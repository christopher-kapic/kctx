import { createProcedureBudget } from "./procedure-budget";
import { chatRateFamily, type ScaledMember } from "./rate-limit-families";

/**
 * The chat SPEND limiter — `chat.send` and `chat.retry`.
 *
 * ── Why this one limiter does not live in `apps/server/src/rate-limit.ts` ────
 *
 * Every other limiter in this app guards a Hono route and is mounted as
 * middleware in `apps/server/src/index.ts`. These two are oRPC *procedures*,
 * and a procedure is not a route:
 *
 *   • The SPA's oRPC client batches, so several procedures arrive as ONE POST
 *     to `/rpc/chat/__batch__` (see `ORPC_BATCH_MAX_SIZE`). Path-mounted
 *     middleware would charge that batch a single point no matter how many
 *     sends it carried, and would charge a `listMessages` the same as a send.
 *   • Nothing in the URL distinguishes `chat.send` from `chat.listSessions`.
 *
 * So enforcement belongs in the procedure layer, and the limiter belongs beside
 * the procedures it guards. `apps/server/src/rate-limit.ts` carries a pointer
 * comment; the tables in patterns/rate-limiting.md list this bucket alongside
 * the route-mounted ones.
 *
 * ── What one point buys ─────────────────────────────────────────────────────
 *
 * One ACCEPTED TURN, not one HTTP request. That is the unit that costs money:
 * an accepted `send` commits a user message, flips the session to RUNNING and
 * enqueues a `chat-run` job which may spend up to `CHAT_MAX_ITERATIONS` PAID
 * model dispatches, and `CHAT_RUN_CONCURRENCY` only decides how fast the queue
 * drains — the excess is queued, never shed. Without a budget here, one
 * signed-in client sits inside the generic 100/min `/rpc/*` ceiling and still
 * builds an indefinitely growing, indefinitely expensive backlog.
 *
 * The default (20 per 60 s) is sized off one legitimate user action: a
 * conversational turn is one point, and a turn is followed by waiting for the
 * answer — `send` is refused outright while its session is RUNNING, so a single
 * conversation cannot even reach 2/minute. Twenty clears a fast human with
 * several sessions open in several tabs, plus their retries, with room to
 * spare, while capping one account's backlog growth at 20 runs per minute.
 *
 * ── Keyed on the credential, not the IP ─────────────────────────────────────
 *
 * `uid:<user id>`, taken from the session `protectedProcedure` has already
 * verified. Keying on IP would be wrong in both directions here: offices,
 * schools, and carriers put hundreds of people behind one address (so an IP
 * budget large enough for them is no per-account budget at all), and the thing
 * being protected is an account's ability to spend, not a network's ability to
 * make requests.
 *
 * The usual companion rule — *a limiter keyed on caller-supplied data must sit
 * behind a coarser one* — is satisfied, and it is worth being precise about
 * why. A credential-keyed limiter in front of authentication keys on a token
 * that was merely PRESENTED, so varying it mints a fresh bucket per request —
 * which is why such a limiter always needs a coarser one behind it. This key
 * is different: it is read after
 * Better-Auth validated the session cookie, so minting a fresh bucket means
 * minting a fresh ACCOUNT (signup + email verification, itself bounded by
 * `signupLimiter` and `signupRecipientLimiter`). The coarser layer is in place
 * regardless and is not being tightened: every `/rpc/*` request already passes
 * the IP-or-user-keyed `rpcLimiter` before it reaches this procedure.
 *
 * ── Fail-CLOSED ─────────────────────────────────────────────────────────────
 *
 * Apply the doc's test — does losing this for ten minutes let a caller do
 * something irreversible? Yes: spend. Money paid to a model provider does not
 * come back, and the worker slots the backlog occupies are denied to every
 * other user until it drains. So a Redis outage refuses the turn rather than
 * waving it through, and, like the other strict limiters, this one carries NO
 * `insuranceLimiter`: a per-process ceiling is not a real bound across a
 * horizontally-scaled fleet, and here it would be precisely the thing quietly
 * letting spend through during the outage.
 *
 * The availability cost is close to zero, which is what makes the trade easy:
 * the very next thing an accepted `send` does is `enqueueChatRun` against this
 * same Redis. With Redis down the turn was going to fail anyway — this just
 * fails it before a claim is committed and a user message is written, instead
 * of after.
 *
 * No `blockDuration`. A block would deny a user their own conversation for
 * minutes after a burst and buys nothing: the window already caps spend, and
 * the key is an account rather than an attacker-chosen string.
 */
