import { EventEmitter } from "node:events";
import type { Session } from "@starter/auth";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

/**
 * Mocked at module load even though most tests here stub `./chat-subscriber.js`
 * outright: one test drives the REAL subscriber (see "hangs" below), and
 * importing `@starter/queue` for real opens IORedis sockets at module load —
 * green locally, `Test timed out` in CI.
 *
 * `psubscribe` never settles, which is what ioredis actually does when Redis is
 * unreachable: `createRedisConnection()` uses `maxRetriesPerRequest: null` and
 * no `commandTimeout`, so the command sits in the offline queue forever rather
 * than rejecting.
 */
class HangingRedis extends EventEmitter {
  psubscribe = vi.fn(() => new Promise<number>(() => {}));
  disconnect = vi.fn();
}
vi.mock("@starter/queue", () => ({ createRedisConnection: () => new HangingRedis() }));

vi.mock("@starter/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

let liveListener:
  | ((event: {
      type: "chunk" | "message" | "status";
      seq: number;
      state?: "STREAMING" | "COMPLETE";
      data: unknown;
    }) => void)
  | undefined;
const unsubscribe = vi.fn();
vi.mock("./chat-subscriber.js", () => ({
  subscribeToChat: vi.fn(async (_sessionId: string, listener: typeof liveListener) => {
    liveListener = listener;
    return unsubscribe;
  }),
}));

const { default: db } = await import("@starter/db");
const { subscribeToChat } = await import("./chat-subscriber.js");
const { mountChatRoutes, terminalStatusFrame } = await import("./chat-routes.js");
/** The unmocked subscriber, for the one test that must exercise its real bound. */
const realSubscriber =
  await vi.importActual<typeof import("./chat-subscriber.js")>("./chat-subscriber.js");
const dbMock = db as unknown as {
  chatSession: { findFirst: MockInstance; findUnique: MockInstance };
  chatMessage: { findMany: MockInstance };
};

function replayQuery(cursor: number) {
  return {
    where: { sessionId: "chat-1", seq: { gt: cursor } },
    orderBy: { seq: "asc" },
    take: 500,
    select: {
      id: true,
      sessionId: true,
      seq: true,
      role: true,
      state: true,
      parts: true,
    },
  };
}

function createApp(userId: string | null) {
  const app = new Hono<{ Variables: { requestId: string; session: Session | null } }>();
  app.use("/api/chat/*", async (c, next) => {
    c.set("requestId", "test-request");
    c.set("session", userId ? ({ user: { id: userId } } as Session) : null);
    await next();
  });
  mountChatRoutes(app);
  return app;
}

/** Read the SSE body until `pattern` shows up, then abort so the stream ends. */
async function readUntil(response: Response, pattern: string, controller: AbortController) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing response body");
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes(pattern)) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
  }
  await reader.cancel();
  controller.abort();
  return output;
}

describe("terminalStatusFrame", () => {
  it("maps only the worker's two terminal states", () => {
    expect(terminalStatusFrame("IDLE")).toBe("idle");
    expect(terminalStatusFrame("ERROR")).toBe("error");
  });

  // A run still in flight must produce NO frame. Inventing one — here, or for a
  // status a future enum member adds — tells a browser to stop waiting for an
  // answer that is still on its way and re-enables the composer mid-run.
  it("emits nothing for a run in flight or an unrecognised state", () => {
    expect(terminalStatusFrame("RUNNING")).toBeUndefined();
    expect(terminalStatusFrame("QUEUED")).toBeUndefined();
    expect(terminalStatusFrame("")).toBeUndefined();
  });
});

