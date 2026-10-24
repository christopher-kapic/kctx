// Load repo-root `.env` before any `@starter/env/*` validation (and before
// packages that import it: auth, db, api). Must stay the first import.
import "@starter/env/load-dotenv";

import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { BatchHandlerPlugin, SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { createContext } from "@starter/api/context";
import {
  pushSubscriptionInputSchema,
  upsertPushSubscription,
} from "@starter/api/lib/push-subscription";
import { parseBucketSpec } from "@starter/api/lib/storage";
import { appRouter } from "@starter/api/routers/index";
import { auth, type Session } from "@starter/auth";
import { ORPC_BATCH_MAX_SIZE } from "@starter/config/orpc-batch";
import { THEME_INIT_SCRIPT } from "@starter/config/theme-init";
import prisma from "@starter/db";
import { ADMIN_EMAILS, env, S3_FORCE_PATH_STYLE } from "@starter/env/server";
import { QUEUE_NAMES, redisConnection } from "@starter/queue";
import { hasExternalConsumer } from "@starter/queue/consumer-health";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { apiReferenceAdminGate } from "./api-reference-admin-gate.js";
import { mountAssetRoutes } from "./asset-routes.js";
import { betterAuthAdminGate } from "./better-auth-admin-gate.js";
import { mountChatRoutes } from "./chat-routes.js";
import { resolveClientIp } from "./client-ip.js";
import { CORS_ALLOW_HEADERS } from "./cors-headers.js";
import {
  EMAIL_RECIPIENT_PATHS,
  emailRecipientLimit,
  FORM_OR_JSON_MEDIA_TYPES,
  SIGNIN_RECIPIENT_PATH,
  SIGNUP_RECIPIENT_PATH,
  signinSentMail,
} from "./email-recipient-limit.js";
import { createServerLifecycle, withTimeout } from "./lifecycle.js";
import {
  LOCALE_MODULEPRELOAD_HEADER,
  loadLocaleModulePreloads,
  resolveLocaleModulePreload,
} from "./locale-modulepreload.js";
import {
  assetLimiter,
  authLimiter,
  chatStreamLimiter,
  createRateLimiterMiddleware,
  credentialBurstLimiter,
  credentialLimiter,
  imageLimiter,
  readyLimiter,
  rpcLimiter,
  signinRecipientLimiter,
  signupLimiter,
  signupRecipientLimiter,
  ssrLimiter,
} from "./rate-limit.js";
import { validateSameSiteJsonRequest } from "./request-origin.js";
import { mountSecurityHeaders, s3ConnectSrcOrigins } from "./security-headers.js";
import { registerSeoRoutes } from "./seo.js";
import { sessionMiddleware } from "./session-middleware.js";
import { SIGNIN_FAILURE_PATH, signinFailureLimit } from "./signin-failure-limit.js";
import { adminBootstrapMarker } from "./signup-gate.js";
import { handleSsrRequest } from "./ssr-cache.js";
import { TWO_FACTOR_OTP_PATH, twoFactorOtpLimit } from "./two-factor-otp-limit.js";

// ---------------------------------------------------------------------------
// Startup guards
// ---------------------------------------------------------------------------

// Reject wildcard CORS origin — it disables credential support and effectively
// opens the API to any website. Fail hard at startup so the misconfiguration
// is caught immediately in staging/CI, not silently in production.
if (env.CORS_ORIGIN === "*") {
  console.error(
    "[server] FATAL: CORS_ORIGIN must not be '*'. Set it to the exact origin of your frontend (e.g. https://app.example.com).",
  );
  process.exit(1);
}

// Non-production banner. NODE_ENV defaults to "development" (see
// packages/env/src/vars/shared.ts), which silently weakens several guards for
// anyone running the server by hand outside Docker — where NODE_ENV is often
// simply unset. Say so loudly at boot, naming what is weaker.
if (process.env.NODE_ENV !== "production") {
  console.warn(
    "[server] ══════════════════════════════════════════════════════════════\n" +
      `[server] NON-PRODUCTION MODE (NODE_ENV=${process.env.NODE_ENV ?? "unset → development"}) — guards weakened:\n` +
      "[server] cookies not Secure · /api-reference public · weak secrets warn-only · http:// URLs allowed\n" +
      "[server] Never expose this process publicly or use production data.\n" +
      "[server] ══════════════════════════════════════════════════════════════",
  );
}

// ---------------------------------------------------------------------------
// App + global middleware
// ---------------------------------------------------------------------------

type AppVariables = {
  requestId: string;
  session: Session | null;
};

const app = new Hono<{ Variables: AppVariables }>();

// Secure-headers — sets a battery of security headers (X-Content-Type-Options,
// X-Frame-Options, Strict-Transport-Security, etc.) on every response, plus the
// raw-asset `sandbox` CSP override. Ordering between the two is load-bearing and
// lives in mountSecurityHeaders (see its doc comment + security-headers.test.ts).
// CSP: tighten per route if third-party scripts/analytics are needed.
//
// connect-src must also allow the S3 origin when object storage is configured:
// asset (asset-client.ts) uploads are browser-direct
// `fetch` PUTs to presigned S3 URLs, which CSP blocks otherwise. The origin is
// derived from the exact same env the S3 client reads (see storage.ts). When S3
// is unconfigured, s3ConnectSrcOrigins returns [] and the policy is unchanged.
const s3ConnectSrc = env.S3_BUCKET
  ? s3ConnectSrcOrigins({
      bucket: parseBucketSpec(env.S3_BUCKET).bucket,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: S3_FORCE_PATH_STYLE,
    })
  : [];
const cspConnectSrc = ["'self'", ...(env.CORS_ORIGIN ? [env.CORS_ORIGIN] : []), ...s3ConnectSrc];

// CSP hash authorizing the inlined anti-FOUC theme bootstrap (THEME_INIT_SCRIPT,
// injected into <head> by apps/web/src/routes/__root.tsx). Computed from the
// shared string at startup, so it can never drift from the inlined content. An
// inline script needs a nonce or hash to run under `script-src 'self' 'nonce-…'`;
// this static bootstrap can't carry a per-request nonce, so it uses a hash.
const themeInitCspHash = `'sha256-${createHash("sha256").update(THEME_INIT_SCRIPT).digest("base64")}'`;
mountSecurityHeaders(app, { cspConnectSrc, themeInitCspHash });

// Body-limit — reject oversized payloads early (before JSON parsing) to
// prevent memory exhaustion. 10 MB covers image uploads and large form
// payloads; individual routes can override with a tighter limit if needed.
app.use(
  "/*",
  bodyLimit({
    maxSize: 10 * 1024 * 1024, // 10 MB
    onError: (c) => c.json({ error: "Request is too large. Try uploading a smaller file." }, 413),
  }),
);

// Request-ID — attach a short random ID to every request for log correlation.
// The ID is stored in `c.var.requestId` and included in the logger output.
app.use("/*", async (c, next) => {
  const id = crypto.randomUUID().slice(0, 8);
  c.set("requestId", id);
  await next();
});

// Logger — custom print function that prepends the request ID for correlation.
app.use("/*", async (c, next) => {
  const logFn = (message: string, ...rest: string[]) => {
    const reqId = c.get("requestId") ?? "-";
    console.log(`[${reqId}] ${message}`, ...rest);
  };
  return logger(logFn)(c, next);
});

// Catch any uncaught error from a route/middleware so admins get a stack
// trace + request context in the logs instead of an opaque 500 in the client.
app.onError((err, c) => {
  const reqId = c.get("requestId") ?? "-";
  console.error(
    `[server] [${reqId}] Unhandled error on ${c.req.method} ${c.req.path}:`,
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  return c.json({ error: "Something didn't work on our end. Try again in a moment." }, 500);
});

// Shared oRPC error logger. Skips expected client errors (4xx ORPCErrors like
// UNAUTHORIZED / NOT_FOUND / METHOD_NOT_SUPPORTED) so logs only contain real
// problems. Transient 5xx codes (502/503/504 — usually upstream infra blipping)
// log at warn so they don't pollute error dashboards alongside genuine bugs.
function logOrpcError(error: unknown) {
  if (error instanceof ORPCError && error.status < 500) {
    return;
  }
  const isTransient5xx = error instanceof ORPCError && error.status > 500;
  const log = isTransient5xx ? console.warn : console.error;
  if (error instanceof Error) {
    log(`[orpc] ${error.name}: ${error.message}`, error.stack);
  } else {
    log("[orpc] Unknown error:", error);
  }
}
if (env.CORS_ORIGIN) {
  app.use(
    "/*",
    cors({
      origin: env.CORS_ORIGIN,
      allowMethods: ["GET", "POST", "OPTIONS"],
      // Adding a header the client sets? It must go in CORS_ALLOW_HEADERS or
      // the preflight fails and the request never leaves the browser — a
      // failure mode invisible in local dev. See cors-headers.ts.
      allowHeaders: [...CORS_ALLOW_HEADERS],
      credentials: true,
    }),
  );
}

// Liveness probe — answers whether this Node process can serve HTTP. Keep this
// independent of external services so orchestrators do not restart healthy app
// containers during a transient Postgres/Redis failover.
app.get("/health", (c) => c.json({ ok: true }));

// Readiness probe — checks dependencies for deploy gates and manual diagnosis.
// Rate-limited (unlike /health) because it touches Postgres and Redis on every
// call, so an unthrottled public probe is a cheap way to load the datastores.
// Fail-open: an orchestrator must still be able to read readiness during a
// Redis blip, which is exactly when it matters most.
//
// Its OWN bucket, not a remount of `rpcLimiter`: readiness and app traffic are
// exactly the two things that must stay independent during an incident.
const lifecycle = createServerLifecycle();

// The drain answer comes BEFORE the limiter, and must stay there. During a
// rolling deploy the load balancer polls readiness about once a second and the
// only correct reply is 503 "draining" — but a limiter placed first will start
// answering 429 partway through the drain window, which an orchestrator reads
// as "probe failed for an unknown reason", not as "stop sending me traffic".
// The check is a boolean read of process state: it touches neither Postgres nor
// Redis, so it costs nothing to serve unthrottled and there is nothing here for
// a limiter to protect. Everything past this point does hit the datastores, and
// that is what `readyLimiter` still guards.
app.use("/ready", async (c, next) => {
  if (lifecycle.isShuttingDown()) {
    return c.json({ ok: false, checks: { shuttingDown: true } }, 503);
  }
  await next();
});
app.use("/ready", createRateLimiterMiddleware(readyLimiter));
app.get("/ready", async (c) => {
  const checks = {
    postgres: false,
    redis: false,
    workers: false,
  };
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 3000, "postgres readiness check");
    checks.postgres = true;

    await withTimeout(redisConnection.ping(), 3000, "redis readiness check");
    checks.redis = true;
    checks.workers =
      env.WORKER_MODE === "embedded"
        ? lifecycle.isWorkerReady()
        : await withTimeout(
            hasExternalConsumer(redisConnection, Object.values(QUEUE_NAMES)),
            3000,
            "consumer readiness check",
          );
    if (!checks.workers) return c.json({ ok: false, checks }, 503);

    return c.json({ ok: true, checks });
  } catch {
    return c.json({ ok: false, checks }, 503);
  }
});

