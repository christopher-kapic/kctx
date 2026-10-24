# Patterns

Canonical patterns for building on this starter. Each file is a self-contained recipe for one concern, with copy-pasteable code matching the stack (TanStack Router + React Query + oRPC + TanStack Form + Better-Auth + Prisma on Hono).

**Read the AGENTS.md rules first** — they are the high-level rules; these patterns are the worked examples. `AGENTS.md` is the source of truth: `CLAUDE.md`, `.cursorrules`, and `.github/copilot-instructions.md` are generated mirrors for specific agent harnesses. Never hand-edit a mirror — edit `AGENTS.md` and run `pnpm sync:agent-docs`.

## Quick picks

| I want to… | Go here |
|---|---|
| Start a brand-new project (onboarding: machine, product, roles, hosting, build plan) | [getting-started.md](./getting-started.md) |
| **Build your first feature** — one vertical end to end, every file in order (schema → procedure → test → route → overlays → locales → nav → sitemap → access matrix) | [golden-path.md](./golden-path.md) |
| Trust Claude Code project hooks (the prompt is expected; Cursor/Copilot backstop) | [claude-code-setup.md](./claude-code-setup.md) |
| Fetch data on a page | [data-fetching.md](./data-fetching.md) |
| Mutate and invalidate | [mutations.md](./mutations.md) |
| Should this be optimistic / live / local-first? | [mutations § When optimistic updates aren't enough](./mutations.md#when-optimistic-updates-arent-enough-sync-engines) |
| Add an autocomplete/combobox field | [autosuggest.md](./autosuggest.md) |
| Build a form | [forms.md](./forms.md) |
| Add an anonymous public form (contact, lead capture — spam/abuse guardrails) | [public-forms.md](./public-forms.md) |
| Export data as CSV, or generate PDF documents | [exports.md](./exports.md) |
| Take payments / add billing — **not shipped**; decisions, webhook idempotency, money rules | [payments.md](./payments.md) |
| Show loading / error states | [loading-and-errors.md](./loading-and-errors.md) |
| Add motion / animate something (`pop in`, `stagger`, `scroll reveal`, `spring`) | [animation.md](./animation.md) |
| Design a component API / split a large route / add context | [react-composition.md](./react-composition.md) |
| Fix a hooks-order or `useEffect` violation | [react-hooks-and-effects.md](./react-hooks-and-effects.md) |
| Write user-facing error message copy | [error-messages.md](./error-messages.md) |
| Open a dialog / sheet / drawer | [overlays.md](./overlays.md) |
| Apply visual design (spacing, type, hierarchy, shadows, motion, `will-change`) | [design-system.md](./design-system.md) |
| Change the shadcn color theme / apply a theme-editor preset; switch Base UI ↔ Radix | [shadcn-theme-update.md](./shadcn-theme-update.md) |
| Split bundles / add a dynamic import / fix a fat eager chunk (routes auto-split, `manualChunks`, `React.lazy`, i18n locales) | [performance-and-bundling.md](./performance-and-bundling.md) |
| Speed up Docker builds (VPS, CI) with Turborepo Remote Cache (Vercel) | [turbo-remote-cache.md](./turbo-remote-cache.md) |
| Build a dashboard (toasts, URL-as-state, list-management & invite recipes) | [dashboard-ui.md](./dashboard-ui.md) |
| Work on the Expo native app | [native.md](./native.md) |
| Work on the companion Rust CLI (commands, CI, cargo-dist releases) | [cli.md](./cli.md) |
| Add an authenticated route (layout + `index` child for list/detail sections) | [auth-and-routing.md](./auth-and-routing.md) |
| Add product-specific staff roles from the access matrix | [custom-roles.md](./custom-roles.md) |
| Write a server procedure | [server-procedures.md](./server-procedures.md) |
| SSR a blog post / article for SEO | [ssr-for-articles.md](./ssr-for-articles.md) |
| Add a background job | [queue.md](./queue.md) |
| Manage client-side state | [zustand.md](./zustand.md) |
| Host user uploads / avatars / images (S3 + sharp + blurhash) | [assets.md](./assets.md) |
| Convert HEIC / shrink huge photos before upload | [assets.md § Prepare images in the browser](./assets.md#prepare-images-in-the-browser) |
| Stop file drops from navigating the SPA | [assets.md § Drag-and-drop (never navigate)](./assets.md#drag-and-drop-never-navigate) |
| Internationalize the UI (`t()`, `/$lang/...`, Zod error map, locale-bundle auto-translation) | [i18n.md](./i18n.md) |
| Add analytics without shipping a non-compliant cookie banner (consent gate, `loadAnalytics()` seam) | [consent.md](./consent.md) |
| Manage agent instructions | [agent-instructions.md](./agent-instructions.md) |
| Manage dependencies (pnpm catalog) | [dependencies.md](./dependencies.md) |
| Respond to a CVE (pnpm overrides, release-age gate, OS patches) | [dependency-vulnerabilities.md](./dependency-vulnerabilities.md) |
| Change or add a database field/model | [schema-changes-recipe.md](./schema-changes-recipe.md) |
| Design a new Prisma model (naming, IDs, relations, indexes) | [schema-guidelines.md](./schema-guidelines.md) |
| Understand how schema push is applied | [schema-push.md](./schema-push.md) |
| Plan database backups and practice restore | [backup-and-restore.md](./backup-and-restore.md) |
| Write server-side tests | [testing.md](./testing.md) |
| Add an environment variable, or generate a production `.env` (`pnpm generate:secrets`) | [environment-variables.md](./environment-variables.md) |
| Add or tune a rate limit (per-surface budgets, fail-open vs fail-closed, shared-NAT traps) | [rate-limiting.md](./rate-limiting.md) |
| Harden for production (rate limit, admin, CSRF) | [production-hardening.md](./production-hardening.md) |
| Prepare to launch (privacy, audience, tracking, AI disclosures, email, billing, uploads, accessibility) | [launch-readiness.md](./launch-readiness.md) |
| Deploy with Dokploy (default; generated Compose + settings checklist) | [deployment-vps.md](./deployment-vps.md) |
| Boot a disposable stack on any port for agent UI testing | [agent-ui-testing.md](./agent-ui-testing.md) |
| Give someone a public URL to the running dev app (Cloudflare quick tunnel) | [dev-tunnels.md](./dev-tunnels.md) |
| Install a new package safely (confirm-first, catalog, changelog check) | [agent-tooling.md](./agent-tooling.md) |
| Run a full project health audit (CI sweep + structure + rule compliance) | [project-audit.md](./project-audit.md) |
| Run a periodic cleanup pass (dead code, schema drift, S3 race-condition checks, queue health) | [agent-tasks/cleanup.md](./agent-tasks/cleanup.md) |
| Apply display branding (default), or opt into a full internal rebrand | [agent-tasks/rebrand.md](./agent-tasks/rebrand.md) |
| Run the agent dependency-update task | [agent-tasks/update-dependencies.md](./agent-tasks/update-dependencies.md) |
| Add a new admin page (404-hidden `/admin` group, `adminOr404Procedure`) | [admin-dashboard.md](./admin-dashboard.md) |
| Build a tool-calling LLM agent (tool seam, result paging, untrusted content, retry/failover, loop guard) | [agent-runtime.md](./agent-runtime.md) |
| Dependency / codebase investigation (map, examples-first, master + optional `delegate_explore`) | [explore-investigation.md](./explore-investigation.md) |
| Stream server→client without losing anything (SSE + `Last-Event-ID` replay, durable cursor, process-wide pub/sub) | [durable-streaming.md](./durable-streaming.md) |
| Rebrand the PWA display layer (name, icons, theme color, offline page) — subset of the full rebrand | [removable/rebrand.md](./removable/rebrand.md) |
| Remove BullMQ background jobs / the worker (Redis stays for server security) | [removable/queue.md](./removable/queue.md) |
| Remove web push notifications | [removable/push.md](./removable/push.md) |
| Remove PWA / service worker | [removable/pwa.md](./removable/pwa.md) |
| Remove email / SMTP | [removable/email.md](./removable/email.md) |
| Remove the admin seed trigger (`/admin/seed` + BullMQ `seed` queue — the `prisma db seed` CLI stays) | [removable/seed.md](./removable/seed.md) |
| Turn ON durable agentic chat — it ships **disabled** (`CHAT_ENABLED` + `OPENROUTER_API_KEY`) | [add-ins/chat.md](./add-ins/chat.md) |
| Add an admin MCP server (API keys + device codes) — **not shipped**; a standing admin credential surface | [add-ins/mcp-server.md](./add-ins/mcp-server.md) |
| Add API keys — bearer auth for CLIs, services, and programmatic API access — **not shipped** | [add-ins/api-keys.md](./add-ins/api-keys.md) |
| Add device authorization — browser-approved login for CLIs and headless clients (RFC 8628) — **not shipped** | [add-ins/devices.md](./add-ins/devices.md) |
| Add a typed CMS (pages + posts) — **not shipped**; landing copy lives in locale bundles until you need editor-authored content | [add-ins/cms.md](./add-ins/cms.md) |
| Add HLS video (upload, ffmpeg transcode, playback) — **not shipped**; S3 assets cover images and files | [add-ins/video.md](./add-ins/video.md) |
| Add Mux video (managed upload, encoding, playback, optional DRM) — **not shipped**; fully managed sibling to the video add-in | [add-ins/video-mux.md](./add-ins/video-mux.md) |
| Remove i18n (react-i18next, `/$lang/...`, auto-translate) | [removable/i18n.md](./removable/i18n.md) |
| Preview and verify removing the optional Expo app (`pnpm template:remove native`) | [removable/native.md](./removable/native.md) |
| Preview and verify removing the optional Rust CLI (`pnpm template:remove cli`) | [removable/cli.md](./removable/cli.md) |

**Doc tiers.** Must-read for every project: [getting-started](./getting-started.md), [golden-path](./golden-path.md), [agent-instructions](./agent-instructions.md), [data-fetching](./data-fetching.md), [mutations](./mutations.md), [server-procedures](./server-procedures.md), [forms](./forms.md), [testing](./testing.md), [schema-guidelines](./schema-guidelines.md), [schema-changes-recipe](./schema-changes-recipe.md), [deployment-vps](./deployment-vps.md), [environment-variables](./environment-variables.md), [rate-limiting](./rate-limiting.md). Everything else in this directory is reference-on-demand — open it when the task matches its row above.

## Philosophy

1. **Client-side data fetching is the default.** All dashboards, tables, and app UIs fetch on the client via oRPC + TanStack Query with skeleton loaders. Only exception: content that needs SEO — see `ssr-for-articles.md`.
2. **Types flow from the server with no codegen.** Adding a procedure in `packages/api/src/routers/` immediately surfaces it on the client as `orpc.<router>.<procedure>`.
3. **IDs travel, names display.** When an input selects an entity (autocomplete, combobox, select), store the ID in form state and render the human-readable name.
4. **Slugs address, IDs identify.** A public, shareable URL carries a readable slug; the primary key stays internal. Admin routes are the deliberate exception — see [auth-and-routing § Dynamic segments](./auth-and-routing.md#dynamic-segments--slugs-in-user-facing-urls-ids-in-admin).
5. **Skeletons mirror final layout.** Never a spinner for content loading; match the shape of the final UI.
6. **Mutations are idiomatic.** Use `orpc.foo.bar.mutationOptions({ onSuccess })` inside `useMutation`, not a hand-rolled `mutationFn` that wraps `.call()`.
7. **Every query handles three states.** `isPending`, `isError`, success. An unhandled error state is a bug.
8. **No `useEffect` in components/routes.** Use `useQuery`, derive state inline, or push the effect into a custom hook in `apps/web/src/hooks/`.
9. **Composition stays explicit.** Prefer discriminated states over boolean mode combinations, split large route files into non-exported local sections first, and introduce compound components only when shared state or repeated workflow structure justifies them.
