# Add-in: API keys (bearer auth for non-browser clients)

The template does **not** ship API keys. This is the recipe for adding Better-Auth's [`apiKey`](https://www.better-auth.com/docs/plugins/api-key) plugin so a non-browser caller — a CLI, a service-to-service integration, a customer's script, an OpenAI-compatible proxy in front of a model — can authenticate to a **dedicated bearer surface** with `Authorization: Bearer <token>` instead of a browser session cookie.

It existed in this template once (as an admin-only MCP credential) and was removed on purpose. The [Full source](#full-source--the-commit-that-had-it) section names the commit; everything to rebuild it — for programmatic API access this time, not only MCP — is below.

**Relationship to the MCP add-in.** [add-ins/mcp-server.md](./mcp-server.md) documents this exact credential in full depth, because an MCP server is one consumer of it. That doc owns the deep bearer-resolution security recipe; this doc is the same plugin used for *your own* programmatic API, without MCP. If you want both, build this first, then mount `/mcp` on top — **one credential, one resolver, one place scope is checked.** Do not stand up two bearer paths.

## Read this first: a bearer is not a cookie

An API key is a **standing credential reachable from outside the browser**, and every protection the browser gives you for free stops applying to it:

- It is long-lived, portable, and copy-pasteable — it survives in a dotfile, a CI secret, a screen-share.
- Cookies, SameSite, CSRF, and the 404-hidden `/admin` group do nothing for it. The bearer path re-implements each check it needs.
- **Do not bolt bearer auth onto `/rpc`.** `/rpc` and every browser surface are cookie-only *by deliberate design* — `apps/server/src/session-middleware.ts` and `packages/api/src/context.ts` delete the `Authorization` header before resolving a session, precisely so a key cannot be replayed against a mutation whose scope nothing checks. The bearer surface is a **separate mount**.
- Build this only when a real non-browser consumer exists. An api-key surface with nothing consuming it is a standing credential no feature can use — see [add-ins/mcp-server.md § Read this first: it is a standing admin credential](./mcp-server.md#read-this-first-it-is-a-standing-admin-credential).

## What you get

- An `ApiKey` Prisma model and the gated `/api/auth/api-key/*` mint/list/revoke endpoints Better-Auth provides.
- A **dedicated bearer-authenticated API surface** (a Hono route group such as `/api/v1/*`, or a bearer-only oRPC context) that never shares the cookie session path.
- Per-key scoping via `permissions`, enforced at the handler.
- Per-key rate limiting on *your* limiter (the plugin's own quota stays off — see below).
- UI to mint a key (one-time plaintext reveal), scope it, and revoke it.

## Security properties that must hold

Each is checkable; an agent building this should point at the code satisfying every line. The bearer-resolution rules are shared with the MCP add-in — the canonical, annotated list is [add-ins/mcp-server.md § Security properties that must hold](./mcp-server.md#security-properties-that-must-hold). The subset that applies to *any* api-key surface:

- [ ] **The bearer is resolved in exactly one module.** One function turns an `Authorization` header into a session and handles every credential type you admit. A second path is how the two drift.
- [ ] **Better-Auth `getSession` resolves the key**, with `enableSessionForAPIKeys` mocking a session for the key's owner. Do not hand-roll a lookup that skips the plugin's `enabled` / `expiresAt` checks.
- [ ] **Ban is re-checked against the database, not the mocked session.** The plugin builds its session from the key row and never reads `user.banned`; **`referenceId` is the owner column, not `userId`** (the plugin writes only `referenceId`, so `userId` is NULL on plugin-created rows). Read the owner off the key row and look the user up.
- [ ] **Every non-bearer surface stays cookie-only.** Do not relax `session-middleware.ts`, `context.ts`, or `apps/server/src/admin-session-gate.ts` to "share" the credential. Regression test: `apps/server/src/session-middleware.test.ts`.
- [ ] **The plugin's own per-key quota is disabled.** Its default is 10 requests / 24 h, stamped onto each row at creation; it silently bricks a long-lived client in under a minute and reads as "the key randomly stopped working". Volume control lives in your own limiter. [rate-limiting § The related footgun: a plugin's own quota](../rate-limiting.md#the-related-footgun-a-plugins-own-quota).
- [ ] **Scope is enforced at the handler, not merely stored.** A `read` key must be rejected by the write handlers themselves. Storing `{"api":["read"]}` in `permissions` and never consulting it is the bug this line exists to prevent.
- [ ] **If a key can act as an admin, it satisfies the same admin gate** as `requireVerifiedAdminSession` (`apps/server/src/admin-session-gate.ts`): verified, admin role, not banned, **and** forced-2FA satisfied. The bearer path re-implements those four checks and stays in sync with it.
- [ ] **Every auth failure is a body-less 401, identical for all reasons.** The reason goes to structured logs only, or the endpoint becomes a role oracle. Never log the token; log the resolved user id and key id.
- [ ] **No handler returns an asset URL it has not permission-checked** — `/api/assets/:id` URLs are 24-hour bearer tokens. [assets § The agent rule](../assets.md#the-agent-rule--check-permissions-before-you-hand-out-the-url).
- [ ] **Every new procedure starts from a registered builder** and appears in the access matrix. [custom-roles § Builder provenance and the pre-notes contract](../custom-roles.md#builder-provenance-and-the-pre-notes-contract).

## The recipe

### 1. Dependencies

**Currency note (Better-Auth 1.7.x).** The api-key plugin is its **own package, `@better-auth/api-key`** — it is *no longer* exported from `better-auth/plugins`. (The device-authorization plugin, by contrast, stays in core; see [add-ins/devices.md](./devices.md).) Both halves live in that one package:

- Server: `import { apiKey } from "@better-auth/api-key"`.
- Client: `import { apiKeyClient } from "@better-auth/api-key/client"`.

Pin `@better-auth/api-key` in the pnpm catalog (`pnpm-workspace.yaml`) at the **same version as `better-auth`** (currently `1.7.1`; `1.7.5` is available if you bump the pair together) and confirm the install with the developer first ([agent-tooling § Installing a new pnpm package](../agent-tooling.md#installing-a-new-pnpm-package)).

### 2. Rate-limit family and env

A dedicated bucket, keyed on the **hashed** key (never the raw token — it must not land in a Redis key or a slow-log), plus its two knobs as a **two-file change** ([environment-variables § Adding a new environment variable](../environment-variables.md#adding-a-new-environment-variable)):

1. `packages/env/src/vars/server.ts` — `RATE_LIMIT_APIKEY_POINTS` (default 300) and `RATE_LIMIT_APIKEY_WINDOW_SECONDS` (default 60).
2. `scripts/lib/env-manifest.ts` — the matching entries, `group: "ratelimit"`, `advanced: true`, with a hint that the member is keyed on the API key, not the IP.
3. `pnpm env:sync` to regenerate the three `.env.example` files. Never hand-edit those.

Then add an `apiKeyRateFamily` to `packages/api/src/lib/rate-limit-families.ts` alongside the existing families, with an IP-keyed probe layer in front of the credential-keyed bucket. [rate-limiting § Give every surface its own bucket](../rate-limiting.md#give-every-surface-its-own-bucket), [rate-limiting § What the bucket is keyed on](../rate-limiting.md#what-the-bucket-is-keyed-on).

### 3. Better-Auth plugin config

In `packages/auth/src/index.ts`, add to `plugins` (the array currently holds `admin`, `twoFactor`, and the conditional `genericOAuth`):

```ts
import { apiKey } from "@better-auth/api-key"; // NOT better-auth/plugins in 1.7.x

apiKey(
  {
    apiKeyHeaders: "authorization",
    requireName: true,
    enableMetadata: true,
    enableSessionForAPIKeys: true,
    // Default is 10 requests / 24 h, stamped onto each row at creation. It
    // bricks a long-lived client in under a minute. Volume control lives in
    // apiKeyRateFamily instead.
    rateLimit: { enabled: false },
    customAPIKeyGetter: (ctx) => parseBearerToken(ctx.headers?.get("authorization")),
  },
  // Prisma exposes `prisma.apiKey`; the adapter looks up the lowercased plugin
  // model name. Without this it 500s on every request.
  { schema: { apikey: { modelName: "apiKey" } } },
),
```

`parseBearerToken` is a small shared parser to create at `packages/auth/src/bearer.ts`: RFC 7235 makes the scheme case-insensitive and allows arbitrary whitespace, so a naive `startsWith("Bearer ")` rejects valid headers. Use one regex (`/^bearer\s+(\S.*)$/i`) everywhere the header is parsed — two call sites parsing differently is a real bug that shipped here once.

Client side, `apps/web/src/lib/auth-client.ts` gains `apiKeyClient()`.

### 4. Prisma model

Additive, so an ordinary `pnpm db:push` ([schema-changes-recipe.md](../schema-changes-recipe.md)):

- `model ApiKey` mapped to `api_key`, matching the plugin's field set. Make `key` `@unique` (key lookups are exact-match auth checks), with indexes on `referenceId`, `userId`, `configId`.
- `User.apiKeys` back-relation. Remember **`referenceId` is the owner**, so `userId` is NULL on plugin-created rows — never resolve the owner through the `user` relation.

### 5. The bearer surface — this is the actual work

The plugin only mints and validates keys; *you* build the authenticated surface. It must resolve the bearer in one module and never touch the cookie session path. Two shapes:

- **A Hono route group** (e.g. `app.route("/api/v1", v1App)`) with a bearer middleware that calls the single resolver, runs `apiKeyRateFamily`, and stores the resolved session/scope in `AsyncLocalStorage` or the Hono context. Do **not** mount `sessionMiddleware` on it.
- **A bearer-only oRPC context** if you want typed procedures for external callers — a separate context factory that reads `Authorization` (the default one deletes it on purpose).

The resolver mirrors the MCP one, minus the device branch; the annotated version is [add-ins/mcp-server.md § 6. The MCP handler](./mcp-server.md#6-the-mcp-handler). The delta for a general API: resolve the key via `auth.api.getSession`, re-read the owner off the key row for the ban check, parse scope from `permissions`, and **enforce scope in each write handler**. Every failure is a body-less 401.

### 6. Manage keys: gate the plugin endpoints

Creation, listing and deletion go through Better-Auth's `/api/auth/api-key/*` endpoints — do not re-implement them. Mount a gate **before** the `/api/auth/*` handler in `apps/server/src/index.ts`:

```ts
app.use("/api/auth/api-key/*", apiKeyGate);
```

The gate (create at `apps/server/src/api-key-admin-gate.ts`) is three lines: resolve the caller's cookie session and reject if they may not mint keys. For an **admin-only** API, that is `requireVerifiedAdminSession`. For a **user-facing** API where each user manages their own keys, it is `requireAuth` plus scoping every read/write to the caller's `referenceId`. Use `403 access_denied` here (this surface is not 404-hidden). Scope-editing beyond what the plugin exposes goes in a small `apiKeys.setScope` oRPC procedure built on the appropriate registered builder, re-asserting ownership in the `updateMany` `where`.

### 7. Web pages and locales

`apps/web/src/routes/$lang/_app/.../api-keys.tsx` — list, create with a **one-time** plaintext reveal (through `CopyField` / `CodeSnippet`), and revoke with type-to-confirm. Put it in the `/admin` group for an admin API, or under `settings` for a user-facing one. Locales: the relevant `*.apiKeys.*` keys and `nav.apiKeys`; new English keys in `packages/locales/src/en-US/`, then `pnpm i18n:translate`. Every string through `t()`.

### 8. Tests and notes

- `packages/auth/src/bearer.test.ts` — lowercase `bearer`, extra whitespace, missing token.
- The resolver's test — every denial reason; banned owner (via the key row, not the mocked session); scope parsing; a `read` key rejected by a write handler.
- Extend `apps/server/src/session-middleware.test.ts` to keep asserting `Authorization` is stripped from `/rpc`.
- Mock the DB (`vi.mock("@starter/db")` + `mockDeep()`); never hit a real Postgres or Redis ([testing.md](../testing.md)).
- Update `patterns/rate-limiting.md` (the family), `patterns/production-hardening.md` (the new standing credential), and `notes/02-users-and-roles.md` (a row for the bearer surface and any new procedure). Run `pnpm verify:fast`; `pnpm policy:access-matrix` gates an unregistered builder.

## Full source — the commit that had it

If your app still carries this template's git history, the credential layer is recoverable from `4024d81^`: `packages/auth/src/bearer.ts`, the `apiKey(...)` plugin config in `packages/auth/src/index.ts`, `apps/server/src/api-key-admin-gate.ts`, `packages/api/src/routers/api-keys.ts`, the `ApiKey` model in `packages/db/prisma/schema/auth.prisma`, and the admin `api-keys.tsx` route. Read `git show 4024d81` for what was load-bearing. Note that the recovered code imports `apiKey` from `better-auth` — update it to `@better-auth/api-key` per step 1.

## Related

- [add-ins/mcp-server.md](./mcp-server.md) — the same credential as an admin MCP surface; the full bearer-resolution security recipe.
- [add-ins/devices.md](./devices.md) — browser-approved login for clients that cannot paste a static token; the two are independent.
- [rate-limiting.md](../rate-limiting.md) — budgets, keying, and the per-surface bucket rule.
- [custom-roles.md](../custom-roles.md) — registered builders and the access-matrix gate.
- [server-procedures.md](../server-procedures.md) — the builders your management procedures start from.
- [assets.md](../assets.md) — before any handler returns an asset URL.
