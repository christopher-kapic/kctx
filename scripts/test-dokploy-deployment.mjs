import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { schemaFingerprint } from "./lib/schema-fingerprint.mjs";
import {
  evaluateCompression,
  evaluateService,
  parseOptions,
  verifyDeployment,
} from "./verify-dokploy-deployment.mjs";
import { collectPrisma, pgEnvironment, schemaAttempt, startChild } from "./wait-for-schema.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureEnvironment = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };

async function commandOutput(file, args, env = fixtureEnvironment) {
  const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  assert.equal(code, 0, errors);
  return output;
}

const service = {
  id: "service",
  version: 1,
  image: "server:latest",
  generation: 2,
  mode: { Replicated: { Replicas: 1 } },
};
const task = {
  id: "task",
  image: service.image,
  generation: 2,
  slot: 1,
  desired: "running",
  status: "running",
  container: { ContainerID: "container", ExitCode: 0 },
};

test("empty input refuses; app-only and full topology parse without credentials", () => {
  assert.throws(() => parseOptions([]), /required/);
  assert.equal(parseOptions(["--server", "web", "--url", "https://app.example.com"]).timeout, 600);
  assert.equal(
    parseOptions([
      "--server",
      "web",
      "--worker",
      "jobs",
      "--applier",
      "schema",
      "--url",
      "https://app.example.com",
    ]).worker,
    "jobs",
  );
  assert.throws(
    () => parseOptions(["--server", "web", "--url", "https://user:password@example.com"]),
    /credentials/,
  );
  assert.throws(
    () => parseOptions(["--server", "web", "--worker", "web", "--url", "https://example.com"]),
    /different/,
  );
});

test("a previous healthy task and previous successful schema task cannot pass a new deployment", () => {
  const previous = { ...task, generation: 1 };
  assert.equal(evaluateService("server", service, [previous]), null);
  assert.equal(evaluateService("applier", service, [{ ...previous, status: "complete" }]), null);
  assert.equal(
    evaluateService("applier", service, [
      { ...task, status: "complete", container: { ExitCode: 1 } },
    ]),
    null,
  );
  assert.equal(evaluateService("applier", service, [{ ...task, status: "complete" }]).length, 1);
});

test("failed or rolled-back deployment and incomplete replica set cannot report success", () => {
  assert.throws(
    () => evaluateService("server", service, [{ ...task, status: "failed" }]),
    /failed/,
  );
  assert.throws(
    () =>
      evaluateService("server", { ...service, update: { State: "rollback_completed" } }, [task]),
    /rolled back/,
  );
  assert.equal(
    evaluateService("server", { ...service, mode: { Replicated: { Replicas: 2 } } }, [task]),
    null,
  );
});

function fakeDocker({ health = "healthy", mutate = false } = {}) {
  let reads = 0;
  return async (args) => {
    assert.ok(!args.join(" ").includes(".Env"));
    if (args[0] === "service" && args[1] === "inspect")
      return JSON.stringify({ ...service, generation: mutate && reads++ > 0 ? 3 : 2 });
    if (args[0] === "service") return "task";
    if (args[2] === "task") return JSON.stringify(task);
    return JSON.stringify({ running: true, health });
  };
}

test("verification requires healthy selected runtime and JSON public readiness", async () => {
  let queried = false;
  await verifyDeployment(
    { server: "web", url: "https://example.com", timeout: 1 },
    {
      inspect: fakeDocker(),
      log: () => {},
      fetchReady: async (url) => {
        queried = true;
        assert.equal(url, "https://example.com/ready");
        return { status: 200, json: async () => ({ ok: true }) };
      },
      fetchPage: async () => ({
        headers: new Headers({ "content-encoding": "br" }),
        arrayBuffer: async () => new ArrayBuffer(4096),
      }),
    },
  );
  assert.equal(queried, true);
  await assert.rejects(
    verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1 },
      { inspect: fakeDocker({ health: null }), log: () => {} },
    ),
    /no healthcheck/,
  );
  await assert.rejects(
    verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1 },
      { inspect: fakeDocker({ mutate: true }), log: () => {} },
    ),
    /changed/,
  );
});

test("an HTTP 200 HTML fallback does not pass public readiness; cancellation fails", async () => {
  const controller = new AbortController();
  await assert.rejects(
    verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1 },
      {
        inspect: fakeDocker(),
        log: () => {},
        signal: controller.signal,
        fetchReady: async () => ({
          status: 200,
          json: async () => {
            throw new Error("HTML");
          },
        }),
        sleep: async () => {
          controller.abort();
        },
      },
    ),
    /cancelled/,
  );
});

