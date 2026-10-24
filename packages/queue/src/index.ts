import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";
import { type ChatRunJobData, chatRunJobId, QUEUE_NAMES } from "./jobs.js";

export { FlowProducer, Job, Queue, QueueEvents, Worker } from "bullmq";
export { createRedisConnection, redisConnection } from "./connection.js";
export { ensureRunnableJob } from "./ensure-job.js";
export {
  type AnalyzeAssetJobData,
  analyzeAssetJobSchema,
  CHECK_BACKUP_FRESHNESS_CRON_PATTERN,
  CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID,
  type ChatRunJobData,
  type CheckBackupFreshnessJobData,
  CLEANUP_ASSETS_CRON_PATTERN,
  CLEANUP_ASSETS_JOB_SCHEDULER_ID,
  type CleanupAssetsJobData,
  chatRunJobId,
  chatRunJobSchema,
  checkBackupFreshnessJobSchema,
  cleanupAssetsJobSchema,
  type EchoJobData,
  echoJobSchema,
  QUEUE_NAMES,
  REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN,
  REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID,
  REAP_STALE_CHAT_RUNS_CRON_PATTERN,
  REAP_STALE_CHAT_RUNS_JOB_SCHEDULER_ID,
  type ReapExpiredAuthTokensJobData,
  type ReapStaleChatRunsJobData,
  reapExpiredAuthTokensJobSchema,
  reapStaleChatRunsJobSchema,
  type SeedJobData,
  seedJobSchema,
} from "./jobs.js";

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400, count: 5000 },
};

/** Pre-configured echo queue. Add more queues here as needed. */
export const echoQueue = new Queue(QUEUE_NAMES.echo, {
  connection: redisConnection,
  defaultJobOptions,
});

/** Re-derives Asset metadata from S3 bytes after a presigned upload finalizes. */
export const analyzeAssetQueue = new Queue(QUEUE_NAMES.analyzeAsset, {
  connection: redisConnection,
  defaultJobOptions,
});

/**
 * Sweeps orphan PENDING Asset rows + orphan S3 objects. Triggered by the
 * admin cleanup page on demand and by a 24h cron registered in the worker.
 * Single-attempt — a transient failure is logged and the next cron firing
 * picks it up; retrying immediately would burn API quota for no gain.
 */
export const cleanupAssetsQueue = new Queue(QUEUE_NAMES.cleanupAssets, {
  connection: redisConnection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 1,
  },
});

/**
 * Runs the database seed on demand from the admin "Run seed" button. Single-
 * attempt — an author-written seed is not guaranteed safe to auto-retry, so a
 * failure surfaces to the admin instead of silently re-running. Concurrency is
 * pinned to 1 in the worker so two seed runs never overlap.
 */
export const seedQueue = new Queue(QUEUE_NAMES.seed, {
  connection: redisConnection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 1,
  },
});

/**
 * Runs one turn of a durable chat session through the agent loop. `attempts: 2`
 * rather than the default 3: a retry re-dispatches the model and costs real
 * money, and the handler only rethrows errors the runtime classified as
 * transient (rate limit, 5xx), so a second attempt is worth paying for and a
 * third is not.
 *
 * Retries are safe because the handler deletes the previous attempt's partial
 * assistant rows before re-answering, so a re-run replaces its own partial work
 * instead of appending a second answer.
 *
 * THE REPLACEMENT LANDS ON FRESH, STRICTLY HIGHER `seq` VALUES — it does NOT
 * re-derive the deleted rows' keys, and nothing here should ever be "fixed" to
 * make it. Re-deriving them (from `MAX(seq) + 1`, say) recycles a cursor a
 * client may already hold as `Last-Event-ID`: that client replays `seq > N`,
 * the replacement sits AT `N`, and the answer reaches it only over the
 * best-effort Redis publish — permanent, silent message loss for anyone who was
 * disconnected at the wrong moment. `ChatSession.nextSeq` is a monotonic
 * allocator for exactly this reason. Gaps in the sequence are fine; a repeat is
 * not. See `apps/worker/src/handlers/chat-run.ts` and
 * patterns/durable-streaming.md § The cursor.
 */
