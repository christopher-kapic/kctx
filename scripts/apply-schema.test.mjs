import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { applySchema, LOCK_ID, runCommand } from "./apply-schema.mjs";
import { enumSchemas } from "./fixtures/schema-enum.mjs";
import { classifyDiff, normalizeDiff } from "./lib/schema-diff.mjs";

const sql = 'ALTER TABLE "Example" ADD COLUMN "note" text;';
const changedSql = 'ALTER TABLE "Example" ADD COLUMN "other" text;';
const hash = (text) => createHash("sha256").update(text).digest("hex");
const env = {
  DATABASE_URL: "postgresql://inert:inert@mock-db.example:5432/mock",
  APPLY_SCHEMA: "safe",
};

function harness(options = {}) {
  const events = [];
  const connections = [];
  const abort = new AbortController();
  let receipt;
  let locked = false;
  let plans = 0;
  let mutations = 0;
  const connect = async () => {
    const id = connections.length;
    if (options.connectError?.(id)) throw new Error("connect refused");
    const client = new EventEmitter();
    connections.push(client);
    let ended = false;
    client.query = async (text, values = []) => {
      if (ended) throw new Error("connection ended");
      events.push({ id, text, values });
      await options.beforeQuery?.({ text, values, id, client, abort });
      if (ended) throw new Error("connection ended");
      let rows = [];
      if (text === "SHOW server_version_num") rows = [{ server_version_num: "170000" }];
      if (text === "SELECT pg_advisory_lock($1)") locked = true;
      if (text === sql || text === changedSql || text === options.executable) {
        assert.ok(locked, "DDL must run on the connection that owns the advisory lock");
        mutations++;
      }
      if (text.startsWith("INSERT INTO starter_control.schema_releases")) receipt = values;
      await options.afterQuery?.({ text, values, id, client, abort });
      return { rows };
    };
    client.end = async () => {
      ended = true;
      locked = false;
      events.push({ id, text: "CLOSE" });
    };
    return client;
  };
  const command = async (_file, args, config) => {
    assert.equal(config.env.DATABASE_URL, env.DATABASE_URL);
    if (args[0]?.endsWith("backup-identity.mjs")) return "target-a\n";
    if (args[0]?.endsWith("schema-fingerprint.sh")) return "fingerprint\n";
    if (args[0] === "migrate") {
      // Planning only happens while this session holds the advisory lock.
      assert.ok(locked, "the live diff must be collected under the advisory lock");
      events.push({ text: "PLAN" });
      const result = options.plans?.[plans++] ?? options.sql ?? sql;
      await options.onPlan?.({ plans, abort, connections });
      if (result instanceof Error) throw result;
      return options.collectPlan ? options.collectPlan(config) : result;
    }
    events.push({ text: "BACKUP" });
    await options.backup?.({ abort, connections });
    return "";
  };
  return {
    events,
    abort,
    get receipt() {
      return receipt;
    },
    get mutations() {
      return mutations;
    },
    run: (overrides = {}) =>
      applySchema({
        env: { ...env, ...overrides },
        connect,
        command,
        signal: abort.signal,
        log: () => {},
      }),
  };
}

const dangerous = (fingerprint = "fingerprint") => ({
  APPLY_SCHEMA: "dangerous",
  APPLY_SCHEMA_CONFIRM: `DANGEROUS:target-a:${fingerprint}`,
});

