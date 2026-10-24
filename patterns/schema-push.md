# Schema Deploy Mechanics

How schema changes flow from the committed `.prisma` file to a running production database.

> Looking for the workflow? See [patterns/schema-changes-recipe.md](./schema-changes-recipe.md) — this doc covers the underlying mechanics only.

## The model: push, not migrate

This template pushes schema; it never migrates. There is no migration history, no `_prisma_migrations` table, no committed SQL files. Locally `pnpm db:push` runs `prisma db push`; in production the db-applier computes and applies a guarded `prisma migrate diff` SQL plan. Either way the deployed schema is whatever is in `packages/db/prisma/schema/` at the moment of the push.

The tradeoff is explicit:

| | `migrate deploy` (not used) | `db push` (what we do) |
|---|---|---|
| Migration history | ✅ Tracks applied migrations | ❌ No history |
| Reviewable SQL diff | ✅ Committed in git | ❌ Only visible in deploy logs |
| Safety against destructive changes | ✅ Refuses edited migrations | ⚠️ Refuses destructive ops unless `--accept-data-loss` |
| Local tooling | Requires Docker for ephemeral-container migration gen | Zero extra tooling |
| Ordering across deploys | Implicit (files applied in timestamp order) | N/A (always brings DB in sync with current schema) |

We picked `db push` because the target audience is solo builders and small teams who should not need to learn the migration-file lifecycle. The expand-contract pattern in [schema-changes-recipe.md](./schema-changes-recipe.md) covers the destructive cases that `migrate deploy` would otherwise guard with committed SQL.

## Who runs the push

Prefer the db-applier image (`Dockerfile.db-applier`), mode `apply`. Dokploy runs it as a Git-backed one-shot Application: production waits for its success before deploying runtimes; automatic development relies on follower admission instead of a cross-Application dependency. Dokploy runtime followers stay `APPLY_SCHEMA=off` with `WAIT_FOR_SCHEMA=true`. On any other orchestrator, run the same image as an ordered one-shot job before the runtimes, or fall back to the app entrypoint leader. Both app Dockerfiles retain Prisma and PostgreSQL clients for schema apply, admission, and backup preparation.

- Run the one-shot db-applier `apply` job (container command `apply`, or `DB_APPLIER_MODE=apply`) with `APPLY_SCHEMA=safe` (or confirmed `dangerous`) on it. Dokploy native Git runs the single leader on every deployment, including no-op changes, to refresh the schema receipt.
- On Dokploy without an applier, keep `APPLY_SCHEMA=safe` and `WAIT_FOR_SCHEMA=false` on the **app** entrypoint for every ordinary deployment; any worker stays `off` with `WAIT_FOR_SCHEMA=true`. Other platforms use their documented single entrypoint leader and toggle lifecycle.
- The app entrypoint (`scripts/docker-entrypoint.sh`) runs `scripts/db-applier.sh apply` only when `APPLY_SCHEMA != off`; the db-applier image's own entrypoint delegates to the same script in `apply` mode.

Two selected roles with `APPLY_SCHEMA != off` is a misconfiguration. The advisory lock serializes operations, but different schema targets need not be no-ops or compatible. Fix the config; the lock cannot choose the correct release for you.

### Recommended leader

| Platform | Leader | Why |
|---|---|---|
| Dokploy / VPS (default) | **Git-backed db-applier Application** | Replicated, one replica, restart policy `none`. Dev may auto-deploy `main`/`master`; prod manually deploys the same immutable Git tag on every role. App/worker use `WAIT_FOR_SCHEMA=true` and require the matching receipt plus live schema before startup. Recipe: [deployment-vps.md](./deployment-vps.md). |

The entrypoint is also a valid deliberate choice on Dokploy when the operator wants fewer containers overall and/or has chosen the provider-only backup profile so no db-applier is deployed. It keeps every discipline — one leader per deploy, `dangerous` never steady-state, the same confirm protocol, no ad-hoc pushes outside the canonical scripts.

## The entrypoint

`scripts/docker-entrypoint.sh` is the app images' side of schema sync — the one place outside the db-applier that talks to Postgres before application code starts. The same script runs in both app images. It does three things:

