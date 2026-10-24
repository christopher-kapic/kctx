# Production Hardening

## Checklist

Walk this list before the first production deploy. Check every box against the running config, not against memory.

- [ ] `notes/02-users-and-roles.md` exists and every procedure you shipped matches its row (capability, role, own vs all).
- [ ] [Launch readiness](./launch-readiness.md) has been checked against the enabled app and live configuration. `notes/06-launch-readiness.md` records applicability and evidence for every topic; no applicable item or unanswered owner decision remains blocked. Passing code checks does not establish legal compliance.
- [ ] `SIGNUP_ENABLED` is the value you intended (`false` is the shipped default).
- [ ] `BETTER_AUTH_URL` is https in production.
- [ ] The schema settings match the chosen platform. Dokploy native Git keeps exactly one leader `APPLY_SCHEMA=safe` and followers `off` + `WAIT_FOR_SCHEMA=true`; development may auto-deploy `main`/`master`, production is manual on one immutable release tag. After any dangerous attempt, clear confirmation/acceptance values and return its leader to `safe`. Dokploy on a VPS is the only target this repo documents; any other platform follows the same explicit-toggle lifecycle — one leader, followers `off`, and `dangerous` set only for the single deploy that needs it, cleared straight after. Never leave `dangerous` enabled. See [schema-push § The APPLY_SCHEMA contract](./schema-push.md#the-apply_schema-contract).
- [ ] `BACKUP_S3_BUCKET` is set and a restore drill has been run (`patterns/backup-and-restore.md`).
- [ ] Rate limiters in `apps/server/src/rate-limit.ts` are still mounted; none share a `keyPrefix` across unrelated surfaces.
- [ ] Admin emails, SMTP, and 2FA policy match `notes/02-users-and-roles.md`.
- [ ] The owner's admin account has TOTP enrolled before go-live. Forced 2FA for **internal (admin) users ships ON**: with no `force2faInternalUsers` AppSetting row, the gates require a second factor, and an admin account gets a **24-hour enrollment grace window from `User.createdAt`** before that requirement bites. So enrollment is not optional homework — walk the owner through it (Settings → Security, backed by the Better-Auth twoFactor client API) inside that window, or they lose the admin dashboard until they do. See [production-hardening.md § Forced two-factor authentication](#forced-two-factor-authentication).
- [ ] **If you built the API-keys or device-authorization add-ins** (neither ships), each bearer surface is hardened per its doc: a dedicated limiter that is **not** a remount of `rpcLimiter` (an api-key bucket keyed on the *hashed* key; a fail-closed `deviceLimiter` for the poll that bypasses the general auth limiter), the plugin's own per-key quota disabled, every cookie-only surface still refusing `Authorization`, and the standing bearer credential recorded in `notes/02-users-and-roles.md`. See [add-ins/api-keys.md](./add-ins/api-keys.md) and [add-ins/devices.md](./add-ins/devices.md).

Five production-safety layers ship with this starter: **Redis-backed rate limiting**, **admin gating with email verification**, **CSRF protection for cross-origin deployments**, an **admin-only OpenAPI reference in production**, and a **scoped CSP override** for widening one directive on one path. Each section covers the problem, the fix, how to tune it, how to verify locally, and what breaks if you misconfigure it.

---

## 1 — Rate Limiting (rate-limiter-flexible + Redis)

### Problem

The starter originally had no rate limiting. Any client could hammer `/api/auth/*` for credential-stuffing or flood `/rpc/*` to exhaust server resources.

### Fix

`apps/server/src/rate-limit.ts` exports several `RateLimiterRedis` instances backed by the shared ioredis connection from `@starter/queue`. **[rate-limiting.md](./rate-limiting.md) is the full reference** — how to size a budget, how to add one for a new surface, and the shared-NAT trap that makes a *tighter* limit the wrong instinct. The headline shape:

| Limiter | Path | Default budget | Block duration |
|---|---|---|---|
| `credentialLimiter` | `/api/auth/sign-in/*`, `/api/auth/two-factor/*` | 10 req / 60 s | 5 min |
| `authLimiter` | the rest of `/api/auth/*` | 30 req / 60 s | 5 min |
| `signupLimiter` | `/api/auth/sign-up/*` | 10 req / hour | 15 min |
| `emailRecipientLimiter` / `signupRecipientLimiter` | anonymous send-mail endpoints | 3 / 6 per address per hour | — |
| `rpcLimiter` | `/rpc/*`, `/api-reference/*`, `/sw/*` | 100 req / 60 s | — (resets each window) |
| `assetLimiter` | `/api/assets/*` (own bucket — **not** a remount of `rpcLimiter`) | 200 req / 60 s (UPLOAD reference) | — |
| `readyLimiter` | `/ready` (own bucket) | 60 req / 60 s | — |
| `imageLimiter` | `/api/images/*` | 300 req / 60 s | — |
| `ssrLimiter` | server-rendered catch-all | 300 req / 60 s | — |

This table covers the main surfaces, not all of them — `apps/server/src/rate-limit.ts` is
authoritative, and also defines `chatStreamLimiter`, `signinRecipientLimiter`,
`twoFactorOtpLimiter`, and the procedure-level budgets in
`packages/api/src/lib/procedure-budget.ts`. See [rate-limiting.md](./rate-limiting.md).

**Add-in credentials bring their own limiters (not shipped).** The API-keys and device-authorization add-ins each add a bearer surface with its own bucket — an api-key limiter keyed on the *hashed* key, and a fail-closed `deviceLimiter` for the poll that must bypass the general auth limiter (two concurrent device authorizations from one office egress otherwise trip a multi-minute block that also takes sign-in and password reset down). Neither exists until you build the add-in; when you do, register it here alongside the shipped set and never remount `rpcLimiter` for it. See [add-ins/api-keys.md § 2. Rate-limit family and env](./add-ins/api-keys.md#2-rate-limit-family-and-env) and [add-ins/devices.md § 4. Who may approve, and the poll limiter](./add-ins/devices.md#4-who-may-approve-and-the-poll-limiter).

Credential endpoints are split out from the general auth surface on purpose: these limiters key on client IP, and a single tight limit across all of `/api/auth/*` would lock a shared office out of password reset and email verification along with sign-in.

**Fail mode is split by limiter:**

- **General limiters (`rpcLimiter`, plus the asset and image mounts) fail open.** If Redis is unreachable the request passes through — a Redis blip should not take down the whole API. Each carries an in-memory `insuranceLimiter` that still enforces a slightly more generous ceiling during the outage.
- **The strict auth-facing limiters fail closed** — `authLimiter`, `signupLimiter`, `credentialLimiter`, and `credentialBurstLimiter`. They are mounted with `createRateLimiterMiddleware(limiter, { failClosed: true })` and deliberately carry **no** `insuranceLimiter`, so a Redis outage surfaces as a connectivity error the middleware turns into a **503 + Retry-After** (body: `{ "error": "Service temporarily unavailable. Please try again in a moment." }`). Credential-stuffing and signup-spam protection must not silently disappear when Redis is down, and an in-memory-only ceiling per app instance is not a real defense across a horizontally-scaled fleet. This trades availability of `/api/auth/*` during a Redis outage for that guarantee; the general API stays up.

> **Algorithm note — "enhanced fixed window", not sliding window.**
> `rate-limiter-flexible` uses an *enhanced fixed window* algorithm by default: it counts hits per fixed-duration bucket with partial-overlap weighting from the previous bucket. This is **not** a true sliding window — don't replace the library or change the configuration thinking the name is wrong. It is accurate and good enough for abuse prevention.

### Tune

Every family is tuned through its budget pair (see `.env.example`'s Advanced
tuning section). Each budget describes its family's REFERENCE member; every
other member scales with it at its designed ratio — points AND windows/blocks:

```env
RATE_LIMIT_AUTH_POINTS=30              # reference: /api/auth/*; credential 10,
                                       # burst 3/10s, signup 10/h, 2FA 3/15min
                                       # all scale with this
RATE_LIMIT_AUTH_WINDOW_SECONDS=60      # scales every auth window AND block
RATE_LIMIT_RPC_POINTS=100              # reference: /rpc/*; /ready and SSR scale
RATE_LIMIT_RPC_WINDOW_SECONDS=60
```

`.env.example` is generated from `scripts/lib/env-manifest.ts` and lists every knob with a hint; that file is the authority, this block is an orientation. The full surface table lives in [rate-limiting § Give every surface its own bucket](./rate-limiting.md#give-every-surface-its-own-bucket).

To relax limits during development, set high values in your root `.env`. To tighten in production, **split the surface rather than shrinking a shared budget** — these limiters key on client IP, and an office shares one. See [rate-limiting § Give every surface its own bucket](./rate-limiting.md#give-every-surface-its-own-bucket).

### Verify locally

```bash
# Burn through the auth budget — the 11th request should return 429:
for i in $(seq 1 11); do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/auth/sign-in/email
done
# Expected: ten 200s (or 4xx auth errors), then 429.

# Check response headers on any request:
curl -I http://localhost:3000/rpc/health
# Look for: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
```

### Failure mode in production

- **Redis down** → the **general** limiters fail open (request passes through), so there's effectively no throttling on `/rpc/*` and the asset and image routes until Redis recovers. Each general limiter's insurance limiter mitigates this — don't remove it. The **auth/signup/credential** limiters instead fail closed (503), so `/api/auth/*` is unavailable during the outage rather than unthrottled — that's intentional; don't add an insurance limiter to them expecting fail-open behavior.
- **`RATE_LIMIT_AUTH_POINTS` set too low** → legitimate users get locked out after a few login attempts (especially with 2FA retries, which cost 4-5 requests) — and it rescales the whole auth family, so the credential, signup, and 2FA-OTP budgets tighten with it. It is IP-keyed, so the third person behind an office NAT is the one who feels it — and being locked out of `/api/auth/*` means being locked out of password reset and email verification too, which is exactly what they need next. Start at 30 and monitor before tightening.
- **`RATE_LIMIT_AUTH_WINDOW_SECONDS` set too high** → windows AND block durations stretch together (blocks stay at 5× the window by design), so a mistyped password blocks the user for minutes to hours — and again, one shared IP means one blocked office. 60 s windows with 300 s blocks is the balance point.
- **Lowering a limit to be "safe"** → the shared-IP problem above, at every scale. The right move is a new limiter with its own `keyPrefix` on the specific surface you are worried about.
- **Missing `x-forwarded-for` behind a proxy** → all anonymous traffic shares one key (`"unknown"`), so a single abuser rate-limits everyone. Ensure your reverse proxy (Nginx, Caddy, Dokploy) forwards the real client IP.

### Per-recipient email flood limits

Every *other* limiter keys on **client IP**. That bounds how fast one caller can
hit an endpoint; it does not bound how much mail one *mailbox* receives.

Three anonymous endpoints mail a caller-supplied address:
`/api/auth/send-verification-email` (the resend control on `/$lang/verify-email`),
`/api/auth/request-password-reset`, and
`/api/auth/sign-up/email` (which mails a verification link because
`sendOnSignUp` is on). The first two sit behind `authLimiter`
(the AUTH budget reference, default 30 per 60 s) and signup behind `signupLimiter`
— both **IP**-keyed. An attacker with rotating IPs — a botnet, a proxy pool, or
plain IPv6 — multiplies that ceiling by the number of source addresses they can
reach, and every request lands in the same victim's inbox. The victim cannot opt
out, and the mail genuinely comes from you, so the cost is sender reputation as
much as nuisance.

**This ships enabled.** `emailRecipientLimiter` (`apps/server/src/rate-limit.ts`)
is keyed on the normalized recipient and mounted by
`apps/server/src/email-recipient-limit.ts` on the first two paths, after the IP
limiter. Default: **3 messages per address per hour**, generous for a human and
useless for flooding.

**Signup gets its own bucket**, `signupRecipientLimiter`, at a higher default
(**6 per address per hour**, 2× the family reference). Two reasons
it is not folded into the shared one. First, budgets should not cross purposes:
a signup flood must not consume the allowance a legitimate user needs to reset
their own password. Second, signup tolerates more — one shared NAT egress (an
office, a school, a mobile carrier) legitimately produces several distinct
signups an hour, and unlike a resend, every request that gets through must name
a *different* address anyway (an already-registered one is rejected before any
mail is sent). Note the reachable target here is therefore **unregistered**
addresses, and each attempt also creates a real `User` row — so this is a row
flood as much as a mail flood. `SIGNUP_ENABLED=false` closes the path entirely,
but that is not the default.

#### Tune

| Variable | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_EMAIL_POINTS` | `3` | Family reference: messages per address per window on the resend/reset endpoints. **`0` disables the whole recipient family** — resend/reset, signup, and sign-in buckets (no Redis round-trip). |
| `RATE_LIMIT_EMAIL_WINDOW_SECONDS` | `3600` | Window, seconds; scales all three recipient buckets. |

The member ratios (signup 6, sign-in-triggered mails 10) and the block stay
code-fixed: the block is **0 on purpose** — read the note below before
touching it.

#### Design notes worth not undoing

**The recipient family's block duration is code-fixed at 0 on purpose — raising
it hands attackers a lockout lever.** Every other limiter here keys on something the *caller* controls about
themselves (their IP, their session). This one keys on an identifier the caller
supplies about *someone else*. That is what makes it effective, and it is also
its hazard: with a non-zero block, four unauthenticated POSTs to
`/request-password-reset` deny that specific user a password reset for the whole
block window, and every retry extends it — no account, no session, no knowledge
of the victim required beyond their address. At `0` the fixed window still
caps throughput, but suppression can never outlast the current window. There is
deliberately no env knob: raising it is a code review that re-reads this note.

**It fails open, unlike `authLimiter`/`signupLimiter`.** Those fail closed
because losing them exposes credential stuffing and signup spam — a genuine
security regression. This one is anti-abuse layered on an IP limiter that is
still enforced (fail-closed) on the very same routes, so a Redis outage never
leaves these endpoints unthrottled. Failing closed here would instead lock every
user out of their own password reset during a blip.

**A 429 here does not leak account existence.** The counter is driven purely by
how many times someone *asked* for an address, never by whether an account
exists or is already verified — probing an unregistered address and a real
unverified one returns byte-identical responses until the shared cap is hit.
That is what lets the rejection carry an honest "wait and try again" message
rather than a fake success. Do not "fix" this into a neutral success response:
it would strand a legitimate user waiting for a reset mail that never arrives,
and buys no enumeration resistance that the constant-time floor in Better-Auth's
handler doesn't already provide. The web clients already surface 429s via
`isRateLimit()` in `apps/web/src/utils/friendly-error.ts`.

**The key is `email.trim().toLowerCase()` and nothing more.** No provider
canonicalization (stripping Gmail dots, collapsing `+tag` suffixes): those rules
differ per provider, and folding `a+work@x.com` into `a@x.com` would let one
abusive address consume a different user's budget.

**An unparseable body consumes no budget.** Otherwise a malformed-request flood
could burn a real address's allowance without ever sending mail.

**The limiter accepts exactly the media types Better-Auth does — no more, no
less.** Both directions of a mismatch are bugs, and the middleware has been
wrong in each at some point. Accepting *less* is a full bypass: Better-Auth
allows form-urlencoded on `/sign-up/email` (`sign-up.mjs`), so a JSON-only
limiter let a caller flip one header and send unmetered mail. Accepting *more*
burns a victim's budget on mail that is never sent, since Better-Auth 415s the
request after the point is spent. The subtlety is that better-call matches on
the media type's **base** (`split(";")[0]`), so a loose substring test over the
whole header reopens the bypass via a parameter —
`application/x-www-form-urlencoded; charset="application/json"`. `readEmail` in
`apps/server/src/email-recipient-limit.ts` mirrors that logic, and
`SIGNUP_MEDIA_TYPES` carries the one route that widens the global JSON-only
default. Enabling a plugin that mails a caller-supplied address (`emailOTP` is
the one to watch) means adding its paths there too.

**`/change-email` is deliberately excluded** — it requires a session and mails
the address the authenticated user nominated, so the per-user auth limiter
covers it.

#### Verify locally

```bash
# 4th request for the same address inside the window → 429
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/auth/send-verification-email \
    -H 'Content-Type: application/json' -d '{"email":"victim@example.com"}'
done

# A media type Better-Auth would refuse is refused here too, without spending
# a point — 415, and the counter above is untouched.
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/auth/send-verification-email \
  -H 'Content-Type: application/x-www-form-urlencoded' -d 'email=victim@example.com'
# Expected: 415
# → 200 200 200 429

# A different mailbox is unaffected
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/auth/send-verification-email \
  -H 'Content-Type: application/json' -d '{"email":"someone-else@example.com"}'
# → 200
```

Covered by `apps/server/src/email-recipient-limit.test.ts`, including the
`.clone()` behavior that keeps the request body readable for the downstream auth
handler — the easiest thing to break here.

---

## 2 — Admin Gating + Email Verification

### Problem

The original starter promoted the **first user to sign up** to admin automatically. This is a critical vulnerability in any deployment where sign-up is open — an attacker who reaches the app first owns it.

### Fix

Two changes work together:

1. **`ADMIN_EMAILS` env var** — a comma-separated allowlist of email addresses that receive the `admin` role on the explicit email/password bootstrap sign-up path. Defined in `packages/env/src/vars/server.ts`, parsed into an `ADMIN_EMAILS` `Set` by `packages/env/src/server.ts`, consumed by a Better-Auth `databaseHooks.user.create.before` hook in `packages/auth/src/index.ts`. Any email not in the list gets the default `user` role.

2. **`adminProcedure`** — a procedure builder in `packages/api/src/index.ts` that stacks two middlewares:
   - `requireAuth` — rejects unauthenticated requests (`UNAUTHORIZED`).
   - `requireAdmin` — rejects users whose email is not verified (`FORBIDDEN: Email verification required`) **and** users whose role list does not include `admin` (`FORBIDDEN: Admin access required`).

   The email-verification check prevents an attacker from registering with a spoofed admin email and immediately accessing admin endpoints before proving they own the address.

3. **Email verification** — Better-Auth's `emailVerification` is configured in `packages/auth/src/index.ts` with `sendOnSignUp: true`. The starter uses `@starter/mailer` (nodemailer) to send verification emails via SMTP.

4. **Password reset** — `emailAndPassword.sendResetPassword` (same file) emails a reset link via `@starter/mailer` when a user requests one from `/{lang}/forgot-password` (and the native sign-in form's "Forgot password?" affordance). Like verification and email-OTP, it **requires working SMTP** — with SMTP unconfigured the web forgot-password page deflects to login and no reset email can be delivered. Both reset endpoints (`/api/auth/request-password-reset`, `/api/auth/reset-password/*`) sit behind the strict `authLimiter`. Confirm SMTP is reachable in staging before relying on self-service password recovery in production.

> **SSO nuance:** SSO-created users are not auto-promoted by `ADMIN_EMAILS`. That is intentional: not every identity provider's email claim is equally trustworthy, and some IdPs let users influence the claim. Treat SSO admin access as a manual approval step: verify the person in the IdP/admin console, then grant the `admin` role through your approved admin/provisioning path. You may still mark `emailVerified: true` for trusted IdPs so SSO users are not forced through a second email-verification flow.

> **Signup-disabled nuance:** `SIGNUP_ENABLED=false` blocks self-provisioning across both email/password signup and SSO just-in-time user creation. Existing SSO users can still sign in because no new user row is created for them. New users must be invited by an admin, created by a seed/provisioning script, or allowed through the `ADMIN_EMAILS` email/password bootstrap path.

### Who email verification gates

The template gates **privilege escalation, not basic use**. Both layers agree on this, deliberately:

| Surface | Server | Client route guard | Requires verified email |
|---|---|---|---|
| Dashboard, settings, ordinary app | `protectedProcedure` | `decideProtectedRouteAccess` | **No** |
| Admin tree | `adminProcedure` / `adminOr404Procedure` | `decideAdminRouteAccess` | Yes |
| Better-Auth admin plugin routes (`/api/auth/admin/*`) | `betterAuthAdminGate` | — | Yes — **and** the `admin` role |
| OpenAPI reference (`/api-reference/*`, production only) | `apiReferenceAdminGate` | — | Yes — **and** the `admin` role |

The route guards are UX; the procedures are the boundary. Keep them in step — a check added to a guard that the matching procedure doesn't enforce buys nothing.

The Better-Auth plugin routes are the case that proves the rule. A plugin's own handlers typically check only "is this caller signed in", so a client guard alone would be trivially bypassable by POSTing to the endpoint directly. The Hono gates in `apps/server/src/` supply the missing boundary — mounted *before* the auth handler and sharing `requireVerifiedAdminSession` (`apps/server/src/admin-session-gate.ts`). If you are auditing this table, check `apps/server/src/index.ts` for such middleware and not just the plugin config: several of this app's auth-route boundaries live there rather than in `packages/auth`. Any plugin you add that exposes a privileged endpoint needs the same treatment.

**Unverified sessions really do occur.** `emailAndPassword.requireEmailVerification` only governs password sign-in. SSO users are created with whatever their IdP asserts in the `email_verified` claim, which Better-Auth defaults to `false` when the provider omits it — Google, Okta, and Keycloak send it; **Entra ID does not**. With `sendOnSignUp: true` those users are mailed a verification link on first SSO login, so they have a path to verified, but they hold a usable session before clicking it.

#### If your product requires verification for all access

Three changes, in this order. Doing only the first two produces an infinite redirect loop.

1. **Add a decision kind** to `ProtectedRouteDecision` — `redirect-to-verify`, not `redirect-to-login`. Sending an unverified-but-authenticated user to `/login` bounces straight off `decideAnonymousOnlyRouteAccess` (which redirects *any* authenticated visitor away) and loops until the browser gives up.
2. **Point it at `/{lang}/verify-email`** and handle the new kind in `_auth.tsx`. A guard redirect arrives with neither `?ok=1` nor `?error=`, which that page renders as its "we don't know your state" branch: the `pendingTitle` copy plus `<ResendVerification />`. That is the branch you want — do **not** "simplify" the page by treating a bare visit as success, or a redirected unverified user is told their address is already confirmed. Note the resend form is itself gated on `emailEnabled && !forceSso` (an SSO-only server has no password flow to come back to), so on such a deployment this route is informational only.
3. **Enforce it server-side** in `requireAuth` (`packages/api/src/index.ts`) — otherwise it's cosmetic. Mirror `requireAdmin`, which throws `FORBIDDEN` with the message `Email verification required for admin access.`

Then decide what SSO should do, because step 3 locks out every user from an IdP that omits the claim. Either map the claim explicitly via `genericOAuth`'s `mapProfileToUser` (only for an IdP you trust to verify addresses), or accept that SSO users complete the emailed verification once.

Update `apps/web/src/lib/route-session-access.test.ts` — a test pins the current asymmetry on purpose, so it will fail and force this to be an intentional change.

### Forced two-factor authentication

Two `AppSetting` rows scope the requirement by role: `force2faInternalUsers` (admins) and `force2faPublicUsers` (everyone else). An admin flips them at **Admin → Settings → Security**, and `settings.update` refuses to turn either one **on** unless the calling admin has already enrolled — you cannot lock yourself out by requiring of others what you have not done.

**The internal default is ON.** When the `force2faInternalUsers` row is absent, the policy resolves to `true`; `force2faPublicUsers` resolves to `false`. Those defaults live in `FORCE_2FA_DEFAULTS` in `packages/auth/src/two-factor-policy.ts` — one module, imported by both the server gate (`packages/api/src/lib/two-factor-policy.ts`) and the browser mirror (`apps/web/src/utils/two-factor-policy.ts`), so the two cannot drift. In this template the admin account is the entire security boundary, so a fresh deployment must not sit behind a single phishable password while nobody has gotten around to writing a settings row. Writing the row explicitly still wins: `"false"` turns enforcement off, and the admin settings page renders the *effective* value, so an untouched install reads "Required".

**The enrollment grace window.** A default of "required" would lock the very first admin out before they ever reached the enrollment screen, so an unenrolled user still satisfies the policy while `now - User.createdAt < TWO_FACTOR_ENROLLMENT_GRACE_MS` (24 hours, same module). After that the ordinary rejection applies, unchanged. Three properties matter when you touch this:

- The grace covers the **forced-2FA check only**. Email verification and role checks are never graced.
- A missing or unparseable `createdAt` means **no grace** — it fails closed.
- Every enforcement point must actually pass `createdAt` through. Server-side that is `isTwoFactorPolicySatisfied(session.user)` in `requireRequiredTwoFactor` / `requireAdmin` / `requireAdminOr404` (`packages/api/src/index.ts`) and `requireVerifiedAdminSession` (`apps/server/src/admin-session-gate.ts`); client-side it is the `_auth` route guard, which reads `createdAt` from the `getRouteSession()` projection (carried as epoch milliseconds across the server-function boundary).

**Enrollment stays reachable.** The `_auth` layout replaces its outlet with the TOTP enrollment flow for a post-grace admin rather than redirecting or 404-ing, and that flow talks to Better-Auth's `/api/auth/two-factor/*` endpoints, which are not behind the admin gate. The two-factor plugin enables `allowPasswordless`, so an SSO-only account can enroll with its authenticated session while a password-bearing account must still confirm its password. A locked-out admin can always enroll their way back in; they cannot reach the rest of the app first.

Inside the window the admin dashboard shows the `TwoFactorNudge` banner with the deadline as a locale-formatted relative time; past it the same banner says access is already blocked. Do not weaken the internal default or the grace window without an explicit user request — see AGENTS.md § Agent Safety Rules.

### Tune

```env
# Comma-separated list of admin emails (case-insensitive)
ADMIN_EMAILS=alice@example.com,bob@example.com

# SMTP for verification emails
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASS=secret
SMTP_FROM=noreply@example.com
```

To bootstrap the first admin: add their email to `ADMIN_EMAILS`, restart the server, and have them use the email/password sign-up form with that exact email address. To grant admin to an existing user or to an SSO user, update their role through your approved admin/provisioning path after verifying the person.

### Verify locally

```bash
# 1. Set ADMIN_EMAILS in .env to your test email
# 2. Sign up with that email — check the user record:
pnpm prisma studio   # open Prisma Studio, find user → role should be "admin"

# 3. Sign up with a DIFFERENT email → role should be "user"

# 4. Test the gate: call an admin-only procedure as a non-admin user
#    → should get FORBIDDEN response

# 5. Test email verification gate: create an admin user but don't verify email
#    → admin procedures should return "Email verification required"
```

### Failure mode in production

- **`ADMIN_EMAILS` not set or empty with `SIGNUP_ENABLED=false`** → the server logs a startup warning in every environment (`packages/env/src/server.ts`) but keeps booting: with signup off no NEW admin can be bootstrapped, so on a fresh install this is a lockout risk — set `ADMIN_EMAILS` before the first signup. On a provisioned install whose admins already persist in the database the warning is expected (clearing the bootstrap allowlist after provisioning is the point) and safe to ignore. With `SIGNUP_ENABLED=true` it is likewise a warning: the first admin must be created another way before the allowlist matters.
- **`ADMIN_EMAILS` contains a typo** → that email never matches. The intended admin signs up as a regular user if public signup is enabled, or is blocked if signup is disabled. Fix the env var and have them re-register (or update the role directly in the database).
- **SMTP misconfigured + `requireEmailVerification: true`** → verification emails never send, so **no one can sign in at all** (Better-Auth blocks unverified users at the sign-in step). Test SMTP in staging before you open sign-up. The same misconfiguration also breaks self-service **password reset** — the reset link never arrives, so forgotten passwords have no recovery path until SMTP is fixed.

### Local-testing note

There is **no auth-bypass mode**. Local agent UI testing exercises the genuine signup → email-verification → 2FA flow; the dev stack just ships an in-stack mailpit SMTP sink so the verification email is captured locally with zero credentials. See [patterns/agent-ui-testing.md § Testing auth-gated features](./agent-ui-testing.md#testing-auth-gated-features).

---

## 3 — CSRF Protection (SimpleCsrfProtectionHandlerPlugin)

### Problem

When the API server and web client are on different origins (e.g., `api.example.com` + `app.example.com`), the browser's same-origin policy no longer blocks cross-site request forgery. An attacker's page can submit forms to your API if credentials (cookies with `SameSite=None`) are sent automatically.

### Fix

oRPC's `SimpleCsrfProtectionHandlerPlugin` is conditionally enabled when `CORS_ORIGIN` is set (see `apps/server/src/index.ts`):

```ts
const csrfPlugins = env.CORS_ORIGIN
  ? [new SimpleCsrfProtectionHandlerPlugin()]
  : [];
```

The plugin requires every mutating request to include an `x-csrf-token` header. The client-side oRPC link (`SimpleCsrfProtectionLinkPlugin`) adds this header automatically. A cross-site attacker cannot set custom headers on a cross-origin request (browsers block it at preflight), so the attack fails.

For same-origin deployments (`CORS_ORIGIN` unset), the plugin is skipped — the browser's default `SameSite=Lax` cookies and same-origin restrictions are sufficient.

### Tune

There are no knobs to turn. The protection is binary:

- `CORS_ORIGIN` is set → CSRF plugin is active.
- `CORS_ORIGIN` is unset → CSRF plugin is inactive.

Make sure the CORS middleware's `allowHeaders` includes `"x-csrf-token"` (it does by default in `apps/server/src/index.ts`). If you add a custom proxy that strips headers, whitelist it there too.

### Verify locally

```bash
# 1. Start the server with CORS_ORIGIN=http://localhost:5173 (the Vite dev server)
# 2. Open the app — everything should work normally (client sends x-csrf-token)

# 3. Simulate an attack — send a request WITHOUT the header:
curl -X POST http://localhost:3000/rpc/some.procedure \
  -H "Content-Type: application/json" \
  -d '{}' \
  --cookie "session=<valid-session-cookie>"
# Expected: rejected (CSRF check fails)

# 4. Same request WITH the header:
curl -X POST http://localhost:3000/rpc/some.procedure \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: csrf" \
  -d '{}' \
  --cookie "session=<valid-session-cookie>"
# Expected: passes CSRF check (may fail auth or validation, but not CSRF)
```

### Failure mode in production

- **`CORS_ORIGIN` set but `allowHeaders` missing `x-csrf-token`** → the browser blocks the preflight request. Every oRPC call fails with a CORS error in the console. Fix: ensure `"x-csrf-token"` is in the `allowHeaders` array.
- **`CORS_ORIGIN` not set when it should be** → CSRF plugin is off. If the API and client are truly cross-origin, you have no CSRF protection. The app may still "work" — the vulnerability is silent.
- **Reverse proxy stripping `x-csrf-token`** → same as missing `allowHeaders`: every request is rejected by the CSRF plugin. Whitelist the header in your proxy config.
- **`CORS_ORIGIN` set to `*`** → the `cors()` middleware allows any origin, which defeats the purpose. Always set it to the exact client origin (`https://app.example.com`).

---

## 4 — OpenAPI Reference is Admin-Only in Production

### Problem

The oRPC `OpenAPIReferencePlugin` serves a live API reference page at `/api-reference` that documents the request/response shape of every procedure. In development that's a convenience; in production it's a public map of the entire API surface handed to anyone who guesses the path.

### Fix

`apps/server/src/api-reference-admin-gate.ts` gates `/api-reference/*` in production. Mounted only when `NODE_ENV=production` (see `apps/server/src/index.ts`), it reuses `requireVerifiedAdminSession` — the same verified-email + admin-role + forced-2FA rule as the better-auth admin gate — but collapses **every** failure mode to a **404** (not 401/403), matching the `adminOr404Procedure` convention so a non-admin can't even confirm the page exists. In development the gate is not mounted, so the reference stays open for local exploration. It sits behind the general RPC rate limiter, so brute-forcing the gate is throttled first.

### Verify locally

```bash
# Development (default) — the reference is open:
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api-reference/
# Expected: 200

# Production — a non-admin (or anonymous) caller gets a 404:
NODE_ENV=production ...   # run the built server
curl -s -o /dev/null -w "%{http_code}\n" https://your-app.example.com/api-reference/
# Expected: 404 (200 only with a verified-admin session cookie)
```

### Failure mode in production

- **`NODE_ENV` not set to `production`** → the gate is never mounted and the reference is public. Ensure `NODE_ENV=production` in the deployed environment (the container images set it).
- **Locked out as an admin** → the gate honors the full admin policy (verified email + admin role + any forced 2FA). If you can reach `/admin` you can reach `/api-reference`; if the reference 404s for you, resolve the same way you would an admin-UI lockout.

---

## 5 — Scoped CSP override (widen one directive for one path)

### Problem

The global Content-Security-Policy in `apps/server/src/security-headers.ts` is deliberately tight — `form-action 'self'`, `connect-src` limited to self plus the CORS/S3 origins, etc. Occasionally one route legitimately needs *more* than the global policy allows, and loosening the global policy to accommodate it would weaken every other page. Concrete cases:

- **A SAML IdP using the HTTP-POST binding** posts the SAMLResponse form to your ACS URL from the IdP's origin — blocked by `form-action 'self'`.
- **GitHub's App Manifest flow** posts a form to `https://github.com/settings/apps/new` — same block.

### Fix

Register a **path-scoped middleware _before_ `secureHeaders`** that rewrites the one directive after `await next()`. Hono's middleware is an onion: the outer middleware's post-`next()` code runs *last*, so a narrower CSP written there wins over the global policy `secureHeaders` set. This is the exact mechanism the shipped `/api/assets/:id` `sandbox` override uses — see the ordering docstring on `mountSecurityHeaders` in `apps/server/src/security-headers.ts`, which explains why registering *after* `secureHeaders` would let it clobber your override back to the app policy.

Add the override inside `mountSecurityHeaders`, above the `secureHeaders` call:

```ts
// Widen form-action for exactly the SAML ACS route — nothing else changes.
app.use("/api/auth/saml/callback", async (c, next) => {
  await next();
  if (c.res.ok) {
    // Start from the global policy and replace only the one directive.
    c.res.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; form-action 'self' https://idp.example.com; frame-ancestors 'none'; object-src 'none'",
    );
  }
});
```

Rules that keep this safe:

- **Leave the global policy untouched.** The override is additive-per-path; the `secureHeaders` block in the same file must not change, or you widen the directive everywhere.
- **Scope the path as narrowly as possible** — the exact callback route, never a `/*` prefix.
- **Widen one directive, keep the rest strict.** Re-state the other directives at their global values (as above) rather than dropping them, so the scoped response is not accidentally more permissive elsewhere.
- **Name the third-party origin explicitly** (`https://idp.example.com`), never `'unsafe-inline'` or a wildcard.

### Verify locally

`curl -si localhost:3000/api/auth/saml/callback | grep -i content-security-policy` should show the widened directive on that path, while `curl -si localhost:3000/some-page` still shows `form-action 'self'`. The app-level ordering test in `apps/server/src/security-headers.test.ts` (the `/api/assets/:id` sandbox case) is the template to copy for a regression test.
