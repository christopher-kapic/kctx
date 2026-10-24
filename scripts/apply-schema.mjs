/** Canonical ordinary schema apply. One session owns both the lock and all DDL. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPrisma } from "./lib/collect-prisma.mjs";
import { classifyDiff, hasStatements, normalizeDiff } from "./lib/schema-diff.mjs";

export const LOCK_ID = 1145389648;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");

// The only durable marker. A singleton row recording the applied schema
// fingerprint, written inside the same transaction as the DDL so followers
// (`WAIT_FOR_SCHEMA`) can never observe a receipt for SQL that is not there.
const receiptSql = `
CREATE SCHEMA IF NOT EXISTS starter_control;
CREATE TABLE IF NOT EXISTS starter_control.schema_releases (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  schema_fingerprint text NOT NULL, plan_identity text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);`;

function failure(message) {
  return new Error(message);
}

/** Injectable boundaries keep ordinary tests entirely network-free. */
export async function applySchema({ env, connect, command, log = console.log, signal }) {
  const mode = env.APPLY_SCHEMA || "off";
  if (mode === "off") return "off";
  if (!["safe", "dangerous"].includes(mode))
    throw failure("APPLY_SCHEMA must be off, safe, or dangerous.");
  if (!env.DATABASE_URL) throw failure("DATABASE_URL is not set.");
  if (Object.keys(env).some((key) => key.startsWith("RESTORE_") && env[key]))
    throw failure("Unset restore-only variables before schema apply.");

  let client;
  let transaction = false;
  const work = new AbortController();
  const cancel = () => work.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const checkpoint = () => {
    if (work.signal.aborted) throw failure("Schema apply cancelled; no later stage will start.");
  };
  const query = async (text, values) => {
    checkpoint();
    return client.query(text, values);
  };
  const run = async (file, args, options = {}) => {
    checkpoint();
    const result = await command(file, args, { env, ...options, signal: work.signal });
    checkpoint();
    return result;
  };
  const close = async (connection) => {
    if (!connection) return;
    let timer;
    try {
      await Promise.race([
        connection.end(),
        new Promise((resolveClose) => {
          timer = setTimeout(() => {
            // pg gracefully ends an idle socket; a partition must not keep
            // that graceful close (or this process) alive indefinitely. The
            // driver-owned stream is never reused after this close boundary.
            connection.connection?.stream?.destroy();
            resolveClose();
          }, 5_000);
        }),
      ]);
    } catch {
      /* The server remains the outcome authority; closing is best effort. */
    } finally {
      clearTimeout(timer);
    }
  };
  const acquire = async (connection) => {
    await connection.query("SET lock_timeout = '300s'; SET statement_timeout = '310s';");
    await connection.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await connection.query(
      "SET lock_timeout = '5s'; SET statement_timeout = '60s'; SET transaction_timeout = '300s'; SET idle_in_transaction_session_timeout = '60s'; SET standard_conforming_strings = on;",
    );
  };
  // Closing a pg connection with an active query destroys its socket, which
  // makes the server roll back any open transaction. Do not issue CANCEL on a
  // second backend/PID that could have been recycled.
  const abortSql = () => {
    void close(client);
  };
  work.signal.addEventListener("abort", abortSql);
  let sqlDeadline;
  try {
    checkpoint();
    client = await connect();
    // A pg client emits 'error' outside queries on transport loss; the pending
    // query already rejects, so keep the process from crashing on the duplex.
    client.on("error", () => {});
    await acquire(client);
    checkpoint();
    const version = await query("SHOW server_version_num");
    const rawVersion = String(version.rows[0]?.server_version_num ?? "unknown");
    const versionNumber = Number(rawVersion);
    const detected = Number.isInteger(versionNumber)
      ? `PostgreSQL ${Math.trunc(versionNumber / 10000)} (server_version_num ${rawVersion})`
      : `server_version_num ${rawVersion}`;
    if (!Number.isInteger(versionNumber) || versionNumber < 170000)
      throw failure(
        `Schema apply requires a PostgreSQL 17 or newer database server; detected ${detected}. Re-provision the database on PostgreSQL 17 or newer — no setting or flag upgrades the server.`,
      );
    await query(receiptSql);

    const target = (await run("node", [resolve(root, "scripts/lib/backup-identity.mjs")])).trim();
    const schemaDir = env.PRISMA_SCHEMA_DIR || resolve(root, "packages/db/prisma/schema");
    const fingerprint = (
      await run("bash", [resolve(root, "scripts/schema-fingerprint.sh")], {
        env: { ...env, PRISMA_SCHEMA_DIR: schemaDir },
      })
    ).trim();
    const diff = async () => {
      const output = await run(
        env.PRISMA_BIN || resolve(root, "packages/db/node_modules/.bin/prisma"),
        ["migrate", "diff", "--from-config-datasource", `--to-schema=${schemaDir}`, "--script"],
        { cwd: env.PRISMA_CWD || resolve(root, "packages/db"), timeout: 120_000 },
      );
      // Prisma represents a no-op with a SQL comment. Missing stdout is a
      // broken machine-output boundary, never evidence of an empty live diff.
      if (!output.trim()) throw failure("Prisma returned no schema SQL or empty-diff marker.");
      try {
        return normalizeDiff(output);
      } catch {
        throw failure("Unsupported schema SQL; the plan cannot escape the atomic transaction.");
      }
    };
    const print = (sql) => {
      log(`APPLY_SCHEMA=${mode} target=${target} fingerprint=${fingerprint} plan=${hash(sql)}`);
      log(sql);
    };
    let sql = await diff();
    const plan = hash(sql);
    print(sql);
    const classification = classifyDiff(sql);
    if (classification === "unsupported")
      throw failure("Unsupported schema SQL; the plan cannot escape the atomic transaction.");
    if (mode === "safe" && classification === "destructive")
      throw failure("APPLY_SCHEMA=safe refuses destructive SQL in the plan.");
    if (hasStatements(sql)) {
      // The confirmation binds the target and schema fingerprint, not plan
      // bytes: replay against a different schema fails the fingerprint match,
      // and any drift inside this run is refused by the post-backup re-diff.
      if (mode === "dangerous" && env.APPLY_SCHEMA_CONFIRM !== `DANGEROUS:${target}:${fingerprint}`)
        throw failure(
          `PREVIEW ONLY: set APPLY_SCHEMA_CONFIRM=DANGEROUS:<target-id>:<schema-fingerprint>. Expected DANGEROUS:${target}:${fingerprint}.`,
        );
      // Reuse the canonical shell backup policies, including writer identity,
      // immutable upload validation, provider-only acknowledgement and drain.
      await run(
        "bash",
        [
          "-c",
          'DB_APPLIER_LIBRARY_ONLY=1 source "$1"; if [ "$2" = dangerous ]; then assert_dangerous_backup_policy; else maybe_pre_apply_backup; fi',
          "schema-backup",
          resolve(root, "scripts/db-applier.sh"),
          mode,
        ],
        { inherit: true },
      );
      sql = await diff();
      if (hash(sql) !== plan)
        throw failure(
          "Live schema plan drifted during the backup window; preview again before applying.",
        );
    }
    checkpoint();
    transaction = true;
    // A transport partition cannot leave this client waiting indefinitely. The
    // server has the stricter transaction timeout; the local guard closes its
    // socket, which also releases the session advisory lock.
    sqlDeadline = setTimeout(cancel, 310_000);
    await query("BEGIN");
    // Session-lock release inside a generated default cannot defeat this lock:
    // it is released only when this very transaction commits or rolls back.
    await query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID]);
    if (hasStatements(sql)) await query(sql);
    await query(
      "INSERT INTO starter_control.schema_releases (singleton, schema_fingerprint, plan_identity) VALUES (true,$1,$2) ON CONFLICT (singleton) DO UPDATE SET schema_fingerprint = EXCLUDED.schema_fingerprint, plan_identity = EXCLUDED.plan_identity, applied_at = now()",
      [fingerprint, plan],
    );
    await query("COMMIT");
    transaction = false;
    log("Schema sync complete.");
    return "completed";
  } catch (error) {
    if (transaction && !work.signal.aborted) {
      // Acknowledged server rejection: roll back politely on the same session.
      // A dead connection (or cancellation, whose abort already closed the
      // socket) leaves the server to roll back on session end — the whole
      // transaction, receipt included, is atomic either way.
      try {
        await client.query("ROLLBACK");
        transaction = false;
      } catch {
        /* The server rolls back on disconnect; retry re-verifies the diff. */
      }
    }
    throw error;
  } finally {
    clearTimeout(sqlDeadline);
    signal?.removeEventListener("abort", cancel);
    work.signal.removeEventListener("abort", abortSql);
    await close(client);
  }
}

