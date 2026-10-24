import { createEnv } from "@t3-oss/env-core";
import { S3_FORCE_PATH_STYLE as SHARED_S3_FORCE_PATH_STYLE, env as sharedEnv } from "./shared.js";
import { serverVars } from "./vars/server.js";
import { webVars } from "./vars/web.js";

// ---------------------------------------------------------------------------
// Full server environment.
//
// `extends: [sharedEnv]` merges in everything ./shared.ts already validated
// (database, redis, S3, translation) so server-side code keeps seeing a
// single `env` with every field. This module adds only the server-only
// variables and the startup guards that depend on them. The worker never
// imports this file, so a worker-only deployment is not required to set
// BETTER_AUTH_URL, BETTER_AUTH_SECRET, the rate-limit knobs, etc.
//
// The variable declarations themselves live in ./vars/server.ts — a
// side-effect-free module, so `pnpm env:check` can read the key set without
// running the startup guards below. Declare new variables there, never inline
// in the `createEnv` call.
//
// Disjointness contract: no key declared in ./vars/server.ts may also appear in
// ./vars/shared.ts — `extends` merges, it does not allow overriding.
// ---------------------------------------------------------------------------

export const env = createEnv({
  extends: [sharedEnv],
  server: serverVars,
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

// ---------------------------------------------------------------------------
// Re-exported worker-safe derived constants. Server-side modules import these
// from `@starter/env/server`,
// so keep them available here even though their source of truth is ./shared.ts.
// ---------------------------------------------------------------------------
export const S3_FORCE_PATH_STYLE: boolean = SHARED_S3_FORCE_PATH_STYLE;

// ---------------------------------------------------------------------------
// Admin emails — parsed once at startup into a Set for O(1) lookups.
// ---------------------------------------------------------------------------
export const ADMIN_EMAILS: Set<string> = new Set(
  (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export const SSO_ENABLED: boolean = env.SSO_ENABLED;
export const FORCE_SSO: boolean = env.FORCE_SSO;
export const SIGNUP_ENABLED: boolean = env.SIGNUP_ENABLED;

// Server-side display name. VITE_APP_NAME is declared exactly once — in
// ./vars/web.ts (the one-surface rule in scripts/lib/env-schema.ts forbids
// re-declaring it here) — but the server needs it too (seo.ts renders it into
// /llms.txt, and the Docker image carries it as a runtime ENV). This helper
// validates the raw runtime value against that same canonical schema instead
// of reading process.env inline, so an overlong/mistyped value fails fast at
// boot like every other env var instead of shipping into public SEO files.
// Empty string counts as unset: the Dockerfile defaults the build arg to ""
// and always exports the ENV, so "" is the common "not configured" shape.
export function resolveAppName(raw: string | undefined = process.env.VITE_APP_NAME): string {
  return webVars.VITE_APP_NAME.parse(raw || undefined) ?? "App";
}

// ---------------------------------------------------------------------------
// BETTER_AUTH_SECRET entropy check — catch weak/placeholder secrets early.
// ---------------------------------------------------------------------------
const WEAK_PLACEHOLDERS = [
  "changeme",
  "secret",
  "password",
  "your-secret-here",
  "replace-me",
  "placeholder",
];

function isWeakSecret(secret: string): string | null {
  // All-same-character strings (e.g. "aaaaaaaaaa…")
  if (new Set(secret).size === 1) {
    return "all characters are identical";
  }
  // Repeating hex-like patterns (e.g. "xxxxxxxx…", "00000000…")
  if (/^(.)\1+$/.test(secret) || /^(..)\1+$/.test(secret)) {
    return "repeating pattern detected";
  }
  // Known placeholder words (case-insensitive)
  const lower = secret.toLowerCase();
  for (const placeholder of WEAK_PLACEHOLDERS) {
    if (lower === placeholder || lower.includes(placeholder)) {
      return `contains placeholder word "${placeholder}"`;
    }
  }
  // Fewer than 10 distinct characters → low entropy
  if (new Set(secret).size < 10) {
    return `only ${new Set(secret).size} distinct characters (need at least 10)`;
  }
  return null;
}

const weakReason = isWeakSecret(env.BETTER_AUTH_SECRET);
if (weakReason) {
  const msg =
    `[env] BETTER_AUTH_SECRET is weak: ${weakReason}. ` +
    "Generate a strong secret with: pnpm generate:secret";
  if (env.NODE_ENV === "production") {
    throw new Error(msg);
  }
  console.warn(msg);
}

// Same entropy bar as BETTER_AUTH_SECRET, but only when SSO credentials are
// configured: SSO_CLIENT_SECRET is optional (unset = SSO inert), so an unset
// value must not warn. A weak-but-configured secret is live the moment
// SSO_ENABLED flips on — catch the placeholder before it becomes the IdP
// client secret in production.
if (env.SSO_CLIENT_SECRET) {
  const ssoWeakReason = isWeakSecret(env.SSO_CLIENT_SECRET);
  if (ssoWeakReason) {
    const msg =
      `[env] SSO_CLIENT_SECRET is weak: ${ssoWeakReason}. ` +
      "Generate a strong secret with: openssl rand -hex 32";
    if (env.NODE_ENV === "production") {
      throw new Error(msg);
    }
    console.warn(msg);
  }
}

// Admin lockout guard. The only in-app path to a NEW admin account is the
// email/password bootstrap signup for addresses in ADMIN_EMAILS (the auth
// database hook never promotes SSO/JIT-created users, regardless of SSO
// config), and SIGNUP_ENABLED=false blocks every user creation — email
// signup 403s and SSO just-in-time provisioning throws. Signup-disabled +
// empty ADMIN_EMAILS is therefore a lockout risk on a FRESH deploy, but a
// healthy shape for a provisioned one whose admins already persist in the
// database (clearing the bootstrap allowlist after provisioning is
// expected). This module cannot see the database at import time, so it must
// not refuse the boot here — that would brick every provisioned install
// that drops the allowlist. Warn in every environment so a fresh deploy
// still notices; the deploy stays up so existing admins can sign in.
// Fresh install with no admin yet: set ADMIN_EMAILS to a comma-separated
// list of operator emails, or set SIGNUP_ENABLED=true (requires SMTP).
if (ADMIN_EMAILS.size === 0 && !SIGNUP_ENABLED) {
  console.warn(
    "[env] SIGNUP_ENABLED=false and ADMIN_EMAILS is empty — no NEW admin can " +
      "be bootstrapped: with signup disabled no account can be created (email or SSO), and " +
      "the admin-bootstrap signup path requires an address in ADMIN_EMAILS " +
      "(SSO users are never auto-promoted). If this is a fresh install with no admin " +
      "yet, set ADMIN_EMAILS to a comma-separated list of operator emails, or set " +
      "SIGNUP_ENABLED=true (requires SMTP) to allow public registration. If admins " +
      "already exist in the database, this warning is expected and safe to ignore.",
  );
} else if (ADMIN_EMAILS.size === 0 && env.NODE_ENV === "production") {
  console.warn(
    "[env] ADMIN_EMAILS is empty — no users will have admin privileges. " +
      "Set ADMIN_EMAILS in your environment to grant admin access.",
  );
}

if (FORCE_SSO && env.NODE_ENV === "production") {
  const missing: string[] = [];
  if (!SSO_ENABLED) missing.push("SSO_ENABLED=true");
  if (!env.SSO_CLIENT_ID) missing.push("SSO_CLIENT_ID");
  if (!env.SSO_CLIENT_SECRET) missing.push("SSO_CLIENT_SECRET");
  if (!env.SSO_ISSUER) missing.push("SSO_ISSUER");
  if (missing.length > 0) {
    throw new Error(
      `[env] FATAL: FORCE_SSO=true in production requires ${missing.join(", ")}. ` +
        "Fix the SSO deployment secrets or unset FORCE_SSO before redeploying.",
    );
  }
}
const vapidMissing: string[] = [];
if (!env.VAPID_PUBLIC_KEY) vapidMissing.push("VAPID_PUBLIC_KEY");
if (!env.VAPID_PRIVATE_KEY) vapidMissing.push("VAPID_PRIVATE_KEY");
if (!env.VAPID_SUBJECT) vapidMissing.push("VAPID_SUBJECT");
if (vapidMissing.length > 0 && vapidMissing.length < 3) {
  const msg =
    `[env] Web push is partially configured — missing ${vapidMissing.join(", ")}. ` +
    "Set all three of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT " +
    "(generate a keypair with: pnpm generate:vapid), or unset them all to ship push inert.";
  if (env.NODE_ENV === "production") {
    throw new Error(msg);
  }
  console.warn(msg);
}

if (env.SMTP_HOST && !env.SMTP_FROM) {
  const msg =
    "[env] SMTP_HOST is set but SMTP_FROM is not. Outgoing email needs an explicit " +
    'From: address — set SMTP_FROM (e.g. "App Name <no-reply@yourdomain.com>").';
  if (env.NODE_ENV === "production") {
    throw new Error(msg);
  }
  console.warn(msg);
}

if (env.NODE_ENV === "production") {
  if (env.BETTER_AUTH_URL.startsWith("http:")) {
    throw new Error(
      "[env] BETTER_AUTH_URL must use https in production (it drives secure cookies and the canonical SEO origin).",
    );
  }
  if (env.CORS_ORIGIN?.startsWith("http:")) {
    throw new Error("[env] CORS_ORIGIN must use https in production.");
  }
  if (env.PUBLIC_APP_URL?.startsWith("http:")) {
    throw new Error("[env] PUBLIC_APP_URL must use https in production.");
  }
  if (env.S3_BUCKET && (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)) {
    throw new Error(
      "[env] S3_BUCKET is set but S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing.",
    );
  }
}

if (SIGNUP_ENABLED && !env.SMTP_HOST) {
  const msg =
    "[env] SIGNUP_ENABLED=true but SMTP_HOST is not configured. " +
    "Better-Auth enforces email verification on signup, so the first user to " +
    "register will hit a runtime error when the verification email tries to send. " +
    "Set SMTP_HOST/SMTP_PORT/SMTP_FROM (and SMTP_USER/SMTP_PASS if your provider " +
    "requires auth), or set SIGNUP_ENABLED=false until SMTP is wired up.";
  if (env.NODE_ENV === "production") {
    throw new Error(msg);
  }
  console.warn(msg);
}
