import { env } from "@starter/env/web";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { orpc } from "@/utils/orpc";

/**
 * EventSource client for the durable chat stream
 * (`GET /api/chat/:sessionId/stream`, mounted in `apps/server/src/chat-routes.ts`).
 *
 * THE CLIENT HALF OF THE RESUMABILITY CONTRACT. Postgres is authoritative and
 * every persisted message carries a monotonic per-session `seq`, which the
 * server sends as the SSE `id:`. This hook therefore only ever has to remember
 * one number — the highest `seq` it has seen — and hand it back on connect
 * (`?lastEventId=`, the manual equivalent of the `Last-Event-ID` header the
 * browser replays automatically). The server returns exactly what was missed.
 * Until there IS such a number the parameter is omitted entirely: `seq` starts
 * at 0, so sending `0` would claim the first message had already been seen and
 * the server's `seq > cursor` replay would skip it forever.
 *
 * ONLY THE SSE `id:` MAY ADVANCE THE CURSOR — never a `seq` read out of a
 * payload. The server stamps an `id:` only on a `message` frame whose row is
 * FINAL (`state: "COMPLETE"`), because a streaming assistant turn is rewritten
 * in place under one `seq`: it is durable, but it is not what the reader will
 * end up with. Advancing from a partial (or from a chunk, published before the
 * row exists at all) would make a reconnect ask for `seq > N` and never receive
 * the finished row N — the answer would stay truncated forever. So this hook
 * reads its cursor from `lastEventId` and from COMPLETE hydrated rows only,
 * while still rendering everything it receives.
 *
 * Three event types, three different jobs:
 *   * `message` — a durable row, and the only cursor source (when final). It
 *     REPLACES whatever is stored at that `seq`, which is how streamed-in text
 *     is swapped for its persisted form instead of being rendered twice. Its
 *     `seq` rides in the JSON payload, because a partial frame has no `id:` to
 *     read it from.
 *   * `chunk` — transient tokens. Its `seq` lives in the JSON payload (NOT in
 *     `lastEventId`, which still holds the last *final* message id) and is used
 *     only to coalesce text into the right slot, so a partial answer renders
 *     while it is still being written. Losing one costs a flicker, never a
 *     message.
 *   * `status` — session-level state (`idle` / `error`). Both are TERMINAL, and
 *     they are the only signal that the *session row* changed: the worker
 *     writes the final status and the auto-generated title before it publishes
 *     one, long after the send mutation (and its invalidation) resolved. So a
 *     terminal frame also refetches the session queries — see
 *     {@link parseChatStatusFrame}.
 *
 * The transcript itself is DERIVED, never copied: state holds only what the
 * stream delivered, and the query-hydrated rows are the authority for the range
 * they cover — the live map contributes only the tail above their highest FINAL
 * `seq` (see `messages` below). Nothing has to re-render to reconcile the two, so a
 * refetch can never show a transcript that is a beat behind the props it was
 * built from, and a row the server deleted cannot linger in live state.
 *
 * Lives in `hooks/` because it owns effects (subscription lifecycle, a ticking
 * clock) — the approved encapsulation boundary for the `useEffect` ban that
 * covers `components/**` and `routes/**`.
 */

export type ChatPart = { type: string; [key: string]: unknown };
export type ChatMessage = {
  id: string;
  seq: number;
  role: string;
  parts: ChatPart[];
  /**
   * `ChatMessage.state` as sent by the server — `"COMPLETE"` once the row is
   * final. Anything else (including `undefined`, from a frame or a cached
   * response that predates the field) means "still being written", which is the
   * safe reading: it keeps the `seq` out of the replay cursor.
   */
  state?: string;
};
type ChatStreamStatus = "IDLE" | "RUNNING" | "ERROR";

/** The one `state` value that makes a row a valid resume point. */
const COMPLETE = "COMPLETE";

/**
 * "I have seen nothing." Sequences start at 0, and the server replays
 * `seq > cursor`, so an absent cursor CANNOT be represented as 0 — that would
 * skip the session's first message. The wire form of "no cursor" is the absence
 * of the parameter (see {@link chatStreamQuery}); this sentinel is its
 * in-memory form, and it is deliberately below every real `seq`.
 */
const NO_CURSOR = -1;

/**
 * The stream query string. `?lastEventId=` is OMITTED entirely until a durable
 * `seq` has been seen, so `0` never has to mean both "message zero" and
 * "nothing yet" — the server's `parseCursor` reads a missing parameter as its
 * own pre-sequence sentinel and replays from the very first message.
 */