test("compression is classified per content-encoding token, including identity and multi-encodings", () => {
  assert.equal(evaluateCompression("gzip"), true);
  assert.equal(evaluateCompression("BR"), true);
  assert.equal(evaluateCompression("zstd"), true);
  assert.equal(evaluateCompression("gzip, br"), true);
  assert.equal(evaluateCompression("identity"), false);
  assert.equal(evaluateCompression(""), false);
  assert.equal(evaluateCompression(null), false);
});

test("compression advisory passes silently when compressed and warns without failing when not", async () => {
  const run = async (fetchPage) => {
    const messages = [];
    await verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1 },
      {
        inspect: fakeDocker(),
        log: (line) => messages.push(line),
        fetchReady: async () => ({ status: 200, json: async () => ({ ok: true }) }),
        fetchPage,
      },
    );
    return messages;
  };
  const page = (encoding, size) => async (url, init) => {
    assert.equal(url, "https://example.com/");
    assert.match(init.headers["accept-encoding"], /gzip/);
    assert.equal(init.redirect, "follow");
    return {
      headers: new Headers(encoding ? { "content-encoding": encoding } : {}),
      arrayBuffer: async () => new ArrayBuffer(size),
    };
  };
  const verified = (messages) => messages.some((line) => line.startsWith("Deployment verified:"));

  const compressed = await run(page("br", 4096));
  assert.ok(compressed.some((line) => /content-encoding: br/.test(line) && !/WARNING/.test(line)));
  assert.ok(verified(compressed));

  const uncompressed = await run(page(null, 4096));
  const warning = uncompressed.find((line) => line.includes("WARNING (non-fatal)"));
  assert.match(warning, /responded uncompressed/);
  assert.match(warning, /traefik\.http\.middlewares\.<name>\.compress/);
  assert.match(
    warning,
    /patterns\/deployment-vps\.md § Enable response compression \(don't skip\)$/,
  );
  assert.ok(verified(uncompressed));

  const identity = await run(page("identity", 4096));
  assert.match(
    identity.find((line) => line.includes("WARNING")),
    /uncompressed/,
  );

  const tiny = await run(page(null, 12));
  assert.match(
    tiny.find((line) => line.includes("WARNING")),
    /under ~1 KB/,
  );

  const unreadable = await run(async () => {
    throw new Error("offline");
  });
  assert.match(
    unreadable.find((line) => line.includes("WARNING")),
    /could not be verified/,
  );
});

test("libpq environment safely separates credentials and ignores Prisma-only URL params", () => {
  const env = pgEnvironment({
    DATABASE_URL:
      "postgresql://test:disposable%40password@db:5432/app?schema=public&sslmode=require",
    PGOPTIONS: "-c statement_timeout=0",
  });
  assert.equal(env.PGPASSWORD, "disposable@password");
  assert.equal(env.PGDATABASE, "app");
  assert.equal(env.PGSSLMODE, "require");
  assert.match(env.PGOPTIONS, /statement_timeout=15000/);
});

