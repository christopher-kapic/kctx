# Removable email / SMTP

The starter ships transactional email wired up: a `@starter/mailer` package (a thin nodemailer wrapper), an SMTP-configured Better-Auth `emailVerification` block that sends verification links on signup, and SMTP env vars validated at boot. Internal tools that gate access by SSO or by manually provisioning users don't need any of that — and carrying it means every deploy needs SMTP credentials and a working mail relay just to start.

## When to remove

Internal tools, back-office dashboards, and apps where every user is provisioned by an admin (or signs in via SSO) do not need transactional email. Removing it deletes the `@starter/mailer` package, drops the SMTP env vars from your config surface, and lets the app boot without a mail relay. If you also disable signup (the recommended pairing — see the security note below), you can ship the entire app with no email infrastructure at all.

Conversely, **keep** email if any of the following apply:

- You allow public signup and need to verify the email belongs to the person creating the account.
- You want password reset via email link.
- You send transactional notifications (receipts, alerts, digests) from server code.
- You may add any of the above in the foreseeable future — removing and re-adding is straightforward but not free.

## What removing loses

- **Email verification on signup.** New accounts are created without proving the email address belongs to anyone. **SECURITY TRADEOFF — read this carefully.** Email verification is one of the cheapest signals you have against signup abuse: bots, throwaway accounts, and pre-attack reconnaissance. Without it, anyone who can reach the signup endpoint can self-provision an account with any email string they want, including emails that collide with future legitimate users or that look like privileged accounts (`admin@yourcompany.com`). If you remove email verification you **must** also disable public signup (see the next section); otherwise the app is not safe to expose to the internet.
- **Password reset via email link.** The starter ships a full self-service reset flow: `emailAndPassword.sendResetPassword` in `packages/auth/src/index.ts`, the `reset-password` mailer template, the web `/{lang}/forgot-password` + `/{lang}/reset-password` routes (plus the "Forgot password?" link on login), and the native sign-in "Forgot password?" affordance. Removing email removes all of it — users who forget their password have no self-service recovery, and an admin must reset passwords directly in the database or via an admin tool you build yourself. See the extra removal steps below.
- **Worker operational-alert email.** The worker emails admins when a job fails hard or the backup-freshness check finds a problem (`apps/worker/src/operational-alerts.ts`). After removal the `/admin` backup-status card is your only staleness signal (plus `BACKUP_HEARTBEAT_URL` if you set it) — see [backup-and-restore.md](../backup-and-restore.md).
- **Transactional notifications from server code.** Any future feature that wants to email a user (receipts, alerts, "your job finished") would need email re-added first.

The recommended posture after removing email is: **`SIGNUP_ENABLED=false`**, plus admin provisioning via `ADMIN_EMAILS` and a seed script (or a small admin UI you build) for non-admin users. With signup disabled, the only way to get an account is for an admin to create one, which makes the lack of email verification a non-issue — the trust comes from the provisioning step, not the email.

## Removal steps

1. **Delete the mailer package.**

   Read every step and inventory its deletion and dependent-edit paths first. Check `git status --short --untracked-files=all`; refuse if any planned path overlaps existing work. With explicit approval for this feature removal, preview tracked deletions:

   ```sh
   git rm --dry-run -r -- packages/mailer
   ```

   Review the list, then repeat without `--dry-run`; never add force flags. Leave ignored/untracked local files alone. Complete the shared consumer/configuration edits below before verification; deleting the package alone is not a completed removal.

   Because `pnpm-workspace.yaml` globs `packages/*`, the workspace package disappears automatically — no edits to that file needed.