export function chatStreamQuery(cursor: number): string {
  return cursor >= 0 ? `?lastEventId=${cursor}` : "";
}

/**
 * The full stream URL, rooted at the API origin — NOT at the page's own.
 *
 * `VITE_SERVER_URL` is what every other call to the backend already uses (the
 * oRPC client, the auth client), and it is a *separate origin* in the deploy
 * topologies this template documents: web on one host, API on `api.<host>`. A
 * relative path works only in the same-origin case, so it fails exactly where
 * the split is deliberate — and it fails as a 404 or an unauthenticated stream,
 * which surfaces as "assistant never answers" rather than as anything pointing
 * at the URL. `withCredentials` on the EventSource carries the session cookie
 * across, which is why the split origin works at all once the origin is right.
 */
export function chatStreamUrl(sessionId: string, cursor: number): string {
  return `${env.VITE_SERVER_URL}/api/chat/${encodeURIComponent(sessionId)}/stream${chatStreamQuery(cursor)}`;
}

/**
 * The replay cursor the persisted transcript contributes: the highest `seq`
 * whose row is FINAL.
 *
 * A row the worker is still writing comes back from `listMessages` with
 * `state: "STREAMING"` and will be REWRITTEN under the same `seq`. Taking it as
 * a cursor would reconnect the stream at `seq > N` and never deliver the
 * finished version of N — the transcript would sit on a half-written answer
 * forever. Being committed is not the same as being final, and only the second
 * one is a resume point.
 *
 * Exported for its own test.
 */
export function hydratedCursor(messages: readonly ChatMessage[]): number {
  return messages.reduce(
    (max, item) => (item.state === COMPLETE ? Math.max(max, item.seq) : max),
    NO_CURSOR,
  );
}

/**
 * The cursor after a `message` frame: the frame's SSE `id:`, never the `seq` in
 * its payload.
 *
 * THE LIVE HALF OF THE SAME RULE. The server omits the `id:` on a frame for a
 * row that is still growing, so `lastEventId` still holds the last FINAL id —
 * which is exactly what should be resumed from. The frame's `seq` is passed in
 * and deliberately IGNORED: it is what places the content in the transcript, and
 * reaching for it here is the whole bug — the first partial of an answer would
 * advance the cursor onto a row that is still being rewritten, and the reconnect
 * (`seq > N`) would never deliver its finished form. Rendering a frame and
 * resuming from it are different decisions. (`lastEventId` on a frame that
 * carried no id is the last one that did, so this can only stand still, never
 * regress.)
 *
 * Exported for its own test.
 */
export function messageFrameCursor(
  current: number,
  frame: { lastEventId: string; seq: number },
): number {
  const id = Number(frame.lastEventId);
  if (!frame.lastEventId || !Number.isSafeInteger(id) || id < 0) return current;
  return Math.max(current, id);
}

/**
 * The rendered transcript: the hydrated rows, plus the live entries above them.
 *
 * `hydrated` is AUTHORITATIVE FOR THE RANGE IT COVERS — everything up to its
 * highest FINAL `seq` — and the live map contributes only the genuinely
 * in-flight tail. Overlaying the two row-by-row instead would strand a live
 * entry forever at a `seq` the server has since DELETED: a retry clears the
 * failed attempt's partial answer and re-answers on a fresh, higher seq (cursors
 * are never recycled), so the partial simply stops coming back from the query
 * and nothing would ever evict it from live state. Cutting at the hydrated
 * maximum makes it disappear on the next refetch, which is what the server
 * actually says.
 *
 * The cut is the highest COMPLETE row, not simply the highest row: opening a
 * session mid-run hydrates the in-flight answer as a STREAMING row, and cutting
 * there would suppress the very live frames that finish it — the transcript
 * would freeze on whatever the query happened to catch. Live wins above the cut
 * (it is strictly fresher), hydrated wins at or below it.
 *
 * Exported for its own test — it is the one piece of transcript logic that is
 * pure, and the invariant it encodes is worth pinning down.
 */
export function mergeTranscript(
  hydrated: ChatMessage[],
  live: Iterable<ChatMessage>,
): ChatMessage[] {
  const cut = hydratedCursor(hydrated);
  const tail = [...live].filter((item) => item.seq > cut);
  const superseded = new Set(tail.map((item) => item.seq));
  const base = hydrated.filter((item) => !superseded.has(item.seq));
  return [...base, ...tail].sort((left, right) => left.seq - right.seq);
}

