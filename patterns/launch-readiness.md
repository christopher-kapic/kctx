# Launch readiness — privacy, safety, and disclosures

Read this during product onboarding, before enabling a feature that collects or shares personal data, and before a production launch. The agent owns the technical work and verification; the app owner supplies product facts and business policies. A nontechnical owner should not have to know to request a privacy notice, safe tracking settings, or a cancellation flow.

This template ships account infrastructure, transactional email, a consent mechanism with no analytics provider, dormant AI chat and upload infrastructure, and self-hosted fonts. It does not ship an app-specific privacy policy, marketing email, billing, an age gate, or a copyright complaint process. A passing code check is not a legal compliance certificate. Requirements depend on audience, jurisdiction, data, and enabled features; verify current official guidance rather than copying fines or deadlines from an online checklist.

## Agent workflow and launch gate

1. During [getting-started](./getting-started.md), identify audience and launch regions, collected data and retention, and whether children, sensitive data, tracking, marketing, subscriptions, AI, or uploads are in scope. Ask about these as they arise in the product conversation, not as a legal questionnaire. Use safe technical defaults; do not invent the owner's policies or collect extra personal data just in case.
2. In the consuming app, create `notes/06-launch-readiness.md` alongside the other onboarding notes. Record each topic below as `blocked`, `ready`, or `not-applicable`, with a reason, owner, evidence (files/lines, test results, or operational confirmation), and any follow-up. Begin applicable topics as `blocked` until verified. An unknown applicability decision is also `blocked`; an absent integration can be `not-applicable` with evidence that it is absent. Never write these app-specific notes into the upstream template.
3. Add the outstanding work to `notes/05-build-plan.md` before deploy. Complete technical work before asking the owner for any external action or review that remains necessary. Explain such actions in plain language and give exact steps. Never claim registration, legal review, or production configuration has happened because a page or placeholder exists.
4. Before allowing production traffic, re-check the enabled features, notices, data flows, live configuration, and verification evidence. Applicable unfinished work or unanswered owner decisions block launch; continue independent local development while those decisions are pending. Report the concrete blocker and recommended next step. Do not silently treat an internal app, low traffic, or disabled public signup as a privacy exemption.
5. Repeat this review when audience, launch regions, providers, collected data, or enabled features change. Update the affected notices and tests in the same change. Run [production-hardening](./production-hardening.md) and `pnpm verify:fast`; neither substitutes for the evidence below.

Use one table in the launch record:

| Topic | Status | Applicability / owner decision | Evidence / remaining work | Owner |
|---|---|---|---|---|
| Privacy and data lifecycle | blocked | Accounts collect personal data | Inventory data and providers; write notice and verify request handling | Agent + app owner |
| Marketing email | not-applicable | No marketing feature | Account-only templates and call sites inspected | Agent |

These are examples, not statuses to copy without inspection. Cover every topic below, including those that do not apply. Legal questions requiring specialist judgment remain unresolved until the owner obtains that judgment; the agent can implement the resulting requirements but cannot certify the app's legal status.

## Database access and secrets

- Keep Postgres and Redis on private service networks; publish only the app. The generated Dokploy Compose in `scripts/generate-dokploy-config.ts` already does this. Local development bindings in `docker-compose.dev.yml` are loopback-only. Verify the deployed settings rather than assuming generated defaults survived manual edits.
- This stack accesses Postgres through server-side Prisma and authenticated, owner-scoped handlers. Test anonymous, wrong-role, and cross-owner access, including asset URLs and background jobs. A database with RLS disabled is not by itself proof of a leak in this architecture. RLS can provide additional protection, but requires an explicit database role and per-request identity design; a blanket toggle can break the app or be bypassed by the database owner. Read [server-procedures](./server-procedures.md), [custom-roles](./custom-roles.md), and [assets](./assets.md).
- Never expose database credentials or provider secrets through browser/native env prefixes, client imports, public configuration, SSR output, logs, or generated documentation. Use the existing [environment-variable boundaries](./environment-variables.md), secret checks, and least-privilege provider credentials. Inspect the built client when adding an integration.

## Privacy notice and data lifecycle

Inventory actual data and uses: account details, sessions and security metadata, uploaded files, conversations and tool results, email recipients, push subscriptions, logs, backups, and anything the product adds. Include enabled processors (hosting, SMTP, storage, AI, analytics), what each receives, retention/deletion behavior, and who can access it. The inventory must match code and deployed configuration, including server-side transfers.

Write a truthful notice using owner-confirmed operator/contact details, purposes, sharing, retention, and the applicable rights/request process. Do not publish stock promises such as "we never share data" while sending conversations to an AI provider, or "deletion is immediate" while backups retain data. Decide how requests are received and fulfilled, including provider-held data and documented backup limits; test the implemented workflow. A notice alone does not implement deletion or access rights.

For a public app, create a public localized route such as `/$lang/privacy`, with copy in the locale bundles through `t()`. Link it from the shared public footer, signup before collection, and app settings; keep it readable without login. If a separate cookie notice is needed, also link it from the consent banner. Update `PUBLIC_PATHS` in `apps/server/src/seo.ts` and `sitemap.md` for each public indexable page. Follow [i18n](./i18n.md), [auth-and-routing](./auth-and-routing.md), and [consent](./consent.md). Internal apps still need appropriate privacy information; record any existing organizational notice and confirm it covers this app.