1. Validates required env vars. `DATABASE_URL` and `REDIS_URL` are required for both server and worker command paths; `BETTER_AUTH_SECRET` is required only when the server command is starting.
2. Runs the selected schema path:
   - `WAIT_FOR_SCHEMA=true` requires `APPLY_SCHEMA=off`: wait for the matching receipt, no active operation, and an empty live diff while holding the admission lock. Timeout or cancellation prevents the runtime command from starting.
   - `off` (default when unset), without a follower gate — skip schema work.
   - `safe` — apply the guarded `prisma migrate diff` SQL if it is not destructive.
   - `dangerous` — apply that hashed SQL after `APPLY_SCHEMA_CONFIRM` binds it.
3. `exec`s the container CMD (the Hono server or the BullMQ worker).

Whichever container carries `APPLY_SCHEMA != off` runs the apply path. Dokploy followers pass the read-only admission gate before their CMD. In a dedicated-applier setup both app containers are followers; the applier's entrypoint (`scripts/db-applier-entrypoint.sh`) delegates to `scripts/db-applier.sh` with mode `apply`.

## Mechanism: the same applier everywhere

One canonical mutating path exists: `scripts/db-applier.sh` under the advisory lock. What hosts it differs — a **deploy-gated one-shot db-applier job** or a **leader container's entrypoint** on boot. `APPLY_SCHEMA` and its `off`/`safe`/`dangerous` semantics are identical everywhere.

| | One-shot db-applier job | Entrypoint schema sync |
|---|---|---|
| Where it runs | A dedicated Job/cron-run container from `Dockerfile.db-applier`, command `apply`, runs to completion | Inside the leader container, on boot, before its CMD |
| What reads `APPLY_SCHEMA` | `scripts/db-applier.sh` (via `scripts/db-applier-entrypoint.sh`) | `scripts/docker-entrypoint.sh` → the same `scripts/db-applier.sh apply` |
| Advisory lock | Required — same lock either way | Required — multiple replicas may boot concurrently |
| Failure behavior | Job exits non-zero; the deployment gate must leave apps on their prior revisions | Container fails healthcheck; platform rolls back / holds traffic |
| Traffic during sync | Apps keep serving the previous schema and schema revision | Old revision serves until the new container is healthy |

## The advisory lock

Neither the guarded migrate-diff apply nor `prisma db push` takes an advisory lock of its own (unlike `prisma migrate deploy`). When multiple replicas boot against the same database on a new revision, they would race — best case, one succeeds and the rest crash with `column already exists`; worst case, concurrent DDL interleaves and leaves the schema in a partial state.

`scripts/db-applier.sh` owns the lock itself, so nobody has to wrap it in one:

1. Ordinary `apply` delegates to `scripts/apply-schema.mjs`. One PostgreSQL connection (`application_name=starter-db-applier-session`) takes `pg_advisory_lock(1145389648)` before planning and backup. This exact connection executes the approved SQL; no separate SQL writer can survive its lock owner.
2. Immediately after `BEGIN`, the owner also takes the same transaction-level advisory lock. Generated SQL cannot release that lock: it lasts until the transaction ends. The SQL and the current schema receipt commit atomically in one transaction.
3. Cancellation stops admission of later stages, closes the SQL connection, and drains any preparation child. Every live Prisma comparison (apply preview, authoritative plan, post-backup replan, and follower admission) uses the same pinned-CLI adapter, which owns the native schema engine and acknowledges its final close. A wrapper exit without that acknowledgement refuses continuation. An interrupted apply leaves no partial state — the SQL and its receipt committed together or not at all — so after a crash, verify the outcome with read-only queries (`starter_control.schema_releases` plus the live schema) before retrying; a retry never resumes the old SQL, it replans from the live database.

`restore` retains its dedicated psql lock owner and supervised shell operation, sharing the same key with ordinary apply. The lock client has 10-second connection and 310-second statement limits; a native-client supervisor bounds its final drain when the command stream closes. Connection-count clients have the same 10-second connection, 5-second lock, and 60-second statement limits with a 75-second client deadline. Their cancellation drains the direct effect. Killing a restore client never proves the server effect stopped: after an interrupted restore, inspect the destination with read-only queries before any retry.

