# Removing (and Re-adding) Web Push Notifications

The starter ships a complete web push notification stack: VAPID keys, a `PushSubscription` Prisma model, an oRPC `push` router, a server-side `web-push` sender, and a client hook.

## When to remove

If your app communicates with users only via email, in-app toast, or in-app badges, the entire push stack is dead weight. Removing it deletes the `web-push` Node dependency, the `PushSubscription` Prisma model and its table, the VAPID environment variables, the VAPID key generation script, the server-side sender, the oRPC `push` router, and the client subscription hook: fewer dependencies, a smaller schema, fewer production env vars, one less surface to secure.

## What removing loses

You lose the ability to deliver push notifications to users' devices via the browser Push API / Service Worker — both foreground and background. Other notification channels are unaffected: email (Better-Auth flows, transactional mail), in-app toasts (sileo), in-app badges, and BullMQ background jobs all keep working. You can still ship a service worker for offline support; only the push subscription / `PushManager` paths go away.

## Removal steps

For a deployed app, first remove the runtime feature while retaining `PushSubscription` and its `User` relation in Prisma. Defer step 5 to a separate approved contract release after the code-only release has been verified. Follow [schema changes § Remove a deployed feature's tables](../schema-changes-recipe.md#remove-a-deployed-features-tables); its retention, rollout, and confirmation rules apply throughout. The zero-model checks below describe the completed contract, not the intermediate release.

### Maintain the endpoint baseline

This removal deletes `push.*` procedures covered by `scripts/access-matrix-pre-notes-baseline.json`. In the **same reviewed change**, remove only those exact `push.*` entries from that baseline after deleting their router registration, then run `pnpm policy:access-matrix`. The compatibility floor remains enforced after onboarding too; never regenerate or silently auto-rebaseline it.

1. **Delete the server router.** Remove `packages/api/src/routers/push.ts` and `packages/api/src/routers/push.test.ts`.

2. **Delete the server sender.** Remove `packages/api/src/lib/web-push.ts`.

3. **Unregister the router from the app router.** Edit `packages/api/src/routers/index.ts`:
   - Remove the import on line 13: `import { pushRouter } from "./push";`
   - Remove the `push: pushRouter,` entry on line 53 of the `appRouter` object.

4. **Delete the client hook and its env shim.**
   - Remove `apps/web/src/hooks/use-push-notifications.ts`.
   - Remove the `declare module "web-push";` line from `apps/web/src/env.d.ts` (delete the file if that was its only line).
   - Grep for `usePushNotifications` and `use-push-notifications` once more to confirm no UI components import it. (At time of writing, nothing in `apps/web/src/components/**` or `apps/web/src/routes/**` consumes the hook — the starter ships the hook ready-to-use without a default UI surface.)

5. **Contract release only: drop the Prisma model.** The `PushSubscription` model lives in `packages/db/prisma/schema/auth.prisma`:
   - Delete the `pushSubscriptions PushSubscription[]` line from the `User` model (around line 27).
   - Delete the entire `model PushSubscription { ... }` block (around lines 140–152).
   - Apply locally with `pnpm db:push:dangerous` (this is a destructive change — Prisma will refuse to drop the table without `--accept-data-loss`). Before pushing, preview the exact SQL with `prisma migrate diff` (see [schema-changes-recipe § What `pnpm db:push` actually prints](../schema-changes-recipe.md#what-pnpm-dbpush-actually-prints)) — on Postgres `db push` prints a data-loss **warning block**, not a `[-] Dropped table` diff, so that is the only way to confirm the scope. It must drop only the `push_subscription` table and its index and nothing else. If it touches another table, stop and revert.
   - In production, use the platform's selected schema leader with `APPLY_SCHEMA=dangerous` and the confirmation two-step. Dokploy uses a manually pinned release: prefer the applier, otherwise the app (never the worker). After success or failure, clear confirmation/acceptance values and return that leader to `safe`; explicitly toggled platforms return it to `off`. See [infra-notes.md](../../infra-notes.md).
   - Follow [patterns/schema-changes-recipe.md](../schema-changes-recipe.md) if you are unsure about the review / apply mechanics.

6. **Remove server env vars.** In `packages/env/src/vars/server.ts`, delete from `serverVars`:
   ```ts
   VAPID_PUBLIC_KEY: z.string().optional(),
   VAPID_PRIVATE_KEY: z.string().optional(),
   VAPID_SUBJECT: z
     .string()
     .regex(/^(mailto:|https:)/, "VAPID_SUBJECT must be a mailto: or https: URL")
     .optional(),
   ```
   Also delete the partial-VAPID startup guard in `packages/env/src/server.ts` one directory up (the `vapidMissing` block that throws in production when only some of the three vars are set).

7. **Clean the env manifest and platform config.**
   - `scripts/lib/env-manifest.ts`: delete the three `VAPID_*` `ENV_VARS` entries and the now-empty `push` group. **Do not hand-edit `.env.example`** — it is generated from the manifest; run `pnpm env:sync` afterwards and commit the result. Leaving a manifest entry for a key the schema no longer declares fails `pnpm env:check` in CI, and leaving the key in the schema without a manifest entry fails it too.
   - Deploy config: remove the three `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` vars from your platform's env config (server Applications on Dokploy/VPS).
   - Verify: `pnpm env:check`.

8. **Remove the VAPID generation script.** In root `package.json`, delete:
   ```json
   "generate:vapid": "pnpm -F @starter/api exec web-push generate-vapid-keys",
   ```
   There is no separate `scripts/generate-vapid.*` file — the script is a one-liner that shells into `web-push` directly, so removing the line is sufficient.

 9. **Remove the npm dependency.** `web-push` is not in the pnpm catalog — it lives directly in `packages/api/package.json`. Delete both:
    - `"web-push": "^3.6.7"` from `dependencies`
    - `"@types/web-push": "^3.6.4"` from `devDependencies`

    Also delete `packages/api/src/types/web-push.d.ts` (the local module declaration).

 10. **Prune lockfile.** Run `pnpm install` from the repo root to remove `web-push` and `@types/web-push` from `pnpm-lock.yaml`.

 11. **Sweep docs and references.**
    - Grep for `VAPID`, `web-push`, `PushSubscription`, `pushSubscription`, `usePushNotifications`. Expected leftovers: README sections and `patterns/agent-tasks/rebrand.md` / `update-dependencies.md`. Update or remove these as appropriate for your fork.
    - Remove the push-notification entry from `sitemap.md` if you had added one.

 12. **Verify.** Run `pnpm install && pnpm build && pnpm test && pnpm lint && pnpm check-types`. All must pass with zero references to `web-push`, `VAPID`, or `pushSubscription` remaining.

## Adding it back

The reverse path. Removal dropped the database table, so re-addition is a fresh-state install — no historical subscription data to migrate. Existing users re-subscribe through their browser the next time they visit the app.

1. Re-add the dependency to `packages/api/package.json`:
   ```json
   "dependencies": { "web-push": "^3.6.7" }
   "devDependencies": { "@types/web-push": "^3.6.4" }
   ```
   Run `pnpm install`.
2. Recreate `packages/api/src/types/web-push.d.ts` and `apps/web/src/env.d.ts` (`declare module "web-push";`) if your TypeScript setup needs them.
3. Restore the env vars in `packages/env/src/vars/server.ts` (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) plus the partial-VAPID startup guard in `packages/env/src/server.ts`. Then run `pnpm env:sync` to regenerate `.env.example` (never hand-edit it).
4. Restore the `generate:vapid` script in root `package.json`.
5. Generate VAPID keys: `pnpm generate:vapid`. Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in your `.env` files. `VAPID_SUBJECT` should be a `mailto:` URL or an HTTPS URL identifying your app.
6. Restore the Prisma model. Add the `PushSubscription` block and the `pushSubscriptions PushSubscription[]` relation on `User` to `packages/db/prisma/schema/auth.prisma`. Apply locally with `pnpm db:push` (non-destructive). Verify with `prisma migrate diff` that the only change is a new `push_subscription` table plus a single index on `userId`.
7. Restore `packages/api/src/lib/web-push.ts` (the lazy `setVapidDetails` + `sendNotification` wrapper).
8. Restore `packages/api/src/routers/push.ts` with the `subscribe`, `unsubscribe`, `send`, and `vapidPublicKey` procedures. The `send` procedure must remain `adminProcedure`.
9. Restore the test file `packages/api/src/routers/push.test.ts` and confirm `pnpm --filter @starter/api test` passes.
10. Re-register the router in `packages/api/src/routers/index.ts`: import `pushRouter` and add `push: pushRouter,` to `appRouter`.
11. Restore `apps/web/src/hooks/use-push-notifications.ts` and wire it into a UI surface (a settings toggle that calls `subscribe()` / `unsubscribe()` and shows current `permission`). Follow [patterns/data-fetching.md](../data-fetching.md) and [patterns/mutations.md](../mutations.md) for the query / mutation conventions.
12. Confirm your service worker (`apps/web/src/sw.ts`, the vite-plugin-pwa `injectManifest` source, or wherever your PWA service worker lives) handles the `push` and `notificationclick` events.

## Sanity checks

**After removal:**
- `pnpm install` removes `web-push` and `@types/web-push` from `pnpm-lock.yaml`.
- `pnpm build` succeeds with no `Cannot find module 'web-push'` or `VAPID_*` errors.
- `pnpm test` passes (the deleted `push.test.ts` no longer runs).
- `pnpm check-types` passes — no dangling references.
- `grep -ri 'web-push\|VAPID\|pushSubscription'` returns zero hits in source (allowing for intentional doc / pattern-doc references).
- The `push_subscription` table no longer exists in the local database (`pnpm db:studio` to verify).

**After re-addition:**
- `pnpm generate:vapid` prints a key pair.
- `pnpm db:push` creates the `push_subscription` table.
- `pnpm build && pnpm test && pnpm lint && pnpm check-types` all pass.
- End-to-end smoke test: log in as a regular user, call `subscribe()` from the hook, confirm a row appears in `push_subscription`. Then log in as an admin and call the `push.send` procedure (or hit it via oRPC client) — confirm the device receives the notification and the row remains. Trigger a 410-style failure (e.g. unsubscribe in the browser without calling the server) and confirm the next `send` removes the stale row.
