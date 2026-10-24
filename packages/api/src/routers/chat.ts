import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@starter/db";
import { cancelChatRun, chatRunJobId, enqueueChatRun, redisConnection } from "@starter/queue";
import { z } from "zod";

import { protectedProcedure } from "../index";
import {
  chatMessageSelect,
  chatSessionSelect,
  serializeChatMessage,
  serializeChatSession,
} from "../lib/chat";
import { assertChatEnabled, chatEnabled } from "../lib/chat-enabled";
import { consumeChatSendBudget, consumeChatSessionBudget } from "../lib/chat-rate-limit";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";

/**
 * Durable agentic chat — the write half. The read half a browser subscribes to
 * is the SSE endpoint in `apps/server/src/chat-routes.ts`; the work happens in
 * the `chat-run` worker. See patterns/add-ins/chat.md.
 *
 * Every session lookup here is owner-scoped and raises NOT_FOUND (never
 * FORBIDDEN) for someone else's session — a chat transcript is private enough
 * that even its existence should not leak. Most mutation paths share
 * {@link ownedSession}; reads use narrower client-facing projections directly.
 *
 * `send` and `retry` are additionally metered by {@link consumeChatSendBudget}.
 * They are the only two procedures here that SPEND: each accepted turn queues a
 * run worth up to `CHAT_MAX_ITERATIONS` paid model dispatches, and the worker's
 * concurrency limit queues the excess rather than shedding it. The generic
 * `/rpc/*` limiter counts requests, not turns, and cannot see either fact — see
 * the doc comment on `packages/api/src/lib/chat-rate-limit.ts` for why this
 * limiter lives in the procedure layer and why it fails closed.
 */

const sessionIdInput = z.object({ sessionId: z.string().min(1) });

const notFound = () => new ORPCError("NOT_FOUND", { message: "Chat session not found" });
const runningConflict = () =>
  new ORPCError("CONFLICT", { message: "Wait for the current response" });
const notFailedConflict = () =>
  new ORPCError("CONFLICT", { message: "Only failed responses can be retried" });

const ownedSessionSelect = {
  id: true,
  status: true,
  runGeneration: true,
} satisfies Prisma.ChatSessionSelect;

async function ownedSession(sessionId: string, ownerId: string) {
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, ownerId },
    select: ownedSessionSelect,
  });
  if (!session) throw notFound();
  return session;
}

/**
 * Withdraw whatever chat-run job a session currently has outstanding.
 *
 * Two ids are tried because the claim and the enqueue are not the same moment.
 * `activeJobId` is authoritative once a worker has picked the job up, but it is
 * null for the whole window between `send`/`retry` committing the claim and a
 * worker claiming it — precisely the window where cancelling saves the most,
 * since nothing has been dispatched yet. So the deterministic id is
 * reconstructed as well, from the session's current generation and its latest
 * user turn: the same inputs `enqueueChatRun` used. They are normally the same
 * string; when they differ, one of them is stale and removing both is correct.
 *
 * Best-effort throughout. See {@link cancelChatRun} for why a failure here must
 * not fail the caller.
 */
async function cancelQueuedChatRun(session: { id: string; runGeneration: number }): Promise<void> {
  const ids = new Set<string>();
  try {
    const [live, latestUser] = await Promise.all([
      prisma.chatSession.findUnique({
        where: { id: session.id },
        select: { activeJobId: true, runGeneration: true },
      }),
      prisma.chatMessage.findFirst({
        where: { sessionId: session.id, role: "USER" },
        orderBy: { seq: "desc" },
        select: { seq: true },
      }),
    ]);
    if (live?.activeJobId) ids.add(live.activeJobId);
    if (latestUser) {
      ids.add(
        chatRunJobId({
          sessionId: session.id,
          userMessageSeq: latestUser.seq,
          runGeneration: live?.runGeneration ?? session.runGeneration,
        }),
      );
    }
  } catch (error) {
    console.warn("[chat] could not resolve the job id to cancel", { sessionId: session.id, error });
    return;
  }
  await Promise.all([...ids].map((id) => cancelChatRun(id)));
}