export const chatRunQueue = new Queue(QUEUE_NAMES.chatRun, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 2 },
});

/**
 * Sweeps chat sessions wedged in `RUNNING` — a crash between `chat.send`'s
 * commit and its enqueue, a SIGKILLed worker, or BullMQ exhausting its attempts
 * without the handler's error path running. Cron-only; `attempts: 1` like the
 * other sweeps, because the next firing (5 minutes later) is the retry.
 */
export const reapStaleChatRunsQueue = new Queue(QUEUE_NAMES.reapStaleChatRuns, {
  connection: redisConnection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 1,
  },
});

/**
 * Deletes expired short-lived credentials (sessions, verifications, device
 * codes, preview tokens). Cron-only and unconditional: a bounded Postgres delete
 * every install owes its users.
 * `attempts: 1` — the next daily firing is the retry.
 */
export const reapExpiredAuthTokensQueue = new Queue(QUEUE_NAMES.reapExpiredAuthTokens, {
  connection: redisConnection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 1,
  },
});

/**
 * Backup freshness check. `attempts: 1` like the other sweeps: a listing error
 * is itself a verdict the handler records and alerts on, and the next firing
 * (6 hours later) is the retry.
 */
export const checkBackupFreshnessQueue = new Queue(QUEUE_NAMES.checkBackupFreshness, {
  connection: redisConnection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 1,
  },
});

/**
 * Enqueue a chat turn under a DETERMINISTIC job id.
 *
 * This is the idempotency boundary for `chat.send`: BullMQ drops an `add()`
 * whose `jobId` already exists, so a double-clicked send (or a client that
 * retries the mutation) can never produce two concurrent runs answering the
 * same user message.
 *
 * The `-g<runGeneration>` suffix is what keeps that dedupe from swallowing a
 * *deliberate* re-run. One accepted claim (`send` or `retry`) = one generation
 * = one job id; re-enqueueing the same claim collapses, a new claim does not.
 * The generation is read back from `ChatSession.runGeneration`, never derived
 * from persisted messages — a failed attempt may have written nothing, and
 * `removeOnFail: { age: 86400 }` above means the previous id is still around to
 * collide with for a day. A collision does not throw; `add()` just returns the
 * retained job, so the caller believes it queued work that will never run.
 */
export const enqueueChatRun = (data: ChatRunJobData) =>
  chatRunQueue.add("chat-run", data, { jobId: chatRunJobId(data) });

/**
 * Withdraw a queued chat turn. Best-effort, and deliberately so.
 *
 * Used by `chat.deleteSession` to stop work for a conversation that is about to
 * stop existing. Three outcomes, all fine:
 *
 *   • The job is WAITING or DELAYED — `remove()` takes it, and the entire run is
 *     saved. This is the case worth having: nothing has been dispatched yet.
 *   • The job is ACTIVE — BullMQ refuses to remove a locked job and throws. A
 *     run in flight cannot be yanked out from under its worker; the handler's
 *     own ownership re-check is what ends it, when the session it is streaming
 *     into turns out to be gone.
 *   • The job does not exist (already completed, already reaped, or the enqueue
 *     never landed) — nothing to do.
 *
 * Never throws: the caller's actual job is deleting the session, and failing
 * that because a queue cleanup did not take would leave the user unable to
 * remove a conversation over a bookkeeping detail. Redis being down means the
 * run cannot make progress anyway.
 */
export const cancelChatRun = async (jobId: string): Promise<boolean> => {
  try {
    const job = await chatRunQueue.getJob(jobId);
    if (!job) return false;
    await job.remove();
    return true;
  } catch (error) {
    console.warn("[queue] could not cancel chat run; leaving it to the handler", { jobId, error });
    return false;
  }
};
