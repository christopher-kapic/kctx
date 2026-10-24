# Error Messages

How to write the words that appear when something goes wrong. This doc is about **copy and content** — for *where* errors render (toasts vs inline vs route-level), see [loading-and-errors.md](./loading-and-errors.md). For server-side error *codes*, see [server-procedures.md § Error vocabulary](./server-procedures.md#error-vocabulary).

When the user hits an error, they want three things, in order: **what happened, what they didn't lose, and what to do next.** Every message should answer those in as few words as possible.

## The five rules

A good error message:

1. **Says what happened, plainly.** "Couldn't save your changes" beats "Whoops! Something went wrong." Name the action that failed.
2. **Reassures.** If their work survived (saved as draft, queued for retry, still in their session), say so. Silence on this point reads as data loss.
3. **Is empathetic, not cute.** No "Oops!", no exclamation marks, no apologies stacked three deep. Use "please" only when the situation is genuinely dire or the user can't fix it themselves.
4. **Tells them how to fix it.** Even when the answer is "try again in a minute" — say it. If there's a doc or setting that resolves the issue, link it.
5. **Gives a way out.** If the user can't fix it, point them at admin/support. Never end with a wall.

The shape, applied to UI:

> **Couldn't save your changes.** *(what)* Your draft is still here. *(reassure)* This is a problem on our end — try again in a moment. *(why + how)* If it keeps happening, contact an admin. *(way out)*

You will rarely have room for all four sentences. Cut in this order: way out → reassure → why → what. Never cut **what**.

## Tone

- Don't blame the user. "The email you entered is invalid" → "That email doesn't look right — check for typos." Same information, no finger-pointing.
- Don't blame third parties by name. "Stripe is down" makes us look unprofessional even when it's true. Say "We're having trouble connecting to our payments provider" instead.
- Don't be cute. Not "Whoops!", not "Yikes!", not "🤖 beep boop". The user is annoyed; matching their energy with a joke makes it worse.
- Don't apologize at the start of every error. Reserve "Sorry" / "Please" for messages where the user is genuinely stuck.

## Plain language — no jargon

If a normal user wouldn't recognize the word, don't use it.

| Don't say | Do say |
|---|---|
| "Failed to fetch data" | "Couldn't load your posts" |
| "Authentication failed" | "That email or password doesn't match" |
| "Invalid credentials" | "That email or password doesn't match" |
| "403 Forbidden" | "You don't have access to this page" |
| "Unprocessable entity" | "Some fields need a second look" |
| "ECONNREFUSED" | "We couldn't reach the server" |
| "Token expired" | "Your session has ended — sign in again" |
| "Constraint violation" | "An account with that email already exists" |

HTTP status codes, exception names, stack traces, error codes, and SQL state names never appear in user copy. They go in `console.error()` and server logs, not in the DOM.

## Sensitive information — never leak this

This is non-negotiable. Even when a leak feels harmless, it usually isn't:

- **No raw exception messages.** `error.message` from a Prisma client may contain table names, column names, the SQL that failed, or even the offending value. Same for `auth.api` and any third-party SDK. Never pass `err.message` straight to the user.
- **No stack traces, file paths, or line numbers.** Not in production, not in errors that reach the browser. Logs only.
- **No internal IDs we didn't already give the user.** Don't echo back a UUID the client never sent, a foreign key from a sibling table, or another user's ID. Only echo what the user already knows.
- **No env-var names, hostnames, or service names.** "DATABASE_URL is not set" tells an attacker our config layout. User-side: "Service unavailable. Try again shortly."
- **No third-party error bodies pasted through.** S3, SMTP, Stripe, OAuth providers — wrap their errors before they reach the client.
- **No user input echoed in errors when it could enable phishing or enumeration.** Login, in particular: "No account found for *foo@example.com*" is an account-enumeration oracle. Use a single message for "wrong email or password" regardless of which it was.
- **No PII from other users.** "Email taken by jane@example.com" leaks Jane. Just say "Email already in use."
- **No secrets, ever.** API keys, tokens, session IDs, password reset codes, MFA codes. If you find one in an error path, treat it as an incident.

The standard server pattern — translate at the boundary:

```ts
// packages/api/src/routers/users.ts
try {
  await auth.api.createUser({ body: input });
} catch (err) {
  // ❌ leaks raw better-auth error to the client
  // throw new ORPCError("INTERNAL_SERVER_ERROR", { message: (err as Error).message });

  // ✅ log the detail, show the user something safe
  console.error("[users.create] auth.api.createUser failed", err);
  throw new ORPCError("INTERNAL_SERVER_ERROR", {
    message: "Couldn't create that account. Try again, or contact an admin if it keeps happening.",
  });
}
```

The standard client pattern — never render `error.message` raw:

```tsx
// ❌ shows whatever the server (or a thrown Error) said
<p className="text-sm text-destructive">{error.message}</p>

// ✅ map known codes; fall back to a friendly default
<p className="text-sm text-destructive">{friendly(error)}</p>
```

The repo has one: `friendly()` in `apps/web/src/utils/friendly-error.ts` branches on `error.status` / `error.code` (the oRPC codes from [server-procedures.md](./server-procedures.md#error-vocabulary)) and falls back to `"Something didn't work. Try again."` — no full error catalog needed.

## Server-side: ORPCError messages

Every `ORPCError` message is user-facing. The browser receives it verbatim as `error.message`.

```ts
// ✅ user-facing, plain, specific
throw new ORPCError("NOT_FOUND", { message: "Post not found" });
throw new ORPCError("CONFLICT", { message: "An account with that email already exists." });
throw new ORPCError("FORBIDDEN", { message: "You don't have access to this page." });

// ❌ leaks internals
throw new ORPCError("INTERNAL_SERVER_ERROR", { message: (err as Error).message });
// ❌ jargon
throw new ORPCError("BAD_REQUEST", { message: "Validation failed: input.slug.format" });
// ❌ echoes user input — phishing/XSS-adjacent risk
throw new ORPCError("BAD_REQUEST", { message: `No template for slug "${input.slug}"` });
```

When the failure is genuinely opaque (third-party 500, network error, unknown DB error), pick `INTERNAL_SERVER_ERROR` and write generic copy. Do **not** fall back to the underlying message.

## Client-side: toasts, inline, route-level

The three slots and the copy patterns that fit each:

| Slot | Length | Pattern |
|---|---|---|
| Toast (mutation error) | one short sentence | `"Couldn't update that. Try again."` |
| Inline (query error) | one sentence + retry button | `"Failed to load posts."` + `[Try again]` |
| Route-level (`ErrorState`) | heading + body | `"Something went wrong"` / `"This page didn't load. Try again, or reload."` |
| Form field (Zod) | label-relative | `"Enter a valid email"` not `"Invalid input"` |

**Don't render `error.message` directly** in any of those slots. Map to friendly copy. The router already pipes mutation/query errors through global toasts in `apps/web/src/router.tsx` — keep those messages friendly. When you only need different fallback copy, `meta: { errorFallbackKey: "ns:key" }` is the lighter path; reserve `meta: { skipGlobalErrorToast: true }` + a custom `onError` for mutations that handle their errors inline.

## Form validation — write copy, not Zod defaults

Zod's defaults ("Required", "Invalid input", "String must contain at least N character(s)") are placeholder copy — but don't replace them with inline schema messages. An inline message (`z.email("Enter a valid email")`) is hardcoded English and bypasses the locale error map. Use bare validators and let the map supply the copy ([forms.md](./forms.md)):

```ts
z.object({
  email: z.email(),
  password: z.string().min(8),
});
```

The copy lives in `packages/locales/src/en-US/validation.json` (`invalidString.email` → "Enter a valid email address.", `tooSmall.string` → "Must be at least {{minimum}} characters."), wired to every bare validator by the error map in `apps/web/src/i18n/zod.ts`. When adding or rewording keys there, phrase the message as guidance, not a verdict — tell the user what to type next, not just the rule that failed.

## Rate limit, auth, network — the common ones

| Situation | Copy |
|---|---|
| 429 with retry-after | `"Too many attempts. Try again in {n} seconds."` |
| 429 without retry-after | `"Too many attempts. Please wait a few minutes and try again."` |
| Login failure (any cause) | `"That email or password doesn't match."` (don't disclose which) |
| Session expired | `"Your session has ended. Sign in again."` |
| Network down | `"We couldn't reach the server. Check your connection and try again."` |
| Generic 5xx | `"Something didn't work on our end. Try again in a moment."` |
| Permission denied | `"You don't have access to this."` (no role-name leak) |

The rate-limit, session, permission, and 5xx rows are `friendly()`'s mappings in `apps/web/src/utils/friendly-error.ts`; the login row is `auth:errors.invalidCredentials` in `packages/locales/src/en-US/auth.json` (used by `apps/web/src/routes/$lang/_app/login.tsx`). When adding a new error path, match those phrasings.

## Anti-patterns

- ❌ **`{error.message}` in JSX.** The router and your handlers must produce friendly text; rendering arbitrary errors in the DOM is how stack-trace-shaped strings leak.
- ❌ **"Whoops!" / "Oops!" / "Yikes!"** Cute openers in serious moments.
- ❌ **"Something went wrong" with no follow-up.** Generic when we know what failed.
- ❌ **Passing the blame.** "The third party didn't respond" / "Your input was wrong."
- ❌ **Echoing user input in errors.** Phishing surface, log-injection surface, occasionally an enumeration oracle.
- ❌ **Distinguishing email-not-found from password-wrong.** That's a free user-enumeration API.
- ❌ **Leaking another user's PII** ("taken by jane@…").
- ❌ **Forwarding raw `Prisma`, `auth.api`, S3, SMTP, OAuth provider errors** to the client.
- ❌ **Exposing env-var names, hostnames, internal service names** in user-facing strings.
- ❌ **Toasts that say "Error" with no verb.** "Error" is a noun; users want a sentence.

## Audit recipe (subagent task)

Use this prompt when you want to sweep the whole app for bad messages. Run it through a subagent so the diffs land back as a structured report — then fix the highest-priority issues yourself.

```
Audit every user-facing error message in this monorepo against /patterns/error-messages.md.

Scope:
- packages/api/src/**           (every ORPCError)
- apps/server/src/**            (every c.json error response, every onError handler)
- apps/worker/src/**            (every error that surfaces back to the user/admin)
- apps/web/src/**               (every toast.error, every JSX rendering of error.message,
                                 every inline error UI, every Zod schema message)

For each message, score:
1. Is the copy plain English (no jargon, no codes, no stack-shaped strings)?
2. Does it say what failed, not just "something went wrong"?
3. Is the tone serious without being cutesy or apologetic?
4. Does it suggest a fix or a way out?
5. Could it leak sensitive info? Specifically check for:
   - raw err.message from Prisma / auth.api / S3 / SMTP / OAuth
   - stack traces, file paths, env-var names, hostnames
   - internal IDs the user didn't already see
   - other users' PII (e.g. "taken by jane@…")
   - login flows that distinguish email-not-found from wrong-password
   - echoed user input that could enable phishing/log-injection

Report as a table: file:line | current copy | issues | suggested copy.
Group by severity (LEAK > BAD COPY > NIT). No fixes — just the report.
```

## Reference

- Where errors render: [loading-and-errors.md](./loading-and-errors.md)
- Server error codes: [server-procedures.md § Error vocabulary](./server-procedures.md#error-vocabulary)
- Form validation: [forms.md](./forms.md)
- Global toast handlers: `apps/web/src/router.tsx`
- Route-level error component: `apps/web/src/components/error-state.tsx`
- Rate limit responses: `apps/server/src/rate-limit.ts`