it("operator lock and failure references preserve the ordinary-apply ownership contract", () => {
  const root = resolve(import.meta.dirname, "..");
  for (const [file, heading] of [["infra-notes.md", "## Advisory lock"]]) {
    const document = readFileSync(resolve(root, file), "utf8");
    const section = document.split(heading)[1]?.split(/\n##? /)[0];
    assert.ok(section, `${file} retains its operator lock reference`);
    assert.ok(section.includes(String(LOCK_ID)), `${file} uses the actual shared lock key`);
    assert.match(section, /Node PostgreSQL session/);
    assert.match(section, /SQL[^\n]*receipt[^\n]*complet[^\n]*atomic/);
    assert.match(section, /native[^\n]*(engine|Prisma)/);
    assert.match(section, /drain acknowledgement/);
    assert.match(section, /one transaction|single transaction/);
    assert.match(section, /read-only queries/);
    assert.doesNotMatch(document, /session-v2|session-v1|execution_protocol|nonce/);
    assert.doesNotMatch(
      document,
      /crashed psql|child process of the lock owner|schema is (?:already )?mutated at the moment of failure|pg_terminate_backend\(<pid>\)/,
    );
  }
});

it("installed enum contraction binds and executes the normalized plan atomically", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "apply-enum-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = resolve(import.meta.dirname, "..");
  const config = join(dir, "prisma.config.ts");
  writeFileSync(join(dir, "before.prisma"), enumSchemas.before);
  writeFileSync(join(dir, "after.prisma"), enumSchemas.after);
  writeFileSync(
    config,
    "export default { datasource: { url: 'postgresql://fixture:fixture@127.0.0.1:1/fixture' } };\n",
  );
  const raw = execFileSync(
    process.execPath,
    [
      resolve(root, "packages/db/node_modules/prisma/build/index.js"),
      "migrate",
      "diff",
      `--from-schema=${dir}/before.prisma`,
      `--to-schema=${dir}/after.prisma`,
      `--config=${config}`,
      "--script",
    ],
    { cwd: dir, env: { PATH: process.env.PATH, CHECKPOINT_DISABLE: "1" }, encoding: "utf8" },
  );
  const executable = normalizeDiff(raw);
  const denied = harness({ sql: raw, executable });
  await assert.rejects(denied.run(), /safe refuses destructive/);
  assert.equal(denied.mutations, 0);
  const wrong = harness({ sql: raw, executable });
  await assert.rejects(wrong.run(dangerous("mismatched-fingerprint")), /PREVIEW ONLY/);
  assert.equal(wrong.mutations, 0);
  const approved = harness({ sql: raw, executable });
  await approved.run(dangerous());
  assert.equal(approved.mutations, 1);
  assert.deepEqual(approved.receipt, ["fingerprint", hash(executable)]);
  assert.equal(approved.events.filter((event) => event.text === "BEGIN").length, 1);
  assert.equal(approved.events.filter((event) => event.text === "COMMIT").length, 1);
  assert.equal(approved.events.filter((event) => event.text === "PLAN").length, 2);
  assert.ok(!approved.events.some((event) => event.text === raw));
  const drift = harness({
    plans: [raw, raw.replace("'draft;value'", "'drifted'")],
    executable,
  });
  await assert.rejects(drift.run(dangerous()), /drifted/);
  assert.equal(drift.mutations, 0);
});

