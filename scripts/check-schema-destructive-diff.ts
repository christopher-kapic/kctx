/**
 * Schema-to-schema destructive-diff gate.
 *
 *   pnpm policy:schema-diff
 *
 * When a PR base SHA is available, checks out the base `packages/db/prisma/schema`
 * into a temp dir and runs `prisma migrate diff --from-schema <base> --to-schema
 * <head> --script`. Fails on DDL that destroys data — DROP COLUMN|DROP TABLE|
 * ALTER COLUMN … TYPE, and a DROP CONSTRAINT that is not re-added under the
 * same name — unless a valid `.github/expand-contract` waiver is present. There is
 * no environment-variable bypass: the dated, reasoned waiver file is the only
 * way through, because it is reviewable.
 *
 * Constraint-tightening DDL (SET NOT NULL, CREATE UNIQUE INDEX, ADD CONSTRAINT
 * … UNIQUE), and a DROP CONSTRAINT that the same diff re-adds under the same
 * name (how Prisma expresses an `onDelete` change), destroy nothing — they fail at
 * push time if existing rows violate them. That is a warning here, not a
 * failure: adding `@unique`, a required column, or `onDelete: Cascade` is
 * ordinary work, and a gate that denies ordinary work is a gate the developer
 * learns to bypass.
 *
 * The `.github/expand-contract` kill switch is not a magic empty file: it must
 * carry an `until: YYYY-MM-DD` line (at most 14 days out) and a `reason:` line,
 * or this check fails. An expired, undated, or unexplained waiver is a hard
 * failure on every run, not a silent skip — an escape hatch nobody has to
 * justify or remove is just a disabled gate. Documented in
 * patterns/schema-changes-recipe.md § Destructive patterns to watch for.
 *
 * Self-test (waiver parsing only): `pnpm policy:schema-diff --self-test`.
 *
 * Local runs independently compare the checked-out `HEAD` schema with both
 * the staged index snapshot and the worktree schema when Git history is
 * available. A source ZIP or initial repository has no durable comparison
 * baseline, so it reports that explicit limitation and exits 0; it never
 * treats an unavailable base as evidence of a clean diff.
 * CI continues to use its immutable PR base and fails CLOSED once that base is
 * expected. The only post-base skip is a genuinely new (absent-at-base) schema,
 * whose diff can only be additive.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { classifyDiff, normalizeDiff } from "./lib/schema-diff.mjs";

const ROOT = resolve(import.meta.dirname!, "..");
const SCHEMA_REL = "packages/db/prisma/schema";
const EXPAND_CONTRACT_FILE = resolve(ROOT, ".github/expand-contract");

function skip(reason: string): never {
  console.log(`schema-destructive-diff: skip — ${reason}`);
  process.exit(0);
}

// Fail CLOSED. Once a PR base is resolved we are committed to running the gate;
// a broken check (missing base tree, unusable Prisma CLI, flag drift) must not
// be indistinguishable from a clean diff, or destructive DDL sails through CI.
function fail(reason: string): never {
  console.error(`schema-destructive-diff: FAILED — ${reason}`);
  console.error(
    "This is a safety gate, not a linter — it fails closed. Fix the check (or the schema); do not skip it.",
  );
  process.exit(1);
}

// -- `.github/expand-contract` waiver ---------------------------------------

/** Longest a destructive-diff waiver may run before it must be renewed. */
const MAX_WAIVER_DAYS = 14;

