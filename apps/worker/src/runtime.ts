import { storage } from "@starter/api/lib/storage";
import { env } from "@starter/env/shared";
import type {
  AnalyzeAssetJobData,
  ChatRunJobData,
  CheckBackupFreshnessJobData,
  CleanupAssetsJobData,
  EchoJobData,
  ReapExpiredAuthTokensJobData,
  ReapStaleChatRunsJobData,
  SeedJobData,
} from "@starter/queue";
import {
  CHECK_BACKUP_FRESHNESS_CRON_PATTERN,
  CLEANUP_ASSETS_CRON_PATTERN,
  CLEANUP_ASSETS_JOB_SCHEDULER_ID,
  checkBackupFreshnessQueue,
  cleanupAssetsQueue,
  createRedisConnection,
  QUEUE_NAMES,
  REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN,
  REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID,
  REAP_STALE_CHAT_RUNS_CRON_PATTERN,
  REAP_STALE_CHAT_RUNS_JOB_SCHEDULER_ID,
  reapExpiredAuthTokensQueue,
  reapStaleChatRunsQueue,
} from "@starter/queue";
import { createConsumerHeartbeat } from "@starter/queue/consumer-health";
import { type Processor, Worker, type WorkerOptions } from "bullmq";
import { syncBackupFreshnessScheduler } from "./backup-freshness-scheduler.js";
import { handleAnalyzeAssetJob } from "./handlers/analyze-asset.js";
import { handleChatRunJob } from "./handlers/chat-run.js";
import { handleCheckBackupFreshnessJob } from "./handlers/check-backup-freshness.js";
import { handleCleanupAssetsJob } from "./handlers/cleanup-assets.js";
import { handleEchoJob } from "./handlers/echo.js";
import { handleReapExpiredAuthTokensJob } from "./handlers/reap-expired-auth-tokens.js";
import { handleReapStaleChatRunsJob } from "./handlers/reap-stale-chat-runs.js";
import { handleSeedJob } from "./handlers/seed.js";
import { closeResultStoreConnection } from "./lib/result-store.js";
import {
  closeOperationalAlertConnection,
  sendOperationalFailureAlert,
} from "./operational-alerts.js";
import { withTimeout } from "./runtime-lifecycle.js";

// One lifecycle per process.
// The host owns signals, fatal exit, and the shared Prisma/producer connections.
let claimed = false;
export type WorkerRuntime = {
  isReady(): boolean;
  stop(): Promise<void>;
};
export class WorkerDrainError extends Error {}

