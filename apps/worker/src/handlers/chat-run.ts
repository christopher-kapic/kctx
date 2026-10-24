import {
  type AgentMessage,
  type AgentMessagePart,
  AgentRuntimeError,
  runAgentLoop,
  type StreamEvent,
} from "@starter/agent-runtime";
import prisma from "@starter/db";
import { env } from "@starter/env/shared";
import type { ChatRunJobData } from "@starter/queue";
import { chatRunJobSchema, redisConnection } from "@starter/queue";
import type { Job } from "bullmq";

import { buildChatSystemPrompt } from "../lib/chat-prompts.js";
import { buildChatTools } from "../lib/chat-tools.js";
import { createRedisResultStore } from "../lib/result-store.js";

/**
 * Answer one user turn of a durable chat session.
 *
 * THE DURABILITY CONTRACT, which the rest of this file exists to keep:
 * Postgres is authoritative and Redis is best-effort. Every assistant turn is
 * upserted under `(sessionId, seq)` BEFORE it is published, so a subscriber that
 * missed the publish — a browser that was closed, a Redis blip, a server
 * restart — recovers the identical message by replaying from Postgres through
 * the SSE endpoint. A publish that fails is logged and swallowed; a write that
 * fails takes the run down. Never invert that.
 *
 * AND ITS SHARPER HALF: a row is upserted many times as the answer grows, so
 * being durable is not the same as being FINAL. `ChatMessage.state` records
 * which one a row is, durably, because the process that replays is not this
 * one — and only a final row may become a client's resume point. See
 * {@link finalizeStreamedRows} and patterns/durable-streaming.md.
 *
 * AND THE STATE MACHINE'S SHARPER HALF: the claim that starts a run is a
 * compare-and-set, and so is every write that ENDS one. Winning the claim is not
 * a lease — the reaper or a newer `send`/`retry` can take the session while this
 * job sits in an `await` — so a terminal write that is not conditional stamps
 * this run's outcome onto somebody else's. See `releaseRun` below.
 *
 * See patterns/add-ins/chat.md.
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Narrow arbitrary tool/message output to something Prisma's Json column accepts. */
const jsonValue = (value: unknown): JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  return String(value);
};

const jsonParts = (parts: AgentMessagePart[]): JsonValue[] => parts.map(jsonValue);

const messageParts = (value: unknown): AgentMessagePart[] =>
  Array.isArray(value)
    ? (value.filter(
        (part): part is Record<string, unknown> => typeof part === "object" && part !== null,
      ) as AgentMessagePart[])
    : [];

const chunkMessageId = (chunk: unknown): string | undefined =>
  typeof chunk === "object" &&
  chunk !== null &&
  "messageId" in chunk &&
  typeof chunk.messageId === "string"
    ? chunk.messageId
    : undefined;

/**
 * The wire form of a chat live event.
 *
 * `state` rides only on `message` frames and is what tells the SSE endpoint
 * whether it may stamp an `id:` on the frame — an `id:` promises the row is
 * FINAL, not merely durable, and a streaming turn is rewritten in place under
 * one `seq`. Mirrors `ChatLiveEvent` in `apps/server/src/chat-subscriber.ts`.
 */
type ChatStreamEvent = StreamEvent & { state?: "STREAMING" | "COMPLETE" };

const publish = async (sessionId: string, event: ChatStreamEvent): Promise<void> => {
  try {
    await redisConnection.publish(`chat:${sessionId}`, JSON.stringify(event));
  } catch (error) {
    console.warn("[chat-run] Redis publish failed; persistence remains authoritative", error);
  }
};

/**
 * The chat model's API key.
 *
 * Env-configured, exactly like the translation provider — the template
 * has no per-user credential vault, and inventing one here would be a product
 * feature masquerading as infrastructure. Thrown at first job rather than at
 * boot so a deploy that never uses chat starts fine.
 */
