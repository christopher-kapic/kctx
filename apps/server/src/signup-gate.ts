import { runWithAllowedUserCreation } from "@starter/auth/user-creation-policy";
import type { Context, Next } from "hono";

// ADMIN_EMAILS bootstrap marker for the email/password signup path. When the
// request carries an admin-listed address it runs downstream inside the
// `admin-bootstrap` creation mode, which is the ONLY mode the auth database
// hook auto-promotes to admin (it never trusts SSO/JIT email claims).
//
// This middleware NEVER rejects: member, non-member, and malformed bodies all
// fall through to Better-Auth, which performs input validation, duplicate
// detection, and (when SIGNUP_ENABLED=false) the signup-disabled rejection
// itself in the database hook. That single-enforcement-point design is what
// keeps admin membership unobservable:
//
//   - An earlier revision rejected non-members here with an immediate 403
//     while members proceeded into Better-Auth. The immediate-403 vs
//     Better-Auth-processing split (different status/body shapes AND different
//     timing) let anyone probe which emails are admins. Any email-based early
//     reject reintroduces that oracle — including for malformed bodies, where
//     Better-Auth would otherwise return identical 400s for every address.
//   - With pass-through, every input class yields identical responses for
//     member and non-member addresses: same 400s for invalid input, same
//     generic 200 for already-registered emails, same 422 for a blocked
//     signup (both pay the password-hash cost before the hook rejects, so
//     timing is normalized too). The only divergence is a VALID new-admin
//     signup succeeding — which inherently creates an account and emails the
//     owner, and whose pre-claim window is mitigated by
//     requireEmailVerification + password reset (unchanged).
export function adminBootstrapMarker(adminEmails: Set<string>) {
  return async function adminBootstrapMarkerMiddleware(c: Context, next: Next) {
    if (adminEmails.size === 0) return next();
    try {
      const body = (await c.req.raw.clone().json()) as { email?: unknown };
      const email = typeof body.email === "string" ? body.email.toLowerCase() : null;
      if (email && adminEmails.has(email)) {
        return runWithAllowedUserCreation("admin-bootstrap", next);
      }
    } catch {
      // Better-Auth returns its normal validation error for malformed signup
      // bodies; the marker must not respond (or throw) for any body shape.
    }
    return next();
  };
}
