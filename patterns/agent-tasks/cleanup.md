# Agent task: cleanup

Periodic hygiene pass. Handed to an agent verbatim ("run the cleanup task"), safe on any schedule — weekly cron, pre-release gate, post-merge check, or one-shot by request.

## Goal

Find and (when explicitly authorized) resolve accumulating cruft across four surfaces:

1. **Code** — dead exports, orphan files, stale TODOs, generated artifacts in tracked dirs
2. **Database schema** — naming drift, missing indexes, dead models, soft-delete inconsistency
3. **S3 / asset storage** — orphan rows, unreferenced objects, leaked multipart uploads, **race conditions on every new write path**
4. **BullMQ queues** — backed-up failures, stale or duplicate Job Schedulers, missing job retention config

**Read-only by default.** It surfaces findings as a punch list. The user decides what to apply; most fixes go through a separate dedicated pattern (e.g. [schema-changes-recipe.md](../schema-changes-recipe.md) for schema edits).

## What this task does NOT do

- Run destructive Prisma commands — see [AGENTS.md § Dangerous Commands — Never Run These](../../AGENTS.md). The full ban list applies even in template-dev mode unless the user explicitly authorizes a destructive local-only operation.
- Touch a production database (even read-only). The audit runs against the **local** dev DB only.
- Delete S3 objects directly. The only authorized deletion path is the existing BullMQ cleanup job (`cleanup-assets`), which carries the tested grace-period model. The cleanup task *audits* those jobs but never replaces them.
- Auto-commit, push, or open PRs. Surface findings; let the user act.

## Inputs the agent should already have

- Working tree at the repo root.
- A running local Postgres (`pnpm dev:services` — the dev stack) if Step 2 is to inspect orphan-row counts. Skip Step 2's DB-introspection sub-steps if no DB is reachable.
- `pnpm doctor:react`, `pnpm lint`, `pnpm check-types` available.
- **Does not need**: prod credentials, S3 access, Redis access. The audit reads code, not data.

## Two operating modes

| Mode | When | Constraints |
|---|---|---|
| **Template-dev** | Working on this starter repo itself, no prod deploy exists | Relaxed: it is OK to propose schema edits that would normally require expand-contract, since there's no prod DB to break. Still no `prisma migrate reset` / `--force-reset` / raw `DROP`. |
| **Production** | A clone of this template that has a live prod DB | Hard rules: every schema change goes through the expand-contract pattern in [schema-changes-recipe.md](../schema-changes-recipe.md). Renames and drops are multi-deploy. The cleanup task never proposes a single-deploy rename or drop. |

Detect mode by asking the user, or by reading the `DATABASE_URL` shape (a `localhost` / `127.0.0.1` / `host.docker.internal` host is template-dev; anything else is production unless the user overrides).

When in doubt, assume production. Erring conservative is free; erring permissive costs data.

---

## Step 1 — Code-level dead-stuff sweep

Find and report:

1. **Unused exports and files** — `pnpm doctor:react` covers React-surface dead code; for the rest, run a fresh `knip` pass and read the output. False positives are normal (entry points, build hooks). Each finding gets either a "fix" proposal (delete) or a `knip.jsonc` ignore entry with a reason.

2. **Stale TODOs / FIXMEs** — `rg -n 'TODO|FIXME|XXX|HACK' apps packages scripts`. For each, check git blame: if the author has shipped a PR referencing it, the TODO is likely stale. Surface, don't auto-remove.

3. **Generated files committed to git** — anything matching `**/dist/`, `**/.turbo/`, `**/build/`, `**/.vite/`, `**/.next/` that's tracked by `git ls-files`. (`git ls-files | rg 'dist/|\.turbo/|build/'`.) Same for `*.log`, `*.tmp`, `*.pid`. Propose `git rm` + `.gitignore` entry.

4. **`.bak` / `.old` / `.orig` files** — banned per [AGENTS.md § Agent Safety Rules](../../AGENTS.md). `rg --files | rg '\.(bak|old|orig|backup)$'`. Every match is a hard finding — delete and commit.

5. **Stale audit / handoff markdown** — `audit-*.md`, `flagged-*.md`, `handoff-*.md`, `cleanup-audit-*.md` at the repo root older than 30 days. These are transient by design (the cleanup task itself writes `cleanup-audit-<YYYY-MM-DD>.md` in step 6 below; [project-audit.md](../project-audit.md) similarly produces ad-hoc audit files). Surface for deletion.

6. **Empty directories** — `find apps packages -type d -empty`. Usually safe to delete; sometimes load-bearing for build configs. Verify before proposing.

---

## Step 2 — Schema-rule audit