/**
 * Is this deployment configured to run chat at all?
 *
 * Mirrors `chatEnabled()` in `packages/api/src/lib/chat-enabled.ts` — the same
 * two conditions, checked again on this side of the queue. NOT a duplicated
 * check for its own sake: the procedure gate runs when a turn is ACCEPTED, and
 * a job can sit in the queue across the deploy that turns chat off. Without
 * this, flipping the documented master switch still lets every already-queued
 * turn spend, which makes it a switch for new work only.
 *
 * Deliberately not imported from `packages/api`: the worker does not depend on
 * the API package, and adding that edge to stop one boolean from being written
 * twice would be the worse trade.
 */
const chatIsEnabled = (): boolean => env.CHAT_ENABLED && Boolean(env.OPENROUTER_API_KEY);

function chatApiKey(): string {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error(
      "[chat-run] OPENROUTER_API_KEY is not set. Chat calls OpenRouter with the same key " +
        "translation uses — set OPENROUTER_API_KEY in your .env (or your deploy's " +
        "environment) to enable chat.",
    );
  }
  return env.OPENROUTER_API_KEY;
}

export async function handleChatRunJob(job: Job<ChatRunJobData>): Promise<{ skipped: boolean }> {
  // Parsed rather than destructured: the payload crosses a queue boundary, so
  // payload drift must fail loudly instead of answering a turn this job cannot
  // identify — a wrong `runGeneration` here would claim a run that isn't ours.
  const { sessionId, userMessageSeq, runGeneration } = chatRunJobSchema.parse(job.data);
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    include: { Messages: { orderBy: { seq: "asc" } } },
  });
  // Session deleted between enqueue and pickup — nothing to answer.
  if (!session) return { skipped: true };

  // Idempotency guard for a BullMQ retry after the run already finished (e.g.
  // the process died between the final write and the ack). An IDLE session that
  // already holds an assistant turn past this user message is done; re-running
  // would bill a second answer to the same question.
  const alreadyFinal =
    session.status === "IDLE" &&
    session.Messages.some(
      (message) => message.role === "ASSISTANT" && message.seq > userMessageSeq,
    );
  if (alreadyFinal) return { skipped: true };

  // Everything written after the user turn this job answers. On a re-run of the
  // turn (BullMQ attempt 2, or `chat.retry`) this is the previous attempt's
  // PARTIAL assistant output; it is cleared below so the answer is replaced
  // rather than appended to.
  const laterMessages = session.Messages.filter((message) => message.seq > userMessageSeq);
  // …unless a newer USER turn is sitting past ours, which means the session
  // moved on while this job was queued (a `send` is allowed out of ERROR). Its
  // own job answers the current question; re-running this one would bill a
  // second answer to a superseded turn AND the clearing below would delete a
  // real user message plus the answers to it. Skip before claiming, so the job
  // that *is* current can take the session.
  if (laterMessages.some((message) => message.role !== "ASSISTANT")) return { skipped: true };

  // Claim the session, compare-and-set — the same idiom as `chat.send`'s
  // `updateMany` claim, for the same reason: a read-then-write lets two writers
  // through. The predicate cannot be `status: { not: "RUNNING" }` here, because
  // `send`/`retry` already flipped the session to RUNNING before enqueueing;
  // ownership is carried by `activeJobId` instead. It is claimable when no job
  // holds it (a fresh send/retry, or a run that released it on the way out) or
  // when this very job holds it (BullMQ re-delivering a stalled attempt).
  //
  // What this closes: a retryable failure clears `activeJobId` and BullMQ
  // schedules attempt 2, while the UI can enqueue a *different* retry job at the
  // same moment. Both used to run the agent loop for one turn — duplicate model
  // spend and two writers racing on the same assistant `seq` rows. Now exactly
  // one wins the row update; the loser exits as skipped rather than throwing,
  // because losing a claim is a correct outcome, not a failure to retry.
  //
  // `runGeneration` is part of the predicate, not decoration: it is what makes
  // the claim identify a *run*, not just a session. Every accepted `send` /
  // `retry` claim increments the counter and stamps its value into this job's
  // payload, so a job whose generation no longer matches the row is answering a
  // snapshot the conversation has moved past. Without this check a stale job
  // (say, one that loaded an ERROR session just before the user sent a new
  // turn) still finds `activeJobId: null`, wins the claim, answers its old
  // question, locks the legitimate job out, and then sets the session IDLE —
  // leaving the newest user message unanswered forever. A generation mismatch
  // exits as skipped rather than throwing: being superseded is a correct
  // outcome, not a failure to retry.
  const claimed = await prisma.chatSession.updateMany({
    where: {
      id: session.id,
      runGeneration,
      OR: [{ activeJobId: null }, { activeJobId: String(job.id) }],
    },
    data: { status: "RUNNING", activeJobId: String(job.id) },
  });
  if (claimed.count === 0) return { skipped: true };

  /**
   * "This job still owns this run" — the SAME predicate the claim above uses.
   *
   * THE EXIT IS A COMPARE-AND-SET TOO, NOT JUST THE ENTRY. Winning the claim is
   * a fact about the moment it was taken, not a lease that holds for the rest of
   * the run: the stale-run reaper can release this session while this job is
   * parked in a long `await`, and the user can then `send` or `retry`, which
   * bumps `runGeneration` and hands the turn to a different job. An unconditional
   * terminal `update` on the session id at that point stamps IDLE/ERROR over the
   * NEWER run and clears ITS `activeJobId` — freeing the session for a second
   * concurrent run and leaving the newest turn showing the wrong status. So every
   * terminal write below goes through {@link releaseRun}, which matches zero rows
   * when this job has been superseded.
   */
  const ownedByThisRun = {
    id: session.id,
    runGeneration,
    activeJobId: String(job.id),
  } as const;

  /**
   * How often this run re-checks that it still owns the session.
   *
   * One period, two consumers. {@link onMessagesChange} fires on every growth
   * step — once per token batch — so it is THROTTLED to this interval; an
   * unthrottled check would put a round-trip in front of each one. The
   * background poller {@link watchOwnership} fires ON this interval, so the
   * check happens even when nothing is being written. Five seconds bounds the
   * wasted work at a few seconds of streaming and a few paid dispatches, which
   * is the same order as the supersede itself.
   */
  const OWNERSHIP_RECHECK_MS = 5_000;

  /**
   * Stop streaming once this run has been superseded.
   *
   * THE MIDDLE OF THE RUN NEEDS THE OWNERSHIP PREDICATE TOO, not just the entry
   * and the exits. Winning the claim is a fact about one instant; the reaper can
   * release this session while the loop is parked in an `await`, and the user's
   * next `send`/`retry` then hands the turn to a different job. The terminal
   * writes already refuse to land in that case ({@link releaseRun}), but nothing
   * stopped the *streaming* writes: this run kept upserting assistant rows into
   * a session the newer run owns, and on success {@link finalizeStreamedRows}
   * promoted them to COMPLETE — a stale duplicate answer, permanently in the
   * transcript and stamped final, plus every paid dispatch it took to produce.
   *
   * This is NOT the cursor-recycling family. `allocateSeq` is an atomic
   * increment on the session row, so a superseded run can never reuse or collide
   * with the newer run's seqs; the damage is duplicate content and duplicate
   * spend, not lost messages.
   *
   * A lookup FAILURE is not a supersede — a blipping database must not abandon a
   * healthy run mid-answer, exactly as the stale-run reaper skips sessions it
   * cannot resolve. Uncertainty leaves the run alone; the terminal
   * compare-and-set is still there to catch it on the way out.
   */
  const supersedeAbort = new AbortController();
  let superseded = false;
  let lastOwnershipCheck = Number.NEGATIVE_INFINITY;

  /** The check itself, unthrottled. `false` means this run has been superseded. */
  const checkOwnership = async (): Promise<boolean> => {
    if (superseded) return false;
    lastOwnershipCheck = Date.now();
    try {
      const owned = await prisma.chatSession.count({ where: ownedByThisRun });
      if (owned > 0) return true;
    } catch (error) {
      console.warn("[chat-run] ownership re-check failed; continuing the run", {
        sessionId: session.id,
        jobId: job.id,
        error,
      });
      return true;
    }
    superseded = true;
    console.warn("[chat-run] run superseded mid-stream; aborting before further writes", {
      sessionId: session.id,
      jobId: job.id,
      runGeneration,
    });
    // Abort the in-flight dispatch. The loop returns `stopReason: "aborted"`,
    // which lands on the non-completed branch below — where `releaseRun` matches
    // zero rows (this run no longer owns the session) and the job exits as
    // skipped, publishing no terminal frame and finalizing no rows.
    supersedeAbort.abort();
    return false;
  };

  /**
   * The write-path check: {@link checkOwnership}, but at most once per interval.
   */
  const stillOwnsRun = async (): Promise<boolean> => {
    if (superseded) return false;
    if (Date.now() - lastOwnershipCheck < OWNERSHIP_RECHECK_MS) return true;
    return checkOwnership();
  };

  /**
   * Poll ownership on a timer, for as long as the loop runs.
   *
   * THE WRITE PATH ALONE IS NOT A HEARTBEAT. Hanging the check off
   * `onMessagesChange` means it only fires when the answer is GROWING — and the
   * expensive parts of a turn are exactly the parts that grow nothing: a
   * provider request in flight, a slow tool call, a retry backoff. Delete a
   * session in the middle of one of those and the run keeps its worker slot and
   * keeps spending until it happens to emit a message or hits
   * `CHAT_RUN_TIMEOUT_MS` — five minutes by default, which is most of a run.
   *
   * So the check gets its own clock, independent of whether anything is being
   * written. Both paths share `lastOwnershipCheck`, so a busy stream and this
   * timer never double up: whichever fires first satisfies the interval for both.
   *
   * `unref()` because this is a watchdog, not work — a pending timer must never
   * be the reason the worker process stays alive during shutdown.
   */
  const startOwnershipWatch = (): NodeJS.Timeout => {
    const timer = setInterval(() => {
      if (superseded) return;
      // Fire-and-forget: `checkOwnership` swallows its own failures and signals
      // through `supersedeAbort`, so there is nothing here to await or handle.
      void checkOwnership();
    }, OWNERSHIP_RECHECK_MS);
    // `unref()` because this is a watchdog, not work — a pending timer must
    // never be the reason the worker process stays alive during shutdown.
    timer.unref?.();
    return timer;
  };
  // Started inside the `try` below, NOT here: the statements between this point
  // and that block do their own awaited writes, and a throw from one of them
  // would step straight over the `finally` that stops the timer.
  let watchOwnership: NodeJS.Timeout | undefined;

  /**
   * The terminal states this handler may leave behind.
   *
   * Status and claim only — the one-shot auto-title is deliberately NOT part of
   * this write. See the two-statement note at the end of the happy path.
   */
  type TerminalSessionState = {
    status: "IDLE" | "ERROR";
    activeJobId: null;
  };

  /**
   * Write this run's terminal state, but only while this job still owns the run.
   *
   * Returns `false` when the write matched zero rows — which means the run was
   * superseded (reaped, re-sent, retried). That is a NORMAL outcome, not a
   * failure: the caller exits cleanly and, critically, publishes no terminal
   * `status` frame, because a frame saying "idle"/"error" for a run the session
   * has moved past would tell a connected client to stop waiting for an answer
   * that is still on its way.
   */
  const releaseRun = async (data: TerminalSessionState): Promise<boolean> => {
    const released = await prisma.chatSession.updateMany({ where: ownedByThisRun, data });
    if (released.count > 0) return true;
    console.warn("[chat-run] run superseded before its terminal write; leaving newer state alone", {
      sessionId: session.id,
      jobId: job.id,
      runGeneration,
    });
    return false;
  };

  // CHAT WAS TURNED OFF WHILE THIS TURN WAS IN THE QUEUE. The procedures refuse
  // new turns the moment the switch flips, but a job committed a second earlier
  // can sit here across the whole deploy — so without this check the documented
  // master switch stops new work and pays for the backlog anyway.
  //
  // After the claim, not before: this run owns the session, so it is the one
  // that may release it. ERROR is the honest state and the useful one — it is
  // what `chat.retry` accepts, so the turn becomes recoverable the moment chat
  // is turned back on, rather than wedged at RUNNING until the reaper notices.
  if (!chatIsEnabled()) {
    console.warn("[chat-run] chat is disabled; releasing the queued turn without dispatching", {
      sessionId: session.id,
      jobId: job.id,
    });
    if (await releaseRun({ status: "ERROR", activeJobId: null })) {
      // `session.nextSeq` is the session's next unallocated cursor — above
      // everything it has emitted. A `status` frame carries no SSE `id:`, so
      // this number only orders the frame; it can never advance a resume
      // cursor. Same choice the stale-run reaper makes.
      await publish(session.id, { type: "status", seq: session.nextSeq, data: "error" });
    }
    return { skipped: true };
  }

  // Raise the session's seq allocator above everything this session has ever
  // emitted, BEFORE the partial rows below are deleted. The allocator is a
  // high-water mark, so this is a floor, never a reset (`nextSeq: { lt: … }`
  // plus a plain assignment) — a concurrent writer that already pushed it
  // higher is left alone.
  //
  // THIS IS WHAT KEEPS CURSORS FROM BEING RECYCLED. A retry used to re-derive
  // the deleted partial's seq from `MAX(seq) + 1`, which meant a client holding
  // `Last-Event-ID: N` for that partial replayed `seq > N` and never received
  // the replacement answer — the live Redis publish, which is explicitly
  // best-effort, was its only delivery path. The stream alone must be enough to
  // reconstruct the transcript. Gaps in the sequence are fine; a repeat is not.
  // See patterns/durable-streaming.md § The cursor.
  //
  // Deliberately NOT gated on {@link ownedByThisRun}, unlike the terminal writes:
  // this only ever RAISES a monotonic high-water mark, so a superseded job that
  // ran it late hands the newer run a slightly larger allocator and nothing else.
  // The predicate it does carry (`nextSeq: { lt: … }`) is what keeps it a floor.
  const highestKnownSeq = Math.max(
    userMessageSeq,
    ...session.Messages.map((message) => message.seq),
  );
  await prisma.chatSession.updateMany({
    where: { id: session.id, nextSeq: { lt: highestKnownSeq + 1 } },
    data: { nextSeq: highestKnownSeq + 1 },
  });

  // Now that no other job can be writing this turn, drop the partial assistant
  // rows from the previous attempt. Without this the user would read a
  // truncated answer followed by a complete one — and the partial would be fed
  // back to the model below as a prior assistant turn, prompting it with its
  // own half-finished output. The replacement lands on a FRESH seq above the
  // deleted one (see the allocator above), so a client that already saw the
  // partial still receives it on replay.
  if (laterMessages.length > 0) {
    await prisma.chatMessage.deleteMany({
      where: { sessionId: session.id, seq: { gt: userMessageSeq }, role: "ASSISTANT" },
    });
  }
  const priorMessages = session.Messages.filter((message) => message.seq <= userMessageSeq);

  /** Highest seq this run has emitted; only the id-less `status` frames use it. */
  let lastSeq = highestKnownSeq;
  /**
   * Take the next cursor value for this session.
   *
   * A single atomic increment that reads the new value back: the session row is
   * the allocator, so nothing is derived from message rows a delete can remove.
   * Called once per assistant message id and remembered in `messageSeq`, so the
   * streaming chunks of a message and its final persisted form carry the SAME
   * seq — that is what lets a client replace its in-progress text with the
   * durable row rather than rendering the answer twice.
   *
   * Unconditional on purpose, for the same reason as the floor above: an
   * increment is monotonic, so even a superseded job can only ever push the
   * allocator up — it can never hand a newer run a cursor it already used.
   */
  const allocateSeq = async (): Promise<number> => {
    const { nextSeq } = await prisma.chatSession.update({
      where: { id: session.id },
      data: { nextSeq: { increment: 1 } },
      select: { nextSeq: true },
    });
    const seq = nextSeq - 1;
    lastSeq = Math.max(lastSeq, seq);
    return seq;
  };
  const messageSeq = new Map<string, number>();
  /**
   * The rows this run has written, by seq — every one of them still marked
   * STREAMING until the turn finalizes. See {@link finalizeStreamedRows}.
   */
  const streamedRows = new Map<number, AgentMessage>();
  const originalIds = new Set(priorMessages.map((message) => message.id));

  /**
   * Promote this run's rows from STREAMING to COMPLETE, then re-publish them.
   *
   * THE FINALITY HALF OF THE CURSOR CONTRACT. `onMessagesChange` upserts the
   * SAME `(sessionId, seq)` row again on every growth step, so a `message` frame
   * emitted mid-answer names a row that is durable but NOT final. If the SSE
   * endpoint stamped an `id:` on it, a client that disconnected right then would
   * reconnect with `Last-Event-ID: N`, replay `seq > N`, and never receive the
   * finished version of row N — a permanently truncated transcript, from the
   * exact same family as the recycled-seq and id-on-chunk bugs. So the state is
   * DURABLE, on the row: the server process that serves a replay is not the
   * worker process that did the streaming, and it must be able to tell a
   * finished turn from a partial one months later.
   *
   * The re-publish is what lets a *connected* client advance its cursor without
   * waiting for a reconnect: it is the first (and only) `message` frame of this
   * turn that carries an `id:`. Losing it costs nothing — the rows are COMPLETE
   * in Postgres, so the next replay stamps them.
   *
   * Deliberately NOT called on the failure paths. A partial left by a failed run
   * stays STREAMING forever, which parks every client's cursor below it; the
   * retry then deletes it and re-answers on a fresh, higher seq, and that
   * replacement reaches every reader through the replay alone. Marking it final
   * would also mean one more write on a path that is already failing.
   */
  const finalizeStreamedRows = async (): Promise<void> => {
    if (streamedRows.size === 0) return;
    await prisma.chatMessage.updateMany({
      where: { sessionId: session.id, seq: { in: [...streamedRows.keys()] } },
      data: { state: "COMPLETE" },
    });
    // Persist first, publish second — the same ordering as every other write in
    // this file, and for the same reason.
    for (const [seq, message] of streamedRows) {
      await publish(session.id, { type: "message", seq, state: "COMPLETE", data: message });
    }
  };

  try {
    watchOwnership = startOwnershipWatch();
    const { tools, systemPromptAddon } = await buildChatTools({
      id: session.id,
      ownerId: session.ownerId,
    });
    // `priorMessages`, not `session.Messages`: the cleared partial turn must not
    // be replayed to the model as though it had already answered.
    const messages: AgentMessage[] = priorMessages.map((message) => ({
      id: message.id,
      role: message.role === "USER" ? "user" : message.role === "SYSTEM" ? "system" : "assistant",
      parts: messageParts(message.parts),
      createdAt: message.createdAt.toISOString(),
    }));

    const baseSystemPrompt = buildChatSystemPrompt(tools);
    const systemPrompt = systemPromptAddon
      ? `${baseSystemPrompt}\n\n${systemPromptAddon}`
      : baseSystemPrompt;

    const result = await runAgentLoop({
      model: { provider: "openrouter", model: env.CHAT_MODEL, apiKey: chatApiKey() },
      // Built from the tool list so the untrusted-content rules turn on exactly
      // when an untrusted tool is registered. See chat-prompts.ts. Explore map /
      // examples-first / delegate guidance append via systemPromptAddon.
      systemPrompt,
      messages,
      // Stable prefix-cache key so every turn of one session reuses the cached
      // system prompt + tool schemas instead of paying full input price.
      cacheKey: session.id,
      // Oversized tool results are stored per-session and paged back via the
      // runtime's `retrieve_tool_result` instead of being hard-truncated.
      resultStore: createRedisResultStore(`chat:${session.id}`),
      tools,
      maxIterations: env.CHAT_MAX_ITERATIONS,
      // The wall-clock backstop. `maxIterations` only counts dispatches that
      // FINISHED, so a provider request or a tool call that never resolves never
      // reaches it — the job and its session would sit at RUNNING forever, and
      // the session claim blocks every later message in that conversation. On
      // expiry the loop aborts its in-flight dispatch and returns
      // `stopReason: "timeout"`, which the non-completed branch below already
      // turns into a recoverable ERROR.
      timeoutMs: env.CHAT_RUN_TIMEOUT_MS,
      // Fired by {@link stillOwnsRun} when the session moves on beneath this
      // run. Distinct from the deadline above, which the runtime owns.
      abortSignal: supersedeAbort.signal,
      onMessagesChange: async (changed) => {
        // Ownership first, before anything is written. See {@link stillOwnsRun}.
        if (!(await stillOwnsRun())) return;
        for (const message of changed) {
          // Only NEW assistant turns: the seed messages are already rows, and a
          // user message must never be rewritten by the loop.
          if (originalIds.has(message.id) || message.role !== "assistant") continue;
          let seq = messageSeq.get(message.id);
          if (seq === undefined) {
            seq = await allocateSeq();
            messageSeq.set(message.id, seq);
          }
          // Upsert, not create: the loop reports a message repeatedly as it
          // grows, so every report after the first lands on a row that already
          // exists. It is also the backstop for a re-run — those rows are
          // cleared before the loop starts, but a delete that did not land (or
          // a row written by a claim-losing straggler) must converge on one row
          // rather than appending a duplicate.
          // STREAMING, and it stays that way until the turn finalizes: this row
          // will be rewritten by the very next growth step, so it is durable but
          // not FINAL, and a cursor may only ever advance onto a final row.
          await prisma.chatMessage.upsert({
            where: { sessionId_seq: { sessionId: session.id, seq } },
            create: {
              sessionId: session.id,
              seq,
              role: "ASSISTANT",
              state: "STREAMING",
              parts: jsonParts(message.parts),
            },
            update: { state: "STREAMING", parts: jsonParts(message.parts) },
          });
          streamedRows.set(seq, message);
          // Published only AFTER the write. A subscriber can therefore never see
          // an event that is not already recoverable from Postgres. The frame
          // carries the row's state so the reader knows it must NOT stamp an
          // `id:` on it — see {@link finalizeStreamedRows}.
          await publish(session.id, { type: "message", seq, state: "STREAMING", data: message });
        }
      },
      onChunk: async (chunk) => {
        // Chunks are transient by design — they are the token stream, and the
        // durable form of the same content arrives via onMessagesChange. Losing
        // one costs a flicker, not a message.
        //
        // The flag, not `stillOwnsRun()`: chunks carry no durable consequence, so
        // they do not deserve a database round-trip of their own. Reading the
        // decision `onMessagesChange` already made just stops a superseded run
        // from painting ghost text into a client watching the newer one.
        if (superseded) return;
        const messageId = chunkMessageId(chunk);
        let seq = messageId ? messageSeq.get(messageId) : undefined;
        if (messageId && seq === undefined) {
          seq = await allocateSeq();
          messageSeq.set(messageId, seq);
        }
        await publish(session.id, { type: "chunk", seq: seq ?? lastSeq, data: chunk });
      },
      onUsage: (usage) =>
        console.debug("[chat-run] model usage", {
          sessionId: session.id,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        }),
    });

    // Anything but "completed" means the answer is partial — an iteration or
    // token ceiling, a timeout, an abort. Reporting it as success would show the
    // user a truncated response as though it were the whole thing.
    if (result.stopReason !== "completed") {
      // Conditional: if the reaper already released this run, or the user has
      // since sent/retried, the newer generation owns the session and this job's
      // ERROR must not land on it. Zero rows matched = superseded = exit cleanly.
      if (!(await releaseRun({ status: "ERROR", activeJobId: null }))) return { skipped: true };
      await publish(session.id, { type: "status", seq: lastSeq + 1, data: "error" });
      return { skipped: false };
    }

    // The turn is over and nothing will rewrite these rows again, so they may
    // finally carry an SSE `id:`. Deliberately NOT ownership-gated: these are
    // this run's OWN rows, at seqs no other run can have issued, so promoting
    // them is correct even if the session has moved on — and a superseded run's
    // rows are either replaced by the newer run at strictly higher seqs or
    // already deleted by it, in which case this matches nothing. Before the
    // session flips to IDLE: a client
    // that acts on the terminal `status` frame must already hold the final form
    // of every message the run produced.
    await finalizeStreamedRows();

    // Auto-title from the first user message, once, so the session list is
    // readable without asking the user to name every conversation. The trigger
    // is the empty string — `ChatSession.title`'s locale-neutral "unset"
    // sentinel — NOT an English placeholder: comparing against "New chat" would
    // both hardcode a user-facing string in the worker and stop auto-titling
    // the moment the UI's fallback wording changed. `renameSession` rejects an
    // empty title, so "" can only mean "never named".
    const firstUser = priorMessages.find((message) => message.role === "USER");
    const firstText = firstUser
      ? messageParts(firstUser.parts).find((part) => part.type === "text")
      : undefined;
    const title =
      firstText && "content" in firstText ? String(firstText.content).trim().slice(0, 60) : "";
    // TWO STATEMENTS, NOT ONE — AND THE TITLE GOES FIRST.
    //
    // "Was this session untitled?" is a question about the DATABASE at the
    // moment of the write, never about the snapshot this run loaded minutes
    // ago. `renameSession` is callable while the first answer is still
    // streaming, so testing `session.title === ""` in memory overwrote the name
    // the user had just chosen. The condition therefore belongs in the WHERE
    // clause: `title: ""` is the claim predicate PLUS one more term, which is
    // strictly narrower and so cannot weaken the compare-and-set.
    //
    // It cannot ride INSIDE the terminal write, though, which is why this is a
    // second statement rather than one longer predicate: that write is the
    // compare-and-set that ENDS the run, and a mid-run rename would then make it
    // match zero rows — the session would be left at RUNNING holding a live
    // `activeJobId`, wedged behind a run that had actually finished. Renaming a
    // conversation must never cost it its terminal status. Two statements keep
    // the two conditions independent.
    //
    // Title first, because {@link releaseRun} clears `activeJobId` and the
    // shared predicate stops matching once it has run. A supersede landing
    // between the two costs nothing: the title is derived from the session's
    // FIRST user message, which no later turn changes.
    //
    // `session.title === ""` survives only as a cheap short-circuit — a session
    // already named when this run loaded it cannot become unnamed
    // (`renameSession` rejects an empty title), so skipping the statement is
    // safe. The predicate is what actually decides.
    if (title && session.title === "") {
      await prisma.chatSession.updateMany({
        where: { ...ownedByThisRun, title: "" },
        data: { title },
      });
    }
    if (!(await releaseRun({ status: "IDLE", activeJobId: null }))) return { skipped: true };
    await publish(session.id, { type: "status", seq: lastSeq + 1, data: "idle" });
    return { skipped: false };
  } catch (error) {
    // `updateMany` (via {@link releaseRun}) so a session deleted mid-run doesn't
    // turn a model failure into a second, more confusing "record not found"
    // failure — and so a run the session has moved past cannot stamp ERROR over
    // a newer one. Clearing `activeJobId` releases the claim: whichever job runs
    // this turn next — a BullMQ attempt 2 or a user-driven `chat.retry` — needs
    // to be able to take it, and the compare-and-set is what keeps them from
    // both taking it.
    if (!(await releaseRun({ status: "ERROR", activeJobId: null }))) {
      // Superseded. No terminal frame (a client is waiting on the NEWER run) and
      // no rethrow: a BullMQ attempt 2 would only lose the claim and skip, so
      // there is nothing left for this job to retry.
      console.error("[chat-run] superseded run failed", { sessionId: session.id, error });
      return { skipped: true };
    }
    await publish(session.id, { type: "status", seq: lastSeq + 1, data: "error" });
    // Rethrow ONLY what the runtime classified as transient (rate limit, 5xx) so
    // BullMQ retries it. Everything else — a bad key, a tool bug — would fail
    // identically on every attempt, so it is recorded and swallowed. The user
    // sees ERROR either way and can retry from the UI.
    if (error instanceof AgentRuntimeError && error.retryable) throw error;
    console.error("[chat-run] run failed", { sessionId: session.id, error });
    return { skipped: false };
  } finally {
    // Every path out of this handler — success, supersede, throw, rethrow —
    // stops the watchdog. A `finally` rather than a line per exit, because the
    // exits are numerous and a leaked interval would keep querying the database
    // about a run that ended, forever.
    if (watchOwnership) clearInterval(watchOwnership);
  }
}
