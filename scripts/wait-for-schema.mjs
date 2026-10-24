#!/usr/bin/env node
// Startup admission only: this script never creates a receipt or changes schema.
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { boundedChild } from "./lib/bounded-child.mjs";
import { collectPrisma } from "./lib/collect-prisma.mjs";
import { hasStatements } from "./lib/schema-diff.mjs";

export { collectPrisma } from "./lib/collect-prisma.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const marker = "SCHEMA_GATE_READY";

function gateSql() {
  return `SELECT pg_try_advisory_lock(1145389648) AS locked \\gset
\\if :locked
SELECT to_regclass('starter_control.schema_releases') IS NOT NULL AS installed \\gset
\\if :installed
SELECT EXISTS (SELECT 1 FROM starter_control.schema_releases
  WHERE singleton AND schema_fingerprint = :'fingerprint') AS accepted \\gset
\\if :accepted
\\echo ${marker}
\\else
\\quit
\\endif
\\else
\\quit
\\endif
\\else
\\quit
\\endif
`;
}

export function pgEnvironment(environment) {
  const url = new URL(environment.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.pathname.slice(1)) {
    throw new Error("DATABASE_URL must name a PostgreSQL database.");
  }
  return {
    ...environment,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get("sslmode") || "prefer",
    PGCONNECT_TIMEOUT: "5",
    PGOPTIONS: "-c lock_timeout=5000 -c statement_timeout=15000 -c idle_session_timeout=30000",
  };
}

// The native ChildProcess identity remains valid through exit/close races.
export function startChild(command, args, options, signal) {
  const owner = boundedChild(command, args, {
    ...options,
    signal,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const { child, stop } = owner;
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  const done = owner.done.then(
    () => true,
    () => false,
  );
  child.stdin.on("error", () => {});
  return { child, done, stop, isClosed: () => closed };
}

async function collect(command, args, options, signal) {
  if (signal.aborted) return null;
  const processRun = startChild(command, args, options, signal);
  processRun.child.stdin.end();
  let output = "";
  let overflow = false;
  processRun.child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.length > 16 * 1024 * 1024) {
      overflow = true;
      processRun.stop();
    }
  });
  return (await processRun.done) && !overflow && !signal.aborted ? output : null;
}

export async function schemaAttempt({ environment, fingerprint, signal }) {
  if (signal.aborted) return false;
  const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
  const session = startChild(
    "psql",
    ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-v", `fingerprint=${fingerprint}`],
    {
      cwd: root,
      env: pgEnvironment(environment),
    },
    attemptSignal,
  );
  let buffer = "";
  const admitted = new Promise((resolveAdmitted) => {
    session.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.split(/\r?\n/).includes(marker)) resolveAdmitted(true);
      if (buffer.length > 4096) session.stop();
    });
    session.done.then(() => resolveAdmitted(false));
  });
  session.child.stdin.write(gateSql());
  try {
    if (!(await admitted) || attemptSignal.aborted) return false;
    // The psql session owns the advisory lock throughout this read-only diff.
    const sql = await collectPrisma(
      [
        "migrate",
        "diff",
        "--from-config-datasource",
        `--to-schema=${environment.PRISMA_SCHEMA_DIR || resolve(root, "packages/db/prisma/schema")}`,
        "--script",
      ],
      environment,
      attemptSignal,
    );
    if (!sql?.trim() || hasStatements(sql) || session.isClosed() || attemptSignal.aborted)
      return false;
    // Prove the owner connection survived the complete diff before admitting.
    buffer = "";
    const stillHeld = new Promise((resolveHeld) => {
      session.child.stdout.on("data", () => {
        if (buffer.includes("SCHEMA_GATE_FINISHED")) resolveHeld(true);
      });
      session.done.then(() => resolveHeld(false));
    });
    session.child.stdin.end(
      "SELECT 'SCHEMA_GATE_FINISHED' WHERE EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid = 0 AND objid = 1145389648 AND granted);\n\\quit\n",
    );
    return (await stillHeld) && (await session.done) && !attemptSignal.aborted;
  } finally {
    session.stop();
    await session.done;
  }
}

async function waitForSchema({
  environment = process.env,
  signal,
  attempt = schemaAttempt,
  sleep = delay,
  log = console.log,
}) {
  const seconds = Number(environment.SCHEMA_WAIT_TIMEOUT_SECONDS || 300);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
    throw new Error("SCHEMA_WAIT_TIMEOUT_SECONDS must be between 1 and 3600.");
  pgEnvironment(environment);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(seconds * 1000)]);
  const fingerprint = (
    await collect(
      process.execPath,
      [resolve(root, "scripts/lib/schema-fingerprint.mjs")],
      { env: environment },
      deadline,
    )
  )?.trim();
  if (!fingerprint || !/^[a-f0-9]{16}$/.test(fingerprint))
    throw new Error("Could not fingerprint the image schema.");
  log("Waiting for a successful schema apply matching this image (receipt and live schema).");
  while (!deadline.aborted) {
    if (await attempt({ environment, fingerprint, signal: deadline })) {
      if (deadline.aborted) break;
      log("Schema startup gate passed.");
      return;
    }
    try {
      await sleep(5000, undefined, { signal: deadline });
    } catch {
      /* Deadline or shutdown. */
    }
  }
  throw new Error(
    "Schema startup gate did not pass before timeout or shutdown. Check the schema-apply task, matching Git ref, and schema leader logs; application startup was refused.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(name, () => controller.abort());
  try {
    await waitForSchema({ signal: controller.signal });
  } catch (error) {
    // URL/child errors can include credentials; expose only our fixed messages.
    const message =
      error instanceof Error &&
      /^(SCHEMA_WAIT_|Could not fingerprint|Schema startup gate|DATABASE_URL must)/.test(
        error.message,
      )
        ? error.message
        : "Schema startup gate failed. Check DATABASE_URL and schema-apply configuration.";
    console.error(`FATAL: ${message}`);
    process.exitCode = 1;
  }
}
