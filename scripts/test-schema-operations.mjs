/** Opt-in operations check: owns one disposable PG17 container; never reads .env. */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { applySchema } from "./apply-schema.mjs";
import { enumSchemas } from "./fixtures/schema-enum.mjs";
import { classifyDiff, normalizeDiff } from "./lib/schema-diff.mjs";
import { applyArchive, restorePrefix } from "./restore-archive.mjs";

if (process.argv[2] !== "--disposable-postgres") {
  console.error(
    "Explicit opt-in required: node scripts/test-schema-operations.mjs --disposable-postgres",
  );
  process.exit(1);
}
const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { Client } = require("pg");
const name = `template-schema-test-${randomUUID()}`;
const password = randomUUID();
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let created = false;
const clients = new Set();
const fixture = mkdtempSync(join(tmpdir(), "schema-operations-"));
const repo = resolve(import.meta.dirname, "..");
async function checkOperations() {
  try {
    docker("image", "inspect", "postgres:17-alpine", "--format", "{{.Id}}");
    docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,size=128m",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "postgres:17-alpine",
    );
    created = true;
    const port = docker("port", name, "5432/tcp").split(":").at(-1);
    assert.match(port, /^\d+$/);
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
    const open = async () => {
      const client = new Client({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 2_000,
        pipeline: false,
      });
      client.on("error", () => {});
      try {
        await client.connect();
      } catch (error) {
        await client.end().catch(() => {});
        throw error;
      }
      clients.add(client);
      return client;
    };
    let inspector;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        inspector = await open();
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(inspector, "disposable PostgreSQL must become ready");
    // Reuse the cached image's native tools without a build/install or Docker
    // exec proxy between the supervisor and libpq. The copied musl loader/tools
    // live only in our disposable fixture and own real local client sockets.
    const toolsDir = join(fixture, "pg-tools");
    mkdirSync(toolsDir);
    const libraries = new Set(["/lib/ld-musl-x86_64.so.1"]);
    for (const tool of ["psql", "pg_dump", "pg_restore"]) {
      const path = `/usr/local/bin/${tool}`;
      const linked = docker("exec", name, "ldd", path);
      for (const match of linked.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)/gm)) libraries.add(match[1]);
      docker("cp", `${name}:${path}`, join(toolsDir, `${tool}.bin`));
      writeFileSync(
        join(toolsDir, tool),
        `#!/bin/sh\nexec '${toolsDir}/ld-musl-x86_64.so.1' --library-path '${toolsDir}' '${toolsDir}/${tool}.bin' "$@"\n`,
        { mode: 0o755 },
      );
    }
    for (const library of libraries)
      docker("cp", "-L", `${name}:${library}`, join(toolsDir, basename(library)));
    const pgEnv = {
      PATH: `${toolsDir}:${process.env.PATH}`,
      PGHOST: "127.0.0.1",
      PGPORT: port,
      PGDATABASE: "postgres",
      PGUSER: "postgres",
      PGPASSWORD: password,
    };
    const count = async (text) => Number((await inspector.query(text)).rows[0].count);
    const run = (sql, options = {}) => {
      let connectCount = 0;
      return applySchema({
        env: { DATABASE_URL: databaseUrl, APPLY_SCHEMA: "safe", ...options.env },
        signal: options.signal,
        log: () => {},
        connect: async () => {
          const client = await open();
          const id = connectCount++;
          const query = client.query.bind(client);
          client.query = async (text, values) => {
            await options.beforeQuery?.({ text, client, id });
            const result = await query(text, values);
            if (text.includes("SET transaction_timeout") && options.limits)
              await query(options.limits);
            await options.afterQuery?.({ text, client, id });
            return result;
          };
          return client;
        },
        // Schema generation/backup boundaries are inert. The actual PostgreSQL
        // sessions, advisory/table locks, DDL, transactions and receipts are real.
        command: async (_file, args) => {
          if (args[0]?.endsWith("backup-identity.mjs")) return "fixture-target";
          if (args[0]?.endsWith("schema-fingerprint.sh")) return "fixture-fingerprint";
          if (args[0] === "migrate") return sql;
          return "";
        },
      });
    };
    await run('CREATE TABLE "operation_fixture" ("id" integer);');
    assert.equal(
      await count(
        "SELECT count(*) FROM starter_control.schema_releases WHERE schema_fingerprint = 'fixture-fingerprint'",
      ),
      1,
    );
    console.log("PASS initial schema and atomic receipt");

    // Cancel actual pg_dump while it waits for our fixture's table lock. This
    // exercises applier -> cooperative backup shell -> native supervisor, not
    // a Docker exec proxy or a mocked process. No S3 configuration is inherited.
    const backupBlocker = await open();
    await backupBlocker.query('BEGIN; LOCK TABLE "operation_fixture" IN ACCESS EXCLUSIVE MODE;');
    const backupArtifacts = join(fixture, "backup-artifacts");
    const backup = promisify(execFile)(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-ceu",
        `
      DB_APPLIER_LIBRARY_ONLY=1 source "$1"
      mktemp() { local path; path="$(command mktemp "$@")"; printf '%s\\n' "$path" >> "$ARTIFACTS"; printf '%s' "$path"; }
      run_backup
    `,
        "owned-backup-fixture",
        join(repo, "scripts/db-applier.sh"),
      ],
      {
        env: {
          ...pgEnv,
          PS1: "",
          TMPDIR: fixture,
          DATABASE_URL: databaseUrl,
          PGAPPNAME: "owned-backup-fixture",
          BACKUP_ENABLED: "true",
          ARTIFACTS: backupArtifacts,
        },
      },
    );
    let backupDiagnostic = "";
    const backupOutcome = backup.then(
      () => 0,
      (error) => {
        backupDiagnostic = error.stderr;
        return error.code;
      },
    );
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting =
          (await count(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'owned-backup-fixture' AND wait_event_type = 'Lock'",
          )) > 0;
        if (waiting) break;
        await delay(50);
      }
      assert.equal(waiting, true, "the actual dump must reach its native lock wait");
      const started = Date.now();
      backup.child.kill("SIGTERM");
      assert.equal(await backupOutcome, 143, backupDiagnostic);
      assert.ok(Date.now() - started < 10_000, "native dump cancellation must finish promptly");
      assert.equal(
        await count(
          "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'owned-backup-fixture'",
        ),
        0,
      );
      assert.ok(
        readFileSync(backupArtifacts, "utf8")
          .trim()
          .split("\n")
          .every((path) => !existsSync(path)),
      );
      console.log(
        "PASS actual PG17 pg_dump cancellation drains all three owners before artifact removal",
      );
    } finally {
      // This retained ChildProcess is the owned fixture, never a stored PID.
      backup.child.kill("SIGTERM");
      await backupOutcome;
      await backupBlocker.query("ROLLBACK");
      await backupBlocker.end();
    }

    const blocker = await open();
    await blocker.query('BEGIN; LOCK TABLE "operation_fixture" IN ACCESS SHARE MODE;');
    const start = Date.now();
    const addition = 'ALTER TABLE "operation_fixture" ADD COLUMN "note" text;';
    await assert.rejects(run(addition), (error) => error.code === "55P03");
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 4_500 && elapsed < 15_000, `production lock timeout took ${elapsed}ms`);
    assert.equal(
      await count(
        "SELECT count(*) FROM information_schema.columns WHERE table_name = 'operation_fixture' AND column_name = 'note'",
      ),
      0,
    );
    await blocker.query("ROLLBACK");
    await blocker.end();
    await run(addition);
    console.log("PASS real five-second table contention, rollback, and ordinary retry");

    for (const [kind, limits] of [
      ["statement", "SET statement_timeout = '100ms';"],
      ["transaction", "SET statement_timeout = '5s'; SET transaction_timeout = '100ms';"],
    ]) {
      const slow = `CREATE TABLE "slow_${kind}" AS SELECT 1 AS id FROM pg_sleep(1);`;
      await assert.rejects(run(slow, { limits }));
      assert.equal(
        await count(
          `SELECT count(*) FROM information_schema.tables WHERE table_name = 'slow_${kind}'`,
        ),
        0,
      );
      console.log(`PASS real ${kind} timeout rollback (test shortens only the server duration)`);
    }

    const abort = new AbortController();
    let timer;
    await assert.rejects(
      run('CREATE TABLE "cancelled_fixture" AS SELECT 1 AS id FROM pg_sleep(5);', {
        signal: abort.signal,
        beforeQuery: ({ text }) => {
          if (text.startsWith('CREATE TABLE "cancelled_fixture"'))
            timer = setTimeout(() => abort.abort(), 100);
        },
      }),
    );
    clearTimeout(timer);
    assert.equal(
      await count(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'cancelled_fixture'",
      ),
      0,
    );
    console.log("PASS cancellation closes real SQL session and verifies rollback");

    await assert.rejects(
      run('CREATE TABLE "commit_reply_fixture" (id integer);', {
        afterQuery: ({ text, id }) => {
          if (text === "COMMIT" && id === 0)
            throw new Error("simulated lost reply after real commit");
        },
      }),
    );
    assert.equal(
      await count(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'commit_reply_fixture'",
      ),
      1,
    );
    console.log("PASS lost COMMIT reply fails closed while the server keeps the atomic completion");

    let firstInside;
    const inside = new Promise((resolveInside) => {
      firstInside = resolveInside;
    });
    let releaseFirst;
    const hold = new Promise((resolveHold) => {
      releaseFirst = resolveHold;
    });
    const first = run('CREATE TABLE "concurrent_first" (id integer);', {
      beforeQuery: async ({ text }) => {
        if (text === "BEGIN") {
          firstInside();
          await hold;
        }
      },
    });
    await inside;
    let secondAdmitted = false;
    const second = run('CREATE TABLE "concurrent_second" (id integer);', {
      beforeQuery: ({ text }) => {
        if (text === "SHOW server_version_num") secondAdmitted = true;
      },
    });
    await delay(100);
    assert.equal(
      secondAdmitted,
      false,
      "second connection must still wait on the advisory lock while the first owns it",
    );
    releaseFirst();
    await Promise.all([first, second]);
    console.log("PASS concurrent appliers serialize on the advisory lock");
    await run("-- Empty migration.");
    console.log("PASS empty schema publishes a fresh receipt");

    // Generate actual pinned-Prisma SQL offline, then execute it exclusively
    // through the canonical applier against this owned PG17. Leave the same
    // consumers present: Prisma can also render removals with invalid ordering,
    // which the atomic writer must reject rather than pretend are executable.
    const enumBefore = join(fixture, "enum-before.prisma");
    writeFileSync(enumBefore, enumSchemas.before);
    const enumAfter = join(fixture, "enum-after.prisma");
    writeFileSync(
      enumAfter,
      readFileSync(enumBefore, "utf8")
        .replace("  ARCHIVED\n", "")
        .replace("  THREE\n", "")
        .replace("  REMOVE\n", ""),
    );
    const enumConfig = join(fixture, "enum.config.ts");
    writeFileSync(
      enumConfig,
      "export default { datasource: { url: 'postgresql://fixture:fixture@127.0.0.1:1/fixture' } };\n",
    );
    const enumDiff = (from, to) =>
      execFileSync(
        process.execPath,
        [
          join(repo, "packages/db/node_modules/prisma/build/index.js"),
          "migrate",
          "diff",
          from,
          `--to-schema=${to}`,
          `--config=${enumConfig}`,
          "--script",
        ],
        {
          cwd: fixture,
          env: { PATH: process.env.PATH, CHECKPOINT_DISABLE: "1" },
          encoding: "utf8",
        },
      );
    await run(enumDiff("--from-empty", enumBefore));
    await inspector.query(
      'INSERT INTO "EnumArticle" (id, "status mapped", "defaultRemoved", "unused") VALUES ($1, $2, $3, $4)',
      [1, "ARCHIVED", "PUBLISHED", "KEEP"],
    );
    const enumPlan = enumDiff(`--from-schema=${enumBefore}`, enumAfter);
    const executableEnumPlan = normalizeDiff(enumPlan);
    const enumHash = createHash("sha256").update(executableEnumPlan).digest("hex");
    const enumEnv = () => ({
      APPLY_SCHEMA: "dangerous",
      APPLY_SCHEMA_CONFIRM: "DANGEROUS:fixture-target:fixture-fingerprint",
    });
    const receiptBefore = (await inspector.query("SELECT * FROM starter_control.schema_releases"))
      .rows[0];
    await assert.rejects(run(enumPlan, { env: enumEnv() }), (error) => error.code === "22P02");
    assert.deepEqual(
      (await inspector.query("SELECT * FROM starter_control.schema_releases")).rows[0],
      receiptBefore,
    );
    assert.equal(
      await count(
        "SELECT count(*) FROM pg_type WHERE typname IN ('Status mapped_new', 'Status mapped_old', 'Mode_new', 'Mode_old')",
      ),
      0,
    );
    assert.equal(
      await count(
        "SELECT count(*) FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'Status mapped' AND e.enumlabel = 'ARCHIVED'",
      ),
      1,
    );
    await inspector.query('UPDATE "EnumArticle" SET "status mapped" = $1 WHERE id = $2', [
      "PUBLISHED",
      1,
    ]);
    let executed = false;
    await run(enumPlan, {
      env: enumEnv(),
      beforeQuery: ({ text }) => {
        if (text === executableEnumPlan) executed = true;
        assert.notEqual(text, enumPlan, "generated transaction wrappers cannot reach PostgreSQL");
      },
    });
    assert.equal(executed, true);
    assert.equal(
      (await inspector.query("SELECT plan_identity FROM starter_control.schema_releases")).rows[0]
        .plan_identity,
      enumHash,
    );
    assert.equal(
      await count(
        "SELECT count(*) FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'Status mapped' AND e.enumlabel = 'ARCHIVED'",
      ),
      0,
    );
    console.log(
      "PASS installed Prisma enum contract: retained-value failure rolls back types/data/receipt; fresh confirmed normalized plan commits atomically",
    );

    for (const escaped of [
      String.raw`CREATE TABLE escaped_e (v text DEFAULT E'a\'b'); COMMIT; CREATE TABLE escaped_second (v text DEFAULT 'z');`,
      "CREATE TABLE escaped_comment (v text DEFAULT 'x' /* outer /* inner */ ' */); COMMIT; CREATE TABLE escaped_second (v text DEFAULT 'z');",
      String.raw`ALTER TABLE U&"starter\005fcontrol"."schema_releases" ADD COLUMN extra text;`,
      String.raw`CREATE TABLE escaped_plain (v text DEFAULT 'a\'b'); COMMIT; CREATE TABLE escaped_second (v text DEFAULT 'z');`,
      "CREATE TABLE escaped_continuation (v text DEFAULT E'a'\n'b\\'c'); COMMIT; CREATE TABLE escaped_second (id int);",
    ]) {
      await assert.rejects(run(escaped), /Unsupported schema SQL/);
      assert.equal(
        await count(
          "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'escaped_%'",
        ),
        0,
      );
    }
    await run(String.raw`CREATE TABLE "quoted;fixture" (v text DEFAULT E'a\'b;COMMIT;');`);
    // Start the connection with the role's opposite setting. acquire() must pin
    // the parser contract before executing any generated SQL.
    await run(String.raw`CREATE TABLE literal_backslash (v text DEFAULT 'a\');`, {
      beforeQuery: async ({ text, client }) => {
        if (text.startsWith("SET lock_timeout = '300s'")) {
          await Client.prototype.query.call(client, "SET standard_conforming_strings = off");
        }
      },
    });
    console.log(
      "PASS real PG lexical refusal, benign E-string DDL, and pinned ordinary-string setting",
    );

    const prismaCwd = join(fixture, "prisma-package");
    mkdirSync(prismaCwd);
    cpSync(join(repo, "packages/db/prisma.config.ts"), join(prismaCwd, "prisma.config.ts"));
    cpSync(join(repo, "packages/db/prisma/schema"), join(prismaCwd, "prisma/schema"), {
      recursive: true,
    });
    symlinkSync(join(repo, "packages/db/node_modules"), join(prismaCwd, "node_modules"), "dir");
    const generated = execFileSync(
      join(repo, "packages/db/node_modules/.bin/prisma"),
      ["migrate", "diff", "--from-empty", "--to-schema=./prisma/schema", "--script"],
      {
        cwd: prismaCwd,
        env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.ok(generated.includes('CREATE TABLE "user"'));
    assert.notEqual(classifyDiff(generated), "unsupported");
    await run(generated);
    console.log(
      "PASS real offline Prisma --script output and complete benign generated SQL on PG17 without quiet override",
    );

    await inspector.query(
      "SET lock_timeout = '5s'; SET statement_timeout = '60s'; SET transaction_timeout = '1800s';",
    );
    await inspector.query(`CREATE FUNCTION public.restore_guard(value text) RETURNS boolean LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('lock_timeout') = '0' OR current_setting('statement_timeout') = '0' OR current_setting('transaction_timeout') = '0' THEN RAISE EXCEPTION 'restore limits disabled'; END IF;
      IF value = 'slow' THEN PERFORM pg_sleep(1); END IF;
      RETURN true;
    END $$;
    CREATE TABLE public.archive_fixture (v text CHECK (public.restore_guard(v)));
    INSERT INTO public.archive_fixture VALUES ('slow'), ('SET statement_timeout = 0;'), ('\\restrict fake'), ('a;COMMIT;');`);
    const dump = join(fixture, "restore.dump");
    execFileSync(
      join(toolsDir, "pg_dump"),
      ["--format=custom", "--table=archive_fixture", `--file=${dump}`],
      { env: pgEnv },
    );
    const script = join(fixture, "restore.sql");
    execFileSync(
      join(toolsDir, "pg_restore"),
      ["--no-owner", "--no-privileges", `--file=${script}`, dump],
      { env: pgEnv },
    );
    const actualPrefix = await restorePrefix(script);
    assert.match(actualPrefix.prefix, /SET transaction_timeout = 0;/);
    // Table-only archives reference their original function. Install that fixture
    // function independently in each test destination (no application data).
    const definition = (
      await inspector.query("SELECT pg_get_functiondef('restore_guard(text)'::regprocedure) AS sql")
    ).rows[0].sql;
    for (const [label, limits] of [
      ["success", ["5s", "60s", "1800s"]],
      ["statement", ["5s", "100ms", "1800s"]],
      ["transaction", ["5s", "5s", "100ms"]],
      ["cancel", ["5s", "5s", "5s"]],
    ]) {
      const db = `restore_${label}`;
      await inspector.query(`CREATE DATABASE ${db}`);
      execFileSync(join(toolsDir, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-c", definition], {
        env: { ...pgEnv, PGDATABASE: db },
        stdio: "ignore",
      });
      const abortRestore = new AbortController();
      const timer = label === "cancel" ? setTimeout(() => abortRestore.abort(), 150) : undefined;
      const restored = applyArchive(script, {
        env: { ...pgEnv, PGDATABASE: db },
        psql: join(toolsDir, "psql"),
        limits,
        signal: abortRestore.signal,
      });
      if (label === "success") await restored;
      else await assert.rejects(restored);
      clearTimeout(timer);
      const query =
        label === "success"
          ? "SELECT count(*) FROM archive_fixture"
          : "SELECT count(*) FROM pg_class WHERE relname = 'archive_fixture'";
      const observed = execFileSync(join(toolsDir, "psql"), ["-X", "-Atqc", query], {
        env: { ...pgEnv, PGDATABASE: db },
        encoding: "utf8",
      }).trim();
      assert.equal(observed, label === "success" ? "4" : "0");
      console.log(
        `PASS real archive ${label}: actual writer limits, atomic rollback and COPY preservation`,
      );
    }
    const dataOnly = join(fixture, "restore-data.sql");
    execFileSync(join(toolsDir, "pg_restore"), ["--data-only", `--file=${dataOnly}`, dump], {
      env: pgEnv,
    });
    const tableLock = await open();
    await tableLock.query("BEGIN; LOCK TABLE archive_fixture IN SHARE MODE;");
    const restoreStart = Date.now();
    await assert.rejects(applyArchive(dataOnly, { env: pgEnv, psql: join(toolsDir, "psql") }));
    assert.ok(Date.now() - restoreStart >= 4_500 && Date.now() - restoreStart < 15_000);
    await tableLock.query("ROLLBACK");
    console.log("PASS actual pg_restore data under real five-second table contention");
    // A local endpoint that accepts TCP but never completes a PostgreSQL
    // handshake exercises the actual libpq connect bound in the connection-count
    // client and the restore lock owner.
    const stalledSockets = new Set();
    const stalled = createServer((socket) => {
      stalledSockets.add(socket);
      socket.on("error", () => {});
    });
    await new Promise((ready) => stalled.listen(0, "127.0.0.1", ready));
    try {
      const address = stalled.address();
      assert.ok(address && typeof address !== "string");
      const connectionEnv = {
        ...pgEnv,
        DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${address.port}/postgres`,
      };
      await Promise.all(
        [
          "load_pg_env; DB_APPLIER_LOCK_PID=123 assert_no_other_connections",
          "with_schema_lock restore",
        ].map(async (operation) => {
          const started = Date.now();
          await assert.rejects(
            promisify(execFile)(
              "bash",
              [
                "-c",
                `DB_APPLIER_LIBRARY_ONLY=1 source "$1"; ${operation}`,
                "connection-fixture",
                join(repo, "scripts/db-applier.sh"),
              ],
              { env: connectionEnv, timeout: 25_000 },
            ),
            (error) => !error.killed && typeof error.code === "number" && error.code !== 0,
          );
          const elapsed = Date.now() - started;
          assert.ok(
            elapsed >= 9_000 && elapsed < 20_000,
            `actual libpq connection deadline: ${elapsed}ms`,
          );
        }),
      );
      console.log(
        "PASS actual connection-count and lock-owner stalled handshakes terminate at libpq's ten-second deadline",
      );
    } finally {
      for (const socket of stalledSockets) socket.destroy();
      await new Promise((closed) => stalled.close(closed));
    }
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    if (created) docker("stop", "--time", "5", name);
    rmSync(fixture, { recursive: true, force: true });
  }
}
await checkOperations();
