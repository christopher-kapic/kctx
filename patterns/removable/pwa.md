# Removing (and Re-Adding) the PWA Layer

Cleanly rip the PWA / service worker / install-prompt scaffolding out of the starter for a plain web app — and the reverse for putting it back. End state: a build that produces no `sw.js`, no `manifest.webmanifest`, and no Workbox cache (or, in reverse, a fully working installable PWA again).

This is purely the PWA shell. Auth, oRPC, Prisma, BullMQ, and the rest of the stack are unaffected.

## When to remove

If the product is desktop-only, embedded inside another shell (Electron, an existing native app, an iframe widget), or explicitly not meant to be installed to a home screen, the PWA layer is dead weight. It adds a Workbox build step, a service worker that has to be cache-invalidated on every deploy, an unwanted install-prompt UX, and a precache that bloats build artifacts. Ripping it out cuts build time, removes a class of "stale cached JS" bug reports, and lets you treat the app as a normal SPA served by your CDN.

## What removing loses

- No "Add to Home Screen" install prompt. The browser will not offer installation on Android or iOS Safari.
- No offline support. A failed navigation request shows the browser's default offline page instead of `/offline.html`.
- No Workbox precaching. Returning visitors re-download static assets the normal HTTP-cache way.
- No app-like standalone window — installed shortcuts (if any pre-existed) open in a normal browser tab.
- No background push notification delivery via the SW `push` listener. If you rely on web push, leave the PWA layer in place or migrate the push handler.

The browser experience still works normally. Routing, data fetching, auth, and forms are unchanged.

## Touchpoints in this repo

Full list of files participating in the PWA layer; the removal steps reference each one.

- `apps/web/vite.config.ts` — `VitePWA` type + plugin import (line 12 at time of writing), the `const pwaPlugins = VitePWA({ ... })` block (lines 164–194), and its companion `generate-sw-after-client-build` plugin (lines 195–210) that forces `generateSW()` from the client environment — under TanStack Start's multi-environment build the plugin's own `closeBundle` never builds the SW. The `injectManifest` strategy points at `src/sw.ts`.
- `apps/web/src/sw.ts` — the actual service worker (Workbox precache, runtime caching for fonts/wasm/workers, offline fallback, push notification handlers).
- `apps/web/pwa-assets.config.ts` — `@vite-pwa/assets-generator` config used by the `generate-pwa-assets` script.
- `apps/web/public/` — generated PWA assets:
  - `manifest.webmanifest` (generated into `dist/client/` by the plugin, not in `public/`)
  - `apple-touch-icon-180x180.png`
  - `maskable-icon-512x512.png`
  - `pwa-64x64.png`, `pwa-192x192.png`, `pwa-512x512.png`
  - `offline.html`
- `apps/web/src/routes/__root.tsx` — TanStack Start owns the document `<head>` (there is no `index.html`). The `head()` block contains `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, and `mobile-web-app-capable` meta tags, plus explicit `<link rel="manifest">` and `<link rel="apple-touch-icon">` entries. (`theme-color` is not declared here — it is managed imperatively by `THEME_INIT_SCRIPT` / `ThemeColorSync`.)
- `apps/web/src/hooks/use-app-update.ts` — registers the service worker explicitly via `registerSW()` from `virtual:pwa-register`. The auto-injected `registerSW.js` script tag never runs (no static `index.html`), so this hook is the only registration path. Pure PWA now — the old `/version.json` polling and `controllerchange` reload are gone.
- `apps/web/src/hooks/use-push-notifications.ts` — touches `navigator.serviceWorker.ready`. Only meaningful if a service worker is registered.
- `apps/web/src/components/pull-to-refresh.tsx`, its single consumer in the app shell `apps/web/src/routes/$lang/_app/route.tsx`, and the `data-pull-to-refresh="off"` opt-out in `apps/web/src/routes/$lang/_app/_auth/chat.tsx` — not strictly PWA-only, but part of the "native feel" rules.
- `apps/web/package.json` — `vite-plugin-pwa`, `@vite-pwa/assets-generator`, `workbox-expiration`, `workbox-precaching`, `workbox-routing`, `workbox-strategies`, `workbox-window`, plus the `generate-pwa-assets` script.
- `pnpm-workspace.yaml` — none of the above are pinned in the catalog at time of writing; they live directly in `apps/web/package.json`. The security `overrides` do reference the `vite-plugin-pwa` and `@vite-pwa/assets-generator` chains (`filelist>minimatch`, `vite-plugin-pwa@…>workbox-build`, `…>sharp`) — drop those entries when the packages go. If you have added the packages to the catalog, remove them there too.
- `AGENTS.md` — the `### PWA — Native Mobile Feel` section. The harness mirrors are generated from it, but nothing syncs automatically: edit `AGENTS.md`, then run `pnpm sync:agent-docs`.
- `patterns/removable/rebrand.md` — only useful if the PWA exists; delete or leave as a no-op reference.

