# Performance — Bundle Splitting and Dynamic Imports

> How code is split into chunks on this stack, what the framework already does for you, and the few places where you should reach for a manual `import()`. The goal is a small **eager** bundle (what every visitor downloads before first paint) and heavy, rarely-used code deferred into **lazy** chunks.

The build is **rolldown-vite** (Rolldown under the hood, not classic Rollup). Chunking config lives in `apps/web/vite.config.ts → build.rolldownOptions.output.manualChunks`.

## TL;DR

1. **Routes already code-split automatically.** TanStack Start splits every route's `component` into its own lazy chunk. Do **not** hand-write `.lazy.tsx` files or `React.lazy` a whole route — it's redundant.
2. **Don't `export` component functions from route files** — exports defeat the automatic split and pull the component (and its imports) back into the eager graph.
3. **The `manualChunks` vendor matchers must be anchored to `/node_modules/<pkg>/`.** A loose substring like `id.includes("/react/")` sweeps every `@scope/react` library into the eager base chunk. This is the single most common bundling regression on this stack — see below.
4. **Reach for `React.lazy` / `import()` only for a heavy widget gated behind a rare interaction** inside an already-split route (QR encoder, rich editor, charting lib).
5. **Measure, don't guess:** `pnpm --filter web build` prints every chunk's size. The >500 kB warning means an *eager* chunk got fat.

## What the framework splits for you

TanStack Start runs its route code-splitter **unconditionally** (it's not a toggle — `autoCodeSplitting` is omitted from the Start config schema precisely because it's always on). For each file in `apps/web/src/routes/`:

| Stays in the eager/critical graph | Split into a lazy per-route chunk |
|---|---|
| `loader`, `beforeLoad` | `component` |
| `validateSearch`, route context, static data | `errorComponent`, `pendingComponent`, `notFoundComponent` |
| links, route params | everything those components import *and nothing else uses* |

Consequence: a heavy dependency imported **only** by a route component already ships in that route's lazy chunk, not the base bundle. The chat route's markdown renderer (`react-markdown`, via `apps/web/src/components/chat/message-parts.tsx`) and the 2FA QR encoder are reachable only from route components, so they are already deferred — **as long as `manualChunks` doesn't yank them back into a vendor chunk** (next section).

> **Rule:** never `export function MyRouteComponent()` from a route file. Exported symbols are reachable from the eager graph and bypass the split. Define the component as a non-exported local. If a split file needs typed route hooks, use `getRouteApi('/path')`, not `import { Route }`.

