# Anonymous public forms (contact, lead capture, intake)

A form anonymous visitors can submit — "contact us", "request a quote", "join the waitlist" — is often the first feature a small-business app needs. Everything here is about adding one **public write surface** without opening a spam or abuse hole. The template ships none of this; the pieces it reuses (forms, rate limiting, mailer, queue) are all in place.

## Decide before building

1. **Where does a submission go?** A `ContactSubmission` (or similar) row you triage in the admin area, an email notification, or both. Storing the row is recommended even when emailing — email loses nothing compared to a table you can query, and the email can be a notification *about* the row.
2. **What is PII here?** Names and email addresses are PII. Say in `notes/02-users-and-roles.md` who can read submissions, and mark the row ⚠️ like any PII-bearing surface ([getting-started](./getting-started.md)).
3. **Is signup the real goal?** If the "waitlist" is really account creation, use the signup flow — don't build a parallel one.

## The submission endpoint

This is the one case where a `publicProcedure` is genuinely correct: the data is public-facing and unauthenticated by design ([server-procedures § Procedure levels](./server-procedures.md#procedure-levels)). That legitimacy comes with obligations:

- **Zod-validate server-side with tight bounds** — `z.string().trim().min(2).max(500)` for the message, `z.string().email().max(254)` for the reply address, enums for anything enumerable. Length caps are not polish; they are the difference between a nuisance and a 10 MB request body per bot hit.
- **Its own rate-limit bucket, fail-closed, keyed on IP.** A public POST endpoint is exactly the "hard-hittable surface" the rate-limiting doc exists for. Add a member to the AUTH-style code-defined family (or a new family if you want independent knobs) — do not widen an existing budget to fit it in. See [rate-limiting § Give every surface its own bucket](./rate-limiting.md#give-every-surface-its-own-bucket) and [§ Fail-open vs fail-closed](./rate-limiting.md#fail-open-vs-fail-closed). Spend-bearing? No — but it feeds the EMAIL family if you notify by mail; count one send per submission when sizing.
- **A honeypot field** (a visually hidden input with a tempting name like `website`); submissions with it filled are silently dropped, success-shaped. It costs nothing and kills the laziest bot tier.
- **Identical success response for dropped and accepted submissions.** Never reflect validation state in a way that distinguishes "this email is now in a system" from "rejected" — the endpoint must not become an enumeration or deliverability oracle.
- **No session, no user row.** Do not create accounts from a contact form.

## The form UI

Standard authenticated-form rules apply unchanged — this is the same TanStack Form shape, minus the session:

- `useForm` + `TextField` with `autoComplete` and `inputMode` per field ([forms](./forms.md)); `autoComplete="email"` on the reply address, `autoComplete="off"` on the message.
- Every label and button through `t()` — a public form is often the most-viewed page in the app; hardcoded strings here are the most visible i18n bug there is ([i18n](./i18n.md)).
- Submit pending state on the button (`isPending`), inline "Try again" on error, and a success state that clears the form.
- The page itself: a public, indexable route (`/$lang/contact`) — update `PUBLIC_PATHS` in `apps/server/src/seo.ts` and mirror it in `sitemap.md` ([ssr-for-articles](./ssr-for-articles.md) for the SSR shape if you want it crawlable).

## Storage and triage

- A `ContactSubmission` model with the required-field conventions ([schema-guidelines § Required fields on every model](./schema-guidelines.md#required-fields-on-every-model)) plus `status` (`NEW` / `REPLIED` / `SPAM` — never delete rows to "manage" spam; mark instead) and the submitted IP for abuse correlation.
- Admin list: a bounded, cursor-paginated procedure like any other list ([data-fetching](./data-fetching.md)), gated by the admin role per the access matrix.
- Retention: decide it out loud with the developer (PII!) and record it in the notes — "we keep contact submissions forever" is a decision someone should have made on purpose.

## Email notification (optional)

Use the mailer, through the queue — never send synchronously in the procedure ([queue](./queue.md)): a slow SMTP relay must not hold the request. One template in `packages/mailer` (it has the i18n + tested-template conventions already), sent to the operator address. Remember the EMAIL rate family when estimating volume: a mail per submission at 10 submissions/minute is a different budget conversation than 3/hour.

## Anti-patterns

- Checking `SIGNUP_ENABLED` or session state from a public form handler — it is public; behave like it.
- A `mailto:` link as the entire contact feature — fine as a stopgap, but say that's what it is; submissions you can't query are marketing you can't measure.
- Silent server-side truncation instead of validation: reject, don't mangle.