// SEO / discoverability: /robots.txt, /sitemap.xml, /llms.txt. Registered here
// — before the static-asset middleware and the SSR catch-all below — so the
// `/$lang/...` router never swallows them and returns the SPA HTML shell.
registerSeoRoutes(app);

// ADMIN_EMAILS bootstrap marker (see signup-gate.ts). Pass-through by design:
// it marks member requests for admin promotion but NEVER rejects, so member
// and non-member addresses are indistinguishable at this layer.
//
// SIGNUP_ENABLED=false is enforced SOLELY by the auth database hook
// (packages/auth/src/index.ts), which throws for every user creation outside
// an allowed mode. An earlier revision additionally rejected non-members here
// with an immediate 403 while members proceeded into Better-Auth — the
// immediate-403 vs Better-Auth-processing split (shape + timing) revealed
// which emails are admins, so it was removed. SSO/JIT creation is likewise
// blocked in that hook; existing SSO users can still sign in because no user
// is created for them. Do NOT re-add an email-based early reject here.
app.use("/api/auth/sign-up/email", adminBootstrapMarker(ADMIN_EMAILS));

// Signup-specific rate limiter — stricter than the general auth limiter.
// Must be mounted BEFORE the general authLimiter so signup traffic is throttled
// at the tighter limit first.
app.use("/api/auth/sign-up/*", createRateLimiterMiddleware(signupLimiter, { failClosed: true }));