/**
 * Tell every OTHER client watching this conversation that a run has started.
 *
 * The submitting tab already knows — its mutation flips its own state. This
 * frame is for the ones that did not submit: a second tab, a phone, a laptop
 * left open. Without it they hold an IDLE status and an ENABLED composer for the
 * entire answer, and their next send fails with "wait for the current response"
 * — a conflict the server could have prevented them from ever attempting.
 *
 * It also carries the transcript. The user message that started the run is a
 * persisted row, and no frame ever contains one; a watching client that only
 * learned the status would render "Thinking…" above a question it cannot see.
 * The client's handler for a recognised `status` frame refetches both.
 *
 * `seq` is the session's next unallocated cursor — above everything emitted so
 * far. A `status` frame carries no SSE `id:`, so it can never advance anyone's
 * resume cursor; the number only orders the frame.
 *
 * Best-effort, like every publish in this feature: Postgres already holds the
 * RUNNING claim, so a lost frame costs those clients a stale composer until
 * their next reconnect — never correctness. It must not fail the send.
 */
async function publishRunStarted(sessionId: string, seq: number): Promise<void> {
  try {
    await redisConnection.publish(
      `chat:${sessionId}`,
      JSON.stringify({ type: "status", seq, data: "running" }),
    );
  } catch (error) {
    console.warn("[chat] could not announce the run to other clients", { sessionId, error });
  }
}

/**
 * Release a session claim whose enqueue never made it to BullMQ.
 *
 * `send` and `retry` both flip the session to RUNNING and only then hand the
 * turn to the queue (deliberately — see the comment at the `send` call site).
 * If that hand-off throws, nothing will ever answer the turn, and a session
 * left RUNNING is wedged forever: the composer stays disabled, and `retry`
 * refuses because it only accepts `status: ERROR`. Landing on ERROR is the one
 * state the UI already knows how to recover from, and it is also what the
 * worker's claim predicate expects to find for a re-run.
 *
 * The WHERE is narrow on purpose: `status: "RUNNING", activeJobId: null` is
 * exactly the claim `send`/`retry` take, and a worker stamps `activeJobId` the
 * moment it picks the job up. So if the job *did* reach Redis and only the ack
 * was lost, this releases nothing and the run proceeds untouched.
 *
 * Failures here are logged, never thrown — the enqueue error is the one the
 * caller has to see.
 */
async function releaseClaimAfterEnqueueFailure(sessionId: string, ownerId: string) {
  try {
    await prisma.chatSession.updateMany({
      where: { id: sessionId, ownerId, status: "RUNNING", activeJobId: null },
      data: { status: "ERROR", activeJobId: null },
    });
  } catch (error) {
    console.error("[chat] failed to release session claim after enqueue failure", error);
  }
}