2. **Unwire Better-Auth.** In `packages/auth/src/index.ts`:

   - Remove the mailer imports (`sendEmail`, `renderVerifyEmail`, `renderTwoFactorOtp`, `renderResetPassword`, `isEmailConfigured`) from `@starter/mailer`.
   - Either delete the entire `emailVerification: { ... sendVerificationEmail ... sendOnSignUp: true }` block, or set `requireEmailVerification: false` inside `emailAndPassword` and remove the `emailVerification` block. Both achieve the same outcome — Better-Auth will no longer attempt to send verification email on signup.
   - Delete the `emailAndPassword.sendResetPassword` block — without it (and without the routes removed in step 3b) the password-reset flow is dead. Better-Auth's reset endpoints simply do nothing useful once no `sendResetPassword` is configured.
   - Delete the email-OTP second factor: the `...(isEmailConfigured() ? { otpOptions: { ... sendOTP ... } } : {})` spread inside `twoFactor`, which calls `renderTwoFactorOtp` + `sendEmail`. TOTP and backup codes remain as second factors; the login pages' "email me a code" affordance disappears with the `emailEnabled` flag in step 3.
   - The `emailAndPassword.requireEmailVerification: true` flag must be flipped to `false` (or the entire flag removed) or signup will reject every new user as "unverified" with no way to verify them.

   Then remove `"@starter/mailer": "workspace:*"` from `packages/auth/package.json` `dependencies`.

   **3b. Remove the password-reset and verification UI.** Delete the web routes `apps/web/src/routes/$lang/_app/forgot-password.tsx`, `apps/web/src/routes/$lang/_app/reset-password.tsx`, and `apps/web/src/routes/$lang/_app/verify-email.tsx` (the emailed-verification-link landing page — dead once `emailVerification` is gone), remove the "Forgot password?" `<Link>` block from `apps/web/src/routes/$lang/_app/login.tsx` (and the `showForgotPassword` prop threaded into `SignInForm`), and remove the `showForgot` / `handleRequestReset` state and its render block + "Forgot password?" trigger from `apps/native/components/sign-in.tsx`. Drop the `forgotPassword`/`resetPassword`/`verifyEmail` keys from `packages/locales/src/*/auth.json` and the `auth.forgotPassword` keys from `packages/locales/src/*/native.json`, then remove `/{lang}/forgot-password`, `/{lang}/reset-password`, and `/{lang}/verify-email` from `sitemap.md`. Rebuild the web app so `routeTree.gen.ts` regenerates without the deleted routes.

3. **Remove `@starter/mailer` from the API routers and the worker.** The starter itself imports the mailer from three routers and one worker module — unwire all four, then drop `"@starter/mailer": "workspace:*"` from both `packages/api/package.json` and `apps/worker/package.json`:

   - `packages/api/src/routers/users.ts` — the `users.invite` procedure sends a best-effort invite email carrying the generated temp password. Delete the `renderInviteUser`/`sendEmail` import and the email-send block; the procedure already returns `tempPassword` to the admin, so invites keep working with out-of-band credential sharing (drop the now-dead `emailSent` from the return).
   - `packages/api/src/routers/auth.ts` — delete the `verifyEmailTransport` procedure (the 2FA email-OTP delivery preflight) and the `verifyTransport` import. Its callers are the preflight in `apps/web/src/routes/$lang/_app/login.tsx` and `apps/native/components/sign-in.tsx`; both go away with the "email me a code" affordance.
   - `packages/api/src/routers/index.ts` — delete the `emailEnabled: isEmailConfigured()` field from `appConfig` and the import. Its consumers are all email UI: the "email me a code" block and `showForgotPassword={emailEnabled}` in `login.tsx`, the resend-verification blocks in `signup.tsx` and `verify-email.tsx`, and the `!cfg.emailEnabled` deflect in `forgot-password.tsx` (the routes themselves are step 3b).
   - `apps/worker/src/operational-alerts.ts` — delete the module and `operational-alerts.test.ts`, remove the `sendOperationalAlert` call and `escapeHtml` import from `apps/worker/src/handlers/check-backup-freshness.ts` (keep `escapeHtml` somewhere if the backup report still needs it — it is a plain HTML-escape util that happens to live in this module), and remove the `sendOperationalFailureAlert` / `closeOperationalAlertConnection` imports and call sites in `apps/worker/src/runtime.ts`. Update `apps/worker/src/handlers/check-backup-freshness.test.ts`, which mocks the module.
   - The router tests mock the mailer too — `packages/api/src/routers/users.test.ts` and `index.test.ts` both `vi.mock("@starter/mailer", ...)`. Remove the mocks and the invite-email assertions alongside the code above.

   **Maintain the endpoint baseline.** Deleting `auth.verifyEmailTransport` also requires deleting only the exact `"auth.verifyEmailTransport": "public"` entry from `scripts/access-matrix-pre-notes-baseline.json` in the same reviewed change. Do this only after removing the procedure and its router registration; never regenerate or broadly rebaseline the file. Run `pnpm policy:access-matrix` afterward.

   If your fork has added other notification procedures that import the mailer, remove those imports and either delete the procedures or replace them with no-op stubs that throw `ORPCError("NOT_IMPLEMENTED")`. Verify nothing is left:

   ```sh
   grep -rn "@starter/mailer" packages apps
   ```