Read [schema-guidelines.md](../schema-guidelines.md) once at the start of this step. It is the canonical reference.

For every `.prisma` file in `packages/db/prisma/schema/`, verify:

### Static checks (no DB needed)

- **Naming**: singular PascalCase models, camelCase fields, `SHOUTY_SNAKE_CASE` enum values, `isFoo`/`hasFoo`/`canFoo` for booleans.
- **Timestamps**: every model has `createdAt: DateTime @default(now())` and `updatedAt: DateTime @updatedAt`. Carve-outs (e.g. Better-Auth tables) are documented in the per-model notes.
- **Indexes**: every column that appears in a `where` clause in `packages/api/src/routers/**` or `apps/worker/src/**` has an `@@index([col])` or is already covered by `@unique` / `@@unique`. Find query paths by grepping `prisma.<model>.findMany|findFirst|count|updateMany|deleteMany` and reading the `where`.
- **Foreign keys**: every relation column has an index (Postgres + Prisma do not auto-add these).
- **Cascade behavior**: every relation has an explicit `onDelete` (not the implicit Prisma default). Cascade vs SetNull vs Restrict matches the lifecycle.
- **Soft-delete consistency**: if a model has `deletedAt` / `archivedAt` / `status: ARCHIVED`, every read path filters it out. Hard-deletes happen only in clearly justified paths (cleanup jobs, GDPR erasure, cascade from parent).
- **Template purity**: no model name suggests a specific project domain (`Customer`, `Invoice`, `Subscription` ≠ generic primitives). Flag for removal or generalization.

### DB-introspection checks (require local Postgres reachable)

Run via `pnpm db:studio` or `psql` against `$DATABASE_URL`. These produce data the static read can't:

- `pg_stat_user_indexes` → indexes with zero scans since DB startup (candidate for removal, but only if observed over multiple runs).
- `pg_stat_user_tables` → tables with high `n_dead_tup` (vacuum lag, not a cleanup-task fix but worth surfacing).
- Orphan-row counts: for every model that has a parent FK, count rows whose parent is gone. Most should be zero by design (the schema enforces FK); a non-zero count means a manual `DELETE` somewhere bypassed cascades.

### What to propose

**Template-dev mode**: it is OK to propose any change — add index, rename column, drop column, change type. Mention the local command (`pnpm db:push` or `pnpm db:push:dangerous`) but do not run it yourself.

**Production mode**: only **additive** changes are safe single-deploy. Anything that touches an existing column (rename, drop, type change) must be proposed as a multi-deploy expand-contract sequence per [schema-changes-recipe.md](../schema-changes-recipe.md). The cleanup task never proposes a single-deploy destructive change in production mode.

The banned commands in [AGENTS.md § Dangerous Commands — Never Run These](../../AGENTS.md) (`prisma migrate reset`, `db push --force-reset`, raw `DROP TABLE`, etc.) are off-limits in both modes.

---

## Step 3 — S3 / asset race-condition audit

The heart of the cleanup task. The existing `cleanup-assets` BullMQ job (see
[patterns/assets.md § Cleanup](../assets.md)) covers three tested
storage-cleanup boundaries:

1. **Orphan PENDING rows** with `uploadHeartbeatAt` older than 5 min — the upload client died or stalled.
2. **Unreferenced S3 objects** under `assets/` older than the grace period (15 min) — the row was deleted but the object wasn't.
3. **Incomplete multipart uploads** older than 24 h — abort only when no exact
   `PENDING` source owner has a fresh heartbeat. A long upload can legitimately
   cross the age threshold; owner-read ambiguity preserves it for the next run.

Age thresholds and owner heartbeats work together to prevent reaping in-flight
work. A cleanup job that relies on elapsed upload duration alone will silently
destroy user data on slow connections.

### Audit every code path that writes to S3

Grep for:

```bash
rg -n 'putObject|createMultipartUpload|uploadPart|getSignedUrl|completeMultipartUpload|abortMultipartUpload' packages apps
```

For every call site outside the lib modules (`packages/api/src/lib/assets.ts`, `packages/api/src/lib/asset-cleanup.ts`, `packages/api/src/lib/storage.ts`, and the worker handlers), verify:

#### Heartbeat invariant

- **Is there a DB row** representing the in-progress upload? (Asset, or a new model.)
- Does the row have an `uploadHeartbeatAt` (or equivalent) column that the client bumps every 60 s?
- Does the cleanup job check the heartbeat before reaping? An object whose row's heartbeat was bumped 30 s ago is still in-flight; deleting it eats user data.

If a new code path uploads to S3 but has no DB row, **that is the finding** — surface it. The model is: every byte in S3 must be discoverable from the DB or it is an orphan.