export async function startWorkerRuntime(options: {
  embedded: boolean;
  onFatal(error: unknown): void;
  signal?: AbortSignal;
}): Promise<WorkerRuntime> {
  if (claimed) throw new Error("Worker runtime already started; restart the process to re-enter.");
  claimed = true;
  const { embedded } = options;
  const connection = createRedisConnection();
  const heartbeatConnection = createRedisConnection({
    maxRetriesPerRequest: 1,
    commandTimeout: 3000,
  });
  const workers: Array<
    Pick<Worker, "name" | "close" | "run" | "isRunning" | "isPaused" | "waitUntilReady">
  > = [];
  const requiredQueues = Object.values(QUEUE_NAMES);
  let stopping = false;
  let ready = false;
  let failed = false;
  let stopPromise: Promise<void> | undefined;
  const heartbeat = createConsumerHeartbeat(
    heartbeatConnection,
    embedded ? "embedded" : "external",
    requiredQueues,
    () =>
      ready &&
      !stopping &&
      !failed &&
      connection.status === "ready" &&
      workers.length === requiredQueues.length &&
      requiredQueues.every((name) => workers.some((worker) => worker.name === name)) &&
      workers.every((worker) => worker.isRunning() && !worker.isPaused()),
  );
  function createWorker<T>(name: string, processor: Processor<T>, options: WorkerOptions) {
    const worker = new Worker<T>(name, processor, { ...options, autorun: false });
    workers.push(worker);
    worker.on("error", (error) =>
      console.error("[worker] Consumer connection error:", error.message),
    );
    return worker;
  }
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopping = true;
    ready = false;
    stopPromise = (async () => {
      // Closing consumers must begin even if a pending heartbeat cannot finish.
      // stop() closes BullMQ admission synchronously before awaiting active jobs.
      const workerDrains = Promise.allSettled(workers.map((worker) => worker.close()));
      const heartbeatFailure = await heartbeat.stop().then(
        () => false,
        () => true,
      );
      const results = await workerDrains;
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("One or more job consumers did not close cleanly.");
      }
      connection.disconnect();
      heartbeatConnection.disconnect();
      closeResultStoreConnection();
      closeOperationalAlertConnection();
      if (heartbeatFailure) throw new Error("Consumer heartbeat did not close cleanly.");
    })();
    // Do not disconnect shared clients or pretend timed-out handlers stopped.
    // The host must exit on this rejection; its watchdog owns the hard deadline.
    stopPromise = withTimeout(
      stopPromise,
      15_000,
      "Worker drain timed out; process must exit.",
    ).catch((error: unknown) => {
      throw new WorkerDrainError(error instanceof Error ? error.message : "Worker drain failed.", {
        cause: error,
      });
    });
    return stopPromise;
  }
  options.signal?.addEventListener(
    "abort",
    () => {
      void stop().catch(() => {});
    },
    { once: true },
  );
  const requireRunning = () => {
    if (stopping || options.signal?.aborted) throw new Error("Worker startup cancelled.");
  };

  try {
    requireRunning();
    for (let attempt = 0; ; attempt++) {
      try {
        requireRunning();
        await withTimeout(connection.ping(), 5000, "Redis startup ping timed out");
        break;
      } catch (error) {
        requireRunning();
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    requireRunning();

    const echoWorker = createWorker<EchoJobData>(QUEUE_NAMES.echo, handleEchoJob, {
      connection,
      concurrency: embedded ? 1 : 5,
    });

    echoWorker.on("completed", (job) => {
      console.log(`[echo] Job ${job.id} completed`);
    });

    echoWorker.on("failed", (job, err) => {
      console.error(`[echo] Job ${job?.id} failed:`, err.message);
      void reportJobFailure("echo", job, err);
    });

    const analyzeAssetWorker = createWorker<AnalyzeAssetJobData>(
      QUEUE_NAMES.analyzeAsset,
      handleAnalyzeAssetJob,
      // Keep concurrency low — sharp is CPU-bound and these jobs allocate large
      // buffers. Bump only after measuring memory + CPU on the worker host.
      { connection, concurrency: embedded ? 1 : 2 },
    );

    analyzeAssetWorker.on("completed", (job) => {
      console.log(`[analyze-asset] Job ${job.id} completed`);
    });

    analyzeAssetWorker.on("failed", (job, err) => {
      console.error(`[analyze-asset] Job ${job?.id} failed:`, err.message);
      void reportJobFailure("analyze-asset", job, err);
    });

    const cleanupAssetsWorker = createWorker<CleanupAssetsJobData>(
      QUEUE_NAMES.cleanupAssets,
      handleCleanupAssetsJob,
      // Concurrency: 1. The job iterates the whole asset prefix and we never
      // want two sweeps stepping on each other (a row could be deleted twice or
      // a sweep could resurface an object the other one just deleted).
      { connection, concurrency: 1 },
    );

    cleanupAssetsWorker.on("completed", (job) => {
      console.log(`[cleanup-assets] Job ${job.id} completed`);
    });

    cleanupAssetsWorker.on("failed", (job, err) => {
      console.error(`[cleanup-assets] Job ${job?.id} failed:`, err.message);
      void reportJobFailure("cleanup-assets", job, err);
    });

    // Database seed — on-demand only (no cron). Concurrency 1: never run two seeds
    // at once. Single-attempt; a failed author-written seed surfaces to the admin.
    const seedWorker = createWorker<SeedJobData>(QUEUE_NAMES.seed, handleSeedJob, {
      connection,
      concurrency: 1,
    });

    seedWorker.on("completed", (job) => {
      console.log(`[seed] Job ${job.id} completed`);
    });

    seedWorker.on("failed", (job, err) => {
      console.error(`[seed] Job ${job?.id} failed:`, err.message);
      void reportJobFailure("seed", job, err);
    });

    // Durable chat — one job per user turn, streaming through the agent loop.
    // I/O bound on the model provider, so concurrency is a provider-rate-limit
    // question rather than a CPU one; CHAT_RUN_CONCURRENCY is the knob.
    const chatRunWorker = createWorker<ChatRunJobData>(QUEUE_NAMES.chatRun, handleChatRunJob, {
      connection,
      concurrency: embedded ? 1 : env.CHAT_RUN_CONCURRENCY,
    });

    chatRunWorker.on("completed", (job) => {
      console.log(`[chat-run] Job ${job.id} completed`);
    });

    chatRunWorker.on("failed", (job, err) => {
      console.error(`[chat-run] Job ${job?.id} failed:`, err.message);
      void reportJobFailure("chat-run", job, err);
    });

    // Stale-chat-run sweep — releases sessions stuck at RUNNING (a crash between
    // `chat.send`'s commit and its enqueue, a SIGKILLed worker, BullMQ exhausting
    // its attempts). Concurrency 1: two overlapping sweeps would scan the same rows,
    // and the compare-and-set inside would make the second one a no-op anyway.
    const reapStaleChatRunsWorker = createWorker<ReapStaleChatRunsJobData>(
      QUEUE_NAMES.reapStaleChatRuns,
      handleReapStaleChatRunsJob,
      { connection, concurrency: 1 },
    );

    reapStaleChatRunsWorker.on("completed", (job) => {
      console.log(`[reap-stale-chat-runs] Job ${job.id} completed`);
    });

    reapStaleChatRunsWorker.on("failed", (job, err) => {
      console.error(`[reap-stale-chat-runs] Job ${job?.id} failed:`, err.message);
      void reportJobFailure("reap-stale-chat-runs", job, err);
    });

    // Expired short-lived credentials (sessions, verifications) — another
    // bounded Postgres delete, no storage involved.
    // Concurrency 1: two overlapping sweeps would select the same id pages and
    // race the delete loops for no gain.
    const reapExpiredAuthTokensWorker = createWorker<ReapExpiredAuthTokensJobData>(
      QUEUE_NAMES.reapExpiredAuthTokens,
      handleReapExpiredAuthTokensJob,
      { connection, concurrency: 1 },
    );

    reapExpiredAuthTokensWorker.on("completed", (job) => {
      console.log(`[reap-expired-auth-tokens] Job ${job.id} completed`);
    });

    reapExpiredAuthTokensWorker.on("failed", (job, err) => {
      console.error(`[reap-expired-auth-tokens] Job ${job?.id} failed:`, err.message);
      void reportJobFailure("reap-expired-auth-tokens", job, err);
    });

    // Backup freshness: one listing of the backup bucket per run, so concurrency 1.
    // The worker is always constructed (a job enqueued from the admin UI must not
    // sit forever), but the schedule is registered only when backups are on.
    const checkBackupFreshnessWorker = createWorker<CheckBackupFreshnessJobData>(
      QUEUE_NAMES.checkBackupFreshness,
      handleCheckBackupFreshnessJob,
      { connection, concurrency: 1 },
    );

    checkBackupFreshnessWorker.on("completed", (job) => {
      console.log(`[check-backup-freshness] Job ${job.id} completed`);
    });

    checkBackupFreshnessWorker.on("failed", (job, err) => {
      console.error(`[check-backup-freshness] Job ${job?.id} failed:`, err.message);
      void reportJobFailure("check-backup-freshness", job, err);
    });

    // Register the scheduled sweeps. Stable BullMQ Job Scheduler IDs make these
    // upserts idempotent across restarts and multiple worker replicas.
    if (storage) {
      try {
        requireRunning();
        await cleanupAssetsQueue.upsertJobScheduler(
          CLEANUP_ASSETS_JOB_SCHEDULER_ID,
          { pattern: CLEANUP_ASSETS_CRON_PATTERN },
          { name: "cleanup-assets", data: { reason: "cron" } },
        );
        console.log(`[cleanup-assets] Registered job scheduler (${CLEANUP_ASSETS_CRON_PATTERN}).`);
      } catch (err) {
        console.error("[cleanup-assets] Failed to register job scheduler:", err);
        throw err;
      }
    } else {
      console.log(
        "[cleanup] Object storage is not configured; storage job schedulers not registered.",
      );
    }

    // Chat's stale-run sweep is registered unconditionally — unlike the cleanup
    // schedulers above it needs no object storage, and a deploy without an
    // OPENROUTER_API_KEY simply never has a RUNNING session to reap.
    try {
      requireRunning();
      await reapStaleChatRunsQueue.upsertJobScheduler(
        REAP_STALE_CHAT_RUNS_JOB_SCHEDULER_ID,
        { pattern: REAP_STALE_CHAT_RUNS_CRON_PATTERN },
        { name: "reap-stale-chat-runs", data: { reason: "cron" } },
      );
      console.log(
        `[reap-stale-chat-runs] Registered job scheduler (${REAP_STALE_CHAT_RUNS_CRON_PATTERN}).`,
      );
    } catch (err) {
      console.error("[reap-stale-chat-runs] Failed to register job scheduler:", err);
      throw err;
    }

    // Expired-auth-token pruning is registered unconditionally for the same
    // reason: reading `expiresAt` back is the only thing that ever happened to
    // an expired session or verification — the
    // rows piled up forever. The sweep needs nothing but Postgres.
    try {
      requireRunning();
      await reapExpiredAuthTokensQueue.upsertJobScheduler(
        REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID,
        { pattern: REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN },
        { name: "reap-expired-auth-tokens", data: { reason: "cron" } },
      );
      console.log(
        `[reap-expired-auth-tokens] Registered job scheduler (${REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN}).`,
      );
    } catch (err) {
      console.error("[reap-expired-auth-tokens] Failed to register job scheduler:", err);
      throw err;
    }

    // Backup freshness is gated on the BACKUP_* config, not on object storage:
    // backups use their own bucket and credentials. The provider-only profile
    // (BACKUP_ENABLED=false) has nothing to measure, so it registers nothing.
    try {
      requireRunning();
      const action = await syncBackupFreshnessScheduler(checkBackupFreshnessQueue);
      if (action === "upserted") {
        console.log(
          `[check-backup-freshness] Registered job scheduler (${CHECK_BACKUP_FRESHNESS_CRON_PATTERN}).`,
        );
      } else {
        console.log(
          "[check-backup-freshness] Logical backups are disabled (BACKUP_ENABLED=false); removed job scheduler.",
        );
      }
    } catch (err) {
      console.error("[check-backup-freshness] Failed to sync job scheduler:", err);
      throw err;
    }

    await withTimeout(
      Promise.all(workers.map((worker) => worker.waitUntilReady())),
      10_000,
      "Job consumer startup timed out",
    );
    requireRunning();
    ready = true;
    for (const worker of workers) {
      void worker.run().catch((error: unknown) => {
        failed = true;
        void sendOperationalFailureAlert({
          queue: "worker",
          jobId: "consumer-failure",
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
        options.onFatal(error);
      });
    }
    await heartbeat.start();
    requireRunning();
    console.log(
      embedded ? "[worker] Embedded consumers started." : "[worker] External consumers started.",
    );
    return { isReady: () => heartbeat.isReady(), stop };
  } catch (error) {
    // Propagate an unclean drain to the host. A rejected startup alone does not
    // prove that active jobs released their shared Prisma/producer dependencies.
    await stop();
    throw error;
  }
}

type FailedJob = {
  id?: string | number;
  attemptsMade: number;
  finishedOn?: number;
  opts: { attempts?: number };
};

// BullMQ emits `failed` on every attempt, not only the last one. Act (alert,
// mark FAILED) only once the job has exhausted its retries so a queue with
// `attempts > 1` doesn't fire one alert per retry. A missing job handle (rare:
// lock lost) is treated as terminal so the failure is still surfaced.
function isTerminalFailure(job: FailedJob | undefined, err?: Error): boolean {
  if (!job) return true;
  if (err?.name === "UnrecoverableError") return true;
  if (job.finishedOn !== undefined) return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

async function reportJobFailure(
  queue: string,
  job: FailedJob | undefined,
  err: Error,
): Promise<void> {
  if (!isTerminalFailure(job, err)) return;
  try {
    await sendOperationalFailureAlert({ queue, jobId: job?.id, message: err.message });
  } catch (alertErr) {
    console.error(
      `[${queue}] Failed to send operational alert:`,
      alertErr instanceof Error ? alertErr.message : alertErr,
    );
  }
}
