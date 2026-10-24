# Removing (and Re-adding) the Admin Seed Trigger

The starter ships an operator-facing trigger for the database seed: an admin page at `/$lang/admin/seed` with a type-to-confirm **Run seed** button (a deliberately stricter phrase in production), a `seed` oRPC router that validates the phrase server-side, and a BullMQ `seed` queue + worker handler that runs `runSeed()` off the request path and reports a per-step summary back to the page. It is a *mechanism* around the seed script — the script itself (`packages/db/prisma/seed.ts`) is a separate thing and **stays** regardless of this removal.

## When to remove

If your product never seeds data through the running app — no demo-data resets, no operator-triggered fixture loads, no staging environments an admin re-seeds from the browser — the admin trigger is dead weight: an extra admin page, an extra oRPC router, an extra BullMQ queue and worker, and a production foot-cannon surface (a button that writes to the live database) you carry for nothing. Local and CI seeding via `prisma db seed` / `pnpm db:seed` does not use any of it.

Removing the seed *admin trigger* is independent of removing the *queue* ([removable/queue.md](./queue.md)) — see the interaction note under Removal steps.

## What removing loses

You lose the ability to run the seed from inside the app: the `/admin/seed` page, the confirm-phrase gate, and the job-status polling that renders the per-step summary. After removal, seeding is a shell-only operation. `pnpm db:seed` is **not** a production path: it runs `scripts/assert-local-database.sh` first, which allows only `localhost` / `127.0.0.1` / `::1` / `host.docker.internal` and explicitly rejects `postgres`, `db`, and the `10.*` / `172.16-31.*` / `192.168.*` ranges. The raw `pnpm --filter @starter/db exec prisma db seed` skips that guard entirely — it is the only form that can reach a remote database, which is exactly why it should not be used casually. Seeding production, if you ever truly need it, is a deliberate, guard-bypassing act, not a button and not a routine command.

**What stays — do not delete these.** The seed *script* path is not part of this module:

- `packages/db/prisma/seed.ts` — `runSeed()`, the seed logic itself (a template stub until you write it).
- `packages/db/prisma/seed.cli.ts` — the standalone CLI wrapper `prisma db seed` executes.
- The `db:seed` script and the `"./seed"` export entry in `packages/db/package.json`.
- The `packages/db/prisma/seed.cli.ts` row in the dotenv-loading entrypoint table ([patterns/environment-variables.md](../environment-variables.md)).