// `get-session` is a benign, cookie-authenticated read that the SPA polls on
// navigation/focus — many calls per minute under normal use. It must NOT be
// subject to the strict credential-stuffing limiter below: at 10/60s with a
// 15-minute block, normal polling locks legitimate users out, and because
// sign-in/sign-up share the /api/auth/* bucket, it blocks those too (a fresh
// user hits "Too many attempts" on their very first signup). Give it the
// general RPC ceiling instead. Mounted BEFORE the strict limiter.
app.use("/api/auth/get-session", createRateLimiterMiddleware(rpcLimiter));

// Credential endpoints — the tight bucket. Sign-in and 2FA verification are
// the only routes where an attacker's guess is worth something, so they get a
// much smaller budget than the rest of the auth surface. Mounted BEFORE the
// general limiter, which still applies as a second layer.
//
// Keeping this separate is what lets the general limiter below be generous:
// these limiters key on client IP, and an office or mobile carrier shares one,
// so a single tight limit across all of /api/auth/* would lock a shared
// network out of password reset and email verification — exactly what a user
// who just failed to sign in needs next.
// TWO windows on the same routes. The 60-second bucket bounds sustained
// guessing; the 10-second one bounds a burst, which is the shape credential
// stuffing actually has — 10/60s on its own happily permits ten guesses inside
// one second. Better-Auth's built-in limiter carried a 3-per-10s rule and we
// disable it (its key degenerates to one shared bucket behind a two-hop proxy;
// see packages/auth/src/index.ts), so this is what replaces that rule rather
// than dropping it.
for (const path of ["/api/auth/sign-in/*", "/api/auth/two-factor/*"]) {
  app.use(path, createRateLimiterMiddleware(credentialBurstLimiter, { failClosed: true }));
  app.use(path, createRateLimiterMiddleware(credentialLimiter, { failClosed: true }));
}

