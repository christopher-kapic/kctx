# Add-in: Admin MCP server (API keys + device codes)

The template does **not** ship an MCP server. This is the recipe for building one: an admin-only [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/mcp` speaking Streamable HTTP, so Claude Desktop, Claude Code, or any MCP client can call your admin procedures as tools — plus the two credential flows that mint a bearer for it (static API keys, and the OAuth 2.0 device-authorization grant).

It existed in this template once and was removed on purpose. The [Full source](#full-source--the-commits-that-had-it) section names the commits if your app still carries template history; everything needed to rebuild it from nothing is below.

## Read this first: it is a standing admin credential

An MCP server is a **second authentication surface for your most privileged users**, reachable from outside the browser, whose credential is a token pasted into a desktop app's config file. That is why it is not shipped:

- The credential is long-lived, portable, and copy-pasteable. It survives on a laptop, in a dotfile, in a screen-share.
- Every gate the browser gives you for free — cookies, SameSite, CSRF, the 404-hidden `/admin` group — does not apply to it. The bearer path has to re-implement each check it needs.
- Nothing else in the template consumes API keys or device codes. Adding them without an MCP server means shipping two standing admin credentials that no feature can use.

Build it when an admin genuinely wants to drive the app from an agent and the alternative (using the admin UI) is the bottleneck. Do not build it "so it's there".

## What you get

- `POST /mcp` (and the rest of the Streamable HTTP method matrix) behind two rate limiters and a verified-admin bearer gate.
- A tool registry where each tool delegates to an existing oRPC procedure, so the permission model stays in one place.
- Two ways to mint the bearer: a pasted API key, or a browser-approved device code.
- Admin pages to list and revoke both.

## Security properties that must hold

Each of these is checkable. An agent restoring this surface should be able to point at the code that satisfies every line.

- [ ] **The bearer is resolved in exactly one module.** One function turns an `Authorization` header into a session, and it handles every credential type you admit. A second resolution path is how the two drift.
- [ ] **Better-Auth `getSession` resolves the API-key credential**, with the api-key plugin's `enableSessionForAPIKeys` mocking a session for the key's owner. Do not hand-roll a key lookup that skips the plugin's `enabled` / `expiresAt` checks.
- [ ] **The admin gate is identical to `requireVerifiedAdminSession`** (`apps/server/src/admin-session-gate.ts`): email verified, admin role via `isAdminRole`, not banned via `isUserBanned`, **and** the forced-2FA policy satisfied via `isTwoFactorPolicySatisfied` (`packages/api/src/lib/two-factor-policy.ts`). Forced 2FA defaults to **on for admins** with an enrollment grace window, so an admin inside the grace window passes and one past it does not — a bearer path that skips this check is a documented way around the policy. The bearer path cannot call `requireVerifiedAdminSession` directly (that gate deletes `Authorization` on purpose); it must re-implement the same four checks and stay in sync with it.
- [ ] **Ban is re-checked against the database, not the mocked session.** The api-key plugin builds its session from the key row and never reads `user.banned`, so trusting its shape makes the ban check vacuous. Read the owner off the key row and look the user up.
- [ ] **Every non-MCP surface stays cookie-only.** `apps/server/src/session-middleware.ts` and `packages/api/src/context.ts` already delete `Authorization` before calling `getSession`; the comment there says why in the exact terms that matter here — a plugin adding a bearer credential mocks a session for its owner, and **no oRPC procedure checks a credential's scope**. `apps/server/src/admin-session-gate.ts` does the same for the Better-Auth plugin endpoints. Do not relax any of the three to "share" the MCP credential. Regression test: `apps/server/src/session-middleware.test.ts`.
- [ ] **Two rate limiters on `/mcp`, in order, each with its own `keyPrefix`.** IP-keyed first (it runs before auth, so it bounds unauthenticated probing), credential-keyed second (hash the presented bearer — never the raw token — so it never lands in a Redis key or a slow-log; that hash keys on what was *presented*, so the IP layer in front remains the real bound against token rotation — keying on the **verified** identity inside the handler is the stronger shape). Neither is a remount of `rpcLimiter`: merging them lets MCP probes 429 the SPA. See [rate-limiting § Give every surface its own bucket](../rate-limiting.md#give-every-surface-its-own-bucket) and [rate-limiting § What the bucket is keyed on](../rate-limiting.md#what-the-bucket-is-keyed-on).
- [ ] **Spend-bearing tools get a procedure-level budget.** A single HTTP request carries many procedures, so the route limiter does not bound them — use `createProcedureBudget` from `packages/api/src/lib/procedure-budget.ts`. See [rate-limiting § When the surface is a procedure, not a route](../rate-limiting.md#when-the-surface-is-a-procedure-not-a-route).
- [ ] **The api-key plugin's own per-key quota is disabled.** Its default is 10 requests per 24 hours, which silently bricks a Claude Desktop session in under a minute and then reads as "the key randomly stopped working". [rate-limiting § The related footgun: a plugin's own quota](../rate-limiting.md#the-related-footgun-a-plugins-own-quota).
- [ ] **Key scope is enforced at the tool layer, not merely stored.** A `read` key must be rejected by the write tools themselves. Storing `{"mcp":["read"]}` in `permissions` and never consulting it is the bug this line exists to prevent — and it is why the cookie-only rule above is load-bearing: the tool wrappers are the *only* place scope is checked.
- [ ] **A device-grant session is distinguishable from a browser login.** The grant hands back a plain `session.token`; without a marker on the row, every admin's browser session token becomes a full-write MCP bearer and the `read` scope becomes sidesteppable. See step 3.
- [ ] **Every auth failure is a body-less 401, identical for all reasons.** Missing token, malformed scheme, valid non-admin, banned owner, 2FA unsatisfied — same response. The reason goes to structured server logs only, never the body, or the endpoint becomes an admin-role oracle. Never log the bearer; log the resolved user id.
- [ ] **No tool returns an asset URL it has not permission-checked.** `/api/assets/:id` and `/api/images/:id` URLs are 24-hour bearer tokens and cached PUBLIC responses can outlive a visibility flip. Filter at the source: [assets § The agent rule](../assets.md#the-agent-rule--check-permissions-before-you-hand-out-the-url).
- [ ] **Tool results that carry foreign content are fenced as untrusted.** A tool that returns a fetched page, an uploaded document, or user-submitted text is feeding a model that also takes instructions: [agent-runtime § Untrusted content and prompt injection](../agent-runtime.md#untrusted-content-and-prompt-injection).
- [ ] **Every new procedure starts from a registered builder** exported from `packages/api/src/index.ts` and listed in `procedureAccessLevels` / `middlewareAccessLevels`; `pnpm policy:access-matrix` fails otherwise. A builder constructed in `packages/api/src/lib/` and imported into a router is rejected by shape — [custom-roles § Builder provenance and the pre-notes contract](../custom-roles.md#builder-provenance-and-the-pre-notes-contract).
- [ ] **The access matrix in `notes/02-users-and-roles.md` covers every new endpoint.** Record it `planned` while you are designing and flip it to `implemented` with its real dotted path in the change that ships the procedure ([getting-started § 3.2 Build the access matrix](../getting-started.md#32-build-the-access-matrix)). A live endpoint may not stay `planned`. `scripts/access-matrix-pre-notes-baseline.json` is the *template's* shipped-endpoint floor and is enforcement-protected — app endpoints belong in implemented matrix rows, not there.

## The recipe

Work in this order. Each step is independently verifiable; do not skip ahead to the handler.

### 1. Dependencies

Two packages, pinned in the pnpm catalog (`pnpm-workspace.yaml`) because more than one workspace may consume them, plus the Better-Auth api-key plugin:

- `@modelcontextprotocol/sdk` — the `McpServer` and tool registry.
- `@hono/mcp` — `StreamableHTTPTransport`, the Hono binding.
- `@better-auth/api-key` — **both** halves live here as of Better-Auth 1.7.x: the server plugin (`apiKey` from `@better-auth/api-key`) and the client (`apiKeyClient` from `@better-auth/api-key/client`). It is no longer exported from `better-auth/plugins` — pin it in the catalog at the same version as `better-auth`. The device-authorization plugin, by contrast, stays in core (`better-auth/plugins`).

**Currency note — SDK v2.** The recipe below is written against `@modelcontextprotocol/sdk` + `@hono/mcp`'s sessionful `StreamableHTTPTransport`, because that is what the removed implementation used. The SDK line has since moved: `@modelcontextprotocol/server` 2.x ships `createMcpHandler(factory, { legacy: "reject", responseMode: "json", maxSubscriptions: 0 })` — a stateless, POST-only JSON-RPC profile that needs no Hono binding package and **no session map at all** (see step 6). Prefer it unless you need SSE or subscriptions; the credential resolution, gates, and tool-layer rules below are unchanged either way.

Confirm current versions before installing rather than copying any version from this doc, and confirm the install with the developer first ([agent-tooling § Installing a new pnpm package](../agent-tooling.md#installing-a-new-pnpm-package)). `@hono/mcp` has historically pulled a transitive rate limiter that the catalog pinned explicitly — check the resolution. The credential layer here is documented on its own for non-MCP use in [add-ins/api-keys.md](./api-keys.md) and [add-ins/devices.md](./devices.md).

### 2. Environment variables

One rate-limit family, two knobs, and a **two-file change** ([environment-variables § Adding a new environment variable](../environment-variables.md#adding-a-new-environment-variable)):

1. `packages/env/src/vars/server.ts` — `RATE_LIMIT_MCP_POINTS` (default 300) and `RATE_LIMIT_MCP_WINDOW_SECONDS` (default 60).
2. `scripts/lib/env-manifest.ts` — the matching entries, `group: "ratelimit"`, `advanced: true`, `source: "default"`, with a hint saying the reference member is keyed on the API key, not the IP.
3. `pnpm env:sync` to regenerate the three `.env.example` files. Never hand-edit those.

Then add `mcpRateFamily` to `packages/api/src/lib/rate-limit-families.ts` alongside the five existing families, referenced at 300/60 s with the IP-keyed probe layer at 100 scaling from it.

### 3. Better-Auth plugins

In `packages/auth/src/index.ts`, add to `plugins`:

```ts
apiKey(
  {
    apiKeyHeaders: "authorization",
    requireName: true,
    enableMetadata: true,
    enableSessionForAPIKeys: true,
    // The plugin's default is 10 requests / 24 h, stamped onto each row at
    // creation. It bricks MCP in under a minute and only recovers after a full
    // day of inactivity. Volume control lives in mcpLimiter instead.
    rateLimit: { enabled: false },
    customAPIKeyGetter: (ctx) => parseBearerToken(ctx.headers?.get("authorization")),
  },
  // Prisma exposes `prisma.apiKey`; the adapter looks up the lowercased plugin
  // model name. Without this it 500s on every request.
  { schema: { apikey: { modelName: "apiKey" } } },
),
deviceAuthorization({
  expiresIn: "30m",
  interval: "5s",
  // `verificationUri` defaults to the relative "/device", which does not
  // resolve under this app's locale-prefixed (/$lang/device) routing. Emit an
  // absolute app-origin URL and add a locale-less /device redirect (step 9).
  verificationUri: `${env.BETTER_AUTH_URL}/device`,
  // The options schema marks `schema` non-optional, so pass it explicitly.
  schema: { deviceCode: { modelName: "deviceCode" } },
}),
```

`parseBearerToken` is a small shared parser to **create** (`packages/auth/src/bearer.ts`): RFC 7235 makes the scheme case-insensitive and allows arbitrary whitespace, so a naive `startsWith("Bearer ")` rejects valid headers. Two call sites parsing differently is a real bug that shipped here once — `authorization: bearer <key>` passed the endpoint and returned `null` from the plugin getter. Use one regex (`/^bearer\s+(\S.*)$/i`) from both.

Then add the session marker — the single most important line in this step:

```ts
session: {
  additionalFields: {
    // `input: false` is load-bearing: a settable field lets a caller mint
    // their own MCP credential.
    mcpDeviceGrant: { type: "boolean", required: false, defaultValue: false, input: false },
  },
},
databaseHooks: {
  session: {
    create: {
      before: async (session, context) => {
        if (context?.path !== "/device/token") return;
        return { data: { ...session, mcpDeviceGrant: true } };
      },
    },
  },
},
```

**Why the flag exists.** The device grant's `access_token` *is* a `session.token`. There is nothing else on the row that distinguishes an approved device from an ordinary browser login, so a bearer lookup on token alone makes every admin's browser session token a full-write MCP credential — and makes the `read` scope on API keys sidesteppable by anyone holding one. A device-grant session is a bearer credential, not a cookie session, and the cookie-only admin surfaces must never accept it; the flag is what keeps the two kinds apart in both directions.

**Upgrade hazard:** `context.path` is a string match against an upstream route path. If Better-Auth renames `/device/token`, stamping silently stops and every device flow starts failing at `/mcp` with a body-less 401 — closed, not open, which is the right direction, but re-check this hook whenever you bump `better-auth`.

Client side, `apps/web/src/lib/auth-client.ts` gains `apiKeyClient()` and `deviceAuthorizationClient()`.

### 4. Prisma models

Additive, so an ordinary `pnpm db:push` ([schema-changes-recipe.md](../schema-changes-recipe.md)) — no expand-contract dance:

- `model ApiKey` mapped to `api_key`, matching the plugin's field set. Make `key` `@unique` rather than a plain index: key lookups are exact-match auth checks. Indexes on `configId`, `referenceId`, `userId`. **`referenceId` is the owner column, not `userId`** — the plugin declares and writes only `referenceId`, so `userId` is NULL on every plugin-created row and the `user` relation is always null. Selecting the relation to find the owner is exactly the mistake that makes the ban gate a no-op.
- `model DeviceCode` mapped to `device_code`, with `deviceCode` and `userCode` unique and indexes on `userId` and `expiresAt`.
- `Session.mcpDeviceGrant Boolean @default(false)` added to the existing `Session` model. Do **not** re-declare `@@index([expiresAt])` on `Session` — it already has one (added for the auth-token reaper); a duplicate fails `prisma validate`. The `expiresAt` index the sweep in step 8 needs is the one on `DeviceCode`.
- `User.apiKeys` / `User.deviceCodes` back-relations.

### 5. Server gates and mounts

In `apps/server/src/index.ts`, **before** the `app.on(["POST","GET"], "/api/auth/*", …)` handler — mount order is the gate:

```ts
app.use("/api/auth/device/approve", deviceAdminGate);
app.use("/api/auth/device/deny", deviceAdminGate);
app.use("/api/auth/api-key/*", apiKeyAdminGate);
```

Both gates to **create** (`apps/server/src/api-key-admin-gate.ts`, `apps/server/src/device-admin-gate.ts`) are three lines each: call `requireVerifiedAdminSession(c.req.raw.headers)` and return `{ error, error_description }` with its status on failure. They exist because the plugins only check that the caller has *some* session — a signed-in non-admin could otherwise approve a pending admin device flow, or mint keys, by hitting the routes directly. The `/device` page's own check is client-side and trivially bypassable. Use `403 access_denied` here rather than a body-less 401: this surface is not 404-hidden and the failure mode is an ordinary end-user error.

The device flow polls every 5 s, so it needs its own bucket (`deviceLimiter`, ~120/60 s, fail-closed, own `keyPrefix`) and a skip in the general `/api/auth/*` limiter — under the general 30/60 s ceiling two concurrent authorizations from one office egress trip a five-minute block that takes sign-in and password reset down with it. [rate-limiting § The related footgun: polling endpoints](../rate-limiting.md#the-related-footgun-polling-endpoints).

Then the endpoint itself, after `sessionMiddleware` is mounted on the other paths and **not** on this one:

```ts
app.use("/mcp", createRateLimiterMiddleware(mcpIpLimiter));
app.use("/mcp", createRateLimiterMiddleware(mcpLimiter, { resolveKey: resolveMcpKey }));
app.route("/mcp", mcpApp);
```

`/mcp` deliberately does not mount `sessionMiddleware`: forwarding `Authorization` into the shared session path is precisely what turns a scoped MCP key into a full admin credential on `/rpc`. Because there is no session on the context, the default limiter key would fall back to the client IP — wrong in both directions (every admin behind one egress shares a bucket; a stolen key gets a fresh budget per source IP). `resolveMcpKey` hashes the presented bearer instead, falling back to IP when there is none. Caveat from the properties list: that hash is derived from what the caller presented, not what verification proved — a rotating attacker picks fresh buckets. Pair it with the IP layer (the real unauthenticated bound), or re-key on the verified identity once `resolveAdminSession` has run.

### 6. The MCP handler

Create `apps/server/src/mcp/` with `session.ts` (credential resolution), `auth.ts` (middleware + `AsyncLocalStorage`), `index.ts` (transport + session map), `tools.ts`, `log.ts`. Compact sketch of the seam:

```ts
// session.ts — the ONLY place a bearer becomes a session.
export async function resolveAdminSession(headers: Headers): Promise<AdminSessionResult> {
  const token = parseBearerToken(headers.get("authorization"));
  if (!token) return { ok: false, reason: "missing_auth" };

  // 1. Device-grant session token, looked up directly — and ONLY when the row
  //    carries mcpDeviceGrant. Tried FIRST because the api-key plugin's
  //    before-hook matches any bearer and throws for anything that is not a
  //    valid key, so a device token routed through getSession always 401s.
  const device = await resolveDeviceSession(token); // null = "not this kind of credential"
  if (device) return device;

  // 2. API key, via Better-Auth (the plugin mocks a session for the owner).
  const bearerOnly = new Headers(); bearerOnly.set("authorization", headers.get("authorization")!);
  const session = await auth.api.getSession({ headers: bearerOnly }).catch(() => null);
  if (!session?.user || !session.session?.id) return { ok: false, reason: "get_session_failed" };
  if (!session.user.emailVerified) return { ok: false, reason: "unverified" };
  if (!isAdminRole(session.user.role)) return { ok: false, reason: "not_admin" };
  if (!(await isTwoFactorPolicySatisfied(session.user))) return { ok: false, reason: "no_2fa" };

  // Ban is re-read from the key row's owner: the plugin never reads user.banned.
  const key = await prisma.apiKey.findFirst({
    where: { key: sha256(token) },
    select: { permissions: true, referenceId: true, userId: true },
  });
  if (!key) return { ok: false, reason: "get_session_failed" };
  const owner = await prisma.user.findUnique({
    where: { id: key.referenceId ?? key.userId! },
    select: { banned: true, banExpires: true },
  });
  if (!owner || isUserBanned(owner)) return { ok: false, reason: "banned" };

  const scope = parseMcpScope(key.permissions);      // "read" | "write" | null
  if (!scope) return { ok: false, reason: "no_mcp_capabilities" };
  return { ok: true, session: { ...session, mcpApiKeyScope: scope,
    credentialFingerprint: sha256(session.session.id) } };
}
```

```ts
// auth.ts — body-less 401 for EVERY reason; the reason goes to the log only.
export async function mcpAuthMiddleware(c: Context, next: Next) {
  const result = await resolveAdminSession(c.req.raw.headers);
  if (!result.ok) { logMcpAuthDenied(result.reason); return c.body(null, 401); }
  return mcpContextStorage.run({ session: result.session }, () => next());
}
```

```ts
// tools.ts — every tool delegates to an oRPC procedure, so the permission
// model and validation live in exactly one place.
function getCallableRouter() {
  return createRouterClient(appRouter, {
    context: { session: getMcpContext().session, clientIp: undefined },
  });
}
async function safe<T>(fn: () => Promise<T>, o: { write?: boolean } = {}) {
  try {
    if (o.write && getMcpContext().session.mcpApiKeyScope === "read") {
      throw new ORPCError("FORBIDDEN", { message: "This MCP API key is read-only" });
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(await fn(), null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `Error: ${msg(err)}` }], isError: true };
  }
}
server.registerTool("posts_list", { title: "List posts", inputSchema: { … } },
  async (input) => safe(() => getCallableRouter().posts.list(input)));
```

Keep the `{ write: true }` flag next to `registerTool`, not inside the procedure — a new write tool that forgets it is the failure this shape makes visible in review.

Three hardenings worth adopting beyond that sketch:

- **A typed manifest beats scattered `registerTool` calls.** One descriptor list — public name, exact oRPC target path, `read`/`write`, side-effect classification, input schema, optional input/output adapters — that drives registration, a generated coverage doc, and a test that fails when a router leaf is unclassified, a write tool lacks its flag, or a destructive tool lacks its confirmation. The "new write tool that forgot `{ write: true }`" failure becomes a test failure instead of a review hope. Keep tool input schemas loose (`z.looseObject`) rather than mirroring each procedure's zod input — the oRPC procedure stays the single validation authority, and mirrored schemas can only drift.
- **`annotations` and `structuredContent`.** Set `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` from the descriptor, and return `structuredContent` (the JSON) next to the text blob. For destructive or costly tools, require a confirmation literal in the input (`confirm: "DELETE"`) and strip it before the procedure sees it.
- **An output pipeline.** Map `ORPCError` codes to stable allowlisted messages (never verbatim — a leaked provider message is an information disclosure), redact secrets, serialize `Date` / `bigint` / `Decimal` to JSON-safe strings, and cap result bytes. JSON-RPC cannot carry those types: a procedure taking `z.date()` silently breaks over MCP unless the tool layer adapts ISO-8601 strings.

**Stateless alternative.** If you build on the SDK v2 handler (step 1's currency note), there is no session map to write: one `McpServer` per request, SDK-owned teardown, no session ids, no sticky sessions. The rules below belong to the sessionful `StreamableHTTPTransport` the original shipped, and apply only to that shape.

`index.ts` holds the transport and a **process-local** `Map` of sessions (a `StreamableHTTPTransport` owns an open response stream, so it cannot move to Redis). Four rules that are easy to get wrong:

- Bind each MCP session id to the `credentialFingerprint` that opened it; a mismatch is a body-less 401, **not** the routine 404 for an unknown id — collapsing them tells a holder of a stolen id that the id is live. A mismatch must not drop the owner's session, or any valid admin credential becomes a way to kill another admin's conversation.
- Dropping a session means `transport.close()`, not just `map.delete()`. `onclose` only fires transport-initiated, so a forgotten-but-open session leaks for the life of the process. Delete from the map first, then close (the close handler deletes from the same map).
- Cap the map (100 is sane, FIFO) and sweep idle sessions (30 min, refreshed on use) on write, so no timer leaks into tests.
- Unknown session id → JSON-RPC `404 Session not found`. Clients recover by re-running `initialize`. Do not "fix" that 404 by relaxing auth.

**Scaling:** because sessions are process-local, run `/mcp` on one replica or route it with sticky sessions. Rolling deploys drop every session; that is expected and self-healing.

Two SDK behaviors to design around (observed with the v2 handler; re-check on your version):

- The SDK catches factory/dispatch exceptions itself and answers with its own JSON-RPC 500 — your route-level `catch` never fires, and the SDK's `onerror` receives only the `Error` with no request context. Correlate failures by stamping a request id at the route layer instead of relying on app-level error handling.
- The SDK appends fields to tool results after your code returns (`resultType`, `_meta`). Reserve headroom under any output-size cap you enforce (~1 KiB is a sane reserve), or the cap you advertise is not the cap you enforce.

No CSP change is needed — `/mcp` is not a browser surface. No CSRF protection is needed either, because the endpoint accepts only `Authorization` and browsers do not auto-attach that header cross-origin; that property depends on the endpoint never accepting cookies, so do not add a cookie fallback.

### 7. Token reaping

Extend `packages/api/src/lib/auth-token-retention.ts` (and the log line in `apps/worker/src/handlers/reap-expired-auth-tokens.ts`) to cover `deviceCode` alongside sessions and verifications. The sweep pages by `expiresAt < now`, which is what the `@@index([expiresAt])` in step 4 is for.

### 8. The two oRPC routers

Create `packages/api/src/routers/api-keys.ts` and `packages/api/src/routers/devices.ts`, register both in `packages/api/src/routers/index.ts`, and build every procedure on `adminOr404Procedure`:

- `apiKeys.setScope({ keyId, scope })` — writes `permissions` as JSON. Scope the write to the caller (`referenceId`) and re-assert ownership in the `updateMany` `where`, throwing `NOT_FOUND` when `count !== 1`; the row can be deleted or reassigned between the read and the write.
- `devices.list({ limit })` / `devices.revoke({ id })` — bounded `take`, `where: { userId: context.session.user.id }` on both, so an admin never sees another admin's codes. `revoke` flips `status` to `denied`: future polls fail, but tokens already issued live to their natural expiry. To kill one immediately, delete the session row.

Creation, listing and deletion of keys themselves go through the Better-Auth `/api/auth/api-key/*` endpoints behind `apiKeyAdminGate` — do not re-implement them as procedures.

### 9. Web pages and locales

Create `apps/web/src/routes/$lang/_app/admin/api-keys.tsx` (list, create with a **one-time** plaintext reveal, revoke with type-to-confirm) and `apps/web/src/routes/$lang/_app/admin/devices.tsx`, plus their admin nav entries. Put the ready-made MCP client JSON in the reveal dialog with the key already substituted, through `CodeSnippet`.

`apps/web/src/routes/$lang/_app/device.tsx` is the device page. Better-Auth's flow is **two steps**: the signed-in admin's browser first **claims** the code via `authClient.device({ query: { user_code } })` (`GET /device`), binding it to their session, and only then approves or denies — a page that posts straight to approve/deny leaves `userId` null and the approval is rejected. Put the access decision in a testable helper next to `decideDeviceRouteAccess` in `apps/web/src/lib/route-session-access.ts`: unauthenticated visitors go to `/login` (return URL `/$lang/device?user_code=…`), non-admins to `/dashboard`, and the Approve/Deny click is mandatory, never silent. Add a **locale-less `/device` redirect** to `/$lang/device` (preserving `?user_code=`) so the `verificationUri` from step 3 resolves. Add both to `sitemap.md` and **leave them out** of `PUBLIC_PATHS` in `apps/server/src/seo.ts`: utility routes, not indexable content, like the other auth routes.

Locales: `admin:apiKeys.*`, `admin:devices.*`, `nav.apiKeys` / `nav.devices`, and `auth:device.*`. New English keys go in `packages/locales/src/en-US/`, then `pnpm i18n:translate` ([i18n.md](../i18n.md)). Every string through `t()`.

### 10. Tests

The deleted implementation's test files are the spec — write the equivalents:

| File to create | Covers |
|---|---|
| `apps/server/src/mcp/session.test.ts` | every denial reason; device token without the flag falls through; expired device session; banned owner; scope parsing |
| `apps/server/src/mcp/auth.test.ts` | body-less 401 shape; context propagation through `AsyncLocalStorage` |
| `apps/server/src/mcp/index.test.ts` | session binding mismatch → 401, unknown id → JSON-RPC 404, eviction and idle sweep close the transport |
| `apps/server/src/mcp/tools.test.ts` | a write tool rejects a `read` key; `ORPCError` becomes a structured tool error |
| `apps/server/src/api-key-admin-gate.test.ts`, `apps/server/src/device-admin-gate.test.ts` | non-admin, unverified admin, and 2FA-unsatisfied admin are all refused |
| `packages/api/src/routers/api-keys.test.ts`, `packages/api/src/routers/devices.test.ts` | cross-admin ownership is never readable or writable |
| `packages/auth/src/bearer.test.ts` | lowercase `bearer`, extra whitespace, missing token |

Plus the existing `apps/server/src/session-middleware.test.ts` assertion that `Authorization` is stripped — extend it rather than replacing it. Mock the DB (`vi.mock("@starter/db")` + `mockDeep()`); never hit a real Postgres or Redis ([testing.md](../testing.md)).

### 11. Docs and notes

- `patterns/rate-limiting.md` — add the MCP family row to the budget table and the two members.
- `patterns/production-hardening.md` — add `mcpLimiter` / `mcpIpLimiter` / `deviceLimiter` to the limiter table and note the new admin credential in the hardening checklist.
- `sitemap.md` — `/{lang}/device`, `/{lang}/admin/api-keys`, `/{lang}/admin/devices`.
- `notes/02-users-and-roles.md` — implemented rows for `apiKeys.setScope`, `devices.list`, `devices.revoke`, and a row for the `/mcp` surface itself (its enforcing cell names the middleware, not an oRPC path).
- This file — record anything you added that is not described here.

Run `pnpm verify:fast` before handing back; `pnpm policy:access-matrix` is the gate that catches an unregistered builder or a missing matrix binding.

## Client configuration

Both flows end at the same place: `Authorization: Bearer <token>` against `POST /mcp`.

```json
{
  "mcpServers": {
    "admin": {
      "transport": "http",
      "url": "https://app.example.com/mcp",
      "headers": { "Authorization": "Bearer <paste-key-here>" }
    }
  }
}
```

Claude Code takes the same server over its own MCP configuration; point it at the identical URL and header. The tool inventory is built at module load, so after adding a tool the user must reconnect the server (or restart the client) to see it.

**Flow A — API key.** Sign in at `/{lang}/admin/api-keys`, create a key, name it for the machine it lives on, pick `read` or `write`, pick an expiry (90 days is a sane default; a never-expiring write key is a production admin credential and should be rare and written down). The plaintext is shown once. Paste it into the config above.

**Flow B — device code.** The client calls `/api/auth/device/code`, shows a short `user_code` and the `verification_uri`, the admin opens it in a logged-in browser, the page **claims** the code (`GET /device`) and the admin approves, and the client polls `/api/auth/device/token` until it gets a session token back. Device sessions carry no scope and get full read/write — deliberately: scope exists to narrow a *key* below its owner's authority, and an interactive browser approval by a verified admin is the stronger act.

| Situation | Use |
|---|---|
| Claude Desktop, persistent config | API key |
| A CLI that can open a browser | Device flow |
| CI runner, scripted automation | API key, short expiry, `read` unless it must write |
| One-off demo on someone else's machine | Device flow |

## The spec-compliant OAuth path (when pasted keys are not enough)

The credentials above are manually-configured long-lived secrets. The MCP Authorization spec defines a real OAuth flow for clients you do not control, and modern clients look for it:

- Serve RFC 9728 `/.well-known/oauth-protected-resource` (pointing at your authorization server) and answer 401s with RFC 6750 `WWW-Authenticate: Bearer` challenges. Without this handshake, only manually-configured static keys work.
- Better-Auth 1.7 ships the server side: the `mcp()` plugin with `jwt()` (authorization code + refresh, optional DPoP, ~10-minute access JWTs) and CIMD client registration with dynamic registration left **disabled**. That stack is the right shape once third-party clients can register — deliberately different from this page's API-key + sessionful-transport recipe, which assumes first-party clients you configure yourself.
- **A short-lived JWT cannot be revoked** — it is self-contained. Revocation must be a server-side tombstone: an `McpGrant` row (`revokedAt`, keyed by grant + subject + client) checked on **every** request, inside the admission checks (live user reload, ban, forced-2FA) that already must run after verification. Skipping the tombstone turns "revoke access" into "wait for expiry".
- Scope works like key scope above: a `mcp:read` baseline on the endpoint, literal `mcp:write` required by write tools at dispatch — enforced where the tool runs, never merely stored in the token.

## Full source — the commits that had it

If your app still carries this template's git history, the complete implementation is recoverable:

- **MCP server** — `61e82a9^`: `apps/server/src/mcp/{index,auth,session,tools,log}.ts` with `index.test.ts`, `auth.test.ts`, `session.test.ts`, `tools.test.ts`; the `/mcp` mount and limiter comments in `apps/server/src/index.ts`; `mcpLimiter` / `mcpIpLimiter` / `resolveMcpKey` in `apps/server/src/rate-limit.ts`; `mcpRateFamily` in `packages/api/src/lib/rate-limit-families.ts`; the `RATE_LIMIT_MCP_*` entries in `packages/env/src/vars/server.ts` and `scripts/lib/env-manifest.ts`; the catalog pins in `pnpm-workspace.yaml`; and the original `patterns/mcp-server.md`.
- **Credential layer** — `4024d81^`: `packages/auth/src/bearer.ts`, the `apiKey(...)` / `deviceAuthorization(...)` plugin config and the `mcpDeviceGrant` field + `session.create.before` hook in `packages/auth/src/index.ts`, `apps/server/src/{api-key-admin-gate,device-admin-gate}.ts`, `packages/api/src/routers/{api-keys,devices}.ts`, the `ApiKey` / `DeviceCode` models in `packages/db/prisma/schema/auth.prisma`, `apps/web/src/routes/$lang/_app/{admin/api-keys,admin/devices,device}.tsx`, and `patterns/add-ins/{api-keys,devices}.md`.

Read the removal commit messages too (`git show 4024d81`, `git show 61e82a9`): they say what was load-bearing and why, which is the part a diff alone does not carry.

## Related

- [rate-limiting.md](../rate-limiting.md) — budgets, keying, and the per-surface bucket rule.
- [custom-roles.md](../custom-roles.md) — registered builders and the access-matrix gate.
- [admin-dashboard.md](../admin-dashboard.md) — the 404-hidden `/admin` group the two pages live in.
- [server-procedures.md](../server-procedures.md) — `adminOr404Procedure` and the conventions tools delegate to.
- [agent-runtime.md](../agent-runtime.md) — if your tools call a model, not just your procedures.
- [assets.md](../assets.md) — before any tool returns an asset URL.
- [add-ins/cms.md](./cms.md) — if you restore pages/posts, register those procedures as tools; do not add a second permission model.
- [add-ins/video.md](./video.md) — same, if you restore the HLS pipeline.
