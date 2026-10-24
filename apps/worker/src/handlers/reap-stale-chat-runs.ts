import prisma, { type Prisma } from "@starter/db";
import { env } from "@starter/env/shared";
import type { ReapStaleChatRunsJobData } from "@starter/queue";
import {
  chatRunJobId,
  chatRunQueue,
  reapStaleChatRunsJobSchema,
  redisConnection,
} from "@starter/queue";
import type { Job } from "bullmq";

/**
 * Release chat sessions wedged at `RUNNING` with nothing on its way to answer
 * them.
 *
 * WHY THIS EXISTS. `chat.send` (and `chat.retry`) commits the user message and
 * the RUNNING claim, and only THEN enqueues the run — deliberately, so the
 * worker cannot load the session before the message is visible. That ordering
 * leaves a window, and three separate failures land a session in the identical
 * unusable state:
 *
 *   1. **Crash between the commit and the enqueue.** The claim and the user
 *      message are durable; no job exists. `send` then conflicts (the session is
 *      RUNNING) and `retry` refuses (it only accepts ERROR). The conversation is
 *      permanently unusable. `releaseClaimAfterEnqueueFailure` in
 *      `packages/api/src/routers/chat.ts` covers only the enqueue *throwing* —
 *      it cannot run if the process is gone.
 *   2. **A worker killed mid-run** (SIGKILL, OOM, a deploy). The session keeps
 *      RUNNING *and* a stale `activeJobId`, which the worker's compare-and-set
 *      claim treats as "another job owns this turn" — so every future job for
 *      that session is locked out too.
 *   3. **BullMQ exhausting its attempts** without the handler's `catch` running
 *      (a lost lock, a process that vanished on the last attempt).
 *
 * WHAT REAPING MEANS: `status: ERROR` + `activeJobId: null` — the exact state
 * the worker's own failure path leaves behind, which is the only state
 * `chat.retry` accepts and the one the UI already knows how to recover from.
 * The same terminal `status` frame the worker publishes goes out on Redis, so a
 * connected client stops waiting without a reload. Nothing else is touched: the
 * user message stays, and any partial assistant rows stay `STREAMING` (they are
 * therefore below every client's cursor, and the retry replaces them on fresh,
 * higher seqs — see patterns/durable-streaming.md).
 *
 * WHY THIS CANNOT REAP A HEALTHY RUN. Two independent guards:
 *
 *   * **The threshold is derived from the run's own ceiling.** A legitimate turn
 *     is bounded by `CHAT_RUN_TIMEOUT_MS` (the agent loop's wall-clock timer,
 *     which aborts the in-flight dispatch and takes the ERROR path), so the
 *     cutoff is that ceiling plus a positive `CHAT_STALE_RUN_GRACE_MS` — never
 *     an independent number. Anything still RUNNING past the sum has outlived
 *     the longest run the worker is capable of producing.
 *   * **`updatedAt` moves while a run is alive.** Every seq the run allocates is
 *     an `UPDATE` on the session row (`nextSeq: { increment: 1 }`), so a
 *     streaming answer keeps pushing `updatedAt` forward; only a run that has
 *     stopped writing entirely can age past the cutoff.
 *   * **A QUEUED JOB IS NOT A STALE JOB.** The two guards above are about a run
 *     that has *started*. `updatedAt` does not advance while a job sits in the
 *     queue waiting its turn, so with more enqueued turns than
 *     `CHAT_RUN_CONCURRENCY` can start inside the threshold, age alone
 *     misclassifies a perfectly healthy job as dead — the user is shown Retry,
 *     and the still-queued job may then start anyway and race the replacement
 *     generation. Age says "nothing has happened recently"; it cannot say
 *     "nothing is going to happen". So the sweep asks the queue directly, via
 *     the deterministic job id, and skips any session whose job still exists in
 *     a live state. See {@link runJobIsReapable}.
 *
 * AND THAT LAST GUARD IS ITSELF BOUNDED, because an unbounded one just relocates
 * the wedge. A job that never STARTS keeps answering "still coming" forever, so
 * a queue nothing is draining (every worker down, a bad deploy) would hold its
 * sessions at RUNNING permanently — the exact condition this file exists to
 * clear, produced by the check that protects against clearing it too early. Past
 * a second, much longer ceiling ({@link QUEUE_WAIT_MULTIPLIER}) a still-queued
 * job is withdrawn and its session released. A job that is `active` is never
 * touched: that one is BullMQ's stalled-job checker's to reclaim.
 *
 * And the release itself is a compare-and-set on the snapshot the scan read
 * (`status` + `runGeneration` + the same `updatedAt` bound), so a session that
 * came back to life between the scan and the write — a fresh `send` claim, a
 * worker allocating another seq — is left alone: the `updateMany` matches zero
 * rows and the session is skipped.
 */