test("startup gate keeps receipt admission before live diff and fails on missing receipt, drift, or owner death", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "schema-startup-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const psql = join(dir, "psql");
  const prisma = join(dir, "prisma.cjs");
  const markerFile = join(dir, "diff-ran");
  await writeFile(
    psql,
    `#!/usr/bin/env bash
while IFS= read -r line; do
  case "$line" in
    *SCHEMA_GATE_READY*)
      case "$GATE_TEST" in no-receipt|old-receipt|reserved|consumed|unknown) exit 0 ;; esac
      echo SCHEMA_GATE_READY
      if [ "$GATE_TEST" = "owner-dies" ]; then sleep 0.02; exit 0; fi
      ;;
    *SCHEMA_GATE_FINISHED*)
      [ "$GATE_TEST" != "connection-lost" ] || exit 0
      echo SCHEMA_GATE_FINISHED; exit 0 ;;
  esac
done
`,
    { mode: 0o755 },
  );
  await writeFile(
    prisma,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.GATE_TEST_MARKER, String(process.pid));
if (process.env.GATE_TEST === "empty-output") process.exit(0);
else if (process.env.GATE_TEST === "prisma-failed") process.exit(1);
else if (process.env.GATE_TEST === "hang") setInterval(() => {}, 1000);
else setTimeout(() => console.log(process.env.GATE_TEST === "drift" ? "ALTER TABLE example ADD COLUMN value text;" : "-- No schema changes"), 50);
`,
    { mode: 0o755 },
  );
  const environment = {
    ...process.env,
    DATABASE_URL: "postgresql://test:disposable@localhost/test",
    PATH: `${dir}:${process.env.PATH}`,
    PRISMA_BIN: prisma,
    PRISMA_CWD: dir,
    GATE_TEST_MARKER: markerFile,
  };
  const run = (mode) =>
    schemaAttempt({
      environment: { ...environment, GATE_TEST: mode },
      fingerprint: "0123456789abcdef",
      signal: new AbortController().signal,
    });
  for (const mode of ["no-receipt", "old-receipt", "reserved", "consumed", "unknown"])
    assert.equal(await run(mode), false);
  await assert.rejects(readFile(markerFile), /ENOENT/);
  const approved = await run("approved");
  assert.match(await readFile(markerFile, "utf8"), /^\d+$/);
  assert.equal(approved, true);
  assert.equal(await run("drift"), false);
  assert.equal(await run("owner-dies"), false);
  assert.equal(await run("connection-lost"), false);
  assert.equal(await run("empty-output"), false);
  assert.equal(await run("prisma-failed"), false);
  await rm(markerFile);
  const cancellation = new AbortController();
  const waiting = schemaAttempt({
    environment: { ...environment, GATE_TEST: "hang" },
    fingerprint: "0123456789abcdef",
    signal: cancellation.signal,
  });
  let pid;
  for (let index = 0; index < 100; index++) {
    try {
      pid = Number(await readFile(markerFile, "utf8"));
      break;
    } catch {
      await delay(10);
    }
  }
  assert.ok(pid, "Prisma subprocess started before cancellation");
  cancellation.abort();
  assert.equal(await waiting, false);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.equal(
    await schemaAttempt({
      environment: { ...environment, GATE_TEST: "hang" },
      fingerprint: "0123456789abcdef",
      signal: AbortSignal.timeout(100),
    }),
    false,
  );
});

test("follower cancellation after actual child exit emits no recycled PID/group signal", async (t) => {
  const numericSignals = [];
  t.mock.method(process, "kill", (...args) => numericSignals.push(args));
  const controller = new AbortController();
  const owner = startChild(
    process.execPath,
    ["-e", "process.exit(0)"],
    { env: fixtureEnvironment },
    controller.signal,
  );
  let lateChildSignals = 0;
  owner.child.once("exit", () => {
    t.mock.method(owner.child, "kill", () => lateChildSignals++);
    controller.abort();
    owner.stop();
  });
  owner.child.stdin.end();
  assert.equal(await owner.done, true);
  assert.deepEqual(numericSignals, []);
  assert.equal(lateChildSignals, 0);
  assert.equal(owner.isClosed(), true);
});

test("pre-cancelled follower starts neither lock session nor comparison", async () => {
  const signal = AbortSignal.abort();
  assert.throws(() => startChild("a-command-that-must-not-start", [], {}, signal), /before start/);
  assert.equal(await schemaAttempt({ environment: {}, fingerprint: "unused", signal }), false);
  assert.equal(await collectPrisma([], {}, signal), null);
});

test("canonical fingerprint preserves sorted raw bytes, empty trees, and shell consumers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "schema-fingerprint-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await schemaFingerprint(dir), "e3b0c44298fc1c14");
  await mkdir(join(dir, "nested"));
  await writeFile(join(dir, "z.prisma"), Buffer.from([0, 255, 10, 128]));
  await writeFile(join(dir, "A.prisma"), "first\n");
  await writeFile(join(dir, "é.prisma"), "unicode\n");
  await writeFile(join(dir, "nested", "space and\nnewline.prisma"), "nested\n");
  await writeFile(join(dir, ".hidden.prisma"), "hidden");
  await writeFile(join(dir, "not-schema.txt"), "excluded");
  await symlink(join(dir, "z.prisma"), join(dir, "linked.prisma"));
  await symlink(join(dir, "nested"), join(dir, "linked-dir"));
  const reference = await commandOutput(
    "bash",
    [
      "-c",
      'set -o pipefail; find "$1" -type f -name "*.prisma" -print0 | sort -z | xargs -0 cat | sha256sum | cut -c1-16',
      "fingerprint-reference",
      dir,
    ],
    { ...fixtureEnvironment, LC_ALL: "C" },
  );
  const fingerprint = await schemaFingerprint(dir);
  assert.equal(fingerprint, reference.trim());
  assert.equal(
    (
      await commandOutput("bash", [join(root, "scripts/schema-fingerprint.sh")], {
        ...fixtureEnvironment,
        PRISMA_SCHEMA_DIR: dir,
      })
    ).trim(),
    fingerprint,
  );
  await assert.rejects(schemaFingerprint(join(dir, "missing")), /ENOENT/);
});

async function prismaOwnerFixture(t, mode) {
  const dir = await mkdtemp(join(tmpdir(), "schema-diff-owner-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const engine = join(dir, "schema-engine-fixture");
  const cli = join(dir, "prisma.cjs");
  await writeFile(
    engine,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.OWNER_MARKER, String(process.pid));
if (process.env.OWNER_MODE === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdout.write('-- No schema changes\\n');
}
`,
    { mode: 0o755 },
  );
  await writeFile(
    cli,
    `const cp = require('node:child_process');
if (process.env.OWNER_MODE === 'missing-ack') process.kill(process.pid, 'SIGKILL');
else if (process.env.OWNER_MODE === 'unexpected') cp.spawn(process.execPath, ['-e', 'process.exit(0)']);
else {
  const child = cp.spawn(process.env.OWNER_ENGINE, [], {env: process.env, stdio: ['pipe','pipe','pipe']});
  child.stdout.pipe(process.stdout);
  if (process.env.OWNER_MODE === 'early-success') process.exit(0);
}
`,
  );
  return {
    ...fixtureEnvironment,
    PRISMA_BIN: cli,
    PRISMA_CWD: dir,
    OWNER_ENGINE: engine,
    OWNER_MARKER: join(dir, "started"),
    OWNER_MODE: mode,
  };
}