/**
 * Chat family members (reference: 20 accepted turns / 60 s here, 30 sessions,
 * 60 stream connections). Setting `RATE_LIMIT_CHAT_POINTS` / `_WINDOW_SECONDS`
 * re-tunes all three together, at each member's designed ratio — see
 * ./rate-limit-families.ts.
 *
 * Resolved LAZILY (first consume), same as the old per-surface env reads:
 * `createProcedureBudget` builds its limiter on first use, so importing the
 * router graph in a test must not require the budget keys in its env mock.
 * The getters below feed `createProcedureBudget` its numbers at limiter-build
 * time instead of at module load.
 */
let sendBudget: ScaledMember | undefined;
let sessionBudget: ScaledMember | undefined;

function resolveSendBudget(): ScaledMember {
  sendBudget ??= chatRateFamily({ points: 20, windowSeconds: 60 });
  return sendBudget;
}

function resolveSessionBudget(): ScaledMember {
  sessionBudget ??= chatRateFamily({ points: 30, windowSeconds: 60 });
  return sessionBudget;
}

const consumeChatSend = createProcedureBudget({
  keyPrefix: "rl:chat-send",
  get points() {
    return resolveSendBudget().points;
  },
  get durationSeconds() {
    return resolveSendBudget().durationSeconds;
  },
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `You're sending messages faster than they can be answered. Try again in ${retryAfterSeconds}s.`,
  unavailableMessage: "Chat is temporarily unavailable. Please try again in a moment.",
  unavailableLog: "[chat] spend limiter unavailable, failing closed:",
});

/**
 * The session-CREATION bucket — `chat.createSession`.
 *
 * A SEPARATE `keyPrefix`, which is the entire point: `keyPrefix` is what makes
 * a budget independent, and these two surfaces are bounded by different costs.
 * The send bucket meters MONEY (each point may buy `CHAT_MAX_ITERATIONS` paid
 * dispatches); this one meters ROWS. Sharing one bucket would either price
 * session creation as though it called a model — throttling a user who opens
 * several conversations to skim them — or, in the direction that actually
 * matters, leave row creation metered by a budget that a client which never
 * sends a message never touches at all. Creating a session costs one insert
 * and no model call, so nothing else in the chat surface bounds how many an
 * authenticated client can mint.
 *
 * Fail-closed like its sibling, for a plainer reason than spend: with Redis
 * down the session is unusable the moment it exists (`send` refuses, the stream
 * has no publisher), so refusing up front costs a user nothing they were about
 * to get and keeps an outage from being the window in which the table fills.
 */
const consumeChatSession = createProcedureBudget({
  keyPrefix: "rl:chat-session",
  get points() {
    return resolveSessionBudget().points;
  },
  get durationSeconds() {
    return resolveSessionBudget().durationSeconds;
  },
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `You're starting conversations faster than expected. Try again in ${retryAfterSeconds}s.`,
  unavailableMessage: "Chat is temporarily unavailable. Please try again in a moment.",
  unavailableLog: "[chat] session limiter unavailable, failing closed:",
});

/**
 * Charge one accepted chat turn to `userId`, or throw.
 *
 * Call it BEFORE the claim transaction, so a refused turn leaves no committed
 * state behind: no RUNNING session to release, no user message written for a
 * run that will never happen.
 *
 * `TOO_MANY_REQUESTS` over budget; `SERVICE_UNAVAILABLE` when the store is
 * unreachable (fail-closed — see the limiter's doc comment).
 */
export async function consumeChatSendBudget(userId: string): Promise<void> {
  await consumeChatSend(`uid:${userId}`);
}

/**
 * Charge one created chat session to `userId`, or throw.
 *
 * Call it BEFORE the insert, for the same reason `consumeChatSendBudget` runs
 * before the claim: a refused request must leave no row behind.
 *
 * Same two failure shapes as the send budget — `TOO_MANY_REQUESTS` over budget,
 * `SERVICE_UNAVAILABLE` when the store is unreachable — off a DIFFERENT bucket.
 * See {@link consumeChatSession}.
 */
export async function consumeChatSessionBudget(userId: string): Promise<void> {
  await consumeChatSession(`uid:${userId}`);
}
