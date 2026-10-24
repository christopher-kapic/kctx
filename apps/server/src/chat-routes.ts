import { chatMessageSelect } from "@starter/api/lib/chat";
import type { Session } from "@starter/auth";
import prisma from "@starter/db";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { type ChatLiveEvent, subscribeToChat } from "./chat-subscriber.js";

type Variables = { requestId: string; session: Session | null };

/**
 * The pre-sequence sentinel: "this client has seen nothing". It MUST sit below
 * every real `seq`, and a session's first message is `seq` 0 (`send` allocates
 * from `ChatSession.nextSeq`, which starts at 0 and only ever increments — it
 * is never lowered to fit deleted rows), so it cannot itself be 0 — the replay is
 * `seq > cursor`, and a 0 cursor would silently skip that first message. It is
 * also unparseable as a supplied cursor (`-1` fails the `>= 0` check below and
 * falls back here), so the two meanings can never be confused on the wire.
 */
const NO_CURSOR = -1;
const REPLAY_PAGE_SIZE = 500;

/**
 * `Last-Event-ID` is attacker-controllable (any client can send any header), so
 * anything that is not a safe non-negative integer replays the whole session
 * rather than being rejected. A wrong cursor must never 500 a reconnect.
 * Absent and invalid both mean {@link NO_CURSOR} — replay from the beginning,
 * first message included.
 */
function parseCursor(value: string | undefined) {
  if (!value) return NO_CURSOR;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : NO_CURSOR;
}

/**
 * May this frame carry an SSE `id:`?
 *
 * An `id:` is a promise of FINALITY, not merely of durability. A `message`
 * frame for a row the worker is still rewriting (`state: "STREAMING"`) names a
 * row that is committed but will change, so stamping it would let a client
 * resume from `seq > N` and never receive the finished version of row N. Only
 * `message` frames are candidates at all — `chunk` frames run ahead of their
 * row entirely and `status` frames are session state, not sequence points.
 *
 * Anything unrecognised is not final, which is the safe direction: a cursor
 * that lags costs a duplicate replay, a cursor that runs ahead costs a message.
 */
function isFinalMessageFrame(event: { type: string; state?: string }): boolean {
  return event.type === "message" && event.state === "COMPLETE";
}

/**
 * The `status` frame a session's persisted status implies, or `undefined` while
 * a run is still in flight.
 *
 * The worker's two TERMINAL states are the only ones a client acts on, and they
 * are what re-enables the composer. `RUNNING` is not a frame: it is the absence
 * of one, and the client already knows it from the session row it fetched.
 * Anything unrecognised is treated the same way — never invent a terminal frame
 * for a state this reader does not understand, because a spurious "idle" tells a
 * browser to stop waiting for an answer that is still coming.
 *
 * Exported for its own test.
 */
export function terminalStatusFrame(status: string): "idle" | "error" | undefined {
  if (status === "IDLE") return "idle";
  if (status === "ERROR") return "error";
  return undefined;
}

/** The JSON payload of a `message` frame: the row shape, replay and live alike. */
function messageFramePayload(event: ChatLiveEvent): string {
  // A live frame's `data` is the agent's message object, which carries no `seq`
  // of its own — and the client can no longer fall back to `lastEventId` for it,
  // because a partial frame deliberately has no `id:`. So the seq (and the
  // state) ride in the payload, exactly as a chunk's seq does.
  const data = typeof event.data === "object" && event.data !== null ? event.data : {};
  return JSON.stringify({ ...data, seq: event.seq, state: event.state ?? "STREAMING" });
}