test("Prisma owner requires native drain; unsupported descendants and premature success refuse", async (t) => {
  for (const mode of ["normal", "unexpected", "early-success", "missing-ack"]) {
    const environment = await prismaOwnerFixture(t, mode);
    const result = collectPrisma(["migrate", "diff"], environment, new AbortController().signal);
    if (mode === "missing-ack")
      await assert.rejects(result, /could not verify comparison shutdown/);
    else assert.equal(await result, mode === "normal" ? "-- No schema changes\n" : null);
    if (mode === "unexpected") await assert.rejects(readFile(environment.OWNER_MARKER), /ENOENT/);
  }
});

test("cancelled Prisma wrapper waits for its ignoring-TERM native engine before returning", async (t) => {
  const environment = await prismaOwnerFixture(t, "hang");
  const cancel = new AbortController();
  const result = collectPrisma(["migrate", "diff"], environment, cancel.signal);
  let pid;
  for (let index = 0; index < 200; index++) {
    try {
      pid = Number(await readFile(environment.OWNER_MARKER, "utf8"));
      break;
    } catch {
      await delay(10);
    }
  }
  assert.ok(pid, "native engine started before cancellation");
  cancel.abort();
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await delay(100);
  assert.equal(settled, false, "wrapper must not return before native escalation/drain");
  assert.equal(await result, null);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("actual pinned Prisma CLI keeps its normal diff protocol under the owned-engine adapter", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "schema-real-prisma-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const schema = join(dir, "schema.prisma");
  const config = join(dir, "prisma.config.ts");
  await writeFile(
    schema,
    'datasource db {\n provider = "postgresql"\n}\nmodel Example {\n id String @id\n}\n',
  );
  await writeFile(
    config,
    `export default {schema: ${JSON.stringify(schema)}, datasource: {url: 'postgresql://fixture:fixture@127.0.0.1:1/fixture'}};\n`,
  );
  const args = [
    "migrate",
    "diff",
    "--from-empty",
    `--to-schema=${schema}`,
    "--script",
    `--config=${config}`,
  ];
  const environment = { ...fixtureEnvironment, PRISMA_CWD: dir, CHECKPOINT_DISABLE: "1" };
  const expected = await commandOutput(
    process.execPath,
    [resolve(root, "packages/db/node_modules/prisma/build/index.js"), ...args],
    environment,
  );
  assert.match(expected, /CREATE TABLE/);
  assert.equal(await collectPrisma(args, environment, new AbortController().signal), expected);
});