// Two-factor OTP resends, capped per CHALLENGE. Mounted here so it runs after
// the fail-closed IP-keyed pair above — its own key is a cookie, i.e.
// caller-supplied, and must sit behind something coarser. See
// `twoFactorOtpLimiter` for why Better-Auth leaves this endpoint uncapped and
// why the key is the challenge rather than the recipient.
app.use(TWO_FACTOR_OTP_PATH, twoFactorOtpLimit());

// Rate limit the remaining auth endpoints, EXCEPT get-session (handled above).
// Must be mounted BEFORE the auth handler so every auth request is throttled.
app.use("/api/auth/*", async (c, next) => {
  if (c.req.path.endsWith("/get-session")) return next();
  return createRateLimiterMiddleware(authLimiter, { failClosed: true })(c, next);
});

// Per-RECIPIENT cap on the anonymous endpoints that mail a caller-supplied
// address. Mounted AFTER the IP limiter above (which is the fail-closed
// security control) because this is the anti-abuse layer on top: the IP
// limiter bounds one caller, this bounds one mailbox, and rotating IPs defeat
// only the former. See email-recipient-limit.ts.
for (const path of EMAIL_RECIPIENT_PATHS) {
  app.use(path, emailRecipientLimit());
}
// Signup mails a caller-supplied address too, and `signupLimiter` above is
// IP-keyed — the exact control rotating IPs defeat. Its own bucket and budget:
// see signupRecipientLimiter. Mounted here, so it runs AFTER the ADMIN_EMAILS
// bootstrap marker and signupLimiter: a request rejected by those never
// reaches this limiter and so never spends a point from the recipient's
// budget. (SIGNUP_ENABLED=false rejections happen downstream in the auth
// database hook, so blocked signups DO reach this limiter — same as any other
// request Better-Auth itself rejects.)
// `/sign-up/email` is the one route that widens Better-Auth's global
// JSON-only `allowedMediaTypes` to also accept form-urlencoded, so the limiter
// has to accept exactly that pair here — see FORM_OR_JSON_MEDIA_TYPES.
app.use(
  SIGNUP_RECIPIENT_PATH,
  emailRecipientLimit(signupRecipientLimiter, FORM_OR_JSON_MEDIA_TYPES),
);
// Sign-in mails too, but only against an unverified account and only because
// `requireEmailVerification` + `sendOnSignIn` are both on — see
// SIGNIN_RECIPIENT_PATH. Mounted after the fail-closed credentialBurstLimiter /
// credentialLimiter pair above, which stays the primary control here: the
// password is checked before any mail is sent, so this bucket is a backstop
// against a leaked-credential mail loop, not an anti-spam gate.
//
// DEFERRED metering (`signinSentMail`) — this must not charge a point for every
// sign-in attempt. The bucket keys on the caller-supplied address, so a
// per-attempt charge would let anyone who knows your email 429 you out of your
// own login. See the `ConsumeWhen` doc comment.
//
// Form-urlencoded as well as JSON: `/sign-in/email` widens the global media
// types exactly as `/sign-up/email` does (`sign-in.mjs:155`), and declaring
// JSON-only here would 415 legitimate form posts before Better-Auth sees them.
app.use(
  SIGNIN_RECIPIENT_PATH,
  emailRecipientLimit(signinRecipientLimiter, FORM_OR_JSON_MEDIA_TYPES, signinSentMail),
);

