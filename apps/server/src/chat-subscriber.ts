import { createRedisConnection } from "@starter/queue";

/**
 * Process-wide fan-out for chat live events.
 *
 * ONE Redis connection for the whole server, not one per SSE stream. Redis
 * connections in subscriber mode can do nothing else, so a per-stream
 * `subscribe()` makes open connections scale with concurrent readers — a few
 * hundred idle browser tabs is enough to exhaust a small managed Redis. This
 * module opens a single `psubscribe("chat:*")` lazily on the first subscriber
 * and demultiplexes by session id in memory, so connection count is O(1) in
 * readers.
 *
 * Events here are BEST-EFFORT. A dropped message, a reconnect, or a process
 * restart loses nothing: `apps/server/src/chat-routes.ts` replays from Postgres
 * on connect and only switches to live events past the replayed high-water
 * mark. Nothing in this file may become the only path a message travels.
 */

/** Mirrors the `ChatMessageState` enum in `packages/db/prisma/schema/chat.prisma`. */
type ChatMessageState = "STREAMING" | "COMPLETE";

export type ChatLiveEvent = {
  type: "chunk" | "message" | "status";
  seq: number;
  /**
   * Whether the row this frame describes is final. Published only on `message`
   * frames, and the reader stamps an SSE `id:` only when it is `"COMPLETE"` —
   * an absent or unrecognised value therefore fails toward "not a resume
   * point", which is the safe direction (a cursor that lags replays; a cursor
   * that runs ahead loses a message).
   */
  state?: ChatMessageState;
  data: unknown;
};
type Listener = (event: ChatLiveEvent) => void;

const listeners = new Map<string, Set<Listener>>();
let subscriber: ReturnType<typeof createRedisConnection> | undefined;
let starting: Promise<void> | undefined;

/**
 * How long the one-time `psubscribe` may take before this module gives up and
 * reports the transport as unavailable.
 *
 * A HUNG DEPENDENCY IS NOT A FAILED DEPENDENCY. `createRedisConnection()` uses
 * `maxRetriesPerRequest: null` and sets no `commandTimeout` — ioredis's "retry
 * forever" configuration — so an unreachable Redis leaves `psubscribe()`
 * PENDING rather than rejecting: the command sits in the offline queue while
 * the connection reconnects on a loop. Without this bound the reader's
 * `await subscribeToChat(...)` never settles, the replay-only degradation in
 * `chat-routes.ts` is never reached, and a Redis outage costs the reader
 * history that is already committed to Postgres — the exact inversion of this
 * feature's invariant, arrived at through code that looks correct.
 *
 * A plain constant rather than an env var: it is a liveness bound on a
 * best-effort transport, not a tuning knob — too low only means a reader takes
 * the (fully correct) replay-only path sooner, and too high means a reader
 * waits longer for the same outcome. It matches the connection's own 5s
 * `connectTimeout`, so an attempt is abandoned about one failed connect after
 * it would have succeeded.
 */
const SUBSCRIBE_TIMEOUT_MS = 5_000;

/**
 * `promise`, but rejecting if it has not settled within `ms`.
 *
 * The loser of the race is NOT cancellable — `psubscribe` may still resolve
 * long after this rejects — so every caller must treat a timeout as final and
 * tear down whatever the pending work would have used. See {@link
 * ensureSubscriber}, which disconnects the half-open connection precisely
 * because a late resolution must not be able to revive it.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    // Never hold the process open just to fail a subscription later.
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isChatLiveEvent(value: unknown): value is ChatLiveEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    (event.type === "chunk" || event.type === "message" || event.type === "status") &&
    typeof event.seq === "number" &&
    // Absent is legal (a `chunk`/`status` frame, or a producer that predates the
    // field) and is simply not `"COMPLETE"`, so it can never earn an `id:`. An
    // unrecognised value drops the frame: adding a member to the Prisma
    // `ChatMessageState` enum means adding it here too. Costs liveness only —
    // the row is in Postgres and the next replay delivers it.
    (event.state === undefined || event.state === "STREAMING" || event.state === "COMPLETE")
  );
}

async function ensureSubscriber() {
  if (subscriber) return;
  // Single-flight: concurrent first subscribers await the same promise instead
  // of each opening a connection and racing to win the `subscriber` slot.
  starting ??= (async () => {
    const connection = createRedisConnection();
    const onMessage = (_pattern: string, channel: string, payload: string) => {
      if (!channel.startsWith("chat:")) return;
      try {
        const event: unknown = JSON.parse(payload);
        if (!isChatLiveEvent(event)) return;
        for (const listener of listeners.get(channel.slice(5)) ?? []) listener(event);
      } catch {
        // Ignore malformed pub/sub payloads. Deliberately not logged: the
        // payload is private chat content, and Postgres remains authoritative.
      }
    };
    connection.on("pmessage", onMessage);
    try {
      await withTimeout(
        connection.psubscribe("chat:*"),
        SUBSCRIBE_TIMEOUT_MS,
        `chat subscription did not complete within ${SUBSCRIBE_TIMEOUT_MS}ms`,
      );
    } catch (error) {
      // Abandon the attempt completely rather than leave a half-open connection
      // reconnecting in the background: drop the handler (so a socket that
      // recovers later cannot fan out through an attempt nobody is holding) and
      // close it. `subscriber` is never assigned on this path, and the `finally`
      // below clears `starting`, so nothing is poisoned — the NEXT reader opens
      // a fresh connection and succeeds the moment Redis is back.
      connection.off("pmessage", onMessage);
      connection.disconnect();
      throw error;
    }
    // Reached only when `psubscribe` won the race. A late resolution cannot get
    // here: the `throw` above already ended this function, so there is no path
    // on which a timed-out attempt installs itself as the shared subscriber.
    subscriber = connection;
  })().finally(() => {
    starting = undefined;
  });
  await starting;
}

/**
 * Register `listener` for one session's live events. Returns an unsubscribe
 * function — call it from the stream's abort/cleanup path or the map leaks a
 * Set per disconnected reader.
 */
export async function subscribeToChat(sessionId: string, listener: Listener) {
  const sessionListeners = listeners.get(sessionId) ?? new Set<Listener>();
  sessionListeners.add(listener);
  listeners.set(sessionId, sessionListeners);
  try {
    await ensureSubscriber();
  } catch (error) {
    sessionListeners.delete(listener);
    if (sessionListeners.size === 0) listeners.delete(sessionId);
    throw error;
  }
  return () => {
    sessionListeners.delete(listener);
    if (sessionListeners.size === 0) listeners.delete(sessionId);
  };
}

/** Drop every listener and close the shared connection. Used by tests. */
export async function closeChatSubscriber() {
  listeners.clear();
  const connection = subscriber;
  subscriber = undefined;
  if (connection) connection.disconnect();
}

/** Live listener count for a session. Used by tests to assert cleanup. */
export function chatSubscriberListenerCount(sessionId: string) {
  return listeners.get(sessionId)?.size ?? 0;
}
