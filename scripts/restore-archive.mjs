/** Restore only a validated pg_restore script, keeping all body/COPY bytes intact. */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { boundedChild } from "./lib/bounded-child.mjs";

// Only pg_restore's bounded, generated preamble is inspected. Never search or
// substitute the body: COPY rows can contain SQL-looking timeout statements.
export async function restorePrefix(path) {
  const file = await open(path, "r");
  const buffer = Buffer.alloc(65_536);
  let bytesRead;
  try {
    ({ bytesRead } = await file.read(buffer));
  } finally {
    await file.close();
  }
  const text = buffer.subarray(0, bytesRead).toString("utf8");
  const marker = /\n--\n-- (?:Name: |Data for Name: |PostgreSQL database dump complete)/.exec(text);
  if (!marker) throw new Error("Unsupported pg_restore preamble boundary.");
  const prefix = text.slice(0, marker.index + 1);
  const lines = prefix.split("\n");
  const settings = new Set();
  for (const line of lines) {
    if (!line || line.startsWith("--")) continue;
    if (/^\\restrict [A-Za-z0-9]+$/.test(line)) continue;
    if (line === "SELECT pg_catalog.set_config('search_path', '', false);") continue;
    const setting =
      /^SET (statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout) = 0;$/.exec(
        line,
      );
    if (setting) {
      settings.add(setting[1]);
      continue;
    }
    if (
      /^SET (?:client_encoding = 'UTF8'|standard_conforming_strings = on|check_function_bodies = false|xmloption = content|client_min_messages = warning|row_security = off|default_tablespace = ''|default_table_access_method = heap);$/.test(
        line,
      )
    )
      continue;
    throw new Error("Unsupported pg_restore preamble statement.");
  }
  if (settings.size !== 4) throw new Error("PostgreSQL 17 pg_restore timeout preamble required.");
  return { prefix, offset: Buffer.byteLength(prefix) };
}

export async function applyArchive(
  path,
  {
    env = process.env,
    signal,
    limits = ["5s", "60s", "1800s"],
    timeout = 1_810_000,
    psql = "psql",
  } = {},
) {
  const { prefix, offset } = await restorePrefix(path);
  if (limits.some((value) => !/^\d+(?:ms|s)$/.test(value)))
    throw new Error("Invalid restore limits.");
  const owner = boundedChild(
    psql,
    ["-X", "-q", "--single-transaction", "-v", "ON_ERROR_STOP=1", "--file=-"],
    {
      env: {
        ...env,
        PGCONNECT_TIMEOUT: "10",
        PGOPTIONS: "-c statement_timeout=60s -c lock_timeout=5s",
      },
      signal,
      timeout,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  const body = createReadStream(path, { start: offset });
  owner.child.stdin.on("error", () => owner.stop());
  body.on("error", () => owner.stop());
  // psql starts BEGIN before reading stdin. Override only generated resets,
  // before any archive object/data; the remainder is streamed byte-for-byte.
  owner.child.stdin.write(prefix);
  owner.child.stdin.write(
    `SET LOCAL lock_timeout = '${limits[0]}';\nSET LOCAL statement_timeout = '${limits[1]}';\nSET LOCAL transaction_timeout = '${limits[2]}';\nSET LOCAL idle_in_transaction_session_timeout = '60s';\n`,
  );
  body.pipe(owner.child.stdin);
  try {
    await owner.done;
  } finally {
    body.destroy();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(name, () => abort.abort());
  try {
    const [mode, path, output] = process.argv.slice(2);
    if (mode === "prepare" && output) {
      await boundedChild(
        "pg_restore",
        [
          "--no-owner",
          "--no-privileges",
          "--exclude-schema=starter_control",
          `--file=${output}`,
          path,
        ],
        { signal: abort.signal, timeout: 120_000 },
      ).done;
      await restorePrefix(output);
    } else if (mode === "apply" && path) await applyArchive(path, { signal: abort.signal });
    else throw new Error("Expected prepare or apply.");
  } catch {
    console.error(
      "FATAL: restore script validation/execution failed; inspect the destination with read-only queries before retrying.",
    );
    process.exitCode = 1;
  }
}
