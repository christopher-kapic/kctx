/** Explicit operations smoke; owns disposable services and never loads the root .env. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { classifyDiff } from "./lib/schema-diff.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = fileURLToPath(import.meta.url);

async function runtimeCheck(mode) {
  assert.ok(["embedded", "external"].includes(mode));
  const [{ startWorkerRuntime }, queues, { default: prisma }, health, { serverVars }] =
    await Promise.all([
      import("../apps/worker/src/runtime.ts"),
      import("../packages/queue/src/index.ts"),
      import("../packages/db/src/index.ts"),
      import("../packages/queue/src/consumer-health.ts"),
      import("../packages/env/src/vars/server.ts"),
    ]);
  assert.equal(serverVars.WORKER_MODE.parse(undefined), "embedded");
  const inventory = Object.values(queues.QUEUE_NAMES);
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), false);
  // Adjacent-release regression against actual Redis Lua: the old inventory
  // stays live while the new server needs an additional queue. Its heartbeat
  // must never admit that server, even after the old worker republishes.
  const old = health.createConsumerHeartbeat(
    queues.redisConnection,
    "external",
    ["echo"],
    () => true,
  );
  await old.start();
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, ["echo"]), true);
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), false);
  const replacement = health.createConsumerHeartbeat(
    queues.redisConnection,
    "external",
    ["echo"],
    () => true,
  );
  await replacement.start();
  await old.stop();
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, ["echo"]), true);
  await replacement.stop();
  const expiringQueue = `heartbeat-expiry-${randomUUID()}`;
  const expiring = health.createConsumerHeartbeat(
    queues.redisConnection,
    "external",
    [expiringQueue],
    () => true,
  );
  await expiring.start();
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, [expiringQueue]), true);
  const expiryKey = `starter:consumers:external:${expiringQueue}`;
  const [replicaId] = await queues.redisConnection.zrange(expiryKey, 0, -1);
  assert.ok(replicaId);
  // Model a crashed publisher's expired score without waiting fifteen seconds.
  // The actual production read Lua must use Redis TIME and reject that score.
  await queues.redisConnection.zadd(expiryKey, 0, replicaId);
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, [expiringQueue]), false);
  await expiring.stop();
  const fatal = [];
  let runtime;
  try {
    runtime = await startWorkerRuntime({
      embedded: mode === "embedded",
      onFatal: (error) => fatal.push(error),
    });
    assert.equal(runtime.isReady(), true);
    assert.equal(
      await health.hasExternalConsumer(queues.redisConnection, inventory),
      mode === "external",
    );
    assert.equal(
      await health.hasExternalConsumer(queues.redisConnection, [
        ...inventory,
        "next-release-queue",
      ]),
      false,
    );
    const id = `runtime-${randomUUID()}`;
    const message = `disposable ${mode} echo`;
    const job = await queues.echoQueue.add("echo", { message }, { jobId: id });
    const deadline = Date.now() + 15_000;
    while ((await job.getState()) !== "completed" && Date.now() < deadline) await delay(50);
    assert.equal(await job.getState(), "completed");
    assert.deepEqual((await queues.echoQueue.getJob(id)).returnvalue, { echoed: message });
    assert.equal(
      (await prisma.appSetting.findUnique({ where: { key: "echo:last" } })).value,
      message,
    );
    const stopping = runtime.stop();
    assert.equal(runtime.isReady(), false);
    assert.equal(runtime.stop(), stopping);
    await stopping;
    assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), false);
    await assert.rejects(
      startWorkerRuntime({ embedded: mode === "embedded", onFatal: () => {} }),
      /already started/,
    );
    assert.deepEqual(fatal, []);
    console.log(`${mode}: schema-backed echo, readiness, withdrawal, drain, and re-entry passed.`);
  } finally {
    await runtime?.stop();
    await Promise.all(
      Object.values(queues)
        .filter((value) => value instanceof queues.Queue)
        .map((queue) => queue.close()),
    );
    queues.redisConnection.disconnect();
    await prisma.$disconnect();
  }
}

async function main() {
  if (process.argv[2] === "--runtime-child") {
    assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
    await runtimeCheck(process.argv[3]);
    return;
  }
  if (process.argv[2] !== "--disposable-services") {
    throw new Error("Use node scripts/test-runtime-operations.mjs --disposable-services.");
  }
  const environment = { PATH: process.env.PATH };
  const docker = (...args) =>
    execFileSync("docker", args, {
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  for (const image of ["postgres:17-alpine", "redis:7-alpine"]) {
    docker("image", "inspect", image, "--format", "{{.Id}}");
  }
  const temporary = mkdtempSync(resolve(tmpdir(), "template-runtime-operations-"));
  const containers = [];
  try {
    const password = randomUUID();
    const postgres = docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      `template-runtime-pg-${randomUUID()}`,
      "--memory",
      "256m",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,size=256m",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "postgres:17-alpine",
    );
    containers.push(postgres);
    const redis = docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      `template-runtime-redis-${randomUUID()}`,
      "--memory",
      "64m",
      "--publish",
      "127.0.0.1::6379",
      "redis:7-alpine",
      "redis-server",
      "--save",
      "",
      "--appendonly",
      "no",
      "--maxmemory",
      "32mb",
      "--maxmemory-policy",
      "noeviction",
    );
    containers.push(redis);
    const port = (id, mapping) => {
      const value = docker("port", id, mapping).split(":").at(-1);
      assert.match(value, /^\d+$/);
      return value;
    };
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port(postgres, "5432/tcp")}/postgres`;
    const redisUrl = `redis://127.0.0.1:${port(redis, "6379/tcp")}`;
    for (let attempt = 0; ; attempt++) {
      try {
        docker("exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "postgres");
        break;
      } catch {
        if (attempt === 49) throw new Error("Disposable PostgreSQL did not become ready.");
        await delay(100);
      }
    }
    // Copy the real Prisma config and schema away from root .env. Only installed
    // packages are linked; dotenv resolves a missing file inside this fixture.
    const prismaCwd = resolve(temporary, "packages/db");
    mkdirSync(prismaCwd, { recursive: true });
    cpSync(resolve(root, "packages/db/prisma.config.ts"), resolve(prismaCwd, "prisma.config.ts"));
    cpSync(resolve(root, "packages/db/prisma/schema"), resolve(prismaCwd, "prisma/schema"), {
      recursive: true,
    });
    symlinkSync(
      resolve(root, "packages/db/node_modules"),
      resolve(prismaCwd, "node_modules"),
      "dir",
    );
    const fixtureEnv = {
      ...environment,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      NODE_ENV: "production",
      BACKUP_ENABLED: "false",
      BACKUP_PRE_APPLY_ENABLED: "false",
      APPLY_SCHEMA: "safe",
      PRISMA_BIN: resolve(root, "packages/db/node_modules/.bin/prisma"),
      PRISMA_CWD: prismaCwd,
      PRISMA_SCHEMA_DIR: resolve(prismaCwd, "prisma/schema"),
    };
    for (const operation of ["empty database", "unchanged schema"]) {
      try {
        execFileSync("bash", [resolve(root, "scripts/db-applier.sh"), "apply"], {
          cwd: temporary,
          env: fixtureEnv,
          timeout: 180_000,
          stdio: "pipe",
        });
      } catch (error) {
        const plan = execFileSync(
          fixtureEnv.PRISMA_BIN,
          [
            "migrate",
            "diff",
            "--from-config-datasource",
            `--to-schema=${fixtureEnv.PRISMA_SCHEMA_DIR}`,
            "--script",
          ],
          {
            cwd: prismaCwd,
            env: fixtureEnv,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 120_000,
          },
        );
        for (const statement of plan.split(";")) {
          if (classifyDiff(statement) === "unsupported")
            console.error(`Unsupported generated DDL: ${statement.trim().slice(0, 500)}`);
        }
        throw error;
      }
      console.log(`Canonical apply with real Prisma: ${operation} passed.`);
    }
    for (const mode of ["embedded", "external"]) {
      const result = execFileSync(
        process.execPath,
        ["--import", "tsx", file, "--runtime-child", mode],
        {
          cwd: root,
          env: {
            ...fixtureEnv,
            APPLY_SCHEMA: "off",
            RUNTIME_OPERATIONS_CHILD: "owned-disposable-services",
          },
          timeout: 45_000,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        },
      );
      process.stdout.write(result);
    }
  } finally {
    const cleanupErrors = [];
    for (const id of containers.reverse()) {
      try {
        docker("stop", "--time", "2", id);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      console.error("Disposable fixture cleanup failed; inspect this run's owned containers.");
      process.exitCode = 1;
    } else {
      console.log("Removed only this smoke run's disposable containers and temporary fixture.");
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Runtime operations check failed.");
  process.exitCode = 1;
}
