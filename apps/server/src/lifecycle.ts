import prisma from "@starter/db";
import { env } from "@starter/env/server";
import { redisConnection } from "@starter/queue";
import { startWorkerRuntime, WorkerDrainError, type WorkerRuntime } from "worker/runtime";

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The HTTP host owns signals before dependency startup or the first job. */
export function createServerLifecycle() {
  const startup = new AbortController();
  let runtime: WorkerRuntime | undefined;
  let starting: Promise<WorkerRuntime> | undefined;
  // closeIdleConnections exists on plain HTTP servers (Node >= 18.2); hono's
  // serve() return union also admits Http2 servers, which lack it — hence optional.
  let server:
    | { close(callback: (error?: Error) => void): unknown; closeIdleConnections?(): void }
    | undefined;
  let closing: Promise<void> | undefined;
  let claimed = false;
  let exitCode = 0;

  function requireRunning() {
    if (startup.signal.aborted) throw new Error("Server startup cancelled.");
  }
  async function waitForDependency(name: string, ping: () => Promise<unknown>) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      requireRunning();
      try {
        await withTimeout(ping(), 5000, `${name} startup ping`);
        requireRunning();
        console.log(`[server] ${name} is reachable.`);
        return;
      } catch (error) {
        requireRunning();
        if (attempt === 5) throw error;
        const delay = 500 * 2 ** (attempt - 1);
        console.warn(`[server] ${name} not ready (attempt ${attempt}/5), retrying in ${delay}ms.`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  function shutdown(reason: string, code = 0): Promise<void> {
    if (code) exitCode = code;
    if (closing) return closing;
    // Set the process watchdog before cancellation invokes runtime callbacks.
    const watchdog = setTimeout(() => process.exit(exitCode || 1), 25_000);
    startup.abort();
    console.log(`[server] Received ${reason} — starting graceful shutdown…`);
    closing = (async () => {
      const jobDrain = (async () => {
        let active = runtime;
        if (!active && starting) {
          try {
            active = await starting;
          } catch (error) {
            // Ordinary startup rejection follows a completed cleanup. A failed
            // cleanup must never authorize disconnecting shared clients.
            if (error instanceof WorkerDrainError) throw error;
          }
        }
        await active?.stop();
      })();
      // Handle rejection now while the independent HTTP drain is in progress.
      const jobResult = jobDrain.then(
        () => true,
        (error: unknown) => {
          console.error("[server] Embedded job drain failed:", error);
          return false;
        },
      );
      if (server) {
        // /ready has already flipped to 503, allowing the proxy to stop routing.
        await new Promise((resolve) => setTimeout(resolve, 5000));
        // close() also waits on idle keep-alive sockets; release them now so only
        // in-flight requests hold the drain.
        server.closeIdleConnections?.();
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 10_000);
          server?.close((error) => {
            clearTimeout(timeout);
            if (error) console.error("[server] Error closing HTTP server:", error.message);
            resolve();
          });
        });
      }
      if (!(await jobResult)) {
        process.exit(1);
        return;
      }
      await prisma.$disconnect();
      redisConnection.disconnect();
      clearTimeout(watchdog);
      process.exit(exitCode);
    })().catch((error: unknown) => {
      console.error("[server] Shutdown failed:", error);
      process.exit(1);
    });
    return closing;
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (error) => {
    console.error("[server] unhandledRejection", error);
    void shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (error) => {
    // An unwound stack may leave shared state inconsistent; don't run a drain.
    console.error("[server] uncaughtException", error);
    process.exit(1);
  });
  return {
    isShuttingDown: () => startup.signal.aborted,
    isWorkerReady: () => !startup.signal.aborted && (runtime?.isReady() ?? false),
    async start(listen: () => NonNullable<typeof server>) {
      if (claimed) throw new Error("Server already started; restart the process to re-enter.");
      claimed = true;
      try {
        await waitForDependency("Postgres", () => prisma.$queryRaw`SELECT 1`);
        await waitForDependency("Redis", () => redisConnection.ping());
        requireRunning();
        if (env.WORKER_MODE === "embedded") {
          starting = startWorkerRuntime({
            embedded: true,
            signal: startup.signal,
            onFatal: (error) => {
              console.error("[server] Embedded consumer failed:", error);
              void shutdown("embedded consumer failure", 1);
            },
          });
          runtime = await starting;
        }
        requireRunning();
        server = listen();
      } catch (error) {
        console.error("[server] Startup failed:", error);
        await shutdown("startup failure", startup.signal.aborted ? 0 : 1);
      }
    },
  };
}