Shell owners request cancellation through private FIFO descriptors; saved PIDs are only wait/status values. The supervisor owns the actual native process handle and acknowledges its final close before artifacts can be removed. Nested shell/archive owners finish their own leaf drain and cleanup before acknowledging; no competing outer five-second timer kills them mid-cleanup. A signal may first await an existing 75-second preflight or connection-count call. Native cancellation escalates after five seconds, and the lock command stream's final drain has a separate ten-second bound. These bounds require the supported owners to reach their signal handlers; they do not promise cleanup after SIGKILL or a stalled host. Missing acknowledgement preserves the source, snapshot result, and backup artifacts for inspection rather than assuming descendants stopped.

Restore admission is approved only after the target/source-bound confirmation is checked against the re-downloaded immutable source. Automatic cleanup drains nested backup/snapshot owners' direct writers before removing artifacts; a signal before the destructive boundary leaves the destination untouched. The advisory lock — not any persisted state — is what serializes restore against apply.

The lock ID `1145389648` is `0x44414450` (ASCII `DADP`) — template-specific to avoid colliding with any application-level advisory locks. If you add your own advisory locks in application code, pick a different ID.

**Do not wrap `db-applier.sh` in your own `pg_advisory_lock` session.** A session-level advisory lock is not re-entrant across sessions: an outer psql wrapper holding the same ID blocks the applier's own acquire until its 300-second `lock_timeout` fails the deploy. The entrypoint calls `bash /app/scripts/db-applier.sh apply` directly — copy that, never an outer psql wrapper.

The 300-second `lock_timeout` is belt-and-suspenders. If the lock is held longer than five minutes, something is wrong and the deploy should abort rather than wait silently.

The advisory wait is separate from PostgreSQL table locks. The **connection actually applying SQL** uses `lock_timeout=5s`, `statement_timeout=60s`, and `transaction_timeout=300s`, with a 10-second connection timeout. These PostgreSQL 17 limits bound both an individual wait and the complete SQL transaction; they do not change application connections. A 310-second client-side SQL deadline closes a partitioned connection, but outcome still requires reacquiring its lock. Each live Prisma comparison is limited to 120 seconds. Backups happen before the SQL transaction and are outside its five-minute budget.

A busy table fails the deployment promptly; an acknowledged rollback leaves nothing behind. There is no retry loop: correct the cause and retry the deployment with a fresh preview for dangerous changes. If the database cannot be reached, the outcome stays unknown — verify it with read-only queries rather than assuming either way.

`safe` means non-destructive, **not** no downtime or no locking. An index build or table rewrite can still disrupt traffic for the permitted statement duration. Keep expand-contract changes small; schedule a deliberate maintenance window for large blocking changes instead of increasing the timeout blindly.

Both CI and runtime call `scripts/lib/schema-diff.mjs`. Constraint replacement pairs must match schema, table, and exact quoted constraint name; a same-named constraint on another table cannot cover a removal. Prisma's enum contraction emits its own `BEGIN`/`COMMIT` pair. The shared normalizer validates the complete generated enum rebuild (temporary type, column casts/defaults, exact rename chain and old-type removal), then removes only those wrapper statements. It preserves all executable SQL bytes, supports multiple enums and scalar/array consumers across schemas, and classifies contraction as destructive. CI displays this normalized SQL; apply preview, confirmation SHA, authoritative plan, backup replan, receipt, and execution all use it. Only the applier begins and commits the transaction. Other transaction-control statements, malformed wrappers, unsupported top-level SQL, and concurrent index operations stay rejected. `safe` means no detected destructive change, not zero runtime cost or guaranteed compatibility with an older app.

That shared lexical boundary supports quoted identifiers, ordinary strings with the writer's explicit `standard_conforming_strings=on`, escape strings and their newline continuations, and nested comments. Unicode escape forms (`U&`) and dollar quoting are explicitly unsupported; malformed/unclosed forms cannot count as an empty diff. This is a bounded Prisma-DDL classifier, not permission to execute arbitrary untrusted SQL. Prisma's dotenv loader is quiet so `--script` stdout remains machine-readable SQL; diagnostics stay on stderr in CI and runtime.

After successful SQL execution, the applier writes the current fingerprint to the singleton `starter_control.schema_releases` record in the same SQL transaction. Apps using an external applier set `WAIT_FOR_SCHEMA=true` with `APPLY_SCHEMA=off`: startup requires a matching receipt and an empty comparison against the actual live schema. The wait defaults to 300 seconds (`SCHEMA_WAIT_TIMEOUT_SECONDS`, 1–3600). A newer schema replaces the receipt, so an old receipt cannot authorize a stale application. Continue to use expand-contract: a startup check cannot prevent a later deployment from changing the database while an older app serves traffic.