describe("mountChatRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveListener = undefined;
    // Default: a run is in flight, so the replay adds no terminal frame. Tests
    // that care about the terminal path override this.
    dbMock.chatSession.findUnique.mockResolvedValue({ status: "RUNNING" });
  });

  it("returns an existence-hiding 404 for anonymous and foreign sessions", async () => {
    expect((await createApp(null).request("/api/chat/chat-1/stream")).status).toBe(404);
    dbMock.chatSession.findFirst.mockResolvedValue(null);
    expect((await createApp("other-user").request("/api/chat/chat-1/stream")).status).toBe(404);
    expect(dbMock.chatSession.findFirst).toHaveBeenCalledWith({
      where: { id: "chat-1", ownerId: "other-user" },
      select: { id: true },
    });
  });

  it("replays past the cursor and drops a live event that raced the replay boundary", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    // Fire live events DURING the replay query — the exact race the buffer and
    // high-water mark exist for. seq 2 duplicates a replayed row; seq 3 is new.
    dbMock.chatMessage.findMany.mockImplementation(async () => {
      liveListener?.({ type: "chunk", seq: 2, data: "duplicate" });
      liveListener?.({ type: "chunk", seq: 3, data: "live" });
      return [
        {
          id: "message-2",
          seq: 2,
          role: "ASSISTANT",
          state: "COMPLETE",
          parts: [{ type: "text", content: "replayed" }],
        },
      ];
    });

    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat/chat-1/stream?lastEventId=1", {
      signal: controller.signal,
    });
    const response = await createApp("owner").request(request);

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const body = await readUntil(response, '"data":"live"', controller);
    expect(body).toContain("event: message");
    expect(body).toContain("id: 2");
    expect(body).toContain("event: chunk");
    // The chunk's seq rides in the payload as a correlation key, never as an
    // SSE `id:` — see the dedicated regression test below.
    expect(body).toContain('{"seq":3,');
    expect(body).not.toContain("duplicate");
    expect(dbMock.chatMessage.findMany).toHaveBeenCalledWith(replayQuery(1));
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalled());
  });

  // Regression guard. The subscription is awaited BEFORE the replay query (which
  // is correct — it closes the gap where an event published between the query and
  // the subscription is lost), so an unreachable Redis used to reject before the
  // query ever ran and the reader got NOTHING: not even the history already
  // committed to Postgres. That inverts the invariant the whole feature rests on —
  // Postgres is authoritative, Redis is best-effort transport — so a failed
  // subscription must degrade to replay-only, not to no data at all.
  it("serves the durable replay when the live subscription is unavailable", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    dbMock.chatMessage.findMany.mockResolvedValue([
      {
        id: "message-0",
        seq: 0,
        role: "USER",
        state: "COMPLETE",
        parts: [{ type: "text", content: "persisted" }],
      },
    ]);
    vi.mocked(subscribeToChat).mockRejectedValueOnce(new Error("redis is down"));

    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat/chat-1/stream", {
      signal: controller.signal,
    });
    const response = await createApp("owner").request(request);
    expect(response.status).toBe(200);

    // The whole body, read to completion: with no live transport the stream
    // ENDS after the replay rather than holding a socket open behind a heartbeat
    // that would make a dead stream look healthy. The client's own reconnect
    // replays from its cursor and retries the subscription, so the feature heals
    // when Redis does.
    const body = await response.text();
    expect(body).toContain("persisted");
    expect(body).toContain("id: 0");
    expect(dbMock.chatMessage.findMany).toHaveBeenCalledWith(replayQuery(-1));
    // Nothing to unsubscribe and no heartbeat left behind.
    expect(unsubscribe).not.toHaveBeenCalled();
    controller.abort();
  });

  it("exhausts every bounded durable-replay page before ending a degraded stream", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    dbMock.chatMessage.findMany
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, seq) => ({
          id: `message-${seq}`,
          seq,
          role: "USER",
          state: "COMPLETE",
          parts: [{ type: "text", content: `message ${seq}` }],
        })),
      )
      .mockResolvedValueOnce([]);
    vi.mocked(subscribeToChat).mockRejectedValueOnce(new Error("redis is down"));

    const response = await createApp("owner").request(
      new Request("http://localhost/api/chat/chat-1/stream"),
    );
    const body = await response.text();

    expect(body).toContain("message 499");
    expect(dbMock.chatMessage.findMany).toHaveBeenNthCalledWith(1, replayQuery(-1));
    expect(dbMock.chatMessage.findMany).toHaveBeenNthCalledWith(2, replayQuery(499));
  });

  // A client that walks away mid-replay must stop the paging. `stream.write`
  // swallows the error a cancelled socket raises, so nothing about a dead
  // connection surfaces inside this loop on its own: without the abort flag it
  // kept issuing bounded `findMany` pages until the transcript ran out.
  it("stops paging the durable replay once the client disconnects", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    let page = 0;
    dbMock.chatMessage.findMany.mockImplementation(async () => {
      // Bounded at 20 full pages so a regression fails the assertion below
      // instead of spinning this suite forever.
      if (page >= 20) return [];
      const base = page * 500;
      page += 1;
      return Array.from({ length: 500 }, (_, index) => ({
        id: `message-${base + index}`,
        sessionId: "chat-1",
        seq: base + index,
        role: "USER",
        state: "COMPLETE",
        parts: [{ type: "text", content: `message ${base + index}` }],
      }));
    });

    const controller = new AbortController();
    const response = await createApp("owner").request(
      new Request("http://localhost/api/chat/chat-1/stream"),
    );
    // Reads the head of the first page, then cancels — which is what fires the
    // route's `onAbort`.
    await readUntil(response, "message 0", controller);
    await new Promise((resolve) => setTimeout(resolve, 25));

    // One page in flight when the client left, and at most the one already
    // awaiting its write barrier — never the remaining nineteen.
    expect(dbMock.chatMessage.findMany.mock.calls.length).toBeLessThanOrEqual(2);
  });

  // The same regression one layer down, and the one the degradation above was
  // silently NOT covering: a hung dependency is not a failed dependency. The
  // stub in the previous test rejects, but the real ioredis configuration
  // (`maxRetriesPerRequest: null`, no `commandTimeout`) leaves `psubscribe`
  // PENDING when Redis is unreachable — so the route never reached its `catch`,
  // the request hung, and durable history was unreachable during an outage.
  // This test therefore runs the REAL subscriber over a redis whose `psubscribe`
  // never settles; it only passes because that subscription is time-bounded.
  it("serves the durable replay when the live subscription hangs rather than failing", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    dbMock.chatMessage.findMany.mockResolvedValue([
      {
        id: "message-0",
        seq: 0,
        role: "USER",
        state: "COMPLETE",
        parts: [{ type: "text", content: "persisted" }],
      },
    ]);
    dbMock.chatSession.findUnique.mockResolvedValue({ status: "IDLE" });
    vi.mocked(subscribeToChat).mockImplementationOnce(realSubscriber.subscribeToChat);

    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = createApp("owner").request(
      new Request("http://localhost/api/chat/chat-1/stream", { signal: controller.signal }),
    );
    // No real waiting: advance past the subscriber's bound and the attempt is
    // abandoned in favour of the replay.
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    const body = await response.text();
    vi.useRealTimers();

    expect(response.status).toBe(200);
    expect(body).toContain("persisted");
    expect(body).toContain("id: 0");
    // Terminal state still rides the replay in the degraded mode — it is the
    // only thing that can carry it when there is no live feed.
    expect(body).toContain('event: status\ndata: "idle"');
    controller.abort();
    await realSubscriber.closeChatSubscriber();
  });

  it("treats a hostile Last-Event-ID as a full replay instead of failing", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    dbMock.chatMessage.findMany.mockResolvedValue([
      {
        id: "message-0",
        seq: 0,
        role: "USER",
        state: "COMPLETE",
        parts: [{ type: "text", content: "hi" }],
      },
    ]);

    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat/chat-1/stream", {
      headers: { "Last-Event-ID": "' OR 1=1; --" },
      signal: controller.signal,
    });
    const response = await createApp("owner").request(request);
    expect(response.status).toBe(200);
    await readUntil(response, "id: 0", controller);
    // `gt: -1`, not `gt: 0` — a full replay has to include `seq` 0, the first
    // message of the session.
    expect(dbMock.chatMessage.findMany).toHaveBeenCalledWith(replayQuery(-1));
  });

  // Regression guard. Sequences start at 0 (`send` allocates `(MAX(seq) ?? -1) + 1`)
  // and the replay is `seq > cursor`, so "no cursor supplied" cannot be encoded
  // as 0 — that is a real message id, and a fresh subscriber would silently
  // never receive the session's first message.
  it("replays the first message when no cursor is supplied", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    dbMock.chatMessage.findMany.mockResolvedValue([
      {
        id: "message-0",
        seq: 0,
        role: "USER",
        state: "COMPLETE",
        parts: [{ type: "text", content: "first" }],
      },
    ]);

    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat/chat-1/stream", {
      signal: controller.signal,
    });
    const response = await createApp("owner").request(request);
    const body = await readUntil(response, "first", controller);

    expect(dbMock.chatMessage.findMany).toHaveBeenCalledWith(replayQuery(-1));
    expect(body).toContain("event: message");
    expect(body).toContain("id: 0");
  });

  // The other half of the same bug: a client that reconnects with an explicit
  // cursor of 0 HAS seen message 0, so that one must not be replayed. `0` means
  // exactly one thing on the wire now.
  it("treats an explicit cursor of 0 as 'message 0 already seen'", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    dbMock.chatMessage.findMany.mockResolvedValue([]);

    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat/chat-1/stream?lastEventId=0", {
      signal: controller.signal,
    });
    const response = await createApp("owner").request(request);
    await vi.waitFor(() =>
      expect(dbMock.chatMessage.findMany).toHaveBeenCalledWith(replayQuery(0)),
    );
    await response.body?.cancel();
    controller.abort();
  });

  it("omits the SSE id on status events so a reconnect cannot skip a message", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    dbMock.chatMessage.findMany.mockResolvedValue([]);

    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat/chat-1/stream", {
      signal: controller.signal,
    });
    const response = await createApp("owner").request(request);
    // Emitted after the replay finished, so it takes the live path.
    await vi.waitFor(() => expect(liveListener).toBeDefined());
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body");
    const decoder = new TextDecoder();
    let body = "";
    liveListener?.({ type: "status", seq: 9, data: "idle" });
    while (!body.includes('data: "idle"')) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value);
    }
    await reader.cancel();
    controller.abort();

    expect(body).toContain("event: status");
    expect(body).not.toContain("id: 9");
  });

  // Regression guard, LIVE PATH. `onMessagesChange` upserts the SAME
  // `(sessionId, seq)` row on every growth step, so an early `message` frame is
  // durable but NOT final. Stamping an `id:` on it lets a client that drops
  // mid-answer reconnect with `Last-Event-ID: N` and replay `seq > N` — it would
  // never receive the finished row N and its transcript would stay truncated
  // forever. Only the frame published once the row is COMPLETE may carry an id.
  it("omits the SSE id on a partial message and stamps it only once the row is final", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    dbMock.chatMessage.findMany.mockResolvedValue([]);

    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat/chat-1/stream", {
      signal: controller.signal,
    });
    const response = await createApp("owner").request(request);
    await vi.waitFor(() => expect(liveListener).toBeDefined());
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body");
    const decoder = new TextDecoder();
    const readUntilBody = async (pattern: string) => {
      let output = "";
      while (!output.includes(pattern)) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value);
      }
      return output;
    };

    liveListener?.({
      type: "message",
      seq: 4,
      state: "STREAMING",
      data: { id: "assistant-1", role: "assistant", parts: [{ type: "text", content: "12 ro" }] },
    });
    const partial = await readUntilBody("12 ro");
    expect(partial).toContain("event: message");
    expect(partial).not.toContain("id: 4");
    // The seq still ships — in the payload, where it places the content rather
    // than advancing the cursor. Without it the client could not render the
    // partial at all, because there is no `id:` to read it from.
    expect(partial).toContain('"seq":4');
    expect(partial).toContain('"state":"STREAMING"');

    liveListener?.({
      type: "message",
      seq: 4,
      state: "COMPLETE",
      data: { id: "assistant-1", role: "assistant", parts: [{ type: "text", content: "12 rows" }] },
    });
    const complete = await readUntilBody("12 rows");
    expect(complete).toContain("id: 4");
    await reader.cancel();
    controller.abort();
  });

  // Regression guard, REPLAY PATH — the same bug, reintroduced on reconnect if
  // only the live path is fixed. The replaying process is the SERVER, not the
  // worker that streamed the row, so "is this final?" has to be read off the
  // row. A run still in progress (or a partial a crashed worker abandoned)
  // replays so the reader can render it, but must not become its resume point.
  it("replays a still-streaming row without an id, and keeps its live tail flowing", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    dbMock.chatMessage.findMany.mockImplementation(async () => {
      // Published while the replay query is in flight: the continuation of the
      // very row being replayed. It must survive the high-water-mark filter,
      // because the reader does NOT yet hold that row's final form.
      liveListener?.({
        type: "message",
        seq: 3,
        state: "COMPLETE",
        data: {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", content: "12 rows" }],
        },
      });
      return [
        {
          id: "message-2",
          seq: 2,
          role: "USER",
          state: "COMPLETE",
          parts: [{ type: "text", content: "how many?" }],
        },
        {
          id: "assistant-1",
          seq: 3,
          role: "ASSISTANT",
          state: "STREAMING",
          parts: [{ type: "text", content: "12 ro" }],
        },
      ];
    });

    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat/chat-1/stream", {
      signal: controller.signal,
    });
    const response = await createApp("owner").request(request);
    const body = await readUntil(response, "12 rows", controller);

    // The finished user turn is a resume point; the half-written answer is not.
    expect(body).toContain("id: 2");
    expect(body.split("12 rows")[0]).not.toContain("id: 3");
    expect(body).toContain("12 ro");
    expect(body).toContain('"state":"STREAMING"');
    // ...and the completed form of that same seq still reaches the client live,
    // WITH its id — the high-water mark only ever advances past a final row, so
    // this frame is not mistaken for a duplicate of the partial just replayed.
    expect(body).toContain("id: 3");
  });

  // Regression guard. A chunk is published at the FIRST TOKEN, before
  // `onMessagesChange` upserts the row, so its seq names a message that may not
  // exist in Postgres yet. Stamping it as an SSE `id:` would let a client that
  // disconnects mid-stream reconnect with `Last-Event-ID: <that seq>`; the
  // replay is `seq > cursor`, so the row would be skipped once it landed and the
  // message lost for good. The cursor may only ever advance on a committed row.
  // THE REGRESSION. A `status` frame is Redis-only and best-effort, and unlike a
  // message it has no durable counterpart in the replay. The route read the
  // session (seeing RUNNING), then subscribed, then replayed messages ONLY — so
  // a worker that finished in the window before the subscription existed had its
  // terminal frame missed outright. The client refreshes session state on a
  // `status` frame and nothing else, so the UI stayed on RUNNING with the
  // composer disabled until a manual reload. Terminal state must be RECOVERABLE
  // FROM THE REPLAY, not only published.
  it("delivers the session's terminal status after the replay, so a missed frame cannot wedge the composer", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    // The run finished before this reader ever subscribed: nothing will arrive
    // on the live feed for the rest of this connection.
    dbMock.chatSession.findUnique.mockResolvedValue({ status: "IDLE" });
    dbMock.chatMessage.findMany.mockResolvedValue([
      {
        id: "assistant-1",
        seq: 3,
        role: "ASSISTANT",
        state: "COMPLETE",
        parts: [{ type: "text", content: "12 rows" }],
      },
    ]);

    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat/chat-1/stream", {
      signal: controller.signal,
    });
    const response = await createApp("owner").request(request);
    const body = await readUntil(response, 'data: "idle"', controller);

    expect(body).toContain("event: status");
    // The status is read AFTER the replay query, and emitted after every
    // replayed row: a client must never re-enable its composer while its
    // transcript is still missing the answer it was waiting for.
    expect(body.indexOf("event: status")).toBeGreaterThan(body.indexOf("id: 3"));
    // …and it is read after the subscription too, which is what makes it
    // race-free: a run that ends later publishes a frame this reader is already
    // listening for.
    expect(dbMock.chatSession.findUnique).toHaveBeenCalledWith({
      where: { id: "chat-1" },
      select: { status: true },
    });
    // A status frame is session state, not a point in the sequence. An `id:`
    // here would advance `Last-Event-ID` past real messages and the next
    // reconnect (`seq > cursor`) would skip them forever.
    expect(body.slice(body.indexOf("event: status"))).not.toContain("id:");
  });

  // The other half: a run still in flight must produce NO terminal frame. Saying
  // "idle" here would re-enable the composer while the answer is still being
  // written — the same wedge, inverted.
  it("says nothing about a session whose run is still in flight", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    dbMock.chatSession.findUnique.mockResolvedValue({ status: "RUNNING" });
    dbMock.chatMessage.findMany.mockResolvedValue([
      {
        id: "assistant-1",
        seq: 3,
        role: "ASSISTANT",
        state: "STREAMING",
        parts: [{ type: "text", content: "12 ro" }],
      },
    ]);

    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat/chat-1/stream", {
      signal: controller.signal,
    });
    const response = await createApp("owner").request(request);
    const body = await readUntil(response, "12 ro", controller);
    expect(body).not.toContain("event: status");
  });

  // Redis being down costs liveness, never durable state — and the session's
  // terminal status is durable state. A reader in the degraded mode has no live
  // feed at all, so the replay is the ONLY thing that can tell it the run ended.
  it("still delivers the terminal status when the live subscription is unavailable", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    dbMock.chatSession.findUnique.mockResolvedValue({ status: "ERROR" });
    dbMock.chatMessage.findMany.mockResolvedValue([]);
    vi.mocked(subscribeToChat).mockRejectedValueOnce(new Error("redis is down"));

    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat/chat-1/stream", {
      signal: controller.signal,
    });
    const response = await createApp("owner").request(request);
    const body = await response.text();

    expect(body).toContain("event: status");
    expect(body).toContain('data: "error"');
    controller.abort();
  });

  // Regression guard, THE WRITE CHAIN. Concurrent `writeSSE` calls on one stream
  // interleave partial frames — an `id:` line landing inside another frame's
  // `data:`, which a browser parses as one corrupt event — so every write on
  // this connection is serialized through `writeChain`, the heartbeat included.
  // The replay loop used to await the socket DIRECTLY, outside the chain: for
  // any replay that outlives the 15-second interval (a long transcript, a slow
  // database, a client draining slowly) the heartbeat then fired onto the chain
  // while the replay was mid-write, unserialized against it — the exact failure
  // the chain exists to prevent. Fake timers, so nothing actually waits.
  it("writes the replay on the same chain as the heartbeat, so a beat cannot land mid-replay", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    // Enough rows that the response's queue fills and the replay is still
    // draining when the interval fires — the state a real long replay is in.
    dbMock.chatMessage.findMany.mockResolvedValue(
      Array.from({ length: 40 }, (_, seq) => ({
        id: `message-${seq}`,
        seq,
        role: "ASSISTANT",
        state: "COMPLETE",
        parts: [{ type: "text", content: `row ${seq}` }],
      })),
    );

    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const response = await createApp("owner").request(
        new Request("http://localhost/api/chat/chat-1/stream", { signal: controller.signal }),
      );
      // Let the subscription, the replay query and the loop run…
      await vi.advanceTimersByTimeAsync(0);
      // …then fire the heartbeat with the replay still unflushed.
      await vi.advanceTimersByTimeAsync(15_000);

      const body = await readUntil(response, "id: 39", controller);
      // Every replayed row was queued onto the chain before the heartbeat was,
      // and the chain is FIFO — so the beat sits behind all 40 of them rather
      // than being wedged between two frames.
      expect(body).not.toContain(": heartbeat");
      expect(body).toContain("row 39");
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits the SSE id on chunk events so a mid-stream drop cannot skip a message", async () => {
    dbMock.chatSession.findFirst.mockResolvedValue({ id: "chat-1" });
    dbMock.chatMessage.findMany.mockResolvedValue([]);

    const controller = new AbortController();
    const request = new Request("http://localhost/api/chat/chat-1/stream", {
      signal: controller.signal,
    });
    const response = await createApp("owner").request(request);
    await vi.waitFor(() => expect(liveListener).toBeDefined());
    liveListener?.({ type: "chunk", seq: 7, data: "tok" });
    const body = await readUntil(response, '"data":"tok"', controller);

    expect(body).toContain("event: chunk");
    expect(body).not.toContain("id: 7");
    // ...but the seq is still delivered, so the client can coalesce tokens into
    // the right message.
    expect(body).toContain('{"seq":7,');
  });
});