// Per-EMAIL cap on FAILED password sign-ins — the layer the IP-keyed pair
// above cannot provide: a rotating-IP stuffing campaign against ONE account
// gets a fresh 10/60s budget from every address it holds, and only this
// counter bounds it per account. Charged ONLY on 401 responses (see
// `signinFailedCredentials`), reserve-then-refund so successes never
// accumulate, 10 failures / 15 min → 10-minute block, keyed on a SHA-256 of
// the normalized email so no address ever sits in a Redis key, and fail-OPEN
// with in-memory insurance — the fail-closed IP pair stays the security floor
// on this route. Sign-in ONLY: signup/forgot-password stay IP-keyed, where a
// per-email counter would be a pure lockout lever. Full rationale:
// `signinFailureLimiter` in rate-limit.ts and signin-failure-limit.ts.
app.use(SIGNIN_FAILURE_PATH, signinFailureLimit());

// Admin gate for Better-Auth's admin plugin endpoints. The plugin role-checks
// by default, but these routes can set roles, reset passwords, impersonate
// users, and remove users, so they must also honor this app's verified-admin
// and forced-2FA policy before the Better-Auth handler sees the request.
app.use("/api/auth/admin/*", betterAuthAdminGate);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Resolve the Better-Auth session once per request on paths that need it.
// Mounted BEFORE the rate limiters so they can key on the user id without
// each making their own getSession() call. Not mounted on /api/auth/*
// (Better-Auth does its own lookup) or /health / SSR / dev-only routes.
app.use("/rpc/*", sessionMiddleware);
app.use("/api/assets/*", sessionMiddleware);
app.use("/api/images/*", sessionMiddleware);
app.use("/api/chat/*", sessionMiddleware);
app.use("/sw/*", sessionMiddleware);

// Rate limit RPC endpoint — general API traffic.
// Uses Redis-backed limiter with in-memory insurance fallback (fail-open).
app.use("/rpc/*", createRateLimiterMiddleware(rpcLimiter));
app.use("/api-reference/*", createRateLimiterMiddleware(rpcLimiter));

// In production the OpenAPI reference is admin-only: it documents every
// procedure and shouldn't be a public surface. Non-admins get a 404 (not
// 401/403) so the page isn't enumerable, matching the adminOr404 convention.
// Mounted after the rate limiter so brute-forcing the gate is throttled first.
// In development it stays open for local API exploration.
if (env.NODE_ENV === "production") {
  app.use("/api-reference/*", apiReferenceAdminGate);
}

// Asset + image endpoints. Permissions live in @starter/api/lib/assets;
// see patterns/assets.md for the full read/write flow and the rule about
// only handing asset URLs to authorized users.
//
// Images get their own bucket rather than sharing the RPC one. A media-heavy
// page costs many requests per view — a gallery renders dozens of image
// variants — so sharing meant one gallery could exhaust the whole API budget
// for a minute and 429 the rest of the app mid-render.
app.use("/api/assets/*", createRateLimiterMiddleware(assetLimiter));
app.use("/api/images/*", createRateLimiterMiddleware(imageLimiter));
mountAssetRoutes(app);

// Durable chat SSE stream. Own limiter for the same reason images
// have one — see `chatStreamLimiter`. The resumability contract (Postgres
// replay + best-effort Redis live events) lives in chat-routes.ts; the write
// half is the `chat` oRPC router. See patterns/add-ins/chat.md.
app.use("/api/chat/*", createRateLimiterMiddleware(chatStreamLimiter));
mountChatRoutes(app);