See [patterns/schema-push.md § Seed data](../schema-push.md#seed-data) for the CLI path that keeps working.

## Removal steps

### Maintain the endpoint baseline

This removal deletes `seed.*` procedures covered by `scripts/access-matrix-pre-notes-baseline.json`. In the **same reviewed change**, remove only those exact `seed.*` entries from that baseline after deleting their router registration, then run `pnpm policy:access-matrix`. The compatibility floor remains enforced after onboarding too; never regenerate or silently auto-rebaseline it.

> **Deploy config:** no changes needed. The seed trigger has no dedicated environment variables (the confirm phrase derives from `NODE_ENV`), no extra service, and nothing wired into the deploy config — so there is also nothing to touch in `packages/env` or `scripts/lib/env-manifest.ts`.

> **Interaction with [removable/queue.md](./queue.md):** the two removals meet at the seed button, from opposite sides.
> - **Queue removed, seed trigger kept** → do *not* follow this doc; follow [removable/queue.md § Running a short job inline without the queue](./queue.md#running-a-short-job-inline-without-the-queue), which converts `seed.run` to a synchronous inline `runSeed()` call instead of an enqueue (the marked comment block in `packages/api/src/routers/seed.ts` points there).
> - **Seed trigger removed (this doc), queue kept** → that inline-swap worked example becomes moot for seed — the router file carrying the marked comment block is deleted below. The inline pattern itself remains valid for other short operator-triggered jobs.
> - **Removing both** → do this doc first; it shrinks removable/queue.md's step list (its seed-conversion step no longer applies).

1. **Delete the oRPC router.** Delete `packages/api/src/routers/seed.ts` and `packages/api/src/routers/seed.test.ts`. Then in `packages/api/src/routers/index.ts` remove the `import { seedRouter } from "./seed";` line and the `seed: seedRouter,` entry in the `appRouter` object.

2. **Delete the admin page.** Delete `apps/web/src/routes/$lang/_app/admin/seed.tsx`. The generated `apps/web/src/routeTree.gen.ts` updates itself on the next `pnpm dev` / `pnpm build` — don't hand-edit it.

3. **Remove the admin-nav entry.** In `apps/web/src/routes/$lang/_app/admin.tsx`, delete the `NAV_ITEMS` entry whose `to` is `"/$lang/admin/seed"` (label `t("nav.seed")`, icon `Database`), and remove `Database` from the `lucide-react` import at the top — the seed item is its only consumer in this file.

4. **Remove the queue surface.** The `seed` queue exists only for this button (on-demand, no cron), so it goes too:
   - `packages/queue/src/jobs.ts` — delete the `seedJobSchema` declaration with its doc comment and the `export type SeedJobData = z.infer<typeof seedJobSchema>;` line, and delete `seed: "seed",` from the `QUEUE_NAMES` object.
   - `packages/queue/src/index.ts` — delete the `export const seedQueue = new Queue(QUEUE_NAMES.seed, {...});` block with its doc comment, and remove `type SeedJobData,` and `seedJobSchema,` from the `export { ... } from "./jobs.js"` re-export list at the top.
   - `apps/worker/src/handlers/seed.ts` and `apps/worker/src/handlers/seed.test.ts` — delete both files.
   - `apps/worker/src/runtime.ts` — remove `SeedJobData` from the `@starter/queue` type import, the `import { handleSeedJob } from "./handlers/seed.js";` line, the `const seedWorker = createWorker<SeedJobData>(QUEUE_NAMES.seed, handleSeedJob, {...});` block with its `seedWorker.on("completed", ...)` / `seedWorker.on("failed", ...)` listeners, (shutdown tracking is automatic).
   - `packages/api/src/routers/queue.ts` — remove `seedQueue` from the `@starter/queue` import, the `[QUEUE_NAMES.seed]: seedQueue,` entry from `queuesByName`, and `QUEUE_NAMES.seed,` from the `queueNameSchema` enum. (This is the `queue.getJob` poll target the seed page used; the rest of the jobs page is untouched.)

5. **Remove the locale keys.** In `packages/locales/src/<locale>/admin.json` for **every** locale (`en-US`, `es-MX`, and any you've added): delete the `"seed"` key from the `nav` object and the entire `"seedPage"` object. A leftover key is harmless but is dead weight `pnpm i18n:translate` will keep carrying.

6. **Update `sitemap.md`.** Remove the `/{lang}/admin/seed` row from the route table. (It's an admin route, so `apps/server/src/seo.ts` `PUBLIC_PATHS` never listed it — nothing to do there.)

7. **Sweep docs and references.** Grep for `admin/seed`, `seedRouter`, `seedQueue`, `SeedJobData`, and `handleSeedJob`. Expected leftovers to update or knowingly accept in your fork:
   - [removable/queue.md](./queue.md) — the "seed admin button" knock-on bullet, the seed worked example under § Running a short job inline without the queue, and the removal step that converts the seed router. With the trigger gone these describe a surface you no longer have.
   - [patterns/queue.md](../queue.md) — the paragraph naming the seed button as the canonical inline-swap example.
   - [patterns/admin-dashboard.md](../admin-dashboard.md) — the `/$lang/admin/seed` row in the admin sections table.
   - [patterns/auth-and-routing.md](../auth-and-routing.md) — the `seed.tsx` line in the route-tree diagram.
   - The header comment in `packages/db/prisma/seed.ts` — it lists the three invocation paths; the BullMQ-worker and inline-admin paths no longer exist, leaving only the CLI.

8. **Verify.** Run `pnpm install && pnpm build && pnpm test && pnpm lint && pnpm check-types && pnpm docs:check-citations`. All must pass with no dangling references to `seedRouter`, `seedQueue`, or `handleSeedJob`.

## Adding it back

The reverse path. Nothing was dropped from the database — this module has no Prisma model — so re-addition is pure code restoration (cleanest source: this file's history, or the upstream template).

1. Restore `packages/api/src/routers/seed.ts` + `seed.test.ts` and re-register `seed: seedRouter,` in `packages/api/src/routers/index.ts`. The router is two admin-gated procedures (`adminOr404Procedure` — see [patterns/admin-dashboard.md](../admin-dashboard.md)): `info` returns `{ isProduction, requiredConfirmPhrase }`, and `run` checks the confirm phrase server-side (`"SEED PRODUCTION"` when `NODE_ENV === "production"`, `"seed"` otherwise) before enqueueing `seedQueue.add("seed", { requestedBy: context.session.user.id })`.
2. Restore the queue surface: `seedJobSchema` / `SeedJobData` and `seed: "seed"` in `packages/queue/src/jobs.ts` (plus the re-export in `packages/queue/src/index.ts`), the `seedQueue` with `attempts: 1` (an author-written seed is not guaranteed safe to auto-retry), `apps/worker/src/handlers/seed.ts` + its test, and the worker registration in `apps/worker/src/runtime.ts` with `concurrency: 1` (two seed runs must never overlap) (shutdown tracking is automatic). Re-add `seedQueue` / `QUEUE_NAMES.seed` to `queuesByName` and `queueNameSchema` in `packages/api/src/routers/queue.ts` so the page can poll job status.
3. Restore `apps/web/src/routes/$lang/_app/admin/seed.tsx` and the `NAV_ITEMS` entry (with the `Database` icon import) in `apps/web/src/routes/$lang/_app/admin.tsx`.
4. Restore the `nav.seed` and `seedPage.*` keys in `packages/locales/src/en-US/admin.json`, then run `pnpm i18n:translate` to fill every non-default locale.
5. Re-add the `/{lang}/admin/seed` row to `sitemap.md`, and re-point the doc references from removal step 7.

## Sanity checks

**After removal:**

- `pnpm build && pnpm test && pnpm lint && pnpm check-types` all pass.
- `pnpm docs:check-citations` passes (you touched pattern docs in step 7).
- `grep -rn 'seedRouter\|seedQueue\|SeedJobData\|handleSeedJob\|admin/seed' apps packages` returns zero source hits (doc mentions you chose to keep are fine).
- Boot the app, sign in as an admin: `/admin` no longer shows a **Seed** nav item, and `/$lang/admin/seed` 404s.
- `pnpm db:seed` still runs against your local database — the guarded CLI path is untouched.

**After re-addition:**

- `pnpm build && pnpm test && pnpm lint && pnpm check-types` all pass.
- End-to-end smoke test with the worker running (`pnpm dev`): visit `/admin/seed`, type the confirm phrase, run the seed, and confirm the page progresses from "Job enqueued, waiting…" to the per-step summary.