/**
 * What a `status` frame means to this client, or `undefined` for a frame it
 * does not recognise.
 *
 * `idle` and `error` are the worker's two TERMINAL states, and both are
 * published *after* the run has written the session row — the final status and,
 * on the first successful run, the title derived from the first user message
 * (`apps/worker/src/handlers/chat-run.ts`). The send mutation's invalidation
 * resolved long before that write, so without this frame the rail and the page
 * header keep rendering the "untitled" fallback until an unrelated refetch.
 * `refetchSession` is what turns the frame into a refetch of the session
 * queries.
 *
 * `running` is the OPENING frame, published by `chat.send` / `chat.retry` the
 * moment a claim is accepted, and it exists for the clients that did not submit
 * it. Only the submitting tab calls `markRunning()`; without this frame every
 * other tab or device viewing the same conversation keeps an IDLE status and an
 * ENABLED composer for the whole answer, and its next send fails with the
 * server's "wait for the current response" conflict — a predictable error
 * presented as a surprise. It refetches for a second reason too: the user
 * message that started the run is a persisted row no frame ever carries, so a
 * watching tab would otherwise render "Thinking…" above a question it cannot
 * see.
 *
 * Two properties keep that from becoming a refetch loop, and both are why this
 * is a function rather than an inline `if`: an unrecognised frame yields
 * `undefined` (no status change, and emphatically no refetch), and each
 * recognised frame is published exactly once per run — one `running` on the
 * claim, one terminal frame at the end. Nothing a refetch updates is an input to
 * the subscription, so a refetch cannot produce another frame.
 *
 * Exported for its own test.
 */
export function parseChatStatusFrame(
  value: unknown,
): { status: ChatStreamStatus; refetchSession: boolean } | undefined {
  if (value === "idle") return { status: "IDLE", refetchSession: true };
  if (value === "error") return { status: "ERROR", refetchSession: true };
  if (value === "running") return { status: "RUNNING", refetchSession: true };
  return undefined;
}

/** A response that has produced nothing for this long is presumed wedged. */
const STALE_AFTER_MS = 120_000;
const CLOCK_TICK_MS = 30_000;

function parts(value: unknown): ChatPart[] {
  return Array.isArray(value)
    ? value.filter(
        (part): part is ChatPart => typeof part === "object" && part !== null && "type" in part,
      )
    : [];
}

/**
 * A `message` frame's payload. The `seq` comes from the payload and ONLY from
 * the payload: a partial frame carries no `id:`, so `lastEventId` would name the
 * previous message and file this content under the wrong slot. A frame without
 * a placeable `seq` is dropped rather than guessed at.
 */
function message(value: unknown): ChatMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const seq = item.seq;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return undefined;
  return {
    id: typeof item.id === "string" ? item.id : `stream-${seq}`,
    seq,
    role: typeof item.role === "string" ? item.role.toUpperCase() : "ASSISTANT",
    parts: parts(item.parts),
    ...(typeof item.state === "string" ? { state: item.state } : {}),
  };
}

/**
 * The message slot a chunk belongs to. It travels in the payload rather than in
 * the frame's `id:` precisely because it is not yet a valid resume point.
 * `undefined` means the chunk cannot be placed, so it is dropped — the durable
 * `message` frame carries the same text moments later.
 */
function chunkSeq(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const seq = (value as Record<string, unknown>).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : undefined;
}

/**
 * Pull display text out of a provider chunk. The shape is provider-specific and
 * not part of any contract, so every key is probed defensively (including one
 * level of `data`/`chunk` nesting) and an unrecognised chunk simply contributes
 * nothing.
 */
function chunkText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  for (const key of ["content", "delta", "text"]) {
    const candidate = item[key];
    if (typeof candidate === "string") return candidate;
  }
  if (depth > 0) return "";
  for (const key of ["data", "chunk", "delta"]) {
    const nested = chunkText(item[key], depth + 1);
    if (nested) return nested;
  }
  return "";
}