#### Grace period invariant

- A live upload is protected by its fresh row heartbeat, so the object grace
  period does not need to exceed the longest realistic upload duration. Verify
  that the client keeps heartbeating throughout slow uploads and that cleanup
  checks the exact source pointer before destructive work.
- The object grace period must exceed storage-before-row/finalization gaps and
  other expected write windows.
- Multipart upload completion is not atomic — between the last `uploadPart` and `completeMultipartUpload`, the row is finalized but the object isn't. The grace period covers that gap. Verify no new code path skips finalization.

#### Multipart abort invariant

- **Every error path** (client disconnect, finalize failure, validation rejection) must call `abortMultipartUpload`. Without it, S3 retains the parts and charges for them — and the cleanup job's 24-hour incomplete-multipart sweep is the only thing reclaiming them.
- Before aborting an aged multipart used by the app, re-read its parsed owner:
  preserve only an exact `PENDING` source-key match with a fresh heartbeat, and
  fail closed on read errors. Count an abort only after storage confirms it;
  report failures separately.
- Verify the upload-client wrapper in `packages/api/src/lib/asset-client.ts` calls abort on every failure branch.

#### TTL invariant

- Presigned PUT URLs: TTL ≤ 5 min.
- Presigned GET URLs: TTL ≤ 24 h (these are bearer tokens; see [AGENTS.md § Agent Safety Rules](../../AGENTS.md) on asset URLs).
- Never indefinite, never larger than the heartbeat grace period.

#### Concurrent-delete invariant

- The cleanup job lists S3, then for every key not in the DB, deletes after the grace period. A user could re-upload to the same key inside that window if the keying scheme isn't unique.
- Verify keying is content-addressed or includes a UUID; verify the cleanup job doesn't delete keys that were created (per S3 `LastModified`) after the listing started.

#### Permission invariant

- Every `deleteObject` call must be gated behind ownership or admin check, OR be reachable only from the cleanup job (which derives authority from "the DB doesn't reference this").
- Surface any new code path that calls `deleteObject` without an explicit authorization check.

### Red flags to surface

- A new model with an S3-uploaded asset field but no `uploadHeartbeatAt` column.
- A new upload flow that calls `putObject` directly without a `PENDING` → finalize transition.
- A cleanup job whose grace period was shortened "to speed things up."
- A `listObjectsV2` + unconditional `deleteObject` pattern that doesn't cross-check the DB.
- Any code path that constructs an S3 key from user input without UUID prefixing or content-addressing.

If you find any of these, **stop and report** — do not propose a fix without the user's input. The race-condition surface is the most expensive class of bug to recover from once data is destroyed.

---

## Step 4 — BullMQ queue health

For each queue defined in `packages/queue/`:

- **Job retention**: `removeOnComplete` and `removeOnFail` are set. Without them, completed jobs accumulate in Redis indefinitely. Surface any queue missing this.
- **Job Scheduler inventory**: compare each entry's `key` from
  `queue.getJobSchedulers()` with every `*_JOB_SCHEDULER_ID` registered in
  `apps/worker/src/runtime.ts`. (`JobSchedulerJson.id` is optional job-template
  metadata, not the scheduler identifier.) Surface unknown
  IDs, missing expected IDs, or multiple schedulers that dispatch the same job
  name. Stable IDs make `upsertJobScheduler` safe across option changes and
  worker replicas; duplicates indicate an abandoned ID or an out-of-band
  registration and must be removed explicitly with
  `queue.removeJobScheduler(exactSchedulerId)`.
- **Dead-letter inspection**: if a queue has a dead-letter setup, check that jobs aren't piling up there. Surface any queue with > 10 dead-lettered jobs.
- **Worker recovery**: workers should reconnect cleanly after Redis restart. Verify `BullMQ` connection options include retry, and that the worker handler is idempotent for the retry case.
- **Concurrency limits**: `Worker(... { concurrency: N })` — N must match what the handler can actually parallelize. Handlers doing native work outside the V8 heap — `analyze-asset` decodes images with sharp — should not run with high concurrency on a small VM.

---

## Step 5 — Documentation drift

