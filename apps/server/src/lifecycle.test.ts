import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: "embedded",
  postgres: vi.fn(),
  redis: vi.fn(),
  disconnectDb: vi.fn(),
  disconnectRedis: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  events: [] as string[],
}));
vi.mock("@starter/db", () => ({
  default: { $queryRaw: state.postgres, $disconnect: state.disconnectDb },
}));
vi.mock("@starter/env/server", () => ({
  env: {
    get WORKER_MODE() {
      return state.mode;
    },
  },
}));
vi.mock("@starter/queue", () => ({
  redisConnection: { ping: state.redis, disconnect: state.disconnectRedis },
}));
vi.mock("worker/runtime", () => ({
  startWorkerRuntime: state.start,
  WorkerDrainError: class WorkerDrainError extends Error {},
}));
const listeners = new Map<string, (...args: unknown[]) => void>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.resetAllMocks();
  listeners.clear();
  state.mode = "embedded";
  state.events.length = 0;
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    listeners.set(String(event), listener);
    return process;
  });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  state.postgres.mockResolvedValue(1);
  state.redis.mockResolvedValue("PONG");
  state.stop.mockImplementation(async () => {
    state.events.push("jobs-drained");
  });
  state.disconnectDb.mockImplementation(async () => {
    state.events.push("db-disconnect");
  });
  state.start.mockImplementation(async (options) => {
    expect(listeners.has("SIGTERM")).toBe(true);
    expect(listeners.has("SIGINT")).toBe(true);
    expect(listeners.has("unhandledRejection")).toBe(true);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return { isReady: () => true, stop: state.stop };
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createServerLifecycle", () => {
  it("owns signals before jobs, starts the default embedded runtime, and rejects re-entry", async () => {
    const { createServerLifecycle } = await import("./lifecycle");
    const lifecycle = createServerLifecycle();
    const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
    expect(lifecycle.isWorkerReady()).toBe(false);
    await lifecycle.start(listen);
    expect(state.start).toHaveBeenCalledWith(expect.objectContaining({ embedded: true }));
    expect(lifecycle.isWorkerReady()).toBe(true);
    expect(listen).toHaveBeenCalledOnce();
    await expect(lifecycle.start(listen)).rejects.toThrow("already started");
  });

  it("external placement never starts an embedded fallback", async () => {
    state.mode = "external";
    const { createServerLifecycle } = await import("./lifecycle");
    const lifecycle = createServerLifecycle();
    await lifecycle.start(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
    expect(state.start).not.toHaveBeenCalled();
  });

  it.each(["SIGTERM", "SIGINT", "unhandledRejection", "consumer failure"])(
    "%s during initial heartbeat stops admission and waits for cleanup before shared teardown",
    async (event) => {
      let finish: (() => void) | undefined;
      let fatal: ((error: Error) => void) | undefined;
      state.start.mockImplementation((options) => {
        fatal = options.onFatal;
        state.events.push("job-running");
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            state.events.push("admission-stopped");
            finish = () => {
              state.events.push("jobs-drained");
              reject(new Error("cancelled"));
            };
          });
        });
      });
      const { createServerLifecycle } = await import("./lifecycle");
      const lifecycle = createServerLifecycle();
      const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
      const starting = lifecycle.start(listen);
      await vi.waitFor(() => expect(state.events).toContain("job-running"));
      if (event === "consumer failure") fatal?.(new Error("fatal"));
      else listeners.get(event)?.(new Error("fatal"));
      expect(lifecycle.isShuttingDown()).toBe(true);
      expect(state.events).toContain("admission-stopped");
      expect(state.disconnectDb).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
      finish?.();
      await starting;
      expect(state.events.indexOf("jobs-drained")).toBeLessThan(
        state.events.indexOf("db-disconnect"),
      );
      expect(process.exit).toHaveBeenCalledWith(event.startsWith("SIG") ? 0 : 1);
      await expect(lifecycle.start(listen)).rejects.toThrow("already started");
    },
  );

  it("exits on an unclean startup drain without closing shared dependencies", async () => {
    const { WorkerDrainError } = await import("worker/runtime");
    state.start.mockRejectedValue(new WorkerDrainError("unfinished job"));
    const { createServerLifecycle } = await import("./lifecycle");
    await createServerLifecycle().start(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
    expect(state.disconnectDb).not.toHaveBeenCalled();
    expect(state.disconnectRedis).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("bounds hung startup cancellation and refuses later listener admission", async () => {
    vi.useFakeTimers();
    state.start.mockImplementation(() => new Promise(() => {}));
    const { createServerLifecycle } = await import("./lifecycle");
    const lifecycle = createServerLifecycle();
    const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
    void lifecycle.start(listen);
    await vi.waitFor(() => expect(state.start).toHaveBeenCalled());
    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(state.disconnectDb).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("drains HTTP and jobs, preserves a fatal exit arriving during a signal drain", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    state.stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const close = vi.fn((done: () => void) => {
      state.events.push("http-drained");
      done();
    });
    const closeIdleConnections = vi.fn(() => {
      state.events.push("idle-connections-closed");
    });
    const { createServerLifecycle } = await import("./lifecycle");
    const lifecycle = createServerLifecycle();
    await lifecycle.start(() => ({ close, closeIdleConnections }));
    listeners.get("SIGTERM")?.();
    listeners.get("unhandledRejection")?.(new Error("fatal while draining"));
    expect(lifecycle.isWorkerReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(closeIdleConnections).toHaveBeenCalledOnce();
    expect(state.events.indexOf("idle-connections-closed")).toBeLessThan(
      state.events.indexOf("http-drained"),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(state.disconnectDb).not.toHaveBeenCalled();
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.stop).toHaveBeenCalledOnce();
    expect(state.disconnectDb).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("cancels pending dependency startup without creating workers or listener", async () => {
    let finish: (() => void) | undefined;
    state.postgres.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { createServerLifecycle } = await import("./lifecycle");
    const lifecycle = createServerLifecycle();
    const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
    const starting = lifecycle.start(listen);
    listeners.get("SIGINT")?.();
    finish?.();
    await starting;
    expect(state.start).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("the real entrypoint wires lifecycle readiness and passes the server queue inventory", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("const lifecycle = createServerLifecycle()");
    expect(source).toContain("await lifecycle.start(() =>");
    expect(source).toContain("lifecycle.isShuttingDown()");
    expect(source).toContain("lifecycle.isWorkerReady()");
    expect(source).toContain("hasExternalConsumer(redisConnection, Object.values(QUEUE_NAMES))");
    expect(source).not.toContain("startWorkerRuntime(");
  });
});