**Sections with child routes** (list + detail, list + utility page) should use a thin layout file (`<Outlet />` only) plus an `index.tsx` for the list UI — see [auth-and-routing.md § Route sections with index children](./auth-and-routing.md#route-sections-with-index-children). That keeps the layout chunk tiny (~150 B) and defers the heavy list, detail, and utility pages into separate lazy chunks. `_auth/settings.tsx` + `settings/index.tsx` + `settings/security.tsx` is the shipped example — the security page's QR encoder never rides the settings shell. Putting the list component in the layout parent bloats every child URL's shared ancestor and breaks the UX (the list stays mounted behind detail pages).

## The `manualChunks` gotcha (the expensive one)

`manualChunks(id)` runs for every module in the graph; `id` is an absolute path like `…/node_modules/.pnpm/react-markdown@10.1.0/node_modules/react-markdown/lib/…`. The matcher must identify the **package**, so anchor on the `node_modules` boundary:

```ts
// ✅ CORRECT — matches only the React runtime
if (
  id.includes("/node_modules/react/") ||
  id.includes("/node_modules/react-dom/") ||
  id.includes("/node_modules/scheduler/") ||
  id.includes("/node_modules/react-is/")
) {
  return "react-vendor";
}
```

```ts
// ❌ BROKEN — `/react/` is a substring of `qrcode.react`, `@scope/react`, …
if (id.includes("react-dom") || id.includes("react/jsx-runtime") || id.includes("/react/")) {
  return "react-vendor";
}
```

This is not hypothetical — it is the regression this template shipped and fixed. At the time the app had a video route on `@vidstack/react`; the loose `/react/` test swept it and its hls.js dependency (~250 kB raw) into `react-vendor`, an **eager** chunk every page loads, even though only that one route used it. `react-vendor` reached **1.68 MB** (502 kB gzip) and tripped the >500 kB warning. Anchoring the matcher dropped it to **182 kB**.

The video route is gone (restore it via [add-ins/video.md](./add-ins/video.md), with Vidstack/hls.js **unlisted** so they ride the watch-route split); the trap is not. Every vendor rule you add runs the same risk — `react-markdown`, `react-i18next` and `qrcode.react` all contain the substring `react`, and the first and third are reachable from exactly one route each today. Anchor on `/node_modules/<pkg>/` and the substring can't reach them.

The current vendor chunks (`react-vendor`, `tanstack`, `ui`, `orpc`, `auth`, `zod`) are foundational libraries used on nearly every page, so grouping them into stable, long-cached chunks is a win. **Only add a `manualChunks` rule for something used app-wide.** A dependency used by one route should stay unlisted so it rides that route's automatic split — listing it forces it eager.

`heic-to` (the ~3 MB embedded-libheif HEIC decoder) is the standing example of the "stay unlisted" rule: `asset-image-prepare.ts` loads it via a dynamic `import("heic-to/csp")` that only runs when a HEIC fails native decode, so Rolldown emits it as its own async chunk that most users never download. It is deliberately **not** listed in `manualChunks` — and must never be matched by a loose `/heic/` substring rule, which would sweep it into an eager vendor chunk and blow the base bundle the same way the `/react/` substring once did.

## Component-level dynamic import (`React.lazy`)

Use this **only** when a heavy widget lives inside an otherwise-light, already-split route and renders behind an interaction most sessions never trigger. Example — the 2FA QR encoder (`apps/web/src/components/lazy-qr-code.tsx`):

```tsx
import { Skeleton } from "@starter/ui/components/skeleton";
import { lazy, Suspense } from "react";

const QRCodeSVG = lazy(() => import("qrcode.react").then((m) => ({ default: m.QRCodeSVG })));

export function LazyQRCode({ value, size }: { value: string; size: number }) {
  return (
    <Suspense fallback={<Skeleton style={{ width: size, height: size }} />}>
      <QRCodeSVG value={value} size={size} />
    </Suspense>
  );
}
```

`qrcode.react` only matters during 2FA enrollment, so this kept ~16 kB out of the security route's chunk until the QR actually renders (security route: 21.6 kB → 6 kB). `lazy()` at module top level is fine — it is not a hook and does not violate the [hooks rules](./react-hooks-and-effects.md). Always wrap a lazy component in `<Suspense>` with a layout-matching fallback (a `<Skeleton>`, never a spinner — see [loading-and-errors.md](./loading-and-errors.md)).

Do **not** lazy-wrap small or always-rendered components — the extra request and Suspense boundary cost more than the bytes saved.

### Optional account-aware public chrome

Public SSR pages must stay session-static by default (see [auth-and-routing.md](./auth-and-routing.md)). If a product needs account-aware public controls after hydration:

1. Render the anonymous/static chrome as the SSR and Suspense fallback.
2. Lazy-import the session-aware leaf with `React.lazy` + `ClientOnly` so Better Auth client code is not a static import of the public route module.
3. Keep anonymous and hydrated variants layout-stable.

The Better Auth client chunk may load after first paint; that is acceptable for optional account-aware chrome and is not a reason to make public pages SSR-session-aware.

## i18n locale splitting

Locale JSON is the one app-wide payload that grows without bound: every language adds ~10 kB gzip to the bundle. So **only the default locale is bundled eagerly**; every other locale is fetched on demand as **one chunk per locale**. See `apps/web/src/i18n/index.ts`:

- The eager `import.meta.glob("@locales/en-US/*.json", { eager: true })` ships only `DEFAULT_LOCALE` (a literal — `import.meta.glob` needs static patterns; a dev-time `console.warn` fires if `DEFAULT_LOCALE` drifts from them). The `@locales` alias (in `apps/web/vite.config.ts`) points at the shared `@starter/locales` package source (`packages/locales/src`), which the Expo app also consumes. `native.json` is excluded — Expo-only.
- A second non-eager glob excludes the default-locale folder with a negative pattern, then produces `() => import(...)` loaders for every non-default locale namespace; `loadLocale(locale)` calls them and `i18n.addResourceBundle`s the results.
- Those per-namespace imports would be **one request each**. A `manualChunks` rule in `apps/web/vite.config.ts` groups every JSON under one non-default locale directory into a single chunk named `` `${LOCALE_CHUNK_PREFIX}${locale}` `` (`locale-es-MX`), so the N imports resolve to one file and a first visit to `/es-MX/...` costs **one** request, not twelve.
- The grouping lives in the bundler on purpose. A hand-written per-locale aggregate module would work too, but it adds a lockstep step — every new namespace has to be imported and re-exported in every locale's aggregate — whose failure mode is silent: non-default visitors quietly fall back to English for that namespace. Nothing to forget beats a documented reminder. Adding a locale stays "drop the JSON in".
- An `i18n.on("languageChanged", …)` handler triggers `loadLocale` for every switch (the language switcher, the user-locale sync hook, deep-linked `/es-MX/...` URLs all funnel through `changeLanguage`).
- **`react: { bindI18nStore: "added" }`** is required: the lazy bundle arrives *after* `languageChanged` already fired, so components must re-render on the store's `added` event or a non-default visitor stays stuck on the fallback.

### SSR modulepreload for the active non-default locale

To keep first-visit hydration from waiting on a late locale discovery:

1. The web Vite build sets `build.manifest: true`, writing `apps/web/dist/client/.vite/manifest.json` (source path → content-hashed `/assets/…` file). That file sits inside the static root, so `apps/server` denies `/.vite/*` ahead of `serveStatic` — it maps admin-only chunks and leaks exact dependency versions through its `node_modules` keys. Keep the deny route as long as the flag is on (`static-manifest-privacy.test.ts`).
2. At production startup the API server (`apps/server/src/locale-modulepreload.ts`) loads that manifest and finds each non-default locale's chunk. Vite keys a **manual** chunk by its emitted filename, not by source path (it has no single source module), so the lookup matches the chunk name — which is why `LOCALE_CHUNK_PREFIX` is a shared constant in `@starter/config/locales` that both the Vite config and the server import rather than a string repeated in two files. A source-path fallback keeps the preload working if the grouping is ever removed.
3. On each SSR request the server resolves the URL locale, strips any client-supplied value, and — only for a non-default supported locale present in the map — forwards the same-origin asset URL on the internal `x-locale-modulepreload` request header (same pattern as `x-csp-nonce`).
4. `getRouter()` reads that header into router context (`localeModulePreloadUrl`); the root route's `head()` emits a single `<link rel="modulepreload" href="…">` for that URL.

Do **not** preload every locale, and do **not** put non-default locale data in the eager bundle. Default-locale visits emit no locale modulepreload. CSP stays `script-src 'self' 'nonce-…'` — same-origin modulepreload does not need a policy change.

### Hydration priority

`apps/web/src/client.tsx` awaits (with timeout) the URL locale before `hydrateRoot` so SSR markup matches, and wraps `hydrateRoot` in `startTransition` (React's interruptible-hydration form). Whether that wrapper is there turned out **not to matter** for this app — it stays because it is the documented default, not because it measured faster — and the measurement is worth knowing about before anyone "optimizes" it in either direction.

A/B/A against the production container (`pnpm dev:docker <port> --prod`), 6× CPU throttle + Slow 4G, `/es-MX`, 10 loads per block, metric = dispatch a real click on the header menu trigger every 100 ms until the menu actually opens (empirical time-to-interactive — robust to *when* hydration lands, unlike a single click at the load event):

| Block | Median TTI | Range | Median TBT |
|---|---|---|---|
| no `startTransition` (A) | 673 ms | 654–803 | 2 ms |
| `startTransition` (B) | 1104 ms | 1052–1181 | 0 ms |
| no `startTransition` (A, repeat) | 1083 ms | 1013–1158 | 0 ms |
| `startTransition` (B, repeat) | 1086 ms | 1041–1186 | 0 ms |

Read the last two rows, not the first two. Adjacent blocks differ by **3 ms (0.3%)**, inside a ~50 ms standard deviation; longest-task and TBT distributions are identical. The 400 ms gap between the first A and B blocks was **drift between measurement blocks** — the machine got slower — and it looked exactly like a real effect until A was re-run next to B.

Two things to take from this:

- The hydration-priority choice is not load-bearing here. Don't spend a change on it in either direction — in particular, don't delete `startTransition` on the strength of a measurement that showed no difference; this app is one tree on one machine, and interruptible hydration is what React documents.
- Any future perf claim on this stack needs **interleaved** A/B/A, not one block per variant. A single A-then-B comparison on a developer machine running Docker builds will manufacture a 60% "improvement" out of nothing. Calibrate the CPU throttle too (a fixed busy loop per run): CDP applies throttling asynchronously and a run where it silently didn't land is indistinguishable from a fast one.

**Tradeoff:** a visitor whose initial locale is non-default may still need the locale chunk before localized strings rehydrate. The `/$lang` route awaits `loadLocaleInto(...)` during route loading so public SSR pages have the right bundles before render, and `client.tsx` awaits the URL locale before `hydrateRoot` so hydration markup matches the server's; client-only `_app` navigations still load missing locale chunks on demand. Modulepreload overlaps that fetch with the rest of the critical path. When you add a new UI feature, still add English keys and run `pnpm i18n:translate` exactly as [i18n.md](./i18n.md) describes — the splitting is transparent to authoring. Adding a **locale** needs no bundler change — the chunk rule matches by directory (see [i18n.md § Adding a new locale](./i18n.md#adding-a-new-locale)).

## Font preloading

The UI font (`@fontsource-variable/roboto`, set as `--font-sans` in `packages/ui/src/styles/globals.css`) is `@import`ed from CSS, so the browser only discovers the `.woff2` *after* it has fetched and parsed the stylesheet — the tail of the critical request chain (`HTML → CSS → @font-face → font`). The root route preloads it to fetch it in parallel with the CSS instead. See `apps/web/src/routes/__root.tsx`:

```ts
// resolves to the content-hashed /assets URL of the Latin subset
import robotoLatinUrl from "@fontsource-variable/roboto/files/roboto-latin-wght-normal.woff2?url";
// …in the route's head() links:
{ rel: "preload", href: robotoLatinUrl, as: "font", type: "font/woff2", crossOrigin: "anonymous" }
```

Three things make this correct rather than a regression — copy them if you preload another font:

- **The preloaded URL must be the exact same asset the `@font-face` requests.** Importing the same source `.woff2` with `?url` works because Vite dedupes the JS import and the CSS `url(...)` to one content-hashed output, so the preload hits the request the stylesheet makes — not a second copy. Preloading a *different* URL (wrong subset, wrong hash) double-downloads.
- **`crossOrigin: "anonymous"` is mandatory, even same-origin.** Fonts always fetch in CORS mode; a preload whose `crossorigin` doesn't match is treated as a different request and downloaded twice (Lighthouse flags it as an unused preload). This is the most common font-preload bug.
- **Preload only the subset you actually paint.** Roboto ships Latin, Latin-ext, Cyrillic, Greek, Vietnamese, … each behind its own `unicode-range`. Preloading all of them wastes bandwidth on bytes the page never renders; preload just the Latin subset that every shipped locale uses. Non-preloaded subsets still load on demand. (If you add a non-Latin locale, that subset won't be pre-warmed — see [i18n.md § Adding a new locale](./i18n.md#adding-a-new-locale).)

The `?url` import typechecks via `vite/client`'s `*?url` module declaration (referenced through `vite-plugin-pwa/client` in `apps/web/src/env.d.ts`).

## Measuring

```bash
pnpm --filter web build      # prints every chunk + gzip size; SSR + client environments
```

Read the **`dist/client/assets/*.js`** lines — those ship to browsers (`dist/server/*` is SSR-only). A `(!) Some chunks are larger than 500 kB` warning means an **eager** chunk is fat; find it, and decide:

- Is a one-route dependency trapped in a vendor `manualChunks` rule? → tighten the matcher (the gotcha above). This is almost always the cause.
- Is it a genuinely huge always-loaded lib? → consider a component-level `import()`, or accept it if it's foundational (e.g. `zod`).
- Is the chunk lazy and just naturally large (e.g. the chat route's markdown renderer, a locale chunk)? → fine, leave it; only eager chunks block first paint.

The warning is advisory — it does not fail the build. `build.chunkSizeWarningLimit` adjusts the threshold and `build.rolldownOptions.output.codeSplitting` ([Rolldown docs](https://rolldown.rs/reference/OutputOptions.codeSplitting)) offers finer control, but reach for the `manualChunks` fix first — bumping the limit just hides a real eager-bundle regression.