// ---------------------------------------------------------------------------
// Service-worker push-subscription renewal
// ---------------------------------------------------------------------------
// Dedicated HTTP endpoint for the `pushsubscriptionchange` handler in
// `apps/web/src/sw.ts`. The service worker runs in a separate execution
// context that cannot easily import the oRPC client, so it needs a plain
// HTTP route. Narrow blast radius: authenticated via Better-Auth session
// cookie, accepts only a push-subscription body, rate-limited the same way
// as `push.subscribe` (same underlying `upsertPushSubscription` helper).
//
// CSRF: the oRPC handlers attach `SimpleCsrfProtectionHandlerPlugin` to
// themselves (not to the Hono app), so this route uses a plain HTTP guard
// instead: JSON-only body, same-site fetch metadata, and Origin allowlist.
app.use("/sw/*", createRateLimiterMiddleware(rpcLimiter));
app.post("/sw/push-renew", async (c) => {
  const rejected = validateSameSiteJsonRequest(c);
  if (rejected) return rejected;

  const session = c.get("session");
  if (!session?.user) {
    return c.json({ error: "You're not signed in. Please sign in and try again." }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request must be valid JSON." }, 400);
  }

  const parsed = pushSubscriptionInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Request contains missing or invalid fields." }, 400);
  }

  await upsertPushSubscription(session.user.id, parsed.data);
  return c.json({ success: true });
});

// When CORS_ORIGIN is set (cross-origin deployment), validate the x-csrf-token
// header sent by the client's SimpleCsrfProtectionLinkPlugin. Same-origin
// deployments don't need this because browsers block cross-origin custom
// headers at preflight anyway.
const csrfPlugins = env.CORS_ORIGIN ? [new SimpleCsrfProtectionHandlerPlugin()] : [];

export const apiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
    ...csrfPlugins,
  ],
  interceptors: [onError(logOrpcError)],
});

// `BatchHandlerPlugin` matches the client's `BatchLinkPlugin` (see
// `apps/web/src/utils/orpc.ts`). Without it, any time the SPA fires multiple
// concurrent queries with a shared router prefix the client wraps them into
// a single `/rpc/<prefix>/__batch__` POST that the server otherwise 404s.
//
// `maxSize` must stay in sync with the client — both read the shared
// `ORPC_BATCH_MAX_SIZE`, never a literal. If this drops below the client's
// value, the server rejects the entire batch with HTTP 413 ("Batch request
// size exceeds the maximum allowed size") and every query in it fails. That
// 413 is a *procedure count* limit, not `bodyLimit` and not a proxy payload
// limit. See `packages/config/src/orpc-batch.ts`.
export const rpcHandler = new RPCHandler(appRouter, {
  plugins: [new BatchHandlerPlugin({ maxSize: ORPC_BATCH_MAX_SIZE }), ...csrfPlugins],
  interceptors: [onError(logOrpcError)],
});

app.use("/*", async (c, next) => {
  const context = await createContext({ context: c, clientIp: resolveClientIp(c) });

  const rpcResult = await rpcHandler.handle(c.req.raw, {
    prefix: "/rpc",
    context: context,
  });

  if (rpcResult.matched) {
    return c.newResponse(rpcResult.response.body, rpcResult.response);
  }

  const apiResult = await apiHandler.handle(c.req.raw, {
    prefix: "/api-reference",
    context: context,
  });

  if (apiResult.matched) {
    return c.newResponse(apiResult.response.body, apiResult.response);
  }

  await next();
});