## Removal steps

> **Deploy config:** no changes needed. The PWA / service worker is built into the SPA bundle at build time and has no dedicated environment variables. (Branding vars like `VITE_APP_NAME` belong to [rebrand.md](./rebrand.md), not the PWA layer — leave them.)

Run these in order. Each step is independent enough that you can stop at any point and the app will still build — one coupling: step 5 must land with (or before) step 1, because `use-app-update.ts` imports `virtual:pwa-register`, which only the plugin provides.

### 1. Remove the VitePWA plugin

In `apps/web/vite.config.ts`:

- Delete the `import { type VitePluginPWAAPI, VitePWA } from "vite-plugin-pwa";` line near the top.
- Delete the entire `const pwaPlugins = VitePWA({ ... })` block (the one with `strategies: "injectManifest"`, `srcDir: "src"`, `filename: "sw.ts"`, `outDir: "dist/client"`, the `manifest` object, `pwaAssets`, `devOptions`, and `injectManifest`), the `pwaApi` lookup right after it, and the companion `generateSWAfterClientBuild` plugin — then drop `pwaPlugins` and `generateSWAfterClientBuild` from the `plugins` array. Anything left referencing them breaks the build.

After this, `vite build` no longer emits `sw.js`, `manifest.webmanifest`, or `registerSW.js`.

### 2. Delete the service worker source

- `rm apps/web/src/sw.ts`
- `rm apps/web/pwa-assets.config.ts`

### 3. Delete generated PWA assets from `public/`

```
apps/web/public/apple-touch-icon-180x180.png
apps/web/public/maskable-icon-512x512.png
apps/web/public/pwa-64x64.png
apps/web/public/pwa-192x192.png
apps/web/public/pwa-512x512.png
apps/web/public/offline.html
```

Keep `favicon.ico` and `logo.png` — those are normal browser assets.

### 4. Strip PWA meta tags from `apps/web/src/routes/__root.tsx`

In the `head()` return value of the root route, delete these `meta` entries:

- `{ name: "apple-mobile-web-app-capable", content: "yes" }`
- `{ name: "apple-mobile-web-app-status-bar-style", content: "black" }`
- `{ name: "mobile-web-app-capable", content: "yes" }`

There is no `theme-color` meta to remove — it is created imperatively by `THEME_INIT_SCRIPT` and kept in sync by `apps/web/src/components/theme-color-sync.tsx`; keep those if you want the colored Android address bar. Also delete the explicit `{ rel: "manifest", href: "/manifest.webmanifest" }` and `{ rel: "apple-touch-icon", … }` entries from the `links` array (step 3 removes the icon file the latter points at).

### 5. Remove service-worker registration code

