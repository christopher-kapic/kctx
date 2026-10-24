import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { describe, expect, it, vi } from "vitest";

import { AgentRuntimeError } from "./errors";
import { createRetryFailoverAdapter } from "./retry-adapter";

const finished = (usage?: { promptTokens: number; completionTokens: number }): StreamChunk =>
  ({
    type: "RUN_FINISHED",
    finishReason: "stop",
    usage: usage ?? { promptTokens: 3, completionTokens: 1 },
  }) as StreamChunk;

/** Build a test adapter. `impl` throws and/or yields via a plain async function returning an iterable. */
const makeAdapter = (
  modelId: string,
  impl: () => AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk>>,
): AnyTextAdapter =>
  ({
    kind: "text",
    name: "test",
    model: modelId,
    chatStream: async function* () {
      const iterable = await impl();
      for await (const chunk of iterable) yield chunk;
    },
    structuredOutput: async () => ({ data: null, rawText: "" }),
  }) as unknown as AnyTextAdapter;

/** Async iterable that fails before yielding. */
function failStream(error: unknown): AsyncIterable<StreamChunk> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<StreamChunk>> {
          throw error;
        },
      };
    },
  };
}

async function* okStream(usage?: {
  promptTokens: number;
  completionTokens: number;
}): AsyncIterable<StreamChunk> {
  yield finished(usage);
}

const drain = async (adapter: AnyTextAdapter) => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.chatStream({} as never)) {
    chunks.push(chunk);
  }
  return chunks;
};

