# Removing (and Restoring) Background-Job Queues

The starter ships BullMQ jobs in `packages/queue/` and a shared consumer runtime in `apps/worker/`. **To omit the separate worker container, keep the code and use `WORKER_MODE=embedded` on the app.** All jobs and backup monitoring remain available. This removal recipe is only for intentionally eliminating background jobs themselves, not for reducing the container count.

This doc is the inverse of [patterns/queue.md](../queue.md). Read that one if you intend to *use* background queues. Read this one if you intend to remove them. Despite this file's historical name, **Redis itself is not a removable queue detail** in the current architecture.

## When to remove

If your app has no scheduled jobs, deferred sends, retry/backoff requirements, or work that should outlive an HTTP request, the BullMQ worker is dead weight. Removing it eliminates one container, the worker app, BullMQ, and the queue administration/demo surface. It does **not** eliminate Redis, `REDIS_URL`, `ioredis`, or the minimal `@starter/queue` connection package: the server's fail-closed rate limiters and readiness check depend on them.

## What removing loses

Everything the BullMQ + worker pair gives you:

- **Background processing** — any work the server enqueues today runs synchronously inside the request instead. If your handlers are slow, the user waits.
- **Retries with exponential backoff** — `defaultJobOptions.attempts: 3` with exponential backoff in `packages/queue/src/index.ts` is gone. Failed work is just a thrown error.
- **Deferred / delayed jobs** — `queue.add(name, data, { delay })` no longer exists. There is no background scheduling primitive after the worker is removed.
- **Decoupled scaling** — the worker container could scale independently of the HTTP server. Without it, every long task runs in the request path.
- **The echo demo and jobs inspector** — `queue.enqueueEcho`, `queue.getJob`, and `queue.listFailed` (in `packages/api/src/routers/queue.ts`), the `/admin/jobs` page, the `handleEchoJob` handler that upserts an `AppSetting` row (`apps/worker/src/handlers/echo.ts`), and its test (`apps/worker/src/handlers/echo.test.ts`) all go away.
- **Server-verified asset metadata.** The asset upload flow uses presigned PUTs (browser → S3 directly) and the `analyze-asset` worker job re-derives `width`/`height`/`blurhash` from the stored bytes after each upload finalizes. Without the worker, those columns reflect whatever the client claimed at presign time and `metadataState` stays `"CLIENT_HINT"` forever. That's fine for visual data — the worst outcome is a slightly-wrong placeholder gradient — but unsuitable when you need pixel-derived metadata to be authoritative. If that matters, keep the queue. See [patterns/assets.md § Running without the worker](../assets.md#running-without-the-worker).
- **Asset cleanup — both the daily cron and the admin button.** The `cleanup-assets` BullMQ job (cron at 03:15 UTC + the **Run cleanup** button at `/admin/assets/cleanup`) sweeps orphan `PENDING` upload rows (heartbeat older than 5 min), unreferenced S3 objects under `assets/` (older than 15 min), and incomplete multipart uploads (older than 24 h). Without the worker, **neither path works**: the cron doesn't fire, and the admin button would enqueue a job no one consumes. Pick an alternative cleanup strategy from [patterns/assets.md § Alternative cleanup strategies](../assets.md#alternative-cleanup-strategies) (S3 lifecycle rules are the no-infrastructure default), and remove `cleanupEnqueue` plus the **Run cleanup** UI so the app cannot create stranded jobs. The read-only `cleanupDryRun` procedure and preview may remain if useful.

