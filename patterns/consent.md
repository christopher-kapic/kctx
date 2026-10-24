# Cookie consent and the analytics gate

Deliberately small: one banner, one hook, one place analytics is allowed to load. It exists so that adding analytics later cannot accidentally ship a non-compliant site — the snippet has exactly one seam, and that seam only runs after the visitor says yes.

**This is a banner, not legal advice.** Cookie law (GDPR + the ePrivacy Directive in the EU/UK, and its equivalents elsewhere) depends on what *your* product does with data. If you process personal data at any scale, have a lawyer read your setup. What this template gives you is the mechanism and a default that fails closed.

## What ships

| File | Role |
|---|---|
| `apps/web/src/lib/consent.ts` | Pure core: versioned `localStorage` decision, parse/validate, subscribe/notify. No React. |
| `apps/web/src/hooks/use-consent.ts` | `useConsent()` → `{ analytics, decided, accept, reject, reset }`, via `useSyncExternalStore`. |
| `apps/web/src/hooks/use-analytics-consent.ts` | The gate. Calls `loadAnalytics()` after consent and `disableAnalytics()` on withdrawal. Mounted in `__root.tsx`. |
| `apps/web/src/lib/analytics.ts` | The seam. Documented no-ops for both setup and revocation. |
| `apps/web/src/components/consent/consent-banner.tsx` | The banner. Mounted in `__root.tsx` inside `<ClientOnly>`. |
| `apps/web/src/components/consent/consent-preferences-button.tsx` | "Cookie preferences" — calls `reset()`. Mounted in `/settings` and in the public landing footer. |
| `packages/locales/src/<locale>/consent.json` | The `consent` i18n namespace. |

There is no server component, no database table, no admin screen, and no consent log. The decision lives in the visitor's browser under `starter.consent.v1` and nothing server-side is gated on it.

**One optional category: `analytics`.** Strictly necessary cookies — the session, CSRF, the theme and locale preference — need no consent, so they are not a category. A toggle that cannot be switched off is a dark pattern, not transparency.

## The rule

> **Never load an analytics script outside `loadAnalytics()`, and always revoke it through `disableAnalytics()`.**

No `<script>` tag in `index.html`, no tag in `__root.tsx`'s `head`, no vendor SDK imported at module scope, no `useEffect` in a route that pings a collector. All of those run before — or regardless of — the decision, which is the exact failure this seam exists to prevent. One seam means one thing to review.

To wire up a provider, change both functions in `lib/analytics.ts` in the same commit: put its setup in `loadAnalytics()` and its documented opt-out/cleanup in `disableAnalytics()`. Revocation must stop collection and remove every provider cookie and storage entry this origin can delete; removing the script tag alone is not enough for an SDK that is already running. If a provider uses storage this origin cannot delete, use its documented revocation API or choose a provider that supports withdrawal. Add the provider's origin to `script-src` / `connect-src` in `apps/server/src/security-headers.ts` (the specific host — never `'unsafe-eval'` or a wildcard, per [AGENTS.md § Agent Safety Rules](../AGENTS.md#agent-safety-rules)), and name its cookies/storage in the cookie policy.

## Tracking scope and sensitive surfaces

The `analytics` decision only covers the analytics purpose presented to the visitor; it does not silently authorize advertising pixels or session replay. Default to no provider, and add separate categories/re-consent when purposes change. Keep replay and advertising pixels off auth, form, chat, payment, and sensitive-data pages. Never send field values, keystrokes, conversation text, credentials, or personal identifiers to a tracker; check URLs, referrers, and server-side events too. Prefer an allowlist of safe routes/events over vendor auto-capture. Masking defaults and positive consent do not prove the collection is safe.

Before enabling a provider, follow [launch-readiness](./launch-readiness.md) and record network/storage evidence for undecided, rejected, accepted, withdrawn, and reloaded states, including navigation into excluded pages. Withdrawal must stop an already-running SDK. Required privacy notices and applicable opt-out signals are separate from this local choice.

## Equal weight is the compliance property

Accept and Reject are the same size, same variant, same one tap. Refusing must be exactly as easy as accepting, and withdrawing must be as easy as consenting — which is why `ConsentPreferencesButton` is mounted somewhere anonymous visitors can reach, not only behind sign-in. `consent-banner.test.tsx` asserts the two buttons render identical classes, so a "make Accept pop" tweak fails CI rather than shipping.

Do not add a "not now" that stores nothing, a pre-ticked box, or a banner that blocks the page until accepted.

## Adding a category

1. Widen `ConsentState` in `lib/consent.ts` (`{ analytics: boolean; marketing: boolean; decidedAt: number }`) and validate the new field in `parse()`.
2. Bump `CONSENT_VERSION`. Existing decisions then read as undecided and every visitor is asked again — which is what re-consent under new terms requires.
3. Return the new flag from `useConsent()` and give it its own gate hook + seam, mirroring `use-analytics-consent.ts` / `lib/analytics.ts`.
4. Two buttons stop being honest once there are two independent categories: add per-category switches in the banner (still no pre-ticked boxes) and add the strings to `packages/locales/src/en-US/consent.json`, then `pnpm i18n:translate`.

## Adding a cookie-policy page later

The banner deliberately links to nothing — a link to a page you have not written is worse than no link. When you write one:

1. Add a public route, e.g. `apps/web/src/routes/$lang/_public/cookie-policy.tsx`. A static `t()` page is enough; making it a typed CMS page is optional and only after you have restored [add-ins/cms.md](./add-ins/cms.md).
2. Add its path to `PUBLIC_PATHS` in `apps/server/src/seo.ts` and a row to `sitemap.md` — both, in the same change ([i18n.md](./i18n.md) for the `/$lang/` contract; AGENTS.md § SEO discoverability files).
3. Link it from the banner with `<Link to="/$lang/cookie-policy" params={{ lang }}>` and a `banner.policyLink` string in the `consent` namespace.
4. List every cookie and storage key you actually set, including the ones your analytics provider sets.

## Removing the banner

Consider removal only after the [launch-readiness](./launch-readiness.md) inventory confirms there is no optional tracking/storage requiring consent and no provider that depends on this choice. Geography alone does not decide whether a banner is needed: strictly necessary cookies can be exempt from consent, including for EU visitors (see the [EU cookie-consent exemption guidance](https://ec.europa.eu/justice/article-29/documentation/opinion-recommendation/files/2012/wp194_en.pdf)). Privacy information is still needed. Restore the gate before adding any optional provider later.

Once that decision is recorded, delete `lib/consent.ts`, `lib/analytics.ts`, the two hooks, `components/consent/`, their tests, and `packages/locales/src/*/consent.json`; drop `"consent"` from `NAMESPACES` in `apps/web/src/i18n/config.ts` and from the namespace list in AGENTS.md (then `pnpm sync:agent-docs`); unmount `<ConsentBanner />` and `useAnalyticsConsent()` from `apps/web/src/routes/__root.tsx`, and `ConsentPreferencesButton` from `$lang/_public/index.tsx` and `$lang/_app/_auth/settings/index.tsx`. Then `pnpm verify:fast`.

Keeping it costs one small component and nothing at runtime, so the default is keep.
