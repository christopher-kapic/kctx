// Process entrypoint: runtime itself never loads files or owns process teardown.
import "@starter/env/load-dotenv";

import { createServer } from "node:http";
import prisma from "@starter/db";
import { env } from "@starter/env/shared";
import { redisConnection } from "@starter/queue";
import { sendOperationalFailureAlert } from "./operational-alerts.js";
import { startWorkerRuntime, WorkerDrainError, type WorkerRuntime } from "./runtime.js";

let runtime: WorkerRuntime | undefined;
let starting: Promise<WorkerRuntime> | undefined;
let closing = false;
let exitCode = 0;
const startup = new AbortController();
// Loopback only: no public unauthenticated operational surface.
const health = createServer((_request, response) => {
  response.writeHead(!closing && runtime?.isReady() ? 200 : 503);
  response.end();
});
async function shutdown(reason: string, code = 0) {
  if (code) exitCode = code;
  if (closing) return;
  closing = true;
  // Best effort only: dependency failure must never delay the process watchdog.
  if (code)
    void sendOperationalFailureAlert({ queue: "worker", jobId: reason, message: reason }).catch(
      () => {},
    );
  setTimeout(() => process.exit(1), 20_000);
  startup.abort();
  console.log("[worker] Shutting down:", reason);
  health.close();
  try {
    const active =
      runtime ??
      (await starting?.catch((error: unknown) => {
        if (error instanceof WorkerDrainError) throw error;
        return undefined;
      }));
    await active?.stop();
  } catch (error) {
    console.error("[worker] Unclean drain; exiting without tearing down shared clients:", error);
    process.exit(1);
    return;
  }
  await prisma.$disconnect();
  redisConnection.disconnect();
  process.exit(exitCode);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) => {
  console.error("[worker] unhandledRejection", error);
  void shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (error) => {
  console.error("[worker] uncaughtException", error);
  process.exit(1);
});
try {
  starting = startWorkerRuntime({
    embedded: false,
    signal: startup.signal,
    onFatal: (error) => {
      console.error("[worker] Consumer stopped unexpectedly:", error);
      void shutdown("consumer failure", 1);
    },
  });
  runtime = await starting;
  health.on("error", (error) => {
    console.error("[worker] Health listener failed:", error.message);
    void shutdown("health listener failure", 1);
  });
  // Local dev's Vite server owns port 3001. Docker production workers live in
  // a separate container and are the only callers of this image health probe.
  if (!closing && env.NODE_ENV === "production") health.listen(3001, "127.0.0.1");
} catch (error) {
  console.error("[worker] Startup failed:", error);
  void shutdown("startup failure", startup.signal.aborted ? 0 : 1);
}
