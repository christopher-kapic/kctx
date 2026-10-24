import { z } from "zod";
import { originUrl } from "../url.js";
import { strictBooleanFlag } from "./shared.js";

// ---------------------------------------------------------------------------
// Server-only variable DECLARATIONS. See ./shared.ts for why these live in a
// side-effect-free module of their own.
//
// Disjointness contract: no key declared here may also appear in ./shared.ts —
// `extends` merges, it does not allow overriding.
// ---------------------------------------------------------------------------

export const serverVars = {
  WORKER_MODE: z.enum(["embedded", "external"]).default("embedded"),
  // Optional process port override. Portless and production platforms inject
  // `PORT`; `SERVER_PORT` is only for raw local runs or container overrides.
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  SERVER_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: originUrl("BETTER_AUTH_URL"),
  CORS_ORIGIN: originUrl("CORS_ORIGIN").optional(),
  SSO_ENABLED: strictBooleanFlag(),
  SSO_CLIENT_ID: z.string().optional(),
  SSO_CLIENT_SECRET: z.string().optional(),
  SSO_ISSUER: z.string().optional(),
  SSO_PROVIDER_NAME: z.string().default("SSO"),
  FORCE_SSO: strictBooleanFlag(),
  SIGNUP_ENABLED: strictBooleanFlag(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  // Web Push contact URI sent to push services (RFC 8292 requires a mailto:
  // or https: URL the service can use to reach you about problems).
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:)/, "VAPID_SUBJECT must be a mailto: or https: URL")
    .optional(),
  // ---- Rate limiting: five named budgets, two knobs each. -----------------
  // Each budget describes its family's REFERENCE member (the number below);
  // every other limiter in the family keeps its ratio to that reference, so
  // setting a budget re-tunes the whole family coherently:
  //
  //   • POINTS multiplies every family member's points by provided/reference.
  //   • WINDOW_SECONDS multiplies every member's window AND block duration by
  //     the same factor (the window:block ratio is part of each member's
  //     design and moves as a unit).
  //
  // Why not one knob per limiter: a per-surface
  // knob invites squeezing one budget to "be safe" — which locks out a
  // shared office behind one NAT IP — instead of SPLITTING the surface that
  // needs its own bucket. Tighter is not safer; if one surface 429s
  // legitimate users, split the surface instead of shrinking a budget.
  // Burst/sustained ratios, bucket keying, and fail-open/fail-closed stay
  // fixed in code (apps/server/src/rate-limit.ts +
  // packages/api/src/lib/rate-limit-families.ts). Defaults reproduce the
  // shipped numbers exactly.
  //
  // AUTH family — the fail-closed /api/auth/* limiters: general auth surface
  // (this reference, 30/60 s + 5-min block), credential (10/60 s),
  // credential burst (3/10 s), signup (10/h), and 2FA-OTP resend
  // (3/15 min). IP-keyed, so shared-NAT
  // offices share these budgets — size for several concurrent humans.
  RATE_LIMIT_AUTH_POINTS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // RPC family — ordinary request volume: /rpc/* (this reference, 100/60 s),
  // /ready (60), and the SSR catch-all (300).
  RATE_LIMIT_RPC_POINTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_RPC_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // UPLOAD family — media GET surfaces where one page costs many requests:
  // /api/assets/* (this reference, 200/60 s) and /api/images/* (300).
  RATE_LIMIT_UPLOAD_POINTS: z.coerce.number().int().positive().default(200),
  RATE_LIMIT_UPLOAD_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // EMAIL family — per-RECIPIENT caps on the anonymous endpoints that mail a
  // caller-supplied address: verification resend / password reset (this
  // reference, 3 per hour), signup (6), and sign-in-triggered mails (10).
  // The 0-second block stays code-fixed: a block on a caller-supplied key is
  // an unauthenticated lockout lever against that user's password reset.
  RATE_LIMIT_EMAIL_POINTS: z.coerce.number().int().min(0).default(3),
  RATE_LIMIT_EMAIL_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  // CHAT family — the durable chat surface: accepted turns / spend (this
  // reference, 20/60 s, fail-closed), session creation (30), and the SSE
  // stream (60).
  RATE_LIMIT_CHAT_POINTS: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_CHAT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // Number of reverse-proxy hops in front of the app, for deriving the real
  // client IP used as the anonymous rate-limit key.
  //
  // Leave UNSET (the default) for zero-config behaviour that is correct for
  // every deploy target in our docs (Render, Railway, Dokploy/nginx, Azure
  // Container Apps): the app trusts the client IP that a proxy on a
  // private/loopback network forwarded, and otherwise (bare deployment, local
  // dev) keys on the real socket peer. See apps/server/src/client-ip.ts.
  //
  // Set this only when a proxy in front of the app has a PUBLIC IP (e.g.
  // Cloudflare, a public load balancer) or your topology is fixed: it is the
  // exact number of proxies between the client and the app. 0 disables
  // X-Forwarded-For entirely and always keys on the socket peer.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).optional(),
  ADMIN_EMAILS: z.string().optional(),
  // Comma-separated allowlist of hostnames the image endpoint may proxy
  // (SSRF protection). Empty = the image endpoint refuses external URLs and
  // only serves transformations of stored Assets. Example:
  // IMAGE_PROXY_ALLOWED_HOSTS=cdn.example.com,images.partner.com
  IMAGE_PROXY_ALLOWED_HOSTS: z.string().default(""),
  IMAGE_PROXY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  IMAGE_PROXY_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  IMAGE_TRANSFORM_MAX_INPUT_PIXELS: z.coerce.number().int().positive().default(50_000_000),
  // On-by-default kill switch for the S3 write-back cache of sharp image
  // transforms (GET /api/images/:id). true (default) caches transformed
  // variants under the `transforms/` prefix so a repeat request serves stored
  // bytes; false disables cache read AND write, restoring the
  // transform-on-every-miss behaviour exactly.
  IMAGE_TRANSFORM_CACHE: strictBooleanFlag(true),
  // Hard cap on cached variants per asset. Transform params are
  // caller-controlled, so without a cap one asset could accumulate an
  // unbounded number of `transforms/<id>/…` objects. Past the cap, transforms
  // still run — they just stop being written back to storage.
  IMAGE_TRANSFORM_CACHE_MAX_VARIANTS: z.coerce.number().int().positive().default(32),
  // Hard cap on a single asset upload, in bytes. The Hono-level 10 MB body
  // limit still applies independently — set this lower if you want to reject
  // large uploads earlier with a clearer error.
  ASSET_UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  // TTL (seconds) for the in-memory SSR HTML cache of public pages
  // (apps/server/src/ssr-cache.ts). 0 disables the cache entirely; the
  // default keeps a cached public render for up to a minute. Edits to a live
  // URL can take up to this long to appear. See patterns/ssr-for-articles.md.
  SSR_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(60),
};