Restore never supplies this receipt. Recovery must run the selected release's ordinary guarded schema leader against the restored target before admitting followers; see [replacement-database recovery handoff](./backup-and-restore.md#replacement-database-recovery-handoff).

## The APPLY_SCHEMA contract

The env var is owned by the infra/orchestrator, not by application code. Values:

- `off` (or unset) — no schema mutation. A follower with `WAIT_FOR_SCHEMA=true` must still pass read-only admission before its runtime starts.
- `safe` — apply the guarded live `prisma migrate diff` SQL. If that plan contains destructive DDL (DROP COLUMN / DROP TABLE / ALTER COLUMN … TYPE), the applier exits non-zero and the container fails to boot. The deploy platform's healthcheck treats the revision as unhealthy and either rolls back (Dokploy) or holds traffic on the previous revision.
- `dangerous` — apply that SQL (including destructive DDL). A missing/invalid confirmation can only print a non-authoritative preview. The applier collects the authoritative live SQL plan and requires `APPLY_SCHEMA_CONFIRM` to bind the canonical target id and `pnpm db:fingerprint`. When logical backups are enabled, a successful pre-apply pg_dump upload is **required** for that live plan; the applier then re-collects the diff and requires SHA equality before applying **that SQL** rather than a second Prisma plan. On the provider-only profile, requires `APPLY_SCHEMA_ACCEPT_PROVIDER_BACKUP=I_ACCEPT_PROVIDER_BACKUP_ONLY` for that deploy. See [backup-and-restore.md](./backup-and-restore.md). The protocol defends against mistakes, not against a driver who already holds `DATABASE_URL`.

For native Git Dokploy deployments, leave `APPLY_SCHEMA=safe` on the one chosen leader so **every deployment**, including a no-op, refreshes the receipt. Followers keep `APPLY_SCHEMA=off` and `WAIT_FOR_SCHEMA=true`. A confirmed dangerous deployment is temporary: return its leader to `safe` afterward, not `off`. This is the generated configuration described in [deployment-vps.md](./deployment-vps.md).

On other platforms whose workflow explicitly enables schema apply only for schema-changing releases, the intended lifecycle is:

1. Steady state: `APPLY_SCHEMA=off` (or unset) everywhere.
2. Schema change in a PR. Before app rollout, infra sets `APPLY_SCHEMA=safe` (or `dangerous` for destructive changes) on the leader — a deploy-gated one-shot apply job, or the entrypoint leader container.
3. The job runs to completion before matching app artifacts deploy (or the new entrypoint-led revision boots, runs the push, and starts its CMD).
4. Once the run is verified (`Schema sync complete.`, exit 0 / healthy revision), infra sets `APPLY_SCHEMA=off` again.

The full orchestrator-level contract and per-platform configuration lives in [infra-notes.md](../infra-notes.md).

## Previewing the diff before a destructive deploy

The deploy's SQL is generated at deploy time by `prisma migrate diff`, comparing the committed schema against whatever production currently is. The applier prints the full SQL in the deploy log, but by then the deploy is already underway — for a `dangerous` deploy you want to read the SQL *before* approving it. There is no structured per-column diff (the `[+] Added column ...` syntax is MongoDB-only). For a `safe` deploy the worst case is the applier refuses the destructive SQL, the container fails its healthcheck, and the database is unchanged — recoverable.

Use `prisma migrate diff` to preview. It computes the diff without applying anything and without creating a migration history (despite the name — it is a generic schema-comparison tool, safe to use in this push-only setup):

```bash
pnpm --filter @starter/db exec prisma migrate diff \
  --from-config-datasource \
  --to-schema=./prisma/schema \
  --script
```

`--from-config-datasource` reads the source database URL from `prisma.config.ts`. To preview the diff against a prod-equivalent database (read replica, recent snapshot, or prod-clone branch), set that URL in `prisma.config.ts` temporarily — Prisma 7 removed the `--from-url` flag in favor of config-file-based URLs. `--to-schema` points at the schema folder you are about to deploy and accepts either a file or a directory.