/**
 * Mounts:
 *   GET /api/chat/:sessionId/stream — resumable SSE stream of one chat session
 *
 * THE RESUMABILITY CONTRACT. A browser refresh, a laptop sleeping, a proxy
 * killing an idle connection — none of them may lose a message. That works
 * because Postgres, not Redis, is the source of truth:
 *
 *   1. The client reconnects with `Last-Event-ID` (EventSource sends it
 *      automatically from the last `id:` it saw; `?lastEventId=` is the manual
 *      escape hatch for fetch-based clients that cannot set headers). A client
 *      that has seen nothing sends NEITHER — it must not claim `0`, which is a
 *      real `seq` (the session's first message).
 *   2. The stream REPLAYS every persisted message with `seq > cursor` first,
 *      tracking a high-water mark as it goes — the highest `seq` whose FINAL
 *      form the reader now holds. A fresh subscriber's cursor is the
 *      pre-sequence sentinel, so `seq > -1` includes message 0.
 *   3. Live pub/sub events that arrive DURING the replay are buffered, not
 *      written — writing them immediately would interleave them ahead of older
 *      replayed messages and corrupt the client's ordering.
 *   4. When the replay finishes, buffered events with `seq > highWaterMark` are
 *      flushed (the rest are duplicates the replay already delivered) and the
 *      stream switches to live.
 *   5. The session's CURRENT terminal status is then re-read and emitted as a
 *      `status` frame. Terminal state has to be recoverable from the replay for
 *      the same reason messages do: the live `status` frame is Redis-only, so a
 *      run that finished between the ownership check and the subscription would
 *      otherwise leave the client on RUNNING — composer disabled — until a
 *      manual reload. Reading it AFTER the replay is what makes that race-free.
 *
 * Two smaller invariants worth keeping:
 *   * EVERY write goes through `writeChain`, a serialized promise chain —
 *     replayed rows, live frames, the terminal `status` frame, and the
 *     heartbeat alike. Concurrent `writeSSE` calls on one stream can interleave
 *     partial frames, and "every" is literal: a replay that awaited the socket
 *     directly would be unserialized against the 15-second heartbeat for as
 *     long as it ran, which is exactly the window where a long transcript needs
 *     the guarantee most.
 *   * ONLY a FINAL `message` frame carries an `id:` — the resume cursor may
 *     only ever advance to a `seq` whose row is committed AND will not change
 *     again (`ChatMessage.state === "COMPLETE"`). `chunk` frames are emitted at
 *     the first token, ahead of the row being upserted; a `message` frame for a
 *     row the worker is still growing names a row that is durable but not final;
 *     and `status` frames are session state (idle / error) rather than sequence
 *     points. Stamping an `id:` on any of them would let a disconnect move the
 *     client's `Last-Event-ID` past content the replay (`seq > cursor`) then
 *     skips forever. Their `seq` therefore rides in the JSON payload, where it
 *     is a correlation key for placing the content, not a resume cursor.
 *
 * And the corollary of "Postgres is authoritative": if the SUBSCRIPTION itself
 * fails — Redis unreachable — the replay still runs and the reader still gets
 * its full durable history. The connection then ends rather than idling behind a
 * heartbeat with nothing behind it, so the client's own reconnect retries the
 * subscription and replays from its cursor. Degraded liveness, never lost data.
 */