/**
 * How long a session may sit at `RUNNING` before it is presumed dead.
 *
 * DERIVED, never a magic number: a legitimate run is bounded by
 * `CHAT_RUN_TIMEOUT_MS`, and the grace on top covers the time a job can spend
 * *outside* the loop's own timer — queue wait at saturated `CHAT_RUN_CONCURRENCY`,
 * BullMQ's retry backoff, and the finalizing writes.
 */
export const staleChatRunThresholdMs = (): number =>
  env.CHAT_RUN_TIMEOUT_MS + env.CHAT_STALE_RUN_GRACE_MS;

export type ReapStaleChatRunsResult = {
  /** Sessions past the threshold when the sweep scanned. */
  scanned: number;
  /** Sessions actually handed back as ERROR (the rest moved under the sweep). */
  reaped: number;
  /**
   * Sessions the sweep deliberately left RUNNING because a job is still on its
   * way to answer them — queued behind a saturated concurrency limit, delayed by
   * a BullMQ backoff, or simply unverifiable because the queue lookup failed.
   * A non-zero value here on every firing is the signal that `CHAT_RUN_TIMEOUT_MS
   * + CHAT_STALE_RUN_GRACE_MS` is short relative to real queue wait, not that
   * anything is wrong. Sessions that lost the release compare-and-set are in
   * neither this count nor `reaped`.
   */
  skipped: number;
};

/**
 * BullMQ job states that mean the run is genuinely over.
 *
 * A DENY-LIST, on purpose, and it is the safe orientation: everything not named
 * here — `waiting`, `waiting-children`, `delayed`, `active`, `prioritized`, the
 * transient `unknown`, and any state a future BullMQ adds — counts as "still on
 * its way" and is skipped. Getting that backwards (an allow-list of live states)
 * would make an unrecognized state reapable, which is the destructive direction.
 */
const DEAD_JOB_STATES: ReadonlySet<string> = new Set(["completed", "failed"]);

/**
 * States meaning "this job has not started yet".
 *
 * Deliberately excludes `active`, which is a run in flight: that one belongs to
 * BullMQ's stalled-job checker, never to this sweep. Unlike {@link
 * DEAD_JOB_STATES} an allow-list is the safe orientation here, because the
 * action it gates is *withdrawing* the job — an unrecognized state must not
 * qualify.
 */
const QUEUED_JOB_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "waiting-children",
  "delayed",
  "prioritized",
]);

/**
 * How much longer than the run threshold a merely-QUEUED job may hold a session.
 *
 * Derived, never an independent number — the same discipline the run threshold
 * follows. A backlog is legitimate: with more enqueued turns than
 * `CHAT_RUN_CONCURRENCY` can start inside one threshold, a healthy job really is
 * still waiting its turn, and reaping it would offer the user a Retry that races
 * real work. Three thresholds (30 minutes at the defaults) is far past any
 * backlog a draining queue produces — and far short of "forever", which is what
 * this ceiling replaces.
 */
const QUEUE_WAIT_MULTIPLIER = 3;

/**
 * Sessions examined per sweep.
 *
 * The sweep is not a full-table scan. It runs every five minutes
 * (`REAP_STALE_CHAT_RUNS_CRON_PATTERN`) and processes up to
 * `REAP_SCAN_LIMIT` aged sessions per run, oldest `updatedAt` first; a backlog
 * therefore drains across successive runs rather than loading every wedged
 * session — and its `Messages` relation — into one process at once. Rows leave
 * the candidate set as they are released (`status` becomes ERROR), and a row
 * this sweep deliberately skipped is one with a job still on its way, which
 * either answers the session or ages past `queueWaitCutoff` and is reaped by a
 * later run. Nothing is lost by stopping at the limit; the next run resumes.
 */
const REAP_SCAN_LIMIT = 500;