describe("createRetryFailoverAdapter", () => {
  it("retries a transient 503 twice then succeeds; only one successful stream is yielded", async () => {
    let calls = 0;
    const primary = makeAdapter("primary", () => {
      calls += 1;
      if (calls < 3) {
        return failStream(Object.assign(new Error("unavailable"), { status: 503 }));
      }
      return okStream();
    });

    const sleeps: number[] = [];
    const { adapter, getServingModelId } = createRetryFailoverAdapter({
      candidates: [{ adapter: primary, modelId: "primary" }],
      maxAttemptsPerModel: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
    });

    const chunks = await drain(adapter);
    expect(calls).toBe(3);
    expect(chunks).toHaveLength(1);
    expect(getServingModelId()).toBe("primary");
    expect(sleeps).toHaveLength(2);
  });

  it("fails immediately on 401 with no retry", async () => {
    let calls = 0;
    const primary = makeAdapter("primary", () => {
      calls += 1;
      return failStream(Object.assign(new Error("unauthorized"), { status: 401 }));
    });
    const sleep = vi.fn();
    const { adapter } = createRetryFailoverAdapter({
      candidates: [{ adapter: primary, modelId: "primary" }],
      sleep,
    });
    await expect(drain(adapter)).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails over to a backup model after primary exhausts retries", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = makeAdapter("primary-model", () => {
      primaryCalls += 1;
      return failStream(Object.assign(new Error("503"), { status: 503 }));
    });
    const fallback = makeAdapter("fallback-model", () => {
      fallbackCalls += 1;
      return okStream({ promptTokens: 5, completionTokens: 2 });
    });
    const onFailover = vi.fn();
    const { adapter, getServingModelId } = createRetryFailoverAdapter({
      candidates: [
        { adapter: primary, modelId: "primary-model" },
        { adapter: fallback, modelId: "fallback-model" },
      ],
      maxAttemptsPerModel: 2,
      sleep: async () => undefined,
      random: () => 0,
      onFailover,
    });

    await drain(adapter);
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(1);
    expect(getServingModelId()).toBe("fallback-model");
    expect(onFailover).toHaveBeenCalledWith("fallback-model", "primary-model");
  });

  it("honors Retry-After for the backoff delay", async () => {
    let calls = 0;
    const primary = makeAdapter("primary", () => {
      calls += 1;
      if (calls === 1) {
        return failStream(
          Object.assign(new Error("rate limited"), {
            status: 429,
            headers: { "retry-after": "1" },
          }),
        );
      }
      return okStream();
    });
    const sleeps: number[] = [];
    const { adapter } = createRetryFailoverAdapter({
      candidates: [{ adapter: primary, modelId: "primary" }],
      maxAttemptsPerModel: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 1,
    });
    await drain(adapter);
    expect(sleeps).toEqual([1000]);
  });

  it("aborts promptly during backoff when the signal fires", async () => {
    const controller = new AbortController();
    let calls = 0;
    const primary = makeAdapter("primary", () => {
      calls += 1;
      return failStream(Object.assign(new Error("503"), { status: 503 }));
    });
    const { adapter } = createRetryFailoverAdapter({
      candidates: [{ adapter: primary, modelId: "primary" }],
      maxAttemptsPerModel: 3,
      abortSignal: controller.signal,
      sleep: async (_ms, signal) => {
        controller.abort();
        if (signal?.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
      },
      random: () => 0,
    });
    await expect(drain(adapter)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("throws a retryable AgentRuntimeError naming attempt/model counts when all fail", async () => {
    const primary = makeAdapter("p", () =>
      failStream(Object.assign(new Error("down"), { status: 503 })),
    );
    const fallback = makeAdapter("f", () =>
      failStream(Object.assign(new Error("down"), { status: 503 })),
    );
    const { adapter } = createRetryFailoverAdapter({
      candidates: [
        { adapter: primary, modelId: "p" },
        { adapter: fallback, modelId: "f" },
      ],
      maxAttemptsPerModel: 2,
      sleep: async () => undefined,
      random: () => 0,
    });
    try {
      await drain(adapter);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRuntimeError);
      const runtime = error as AgentRuntimeError;
      expect(runtime.retryable).toBe(true);
      expect(runtime.message).toMatch(/4 attempt\(s\)/);
      expect(runtime.message).toMatch(/2 model\(s\)/);
    }
  });

  // THE RETRY WINDOW CLOSES WITH THE FIRST CHUNK. Retrying after text has been
  // handed downstream would replay the answer from the top on top of tokens the
  // consumer has already rendered and — in the chat feature — already published
  // over SSE. Transient or not, a committed dispatch is over; the error goes to
  // the caller, which turns it into a failure the user can retry deliberately.
  it("surfaces a mid-stream failure instead of retrying over emitted chunks", async () => {
    let calls = 0;
    const primary = makeAdapter("primary", () => {
      calls += 1;
      if (calls === 1) {
        return (async function* () {
          yield { type: "TEXT_MESSAGE_CONTENT", delta: "first-half" } as StreamChunk;
          throw Object.assign(new Error("stream died"), { status: 503 });
        })();
      }
      return okStream();
    });
    const { adapter } = createRetryFailoverAdapter({
      candidates: [{ adapter: primary, modelId: "primary" }],
      maxAttemptsPerModel: 2,
      sleep: async () => undefined,
      random: () => 0,
    });

    await expect(drain(adapter)).rejects.toThrow("stream died");
    // The 503 is transient and there was an attempt left — the emitted chunk is
    // the only reason this did not retry.
    expect(calls).toBe(1);
  });

  // The other half of the same rule, and the one the buffering design broke: a
  // successful response must reach the consumer AS IT ARRIVES. Buffering until
  // completion silently defeats streaming for every successful answer — the
  // common case — leaving a durable SSE stream with nothing to publish until the
  // model finishes.
  it("forwards chunks as they arrive rather than buffering to completion", async () => {
    const seen: string[] = [];
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const primary = makeAdapter("primary", () =>
      (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "one" } as StreamChunk;
        // The stream does not finish until the consumer has already seen "one".
        // Under the buffering design this deadlocks the assertion below.
        await gate;
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "two" } as StreamChunk;
      })(),
    );
    const { adapter } = createRetryFailoverAdapter({
      candidates: [{ adapter: primary, modelId: "primary" }],
    });

    const consumer = (async () => {
      for await (const chunk of adapter.chatStream({} as never)) {
        seen.push(JSON.stringify(chunk));
        if (seen.length === 1) released();
      }
    })();
    await consumer;
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("one");
  });

  // Failover is announced on the first chunk, not after the stream ends: a
  // consumer must never render text attributed to the wrong model, and once a
  // chunk is out there is no later point to correct it from.
  it("reports the serving model before handing on its first chunk", async () => {
    const failing = makeAdapter("failing", () => {
      throw Object.assign(new Error("down"), { status: 503 });
    });
    const backup = makeAdapter("backup", () => okStream());
    const failovers: string[] = [];
    const { adapter, getServingModelId } = createRetryFailoverAdapter({
      candidates: [
        { adapter: failing, modelId: "primary" },
        { adapter: backup, modelId: "backup" },
      ],
      maxAttemptsPerModel: 1,
      sleep: async () => undefined,
      random: () => 0,
      onFailover: (serving) => failovers.push(serving),
    });

    for await (const _chunk of adapter.chatStream({} as never)) {
      // The very first chunk: the failover must already be known.
      expect(getServingModelId()).toBe("backup");
      expect(failovers).toEqual(["backup"]);
      break;
    }
  });
});