Check applicable notice-at-collection and opt-out requirements with current authoritative guidance, including the [California Attorney General's privacy guidance](https://oag.ca.gov/privacy/ccpa). Publishing a privacy notice is not consent to optional tracking, and accepting terms is not consent to marketing.

## Audience, children, and sensitive data

Record whether the app is directed to children, serves a mixed audience, is general-audience, or is intended for adults. Do not add a birth-date field or an "I am 13" checkbox to every app: general-audience apps do not universally need age screening, and collecting age can create actual knowledge that must be handled. A checkbox does not make a child-directed product compliant. Use the [FTC COPPA guidance](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions) and the current rule when assessing applicability.

If child-directed use, mixed audiences, or known underage users are relevant, resolve the notice, screening, parental-consent, retention, and request-handling requirements with the owner and appropriate specialist review before enabling collection. If an age screen is chosen, it must be neutral and precede the affected collection; an underage result must lead to the agreed blocked or verified-parent flow. Review cookies, device identifiers, third-party SDKs, SSO, uploads, and chat too. Do not automatically store identity documents or full dates of birth.

Health, financial, biometric, precise-location, and other sensitive data require a deliberate collection and provider review. Default to no advertising pixels or session replay on sensitive surfaces. Do not enable an integration merely because the provider offers a consent banner. Escalate regulated use cases instead of claiming the template makes them compliant.

## Tracking, session replay, and pixels

Default to no provider. Optional tracking must use the existing [consent gate](./consent.md) and support withdrawal. Consent must cover the actual purpose; the `analytics` choice does not silently authorize advertising or replay. Add separate categories and re-consent when needed.

Do not capture field values, keystrokes, chat transcripts, payment details, health data, credentials, or personal identifiers in analytics/replay. Keep replay and advertising pixels off auth, forms, chat, payment, and sensitive pages; prefer allowlisted events and routes over vendor auto-capture. Check page URLs, query strings, referrers, error payloads, and server-side events for sensitive data too. Vendor masking defaults and a consent toggle are insufficient proof.

Verify network requests and cookies/storage in undecided, rejected, accepted, withdrawn, and reloaded states, including navigation into excluded pages. Withdrawal must stop an already-running SDK and clear accessible provider storage. Record the result and any vendor limitation; choose a different provider when the required controls cannot be achieved. Honor applicable opt-out signals, including Global Privacy Control where relevant; a local analytics choice is not a substitute for those obligations.

## Email and subscriptions

The current mailer sends account messages. Do not add promotions to authentication mail or use `sendEmail()` for marketing until a marketing flow implements unsubscribe links, the sender's valid postal address, and a durable suppression record. Check suppression at dispatch time, including queued sends and retries. Keep opt-out separate from deleting the account or disabling security email; never require login to unsubscribe. Test the link and subsequent send suppression. Follow the [FTC CAN-SPAM guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) and applicable regional consent rules; transactional and commercial email have different requirements.

Billing does not ship. Before implementing subscriptions, follow [payments](./payments.md): disclose price/currency, billing interval, trial conversion, renewal, and cancellation terms beside the purchase consent; obtain affirmative consent; send confirmation; and provide a clear online cancellation path. Verify the provider portal actually allows cancellation for the sold plan. Test webhook-driven cancellation and the distinction between cancellation, access end, refunds, and deleting an account. Review current rules for the launch regions rather than relying on the name or status of any single federal rule; see the [FTC negative-option rule information](https://www.ftc.gov/legal-library/browse/rules/negative-option-rule).

## AI and user content

When enabling chat, retain the visible translated AI disclosure in `apps/web/src/routes/$lang/_app/_auth/chat.tsx` before the first message and throughout the conversation. Explain that it is AI and can make mistakes; do not rely on the model to disclose itself. Review OpenRouter, the selected model provider, conversation retention, tool-result storage, and every registered tool's data access and transfer. Put the actual behavior in the privacy notice. The technical enablement flag is not approval to send sensitive data to a vendor. Follow [add-ins/chat](./add-ins/chat.md) and the [European Commission's AI transparency guidance](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act). Companion, child-facing, or regulated-advice features need their own review; a generic AI notice does not satisfy all obligations.

Before accepting user uploads, decide permitted content, who can see it, how complaints are received, and who handles removal. For US copyright safe-harbor reliance, resolve designated-agent registration and public contact information, renewal ownership, takedown/counter-notice handling, and the repeat-infringer policy with the owner. A DMCA page or agent registration alone is insufficient. Record external registration confirmation; do not fabricate an agent name or publish a registration placeholder as finished. See [assets](./assets.md) and the [Copyright Office's designated-agent guidance](https://www.copyright.gov/dmca-directory/).

## Accessibility and provider inventory

Follow [design-system](./design-system.md) and verify WCAG AA basics on the actual surfaces: keyboard navigation, visible focus, correctly named controls, form labels/errors, meaningful image alternatives, status announcements, contrast in both themes, and zoom/reflow. Overlay focus handling, authentication, signup, legal pages, consent, and cancellation belong in that pass. Use [W3C's WCAG quick reference](https://www.w3.org/WAI/WCAG22/quickref/); automated diagnostics support manual checks rather than certifying conformance. Record what was tested and outstanding limitations.

Inventory every third-party script, SDK, font, embedded resource, and server-side processor: purpose, data sent, origin, consent category or other basis, owner, retention, and removal/withdrawal behavior. Fonts ship locally through Fontsource; preserve self-hosting where practical and verify licenses. Review the built browser's network traffic as well as imports and CSP. Do not widen CSP, add a new dependency, or send owner credentials to a provider without the authorization required by AGENTS.md. No extra font service or tag manager is needed merely to launch an app.
