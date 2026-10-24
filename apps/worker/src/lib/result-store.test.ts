import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeSet = vi.fn();
const storeGet = vi.fn();
// `vi.clearAllMocks()` in `beforeEach` wipes mock call history, but the store
// module opens its connection once at import time — so the constructor args
// are recorded in a plain array the clear cannot touch.
const createCalls: unknown[][] = [];

// `@starter/queue` opens IORedis sockets in its real module — mock it, or this
// suite passes locally and hangs in CI.
vi.mock("@starter/queue", () => ({
  redisConnection: { set: vi.fn(), get: vi.fn() },
  createRedisConnection: (...args: unknown[]) => {
    createCalls.push(args);
    return { set: storeSet, get: storeGet, disconnect: vi.fn() };
  },
}));
vi.mock("@starter/env/shared", () => ({ env: { RESULT_STORE_TTL_SECONDS: 600 } }));

const { redisConnection } = await import("@starter/queue");
const { createRedisResultStore } = await import("./result-store.js");

const store = { set: storeSet, get: storeGet };
const producer = redisConnection as unknown as { set: MockInstance; get: MockInstance };

describe("createRedisResultStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens its own untimed connection instead of the producer handle", async () => {
    expect(createCalls).toEqual([[{ commandTimeout: undefined }]]);
    await createRedisResultStore("chat:session-1").put("body-1", {
      body: "hello",
      untrusted: false,
    });
    expect(store.set).toHaveBeenCalledOnce();
    expect(producer.set).not.toHaveBeenCalled();
    expect(producer.get).not.toHaveBeenCalled();
  });

  it("namespaces keys and expires entries with the configured TTL", async () => {
    await createRedisResultStore("chat:session-1").put("body-1", {
      body: "hello",
      untrusted: false,
    });
    expect(store.set).toHaveBeenCalledWith(
      "result-store:chat:session-1:body-1",
      JSON.stringify({ body: "hello", untrusted: false }),
      "EX",
      600,
    );
  });

  // The namespace is the isolation boundary: without it a `retrieve_tool_result`
  // id guessed from one session would read another session's tool output.
  it("cannot read across namespaces", async () => {
    store.get.mockResolvedValue(null);
    await createRedisResultStore("chat:session-2").get("body-1", 0, 10);
    expect(store.get).toHaveBeenCalledWith("result-store:chat:session-2:body-1");
  });

  it("returns null for an unknown or expired id", async () => {
    store.get.mockResolvedValue(null);
    await expect(createRedisResultStore("ns").get("missing", 0, 10)).resolves.toBeNull();
  });

  it("clamps a model-supplied offset/limit instead of rejecting it", async () => {
    store.get.mockResolvedValue(JSON.stringify({ body: "0123456789", untrusted: true }));
    const resultStore = createRedisResultStore("ns");

    await expect(resultStore.get("id", 2, 4)).resolves.toEqual({
      slice: "2345",
      offset: 2,
      total: 10,
      untrusted: true,
      hasMore: true,
    });
    // Negative offset, absurd limit, offset past the end — all clamped.
    await expect(resultStore.get("id", -5, 1000)).resolves.toMatchObject({
      slice: "0123456789",
      offset: 0,
      hasMore: false,
    });
    await expect(resultStore.get("id", 50, 10)).resolves.toMatchObject({
      slice: "",
      offset: 10,
      hasMore: false,
    });
  });
});
