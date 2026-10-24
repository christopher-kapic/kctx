import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { restorePrefix } from "./restore-archive.mjs";

test("archive boundary accepts only generated preamble and preserves SQL-looking COPY bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "restore-prefix-"));
  try {
    const path = join(dir, "restore.sql");
    const prefix =
      "-- PostgreSQL database dump\n\nSET statement_timeout = 0;\nSET lock_timeout = 0;\nSET idle_in_transaction_session_timeout = 0;\nSET transaction_timeout = 0;\nSET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\nSELECT pg_catalog.set_config('search_path', '', false);\n";
    const body =
      "\n--\n-- Name: fixture; Type: TABLE; Schema: public; Owner: postgres\n--\nCREATE TABLE public.fixture (v text);\nCOPY public.fixture (v) FROM stdin;\nSET statement_timeout = 0;\n\\.\n";
    await writeFile(path, prefix + body);
    const result = await restorePrefix(path);
    assert.equal(result.prefix, prefix + "\n");
    const original = await readFile(path);
    assert.equal(original.subarray(result.offset).toString(), body.slice(1));
    for (const invalid of [
      prefix.replace("SET transaction_timeout = 0;", ""),
      `${prefix}COMMIT;\n`,
      prefix.replace("standard_conforming_strings = on", "standard_conforming_strings = off"),
    ]) {
      await writeFile(path, invalid + body);
      await assert.rejects(restorePrefix(path));
    }
    await writeFile(path, "--" + "x".repeat(70_000) + body);
    await assert.rejects(restorePrefix(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
