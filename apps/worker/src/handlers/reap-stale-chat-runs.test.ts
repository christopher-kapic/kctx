import type { ReapStaleChatRunsJobData } from "@starter/queue";
import type { Job } from "bullmq";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@starter/env/shared", () => ({
  env: { CHAT_RUN_TIMEOUT_MS: 300_000, CHAT_STALE_RUN_GRACE_MS: 300_000 },
}));
// Real `@starter/queue` constructs BullMQ Queues at import (IORedis sockets), but
// `@starter/queue/jobs` is the side-effect-free half — so the job schema under
// test is the real one while the connection is a stub.
vi.mock("@starter/queue", async () => {
  const jobs = await import("@starter/queue/jobs");
  return {
    ...jobs,
    redisConnection: { publish: vi.fn().mockResolvedValue(1) },
    // The sweep asks the real queue whether a job is still on its way; the
    // deterministic id it looks up comes from the REAL `chatRunJobId` above.
    chatRunQueue: { getJob: vi.fn() },
  };
});

const { default: prisma } = await import("@starter/db");
const { chatRunQueue, redisConnection } = await import("@starter/queue");
const { handleReapStaleChatRunsJob, reapStaleChatRuns, staleChatRunThresholdMs } = await import(
  "./reap-stale-chat-runs.js"
);

const db = prisma as unknown as {
  chatSession: { findMany: MockInstance; updateMany: MockInstance };
};
const publish = redisConnection.publish as unknown as MockInstance;
const getJob = chatRunQueue.getJob as unknown as MockInstance;

/** A BullMQ job stub that reports exactly one state. */
const jobInState = (state: string) => ({
  getState: vi.fn().mockResolvedValue(state),
  remove: vi.fn().mockResolvedValue(undefined),
});

const now = new Date("2026-07-31T12:00:00.000Z");

/** A session claimed at 11:00 — RUNNING, and untouched for an hour. */
function wedgedSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "chat-1",
    runGeneration: 3,
    nextSeq: 7,
    updatedAt: new Date("2026-07-31T11:00:00.000Z"),
    // The scan carries the latest USER turn so the sweep can re-derive the
    // deterministic job id: `chat-run-<sessionId>-<userMessageSeq>-g<generation>`.
    Messages: [{ seq: 5 }],
    ...overrides,
  };
}