export const chatRouter = {
  /**
   * Whether this deployment can serve chat at all.
   *
   * The UI's half of {@link assertChatEnabled}. Hiding the entry point is not a
   * security control — the procedures refuse regardless — it is what stops the
   * app from offering a conversation it cannot hold. `protectedProcedure`
   * because chat is an authenticated surface and there is no reason to tell an
   * anonymous caller anything about how this server is configured.
   */
  config: protectedProcedure.handler(async () => ({ enabled: chatEnabled() })),

  createSession: protectedProcedure.handler(async ({ context }) => {
    // The whole feature, or none of it. Refusing here is what keeps a
    // misconfigured deployment from committing a session, a message and a
    // RUNNING claim for a run that can only fail. See {@link assertChatEnabled}.
    assertChatEnabled();
    // Before the insert, so a refused request leaves no row behind. Its own
    // bucket, not the send budget's: a session costs a row and no model call,
    // so metering only turns leaves row creation bounded by nothing a client
    // that never sends a message would ever touch.
    await consumeChatSessionBudget(context.session.user.id);
    return serializeChatSession(
      await prisma.chatSession.create({
        data: {
          ownerId: context.session.user.id,
          // The locale-neutral "unset" sentinel, not an English placeholder: a
          // stored "New chat" renders in English for every locale, in the page
          // header and the session rail, and stays there indefinitely if the
          // first run fails before the worker auto-titles. The UI renders
          // `chat:sessions.untitled` for an empty title; the worker replaces it
          // with the first user message. See the schema comment on
          // `ChatSession.title`.
          title: "",
          status: "IDLE",
        },
        select: chatSessionSelect,
      }),
    );
  }),

  listSessions: protectedProcedure.input(cursorPageInput).handler(async ({ input, context }) => {
    const sessions = await prisma.chatSession.findMany({
      // The owner scope stays the first `AND` member; the cursor is a keyset
      // fragment ANDed onto it, never a replacement for it.
      where: withCursor({ ownerId: context.session.user.id }, "updatedAt", input.cursor, "desc"),
      // `id` breaks ties: `updatedAt` alone is not unique, and a cursor into a
      // non-total order silently skips or repeats rows across pages.
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: pageTake(input.limit),
      // `updatedAt` is fetched only to anchor the cursor; `serializeChatSession`
      // keeps it out of the response.
      select: { ...chatSessionSelect, updatedAt: true },
    });
    const page = cursorPage(sessions, input.limit, "updatedAt");
    return {
      items: page.items.map(serializeChatSession),
      nextCursor: page.nextCursor,
    };
  }),

  getSession: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const session = await prisma.chatSession.findFirst({
        where: { id: input.id, ownerId: context.session.user.id },
        select: chatSessionSelect,
      });
      if (!session) throw notFound();
      return serializeChatSession(session);
    }),

  /**
   * One page of a transcript, NEWEST FIRST — and that direction is the whole
   * point.
   *
   * A transcript is read newest-at-the-bottom, so the page a client needs on
   * open is the *end* of the conversation, not its beginning. Paging forward
   * from `seq 0` instead made every session past `limit` messages permanently
   * truncated at the top of the log: the newest rows were on a page nobody ever
   * fetched, so a user turn beyond the first page never rendered at all (the
   * SSE stream publishes assistant frames, never the user's own message — that
   * row reaches the browser only through this query or through a reconnect's
   * replay, and the replay cursor has long since advanced past it). Older
   * messages are reachable through "Load older"; newer ones had no second route
   * back.
   *
   * So `cursor` is an EXCLUSIVE UPPER bound — "the oldest `seq` I already hold;
   * give me what sits below it" — and `nextCursor` is the lowest `seq` on this
   * page. Each page is still returned in ascending `seq` order, because that is
   * the order it is rendered in; only the *paging* runs backwards.
   *
   * `seq` remains the cursor (not a row id) for the same reason as before: it is
   * the ordering key the SSE replay uses, it is immutable, and it is a total
   * order — so pages can neither repeat nor skip a row.
   */
  listMessages: protectedProcedure
    .input(
      sessionIdInput.extend({
        cursor: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .handler(async ({ input, context }) => {
      await ownedSession(input.sessionId, context.session.user.id);
      const messages = await prisma.chatMessage.findMany({
        where: {
          sessionId: input.sessionId,
          ...(input.cursor === undefined ? {} : { seq: { lt: input.cursor } }),
        },
        // Descending is how the page is SELECTED (the newest `limit` rows below
        // the cursor); it is reversed below because ascending is how it is read.
        orderBy: { seq: "desc" },
        take: pageTake(input.limit),
        select: chatMessageSelect,
      });
      const hasMore = messages.length > input.limit;
      const page = messages.slice(0, input.limit).reverse();
      return {
        items: page.map(serializeChatMessage),
        // The page's LOWEST seq: the next page is everything strictly below it.
        // `undefined` when this page reached the start of the conversation.
        nextCursor: hasMore ? page[0]?.seq : undefined,
      };
    }),

  send: protectedProcedure
    .input(sessionIdInput.extend({ text: z.string().trim().min(1).max(8000) }))
    .handler(async ({ input, context }) => {
      assertChatEnabled();
      await ownedSession(input.sessionId, context.session.user.id);
      // Before the claim, so a refused turn leaves nothing committed to undo.
      // Charged per ATTEMPT rather than per accepted run, which is safe here
      // only because the bucket is keyed on the caller's OWN account: the one
      // person who can exhaust it is the person making the requests. (The
      // opposite case — a bucket keyed on an address an attacker supplies —
      // is why the mail limiters meter the outcome instead. See
      // patterns/rate-limiting.md.)
      await consumeChatSendBudget(context.session.user.id);
      const claim = await prisma.$transaction(async (tx) => {
        // Conditional transition = the one-active-job invariant shared with the
        // worker. `updateMany` with `status: { not: "RUNNING" }` in the WHERE
        // makes the claim atomic: two concurrent sends race on the same row and
        // exactly one sees `count === 1`. A read-then-write would let both pass.
        //
        // `activeJobId: null` because taking the claim means no job owns this
        // session yet — the worker's own claim (chat-run.ts) is a compare-and-
        // set against exactly that, so a stale id left behind by a crashed run
        // would otherwise lock every future job out of the session.
        //
        // `runGeneration` is bumped in the SAME statement: the claim and the id
        // of the job that fulfils it are one atomic fact. Every accepted claim
        // gets a generation nothing else can hand out, which is what makes the
        // job id unique per claim without giving up dedupe of a re-sent claim.
        const claimed = await tx.chatSession.updateMany({
          where: {
            id: input.sessionId,
            ownerId: context.session.user.id,
            status: { not: "RUNNING" },
          },
          data: { status: "RUNNING", activeJobId: null, runGeneration: { increment: 1 } },
        });
        if (claimed.count === 0) throw runningConflict();
        // Read back inside the transaction — `updateMany` returns a count, not
        // the row, and the post-increment value is the one the job id needs.
        const claimedSession = await tx.chatSession.findUniqueOrThrow({
          where: { id: input.sessionId },
          select: { runGeneration: true, nextSeq: true },
        });
        const aggregate = await tx.chatMessage.aggregate({
          where: { sessionId: input.sessionId },
          _max: { seq: true },
        });
        // The seq comes from the session's allocator, NOT from `MAX(seq) + 1`
        // alone: a cursor must never be recycled. The worker deletes a failed
        // attempt's partial assistant rows, so `MAX(seq) + 1` can drop back onto
        // a seq some client already holds as its `Last-Event-ID` — and its
        // replay (`seq > cursor`) would then skip this message forever. The
        // `MAX(seq) + 1` term survives only as the floor that makes the
        // additively-defaulted `nextSeq` correct for sessions that predate the
        // column. `send` serializes with the worker through the RUNNING claim
        // taken above, so this read-then-write cannot race one.
        const nextSeq = Math.max(claimedSession.nextSeq, (aggregate._max.seq ?? -1) + 1);
        await tx.chatMessage.create({
          data: {
            sessionId: input.sessionId,
            seq: nextSeq,
            role: "USER",
            // `content`, not `text`: this is an AgentMessagePart, and the worker
            // feeds these parts straight to the model. A `text` key here reads
            // back as an empty text part and the model answers a blank prompt.
            parts: [{ type: "text", content: input.text }],
          },
        });
        // Advance the allocator in the same transaction as the row it handed
        // out, so the seq can never be issued twice even if this turn's rows are
        // later deleted.
        await tx.chatSession.update({
          where: { id: input.sessionId },
          data: { nextSeq: nextSeq + 1 },
        });
        return { seq: nextSeq, runGeneration: claimedSession.runGeneration };
      });
      // AFTER the commit, deliberately: the worker loads the session by id and
      // would not see the user message if the enqueue raced the transaction.
      // The cost of that ordering is this catch — the claim is already durable,
      // so an unreachable Redis has to hand the session back as ERROR rather
      // than leave it RUNNING with nothing on its way to answer it.
      try {
        await enqueueChatRun({
          sessionId: input.sessionId,
          userMessageSeq: claim.seq,
          runGeneration: claim.runGeneration,
        });
      } catch (error) {
        await releaseClaimAfterEnqueueFailure(input.sessionId, context.session.user.id);
        throw error;
      }
      // AFTER the enqueue, so no client is told a run started that never got
      // queued: an enqueue failure releases the claim back to ERROR above, and a
      // frame published before that would leave every other tab waiting on an
      // answer that was never going to come.
      await publishRunStarted(input.sessionId, claim.seq + 1);
      return { userMessageSeq: claim.seq };
    }),

  renameSession: protectedProcedure
    .input(sessionIdInput.extend({ title: z.string().trim().min(1).max(100) }))
    .handler(async ({ input, context }) => {
      const session = await ownedSession(input.sessionId, context.session.user.id);
      return serializeChatSession(
        await prisma.chatSession.update({
          where: { id: session.id },
          data: { title: input.title },
          select: chatSessionSelect,
        }),
      );
    }),

  deleteSession: protectedProcedure.input(sessionIdInput).handler(async ({ input, context }) => {
    const session = await ownedSession(input.sessionId, context.session.user.id);
    // Cancel first, delete second — and deleting is allowed while RUNNING.
    //
    // Refusing to delete a running session would be the wrong fix: an
    // unanswerable conversation is exactly the one a user most wants gone, and
    // a wedged RUNNING session (the state the reaper exists to sweep) would
    // become undeletable for as long as it stayed wedged.
    //
    // So the delete stands and the queued work is withdrawn beneath it. This
    // matters most for a job still WAITING: nothing has been dispatched yet, so
    // removing it saves the entire run. A job already executing is not
    // removable, but the handler re-checks ownership as it streams and finds the
    // session gone, so it aborts within a few seconds rather than paying out the
    // full `CHAT_MAX_ITERATIONS`. Best-effort throughout — see
    // {@link cancelQueuedChatRun}.
    await cancelQueuedChatRun(session);
    await prisma.chatSession.delete({ where: { id: session.id } });
    return { success: true };
  }),

  retry: protectedProcedure.input(sessionIdInput).handler(async ({ input, context }) => {
    assertChatEnabled();
    const session = await ownedSession(input.sessionId, context.session.user.id);
    if (String(session.status) !== "ERROR") throw notFailedConflict();
    const latestUser = await prisma.chatMessage.findFirst({
      where: { sessionId: input.sessionId, role: "USER" },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    if (!latestUser) throw new ORPCError("CONFLICT", { message: "No user message to retry" });
    // Same budget as `send`, and deliberately the SAME bucket: a retry queues
    // the identical run and bills the identical dispatches, so metering it
    // separately would just double the ceiling.
    await consumeChatSendBudget(context.session.user.id);
    const runGeneration = await prisma.$transaction(async (tx) => {
      // Conditional claim, exactly as in `send` — the status check above is a
      // read-then-write and two clicks on Retry would both sail past it, each
      // taking a fresh generation and each billing the model for the same turn.
      // `status: "ERROR"` is the only claimable state here (a RUNNING session
      // already has an answer on the way, an IDLE one already has its answer).
      const claimed = await tx.chatSession.updateMany({
        where: { id: session.id, ownerId: context.session.user.id, status: "ERROR" },
        data: { status: "RUNNING", activeJobId: null, runGeneration: { increment: 1 } },
      });
      if (claimed.count === 0) throw notFailedConflict();
      // The bumped counter — NOT a count of assistant rows — is the retry
      // generation in the job id. A failed attempt may have persisted nothing
      // (bad OPENROUTER_API_KEY, auth rejection, network failure on the first
      // dispatch), and the worker clears whatever partial rows an attempt did
      // leave, so any row-derived generation repeats itself across retries.
      // BullMQ keeps failed jobs for 24h and drops a re-`add()` of an existing
      // id *without throwing*, so a repeat would leave this session RUNNING
      // with nothing queued to answer it — and the release path below, which
      // only fires when `add()` rejects, would not save it.
      const claimedSession = await tx.chatSession.findUniqueOrThrow({
        where: { id: session.id },
        select: { runGeneration: true },
      });
      return claimedSession.runGeneration;
    });
    // Same failure mode as `send`: the RUNNING claim is already committed, so an
    // enqueue that never lands must put the session back into the only state
    // this procedure will accept again.
    try {
      await enqueueChatRun({
        sessionId: input.sessionId,
        userMessageSeq: latestUser.seq,
        runGeneration,
      });
    } catch (error) {
      await releaseClaimAfterEnqueueFailure(input.sessionId, context.session.user.id);
      throw error;
    }
    await publishRunStarted(input.sessionId, latestUser.seq + 1);
    return { userMessageSeq: latestUser.seq };
  }),
};
