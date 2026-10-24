import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { close, createReadStream, open, readFileSync } from "node:fs";
import { access, constants, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { text as readStreamText } from "node:stream/consumers";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";

const root = fileURLToPath(new URL("..", import.meta.url));
const backupScript = join(root, "scripts", "backup.sh");
const inertDatabaseUrl = ["post", "gresql://inert:", "inert@mock-db.example:5432/mock"].join("");
process.env.DATABASE_URL = inertDatabaseUrl;
const { MULTIPART_THRESHOLD_BYTES, uploadBackup } = await import("./upload-backup-to-s3.mjs");

const inertS3Config = {
  bucket: "inert-backup-bucket",
  region: "us-east-1",
  endpoint: undefined,
  forcePathStyle: false,
  credentials: { accessKeyId: "writer", secretAccessKey: "inert" },
  prefix: "database",
};

function fakeS3Client(send) {
  return {
    async send(command) {
      const body = command.input.Body;
      let bodyError;
      const onError = (error) => {
        bodyError = error;
      };
      body?.on("error", onError);
      let result;
      try {
        result = { value: await send(command) };
      } catch (error) {
        result = { error };
      } finally {
        if (body) {
          try {
            // SDK commands contain real ReadStreams. Wait for deferred open and
            // close even after fake failures; never drain the sparse 5 GB cases.
            if (!body.closed) {
              const closed = new Promise((resolve) => body.once("close", resolve));
              body.destroy();
              await closed;
            }
          } finally {
            body.off("error", onError);
          }
        }
      }
      if (bodyError) throw bodyError;
      if ("error" in result) throw result.error;
      return result.value;
    },
  };
}

test("fake S3 sends settle pending body opens and closes before fixture cleanup", async (t) => {
  for (const outcome of ["success", "provider failure", "open failure"]) {
    await t.test(outcome, { timeout: 5_000 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), "starter-backup-body-lifetime-"));
      const openStarted = Promise.withResolvers();
      const allowOpen = Promise.withResolvers();
      const closeStarted = Promise.withResolvers();
      const allowClose = Promise.withResolvers();
      const streamClosed = Promise.withResolvers();
      const events = [];
      let body;
      let result;
      try {
        const dump = join(directory, "backup.dump");
        await writeFile(dump, "small fixture");
        body = createReadStream(dump, {
          fs: {
            open(path, flags, mode, callback) {
              openStarted.resolve();
              void allowOpen.promise.then(() => {
                events.push("open");
                if (outcome === "open failure") callback(new Error("inert open failure"));
                else open(path, flags, mode, callback);
              });
            },
            close(fd, callback) {
              closeStarted.resolve();
              void allowClose.promise.then(() => {
                close(fd, (error) => {
                  events.push("fd closed");
                  callback(error);
                });
              });
            },
            read(_fd, _buffer, _offset, _length, _position, callback) {
              callback(new Error("the fake must close unread bodies without draining them"));
            },
          },
        });
        body.on("error", (error) => events.push(error.message));
        body.once("close", () => {
          events.push("stream closed");
          streamClosed.resolve();
        });
        const client = fakeS3Client(() => {
          if (outcome === "provider failure") throw new Error("inert provider failure");
          return { ETag: "fixture-etag" };
        });
        let settled = false;
        result = client.send({ input: { Body: body } }).then(
          (value) => {
            settled = true;
            return { value };
          },
          (error) => {
            settled = true;
            return { error };
          },
        );
        await openStarted.promise;
        // An event-loop checkpoint flushes ready callbacks; the explicit gates
        // keep open/close pending regardless of machine speed.
        await new Promise(setImmediate);
        assert.equal(settled, false, "fake send settled before its pending open");
        allowOpen.resolve();
        if (outcome !== "open failure") {
          await closeStarted.promise;
          await new Promise(setImmediate);
          assert.equal(settled, false, "fake send settled before its pending close");
          allowClose.resolve();
        }
        const response = await result;
        assert.equal(body.closed, true);
        assert.equal(body.bytesRead, 0);
        assert.equal(events.at(-1), "stream closed");
        if (outcome === "success") assert.equal(response.value.ETag, "fixture-etag");
        else assert.equal(response.error.message, `inert ${outcome}`);
        await rm(directory, { recursive: true, force: true });
        assert.deepEqual(events, [
          "open",
          outcome === "open failure" ? "inert open failure" : "fd closed",
          "stream closed",
        ]);
      } finally {
        // Also settle the deliberately gated stream when an assertion fails.
        allowOpen.resolve();
        allowClose.resolve();
        if (body) {
          body.destroy();
          await streamClosed.promise;
        }
        await result;
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

// Exercise the finite stage-owner directly with inert shell writers.  The
// production script's top-level preflight needs a database, but the ownership
// helper is self-contained and these probes never invoke a client or network.
const backupWriterSource = readFileSync(backupScript, "utf8");
const backupWriterFunctions = backupWriterSource.slice(
  backupWriterSource.indexOf('backup_writer_pid=""'),
  backupWriterSource.indexOf('\necho "Writing backup'),
);

function runBackupWriterProbe(body) {
  const result = spawnSync(
    "bash",
    [
      "-c",
      `source "$1"\n${backupWriterFunctions}\n${body}`,
      "backup-writer-probe",
      join(root, "scripts", "lib", "owned-child.sh"),
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(result.signal, null, `${result.stdout}${result.stderr}`);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

test("rejects a TERM delivered at the former check-to-start handoff without admitting a writer", () => {
  const output = runBackupWriterProbe(`
    fixture_writer() { printf writer-admitted; }
    set -T
    trap 'if [[ $BASH_COMMAND == backup_writer_starting=1 ]]; then trap - DEBUG; kill -TERM "$BASHPID"; fi' DEBUG
    if run_backup_writer fixture_writer; then status=0; else status=$?; fi
    printf ':status=%s' "$status"
  `);
  assert.match(output, /:status=143/);
  assert.doesNotMatch(output, /writer-admitted/);
});

test("uses application-owned retries so the installed SDK never replays a consumed stream", async () => {
  const client = new S3Client({ maxAttempts: 1 });
  assert.equal(await client.config.maxAttempts(), 1);
});

test("keeps the established conditional PUT path through the conservative 5 GB provider boundary", () => {
  assert.equal(MULTIPART_THRESHOLD_BYTES, 5_000_000_000);
});

async function executable(path, body) {
  await writeFile(path, body, { encoding: "utf8", mode: 0o755 });
  await access(path, constants.X_OK);
}

test("backup writer rejects a missing dump credential before dump or upload effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-backup-writer-"));
  try {
    const parsed = new URL(inertDatabaseUrl);
    assert.deepEqual(
      {
        protocol: parsed.protocol,
        username: parsed.username,
        password: parsed.password,
        hostname: parsed.hostname,
        port: parsed.port,
        pathname: parsed.pathname,
      },
      {
        protocol: "postgresql:",
        username: "inert",
        password: "inert",
        hostname: "mock-db.example",
        port: "5432",
        pathname: "/mock",
      },
    );
    // backup.sh performs a read-only version preflight before validating dump credentials.
    await executable(join(directory, "psql"), "#!/bin/sh\nprintf '170000\\n'\n");
    await executable(
      join(directory, "pg_dump"),
      "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'pg_dump (PostgreSQL) 17.0\\n'; exit 0; fi\nprintf 'pg_dump must not run\\n' >&2\nexit 70\n",
    );
    const env = {
      PATH: `${directory}:${dirname(process.execPath)}:/usr/bin:/bin`,
      DATABASE_URL: inertDatabaseUrl,
      BACKUP_DIR: join(directory, "backups"),
      BACKUP_S3_BUCKET: "inert-backup-bucket",
      BACKUP_S3_REGION: "us-east-1",
    };
    let output = "";
    let status = 0;
    try {
      execFileSync("bash", [backupScript], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      });
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        typeof error.status !== "number" ||
        error.signal
      ) {
        throw error;
      }
      status = error.status;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    assert.equal(status, 1, output);
    assert.match(output, /BACKUP_S3_ACCESS_KEY_ID \/ BACKUP_S3_SECRET_ACCESS_KEY are missing/);
    assert.doesNotMatch(output, /pg_dump must not run/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("large backup uses conditional multipart completion and records metadata only after success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-backup-multipart-"));
  try {
    const dump = join(directory, "backup.dump");
    await writeFile(dump, "123456789");
    const commands = [];
    const client = fakeS3Client(async (command) => {
      commands.push(command);
      if (command.constructor.name === "CreateMultipartUploadCommand")
        return { UploadId: "upload-1" };
      if (command.constructor.name === "UploadPartCommand") {
        return { ETag: `part-${command.input.PartNumber}` };
      }
      if (command.constructor.name === "CompleteMultipartUploadCommand")
        return { ETag: "complete-etag" };
      throw new Error(`unexpected command ${command.constructor.name}`);
    });

    const result = await uploadBackup({
      file: dump,
      config: inertS3Config,
      client,
      multipartThresholdBytes: 1,
      partSizeBytes: 4,
    });

    assert.equal(result.eTag, "complete-etag");
    assert.deepEqual(
      commands.map((command) => command.constructor.name),
      [
        "CreateMultipartUploadCommand",
        "UploadPartCommand",
        "UploadPartCommand",
        "UploadPartCommand",
        "CompleteMultipartUploadCommand",
      ],
    );
    const complete = commands.at(-1).input;
    assert.equal(complete.IfNoneMatch, "*");
    assert.deepEqual(complete.MultipartUpload.Parts, [
      { ETag: "part-1", PartNumber: 1 },
      { ETag: "part-2", PartNumber: 2 },
      { ETag: "part-3", PartNumber: 3 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses PUT exactly at 5 GB and multipart at the next byte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-backup-boundary-"));
  try {
    const dump = join(directory, "backup.dump");
    await writeFile(dump, "");
    const commandForSize = async (size) => {
      await truncate(dump, size);
      const commands = [];
      const client = fakeS3Client(async (command) => {
        commands.push(command);
        if (command.constructor.name === "PutObjectCommand") return { ETag: "put" };
        if (command.constructor.name === "CreateMultipartUploadCommand")
          return { UploadId: "boundary" };
        if (command.constructor.name === "UploadPartCommand") return { ETag: "part" };
        if (command.constructor.name === "CompleteMultipartUploadCommand")
          return { ETag: "complete" };
        throw new Error(`unexpected command ${command.constructor.name}`);
      });
      await uploadBackup({
        file: dump,
        config: inertS3Config,
        client,
        partSizeBytes: MULTIPART_THRESHOLD_BYTES,
      });
      for (const command of commands) {
        if (!command.input.Body) continue;
        assert.equal(command.input.Body.closed, true);
        assert.equal(command.input.Body.bytesRead, 0);
      }
      return commands[0].constructor.name;
    };
    assert.equal(await commandForSize(MULTIPART_THRESHOLD_BYTES), "PutObjectCommand");
    assert.equal(
      await commandForSize(MULTIPART_THRESHOLD_BYTES + 1),
      "CreateMultipartUploadCommand",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multipart failure aborts its owned upload and never returns immutable metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-backup-multipart-fail-"));
  try {
    const dump = join(directory, "backup.dump");
    await writeFile(dump, "123456789");
    const commands = [];
    const client = fakeS3Client(async (command) => {
      commands.push(command);
      if (command.constructor.name === "CreateMultipartUploadCommand")
        return { UploadId: "upload-2" };
      if (command.constructor.name === "UploadPartCommand") throw new Error("inert part failure");
      if (command.constructor.name === "AbortMultipartUploadCommand") return {};
      throw new Error(`unexpected command ${command.constructor.name}`);
    });

    await assert.rejects(
      uploadBackup({
        file: dump,
        config: inertS3Config,
        client,
        multipartThresholdBytes: 1,
        partSizeBytes: 4,
      }),
      /inert part failure/,
    );
    assert.deepEqual(
      commands.map((command) => command.constructor.name),
      [
        "CreateMultipartUploadCommand",
        "UploadPartCommand",
        "UploadPartCommand",
        "UploadPartCommand",
        "AbortMultipartUploadCommand",
      ],
    );
    assert.equal(commands.at(-1).input.UploadId, "upload-2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not blindly retry multipart initiation without an upload identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-backup-create-fail-"));
  try {
    const dump = join(directory, "backup.dump");
    await writeFile(dump, "123456789");
    const commands = [];
    const client = fakeS3Client(async (command) => {
      commands.push(command);
      throw new Error("inert lost create response");
    });
    await assert.rejects(
      uploadBackup({
        file: dump,
        config: inertS3Config,
        client,
        multipartThresholdBytes: 1,
        partSizeBytes: 4,
      }),
      /inert lost create response/,
    );
    assert.deepEqual(
      commands.map((command) => command.constructor.name),
      ["CreateMultipartUploadCommand"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries a small PUT with a fresh unread stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-backup-put-retry-"));
  try {
    const dump = join(directory, "backup.dump");
    await writeFile(dump, "retry-body");
    const commands = [];
    const client = fakeS3Client(async (command) => {
      commands.push(command);
      assert.equal(command.input.Body.bytesRead, 0);
      assert.equal(await readStreamText(command.input.Body), "retry-body");
      if (commands.length === 1) {
        throw new Error("inert transient PUT failure after body consumption");
      }
      return { ETag: "put-etag" };
    });
    await expectUploadBackup({ file: dump, config: inertS3Config, client });
    assert.equal(commands.length, 2);
    assert.notEqual(commands[0].input.Body, commands[1].input.Body);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries each multipart range with a fresh unread stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-backup-part-retry-"));
  try {
    const dump = join(directory, "backup.dump");
    await writeFile(dump, "123456789");
    const commands = [];
    let firstPart = true;
    const client = fakeS3Client(async (command) => {
      commands.push(command);
      if (command.constructor.name === "CreateMultipartUploadCommand")
        return { UploadId: "upload-retry" };
      if (command.constructor.name === "UploadPartCommand") {
        assert.equal(command.input.Body.bytesRead, 0);
        assert.equal(
          await readStreamText(command.input.Body),
          ["1234", "5678", "9"][command.input.PartNumber - 1],
        );
        if (firstPart) {
          firstPart = false;
          throw new Error("inert transient part failure after body consumption");
        }
        return { ETag: `part-${command.input.PartNumber}` };
      }
      if (command.constructor.name === "CompleteMultipartUploadCommand")
        return { ETag: "complete-etag" };
      throw new Error(`unexpected command ${command.constructor.name}`);
    });
    await expectUploadBackup({
      file: dump,
      config: inertS3Config,
      client,
      multipartThresholdBytes: 1,
      partSizeBytes: 4,
    });
    const attempts = commands.filter((command) => command.constructor.name === "UploadPartCommand");
    assert.equal(attempts.length, 4);
    assert.equal(attempts[0].input.PartNumber, 1);
    assert.equal(attempts[1].input.PartNumber, 1);
    assert.notEqual(attempts[0].input.Body, attempts[1].input.Body);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function expectUploadBackup(input) {
  const result = await uploadBackup(input);
  assert.ok(result.eTag);
  return result;
}