4. **Remove SMTP env vars.** In `packages/env/src/vars/shared.ts` (the declarations live in the worker-safe shared object, because the worker sends operational-alert email too), delete the five lines from `sharedVars`:

   ```ts
   SMTP_HOST: z.string().optional(),
   SMTP_PORT: z.coerce.number().int().positive().optional(),
   SMTP_USER: z.string().optional(),
   SMTP_PASS: z.string().optional(),
   SMTP_FROM: z.string().optional(),
   ```

   Also remove the production boot guards that require SMTP when public signup is enabled. They live one directory up, in `packages/env/src/server.ts` — search it for `SIGNUP_ENABLED` and `SMTP_`; after email removal, production must not crash just because SMTP is unset. Keep `SIGNUP_ENABLED=false` unless you build a different verification/provisioning gate.

5. **Remove SMTP from the env manifest.** In `scripts/lib/env-manifest.ts`, delete the five `SMTP_*` `ENV_VARS` entries and the now-empty `smtp` group, then run `pnpm env:sync`.

   **Do not edit `.env.example` by hand** — it and the other `.env.example` files are generated from the manifest, so the sync is what removes the `# Email (SMTP)` section. A hand edit is reverted by the next `pnpm env:sync`, and CI's `pnpm env:check` fails on both halves of the mismatch: a schema key with no manifest entry, and a manifest entry naming a key no schema declares. Do this in the same commit as step 4.

   **Update the deploy config too**: on the Dokploy/VPS setup ([deployment-vps.md](../deployment-vps.md)), remove the five `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` vars from both the server and worker Applications' env config.

   **Leave the `RATE_LIMIT_EMAIL_POINTS` / `RATE_LIMIT_EMAIL_WINDOW_SECONDS` budget alone** — despite the name, it belongs to the rate-limit group, not SMTP: it scales the per-recipient caps on the auth endpoints themselves (`sign-up/email`, `send-verification-email`, `request-password-reset`), which still matter with mail delivery removed. It only comes out if you also delete the per-recipient limiter mounts in `apps/server/src/index.ts`.

   Verify: `pnpm env:check`.