const staleSessionSelect = {
  id: true,
  runGeneration: true,
  nextSeq: true,
  updatedAt: true,
  // The latest USER turn, fetched with the scan rather than per session, so
  // the job-id derivation in `runJobIsReapable` costs no extra round trip.
  Messages: {
    where: { role: "USER" },
    orderBy: { seq: "desc" },
    take: 1,
    select: { seq: true },
  },
} satisfies Prisma.ChatSessionSelect;

/** The schema-checked shape {@link reapStaleChatRuns} reads out of its scan. */
type StaleSessionRow = Prisma.ChatSessionGetPayload<{ select: typeof staleSessionSelect }>;

/**
 * Is there genuinely no job left to answer this session's run?
 *
 * The job id is DETERMINISTIC (`chatRunJobId`: session id + user message seq +
 * `runGeneration`), so the sweep can look up the exact job that a given claim
 * produced without storing anything extra. `userMessageSeq` is the session's
 * highest USER seq because that is precisely what `chat.send` and `chat.retry`
 * put in the payload; the same derivation reproduces the id byte for byte. (When
 * a worker has already claimed the turn, `ChatSession.activeJobId` holds that
 * same string — but it is null for exactly the case this check exists for, a job
 * still waiting in the queue, so the id has to be derived rather than read.)
 *
 * Three answers collapse into `true` (reap):
 *   * **No user turn at all.** Neither `send` nor `retry` can have enqueued
 *     anything, so no job exists by construction.
 *   * **`getJob` finds nothing.** The crash-between-commit-and-enqueue case:
 *     the job never reached Redis. Also a `completed`/`failed` job already swept
 *     up by `removeOnComplete` / `removeOnFail`.
 *   * **The job is in a dead state.** BullMQ exhausted its attempts (`failed`),
 *     or it completed without the handler's terminal write landing.
 *
 * And `false` (skip) for a live job — including a SIGKILLed worker's job still
 * sitting `active`: BullMQ's own stalled-job checker reclaims that one within
 * `stalledInterval` and either re-queues it (it gets answered) or fails it (this
 * sweep reaps it on the next firing). Waiting one cron period for a mechanism
 * that already exists is strictly better than racing it.
 *
 * A FAILED LOOKUP ALSO RETURNS `false`. Reaping on "I could not tell" is the
 * destructive direction — it marks a live run ERROR, offers the user a Retry
 * that races the job still in the queue, and clears `activeJobId`, which is the
 * one-active-job invariant given away on the strength of a Redis timeout.
 * Skipping costs one cron period (5 minutes) for a session that is, by
 * construction, already stuck; the next firing re-checks.
 */
async function runJobIsReapable(
  session: StaleSessionRow,
  options: { queueWaitExhausted: boolean },
): Promise<boolean> {
  const userMessageSeq = session.Messages[0]?.seq;
  if (userMessageSeq === undefined) return true;
  const jobId = chatRunJobId({
    sessionId: session.id,
    userMessageSeq,
    runGeneration: session.runGeneration,
  });
  try {
    const job = await chatRunQueue.getJob(jobId);
    if (!job) return true;
    const state = await job.getState();
    if (DEAD_JOB_STATES.has(state)) return true;
    // "A queued job is not a stale job" is right, but it must not be UNBOUNDED —
    // otherwise it is simply a different route to the wedge this sweep exists to
    // clear. A job parked in `waiting` keeps `getJob` answering "still coming"
    // on every firing, so a queue with nothing draining it (every worker down, a
    // bad deploy, a Redis restored from a snapshot) leaves the session RUNNING
    // for good: the composer stays disabled and `retry` refuses, because it only
    // accepts ERROR.
    //
    // So a job that has not STARTED gets its own, much longer ceiling. Past it
    // the job is withdrawn and the session released — safe precisely because it
    // never ran: nothing was dispatched, nothing was written, and the user's
    // Retry enqueues a fresh generation instead of racing this one. Removing it
    // is what makes that true; a job left in the queue could still be picked up
    // later and answer a turn the user has since retried.
    if (QUEUED_JOB_STATES.has(state) && options.queueWaitExhausted) {
      await job.remove();
      console.warn(
        `[reap-stale-chat-runs] Job ${jobId} sat in "${state}" past the queue-wait ceiling; withdrew it and released session ${session.id}.`,
      );
      return true;
    }
    return false;
  } catch (error) {
    console.warn(
      `[reap-stale-chat-runs] Could not read job ${jobId}; leaving session ${session.id} alone`,
      error,
    );
    return false;
  }
}