- **`sitemap.md`** — diff against the route files in `apps/web/src/routes/`. List routes that exist on disk but aren't in the sitemap, and vice versa.
- **`MEMORY.md`** (under `~/.claude/projects/.../memory/`, not in the repo) — out of scope for this task; user memory is the user's domain.
- **Pattern doc cross-links** — `rg -o '\[.*?\]\((\.\./)?\K[a-z-]+\.md' patterns/` then check each target exists. Broken references are findings.
- **AGENTS.md vs pattern docs** — AGENTS.md scopes "the pattern doc wins" to **recipe details** only; its § STOP, § Dangerous Commands, and § Agent Safety Rules override every pattern doc. Spot-check three randomly-picked rules in AGENTS.md against their referenced pattern doc; surface drift — and flag any pattern doc that reads as granting an exception to those three sections, which is a bug in the pattern doc.
- **`patterns/README.md`** Quick-picks table — diff against the actual files in `patterns/`. Missing entries or links to files that have been renamed are findings.

---

## Step 6 — Report

Write a single markdown file at the repo root: `cleanup-audit-<YYYY-MM-DD>.md`. Structure:

```markdown
# Cleanup audit — <date>

Mode: <template-dev | production>
Findings: <N total> (<H high> / <M medium> / <L low>)

## High-priority
1. ...
2. ...

## Medium-priority
...

## Low-priority / noted-for-awareness
...

## Per-surface

### Code
- ...

### Schema
- ...

### S3 / asset storage
- ...

### Queues
- ...

### Documentation
- ...

## Proposed action plan
Ordered list. Each item references a finding above, names the files involved, and says which pattern doc the fix should follow.
```

Cap at ~2000 words. Bullets > paragraphs.

The user reads this file, decides what to apply, then either:
- Hands the report to a follow-up agent with specific items to fix, or
- Applies fixes themselves, or
- Rejects items.

After the user has acted, delete the report — it's transient by design.

---

## Hard rules

- **READ-ONLY by default.** Every cleanup proposal goes through the user. The exception is Step 1's clearly-mechanical fixes (`.bak` files, generated artifacts tracked by git) — those are pre-authorized in AGENTS.md and can be deleted in the same pass that surfaces them, but in a separate commit so the user can revert cleanly.
- **No destructive Prisma commands ever.** The list in [AGENTS.md § Dangerous Commands — Never Run These](../../AGENTS.md) is binding in both template-dev and production mode.
- **No S3 deletions outside the existing BullMQ cleanup jobs.** If the audit identifies orphan objects, it surfaces them for the existing cleanup job to handle on its next run. The cleanup task never runs `deleteObject` itself.
- **Never propose shortening a grace period.** Grace periods exist to prevent data loss. The only legitimate reason to change one is when upload-size limits change — and that's a deliberate decision, not a cleanup fix.
- **Never propose a single-deploy rename or drop in production mode.** Use expand-contract per [schema-changes-recipe.md](../schema-changes-recipe.md).
- **No `git commit --no-verify`.** If pre-commit hooks fail on a cleanup commit, fix the root cause.

## Scheduling

Designed to run periodically. Suggested cadences:

- **Weekly** as a hygiene cron via `/loop 7d` or a routine. Findings accumulate slowly; a weekly read keeps the punch list short.
- **Pre-release** as a gate before cutting a tag. A clean cleanup-audit before release means no surprises in the deploy.
- **After a major refactor** that touched many surfaces.
- **On user request** — `/cleanup` or "run the cleanup task".

If running on a schedule, gate the run on whether `cleanup-audit-*.md` already exists from a previous run — don't overwrite without checking that the user has acted on the previous report.

## Anti-patterns

- **Don't** auto-apply schema edits "because they look safe." Index additions feel additive, but `CREATE INDEX` on a large table takes locks; user decides when to run it.
- **Don't** combine the cleanup task with [update-dependencies.md](./update-dependencies.md) — they are separate change sets with different review needs.
- **Don't** delete S3 objects the cleanup audit finds, even ones older than the grace period. The BullMQ cleanup job is the authority.
- **Don't** sweep `node_modules` or `.pnpm-store` — pnpm manages those; manual cleanup defeats the cache.
- **Don't** rewrite the `cleanup-assets` BullMQ job to "be more aggressive." Its grace periods are tuned to the worst-case upload duration; tightening them silently destroys user data.

## See also

- [project-audit.md](../project-audit.md) — end-to-end health audit (CI + structure + rules). Cleanup task is a *narrower*, *more S3-aware* sibling; project audit fixes failing CI, cleanup audit finds accumulating cruft and race surfaces.
- [schema-changes-recipe.md](../schema-changes-recipe.md) — the only authorized way to change an existing column in production mode.
- [assets.md](../assets.md) — cleanup model for assets, including alternative strategies (sendBeacon, S3 lifecycle rules, event-driven).
- [queue.md](../queue.md) — BullMQ conventions.
- [AGENTS.md § Dangerous Commands — Never Run These](../../AGENTS.md) and [§ Agent Safety Rules](../../AGENTS.md) — the binding ban list.