The output is the full DDL (`CREATE TABLE`, `ALTER TABLE`, `DROP COLUMN`, etc.) that would bring the source DB up to the new schema. Read every `DROP`, `ALTER`, and `NOT NULL` line. If the diff matches what the recipes in [schema-changes-recipe.md](./schema-changes-recipe.md) lead you to expect, approve the deploy and flip `APPLY_SCHEMA=dangerous`. If something unexpected appears (a column you didn't intend to drop, a type change you didn't author), stop and investigate — production state has likely drifted from what your local DB reflects.

This step is mandatory before any `APPLY_SCHEMA=dangerous` deploy. It is the closest analog to "review the migration SQL in the PR" that the migration-file model gives you for free.

## Keeping the Dockerfiles in sync

The repo ships three production Dockerfiles: `Dockerfile` (Hono server + SSR + web SPA), `Dockerfile.worker` (BullMQ consumer), and `Dockerfile.db-applier` (the one-shot backup/restore/apply applier, also used for the nightly dump cron and as the Dokploy schema leader). The first two share the `base` / `build-base` / `builder` / `prod-deps` stage structure and the `scripts/docker-entrypoint.sh` entrypoint. Both ship the Prisma CLI + `postgresql-client` by default so either can be the entrypoint schema leader on a given deploy — `APPLY_SCHEMA` decides (see "Who runs the push" above). The db-applier image has its own entrypoint and no default command; its Postgres client major must stay in step with the other two (`pnpm docker:check-copy` fails on drift).

**When you change one, open the other and check whether it needs a matching change.** Common cases:

- **Bumping the Node or pnpm version** in `FROM node:*` / `corepack prepare pnpm@*` — update both.
- **Adding or removing a workspace package** (`packages/foo/package.json`) — update the `COPY` lists in both builder + prod-deps stages of both files.
- **Editing `scripts/docker-entrypoint.sh`** — both images use it; re-check that the env-var validation still covers what each image needs and that the `APPLY_SCHEMA` handling still matches reality.
- **Adding a system package to a stage** — include it in every runtime that uses it. Both app images need `postgresql-client` and the Prisma CLI for schema leadership or follower admission (`WAIT_FOR_SCHEMA=true` needs psql to hold the read-only admission lock and Prisma to compare the live schema, even when that image never applies schema — a separate applier image does not make a stripped follower viable), and embedded background execution means any package a job handler shells out to must be present in the server image too, not just the worker.
- **Changing the schema-sync story** — either app image runs `scripts/db-applier.sh apply` on boot when `APPLY_SCHEMA != off` on that container. If you touch that logic, preserve the "one leader per deploy" discipline and the advisory lock, and update [infra-notes.md](../infra-notes.md) + this doc to match.

## Seed data

For repeatable seed data (dev/test fixtures), create a seed script in `packages/db/`:

```ts
// packages/db/prisma/seed.ts
import { PrismaClient } from "../src/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.user.upsert({
    where: { email: "dev@example.com" },
    update: {},
    create: {
      email: "dev@example.com",
      name: "Dev User",
    },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
```

Run it with:

```bash
pnpm --filter @starter/db exec prisma db seed
```

Use `upsert` so the script is idempotent — safe to run multiple times without duplicating data.

## Prisma enum serialization gotcha

Prisma enum fields serialize as objects (not plain strings) over JSON. If your model has enums, you must coerce them to strings before returning from a procedure — otherwise the client receives `{ value: "PUBLISHED" }` instead of `"PUBLISHED"`.

See [server-procedures.md § Prisma enum serialization](./server-procedures.md#prisma-enum-serialization) for the `serializeX()` pattern.

## Quick reference

| Task | Command |
|---|---|
| Apply schema changes to local DB | `pnpm db:push` |
| Apply destructive schema changes to local DB | `pnpm db:push:dangerous` |
| Apply schema changes in production | Dokploy: manually select one immutable Git release on every role, run the applier (or app leader), then deploy followers; ordinary leader `safe`, followers `off` + `WAIT_FOR_SCHEMA=true`. `dangerous` requires the confirm two-step and cleanup back to `safe`. See [infra-notes.md](../infra-notes.md). |
| Reset local DB | `bash scripts/compose.sh -f docker-compose.dev.yml down -v && pnpm dev:services && pnpm db:push` (the documented dev-stack reset — see AGENTS.md § Safe alternatives) |
| Seed the database | `pnpm --filter @starter/db exec prisma db seed` |
| View DB in browser | `pnpm db:studio` |
| Regenerate Prisma client | `pnpm db:generate` (usually handled by `postinstall`) |
