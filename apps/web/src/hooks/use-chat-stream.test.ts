import { describe, expect, it } from "vitest";

import {
  type ChatMessage,
  chatStreamQuery,
  hydratedCursor,
  mergeTranscript,
  messageFrameCursor,
  parseChatStatusFrame,
} from "./use-chat-stream";

// The client half of the resumability contract. `seq` starts at 0 and the
// server replays `seq > cursor`, so "I have seen nothing" must NOT be sent as
// `lastEventId=0` — that claims the first message was already delivered and it
// is then skipped forever. The wire form of "no cursor" is no parameter at all.
describe("chatStreamQuery", () => {
  it("omits the parameter entirely before any durable seq has been seen", () => {
    expect(chatStreamQuery(-1)).toBe("");
  });

  it("sends 0 only when message 0 has genuinely been received", () => {
    expect(chatStreamQuery(0)).toBe("?lastEventId=0");
    expect(chatStreamQuery(7)).toBe("?lastEventId=7");
  });
});

/** A persisted (final) row, as `listMessages` and the replay both deliver it. */
const entry = (seq: number, content: string, id = `m-${seq}`): ChatMessage => ({
  id,
  seq,
  role: "ASSISTANT",
  state: "COMPLETE",
  parts: [{ type: "text", content }],
});

/** A row the worker is still rewriting under this same seq. */
const partial = (seq: number, content: string, id = `m-${seq}`): ChatMessage => ({
  ...entry(seq, content, id),
  state: "STREAMING",
});

// THE CURSOR RULE, client half. An SSE `id:` — and therefore the client's
// replay cursor — promises that a row is FINAL, not merely that it is durable.
// A streaming assistant turn is upserted repeatedly under one seq, so resuming
// from it asks the server for `seq > N` and never delivers the finished row N:
// the transcript is stuck on a partial answer forever.
describe("hydratedCursor", () => {
  it("resumes from the highest COMPLETE row", () => {
    expect(hydratedCursor([entry(0, "q"), entry(1, "a")])).toBe(1);
  });

  it("never resumes from a row that is still being written", () => {
    expect(hydratedCursor([entry(0, "q"), entry(1, "user"), partial(2, "12 ro")])).toBe(1);
  });

  it("is the pre-sequence sentinel when nothing is final yet", () => {
    expect(hydratedCursor([])).toBe(-1);
    expect(hydratedCursor([partial(0, "12 ro")])).toBe(-1);
  });
});

describe("messageFrameCursor", () => {
  // The server omits the `id:` on a partial frame, so `lastEventId` still holds
  // the last FINAL id — which is exactly what a reconnect must resume from.
  // Reading the payload's own `seq` instead is the bug: the first partial of an
  // answer would advance the cursor past a row that has not been written yet.
  it("stands still while a partial frame streams, and advances on the final one", () => {
    // A partial for seq 4 carries no `id:`, so `lastEventId` still reads "3".
    // Taking the payload's seq here is the bug: the cursor would jump to 4 and
    // the reconnect (`seq > 4`) would never deliver the finished row 4.
    expect(messageFrameCursor(3, { lastEventId: "3", seq: 4 })).toBe(3);
    // The completed row IS stamped, and only then does the cursor move.
    expect(messageFrameCursor(3, { lastEventId: "4", seq: 4 })).toBe(4);
  });

  it("never regresses, and ignores a frame with no usable id", () => {
    expect(messageFrameCursor(5, { lastEventId: "2", seq: 2 })).toBe(5);
    expect(messageFrameCursor(5, { lastEventId: "", seq: 6 })).toBe(5);
    expect(messageFrameCursor(-1, { lastEventId: "not-a-number", seq: 3 })).toBe(-1);
  });

  it("accepts 0, which is a real seq and not 'no cursor'", () => {
    expect(messageFrameCursor(-1, { lastEventId: "0", seq: 0 })).toBe(0);
  });
});