export function runCommand(file, args, { env, signal, cwd, timeout = 0, inherit = false }) {
  if (args[0] === "migrate" && args[1] === "diff")
    return collectPrisma(args, { ...env, PRISMA_BIN: file, PRISMA_CWD: cwd }, signal, {
      timeout,
    }).then((output) => {
      if (output === null) throw failure("Schema preparation child failed or was cancelled.");
      return output;
    });
  return new Promise((resolveCommand, reject) => {
    if (signal.aborted) return reject(failure("Schema apply cancelled before child start."));
    const child = spawn(file, args, {
      env,
      cwd,
      stdio: ["ignore", inherit ? "inherit" : "pipe", "inherit"],
    });
    let output = "";
    let stopped = false;
    let escalation;
    const abort = () => {
      stopped = true;
      // ChildProcess identity, not a PID from a persisted file. Shell backup
      // helpers drain their owned writer before close, so no artifacts disappear
      // under a running uploader. No new stage is admitted after the close.
      child.kill("SIGTERM");
      // Fingerprint readers have no durable side effect to drain.
      // The backup shell instead owns a bounded native-client drain of its own.
      if (!inherit) escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = timeout ? setTimeout(abort, timeout) : undefined;
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      if (output.length > 16 * 1024 * 1024) abort();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal.removeEventListener("abort", abort);
      if (stopped || code !== 0)
        reject(failure("Schema preparation child failed or was cancelled."));
      else resolveCommand(output);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(name, () => abort.abort());
  try {
    // packages/db exists in all three images. Node resolution also finds the
    // dedicated applier's flattened /app/node_modules deployment closure.
    const require = createRequire(resolve(root, "packages/db/package.json"));
    const { Client } = require("pg");
    const connect = async () => {
      const client = new Client({
        connectionString: process.env.DATABASE_URL,
        application_name: "starter-db-applier-session",
        connectionTimeoutMillis: 10_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
        query_timeout: 320_000,
        pipeline: false,
      });
      try {
        await client.connect();
        return client;
      } catch (error) {
        await client.end().catch(() => {});
        throw error;
      }
    };
    await applySchema({ env: process.env, connect, command: runCommand, signal: abort.signal });
  } catch (error) {
    // Never echo pg's error object: it can contain connection parameters or SQL
    // data. The diagnostic vocabulary is owned above, not a driver stack trace.
    console.error(
      `FATAL: ${error instanceof Error && !error.code ? error.message : "Schema database operation failed; no successful release was published."}`,
    );
    process.exitCode = 1;
  }
}