export type ReapStaleChatRunsOptions = {
  /** Overrides {@link staleChatRunThresholdMs}. Tests only. */
  staleAfterMs?: number;
  now?: Date;
};

/**
 * Publish the same terminal `status` frame the worker publishes on its failure
 * path, so a client watching the stream leaves its "answering…" state without
 * waiting for a reload.
 *
 * Best-effort, exactly like every other publish in this feature: Postgres now
 * says ERROR, so a lost frame costs liveness only — the next reconnect reads the
 * session row and the replay repairs the transcript.
 */
async function publishReapedStatus(sessionId: string, seq: number): Promise<void> {
  try {
    await redisConnection.publish(
      `chat:${sessionId}`,
      // `seq` is the session's next unallocated cursor: above everything this
      // session has emitted. A `status` frame carries no SSE `id:` — it is
      // session state, not a sequence point — so this number only orders the
      // frame; it can never advance a client's resume cursor.
      JSON.stringify({ type: "status", seq, data: "error" }),
    );
  } catch (error) {
    console.warn(
      "[reap-stale-chat-runs] Redis publish failed; persistence remains authoritative",
      error,
    );
  }
}

export async function reapStaleChatRuns(
  options: ReapStaleChatRunsOptions = {},
): Promise<ReapStaleChatRunsResult> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? staleChatRunThresholdMs();
  const cutoff = new Date(now.getTime() - staleAfterMs);
  // The second, longer cutoff: past this a job that never STARTED stops earning
  // the benefit of the doubt. See {@link QUEUE_WAIT_MULTIPLIER}.
  const queueWaitCutoff = new Date(now.getTime() - staleAfterMs * QUEUE_WAIT_MULTIPLIER);

  const stale = await prisma.chatSession.findMany({
    where: { status: "RUNNING", updatedAt: { lt: cutoff } },
    select: staleSessionSelect,
    // Oldest first: the longest-wedged conversation is the one a user is most
    // likely staring at. See {@link REAP_SCAN_LIMIT} for why this is bounded.
    orderBy: { updatedAt: "asc" },
    take: REAP_SCAN_LIMIT,
  });

  let reaped = 0;
  let skipped = 0;
  for (const session of stale) {
    // AGE IS NOT ABSENCE. `updatedAt` stands still while a job waits its turn in
    // the queue, so before releasing anything ask the queue whether a job is
    // still coming. Only "no job, or a dead one" is reapable.
    if (
      !(await runJobIsReapable(session, {
        queueWaitExhausted: session.updatedAt < queueWaitCutoff,
      }))
    ) {
      skipped += 1;
      continue;
    }
    // Compare-and-set against the snapshot above. `runGeneration` pins the run:
    // a `send`/`retry` that claimed this session in the meantime incremented it,
    // and `updatedAt` catches every other write (a live run allocating a seq,
    // the worker's own terminal update). Either way the row no longer matches
    // and this sweep does nothing — the same idiom `chat.send` and the worker
    // use to claim, for the same reason a read-then-write is not enough.
    const released = await prisma.chatSession.updateMany({
      where: {
        id: session.id,
        status: "RUNNING",
        runGeneration: session.runGeneration,
        updatedAt: { lt: cutoff },
      },
      data: { status: "ERROR", activeJobId: null },
    });
    if (released.count === 0) continue;
    reaped += 1;
    console.warn(
      `[reap-stale-chat-runs] Released session ${session.id}; RUNNING since ${session.updatedAt.toISOString()} with no queued or running job to answer it.`,
    );
    await publishReapedStatus(session.id, session.nextSeq);
  }

  return { scanned: stale.length, reaped, skipped };
}

export async function handleReapStaleChatRunsJob(job: Job<ReapStaleChatRunsJobData>) {
  // Parsed rather than destructured: the payload crosses a queue boundary, so an
  // older deploy (or a hand-added job) must fail loudly here instead of sweeping
  // with an undefined threshold.
  const { reason, staleAfterMs } = reapStaleChatRunsJobSchema.parse(job.data);
  const result = await reapStaleChatRuns({ staleAfterMs });
  if (result.reaped > 0 || result.skipped > 0) {
    console.warn(
      `[reap-stale-chat-runs] Job ${job.id} (${reason}) released ${result.reaped} of ${result.scanned} aged session(s); ${result.skipped} still had a job on the way`,
    );
  }
  return { reason, ...result };
}
