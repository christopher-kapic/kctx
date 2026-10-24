# Add-in: Device authorization (browser-approved login for non-browser clients)

The template does **not** ship device authorization. This is the recipe for adding Better-Auth's [`deviceAuthorization`](https://www.better-auth.com/docs/plugins/device-authorization) plugin (OAuth 2.0 Device Authorization Grant, RFC 8628) so a client that has no browser of its own — a CLI, a TV app, a headless daemon — can log a user in: the client shows a short code, the user approves it in a browser they already trust, and the client polls until it receives a session token.

It existed in this template once (to bootstrap an admin MCP session) and was removed on purpose. The [Full source](#full-source--the-commit-that-had-it) section names the commit; everything to rebuild it is below.

**When to use this instead of an API key.** A [static API key](./api-keys.md) is the right credential for a client that can be handed a token out of band (CI, a service). Device authorization is for a client operated by a *person* who can open a browser but cannot safely paste a long-lived secret — the classic `mytool login` flow. The two are independent: keep either, both, or neither. The admin MCP add-in ([add-ins/mcp-server.md](./mcp-server.md)) is one consumer that offers both and documents the shared bearer-resolution security in full depth.

## Read this first: the grant hands back a real session token

The device grant's `access_token` **is** a Better-Auth `session.token`. That has one sharp consequence that governs the whole design:

- Nothing on the session row distinguishes an approved device from an ordinary browser login. A bearer lookup on the token alone therefore turns **every browser session token into a device-grant bearer** — and makes any scope you enforce on API keys sidesteppable by anyone holding a normal login. You must stamp device-grant sessions with a marker (step 3) and keep cookie-only surfaces refusing bearers (see [add-ins/api-keys.md § Read this first: a bearer is not a cookie](./api-keys.md#read-this-first-a-bearer-is-not-a-cookie)).
- **Approval binds to the session that claimed the code.** Better-Auth's flow is two server steps: the signed-in user first *claims* the pending code via `GET /device` (which binds it to their session), then that same session approves or denies. By default only the claiming user can approve — a good default. If you additionally restrict *who* may approve (the admin-only/MCP case), that restriction is server-side too; a client-side page check alone is bypassable.
- Device sessions carry no per-key scope — an interactive browser approval by the user *is* the authorization. If you need to narrow authority below the owner's, that is what API-key `permissions` are for.

## What you get

- A `DeviceCode` Prisma model and the plugin's `/api/auth/device/{code,token,approve,deny}` endpoints (plus `GET /device`, the claim endpoint).
- A `/{lang}/device` page where the user enters the short code, the page **claims** it (`GET /device`), and then approves or denies — plus a locale-less `/device` redirect so the emitted verification URL resolves.
- A `deviceGrant` marker on the session so a device-grant token stays distinguishable from a cookie login at every bearer surface.
- Optional admin visibility into outstanding codes.

## Security properties that must hold

- [ ] **A device-grant session is distinguishable from a browser login.** Stamp a boolean on the session row when, and only when, the grant issues it (step 3). Without it, `read` scope becomes sidesteppable and every login token becomes a full bearer.
- [ ] **The page claims the code before approving.** The user's browser must call `GET /device` (`authClient.device({ query: { user_code } })`) to bind the pending code to their session *before* posting approve/deny. A page that skips the claim leaves `userId` null and every approval is rejected. Pre-binding via `user_id` at `/device/code` is the only sanctioned way to skip it, and needs a server that already knows the user — not the case for a generic CLI.
- [ ] **If you restrict who may approve, that restriction is server-side.** By default Better-Auth binds a claimed code to the claiming session, so only that user can approve — no extra gate needed. For an admin-only add-in (MCP), a signed-in non-admin could otherwise claim and approve a code destined for the privileged surface, so gate `/api/auth/device/approve` and `/deny` server-side; the `/device` page's own check is client-side and bypassable.
- [ ] **The poll has its own limiter, and it bypasses the general auth limiter.** The client polls `/api/auth/device/token` every few seconds; under the general auth ceiling two concurrent authorizations from one office egress trip a multi-minute block that also takes sign-in and password reset down with it. A dedicated fail-closed `deviceLimiter` (own `keyPrefix`) with a skip in the `/api/auth/*` limiter. [rate-limiting § The related footgun: polling endpoints](../rate-limiting.md#the-related-footgun-polling-endpoints).
- [ ] **Every bearer surface that accepts a device token resolves it in the one shared resolver**, tries the device-token branch **before** the api-key branch (the api-key plugin's before-hook matches any bearer and throws for anything that is not a valid key), and re-checks the owner's ban/role/2FA against the database. The annotated resolver is [add-ins/mcp-server.md § 6. The MCP handler](./mcp-server.md#6-the-mcp-handler).
- [ ] **Expired codes are reaped.** The sweep pages by `expiresAt < now`, which is what the `DeviceCode` `expiresAt` index in step 3 is for.

## The recipe

### 1. Dependencies

**Currency note (Better-Auth 1.7.x).** Unlike the api-key plugin, `deviceAuthorization` **is** still exported from core — no extra package:

- Server: `import { deviceAuthorization } from "better-auth/plugins"`.
- Client: `import { deviceAuthorizationClient } from "better-auth/client/plugins"`.

So there is nothing new to install for a first-party CLI login — it rides the `better-auth` you already have (`1.7.1`; `1.7.5` is available). Note the plugin gained a sibling, `oauthDeviceAuthorization()`, for the case where you are a full **OAuth provider** and registered third-party clients redeem codes at `/oauth2/token`. That is a different flow; for your own CLI signing a user into your own app, use `deviceAuthorization()` and poll `/device/token`.

### 2. Better-Auth plugin config

In `packages/auth/src/index.ts`, add to `plugins`:

```ts
import { deviceAuthorization } from "better-auth/plugins";

deviceAuthorization({
  expiresIn: "30m",
  interval: "5s",
  // `verificationUri` defaults to "/device" (relative). This app's routes are
  // all locale-prefixed (/$lang/device), so a bare "/device" does not resolve
  // to the page. Emit an absolute app-origin URL and reconcile the path with
  // i18n routing via the locale-less redirect in step 5.
  verificationUri: `${env.BETTER_AUTH_URL}/device`,
  // The options schema marks `schema` non-optional, so pass it explicitly.
  schema: { deviceCode: { modelName: "deviceCode" } },
}),
```

Then the session marker — the single most important line in this step. Merge these into the **existing** `session` and `databaseHooks` objects already in `packages/auth/src/index.ts` (the file already defines `session.cookieCache` and `databaseHooks.user.create`; do not replace them):

```ts
session: {
  // ...existing expiresIn / updateAge / cookieCache...
  additionalFields: {
    // `input: false` is load-bearing: a settable field lets a caller mint
    // their own device credential.
    deviceGrant: { type: "boolean", required: false, defaultValue: false, input: false },
  },
},
databaseHooks: {
  // ...existing user.create.before...
  session: {
    create: {
      before: async (session, context) => {
        if (context?.path !== "/device/token") return;
        return { data: { ...session, deviceGrant: true } };
      },
    },
  },
},
```

**Upgrade hazard:** `context.path` is a string match against the upstream route. Verified present in `1.7.1` (the plugin registers `/device/{code,token,approve,deny}`). If a future Better-Auth renames `/device/token`, stamping silently stops and device tokens start failing closed at your bearer surface — re-check this hook whenever you bump `better-auth`.

Client side, `apps/web/src/lib/auth-client.ts` gains `deviceAuthorizationClient()`.

### 3. Prisma model

Additive `pnpm db:push` ([schema-changes-recipe.md](../schema-changes-recipe.md)):

- `model DeviceCode` mapped to `device_code`, with `deviceCode` and `userCode` unique and indexes on `userId` and `expiresAt`.
- Add **only** `Session.deviceGrant Boolean @default(false)` to the existing `Session` model. Do **not** add `@@index([expiresAt])` to `Session` — it already has one (`packages/db/prisma/schema/auth.prisma`, added for the auth-token reaper); a second declaration fails `prisma validate`. The reaper's `expiresAt` index that step 6 needs is the new one on `DeviceCode` above.
- `User.deviceCodes` back-relation.

### 4. Who may approve, and the poll limiter

**Default (user-facing `mytool login`): no custom gate.** Better-Auth binds a claimed code to the session that claimed it, so only that signed-in user can approve or deny — the server-side restriction you want is already there. The page only has to require authentication (step 5).

**Admin-only variant** (the add-in exists solely to bootstrap a privileged surface such as MCP): mount a gate **before** the `/api/auth/*` handler in `apps/server/src/index.ts` — mount order is the gate:

```ts
app.use("/api/auth/device/approve", deviceAdminGate);
app.use("/api/auth/device/deny", deviceAdminGate);
```

`deviceAdminGate` (create at `apps/server/src/device-admin-gate.ts`) is three lines: `requireVerifiedAdminSession(c.req.raw.headers)`, else `403 access_denied`. Without it a signed-in non-admin could claim and approve a code destined for the admin surface. Pair it with the page redirect in step 5.

**Either way, the poll needs its own limiter.** The client polls `/api/auth/device/token` every few seconds, so add a fail-closed `deviceLimiter` (~120/60 s, own `keyPrefix`) and a skip in the general `/api/auth/*` limiter — otherwise two concurrent authorizations from one office egress trip a multi-minute block that also takes sign-in and password reset down. [rate-limiting § The related footgun: polling endpoints](../rate-limiting.md#the-related-footgun-polling-endpoints).

### 5. The verification + approval page (two steps, not one)

`apps/web/src/routes/$lang/_app/device.tsx` is where the user enters or confirms the `user_code`. Better-Auth's [User Authorization Flow](https://www.better-auth.com/docs/plugins/device-authorization) is **two server calls**:

1. **Claim** — the page calls `authClient.device({ query: { user_code } })` (`GET /device`), which binds the pending code to the *calling* session. This is mandatory: skip it and `userId` stays null, so the approval in step 2 is rejected.
2. **Approve / deny** — the same session then calls approve or deny. The click is **mandatory, never silent**.

The user must be signed in to claim, so put the access decision in a testable helper (`decideDeviceRouteAccess` in `apps/web/src/lib/route-session-access.ts`): send an anonymous visitor to `/login` with a return URL of `/$lang/device?user_code=…` and re-run the claim after sign-in. For the **admin-only variant** (step 4), also send a non-admin to `/dashboard`; the user-facing default lets any authenticated user proceed.

**Reconcile the verification URL with `/$lang/` routing.** `verificationUri` (step 2) is one static string, but every page here is locale-prefixed. Register a **locale-less `/device` route that redirects to `/$lang/device`** (reusing the app's root locale-detection redirect) and preserves the `?user_code=` query, so the emitted `verification_uri` is a clean app-origin `/device` that lands the user on the localized page. It is a utility route: add both `/device` and `/{lang}/device` to `sitemap.md` and **leave them out** of `PUBLIC_PATHS` in `apps/server/src/seo.ts`, like the other auth routes. Locales: `auth:device.*`; new English keys then `pnpm i18n:translate`.

### 6. Reaping and the bearer branch

- Extend `packages/api/src/lib/auth-token-retention.ts` (and the log line in `apps/worker/src/handlers/reap-expired-auth-tokens.ts`) to cover `deviceCode` alongside sessions and verifications.
- If a bearer surface accepts device tokens, add the device branch to the shared resolver **first**, gated on the `deviceGrant` marker — see the security checklist above and the annotated resolver in [add-ins/mcp-server.md § 6. The MCP handler](./mcp-server.md#6-the-mcp-handler). If you only use device auth to establish an ordinary cookie session in a browser, no bearer surface is involved and this step is moot.

### 7. Tests and notes

- The resolver/gate tests: a device token without the marker falls through; an expired device session is refused; a non-authorized caller cannot approve.
- Mock the DB (`vi.mock("@starter/db")` + `mockDeep()`); never hit a real Postgres or Redis ([testing.md](../testing.md)).
- Update `patterns/rate-limiting.md` (the `deviceLimiter`), `patterns/production-hardening.md`, `sitemap.md` (`/{lang}/device`), and `notes/02-users-and-roles.md`. Run `pnpm verify:fast`.

## Client configuration

The flow, first-party path: the client calls `POST /api/auth/device/code` and shows the `user_code` plus the `verification_uri` the server returns (the absolute app-origin `/device` from step 2, which redirects to the localized page). The user opens it, signs in, the page **claims** the code (`GET /device`) and the user approves. Meanwhile the client polls `POST /api/auth/device/token` at the returned `interval` until it gets a session token — `authorization_pending` means keep waiting, `slow_down` means increase the interval. From then the client sends that token as `Authorization: Bearer <token>` to whatever bearer surface you built ([add-ins/api-keys.md § 5. The bearer surface — this is the actual work](./api-keys.md#5-the-bearer-surface--this-is-the-actual-work)).

| Situation | Use |
|---|---|
| A CLI a person runs (`mytool login`) | Device flow |
| CI runner, scripted automation | [API key](./api-keys.md), short expiry |
| A registered third-party OAuth app | `oauthDeviceAuthorization()` + `/oauth2/token` (different flow) |

## Full source — the commit that had it

If your app still carries this template's git history, the flow is recoverable from `4024d81^`: the `deviceAuthorization(...)` plugin config and the `mcpDeviceGrant` field + `session.create.before` hook in `packages/auth/src/index.ts`, `apps/server/src/device-admin-gate.ts`, `packages/api/src/routers/devices.ts`, the `DeviceCode` model in `packages/db/prisma/schema/auth.prisma`, and `apps/web/src/routes/$lang/_app/{device,admin/devices}.tsx`. Read `git show 4024d81` for what was load-bearing. The plugin import and endpoint paths are unchanged in `1.7.1`.

## Related

- [add-ins/api-keys.md](./api-keys.md) — the static-token credential for clients that can hold a secret; the bearer surface a device token is sent to.
- [add-ins/mcp-server.md](./mcp-server.md) — an admin surface that composes both credentials; the full bearer-resolution recipe.
- [rate-limiting.md](../rate-limiting.md) — the polling-endpoint limiter rule.
- [testing.md](../testing.md) — mocking the DB in auth tests.