export function mountChatRoutes(app: Hono<{ Variables: Variables }>) {
  app.get("/api/chat/:sessionId/stream", async (c) => {
    const sessionId = c.req.param("sessionId");
    const authSession = c.get("session");
    // 404, not 401/403, for anonymous *and* foreign sessions: a chat id must not
    // be probeable for existence by anyone but its owner.
    if (!authSession?.user) return c.json({ error: "Not found" }, 404);
    const chatSession = await prisma.chatSession.findFirst({
      where: { id: sessionId, ownerId: authSession.user.id },
      select: { id: true },
    });
    if (!chatSession) return c.json({ error: "Not found" }, 404);

    const cursor = parseCursor(c.req.header("Last-Event-ID") ?? c.req.query("lastEventId"));
    // Tells nginx-style proxies not to buffer the response; without it a
    // reverse proxy can hold tokens back until the whole run finishes.
    c.header("X-Accel-Buffering", "no");

    const response = streamSSE(c, async (stream) => {
      let replaying = true;
      /** Highest `seq` whose FINAL form this reader now holds. */
      let highWaterMark = cursor;
      const buffered: ChatLiveEvent[] = [];
      let writeChain = Promise.resolve();
      // THE one serialized chain. Concurrent `writeSSE` calls on a single stream
      // can interleave partial frames, so nothing on this connection may write
      // to the socket except through here — the replay loop included, not just
      // the live path and the heartbeat. The `.catch` is load-bearing: once the client
      // is gone a write rejects, and without it that rejection both poisons every
      // later link in the chain (including the heartbeat, which keeps chaining
      // onto it) and surfaces as an unhandled rejection. `onAbort` is what
      // actually tears the stream down; a write that lost the race is noise.
      const enqueueWrite = (write: () => Promise<void>) => {
        writeChain = writeChain.then(write).catch(() => {});
      };
      const writeLive = (event: ChatLiveEvent) => {
        enqueueWrite(async () => {
          await stream.writeSSE({
            event: event.type,
            // ONLY a FINAL `message` frame carries an `id:` — see
            // {@link isFinalMessageFrame}. A `chunk` is emitted at the first
            // token, before `onMessagesChange` has upserted the row; a partial
            // `message` names a row the worker will rewrite; `status` frames are
            // session state, not sequence points. Stamping any of them would let
            // a disconnect move the client's `Last-Event-ID` past content the
            // replay (`seq > cursor`) then skips forever.
            ...(isFinalMessageFrame(event) ? { id: String(event.seq) } : {}),
            // Chunks still need their seq so the client can coalesce tokens into
            // the right message, but it rides in the payload where it is a
            // correlation key rather than a resume cursor. Partial messages ride
            // the same way, for the same reason.
            data:
              event.type === "chunk"
                ? JSON.stringify({ seq: event.seq, data: event.data })
                : event.type === "message"
                  ? messageFramePayload(event)
                  : JSON.stringify(event.data),
          });
        });
      };
      // Subscribe BEFORE the replay query: an event published between the query
      // and the subscription would otherwise fall in the gap between "too new to
      // be replayed" and "too early to be live", and be lost outright. That
      // ordering is not negotiable — but neither is what happens when it fails.
      //
      // REDIS IS BEST-EFFORT TRANSPORT; POSTGRES IS AUTHORITATIVE. Awaiting the
      // subscription ahead of the replay used to mean an unreachable Redis threw
      // (or hung) before the query ran, so a Redis outage cost the user their
      // ALREADY-PERSISTED history — the exact inversion of the invariant this
      // whole feature is built on. A failed subscription therefore degrades to
      // replay-only: no live tail, a no-op unsubscribe, and the stream ends once
      // the replay is delivered so the client's own reconnect (which replays
      // from its cursor) is what retries the subscription. Degraded, not dead.
      let unsubscribe: () => void = () => {};
      let live = true;
      try {
        unsubscribe = await subscribeToChat(sessionId, (event) => {
          if (replaying) buffered.push(event);
          else writeLive(event);
        });
      } catch (error) {
        live = false;
        console.error(
          "[chat] live subscription unavailable; serving durable replay only",
          error instanceof Error ? error.message : error,
        );
      }
      // Keeps intermediaries (and mobile radios) from dropping an idle stream
      // during a long tool call that produces no tokens. Only for a stream that
      // stays open — a replay-only response ends immediately, so an interval
      // here would be a timer with nothing left to write to.
      const heartbeat = live
        ? setInterval(() => {
            enqueueWrite(async () => {
              await stream.write(": heartbeat\n\n");
            });
          }, 15_000)
        : undefined;
      // The replay loop reads it every iteration: a client that goes away
      // mid-replay must stop the paging, not keep issuing bounded `findMany`
      // pages into a socket nobody is reading. `cleanup` runs on abort AND in
      // the `finally` below, so this is set on every exit path.
      let aborted = false;
      const cleanup = () => {
        aborted = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
      };
      stream.onAbort(cleanup);

      try {
        // A reconnect can be far behind a long-lived session. Keep each Prisma
        // read bounded, but exhaust every page on this same SSE response: closing
        // after one page would make the live tail race the client's reconnect.
        let replayCursor = cursor;
        for (;;) {
          // Checked before the query, so a disconnect that lands while the
          // previous page was draining costs zero further database reads.
          if (aborted) break;
          const messages = await prisma.chatMessage.findMany({
            where: { sessionId, seq: { gt: replayCursor } },
            orderBy: { seq: "asc" },
            take: REPLAY_PAGE_SIZE,
            // One disclosure boundary: the shared select plus the sessionId the
            // SSE frame needs. Do not re-list the fields here.
            select: { ...chatMessageSelect, sessionId: true },
          });
          for (const message of messages) {
            // THE SAME RULE ON THE REPLAY PATH, and it has to be read off the ROW:
            // this process is not the one that streamed it. A row still marked
            // STREAMING — a run in progress, or a partial a crashed worker left
            // behind — is delivered so the reader can render it, but it carries no
            // `id:` and does NOT advance the high-water mark, because the reader
            // does not yet hold its final form. Skip either half and the bug is
            // simply reintroduced on reconnect.
            const final = String(message.state) === "COMPLETE";
            // The mark is raised HERE, synchronously as the loop walks the rows,
            // not inside the queued write — so it is fully up to date by the time
            // the buffered flush below consults it, exactly as when this loop
            // awaited each write itself.
            if (final) highWaterMark = Math.max(highWaterMark, message.seq);
            // ON THE CHAIN, like every other write on this stream. Awaiting
            // `writeSSE` directly here left the replay unserialized with respect
            // to the heartbeat: a replay that outlives the 15-second interval — a
            // long transcript, a slow database, a client draining slowly — had the
            // heartbeat writing onto the chain while the loop was mid-write, which
            // is precisely the interleaving the chain exists to prevent. The chain
            // is FIFO, so queueing instead of awaiting preserves this loop's order
            // AND keeps everything queued after it (the buffered flush, then the
            // terminal `status` frame) strictly behind every replayed row.
            enqueueWrite(async () => {
              await stream.writeSSE({
                event: "message",
                ...(final ? { id: String(message.seq) } : {}),
                data: JSON.stringify({
                  ...message,
                  role: String(message.role),
                  state: String(message.state),
                }),
              });
            });
          }
          if (messages.length < REPLAY_PAGE_SIZE) break;
          const lastSeq = messages.at(-1)?.seq;
          if (lastSeq === undefined) break;
          // Bound both the database result and the queued socket writes. Without
          // this barrier a very old transcript could enqueue every page before
          // the client has drained the first one.
          await writeChain;
          replayCursor = lastSeq;
        }
        replaying = false;
        // Anything at or below the mark was already delivered in its final form
        // by the replay. A row the replay delivered mid-stream did NOT raise the
        // mark, so its buffered continuations — the rest of its tokens, and the
        // completed message that ends it — are flushed rather than discarded as
        // duplicates. That is the difference between a live client watching an
        // in-flight answer finish and one frozen on a partial until it reconnects.
        for (const event of buffered) {
          if (event.seq > highWaterMark) writeLive(event);
        }

        // TERMINAL STATE IS PART OF THE REPLAY, NOT ONLY OF THE LIVE FEED.
        //
        // A `status` frame is Redis-only and best-effort like every other live
        // frame — but unlike a message it has no durable counterpart in the
        // replay, so losing one used to be unrecoverable: the client refreshes
        // session state on a `status` frame and nothing else, so a run that
        // finished in the window before this reader's subscription existed left
        // the UI on RUNNING with the composer disabled until a manual reload.
        // Re-reading the session row here closes that window for good.
        //
        // WHY THIS READ IS RACE-FREE, and why it happens HERE rather than next
        // to the ownership check at the top. The worker writes the session's
        // terminal status BEFORE it publishes the matching frame, and this
        // reader subscribed BEFORE the replay query ran. So for any terminal
        // transition, exactly one of two things is true:
        //   * it published before this reader subscribed — then the write that
        //     preceded that publish is already committed, and this read (which
        //     happens strictly after the subscription AND after the replay
        //     query) is guaranteed to see it; or
        //   * it published at or after the subscription — then the frame itself
        //     is in `buffered` (flushed just above: the worker allocates a
        //     status frame's `seq` above every row it emitted, so it clears the
        //     high-water mark) or arrives live.
        // There is no third ordering, so no window remains. Reading BEFORE the
        // replay would leave one: the status would then describe a moment older
        // than the message snapshot the client is being handed, which is the
        // same bug moved one step earlier.
        const current = await prisma.chatSession.findUnique({
          where: { id: sessionId },
          select: { status: true },
        });
        const terminal = current ? terminalStatusFrame(String(current.status)) : undefined;
        if (terminal) {
          enqueueWrite(async () => {
            // NO `id:` — a status frame is session state, not a point in the
            // sequence. Stamping one would advance `Last-Event-ID` past real
            // messages and the next reconnect (`seq > cursor`) would skip them.
            // It also goes out LAST, after every replayed row and every buffered
            // frame — which is a consequence of the chain being FIFO and of the
            // replay queueing onto it rather than writing around it: this link
            // is appended after all of them, so a client never re-enables its
            // composer while its transcript is still missing the answer it was
            // waiting for.
            await stream.writeSSE({ event: "status", data: JSON.stringify(terminal) });
          });
        }
        // The mode switch's barrier, and now also the replay's: it drains every
        // queued replayed row, the flushed buffer and the terminal frame before
        // this reader either closes (degraded) or starts writing live frames.
        await writeChain;
        // No live transport: the durable history has been delivered in full and
        // nothing more can arrive on this connection, so let it close instead of
        // holding a socket open behind a heartbeat that would only make a dead
        // stream look healthy. `EventSource` reconnects on its own, resending the
        // last `id:` it received, and that reconnect both replays whatever landed
        // in the meantime and retries the subscription — so the feature heals as
        // soon as Redis does.
        if (!live) return;
        // Hold the stream open until the client goes away. `streamSSE` closes
        // the response the moment this callback resolves.
        await new Promise<void>((resolve) => stream.onAbort(resolve));
      } finally {
        cleanup();
      }
    });
    // Hono defaults SSE to `no-cache`, which still permits storage. A replay
    // response is a full private transcript and must never be written to disk
    // by a browser or an intermediary.
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
}