describe("reapStaleChatRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.chatSession.updateMany.mockResolvedValue({ count: 1 });
    publish.mockResolvedValue(1);
    // Default: the job is genuinely gone — the crash-before-enqueue case this
    // sweep exists for. Tests that need a live job say so.
    getJob.mockResolvedValue(undefined);
  });

  // The threshold is the one design decision that keeps this sweep from eating
  // healthy work: a legitimate turn is bounded by the agent loop's own
  // `CHAT_RUN_TIMEOUT_MS`, so the cutoff is that ceiling plus a positive grace —
  // never an independent number.
  it("derives its cutoff from the run timeout plus the configured grace", async () => {
    db.chatSession.findMany.mockResolvedValue([]);

    await expect(reapStaleChatRuns({ now })).resolves.toEqual({
      scanned: 0,
      reaped: 0,
      skipped: 0,
    });

    expect(staleChatRunThresholdMs()).toBe(600_000);
    expect(db.chatSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "RUNNING", updatedAt: { lt: new Date(now.getTime() - 600_000) } },
      }),
    );
    expect(db.chatSession.updateMany).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  // The wedge this exists for: RUNNING is durable, `activeJobId` may hold a job
  // id nothing is running any more, `send` conflicts and `retry` refuses. ERROR
  // with a cleared `activeJobId` is the exact state the worker's own failure path
  // leaves — the only one `chat.retry` accepts.
  it("hands a wedged session back as ERROR with the claim released", async () => {
    db.chatSession.findMany.mockResolvedValue([wedgedSession()]);

    await expect(reapStaleChatRuns({ now })).resolves.toEqual({
      scanned: 1,
      reaped: 1,
      skipped: 0,
    });

    expect(db.chatSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: "chat-1",
        status: "RUNNING",
        runGeneration: 3,
        updatedAt: { lt: new Date(now.getTime() - 600_000) },
      },
      data: { status: "ERROR", activeJobId: null },
    });
  });

  // A connected client must stop waiting without a reload, so the sweep emits the
  // SAME terminal frame the worker publishes. `status` frames carry no SSE `id:`,
  // so this seq can never move a client's resume cursor.
  it("publishes the worker's terminal status frame for a connected client", async () => {
    db.chatSession.findMany.mockResolvedValue([wedgedSession()]);

    await reapStaleChatRuns({ now });

    expect(publish).toHaveBeenCalledWith(
      "chat:chat-1",
      JSON.stringify({ type: "status", seq: 7, data: "error" }),
    );
  });

  // The scan and the release are two statements, so the release is a
  // compare-and-set on the snapshot: a session that was claimed again (or whose
  // live run allocated another seq) between them no longer matches and is left
  // strictly alone — no ERROR, and no status frame telling its client to give up.
  it("leaves a session that came back to life between the scan and the release", async () => {
    db.chatSession.findMany.mockResolvedValue([wedgedSession()]);
    db.chatSession.updateMany.mockResolvedValue({ count: 0 });

    await expect(reapStaleChatRuns({ now })).resolves.toEqual({
      scanned: 1,
      reaped: 0,
      skipped: 0,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  // Redis is best-effort transport; Postgres already says ERROR. A failed publish
  // costs liveness for that one client, never the sweep.
  it("keeps sweeping when the publish fails", async () => {
    db.chatSession.findMany.mockResolvedValue([
      wedgedSession(),
      wedgedSession({ id: "chat-2", nextSeq: 2 }),
    ]);
    publish.mockRejectedValueOnce(new Error("redis is down"));

    await expect(reapStaleChatRuns({ now })).resolves.toEqual({
      scanned: 2,
      reaped: 2,
      skipped: 0,
    });
    expect(db.chatSession.updateMany).toHaveBeenCalledTimes(2);
  });

  // ── A QUEUED JOB IS NOT A STALE JOB ──────────────────────────────────────
  //
  // `ChatSession.updatedAt` only moves once a run has STARTED (every allocated
  // seq is an UPDATE on the row). It does not move while a job waits its turn,
  // so with more enqueued turns than `CHAT_RUN_CONCURRENCY` can start inside the
  // threshold, age alone declares a perfectly healthy job dead: the user is
  // shown Retry, and the still-queued job may then start anyway and race the
  // replacement generation. Age says "nothing happened recently"; only the queue
  // can say "nothing is going to happen".

  it("looks the run up under the deterministic job id", async () => {
    db.chatSession.findMany.mockResolvedValue([wedgedSession()]);

    await reapStaleChatRuns({ now });

    // sessionId + the latest USER seq + the run generation — byte for byte the
    // id `chat.send` / `chat.retry` enqueued under.
    expect(getJob).toHaveBeenCalledWith("chat-run-chat-1-5-g3");
  });

  it.each(["waiting", "waiting-children", "delayed", "active", "prioritized"])(
    "skips a session whose job is still %s in the queue",
    async (state) => {
      // 15 minutes stale: past the 10-minute release threshold, well inside the
      // 30-minute queue-wait ceiling. A queued job earns the benefit of the
      // doubt in that band — that is the whole point of asking the queue.
      db.chatSession.findMany.mockResolvedValue([
        wedgedSession({ updatedAt: new Date("2026-07-31T11:45:00.000Z") }),
      ]);
      getJob.mockResolvedValue(jobInState(state));

      await expect(reapStaleChatRuns({ now })).resolves.toEqual({
        scanned: 1,
        reaped: 0,
        skipped: 1,
      });
      // Not touched at all: no ERROR, and no terminal frame telling a waiting
      // client to give up on an answer that is still coming.
      expect(db.chatSession.updateMany).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  // THE "STILL QUEUED" GUARD NEEDS ITS OWN CEILING, or it is just a different
  // route to the wedge this file exists to clear. A job parked in `waiting`
  // answers "still coming" on every firing, so a queue nothing is draining
  // (every worker down, a bad deploy) holds its sessions at RUNNING forever —
  // composer disabled, `retry` refusing because it only accepts ERROR.
  it.each(["waiting", "waiting-children", "delayed", "prioritized"])(
    "withdraws a job stuck in %s past the queue-wait ceiling and releases the session",
    async (state) => {
      // Three thresholds is the ceiling; 12 hours is comfortably past it.
      const job = jobInState(state);
      db.chatSession.findMany.mockResolvedValue([
        wedgedSession({ updatedAt: new Date("2026-07-31T00:00:00.000Z") }),
      ]);
      getJob.mockResolvedValue(job);

      await expect(reapStaleChatRuns({ now })).resolves.toEqual({
        scanned: 1,
        reaped: 1,
        skipped: 0,
      });
      // Withdrawn, not merely ignored: a job left in the queue could still be
      // picked up later and answer a turn the user has since retried.
      expect(job.remove).toHaveBeenCalledOnce();
      expect(db.chatSession.updateMany).toHaveBeenCalled();
    },
  );

  // `active` is a run IN FLIGHT, and it is never this sweep's to withdraw —
  // BullMQ's own stalled-job checker reclaims a SIGKILLed worker's job within
  // `stalledInterval`, and racing that mechanism is strictly worse than waiting
  // one cron period for it.
  it("never withdraws an active job, however long it has been running", async () => {
    const job = jobInState("active");
    db.chatSession.findMany.mockResolvedValue([
      wedgedSession({ updatedAt: new Date("2026-07-01T00:00:00.000Z") }),
    ]);
    getJob.mockResolvedValue(job);

    await expect(reapStaleChatRuns({ now })).resolves.toEqual({
      scanned: 1,
      reaped: 0,
      skipped: 1,
    });
    expect(job.remove).not.toHaveBeenCalled();
    expect(db.chatSession.updateMany).not.toHaveBeenCalled();
  });

  // The case the sweep exists for still holds: the process died between
  // `chat.send`'s commit and its enqueue, so the job never reached Redis at all.
  // A lookup finds nothing, and nothing is exactly what "reap this" means.
  it("still reaps a claim whose job never reached Redis", async () => {
    db.chatSession.findMany.mockResolvedValue([wedgedSession()]);
    getJob.mockResolvedValue(undefined);

    await expect(reapStaleChatRuns({ now })).resolves.toEqual({
      scanned: 1,
      reaped: 1,
      skipped: 0,
    });
  });

  it.each(["completed", "failed"])("reaps a session whose job is %s", async (state) => {
    db.chatSession.findMany.mockResolvedValue([wedgedSession()]);
    getJob.mockResolvedValue(jobInState(state));

    await expect(reapStaleChatRuns({ now })).resolves.toEqual({
      scanned: 1,
      reaped: 1,
      skipped: 0,
    });
  });

  // A session with no USER turn cannot have a job: both `send` and `retry`
  // derive `userMessageSeq` from one. No lookup, and it is reapable by
  // construction.
  it("reaps a claim with no user turn without asking the queue", async () => {
    db.chatSession.findMany.mockResolvedValue([wedgedSession({ Messages: [] })]);

    await expect(reapStaleChatRuns({ now })).resolves.toEqual({
      scanned: 1,
      reaped: 1,
      skipped: 0,
    });
    expect(getJob).not.toHaveBeenCalled();
  });

  // "I could not tell" must never be read as "it is gone". Reaping on a failed
  // lookup marks a live run ERROR, offers a Retry that races the job still in
  // the queue, and gives away the one-active-job invariant on the strength of a
  // Redis timeout. Skipping costs one cron period for a session that is, by
  // construction, already stuck.
  it("leaves a session alone when the queue lookup itself fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db.chatSession.findMany.mockResolvedValue([wedgedSession()]);
    getJob.mockRejectedValue(new Error("redis is down"));

    await expect(reapStaleChatRuns({ now })).resolves.toEqual({
      scanned: 1,
      reaped: 0,
      skipped: 1,
    });
    expect(db.chatSession.updateMany).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps sweeping the rest when one session's job is still queued", async () => {
    db.chatSession.findMany.mockResolvedValue([
      // Inside the queue-wait ceiling, so its still-queued job is respected.
      wedgedSession({ updatedAt: new Date("2026-07-31T11:45:00.000Z") }),
      wedgedSession({ id: "chat-2", nextSeq: 2, runGeneration: 1, Messages: [{ seq: 0 }] }),
    ]);
    getJob.mockImplementation(async (jobId: string) =>
      jobId === "chat-run-chat-1-5-g3" ? jobInState("waiting") : undefined,
    );

    await expect(reapStaleChatRuns({ now })).resolves.toEqual({
      scanned: 2,
      reaped: 1,
      skipped: 1,
    });
    expect(db.chatSession.updateMany).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      "chat:chat-2",
      JSON.stringify({ type: "status", seq: 2, data: "error" }),
    );
  });
});

describe("handleReapStaleChatRunsJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.chatSession.findMany.mockResolvedValue([]);
    db.chatSession.updateMany.mockResolvedValue({ count: 1 });
  });

  it("honours an explicit staleAfterMs override from the payload", async () => {
    const job = {
      id: "cron-1",
      data: { reason: "cron", staleAfterMs: 1_000 },
    } as Job<ReapStaleChatRunsJobData>;
    await expect(handleReapStaleChatRunsJob(job)).resolves.toEqual({
      reason: "cron",
      scanned: 0,
      reaped: 0,
      skipped: 0,
    });
    const call = db.chatSession.findMany.mock.calls[0]?.[0] as {
      where: { updatedAt: { lt: Date } };
    };
    // 1s, not the 10min default — the payload won.
    expect(Date.now() - call.where.updatedAt.lt.getTime()).toBeGreaterThanOrEqual(1_000);
    expect(Date.now() - call.where.updatedAt.lt.getTime()).toBeLessThan(300_000);
  });

  // The payload crosses a queue boundary: an older deploy, or a job added by
  // hand, must fail loudly rather than sweep with an undefined threshold.
  it("rejects a payload that is not a valid job", async () => {
    const job = {
      id: "cron-2",
      data: { reason: "manual" },
    } as unknown as Job<ReapStaleChatRunsJobData>;
    await expect(handleReapStaleChatRunsJob(job)).rejects.toThrow();
    expect(db.chatSession.findMany).not.toHaveBeenCalled();
  });
});
