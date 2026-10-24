# Schema Changes — Step-by-Step Recipes

How to evolve the database schema safely. Read this **before** touching `packages/db/prisma/schema/`.

If you only remember one thing: **edit the schema file, run `pnpm db:push` locally, commit the schema change, deploy with `APPLY_SCHEMA=safe`.**

## How schema changes reach production

The schema directory (`packages/db/prisma/schema/`) is the single source of truth — exactly the tables and columns the app expects. No migration files. Every environment (local, staging, production) is synced to the committed schema by the db-applier.

At deploy time:

1. On Dokploy, each selected Application builds directly from Git. Development follows `main`/`master` automatically; production manually selects the same existing immutable `release/<full-commit-sha>` tag on every role. No registry publish step or Compose file is required. Other platforms use their documented artifact build workflow.
2. Run exactly one schema leader with `APPLY_SCHEMA=safe` (or confirmed `dangerous` — see below). On Dokploy prefer the db-applier Application, command `apply`; without it, the app entrypoint leads and any worker is a follower. On any other platform, either shape works — a one-shot job before the rollout, or the app entrypoint as leader with every other runtime a follower.
3. The applier collects the guarded `prisma migrate diff` SQL plan against the live database, takes any required pre-apply backup, and applies that hashed SQL; then the app starts against the synced schema.
4. On Dokploy, leave the chosen leader at `safe` for every ordinary deploy, even with no schema change. Followers stay `APPLY_SCHEMA=off` with `WAIT_FOR_SCHEMA=true`: before starting HTTP or jobs they require the baked schema fingerprint's receipt, no active intent, and an empty live Prisma diff under the advisory lock. Production runs the leader successfully before deploying runtimes; development followers may wait for independently built Applications. Verify the selected deployment with `pnpm dokploy:verify`.