type Waiver = { until: string; reason: string };

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Throws with an actionable message when the waiver file is not usable. */
function parseWaiver(text: string, today: Date): Waiver {
  const until = /^[\s#]*until:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(text)?.[1];
  const reason = /^[\s#]*reason:\s*(\S.*?)\s*$/m.exec(text)?.[1];
  if (!until || !reason) {
    throw new Error(
      ".github/expand-contract exists but is not a valid waiver. It must contain both an " +
        "`until: YYYY-MM-DD` line (at most 14 days out) and a `reason: <why this contract phase is intentional>` line.",
    );
  }
  const deadline = new Date(`${until}T00:00:00Z`);
  if (Number.isNaN(deadline.getTime())) {
    throw new Error(`.github/expand-contract has an unparseable \`until\` date "${until}".`);
  }
  const days = Math.round((deadline.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) {
    throw new Error(
      `.github/expand-contract expired ${-days} day(s) ago (until: ${until}). Delete the file — the contract phase it covered has shipped.`,
    );
  }
  if (days > MAX_WAIVER_DAYS) {
    throw new Error(
      `.github/expand-contract has \`until: ${until}\`, ${days} days out (max ${MAX_WAIVER_DAYS}). A waiver covers one contract-phase deploy, not a standing exemption.`,
    );
  }
  return { until, reason };
}

if (process.argv.includes("--self-test")) {
  const today = new Date(Date.UTC(2026, 0, 10));
  const cases: Array<[string, string, boolean]> = [
    ["valid waiver", "until: 2026-01-15\nreason: contract phase of the user.name rename\n", true],
    ["missing reason", "until: 2026-01-15\n", false],
    ["missing until", "reason: because\n", false],
    ["expired", "until: 2026-01-09\nreason: because\n", false],
    ["too far out", "until: 2026-03-01\nreason: because\n", false],
    ["empty file (the old kill switch)", "", false],
  ];
  for (const [label, text, shouldParse] of cases) {
    let parsed = true;
    try {
      parseWaiver(text, today);
    } catch {
      parsed = false;
    }
    if (parsed !== shouldParse) {
      console.error(`self-test FAILED: ${label} — expected ${shouldParse ? "accept" : "reject"}`);
      process.exit(1);
    }
    console.log(`ok: ${label} ${shouldParse ? "accepted" : "rejected"}`);
  }
  const commandErrorCases: Array<[string, CommandResult, boolean]> = [
    ["normal exit", { status: 0, stdout: "", stderr: "", error: null, signal: null }, false],
    ["spawn error", { status: null, stdout: "", stderr: "", error: "ENOENT", signal: null }, true],
    ["signal exit", { status: null, stdout: "", stderr: "", error: null, signal: "SIGTERM" }, true],
    ["missing status", { status: null, stdout: "", stderr: "", error: null, signal: null }, true],
  ];
  for (const [label, result, shouldFail] of commandErrorCases) {
    const failed = commandFailure("mock command", result) !== null;
    if (failed !== shouldFail) {
      console.error(`self-test FAILED: ${label} command result was misclassified`);
      process.exit(1);
    }
    console.log(`ok: ${label} command result ${shouldFail ? "fails closed" : "continues"}`);
  }
  // Classification: fatal vs. warn-only. A gate that fails on `@unique` or a
  // required column would be routed around within a week.
  const classifyCases: Array<[string, string, "destructive" | "risky" | "clean"]> = [
    ["drop column", 'ALTER TABLE "User" DROP COLUMN "name";', "destructive"],
    ["drop table", 'DROP TABLE "Session";', "destructive"], // destructive:audited — inert schema-diff fixture.
    ["drop constraint", 'ALTER TABLE "Post" DROP CONSTRAINT "Post_userId_fkey";', "destructive"],
    [
      "drop constraint re-added under the same name (an onDelete change)",
      'ALTER TABLE "Post" DROP CONSTRAINT "Post_userId_fkey";\n' +
        'ALTER TABLE "Post" ADD CONSTRAINT "Post_userId_fkey" FOREIGN KEY ("userId") ' +
        'REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      "risky",
    ],
    [
      "drop constraint with a differently named add on the same table",
      'ALTER TABLE "User" DROP CONSTRAINT "User_email_key";\n' +
        'ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") ' +
        'REFERENCES "Org"("id");',
      "destructive",
    ],
    [
      "drop constraint with the add on a different table",
      'ALTER TABLE "Post" DROP CONSTRAINT "Post_userId_fkey";\n' +
        'ALTER TABLE "Tag" ADD CONSTRAINT "Tag_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id");',
      "destructive",
    ],
    [
      "narrowed type",
      'ALTER TABLE "Post" ALTER COLUMN "title" SET DATA TYPE VARCHAR(50);',
      "destructive",
    ],
    ["set not null", 'ALTER TABLE "Post" ALTER COLUMN "slug" SET NOT NULL;', "risky"],
    ["unique index", 'CREATE UNIQUE INDEX "Post_slug_key" ON "Post"("slug");', "risky"],
    [
      "add unique constraint",
      'ALTER TABLE "Post" ADD CONSTRAINT "Post_slug_key" UNIQUE ("slug");',
      "risky",
    ],
    ["additive column", 'ALTER TABLE "Post" ADD COLUMN "subtitle" TEXT;', "clean"],
    ["new table", 'CREATE TABLE "Tag" ("id" TEXT NOT NULL);', "clean"],
  ];
  for (const [label, sql, expected] of classifyCases) {
    const actual = classifyDiff(sql);
    if (actual !== expected) {
      console.error(`self-test FAILED: ${label} — expected ${expected}, got ${actual}`);
      process.exit(1);
    }
    console.log(`ok: ${label} classified ${expected}`);
  }

  console.log("schema-destructive-diff self-test passed.");
  process.exit(0);
}

let waiver: Waiver | null = null;
if (existsSync(EXPAND_CONTRACT_FILE)) {
  try {
    waiver = parseWaiver(readFileSync(EXPAND_CONTRACT_FILE, "utf8"), todayUtc());
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  signal: string | null;
};

function git(args: string[], opts?: { cwd?: string }): CommandResult {
  const result = spawnSync("git", args, {
    cwd: opts?.cwd ?? ROOT,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null,
    signal: result.signal ?? null,
  };
}

function commandFailure(label: string, result: CommandResult): string | null {
  if (result.error) return `${label} could not start: ${result.error}`;
  if (result.signal) return `${label} was terminated by signal ${result.signal}`;
  if (result.status === null) return `${label} returned no exit status`;
  return null;
}

type BaseResolution = { sha: string; source: "pr" | "local-head" } | { error: string } | null;

function resolveBaseSha(): BaseResolution {
  if (process.env.PR_BASE_SHA) {
    if (/^[0-9a-f]{7,40}$/i.test(process.env.PR_BASE_SHA)) {
      return { sha: process.env.PR_BASE_SHA, source: "pr" };
    }
    return null;
  }
  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef) {
    const candidates = [`origin/${baseRef}`, baseRef];
    for (const ref of candidates) {
      const probed = git(["rev-parse", "--verify", ref]);
      const failure = commandFailure(`git rev-parse ${ref}`, probed);
      if (failure) return { error: failure };
      if (probed.status === 0) return { sha: probed.stdout.trim(), source: "pr" };
    }
    return null;
  }
  const localHead = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  const failure = commandFailure("git rev-parse HEAD", localHead);
  if (failure) return { error: failure };
  if (localHead.status === 0 && /^[0-9a-f]{40}$/i.test(localHead.stdout.trim())) {
    return { sha: localHead.stdout.trim(), source: "local-head" };
  }
  return null;
}

const base = resolveBaseSha();
const ciExpectsBase = Boolean(process.env.PR_BASE_SHA || process.env.GITHUB_BASE_REF);
if (base && "error" in base) fail(base.error);
if (!base) {
  if (ciExpectsBase) {
    fail(
      `PR base unresolved (GITHUB_BASE_REF=${process.env.GITHUB_BASE_REF ?? "unset"}). Checkout with fetch-depth: 0 and ensure origin/${process.env.GITHUB_BASE_REF ?? "<base>"} exists.`,
    );
  }
  skip(
    "no PR base and no local HEAD commit (fresh source ZIP or initial repository — no comparison baseline).",
  );
}
const baseSha = base.sha;
if (base.source === "local-head") {
  console.log(
    "schema-destructive-diff: local HEAD baseline — checking staged snapshot and worktree schema changes independently.",
  );
}

const listing = git(["ls-tree", "-r", "--name-only", baseSha, SCHEMA_REL]);
const listingFailure = commandFailure(`git ls-tree ${SCHEMA_REL} at ${baseSha}`, listing);
if (listingFailure) fail(listingFailure);
if (listing.status !== 0) {
  // git errored (not just "path absent") — the base tree should be readable at
  // this point, so this is a broken check, not a clean diff.
  fail(`git ls-tree ${SCHEMA_REL} at ${baseSha} errored: ${listing.stderr.trim() || "unknown"}`);
}
if (listing.stdout.trim() === "") {
  // Path genuinely absent at the base: the schema is new in this PR, so the diff
  // can only be additive (CREATE) — nothing destructive is possible. Safe to skip.
  skip(`${SCHEMA_REL} does not exist at base ${baseSha} (new schema — additive only).`);
}

const temp = mkdtempSync(join(tmpdir(), "schema-diff-"));
const fromSchema = join(temp, SCHEMA_REL);
try {
  mkdirSync(fromSchema, { recursive: true });

  for (const rel of listing.stdout.trim().split("\n").filter(Boolean)) {
    const shown = git(["show", `${baseSha}:${rel}`]);
    const showFailure = commandFailure(`git show ${baseSha}:${rel}`, shown);
    if (showFailure) fail(showFailure);
    if (shown.status !== 0) fail(`git show ${baseSha}:${rel} failed: ${shown.stderr.trim()}`);
    const dest = join(temp, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, shown.stdout);
  }

  // A worktree can reverse a staged destructive edit. Recreate stage 0 into a
  // separate schema directory so both states are independently compared to
  // the immutable base rather than treating the worktree as a proxy for index.
  const indexListing = git(["ls-files", "--stage", "--", SCHEMA_REL]);
  const indexFailure = commandFailure(`git ls-files --stage ${SCHEMA_REL}`, indexListing);
  if (indexFailure) fail(indexFailure);
  if (indexListing.status !== 0) {
    fail(`git ls-files --stage ${SCHEMA_REL} failed: ${indexListing.stderr.trim() || "unknown"}`);
  }
  const indexFiles = indexListing.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((entry) => {
      const [metadata, rel] = entry.split("\t", 2);
      const stage = metadata?.trim().split(/\s+/).at(-1);
      if (!rel || stage !== "0") {
        fail(`schema index has an unresolved path or merge stage: ${entry}`);
      }
      return rel;
    });
  if (indexFiles.length === 0) {
    fail(`staged index has no ${SCHEMA_REL} files; cannot safely compare a schema removal.`);
  }
  const indexSchema = join(temp, "index-schema");
  mkdirSync(indexSchema, { recursive: true });
  for (const rel of indexFiles) {
    const shown = git(["show", `:${rel}`]);
    const showFailure = commandFailure(`git show :${rel}`, shown);
    if (showFailure) fail(showFailure);
    if (shown.status !== 0) fail(`git show :${rel} failed: ${shown.stderr.trim()}`);
    const relative = rel.slice(`${SCHEMA_REL}/`.length);
    if (!relative || relative.startsWith("../")) fail(`invalid staged schema path: ${rel}`);
    const dest = join(indexSchema, relative);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, shown.stdout);
  }

  function diffSchema(label: string, toSchema: string): "destructive" | "risky" | "clean" {
    const prisma = spawnSync(
      "pnpm",
      [
        "--filter",
        "@starter/db",
        "exec",
        "prisma",
        "migrate",
        "diff",
        "--from-schema",
        fromSchema,
        "--to-schema",
        toSchema,
        "--script",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    const output = prisma.stdout ?? "";
    const diagnostic = prisma.stderr ?? "";
    const prismaFailure = prisma.error?.message
      ? `prisma migrate diff (${label}) could not start: ${prisma.error.message}`
      : prisma.signal
        ? `prisma migrate diff (${label}) was terminated by signal ${prisma.signal}`
        : prisma.status === null
          ? `prisma migrate diff (${label}) returned no exit status`
          : null;
    if (prismaFailure) fail(prismaFailure);
    if (prisma.status !== 0) {
      // `migrate diff --from-schema --to-schema --script` is fully offline
      // (no DB), so a nonzero exit is a broken gate, never a clean diff.
      fail(
        `prisma migrate diff (${label}) exited ${prisma.status} (unusable CLI or flag drift). ${diagnostic.trim().slice(0, 400)}`,
      );
    }
    if (!output.trim())
      fail(`prisma migrate diff (${label}) returned no SQL or empty-diff marker.`);
    let executable: string;
    try {
      executable = normalizeDiff(output);
    } catch {
      fail("schema plan contains an unsupported Prisma transaction wrapper or lexical form.");
    }
    console.log(`---- prisma migrate diff (base schema → ${label} schema; executable SQL) ----`);
    if (diagnostic.trim()) console.error(diagnostic.trimEnd());
    console.log(executable.trimEnd());
    console.log("---- end diff ----");
    const classification = classifyDiff(executable);
    if (classification === "unsupported")
      fail(
        "schema plan contains unsupported SQL or cannot run as one transaction; review the shared classifier before deployment.",
      );
    return classification;
  }

  const verdicts = [
    diffSchema("staged index", indexSchema),
    diffSchema("worktree", resolve(ROOT, SCHEMA_REL)),
  ];

  if (verdicts.includes("risky")) {
    console.warn("");
    console.warn(
      "WARNING: the schema diff tightens or replaces a constraint (SET NOT NULL / CREATE UNIQUE INDEX / ADD CONSTRAINT … UNIQUE, or a DROP CONSTRAINT re-added under the same name).",
    );
    console.warn(
      "Nothing is deleted, but the push FAILS if existing rows already violate it — backfill the column, or de-duplicate the values, before deploying. See patterns/schema-changes-recipe.md § Destructive patterns to watch for.",
    );
    console.warn("");
  }

  if (!verdicts.includes("destructive")) {
    process.exit(0);
  }

  if (waiver) {
    console.log(
      `Destructive DDL present, but .github/expand-contract is a live waiver (until: ${waiver.until}) — allowing.`,
    );
    console.log(`  reason: ${waiver.reason}`);
    process.exit(0);
  }

  console.error("");
  console.error(
    "POLICY VIOLATION: schema diff contains destructive DDL (DROP COLUMN / DROP TABLE / ALTER COLUMN … TYPE, or a DROP CONSTRAINT with no ADD CONSTRAINT of the same name). This deletes data — or referential integrity — that already exists.", // destructive:audited — error text, not executable SQL.
  );
  console.error(
    "Nearly always the right fix is to split the change — use the expand-contract recipe (patterns/schema-changes-recipe.md).",
  );
  console.error(
    "When this PR genuinely IS the contract phase, commit a `.github/expand-contract` file containing an `until: YYYY-MM-DD` line (at most 14 days out) and a `reason: <why>` line. That waiver is reviewable and expires; there is no environment-variable bypass.",
  );
  process.exit(1);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