describe("live schema SQL preserves UTF-8 through the production collector", () => {
  function fixture(t, bytes, withEngine = false) {
    const dir = mkdtempSync(join(tmpdir(), "apply-prisma-utf8-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const cli = join(dir, "prisma-fixture.cjs");
    const marker = join(dir, "started");
    const engine = join(dir, "schema-engine-fixture.cjs");
    if (withEngine)
      writeFileSync(
        engine,
        `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.PROBE_MARKER, String(process.pid));
setTimeout(() => {}, 500);
`,
        { mode: 0o755 },
      );
    writeFileSync(
      cli,
      `${withEngine ? "require('node:child_process').spawn(process.env.PROBE_ENGINE, [], { env: process.env, stdio: 'ignore' });" : ""}
const bytes = Buffer.from(${JSON.stringify([...bytes])});
let offset = 0;
function write() {
  if (offset === bytes.length) return;
  process.stdout.write(bytes.subarray(offset, ++offset), () => setTimeout(write, 5));
}
write();
`,
    );
    return {
      marker,
      collect: (signal = new AbortController().signal) =>
        runCommand(cli, ["migrate", "diff"], {
          env: { PATH: process.env.PATH, PROBE_MARKER: marker, PROBE_ENGINE: engine },
          cwd: dir,
          signal,
          timeout: 5000,
        }),
    };
  }

  it("keeps split 2/3/4-byte identifiers and literals identical in the approved apply plan", async (t) => {
    const executable = 'CREATE TABLE "café漢😀" ("naïve€🌍" text DEFAULT \'é漢😀\');\n';
    const f = fixture(t, Buffer.from(executable));
    const applied = harness({
      executable,
      collectPlan: ({ signal }) => f.collect(signal),
    });
    await applied.run(dangerous());
    assert.equal(applied.events.filter((event) => event.text === "PLAN").length, 2);
    assert.equal(applied.events.filter((event) => event.text === executable).length, 1);
    assert.equal(applied.mutations, 1);
    assert.deepEqual(applied.receipt, ["fingerprint", hash(executable)]);
  });

  for (const [name, output] of [
    ["empty stdout", ""],
    ["empty-diff marker", "-- This is an empty migration.\n"],
    ["leading BOM", "\ufeff-- This is an empty migration.\n"],
    ["valid replacement character", 'CREATE TABLE "�" ("value" text DEFAULT \'�\');\n'],
  ]) {
    it(`preserves ${name} without silently removing or replacing bytes`, async (t) => {
      const bytes = Buffer.from(output);
      const actual = await fixture(t, bytes).collect();
      assert.equal(actual, output);
      assert.deepEqual(Buffer.from(actual), bytes);
    });
  }

  for (const [name, bytes] of [
    ["malformed sequence", Buffer.from([0xc3, 0x28])],
    ["incomplete tail", Buffer.from([0xe2, 0x82])],
  ]) {
    it(`rejects ${name} only after the real adapter drains its native child`, async (t) => {
      const f = fixture(t, bytes, true);
      let settled = false;
      const outcome = f.collect().then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      for (let attempt = 0; !existsSync(f.marker) && attempt < 500; attempt++) await delay(10);
      assert.equal(existsSync(f.marker), true, "adapter started its native child");
      const pid = Number(readFileSync(f.marker, "utf8"));
      assert.equal(settled, false, "invalid output cannot return before native drain");
      const error = await outcome;
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid UTF-8/);
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    });
  }
});

describe("ordinary apply uses the owned Prisma native comparison boundary", () => {
  async function fixture(t, mode) {
    const dir = mkdtempSync(join(tmpdir(), "apply-prisma-owner-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const engine = join(dir, "schema-engine-fixture.cjs");
    const marker = join(dir, "started");
    const finished = join(dir, "finished");
    writeFileSync(
      engine,
      `#!/usr/bin/env node
const fs = require('node:fs');
process.stdin.resume();
process.on('SIGTERM', () => {});
setTimeout(() => { fs.writeFileSync(process.env.PROBE_FINISH, 'finished'); process.exit(0); }, 8000);
if (process.env.PROBE_MODE === 'error') {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: 4466, message: 'fixture error', data: { is_panic: false,
        message: 'fixture error', error_code: 'P1001' } } }) + '\\n');
  });
}
fs.writeFileSync(process.env.PROBE_MARKER, String(process.pid));
`,
      { mode: 0o755 },
    );
    const schema = join(dir, "schema.prisma");
    const config = join(dir, "prisma.config.ts");
    writeFileSync(
      schema,
      'datasource db {\n provider = "postgresql"\n}\nmodel Example {\n id Int @id\n}\n',
    );
    writeFileSync(
      config,
      "export default { datasource: { url: 'postgresql://fixture:fixture@127.0.0.1:1/fixture' } };\n",
    );
    return {
      dir,
      marker,
      finished,
      cli: resolve(import.meta.dirname, "../packages/db/node_modules/prisma/build/index.js"),
      args: [
        "migrate",
        "diff",
        "--from-empty",
        `--to-schema=${schema}`,
        `--config=${config}`,
        "--script",
      ],
      environment: {
        PATH: process.env.PATH,
        CHECKPOINT_DISABLE: "1",
        PRISMA_SCHEMA_ENGINE_BINARY: engine,
        PROBE_MARKER: marker,
        PROBE_FINISH: finished,
        PROBE_MODE: mode,
      },
    };
  }
  for (const mode of ["cancel", "timeout", "error"]) {
    it(`actual installed CLI ${mode} drains its ignoring-TERM native engine before returning`, async (t) => {
      const f = await fixture(t, mode);
      const abort = new AbortController();
      const pending = runCommand(f.cli, f.args, {
        env: f.environment,
        cwd: f.dir,
        signal: abort.signal,
        timeout: mode === "timeout" ? 2000 : 12_000,
      });
      let settled = false;
      const outcome = pending
        .then(
          () => null,
          (error) => error,
        )
        .finally(() => {
          settled = true;
        });
      for (let attempt = 0; !existsSync(f.marker) && attempt < 500; attempt++) await delay(10);
      assert.equal(existsSync(f.marker), true, "actual CLI started native fixture");
      const pid = Number(readFileSync(f.marker, "utf8"));
      if (mode === "cancel") {
        abort.abort();
        abort.abort();
      }
      await delay(100);
      assert.equal(settled, false, "direct CLI exit cannot imply native drain");
      assert.ok((await outcome) instanceof Error);
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    });
  }
  it("pre-aborted comparison cannot start the installed CLI", async (t) => {
    const f = await fixture(t, "cancel");
    await assert.rejects(
      runCommand(f.cli, f.args, { env: f.environment, cwd: f.dir, signal: AbortSignal.abort() }),
      /failed or was cancelled/,
    );
    assert.equal(existsSync(f.marker), false);
  });
  for (const mode of ["overflow", "multibyte-overflow", "missing-ack"]) {
    it(`${mode} cannot produce successful preparation`, async (t) => {
      const f = await fixture(t, mode);
      const cli = join(f.dir, "prisma-fixture.cjs");
      writeFileSync(
        cli,
        mode === "missing-ack"
          ? "process.kill(process.pid, 'SIGKILL');\n"
          : `require('node:child_process').spawn(process.env.PRISMA_SCHEMA_ENGINE_BINARY, [], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
const wait = setInterval(() => {
  if (require('node:fs').existsSync(process.env.PROBE_MARKER)) {
    clearInterval(wait); process.stdout.write(${mode === "multibyte-overflow" ? "'😀'.repeat(5 * 1024 * 1024)" : "'x'.repeat(17 * 1024 * 1024)"});
  }
}, 10);\n`,
      );
      await assert.rejects(
        runCommand(cli, ["migrate", "diff"], {
          env: f.environment,
          cwd: f.dir,
          signal: new AbortController().signal,
          timeout: 10_000,
        }),
        mode === "missing-ack" ? /could not verify comparison shutdown/ : /failed or was cancelled/,
      );
      if (mode !== "missing-ack") {
        const pid = Number(readFileSync(f.marker, "utf8"));
        assert.throws(() => process.kill(pid, 0), /ESRCH/);
      }
    });
  }
});

describe("collapsed apply protocol (all clients mocked)", () => {
  it("off does not connect or run tools", async () => {
    const t = harness();
    assert.equal(await t.run({ APPLY_SCHEMA: "off" }), "off");
    assert.equal(t.events.length, 0);
  });
  it("safe additive plan locks, backs up, and commits SQL and receipt in one session", async () => {
    const t = harness();
    await t.run();
    assert.deepEqual(t.receipt, ["fingerprint", hash(sql)]);
    const index = (part) => t.events.findIndex((event) => event.text.includes(part));
    assert.ok(index("pg_advisory_lock") < index("PLAN"));
    assert.ok(index("PLAN") < index("BACKUP"));
    assert.ok(index("BACKUP") < index("BEGIN"));
    assert.ok(index("BEGIN") < index("pg_advisory_xact_lock"));
    assert.ok(index("pg_advisory_xact_lock") < index(sql));
    assert.ok(index(sql) < index("schema_releases (singleton"));
    assert.equal(
      new Set(t.events.filter((event) => event.id !== undefined).map((event) => event.id)).size,
      1,
    );
    assert.deepEqual(
      t.events.find((event) => event.text === "SELECT pg_advisory_lock($1)").values,
      [LOCK_ID],
    );
  });
  it("empty safe plan publishes the receipt without an unnecessary backup", async () => {
    const t = harness({ sql: "-- Empty migration." });
    await t.run();
    assert.ok(t.receipt);
    assert.equal(t.mutations, 0);
    assert.ok(!t.events.some((event) => event.text === "BACKUP"));
  });
  it("missing Prisma stdout cannot publish a no-op receipt", async () => {
    const t = harness({ sql: "" });
    await assert.rejects(t.run(), /no schema SQL/);
    assert.equal(t.receipt, undefined);
    assert.equal(t.mutations, 0);
  });
  it("destructive plan in safe mode is refused before any backup or mutation", async () => {
    const t = harness({ sql: 'ALTER TABLE "Example" DROP COLUMN "note";' });
    await assert.rejects(t.run(), /safe refuses destructive/);
    assert.equal(t.mutations, 0);
    assert.equal(t.receipt, undefined);
    assert.ok(!t.events.some((event) => event.text === "BACKUP"));
  });
  it("dangerous plan without a confirmation is a preview-only refusal", async () => {
    const t = harness();
    await assert.rejects(t.run({ APPLY_SCHEMA: "dangerous" }), /PREVIEW ONLY/);
    assert.equal(t.mutations, 0);
    assert.ok(!t.events.some((event) => event.text === "BACKUP"));
  });
  it("wrong target or fingerprint cannot authorize a dangerous apply", async () => {
    const wrongTarget = harness();
    await assert.rejects(
      wrongTarget.run({
        APPLY_SCHEMA: "dangerous",
        APPLY_SCHEMA_CONFIRM: "DANGEROUS:target-b:fingerprint",
      }),
      /PREVIEW ONLY/,
    );
    assert.equal(wrongTarget.mutations, 0);
    const wrongFingerprint = harness();
    await assert.rejects(wrongFingerprint.run(dangerous("other")), /PREVIEW ONLY/);
    assert.equal(wrongFingerprint.mutations, 0);
    const staleShape = harness();
    await assert.rejects(
      staleShape.run({
        APPLY_SCHEMA: "dangerous",
        APPLY_SCHEMA_CONFIRM: `DANGEROUS:target-a:fingerprint:${hash(sql)}:legacy-nonce`,
      }),
      /PREVIEW ONLY/,
    );
    assert.equal(staleShape.mutations, 0);
  });
  it("confirmed dangerous apply backs up, re-verifies the plan, and commits atomically", async () => {
    const t = harness();
    await t.run(dangerous());
    assert.equal(t.mutations, 1);
    assert.deepEqual(t.receipt, ["fingerprint", hash(sql)]);
    assert.equal(t.events.filter((event) => event.text === "PLAN").length, 2);
    const index = (part) => t.events.findIndex((event) => event.text.includes(part));
    assert.ok(index("BACKUP") < index("BEGIN"));
  });
  it("empty dangerous re-entry publishes the receipt without a confirmation", async () => {
    const t = harness({ sql: "-- Empty migration." });
    await t.run({ APPLY_SCHEMA: "dangerous" });
    assert.ok(t.receipt);
    assert.equal(t.mutations, 0);
  });
  it("failed backup refuses mutation", async () => {
    const t = harness({
      backup: () => {
        throw new Error("backup failed");
      },
    });
    await assert.rejects(t.run(dangerous()), /backup failed/);
    assert.equal(t.mutations, 0);
    assert.equal(t.receipt, undefined);
  });
  it("backup-window schema drift refuses mutation", async () => {
    const t = harness({ plans: [sql, changedSql] });
    await assert.rejects(t.run(), /drifted/);
    assert.equal(t.mutations, 0);
    assert.equal(t.receipt, undefined);
  });
  for (const forbidden of [
    "COMMIT;",
    "SELECT 1;",
    'CREATE TABLE "x" (id int) \\gexec',
    'ALTER TABLE "starter_control"."schema_releases" ADD COLUMN x text;',
  ]) {
    it(`rejects transaction escapes / control schema: ${forbidden}`, async () => {
      assert.equal(classifyDiff(forbidden), "unsupported");
      const t = harness({ sql: forbidden });
      await assert.rejects(t.run(), /Unsupported/);
      assert.equal(t.mutations, 0);
    });
  }
  for (const code of ["55P03", "57014", "25P04"]) {
    it(`database timeout ${code} rolls back and permits a fresh retry`, async () => {
      let once = true;
      const t = harness({
        beforeQuery: ({ text }) => {
          if (text === sql && once) {
            once = false;
            throw Object.assign(new Error("timeout"), { code });
          }
        },
      });
      await assert.rejects(t.run(), /timeout/);
      assert.equal(t.receipt, undefined);
      await t.run();
      assert.deepEqual(t.receipt, ["fingerprint", hash(sql)]);
      assert.ok(
        t.events.some(
          (event) =>
            event.text.includes("lock_timeout = '5s'") &&
            event.text.includes("statement_timeout = '60s'") &&
            event.text.includes("transaction_timeout = '300s'"),
        ),
      );
      assert.ok(t.events.some((event) => event.text === "ROLLBACK"));
    });
  }
  it("lock acquisition failure never plans or mutates", async () => {
    const t = harness({
      beforeQuery: ({ text }) => {
        if (text === "SELECT pg_advisory_lock($1)") throw new Error("lock timeout");
      },
    });
    await assert.rejects(t.run(), /lock timeout/);
    assert.ok(!t.events.some((event) => event.text === "PLAN"));
    assert.equal(t.mutations, 0);
  });
  it("advisory lock serializes appliers: every plan and DDL query runs on the locked session", async () => {
    // The harness itself enforces lock ownership on every PLAN and DDL query
    // (an unlocked stage throws); here we additionally prove no stage runs
    // before the lock is taken and the session is never exchanged mid-apply.
    // Real multi-connection contention is covered by the disposable-Postgres
    // operations check (scripts/test-schema-operations.mjs).
    const t = harness();
    await t.run();
    const firstLock = t.events.findIndex((event) => event.text === "SELECT pg_advisory_lock($1)");
    const firstPlan = t.events.findIndex((event) => event.text === "PLAN");
    const firstDdl = t.events.findIndex((event) => event.text === sql);
    assert.ok(firstLock >= 0 && firstPlan > firstLock && firstDdl > firstLock);
    assert.equal(
      new Set(t.events.filter((event) => event.id !== undefined).map((event) => event.id)).size,
      1,
    );
  });
  for (const phase of ["plan", "backup", "ddl", "receipt", "before-commit"]) {
    it(`cancellation during ${phase} admits no later mutation stage`, async () => {
      const t = harness({
        onPlan: ({ abort }) => {
          if (phase === "plan") abort.abort();
        },
        backup: ({ abort }) => {
          if (phase === "backup") abort.abort();
        },
        beforeQuery: ({ text, abort }) => {
          if (
            (phase === "ddl" && text === sql) ||
            (phase === "receipt" &&
              text.startsWith("INSERT INTO starter_control.schema_releases")) ||
            (phase === "before-commit" && text === "COMMIT")
          )
            abort.abort();
        },
      });
      await assert.rejects(t.run());
      // Cancelling at receipt/COMMIT time can only observe the already-executed
      // DDL; every earlier phase stops before any SQL reaches the server.
      assert.equal(t.mutations, ["receipt", "before-commit"].includes(phase) ? 1 : 0);
      assert.ok(t.events.some((event) => event.text === "CLOSE"));
    });
  }
  for (const phase of ["before-ddl", "after-commit"]) {
    it(`connection loss ${phase} fails closed; retry re-verifies idempotently`, async () => {
      let once = true;
      const trigger = ({ text, id, client }) => {
        if (id === 0 && once && text === (phase === "after-commit" ? "COMMIT" : sql)) {
          once = false;
          client.emit("error", new Error("lost"));
          throw new Error("lost");
        }
      };
      const t = harness(
        phase === "before-ddl" ? { beforeQuery: trigger } : { afterQuery: trigger },
      );
      await assert.rejects(t.run(), /lost/);
      if (phase === "before-ddl") {
        assert.equal(t.receipt, undefined);
        assert.equal(t.mutations, 0);
      }
      // A retry is always safe: the live diff is re-collected under the lock,
      // and the receipt upsert is idempotent for an already-committed schema.
      const retry = harness();
      await retry.run();
      assert.deepEqual(retry.receipt, ["fingerprint", hash(sql)]);
    });
  }
});
