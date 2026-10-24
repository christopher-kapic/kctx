import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { enumSchemas } from "../fixtures/schema-enum.mjs";
import { classifyDiff, hasStatements, normalizeDiff } from "./schema-diff.mjs";

test("PostgreSQL lexical forms cannot hide transaction control or control identifiers", () => {
  const refused = [
    String.raw`CREATE TABLE sample (value text DEFAULT E'a\'b'); COMMIT; CREATE TABLE outside_transaction (value text DEFAULT 'z');`,
    "CREATE TABLE example (value text DEFAULT 'x' /* outer /* inner */ ' */); COMMIT; CREATE TABLE second_example (value text DEFAULT 'z');",
    String.raw`ALTER TABLE U&"starter\005fcontrol"."destructive_operations" ADD COLUMN extra text;`,
    String.raw`CREATE TABLE example (value text DEFAULT 'a\'b'); COMMIT; CREATE TABLE second_example (value text DEFAULT 'z');`,
    "CREATE TABLE x (v text DEFAULT E'a'\n'b\\'c'); COMMIT; CREATE TABLE escaped (id int);",
    "CREATE TABLE x (v text DEFAULT $tag$COMMIT;$tag$);",
    String.raw`CREATE TABLE x (v text DEFAULT U&'d\0061t');`,
    `ALTER TABLE U&"starter!005fcontrol" UESCAPE '!' ADD COLUMN extra text;`,
    "CREATE TABLE x (id int);\\gexec",
    "CREATE TABLE x (id int);/* unfinished",
    "/* unterminated",
    "CREATE TABLE x (v text DEFAULT 'unfinished);",
    'CREATE TABLE "unfinished (id int);',
    "\0",
  ];
  for (const sql of refused) assert.equal(classifyDiff(sql), "unsupported", sql);
  for (const sql of ["/* unterminated", "'", '"', "$body$"])
    assert.throws(() => hasStatements(sql), undefined, sql);
});

test("installed Prisma enum rebuilds normalize exact executable SQL across CI and runtime", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "schema-enum-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = resolve(import.meta.dirname, "../..");
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
  assert.equal(raw.match(/^BEGIN;$/gm)?.length, 3);
  assert.match(raw, /TYPE "Status mapped_new"\[\] USING/);
  assert.match(raw, /CREATE TYPE "enum_fixture"\."Mode_new"/);
  assert.match(raw, /ADD COLUMN\s+"added"/);
  const normalized = normalizeDiff(raw);
  assert.equal(normalized, raw.replace(/^BEGIN;|^COMMIT;/gm, ""));
  assert.equal(normalizeDiff(normalized), normalized);
  assert.equal(classifyDiff(raw), "destructive");
  assert.equal(classifyDiff(normalized), "destructive");
  assert.equal(hasStatements(raw), true);
  for (const invalid of [
    raw.replace("BEGIN;", "BEGIN TRANSACTION;"),
    raw.replace("COMMIT;", "COMMIT AND CHAIN;"),
    raw.replace("COMMIT;", "END;"),
    raw.replace("COMMIT;", "ROLLBACK;"),
    raw.replace("COMMIT;", "COMMIT; COMMIT;"),
    raw.replace("BEGIN;", "BEGIN; BEGIN;"),
    raw.replace('RENAME TO "Mode_old"', 'RENAME TO "Different_old"'),
    raw.replace('"Mode_new" USING', '"Different_new" USING'),
    raw.replace("BEGIN;", "BEGIN; CREATE TABLE injected (id int);"),
    raw.replace('"EnumArticle"', '"starter_control"."EnumArticle"'),
  ])
    assert.equal(classifyDiff(invalid), "unsupported", invalid);
});

test("supported strings, quoted identifiers, nested comments and empty output stay usable", () => {
  const benign = [
    String.raw`CREATE TABLE "semi;""colon" ("v" text DEFAULT E'a\'b;COMMIT;');`,
    "CREATE TABLE x (v text DEFAULT E'a'\n'b\\'c');",
    String.raw`CREATE TABLE x (v text DEFAULT 'a\');`,
    "CREATE TABLE x (v text DEFAULT 'quote'';COMMIT;');",
    "/* outer /* inner */ still comment */ CREATE TABLE café (id int);",
    "CREATE TABLE x (v bit DEFAULT B'01', b bytea DEFAULT X'ff');",
  ];
  for (const sql of benign) assert.equal(classifyDiff(sql), "clean", sql);
  for (const sql of ["", " -- Empty migration.\n", "/* outer /* inner */ comment */ ;"])
    assert.equal(hasStatements(sql), false, sql);
  assert.equal(hasStatements("diagnostic output"), true);
});