if (env.NODE_ENV === "production") {
  const { serveStatic } = await import("@hono/node-server/serve-static");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const { dirname, join } = await import("node:path");

  // The built web assets live at apps/web/dist — a sibling of apps/server.
  // Resolve them from THIS module's location, not the process CWD: the bundle
  // runs as /app/apps/server/dist/index.mjs with CWD=/app, so a CWD- or
  // module-relative "../web/dist" lands in the wrong place. `serveStatic`
  // (CWD-relative) and dynamic import (module-relative) disagree on the base,
  // so we hand both an absolute path computed from import.meta.url.
  const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

  // Serve static client assets (JS, CSS, images)
  // Vite/rolldown content-hashes every file under /assets, so each URL is
  // immutable: a code change produces a new filename, never a new body at the
  // same URL. Safe to cache for a year. This middleware runs before the
  // serveStatic below (sets the header, then defers to it).
  // IMPORTANT: do NOT add long caching to the catch-all /* serveStatic or the
  // SSR shell — index.html and version.json must stay revalidated so new
  // deploys are picked up.
  app.use("/assets/*", async (c, next) => {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    await next();
  });
  app.use("/assets/*", serveStatic({ root: join(webDist, "client") }));

  // `build.manifest: true` (apps/web/vite.config.ts) writes the client Vite
  // manifest INTO the static root at `.vite/manifest.json`, and Hono's
  // serveStatic happily serves dotfile directories. That file maps every source
  // path to its hashed asset — including admin-only route chunks — and its
  // node_modules keys leak the exact installed version of every dependency,
  // which is free reconnaissance for anyone probing for a known CVE. The server
  // reads it from disk at startup; nothing needs it over HTTP. Deny it before
  // the catch-all static handler can find it. See locale-modulepreload.ts.
  app.all("/.vite/*", (c) => c.text("Not Found", 404));

  app.use("/*", serveStatic({ root: join(webDist, "client") }));

  // Mount TanStack Start for SSR — handles all non-static requests. The bundle
  // is produced by `apps/web` at build time and doesn't exist when this file is
  // type-checked, so the specifier is computed at runtime (a non-literal import
  // is left external by rolldown automatically).
  const startHandlerUrl = pathToFileURL(join(webDist, "server/server.js")).href;
  const { default: startHandler } = await import(startHandlerUrl);

  // Content-hashed locale aggregate chunks for SSR modulepreload. Built from
  // the client Vite manifest (apps/web `build.manifest: true`). Missing in
  // incomplete builds is non-fatal — visitors still load the locale on demand.
  loadLocaleModulePreloads(join(webDist, "client"));

  // Throttle the SSR catch-all. Everything above this line is either a static
  // file or an already-limited API route; everything reaching here renders
  // React on the server. Public pages are cached for SSR_CACHE_TTL_SECONDS,
  // but that cache is in-memory, per-replica, and keyed by URL — so a loop
  // appending a junk query string misses it every time and renders on each
  // request. Generous and fail-open on purpose: this is CPU protection, not a
  // security control, and it must never be why a real visitor can't load the
  // site. Mounted only in production, matching the SSR handler itself.
  app.use("/*", createRateLimiterMiddleware(ssrLimiter));

  app.all("/*", async (c) => {
    // Forward the per-request CSP nonce (from secureHeaders) to the SSR
    // renderer via a request header. getRouter() reads it server-side and sets
    // router.options.ssr.nonce, so TanStack Start stamps the matching nonce on
    // every inline script it injects — otherwise script-src would block them.
    //
    // Also forward the active non-default locale's aggregate chunk URL so the
    // SSR root can emit `<link rel="modulepreload">`. Both headers are
    // server-controlled: strip any client-supplied values first.
    const nonce = c.get("secureHeadersNonce");
    const headers = new Headers(c.req.raw.headers);
    headers.delete("x-csp-nonce");
    headers.delete(LOCALE_MODULEPRELOAD_HEADER);
    if (typeof nonce === "string") {
      headers.set("x-csp-nonce", nonce);
    }
    const localePreload = resolveLocaleModulePreload(new URL(c.req.raw.url).pathname);
    if (localePreload) {
      headers.set(LOCALE_MODULEPRELOAD_HEADER, localePreload);
    }
    const request = new Request(c.req.raw, { headers });
    // Public, anonymous GETs are served from a bounded in-memory HTML cache
    // (TTL via SSR_CACHE_TTL_SECONDS); everything else falls straight through
    // to the renderer. The nonce is swapped per request inside the cache.
    return handleSsrRequest({
      request,
      nonce: typeof nonce === "string" ? nonce : undefined,
      render: (req) => startHandler.fetch(req),
    });
  });
} else {
  app.get("/", (c) => {
    return c.text("OK");
  });
}

await lifecycle.start(() =>
  serve(
    {
      fetch: app.fetch,
      port: env.SERVER_PORT ?? env.PORT ?? 3000,
      // Node's default keepAliveTimeout (5s) is shorter than the idle-reuse window of
      // fronting proxies (nginx keepalive_timeout defaults to 60-75s; Traefik similar),
      // so the app would drop sockets the proxy still considers open → sporadic 502s/
      // ECONNRESETs. The app timeout must exceed the proxy's (65s here), and Node
      // requires headersTimeout > keepAliveTimeout (66s).
      serverOptions: {
        keepAliveTimeout: 65_000,
        headersTimeout: 66_000,
      },
    },
    (info) => console.log(`Server is running on http://localhost:${info.port}`),
  ),
);