The starter registers the service worker **explicitly**: `apps/web/src/hooks/use-app-update.ts` imports `registerSW` from `virtual:pwa-register` and calls it on mount (vite-plugin-pwa's auto-injected `registerSW.js` script tag never runs — this app has no static `index.html`). Removing the plugin (step 1) alone therefore breaks the build on the unresolved `virtual:pwa-register` import. Clean up the two hooks that touch the SW:

- `apps/web/src/hooks/use-app-update.ts` — **delete the hook** and remove the `useAppUpdate()` call from `RootComponent` in `apps/web/src/routes/__root.tsx`. Nothing else is lost: the update model is silent auto-update with no toast and no forced reload; without a SW, returning visitors just get fresh assets via the normal HTTP cache on their next visit.
- `apps/web/src/hooks/use-push-notifications.ts` (lines 17, 30, 51) — the `navigator.serviceWorker.ready` calls become permanently pending without a registered SW. If you are removing PWA you almost certainly do not want web push either; delete this hook and any UI that consumes it. If you do want push without the PWA shell, you have to register a minimal SW for push only and the rip-out is no longer "clean" — leave the PWA layer in place instead.

### 6. (Optional) Remove the rest of the native-feel layer

Not strictly PWA, but they exist because the app pretends to be a native shell. Decide per-piece:

- **`PullToRefresh` component.** Remove `apps/web/src/components/pull-to-refresh.tsx`, unwrap `<Outlet />` from it in `apps/web/src/routes/$lang/_app/route.tsx` (drop the `handleRefresh` callback and the `relative` class on `main` with it), and delete the `data-pull-to-refresh="off"` attributes (e.g. in `chat.tsx`). Desktop users do not pull-to-refresh; they hit the reload button.
- **`BottomNav` + the bottom padding.** If you also drop the mobile bottom tab bar (because the app is desktop-only), edit `apps/web/src/routes/$lang/_app/route.tsx` and:
  - Remove the `<BottomNav hidden={mobileKeyboardOpen} />` line.
  - Remove the `pb-[calc(3.5rem_+_var(--safe-area-bottom))]` and `md:pb-0` classes from the `cn(...)` on the grid wrapper.
  - Drop the `import BottomNav from "@/components/bottom-nav";` import, plus the `useMobileKeyboard()` call and import if nothing else in the file uses them.
  - Delete `apps/web/src/components/bottom-nav.tsx` if nothing else references it.

### 7. Drop PWA dependencies

In `apps/web/package.json`, remove:

- `"vite-plugin-pwa"` (dependencies)
- `"@vite-pwa/assets-generator"` (devDependencies)
- `"workbox-expiration"` (devDependencies)
- `"workbox-precaching"` (devDependencies)
- `"workbox-routing"` (devDependencies)
- `"workbox-strategies"` (devDependencies)
- `"workbox-window"` (devDependencies)

Also delete the `"generate-pwa-assets": "pwa-assets-generator"` script entry.

Check `pnpm-workspace.yaml` — at time of writing none of these are pinned in the catalog, but the security `overrides` reference the `vite-plugin-pwa` and `@vite-pwa/assets-generator` chains (`filelist>minimatch`, `vite-plugin-pwa@…>workbox-build`, `…>sharp`); delete those override entries too, and any catalog entries if your fork moved the packages there.

Then prune the lockfile:

```sh
pnpm install
```

### 8. Remove the AGENTS.md PWA rules

In `AGENTS.md`, delete the entire `### PWA — Native Mobile Feel` section (from that heading up to the next `###` heading). The agent should not be told to enforce 44px touch targets, skeleton-over-spinner loading, or overscroll/tap-highlight conventions in a desktop build — those rules will fight any new code it writes.

Also drop `Vite PWA` from the `## Stack` paragraph, which today reads:

> React 19, TanStack Router + Query + Form, oRPC, Hono, Prisma, Better-Auth, Tailwind v4 + shadcn/ui, Zustand (client state, `apps/web/src/stores/`), BullMQ, **Vite PWA**, i18n (`/$lang/...`), Turborepo/pnpm, `portless` for local HTTPS.

Leaving `Vite PWA` in the stack line tells every future agent the app still installs and works offline, one paragraph after you deleted the service worker.

`CLAUDE.md`, `.cursorrules`, and `.github/copilot-instructions.md` are generated from `AGENTS.md` — never hand-edit them. Run `pnpm sync:agent-docs` to propagate.

Also update `patterns/README.md` (the categorized patterns index): delete the "Remove PWA / service worker" row, and — if you delete `patterns/removable/rebrand.md` along with the PWA — the rebrand rows that point at it.

### 9. Build and verify

```sh
pnpm build
```

The build should complete with no "vite-plugin-pwa" log lines. Inspect `apps/web/dist/client/`:

- No `sw.js`
- No `manifest.webmanifest`
- No `registerSW.js`
- No `pwa-*.png`, no `apple-touch-icon-*.png`, no `maskable-icon-*.png`
- No `offline.html`

Open the built app in a browser: DevTools → Application → Service Workers should be empty; Application → Manifest should say "No manifest detected".

## Adding the PWA layer back

Reverse direction. The last commit before your rip-out is the canonical reference — `git show <pre-removal-sha> -- apps/web/vite.config.ts apps/web/src/sw.ts apps/web/pwa-assets.config.ts apps/web/src/routes/__root.tsx` gives copy-paste blocks for every file below.

### 1. Re-install the dependencies

In `apps/web/package.json`, add back:

```json
"dependencies": {
  "vite-plugin-pwa": "^1.3.0"
},
"devDependencies": {
  "@vite-pwa/assets-generator": "^1.0.2",
  "workbox-expiration": "^7.4.1",
  "workbox-precaching": "^7.4.1",
  "workbox-routing": "^7.4.1",
  "workbox-strategies": "^7.4.1",
  "workbox-window": "^7.4.1"
}
```

and the script:

```json
"scripts": {
  "generate-pwa-assets": "pwa-assets-generator"
}
```

If your fork pins shared versions in `pnpm-workspace.yaml`, add them to the catalog instead and reference them with `"catalog:"` from `package.json`. See `patterns/dependencies.md`.

```sh
pnpm install
```

### 2. Re-add the VitePWA plugin

In `apps/web/vite.config.ts`, restore the Vite `Plugin` type import together with the PWA import and plugin call. If the existing `vite` import already names other symbols, merge `type Plugin` into that import rather than adding a duplicate module import:

```ts
import { loadEnv, type Plugin } from "vite";
import { type VitePluginPWAAPI, VitePWA } from "vite-plugin-pwa";

// assign to a variable — the companion plugin below needs it
const pwaPlugins = VitePWA({
  strategies: "injectManifest",
  srcDir: "src",
  filename: "sw.ts",
  outDir: "dist/client",
  registerType: "autoUpdate",
  manifest: {
    name: appName,        // from VITE_APP_NAME — see env.VITE_APP_NAME in this file
    short_name: appName,
    description: `${appName} - PWA Application`,
    theme_color: "#0c0c0c",
    background_color: "#0c0c0c",
  },
  pwaAssets: { disabled: false, config: true },
  devOptions: { enabled: true, type: "module" },
  injectManifest: {
    globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
    globIgnores: ["**/logo.png", "**/heic-to-*.js"],
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
  },
});
```

**Do not stop at the plugin call.** Under TanStack Start's multi-environment build, vite-plugin-pwa's own `closeBundle` captures the SSR environment's config (`build.ssr: true`) and silently never builds `src/sw.ts` — the deployed app would 404 on `sw.js`. The starter compensates with a companion plugin that calls `pwaApi.generateSW()` from the client environment's `closeBundle`:

```ts
const pwaApi = pwaPlugins.find((p) => p.name === "vite-plugin-pwa")?.api as
  | VitePluginPWAAPI
  | undefined;
const generateSWAfterClientBuild: Plugin = {
  name: "generate-sw-after-client-build",
  apply: "build",
  enforce: "post",
  closeBundle: {
    sequential: true,
    order: "post",
    async handler() {
      if (this.environment?.name !== "client") return;
      await pwaApi?.generateSW();
    },
  },
};
```

Add both (`pwaPlugins`, `generateSWAfterClientBuild`) to the `plugins` array.

### 3. Re-add the service worker source

Recreate `apps/web/src/sw.ts` with Workbox precaching, runtime caching for fonts/wasm/workers, the offline fallback, and any push handlers you want. Pull from `git show <pre-removal-sha>:apps/web/src/sw.ts` for the canonical contents.

Recreate `apps/web/pwa-assets.config.ts`:

```ts
import { defineConfig, minimal2023Preset as preset } from "@vite-pwa/assets-generator/config";

export default defineConfig({
  headLinkOptions: { preset: "2023" },
  preset,
  images: ["public/logo.png"],
});
```

### 4. Regenerate icons and offline page

```sh
pnpm --filter web generate-pwa-assets
```

This produces `pwa-64x64.png`, `pwa-192x192.png`, `pwa-512x512.png`, `apple-touch-icon-180x180.png`, and `maskable-icon-512x512.png` from `public/logo.png`.

Hand-author `apps/web/public/offline.html` — it is a static page, not generated. Use the previous version in git history as a starting point.

### 5. Restore meta tags in `__root.tsx`

In `apps/web/src/routes/__root.tsx`, add back to the `meta` array in `head()`:

```ts
{ name: "apple-mobile-web-app-capable", content: "yes" },
{ name: "apple-mobile-web-app-status-bar-style", content: "black" },
{ name: "mobile-web-app-capable", content: "yes" },
```

Do not re-add a `theme-color` meta — it is managed imperatively (`THEME_INIT_SCRIPT` creates it on the first frame, `ThemeColorSync` updates it on theme toggles); a static entry here reintroduces the white-status-bar-in-dark-mode bug. Also restore the link entries:

```ts
{ rel: "manifest", href: "/manifest.webmanifest" },
{ rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon-180x180.png" },
```

(`vite-plugin-pwa` generates `/manifest.webmanifest` into `dist/client/` — the link points at that output, and nothing injects it for you.)

### 6. Restore `useAppUpdate` and `usePushNotifications`

If you deleted them, restore from git history. `useAppUpdate` should be called from `RootComponent` so the service worker is registered again (it is the only registration path — there is no auto-injected `registerSW.js` script).

### 7. Restore the AGENTS.md PWA section

Re-add the `### PWA — Native Mobile Feel` section to `AGENTS.md` from git history, then run `pnpm sync:agent-docs`.

## Sanity checks

### After removal

- `pnpm build` succeeds with no `vite-plugin-pwa` output in the log.
- `apps/web/dist/client/` contains no `sw.js`, `manifest.webmanifest`,
  `registerSW.js`, `offline.html`, or `pwa-*.png`.
- DevTools → Application → Service Workers is empty.
- DevTools → Application → Manifest says "No manifest detected".
- DevTools → Application → Cache Storage has no `workbox-*` or `offline`
  entries on a fresh load.
- A `grep -r "serviceWorker\|virtual:pwa-register\|workbox" apps/web/src`
  returns nothing.

### After re-adding

- `pnpm build` logs the `vite-plugin-pwa` injection step and writes
  `sw.js` and `manifest.webmanifest` into `apps/web/dist/client/`.
- DevTools → Application → Service Workers shows a registered, activated
  worker for the app origin.
- DevTools → Application → Manifest validates with no errors and shows the
  `name`, `short_name`, `theme_color`, and icons.
- On Chrome desktop, the install icon appears in the URL bar after a few
  seconds of interaction.
- A second visit (after the SW activates) loads precached assets from the
  service worker (visible as "ServiceWorker" in the Network tab Source
  column).
- Going offline in DevTools and reloading shows `/offline.html` for any
  navigation request.
