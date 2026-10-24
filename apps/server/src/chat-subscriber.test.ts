import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `@starter/queue` MUST be mocked: importing it for real constructs the BullMQ
 * `Queue` objects at module load, which open IORedis sockets. That passes
 * locally (Redis is running) and hangs in CI.
 */
/**
 * What the next connection's `psubscribe` does. Chosen at connection-creation
 * time because the module issues the command synchronously on the first
 * subscriber, before a test could reach in and override it.
 */
let psubscribeBehaviour: () => Promise<number> = async () => 1;
/** ioredis under an outage: pending forever, never rejecting. */
const neverSettles = () => new Promise<number>(() => {});

class FakeRedis extends EventEmitter {
  psubscribe = vi.fn(() => psubscribeBehaviour());
  disconnect = vi.fn();
}

/**
 * A fresh connection per `createRedisConnection()` call, like the real thing —
 * an abandoned attempt must not be the object the next attempt gets back, or a
 * test cannot tell "opened a new connection" from "reused the broken one".
 * `fakeRedis` always names the most recently opened one.
 */
const connections: FakeRedis[] = [];
let fakeRedis = new FakeRedis();
vi.mock("@starter/queue", () => ({
  createRedisConnection: () => {
    fakeRedis = new FakeRedis();
    connections.push(fakeRedis);
    return fakeRedis;
  },
}));

const { chatSubscriberListenerCount, closeChatSubscriber, subscribeToChat } = await import(
  "./chat-subscriber.js"
);

describe("chat subscriber demux", () => {
  beforeEach(async () => {
    await closeChatSubscriber();
    for (const connection of connections) connection.removeAllListeners();
    connections.length = 0;
    vi.clearAllMocks();
  });

  it("uses one pattern subscription and demuxes by session", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = await subscribeToChat("session-1", first);
    const unsubscribeSecond = await subscribeToChat("session-2", second);

    // The O(1)-connection property: two subscribers, one psubscribe.
    expect(fakeRedis.psubscribe).toHaveBeenCalledOnce();
    expect(fakeRedis.psubscribe).toHaveBeenCalledWith("chat:*");

    fakeRedis.emit(
      "pmessage",
      "chat:*",
      "chat:session-1",
      JSON.stringify({ type: "chunk", seq: 2, data: "one" }),
    );
    expect(first).toHaveBeenCalledWith({ type: "chunk", seq: 2, data: "one" });
    expect(second).not.toHaveBeenCalled();

    unsubscribeFirst();
    unsubscribeSecond();
    expect(chatSubscriberListenerCount("session-1")).toBe(0);
    expect(chatSubscriberListenerCount("session-2")).toBe(0);
  });

  it("shares one connection across sequential subscribers", async () => {
    await subscribeToChat("session-1", vi.fn());
    await subscribeToChat("session-1", vi.fn());
    await subscribeToChat("session-3", vi.fn());
    expect(fakeRedis.psubscribe).toHaveBeenCalledOnce();
    expect(chatSubscriberListenerCount("session-1")).toBe(2);
  });

  it("ignores malformed and off-shape payloads", async () => {
    const listener = vi.fn();
    await subscribeToChat("session-1", listener);

    fakeRedis.emit("pmessage", "chat:*", "chat:session-1", "not-json");
    fakeRedis.emit("pmessage", "chat:*", "chat:session-1", JSON.stringify({ type: "nope" }));
    fakeRedis.emit("pmessage", "chat:*", "chat:session-1", JSON.stringify({ type: "chunk" }));
    // Not a chat channel at all — another feature's pub/sub must not leak in.
    fakeRedis.emit(
      "pmessage",
      "chat:*",
      "other:session-1",
      JSON.stringify({ type: "chunk", seq: 1, data: "x" }),
    );

    expect(listener).not.toHaveBeenCalled();
  });

  it("closes the shared connection and drops every listener", async () => {
    await subscribeToChat("session-1", vi.fn());
    await closeChatSubscriber();
    expect(fakeRedis.disconnect).toHaveBeenCalledOnce();
    expect(chatSubscriberListenerCount("session-1")).toBe(0);
  });
});

/**
 * A HUNG DEPENDENCY IS NOT A FAILED DEPENDENCY.
 *
 * `createRedisConnection()` sets `maxRetriesPerRequest: null` and no
 * `commandTimeout`, so an unreachable Redis leaves `psubscribe()` pending
 * forever instead of rejecting. Without a bound here, the caller's
 * `await subscribeToChat(...)` never settles, `chat-routes.ts` never reaches its
 * replay-only degradation, and a Redis outage costs the reader history that is
 * already durable in Postgres.
 */
describe("chat subscriber timeout", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    psubscribeBehaviour = async () => 1;
    await closeChatSubscriber();
    for (const connection of connections) connection.removeAllListeners();
    connections.length = 0;
    vi.clearAllMocks();
  });

  it("gives up on a psubscribe that never settles, without leaking the connection", async () => {
    vi.useFakeTimers();
    psubscribeBehaviour = neverSettles;
    const assertion = expect(subscribeToChat("session-1", vi.fn())).rejects.toThrow(
      /did not complete within/,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    // The half-open connection is closed rather than left reconnecting in the
    // background, and its handler is gone so a socket that recovers later cannot
    // fan out through an attempt nobody is holding.
    expect(connections[0]?.disconnect).toHaveBeenCalledOnce();
    expect(connections[0]?.listenerCount("pmessage")).toBe(0);
    // No listener left in the map for a subscription that never happened.
    expect(chatSubscriberListenerCount("session-1")).toBe(0);
    vi.useRealTimers();
  });

  it("does not poison the subscriber: a later attempt opens a fresh connection and succeeds", async () => {
    vi.useFakeTimers();
    psubscribeBehaviour = neverSettles;
    const firstRejects = expect(subscribeToChat("session-1", vi.fn())).rejects.toThrow(
      /did not complete within/,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await firstRejects;
    vi.useRealTimers();

    // Redis is back. The cached `starting` promise was cleared and no broken
    // connection was cached, so this attempt is a clean one.
    psubscribeBehaviour = async () => 1;
    const listener = vi.fn();
    const unsubscribe = await subscribeToChat("session-2", listener);
    expect(connections).toHaveLength(2);
    expect(connections[1]?.psubscribe).toHaveBeenCalledWith("chat:*");

    connections[1]?.emit(
      "pmessage",
      "chat:*",
      "chat:session-2",
      JSON.stringify({ type: "chunk", seq: 1, data: "live again" }),
    );
    expect(listener).toHaveBeenCalledWith({ type: "chunk", seq: 1, data: "live again" });

    // And the abandoned connection is inert: a late `psubscribe` resolution
    // cannot resurrect it as the shared subscriber, so nothing double-fans-out.
    connections[0]?.emit(
      "pmessage",
      "chat:*",
      "chat:session-2",
      JSON.stringify({ type: "chunk", seq: 2, data: "ghost" }),
    );
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