- **The seed admin button.** The **Run seed** button at `/admin/seed` enqueues a `seed` BullMQ job that runs `runSeed()` (`packages/db/prisma/seed.ts`). Without the worker the job is never consumed and the page sits on "Job enqueued, waiting…" forever. Unlike asset cleanup, this one has a clean inline replacement — seeds are required to be short — so you do **not** lose the feature, you just move it onto the request path. Follow [§ Running a short job inline without the queue](#running-a-short-job-inline-without-the-queue) below; the `prisma db seed` CLI keeps working regardless. (If you don't want the admin trigger at all, remove it via [removable/seed.md](./seed.md) instead — then the inline swap is moot for seed.)

If you later need any of the above, follow the **Adding back** section.

## What you'll lose besides background jobs

Several systems lean on the worker beyond their own routers, so removing it has knock-on effects to plan for. Do not remove the worker while leaving one of these producers wired to jobs that can no longer run.

Redis has separate, non-job consumers that must remain:

- `apps/server/src/rate-limit.ts` uses the shared connection for fail-closed authentication, API, upload, and other security rate limiters.
- `apps/server/src/index.ts` pings Redis for readiness and disconnects the shared client during shutdown.
- If chat remains behind a replacement/external executor, `packages/api/src/lib/chat-rate-limit.ts`, chat event publication, and `apps/server/src/chat-subscriber.ts` still require the shared connection plus a dedicated pub/sub connection. The Postgres replay path makes live delivery best-effort; it does not make the chat rate limiter optional.

Consequently, removing background jobs never means making the server boot without Redis or weakening these controls. A future architecture may extract the connection into a package named `@starter/redis`; until that complete repo-wide migration exists, retain the minimal `@starter/queue` package and its server dependency.

### Chat runs and stale-run recovery stop

`chat-run` performs the streamed assistant run, while `reap-stale-chat-runs` releases sessions whose worker disappeared. Removing either consumer while keeping the current chat producer can leave sessions permanently `RUNNING`. Remove chat via [add-ins/chat.md](../add-ins/chat.md), or replace both execution and stale-run recovery before deleting the queue.

### Scheduled maintenance jobs stop

`reap-expired-auth-tokens` (expired verification/reset tokens) and `check-backup-freshness` (the backup staleness alert) are cron-scheduled worker jobs with no other trigger. Removing the worker silently stops both: tokens accumulate, and a stalled backup pipeline no longer raises an operational alert. Replace each with an external scheduler before deleting the worker, or accept the loss deliberately.

### Asset cleanup cron stops

Already covered above — the daily orphan-asset sweep at 03:15 UTC, the mutating **Run cleanup** action, and metadata re-derivation after each upload all stop. The read-only `cleanupDryRun` procedure and preview are server-side and may remain; they inspect what cleanup would find without enqueuing or deleting anything. See [patterns/assets.md § Cleanup](../assets.md#cleanup--orphan-pending-rows-and-unreferenced-s3-objects) for replacement mutation strategies (S3 lifecycle rules are the no-infrastructure default).

## Running a short job inline without the queue

Some jobs are short enough to run **synchronously inside the HTTP request** instead of deferring them to the worker. When you remove BullMQ, that is the replacement for those jobs: keep the admin trigger, drop the enqueue, `await` the work directly, and return its result instead of a job id. The **seed admin button** is the canonical one and the template ships it pre-shaped for the swap.

**This is only safe for genuinely short work.** The request thread is blocked for the entire duration and the work **cannot be cancelled** once started — a timeout returns an error to the browser while the database keeps being written. Hard rules:

- **Seconds, not minutes.** If the job can exceed a few seconds, keep the queue. It will hit the server request timeout, the rate limiter, or a reverse-proxy/load-balancer timeout long before it finishes — and you'll have a half-applied write with no retry.
- **No retries, no backoff.** BullMQ's `attempts`/backoff are gone. A failure is just a thrown error surfaced to the operator.
- **Idempotent or bust.** A blocked request the user reloads becomes a second concurrent run. The work must tolerate that (the seed is required to be idempotent for exactly this reason).
- **One trigger only.** This pattern is for operator-initiated, on-demand actions (a button an admin clicks), never for per-user or high-frequency paths.

### Worked example — the seed button

`runSeed()` (`packages/db/prisma/seed.ts`) is already a plain exported function, so the swap is mechanical. The producer (`packages/api/src/routers/seed.ts`) carries a marked comment block at the enqueue site pointing here.

**Before (queue path, as shipped):**

```ts
import { seedQueue } from "@starter/queue";
// …
run: adminOr404Procedure
  .input(z.object({ confirm: z.string() }))
  .handler(async ({ input, context }) => {
    // …confirm-phrase check unchanged…
    const job = await seedQueue.add("seed", { requestedBy: context.session.user.id });
    return { jobId: job.id ?? null };
  }),
```

**After (inline, queue removed):**

```ts
import { runSeed } from "@starter/db/seed";
// …
run: adminOr404Procedure
  .input(z.object({ confirm: z.string() }))
  .handler(async ({ input }) => {
    // …confirm-phrase check unchanged…
    // INLINE — blocks the request. Only safe because the seed is required to
    // be short + idempotent (see the rules above). No retry, no cancel.
    const result = await runSeed();
    return { result };
  }),
```

Then simplify the UI (`apps/web/src/routes/$lang/_app/admin/seed.tsx`): delete the `jobStatus` `queue.getJob` poll and the `activeJobId` state; render `run.data.result.summary` directly from the mutation result instead of from the polled job. The `seed.info` query, the confirm dialog, and the production phrase gate are unchanged. Drop the `seed` entries from `queuesByName`/`queueNameSchema` in `packages/api/src/routers/queue.ts` (they vanish with the file anyway during full removal — see step 5 below). The `apps/worker/src/handlers/seed.ts` handler and its test are deleted along with `apps/worker/` in step 2.

The reverse (restoring the queue) is the same swap backwards; the canonical "how to add a job" reference is [patterns/queue.md](../queue.md).

## Removal steps

### Maintain the endpoint baseline

This removal deletes `queue.*` procedures covered by `scripts/access-matrix-pre-notes-baseline.json`. In the **same reviewed change**, remove only those exact `queue.*` entries from that baseline after deleting their router registration, then run `pnpm policy:access-matrix`. The compatibility floor remains enforced after onboarding too; never regenerate or silently auto-rebaseline it.

Work top-to-bottom; every path is absolute from the repo root.

**Prerequisite — account for every job producer before deleting contracts.** The current producers live in `packages/api/src/routers/{seed,chat,queue}.ts` and `apps/server/src/asset-routes.ts`. Remove the owning chat feature or supply its fully tested replacement; apply the inline seed recipe; remove queue inspection; remove asset cleanup enqueue/UI; and remove the `analyzeAssetQueue` enqueue from asset finalization (leaving metadata at `CLIENT_HINT`) unless you provide a synchronous/external analyzer. Use `rg -n 'Queue|enqueue|QUEUE_NAMES|\.add\(' packages/api/src apps/server/src` after the edits rather than trusting this list forever. Do not shrink `packages/queue` while any producer still imports a job export.

**Prerequisite — remove every stored Job Scheduler before deleting its queue.**
Run these exact removals once against each deployment's Redis while the current
queue package and environment still exist:

```ts
await cleanupAssetsQueue.removeJobScheduler(CLEANUP_ASSETS_JOB_SCHEDULER_ID);
await reapStaleChatRunsQueue.removeJobScheduler(REAP_STALE_CHAT_RUNS_JOB_SCHEDULER_ID);
await reapExpiredAuthTokensQueue.removeJobScheduler(
  REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID,
);
await checkBackupFreshnessQueue.removeJobScheduler(
  CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID,
);
```

Those four are the template's current known inventory, not a future-proof
allowlist. Before deletion, call `getJobSchedulers()` on **every queue being
removed**, record each exact queue/`entry.key` pair, and remove every returned
scheduler with that same queue's `removeJobScheduler(entry.key)`. Do not use
`entry.id`; that is optional job-template metadata, not the scheduler
identifier. Investigate unexpected keys before removing them so you do not
erase another deployment's work from a
shared Redis instance. Re-inventory every queue afterward and require every
result to be empty. Do not use a fuzzy name match and do not assume deleting the
worker registration clears Redis. If a feature-specific removal already
removed a known ID, a `false` result is harmless; the empty final inventory is
authoritative.

1. **Shrink the queue package to the shared Redis connection; do not delete it.** In `packages/queue/`, keep `src/connection.ts`, `package.json`, and `tsconfig.json`. Delete the BullMQ-only job contracts, helpers, and tests (`src/jobs.ts`, `src/ensure-job.ts`, and their tests). Rewrite `src/index.ts` to export only `createRedisConnection` and `redisConnection` from `./connection.js`; remove every `Queue`, `Worker`, job-schema, and enqueue export. In `package.json`, keep `@starter/env` and `ioredis`, remove `bullmq`, and remove the test script/`vitest` if no tests remain. Keep both `.` and `./connection` exports so existing server imports remain valid.

2. **Delete the whole worker app, not a hand-maintained handler allowlist.** Remove `apps/worker/` recursively. That intentionally removes runtime entrypoints, handlers, tests, operational alerts, build configuration, and worker-only support code—not just the currently known jobs. Before continuing, list every file with `rg --files apps/worker` and account for every producer/feature using each handler; the chat consumers and the scheduled maintenance jobs above must already have been removed or replaced. This directory-wide instruction remains exhaustive when the template gains another handler.

3. **Drop the worker workspace registration.** `pnpm-workspace.yaml` is glob-based (`apps/*` / `packages/*`), so deleting `apps/worker/` is enough. `packages/queue/` remains registered as the shared Redis package.

4. **Remove the queue router from oRPC.** In `packages/api/src/routers/index.ts`:
   - Delete the `import { queueRouter } from "./queue";` line.
   - Delete the `queue: queueRouter,` line from the `appRouter` object.
   - **Do not** delete `seed: seedRouter` / its import — convert it to the inline path instead (next step).

5. **Convert the seed router to the inline path, then delete the queue procedure file and jobs page.** Apply the before/after from [§ Running a short job inline without the queue](#running-a-short-job-inline-without-the-queue) to `packages/api/src/routers/seed.ts` and simplify `apps/web/src/routes/$lang/_app/admin/seed.tsx` as described there. Then remove `packages/api/src/routers/queue.ts` and `apps/web/src/routes/$lang/_app/admin/jobs.tsx` (the `queue.getJob` polls and `queue.listFailed` page are gone). Remove the Jobs nav item from `apps/web/src/routes/$lang/_app/admin.tsx`, delete the `nav.jobs` locale key, and remove the `admin.jobs.*` locale keys.

6. **Drop `@starter/queue` only from packages that no longer consume Redis.** Once every job producer and chat-specific Redis consumer has been removed, remove `"@starter/queue": "workspace:*"` from `packages/api/package.json`. If a replacement chat executor retains Redis publication or chat rate limiting, keep the API dependency. **Always keep it in `apps/server/package.json`**: rate limiting, readiness, shutdown, and (when retained) chat subscription import the shared Redis connection.

7. **Preserve Redis configuration and local infrastructure.** Keep `REDIS_URL` in `packages/env/src/vars/shared.ts`, `scripts/lib/env-manifest.ts`, `.env.example`, `scripts/docker-entrypoint.sh`, and every deployment environment. Keep the Redis service and volume in `docker-compose.dev.yml`. The server must continue to fail configuration validation when `REDIS_URL` is absent and fail readiness when Redis is unavailable; do not turn a security dependency into an optional best-effort service as part of queue removal.

8. **Remove worker scripts from the root `package.json`.** Delete `"dev:worker": "turbo -F worker dev"` from `scripts`. There are no other worker-scoped scripts at the root.

9. **Remove BullMQ, not ioredis.** Remove `bullmq` from the surviving `packages/queue/package.json`; keep `ioredis` for `src/connection.ts`. The worker package disappears with `apps/worker/`. Remove the `knip.jsonc` `apps/worker` block and any other worker-only static-analysis entry. Remove the server's `worker` workspace dependency, `worker/runtime` imports/start/drain hooks and bundler matcher; remove `WORKER_MODE` from its schema, manifest, and deployment settings. Remove `consumer-health.ts`, its tests/export, and the consumer part of `/ready` only after all producer replacement checks above pass. Preserve Postgres/Redis readiness and HTTP shutdown ordering. Regenerate the lockfile and env examples.

10. **Delete the worker Dockerfile and prune every worker reference from the remaining Docker surface.** Remove `Dockerfile.worker` from the repo root. In the server `Dockerfile`, delete the stale worker workspace COPY line:

    ```dockerfile
    COPY apps/worker/package.json apps/worker/
    ```

    Also remove or rewrite its comments that compare server and worker stages, worker schema leadership, frontend build arguments, or worker image contents. Check `Dockerfile.dev` and `docker-compose*.yml` for worker build/service references. Keep `COPY packages/queue/package.json packages/queue/` in both server stages: it is a runtime dependency of the HTTP server. A leftover worker line points at a directory that no longer exists and fails `docker build`.

11. **Update hard-coded scripts and all CI/release consumers.** Deleting the directory and Dockerfile is not enough; several checks enumerate them rather than discovering them:

    - In `scripts/check-docker-copy.ts`, remove `Dockerfile.worker` from `DOCKERFILES` and rewrite the two-image comments. Keep checking the server Dockerfile.
    - In `scripts/check-load-dotenv-contract.ts`, remove both `apps/worker/src/bootstrap.ts` and `apps/worker/src/index.ts` entrypoint contracts. Update the corresponding entrypoint table in [environment-variables](../environment-variables.md), and remove worker-only prose from `scripts/sync-env-example.ts` / `scripts/lib/env-manifest.ts` before running `pnpm env:sync`.
    - In `.github/workflows/pr-checks.yml`, remove `Dockerfile.worker` and `apps/worker` from explicit policy/destructive-scan input lists and remove the worker image build. Preserve the server image scan and the policies themselves.
    - In `.github/workflows/build-image.yml`, remove the worker matrix entry and rewrite its “both images” comments. A one-entry server matrix may remain or be simplified.
    - In `.github/workflows/release.yml`, remove the worker image build/publish job, worker outputs/dependencies, and worker line from the release summary. A release must no longer claim an image it did not publish.
    - Remove `Dockerfile.worker` / `apps/worker/**` ownership or matching rules from `.github/labeler.yml`; rewrite the Docker comment in `.github/dependabot.yml` while retaining the server Docker update entry.

    Run the affected script checks after editing. Do not delete a check merely because one of its inputs disappeared.

12. **Update deployment, infrastructure, environment, and schema documentation.** Update `infra-notes.md` and every deployment walkthrough, not only the platform you currently use: `patterns/deployment-vps.md`, plus `patterns/schema-push.md`, `patterns/backup-and-restore.md`, `patterns/agent-ui-testing.md`, `patterns/turbo-remote-cache.md`, and environment-variable guidance. Drop the worker process/Application/container, image commands, watch paths, health/log instructions, worker-only env ownership, and two-image/schema-leader claims. Preserve Redis, the server's `REDIS_URL`, and its network access to Redis. On Dokploy keep the existing applier if selected, otherwise keep the app entrypoint leader; its ordinary Git setting remains `safe`, with `off` + `WAIT_FOR_SCHEMA=true` on the app only when it is a follower. Describe Prisma/psql contents for the one surviving app image. Remove worker-only variables only when no remaining server or inline implementation reads them; use the manifest and `pnpm env:sync`, not hand-edits to generated `.env.example`.

13. **Update product, pattern, and agent documentation.** Review the full patterns index and every feature/removal recipe that points at a worker handler or `Dockerfile.worker`; either remove the obsolete instruction or explain the chosen inline/external replacement. Update root `README.md`, `SECURITY.md`, `THIRD-PARTY-LICENSES.md`, and `AGENTS.md` where applicable. Replace the **Dockerfiles — keep server and worker in sync** agent rule with single-server-image guidance while preserving the surviving Redis package requirement. Run `pnpm sync:agent-docs` so `CLAUDE.md`, `.cursorrules`, and `.github/copilot-instructions.md` match the canonical file.

14. **Decide what to do with `patterns/queue.md`.** Two options:
    - Delete it. Cleaner, but you lose the recipe if you ever want it back. (You can always read it from git history.)
    - Leave it in place as a "how to add this back" reference. It will dangle from `patterns/README.md`, so update that index if you delete the file.

15. **Prune the lockfile.** Run `pnpm install` from the repo root. This drops BullMQ, worker-only dependencies, and the worker workspace importer. It deliberately retains `ioredis` and the `packages/queue` importer. Check the diff rather than assuming every worker-only package disappeared; another workspace may still use one.

16. **Run a search-based completeness audit, then verify the job surface and Redis security.** A finite path list becomes stale as the template grows. After the edits, run at least:

    ```bash
    rg -n -i 'apps/worker|Dockerfile\.worker|worker image|worker container|worker service|worker package|BullMQ worker' \
      --hidden --glob '!**/node_modules/**' --glob '!pnpm-lock.yaml'
    rg -n 'from "bullmq"|new (Queue|Worker)|QUEUE_NAMES|\.add\(' \
      apps packages scripts .github --glob '!**/node_modules/**'
    rg --files apps/worker
    ```

    The final command must report that the directory does not exist. Classify every other hit: remove stale worker/runtime references; keep intentional “how to restore background jobs” prose only when it is accurate and does not claim the worker is installed. This audit supplements the mandatory consumers in steps 10–13; it does not replace them.

    ```bash
    pnpm build
    pnpm test
    pnpm dev:server   # with REDIS_URL set and Redis running
    ```

    Imports of `redisConnection` or `createRedisConnection` from `@starter/queue` in the server (and retained chat code) are expected. Confirm the readiness endpoint succeeds with Redis up and fails when Redis is unavailable. The existing `apps/server/src/rate-limit.test.ts` suite replaces `RateLimiterRedis` with `RateLimiterMemory`; it proves middleware headers, rejection behavior, and configured fail-open/fail-closed error handling, **not Redis round trips**. Run it as a unit gate, then separately perform a real-Redis integration/manual check: start the dev Redis service, boot the server with its normal `RateLimiterRedis` instances, exhaust a disposable key on a limited endpoint, observe the Redis key/TTL and 429 response, and verify a fail-closed auth surface returns 503 when Redis is stopped. Do not describe the memory-backed suite as integration coverage.

## Adding it back

The cleanest restore is a `git revert` of the commit(s) that removed the queue. If you removed it long ago and don't want a revert, do this instead:

1. **Restore the directories and files from git history.**

   ```bash
   git checkout <pre-removal-sha> -- apps/worker
   git checkout <pre-removal-sha> -- packages/queue/src/index.ts packages/queue/src/jobs.ts packages/queue/src/jobs.test.ts packages/queue/src/ensure-job.ts packages/queue/src/ensure-job.test.ts
   git checkout <pre-removal-sha> -- packages/api/src/routers/queue.ts
   git checkout <pre-removal-sha> -- Dockerfile.worker
   ```

   Also restore the BullMQ dependency, tests/scripts, and exports in `packages/queue/package.json`. Re-add only `COPY apps/worker/package.json apps/worker/` to the server `Dockerfile` builder stage; the surviving queue package COPY lines never left. `pnpm docker:check-copy` will flag a missing worker line.

2. **Re-register the router.** In `packages/api/src/routers/index.ts`, re-add the `import { queueRouter } from "./queue";` line and the `queue: queueRouter,` field on `appRouter`.

3. **Re-add the API workspace dep if removal dropped it.** Put `"@starter/queue": "workspace:*"` back into `dependencies` of `packages/api/package.json`. The server dependency stayed throughout.

4. **Keep the existing Redis configuration.** `REDIS_URL`, local Redis, the deployment Redis service, and the server wiring were never removed. The restored worker reads the same shared variable and connects to the same instance.

5. **Re-add `"dev:worker": "turbo -F worker dev"`** to the root `package.json` scripts.

6. **Re-add the worker image to CI.** In `.github/workflows/build-image.yml`, add the `worker` entry back to the `matrix.include` list (pointing at `./Dockerfile.worker`).

7. **Re-add the worker container and its `REDIS_URL` wiring** to your production deploy config. On Dokploy that means a second Application built from `Dockerfile.worker`, on the same project network, with the same `REDIS_URL` (and `DATABASE_URL`) as the server. The Redis service and server wiring remain unchanged. See [patterns/deployment-vps.md](../deployment-vps.md).

8. **Restore the AGENTS.md sync rule.** Put the **Dockerfiles — keep server and worker in sync** section back into `AGENTS.md` and run `pnpm sync:agent-docs`.

9. **Reinstall.**

    ```bash
    pnpm install
    pnpm dev:services    # starts Redis
    pnpm dev             # starts server + worker together
    ```

10. **Read [patterns/queue.md](../queue.md)** for the canonical reference on adding new jobs once the system is back in place.

## Sanity checks

**After removal:**

- `pnpm build` succeeds (no `Cannot find module '@starter/queue'`).
- `pnpm test` succeeds (no leftover `apps/worker` or `packages/api` queue test importing the deleted code).
- `pnpm dev:server` boots with Redis running and its readiness endpoint reports Redis healthy.
- Starting the server without `REDIS_URL` still fails env validation; taking Redis down makes readiness fail rather than silently disabling rate limits.
- Grep the repo for `bullmq`, queue constructors, job schemas, and worker imports; no runtime job surface remains. Hits for `@starter/queue`, `ioredis`, `REDIS_URL`, `redisConnection`, and `createRedisConnection` are expected for server security/readiness and any retained chat pub/sub path.

**After adding back:**

- `pnpm dev:services` starts the Redis container and `redis-cli ping` returns `PONG`.
- The worker logs `[worker] Redis is reachable.` and `Worker started — listening for jobs…` on startup.
- Enqueue a test job from a tinker shell or by calling `orpc.queue.enqueueEcho` from the client, then confirm the worker logs `[echo] Job <id> completed` and the `AppSetting` row with key `echo:last` exists in Postgres.