6. **Check `scripts/docker-entrypoint.sh`.** The current entrypoint validates `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `REDIS_URL` only — there is no SMTP validation to remove. If your fork has added `SMTP_HOST` or similar to the required-vars loop, drop it.

7. **Remove nodemailer from the catalog.** In `pnpm-workspace.yaml` under `catalog:`, delete the lines:

   ```yaml
   nodemailer: ^9.1.0
   "@types/nodemailer": ^8.0.1
   ```

8. **Remove the mailer `COPY` lines from both Dockerfiles.** `packages/mailer` is hand-enumerated in the install lists of `Dockerfile` and `Dockerfile.worker`. Delete this line from the `builder` **and** `prod-deps` stages of **both** files (four lines total):

   ```dockerfile
   COPY packages/mailer/package.json packages/mailer/
   ```

   Leaving a stale line makes `docker build` fail at install time. `pnpm docker:check-copy` (the CI `lint` gate) catches the omission — run it after editing.

9. **Reinstall, rebuild, and boot.**

   ```sh
   rg "@starter/mailer|SMTP_|nodemailer" packages apps scripts .env.example
   pnpm install
   pnpm build
   pnpm test
   pnpm docker:check-copy
   ```

   `pnpm install` will remove `nodemailer` and `@types/nodemailer` from the lockfile and prune the deleted workspace package. `pnpm build` should pass with no references to `@starter/mailer` anywhere. `pnpm test` and `pnpm docker:check-copy` should pass. Boot once with `NODE_ENV=production`, `SIGNUP_ENABLED=false`, and no `SMTP_*` values so you know the production env validator was fully unwired.

10. **Disable signup.** Set `SIGNUP_ENABLED=false` in `.env` (and in your production environment). This is non-optional — see the next section.

## Security: disable signup after removing email

Without email verification, **public signup is unsafe**. Anyone who can reach the signup form (or the signup oRPC procedure directly) can create an account with any email address they choose, with no proof they own it. They can:

- Squat on emails that look like privileged accounts (`admin@yourcompany.com`, `security@...`) before the real owner signs up.
- Create unlimited throwaway accounts for abuse, scraping, or rate-limit bypass.
- Pollute your `User` table with emails belonging to people who never signed up.

The mitigation is to **stop accepting public signups entirely**. In `.env`:

```
SIGNUP_ENABLED=false
```

This is the starter's default, and it is the right default once email verification is gone. With signup disabled:

- The signup form is hidden in the UI.
- The signup oRPC procedure rejects all attempts.
- The only way to create a non-admin user is via a seed script, an admin UI you build, or direct DB insert.
- Admins are bootstrapped via `ADMIN_EMAILS` (a comma-separated list in env) only on the explicit email/password bootstrap sign-up path. SSO-created users are not auto-promoted by email claim; approve SSO admins manually after checking the IdP.

If you must keep signup open after removing email — don't. Either keep email verification, or build a different gating mechanism (invite tokens, allow-listed domains, manual admin approval queue) before removing this safety net.

## Adding email back

The steps are the inverse. The cleanest path is `git revert` of the removal commit, but if too much has changed since then:

1. **Restore the mailer package** from git history (`git show <removal-sha>:packages/mailer/src/index.ts`) or recreate it from the structure described at the top of this doc — a `sendEmail({ to, subject, html })` function wrapping nodemailer with a lazily constructed transport, plus `isEmailConfigured()`, `verifyTransport()`, and the email renderers (verify-email, 2FA OTP, reset-password, invite).
2. **Re-add the catalog entries** (`nodemailer`, `@types/nodemailer`) in `pnpm-workspace.yaml`.
3. **Re-add `@starter/mailer`** to `packages/auth/package.json` dependencies.
4. **Re-wire Better-Auth** in `packages/auth/src/index.ts`: import `sendEmail`, restore the `emailVerification.sendVerificationEmail` function, and set `emailAndPassword.requireEmailVerification: true`.
5. **Re-add SMTP env vars** to `sharedVars` in `packages/env/src/vars/shared.ts` (and the boot guards in `packages/env/src/server.ts`) and document them in `.env.example`.
6. **Provision SMTP credentials.** For local dev, run mailpit (`docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit`) and point `SMTP_HOST=localhost SMTP_PORT=1025`. For production, see [production-hardening.md](../production-hardening.md) for SMTP provider guidance and the auth/email checklist.
7. **Run `pnpm install`** to pull nodemailer back into the lockfile, then `pnpm build` and `pnpm test`.
8. **Decide on `SIGNUP_ENABLED`.** Now that verification is back, you can safely flip signup on if your product needs it.

## Sanity checks

After removal:

- `pnpm install` completes without errors and the lockfile no longer contains `nodemailer` (`grep nodemailer pnpm-lock.yaml` returns nothing).
- `pnpm build` succeeds with no unresolved imports of `@starter/mailer`.
- `pnpm test` passes.
- `grep -r "@starter/mailer" packages apps` returns nothing.
- `grep -r "SMTP_" packages apps scripts .env.example` returns nothing (the `.env.example`, `packages/env/src/vars/shared.ts`, and `packages/env/src/server.ts` references are gone).
- The app boots with no SMTP env vars set.
- With `SIGNUP_ENABLED=false`, attempting to sign up via the UI is blocked and the signup oRPC procedure returns an error.
- Admin login still works for users whose email is in `ADMIN_EMAILS`.

After re-adding:

- `pnpm install` pulls nodemailer back in.
- Run mailpit locally, sign up a new test user, and confirm a verification email arrives in the mailpit inbox at `http://localhost:8025`.
- Click the verification link and confirm the user transitions to verified state in the database.
- Confirm the user can sign in only after verification (when `requireEmailVerification: true`).