describe("mergeTranscript", () => {
  it("keeps the streamed tail above the hydrated range", () => {
    const merged = mergeTranscript(
      [entry(0, "question"), entry(1, "answer")],
      [entry(1, "ans"), entry(2, "streaming…")],
    );
    expect(merged.map((item) => item.seq)).toEqual([0, 1, 2]);
    // The persisted row wins inside the hydrated range; the tail still renders.
    expect(merged[1]?.parts[0]?.content).toBe("answer");
    expect(merged[2]?.parts[0]?.content).toBe("streaming…");
  });

  // A failed attempt streamed a partial answer at seq 2; the retry DELETED that
  // row and answered at seq 3 (cursors are never recycled). The persisted
  // transcript is the truth for everything it covers, so the orphaned partial
  // must vanish — a row-by-row overlay would leave it on screen forever, since
  // nothing ever arrives at seq 2 again to replace it.
  it("drops a live entry whose row the server deleted", () => {
    const merged = mergeTranscript(
      [entry(0, "question"), entry(1, "user"), entry(3, "complete answer")],
      [entry(2, "partial ans"), entry(3, "complete answer")],
    );
    expect(merged.map((item) => item.seq)).toEqual([0, 1, 3]);
  });

  // And the converse, which is exactly why a terminal `status` frame has to
  // invalidate `listMessages` and not just the session queries. THE STREAM CAN
  // ADD AND REPLACE ROWS BUT NEVER RETRACT ONE, so a deleted row reaches this
  // client only through a refetch. Hand this function a hydrated transcript
  // fetched BEFORE the retry deleted the partial — which is what `chat.retry`'s
  // own invalidation produces, since it fires before the worker has claimed the
  // turn — and it is powerless: the orphan sits inside the hydrated range, no
  // live frame ever supersedes it, and it renders directly above its own
  // replacement. Nothing here is wrong; the input is. See `refreshFromStatusFrame`.
  it("cannot drop a deleted row while the hydrated transcript is stale", () => {
    const merged = mergeTranscript(
      [entry(0, "question"), entry(1, "user"), partial(2, "partial ans")],
      [entry(3, "complete answer")],
    );
    expect(merged.map((item) => item.seq)).toEqual([0, 1, 2, 3]);
  });

  // Opening a session while a run is in flight hydrates the half-written answer
  // as a STREAMING row. Cutting the live tail at the highest hydrated seq would
  // suppress the very frames that finish it and freeze the transcript on
  // whatever the query happened to catch — so the cut is the highest FINAL row.
  it("lets live frames finish a hydrated row that is still streaming", () => {
    const merged = mergeTranscript(
      [entry(0, "question"), partial(1, "12 ro")],
      [partial(1, "12 rows")],
    );
    expect(merged.map((item) => item.seq)).toEqual([0, 1]);
    expect(merged[1]?.parts[0]?.content).toBe("12 rows");
  });

  it("keeps a hydrated streaming row that nothing live has superseded yet", () => {
    const merged = mergeTranscript([entry(0, "question"), partial(1, "12 ro")], []);
    expect(merged.map((item) => item.seq)).toEqual([0, 1]);
    expect(merged[1]?.parts[0]?.content).toBe("12 ro");
  });

  it("renders the whole live stream while the query is still empty", () => {
    const merged = mergeTranscript([], [entry(0, "typing…")]);
    expect(merged.map((item) => item.seq)).toEqual([0]);
  });
});

// A run's terminal `status` frame is published AFTER the worker has written the
// session row — including the title it derives from the first user message. The
// send mutation's invalidation resolved long before that, so if a terminal frame
// does not refetch the session queries the rail and the header keep rendering
// the "untitled" fallback until a reload.
describe("parseChatStatusFrame", () => {
  it("refetches the session on every terminal frame", () => {
    expect(parseChatStatusFrame("idle")).toEqual({ status: "IDLE", refetchSession: true });
    expect(parseChatStatusFrame("error")).toEqual({ status: "ERROR", refetchSession: true });
  });

  // The OPENING frame, published by `send`/`retry` when a claim is accepted, and
  // it exists for the clients that did not submit it. Only the submitting tab
  // flips its own state; without this every other tab keeps an IDLE status and
  // an enabled composer for the whole answer, and its next send fails with the
  // server's conflict. It refetches too, because the user message that started
  // the run is a persisted row no frame ever carries — a watching tab would
  // otherwise render "Thinking…" above a question it cannot see.
  it("recognises the opening running frame and refetches for it", () => {
    expect(parseChatStatusFrame("running")).toEqual({ status: "RUNNING", refetchSession: true });
  });

  // The refetch must be reachable only from a frame this client understands:
  // an unrecognised frame that still refetched would turn any stray publish into
  // a refetch loop.
  it("ignores a frame it does not recognise", () => {
    expect(parseChatStatusFrame("thinking")).toBeUndefined();
    expect(parseChatStatusFrame({ status: "idle" })).toBeUndefined();
    expect(parseChatStatusFrame(undefined)).toBeUndefined();
  });
});