The modes and guards are shared; the lifecycle is platform-specific. After a dangerous attempt, clear its confirmation/acceptance values and return the Dokploy leader to `safe`, not `off`. Other platforms that explicitly toggle schema apply return their leader to `off`. Both job and entrypoint run the same canonical `scripts/db-applier.sh` under a Postgres advisory lock. See [schema-push § The APPLY_SCHEMA contract](./schema-push.md#the-apply_schema-contract) and [deployment-vps § Schema deploy lifecycle](./deployment-vps.md#schema-deploy-lifecycle).

No migration history table to desync or `_prisma_migrations` checksum to violate. Release ordering still matters: the startup gate proves compatibility at admission, not ongoing compatibility or zero downtime. The tradeoff is no reviewable SQL diff committed to git — **you have to think ahead about destructive changes yourself**. That's what this doc is for.

## Backwards-compatible or downtime — pick one

During a rolling deploy, the old container keeps serving traffic while the schema leader applies and the new container boots. For a window of seconds to minutes — longer if a healthcheck holds traffic on the old revision — both code versions run against the new schema. Two constraints must hold at once:

1. **Old code must work against the new schema** — nothing it still reads has been removed, nothing it still writes violates a tightened constraint.
2. **New code must work against the old data** — no required field that existing rows lack, no type the old data doesn't fit.

Schema changes fall into two buckets.

**Naturally compatible — ship in one deploy.**

- Add a nullable column, or a column with `@default(...)`
- Add a new model, table, index, or unique constraint not already violated by existing data
- Add a foreign key whose target rows already exist

**Destructive or narrowing — must be expand-contract across multiple deploys.**

- Drop a column (or rename — same shape)
- Tighten a nullable column to `NOT NULL`
- Narrow a column type (`String` → `VarChar(50)`, `Int` → `SmallInt`, `String` → enum)
- Add a unique constraint to a column that may have duplicates today
- Tighten an `onDelete` from `Cascade` to `Restrict` (or any direction that could fail on existing data)

For anything in the second bucket, splitting into multiple deploys is non-negotiable — a single deploy means downtime, with no in between.

The expand-contract shape is always: **add new compatible shape → backfill or migrate data → switch reads/writes → drop old shape (in a separate deploy).** Recipe 3 walks through this for a column rename; Recipe 3b covers the variations for the other patterns above.

### Phases are rollback-safe; the contract is not

Phases 1 and 2 of any expand-contract (add new shape, backfill, switch reads) are rollback-safe — both the new and prior code revisions work against the expanded schema. Phase 3 (drop the old shape) is a one-way door: once it runs, you cannot roll the *code* back to a revision that still reads the old column without also restoring data.

This is a code-compatibility claim, not permission to restart any old image. Dokploy's follower gate requires the current schema fingerprint; after it changes, an old image can refuse startup even when its code could tolerate the additive change. Prefer a correction built with the current schema, and follow [deployment-vps § Rollback Procedure](./deployment-vps.md#rollback-procedure). Never disable the gate to force a rollback.

The implication is timing. **Let the new code run on the expanded schema for at least one full deploy cycle — 24 hours is a reasonable default — before scheduling Phase 3.** That soak is your safety net for catching regressions and reverting the code without also having to restore data.

The same logic forbids bundling a destructive schema change with the code change that depends on it: if the apply succeeds but the new code then fails its healthcheck and traffic returns to old replicas, those replicas are running against a schema they didn't expect. Always ship the schema change additively first, then the code, then (after the soak) the contract.

## The two commands you need

| Command | What it does | When to run |
|---|---|---|
| `pnpm db:push` | Apply your current schema to your local Postgres. Refuses destructive ops. | After editing the schema. |
| `pnpm db:push:dangerous` | Same, with `--accept-data-loss`. | Only when you intentionally want to drop/rename and have already understood what will be lost. |
| `pnpm db:studio` | Opens Prisma Studio (browser GUI) so you can see the data in your local DB. | When you want to look at the data. |

You should never need any other Prisma command in day-to-day work. Anything starting with `prisma migrate` or `prisma db push --force-reset` is a footgun — see the "Dangerous Commands" section in `AGENTS.md`.

**All three refuse to run against anything but your local database.** `scripts/assert-local-database.sh` reads `DATABASE_URL` the same way Prisma does — from your shell, else from the repo-root `.env`, parsed with dotenv so a duplicated key resolves to the *last* one, exactly like Prisma — and requires the host to be `localhost` / `127.0.0.1` / `::1` / `host.docker.internal`. Two knobs adjust it for a local database that isn't the default:

- `EXPECTED_DB` (default `starter`) — export this if you renamed your local database, e.g. during the rebrand.
- `EXPECTED_PORT` (default `5432`) — export this if your local Postgres listens elsewhere.

Neither widens the host allowlist, which is the part doing the real work. If the guard refuses and `DATABASE_URL` points at a shared, staging, or production database, that is the guard working: deploy the schema with `APPLY_SCHEMA` (below) instead of pointing a local command at it. After changing the script, re-run its self-test: `bash scripts/assert-local-database.sh --self-test`.

---

## Recipe 1 — Add a field to an existing model

**Goal:** Add a `phoneNumber` column to the `User` model.

### Steps

1. **Open** the relevant file in `packages/db/prisma/schema/` (`auth.prisma` for auth models, `assets.prisma` for asset models, `chat.prisma` for chat models).
2. **Find** the `User` model and add the field. Make it optional (`?`) unless you have a strategy for backfilling existing rows.

   ```prisma
   model User {
     id          String  @id @default(cuid(2))
     email       String  @unique
     name        String
     phoneNumber String? // ← new field
     // ... existing fields
   }
   ```

3. **Apply to your local DB:**

   ```bash
   pnpm db:push
   ```

   For a nullable column add, the push completes silently with: `Your database is now in sync with your Prisma schema.` There is no per-column diff in the output — see "What `pnpm db:push` actually prints" below for why and how to preview the SQL when you want to.

4. **Commit the schema file.** Only the `.prisma` file needs to be committed — there are no migration folders.

When the selected release's schema leader runs with `APPLY_SCHEMA=safe`, it picks up the new column. On Dokploy this happens automatically in development after a push to `main`/`master`; production still requires manually selecting and deploying the reviewed release.

---

## Recipe 2 — Add a new model

**Goal:** Add a `Project` model that belongs to a `User`.

### Steps

1. **Open** the relevant file in `packages/db/prisma/schema/`. `schema.prisma` holds the datasource and generator blocks; application models live in sibling files — `auth.prisma`, `assets.prisma`, `chat.prisma`. A new domain gets its own `<domain>.prisma`.
2. **Add the new model.** Follow the conventions in `patterns/schema-guidelines.md` — every model needs `id`, `createdAt`, `updatedAt`, and every foreign key needs an explicit relation and an index.

   ```prisma
   model Project {
     id        String   @id @default(cuid(2))
     createdAt DateTime @default(now())
     updatedAt DateTime @default(now()) @updatedAt
     name      String
     userId    String
     User      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

     @@index([userId])
   }
   ```

3. **Add the back-relation on `User`.** Prisma requires both sides of every relation to be declared.

   ```prisma
   model User {
     // ... existing fields
     Projects Project[]
   }
   ```

4. **Apply locally and commit:**

   ```bash
   pnpm db:push
   ```

   For a purely additive change (new table + index + FK), the push completes silently with the success message. If Prisma prints a yellow warning block about data loss — referring to a dropped table or column — **stop**: you've accidentally removed something. Revert and retry. To see the actual SQL before applying, use the `migrate diff` workflow in "What `pnpm db:push` actually prints" below.

---

## Recipe 3 — Rename a field (worked example of expand-contract)

Renaming is the canonical case for the expand-contract pattern called out in "Backwards-compatible or downtime — pick one." **Read this twice.** The naive approach (rename the column in the schema, run `db:push:dangerous`) **destroys data**: Prisma sees "column `name` no longer exists, column `fullName` is new" and issues `ALTER TABLE DROP COLUMN "name"; ALTER TABLE ADD COLUMN "fullName";` — every existing row's name is gone.

Because we have no migration files to write a custom backfill into, a rename must be split across **two deploys** with an explicit data-copy step in between. This expand-contract pattern is non-negotiable for any destructive change against production data.

**Goal:** Rename `User.name` to `User.fullName`.

### Phase 1 — Add the new column, keep the old one

1. Edit the schema to add the new field *without* removing the old one:

   ```prisma
   model User {
     id       String  @id @default(cuid(2))
     name     String  // ← keep for now
     fullName String? // ← new, optional
     // ...
   }
   ```

2. `pnpm db:push` locally. Commit.

3. **Deploy this change with `APPLY_SCHEMA=safe`.** The push is purely additive, so `safe` accepts it. Production now has both columns.

### Phase 2 — Backfill data

Because there are no migration files, **the data copy has to be an explicit admin-only feature shipped with Phase 1**. Common shapes:

- An admin-only oRPC procedure (e.g. `admin.backfillUserFullName`) that runs `UPDATE "User" SET "fullName" = "name" WHERE "fullName" IS NULL`.
- A one-off BullMQ job that the admin can trigger from the admin UI.
- A seed script variant the admin runs once via a temporary production shell.

The admin triggers the backfill after Phase 1 is deployed, verifies the data, then proceeds to Phase 3. **Do not skip the verify step** — this is the last checkpoint before the old column is dropped.

### Phase 3 — Switch reads, then drop the old column

1. Update all application code to read from `fullName` instead of `name`. Keep both fields in the Prisma schema for this code-only release. Deploy with the platform's ordinary settings (Dokploy leader `safe`, followers `off` + `WAIT_FOR_SCHEMA=true`; explicitly toggled platforms leave apply `off`). Verify reads look correct and all old consumers have stopped before contracting.

2. Edit the schema to remove `name` and make `fullName` required:

   ```prisma
   model User {
     id       String @id @default(cuid(2))
     fullName String // ← required now
     // (name removed)
   }
   ```

3. `pnpm db:push:dangerous` locally to verify. Commit.

4. **Deploy with `APPLY_SCHEMA=dangerous`** on the schema leader. Golden path: run the one-shot db-applier `apply` job — first without confirm variables to get the non-authoritative preview (it exits non-zero by design), then with `APPLY_SCHEMA_CONFIRM=DANGEROUS:<target-id>:<schema-fingerprint>` built from that preview; the required pre-apply dump runs automatically when logical backups are enabled. Fallback: use the app leader with the same two-step confirm. Confirm a recent backup exists and the restore path in [backup-and-restore.md](./backup-and-restore.md) has been practiced. On Dokploy disable automatic deployment in either environment and pin every role to the same reviewed release tag for this operation. The apply drops the old column and tightens the NOT NULL constraint. After success or failure, clear the confirmation/acceptance values and return the leader to `safe` on Dokploy (`off` on explicitly toggled platforms). Restore development's branch/automatic deployment only after that cleanup; production stays manual.

This pattern (add → backfill → switch reads → drop) applies to any rename or destructive change. Recipe 3b below covers the other variations (column drop, type narrowing, NOT NULL tightening, unique constraint addition, `onDelete` tightening) — they all share this shape. Splitting across multiple deploys with explicit application-level backfills is the only safe way.

---

## Recipe 3b — Other expand-contract variations

Each of these follows Recipe 3's shape (add → backfill → switch → drop) with different specifics. The discipline is the same: the application change ships *before* the schema change, with verification between phases.

### Drop a column

1. Remove all reads/writes from application code, but retain the column in the Prisma schema. Deploy with ordinary platform settings as in Recipe 3, Phase 3 above. Verify production no longer touches the column (logs, metrics), including old replicas and background jobs.
2. Remove the column from the schema. Confirm backup/restore readiness via [backup-and-restore.md](./backup-and-restore.md), then deploy with `APPLY_SCHEMA=dangerous`.

### Remove a deployed feature's tables

Treat removal recipes as an inventory, not permission to combine code removal and data deletion in one release:

1. **Code-only release:** remove the feature's runtime consumers, but retain its Prisma models, enums, and relation fields unchanged. Complete any documented queue/scheduler drain before removing its consumers. Deploy with ordinary platform settings, verify the feature is unused, and let this revision soak before contracting. On Dokploy the `safe` leader refreshes the receipt; followers still require an empty live diff. Deleting the models now and setting apply `off` cannot pass that gate.
2. **Retention decision:** export any data that must survive and verify backup/restore readiness. If the owner wants to retain the tables indefinitely, keep their Prisma definitions too; do not hide live drift by disabling the gate.
3. **Separate contract release:** only after approval, remove the retained models/enums and sibling relations, review the exact SQL and the dated CI waiver below, and follow Recipe 3's dangerous-deploy confirmation and cleanup. On Dokploy this is a manual pinned release in both environments; afterward its leader returns to `safe`, with followers still `off` + `WAIT_FOR_SCHEMA=true`.

For a fresh, never-deployed app with only disposable local data, the local removal can happen in one change through `pnpm db:push:dangerous`. These exceptions do not authorize deleting shared data or bypassing the production contract.

### Tighten nullable → `NOT NULL`

1. Backfill existing nulls (admin-triggered procedure, BullMQ job, or seed script). Verify `SELECT count(*) FROM "X" WHERE "y" IS NULL` returns 0.
2. Change the schema to `NOT NULL` (optionally with `@default(...)`). Deploy with `APPLY_SCHEMA=safe` — once the nulls are gone, the push is non-destructive.

### Narrow a column type

Same shape as Recipe 3 — Prisma cannot reliably convert in place, so you add a new column with the narrower type, backfill with explicit conversion (truncating, validating, mapping to enum values), switch reads, then drop the old column. Three deploys.

### Add a unique constraint where duplicates may exist

1. Deduplicate via an admin procedure (which row wins is your call). Verify `SELECT y, count(*) FROM "X" GROUP BY y HAVING count(*) > 1` is empty.
2. Add `@unique` (or `@@unique`) to the schema. Deploy with `APPLY_SCHEMA=safe`.

### Tighten an `onDelete` to a stricter mode

1. Clean up rows that would block parent deletes under the new mode (e.g. orphan deletes for `Restrict`, FK nulling for `SetNull`).
2. Update the schema. Deploy with `APPLY_SCHEMA=safe`.

---

## What `pnpm db:push` actually prints

Important caveat for Postgres: `prisma db push` does **not** print a structured per-column diff. The `[+] Added column "x"` / `[-] Dropped column "x"` syntax is MongoDB-only. The actual output is:

1. A datasource line confirming which database it's connecting to.
2. **If there are data-loss risks** — a yellow warning block listing them (e.g. "You are about to drop the column `name` on the `User` table"). Without `--accept-data-loss` (i.e. plain `pnpm db:push`), the command refuses and exits non-zero. With it (`pnpm db:push:dangerous`), the warnings print and the push proceeds.
3. The success message: `Your database is now in sync with your Prisma schema.`

If your push completes silently with only the success message, you have no visibility into what changed. Two options for getting that visibility — pick whichever fits the change.

### Option A — Preview the SQL with `prisma migrate diff` (recommended for destructive changes)

Run `migrate diff` against your local DB *before* `db push` to see the exact SQL that will execute:

```bash
pnpm --filter @starter/db exec prisma migrate diff \
  --from-config-datasource \
  --to-schema=./prisma/schema \
  --script
```

This prints the full DDL (`CREATE TABLE`, `ALTER TABLE`, `DROP COLUMN`, etc.) without applying anything. Read it, sanity-check the destructive lines, then run `pnpm db:push` (or `pnpm db:push:dangerous`) to apply.

`migrate diff` is read-only — it does not touch `_prisma_migrations` or write anything to either database, so it is safe in our push-only setup.

`--from-config-datasource` reads the URL from `prisma.config.ts`. To diff against a non-default database (a prod replica, a snapshot), set the URL there temporarily. Prisma 7 removed the `--from-url` flag; the URL must come from the config file. `--to-schema` accepts either a single `.prisma` file or the schema folder.

Same command applies for previewing the production diff before approving an `APPLY_SCHEMA=dangerous` deploy — see [schema-push.md § Previewing the diff before a destructive deploy](./schema-push.md#previewing-the-diff-before-a-destructive-deploy).

### Option B — Rely on the `safe` / `dangerous` gate as the only check

If you skip the `migrate diff` preview, the only signal you have is whether `db push` refuses or accepts:

- `pnpm db:push` (or `APPLY_SCHEMA=safe`) — refuses any destructive op. If it succeeds, the change is purely additive and safe.
- `pnpm db:push:dangerous` (or `APPLY_SCHEMA=dangerous`) — applies destructive ops. The yellow warning block prints, but you must read it carefully because the change *will* go through regardless.

This is acceptable for changes you understand well — e.g. the simple cases in Recipes 1 and 2. **For anything destructive (Recipe 3 or 3b), Option A is mandatory**: never approve `APPLY_SCHEMA=dangerous` against production without having reviewed the SQL via `migrate diff` first.

## Destructive patterns to watch for

Whether you are reading SQL from `migrate diff --script` (Option A) or warning text from a `dangerous` push (Option B), these patterns should make you stop:

- **`DROP COLUMN "x"`** when you did not intend to remove a field. Usually a typo — Prisma sees "old column gone, new column added." Fix the typo and retry. If the drop *is* intentional → Recipe 3b "Drop a column" (must split across two deploys).
- **`DROP TABLE "X"`** when you did not intend to delete a model. Same root cause. If intentional, drop reads first, then the table — same shape as dropping a column.
- **`ALTER TABLE ... ALTER COLUMN ... TYPE ...`** (or warning: "the data in that column could be lost") — Postgres may or may not be able to convert existing data → Recipe 3b "Narrow a column type."
- **`ALTER TABLE ... ALTER COLUMN ... SET NOT NULL`** without a backfill, or **`ADD COLUMN ... NOT NULL` without a default** on an existing table. Will fail on any non-empty table. Either add a `@default(...)` (single deploy) or → Recipe 3b "Tighten nullable → `NOT NULL`."
- **`CREATE UNIQUE INDEX`** on a column that may have duplicates today. Will fail at push time → Recipe 3b "Add a unique constraint where duplicates may exist."
- **`ALTER TABLE ... DROP CONSTRAINT ... FOREIGN KEY`** with no matching `ADD CONSTRAINT` on the same table — means a relation was removed. Make sure that's intentional. A drop *paired* with an add on that table is just an `onDelete`/`onUpdate` change and is fine.

When in doubt, **don't commit and don't push**. Revert the schema change and try again.

### The CI gate, and the dated waiver that opens it

`pnpm policy:schema-diff` (`scripts/check-schema-destructive-diff.ts`, run in the PR-checks "Policy checks" job) diffs the base branch's schema against the PR's. It splits the DDL above into two classes:

- **Fails the check** — `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN … TYPE`, and a `DROP CONSTRAINT` the diff does **not** re-add on the same table. These delete data — or referential integrity — that already exists. Nearly always the right response is to split the change — that is what the gate is for.
- **Prints a warning and passes** — `SET NOT NULL`, `CREATE UNIQUE INDEX`, `ADD CONSTRAINT … UNIQUE`, and a `DROP CONSTRAINT` immediately re-added on the same table (which is how Prisma expresses an `onDelete`/`onUpdate` change on an existing relation). Nothing is deleted; the push simply *fails* if existing rows already violate the new constraint. Adding `@unique` or a required column is ordinary work, so the check tells you what to check (backfill the column, de-duplicate the values) instead of blocking you. Recipe 3b still applies when the table already has rows.

When a PR genuinely *is* the contract phase of a destructive change, there is exactly one way through: commit `.github/expand-contract` in the PR. There is no environment-variable bypass — an escape hatch with no reason and no expiry is just a disabled gate.

The file is **not** an empty marker. It must contain two lines:

```
until: 2026-09-20
reason: contract phase of the User.name → User.fullName rename (expand shipped 2026-09-06)
```

`until:` may be at most **14 days** in the future; `reason:` must be non-empty. A file that is missing either line, is expired, or is dated further out than that fails the check on *every* run — including PRs with a clean schema diff. That is deliberate: the waiver is scoped to one contract-phase deploy, and leaving it behind must break the build rather than quietly disable the gate. Delete it in the PR that follows the drop.

Check the parsing rules without touching a schema: `pnpm policy:schema-diff --self-test`.

---

## Common mistakes

### "I pushed to local, everything worked, but production fails with `APPLY_SCHEMA=safe`"

Symptom: deploy logs show the schema apply failing with a message about destructive operations (`APPLY_SCHEMA=safe refuses destructive SQL in the plan`).

Cause: the diff against production's current schema includes a destructive op (drop column, narrow type, add NOT NULL without default). Your local DB may not have been in the "old" state because you'd already pushed earlier experimental changes.

Fix: reproduce locally by resetting your DB to the old schema, then running `pnpm db:push` against it. That shows you the same failure. Follow the expand-contract pattern above.

### "I want to start over with a fresh local DB"

```bash
bash scripts/compose.sh -f docker-compose.dev.yml down -v   # delete the local Postgres volume
pnpm dev:services                                            # start a new empty Postgres + Redis
pnpm db:push                                                 # apply the current schema from scratch
```

`pnpm dev:services:stop` is an ordinary `down` and does **not** delete the volume — only `down -v` does. Safe because it only touches your local Docker volume and cannot reach a remote database. See AGENTS.md § Safe alternatives.

### "I pushed to local, but my code has type errors about the new field"

After pushing, the Prisma client types regenerate automatically (via `postinstall`). If your editor still shows stale types, restart the TypeScript server. For a manual regenerate:

```bash
pnpm db:generate
```

---

## See also

- [patterns/schema-push.md](./schema-push.md) — the deploy mechanics (how `APPLY_SCHEMA` and the entrypoint advisory lock work, which container leads schema sync, slim-app variant, seed scripts)
- [patterns/schema-guidelines.md](./schema-guidelines.md) — naming conventions, ID strategies, relation patterns, indexing — read this *before* designing a new model
- [infra-notes.md](../infra-notes.md) — the full deploy contract for the infra agent
- `AGENTS.md` § Dangerous Commands — the list of Prisma commands that are forbidden and why