export function useChatStream(
  sessionId: string | undefined,
  hydrated: ChatMessage[],
  persistedStatus?: string,
) {
  // Only ever holds what arrived over the wire. The query-hydrated transcript is
  // folded in during render (see `messages` below) rather than copied into state,
  // so there is no window where the two disagree.
  const [liveMessages, setLiveMessages] = useState<Map<number, ChatMessage>>(new Map());
  const [status, setStatus] = useState<ChatStreamStatus | undefined>();
  const [lastActivityAt, setLastActivityAt] = useState(() => Date.now());
  const [clock, setClock] = useState(() => Date.now());
  const [connectionError, setConnectionError] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  // Starts at the pre-sequence sentinel, NOT 0: `seq` 0 is a real message (the
  // first one in the session), so a fresh client that reported `0` would be
  // asserting it had already seen a message it has never received.
  const highestSeq = useRef(NO_CURSOR);
  const activeSession = useRef<string | undefined>(undefined);
  // The replay cursor contributed by the persisted transcript, kept per-session
  // and out of React state: it must be readable when the stream opens without
  // making every refetch reopen the connection.
  const hydratedSeq = useRef<{ sessionId: string | undefined; seq: number }>({
    sessionId: undefined,
    seq: NO_CURSOR,
  });
  const queryClient = useQueryClient();

  /**
   * Re-read the session AND its transcript on any recognised `status` frame.
   *
   * `getSession` feeds the header and `listSessions` the rail — the two surfaces
   * showing the title the worker just wrote. `listMessages` is here for a
   * sharper reason:
   *
   * **THE STREAM CAN ADD AND REPLACE ROWS, BUT IT CANNOT RETRACT ONE.** There is
   * no delete frame, and there should not be — a client that missed it would
   * never learn. So a row the server REMOVED has no path to this client except a
   * refetch. That is not hypothetical: a failed run leaves a STREAMING partial,
   * and the retry deletes it and answers on a fresh, higher seq — see
   * patterns/durable-streaming.md § The cursor
   *
   * Without this invalidation the abandoned partial sits in the hydrated cache
   * forever, rendered directly above its own replacement. And `chat.retry`'s
   * own invalidation does not save it:
   * that fires before the worker has even claimed the turn, so it refetches the
   * partial rather than its absence.
   *
   * Refetching the whole transcript per finished turn is the cost, and it is
   * worth paying — but note it also cleans up the LIVE half for free, without a
   * second mechanism: `mergeTranscript` only keeps live rows ABOVE the highest
   * COMPLETE hydrated seq, so once the refetch lands the deleted partial falls
   * below the cut and is dropped from both halves at once.
   */
  const refreshFromStatusFrame = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: orpc.chat.getSession.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.chat.listSessions.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.chat.listMessages.key() });
  }, [queryClient]);

  // Ref bookkeeping only — a persisted row is a valid resume point exactly when
  // it is FINAL, which is what {@link hydratedCursor} filters on: a row the
  // worker is still writing comes back from the query too, and resuming from it
  // would skip its finished form. Declared before the subscription effect so a
  // session switch updates the cursor before the stream reads it.
  useEffect(() => {
    const highest = hydratedCursor(hydrated);
    hydratedSeq.current =
      hydratedSeq.current.sessionId === sessionId
        ? { sessionId, seq: Math.max(hydratedSeq.current.seq, highest) }
        : { sessionId, seq: highest };
  }, [hydrated, sessionId]);

  // Staleness is a function of elapsed time, so something has to re-render for
  // it to ever become true. A coarse tick is enough for a two-minute threshold.
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: connectionAttempt is an intentional re-run trigger — reconnect() bumps it to re-open the EventSource without changing sessionId, so removing it (as the auto-fix suggests) would break manual reconnection.
  useEffect(() => {
    if (!sessionId) return;
    // Opening the stream for a different session is what resets the session's
    // live state — the cursor most of all, since `seq` is per-session and a
    // cursor carried across would silently skip the new session's history. A
    // manual `reconnect()` re-runs this effect without changing `sessionId`, so
    // it deliberately keeps everything and resumes from where it left off.
    if (activeSession.current !== sessionId) {
      activeSession.current = sessionId;
      highestSeq.current = NO_CURSOR;
      setLiveMessages(new Map());
      setStatus(undefined);
      setLastActivityAt(Date.now());
      setConnectionError(false);
    }
    const persisted =
      hydratedSeq.current.sessionId === sessionId ? hydratedSeq.current.seq : NO_CURSOR;
    const cursor = Math.max(highestSeq.current, persisted);
    const source = new EventSource(chatStreamUrl(sessionId, cursor), {
      withCredentials: true,
    });
    const onOpen = () => setConnectionError(false);
    const onError = () => setConnectionError(true);
    const onMessage = (event: Event) => {
      const frame = event as MessageEvent<string>;
      try {
        const next = message(JSON.parse(frame.data));
        if (!next) return;
        setLastActivityAt(Date.now());
        // The frame's `id:`, NOT `next.seq`: a partial message is durable but
        // will be rewritten under the same seq, so it is not a resume point and
        // the server deliberately sends it without an id. Rendering it and
        // resuming from it are different decisions. See {@link messageFrameCursor}.
        highestSeq.current = messageFrameCursor(highestSeq.current, {
          lastEventId: frame.lastEventId,
          seq: next.seq,
        });
        setLiveMessages((current) => new Map(current).set(next.seq, next));
      } catch {
        // A malformed frame is ignored; the persisted replay stays authoritative.
      }
    };
    const onChunk = (event: Event) => {
      const frame = event as MessageEvent<string>;
      try {
        const payload: unknown = JSON.parse(frame.data);
        // NOT `frame.lastEventId` — chunks carry no `id:`, so it still holds the
        // last *final* message id. And `highestSeq` is deliberately NOT advanced
        // here: this seq names a row that may not even be committed yet, let
        // alone finished.
        const seq = chunkSeq(payload);
        const text = chunkText(payload);
        if (seq === undefined || !text) return;
        setLastActivityAt(Date.now());
        setLiveMessages((current) => {
          const next = new Map(current);
          const existing = next.get(seq) ?? {
            id: `stream-${seq}`,
            seq,
            role: "ASSISTANT",
            parts: [],
          };
          // Coalesce into ONE text part rather than appending a part per token:
          // the durable message that lands later has a single text part, and a
          // per-token list would reflow the whole answer when it arrives.
          const existingText = existing.parts.find((part) => part.type === "text");
          const previous = typeof existingText?.content === "string" ? existingText.content : "";
          next.set(seq, {
            ...existing,
            parts: [
              ...existing.parts.filter((part) => part !== existingText),
              { type: "text", content: `${previous}${text}` },
            ],
          });
          return next;
        });
      } catch {
        // Native EventSource reconnects on its own and the replay repairs the gap.
      }
    };
    const onStatus = (event: Event) => {
      const frame = event as MessageEvent<string>;
      try {
        const parsed = parseChatStatusFrame(JSON.parse(frame.data));
        setLastActivityAt(Date.now());
        if (!parsed) return;
        setStatus(parsed.status);
        // The run has ended and its session row — status, and the auto-title on
        // the first turn — is already written. This is the only signal the
        // client gets for that write, so it is what makes the title appear
        // without a reload. See {@link parseChatStatusFrame}.
        if (parsed.refetchSession) refreshFromStatusFrame();
      } catch {
        // Ignore invalid status frames.
      }
    };
    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    source.addEventListener("message", onMessage);
    source.addEventListener("chunk", onChunk);
    source.addEventListener("status", onStatus);
    // Every listener is detached before the socket is closed, so a session
    // switch cannot leave a previous stream writing into the new session.
    return () => {
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
      source.removeEventListener("message", onMessage);
      source.removeEventListener("chunk", onChunk);
      source.removeEventListener("status", onStatus);
      source.close();
    };
  }, [connectionAttempt, sessionId, refreshFromStatusFrame]);

  /** Flip to RUNNING optimistically after a send, before the first token lands. */
  const markRunning = useCallback(() => {
    setStatus("RUNNING");
    setLastActivityAt(Date.now());
    setConnectionError(false);
  }, []);

  /** Tear down and re-open the EventSource from the current replay cursor. */
  const reconnect = useCallback(() => {
    setConnectionError(false);
    setConnectionAttempt((attempt) => attempt + 1);
  }, []);

  // Derived, not stored: the transcript is a pure function of what the query
  // hydrated and what the stream has delivered since. See {@link mergeTranscript}.
  const messages = useMemo(
    () => mergeTranscript(hydrated, liveMessages.values()),
    [liveMessages, hydrated],
  );

  return {
    messages,
    status,
    markRunning,
    connectionError,
    reconnect,
    // The persisted status is the fallback: a browser that connects long after
    // a run wedged never receives a live event to judge staleness from.
    isStale: (status ?? persistedStatus) === "RUNNING" && clock - lastActivityAt > STALE_AFTER_MS,
  };
}
