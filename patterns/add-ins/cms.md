# Add-in: Typed CMS (pages + posts)

The template does **not** ship a CMS. Landing-page copy lives in the i18n bundles (`home.*` in `packages/locales/src/<lang>/common.json`); that is the deliberate replacement — one place to edit, translated by the same script as the rest of the UI, no content database to operate.

This is the recipe for building the typed CMS that used to ship here: fixed-slug **pages** (Zod schema + default content + render function), Prisma-backed **posts** (markdown, draft/publish, preview tokens), and an admin Finder over the existing [assets](../assets.md) store so markdown can embed `asset:<id>` images.

It existed in this template once and was removed on purpose. The [Full source](#full-source--the-commits-that-had-it) section names the commit if your app still carries template history; everything needed to rebuild it from nothing is below.

## Read this first: most apps do not need it

Build this when someone without repo access must author pages or posts weekly, and that copy cannot live in a locale bundle. Do not build it so the landing page is "editable" — changing `home.*` and running `pnpm i18n:translate` is the cheaper path, reviewed and deployed like any other change.

A CMS is a content database, an admin editing surface, a sanitization boundary for anything rendered as markup, a translation worker, and a public SSR surface. It is not a locale-bundle key. [i18n.md § One store, one update path](../i18n.md#one-store-one-update-path).

Do **not** replace the shipped `t()`-driven home route unless the product explicitly wants `/` to be editor-authored. Restore posts (and optionally `/about`) first. Cookie-policy copy is a separate decision: the slim consent banner currently links to nothing on purpose ([consent.md § Adding a cookie-policy page later](../consent.md#adding-a-cookie-policy-page-later)); a CMS page is one way to fill that, a static `t()` route is another.

## What you get

- Typed page templates: the set of slugs is fixed in code; each template owns a Zod schema; the admin form is derived from that schema; the public route consumes `z.infer<typeof schema>`.
- Posts with `DRAFT` / `PUBLISHED`, markdown bodies, optional hero image, soft-delete, and short-lived draft preview tokens.
- Locale-aware content: source row plus `PostTranslation` / `PageTranslation`, with a BullMQ `translate-content` worker that never overwrites a human edit.
- Admin UIs at `/admin/content/pages` and `/admin/content/posts` (the posts workspace is a route, not a Sheet — [overlays.md § Route-Based Exceptions](../overlays.md#route-based-exceptions)).
- Public SSR pages under `/$lang/_public` ([ssr-for-articles.md](../ssr-for-articles.md)).

## Properties that must hold

Each of these is checkable. An agent restoring this surface should be able to point at the code that satisfies every line.

- [ ] **Two registries, one schema.** `packages/cms-templates` is the shape authority (Zod schemas + defaults, no React, no `@starter/api`). The web registry (`apps/web/src/cms/pages/_registry.ts`) adds the render function and re-validates erased `unknown` content before rendering. The server validates writes with the **Zod schema**, not the exported JSON Schema (that document only lays out admin form controls).
- [ ] **An admin cannot conjure a slug.** `cms.pages.update` accepts only registry keys. Adding `/pricing` means adding a template in code, then a public route, then `PUBLIC_PATHS` + `sitemap.md`.
- [ ] **Every list procedure is bounded** (`cursorPageInput` + `take`). Public `cms.posts.list` / `get` surface only `PUBLISHED` rows whose `publishedAt` is in the past.
- [ ] **Public pages live under `/$lang/_public` with `ssr: true`.** A child of `_app` cannot turn SSR back on. [ssr-for-articles.md](../ssr-for-articles.md).
- [ ] **Every new public indexable page updates `PUBLIC_PATHS` and `sitemap.md` in the same change.** Auth, preview, and admin routes stay out of `PUBLIC_PATHS`.
- [ ] **Asset URLs are 24-hour bearer tokens.** Before emitting `/api/assets/:id` or `/api/images/:id` — in JSON, SSR HTML, markdown `urlTransform`, anywhere — the recipient must be allowed to see the asset. Filter at the source. [assets.md § The agent rule](../assets.md#the-agent-rule--check-permissions-before-you-hand-out-the-url). Split the write-side gate: for **pages**, `cms.pages.update` rejects non-PUBLIC refs when the template is `access: "public"`. For **posts**, drafts may reference restricted assets (the admin preview is authenticated); `cms.posts.publish`, and `update` / `upsertTranslation` of an already-`PUBLISHED` row, refuse non-PUBLIC refs. Keep the original `upgradeRestrictedAssets` flag if you restore it — it promotes assets the publisher owns rather than failing. The gate lives in `61e82a9^:packages/api/src/routers/cms/posts.ts`, not on every update.
- [ ] **Markdown embeds `asset:<id>`, never `/api/images/<id>`.** The rotating URL is computed at render time. The add-in ships that rewrite in the **admin** preview pane. A public post list/detail UI is an optional follow-up (the original shipped public oRPC `cms.posts.list` / `get` and no public renderer); if you add one, the same `urlTransform` applies.
- [ ] **Slugs are human-readable**, unique, not `@default(cuid(2))`. `packages/api/src/lib/slug.ts` already exists (`slugify` / `uniqueSlug`) — use it. Handle P2002 as `CONFLICT`; `uniqueSlug` is best-effort, not atomic. [schema-guidelines.md § Slugs and public identifiers](../schema-guidelines.md#slugs-and-public-identifiers).
- [ ] **Preview tokens are stored hashed** (SHA-256), returned once, capped TTL (default 1 h, max 24 h). `cms.posts.get(slug)` 404s drafts; only `getByPreviewToken` returns them. Every failure mode of that procedure is a 404.
- [ ] **Human translations are never overwritten.** The worker skips `translationOrigin === "HUMAN"` rows. Re-translate deletes and re-enqueues only `MACHINE` rows.
- [ ] **Every new procedure starts from a registered builder** in `packages/api/src/index.ts` (`procedureAccessLevels` / `middlewareAccessLevels`). Public reads: `publicProcedure`. Admin writes: `adminOr404Procedure`. [custom-roles.md](../custom-roles.md).
- [ ] **The access matrix in `notes/02-users-and-roles.md` covers every new endpoint.** Record `planned`, then `implemented` with the real dotted path in the change that ships the procedure. Do not add app endpoints to `scripts/access-matrix-pre-notes-baseline.json` — that file is the template's shipped-endpoint floor.
- [ ] **Every user-facing string goes through `t()`.** New English keys in `packages/locales/src/en-US/`, then `pnpm i18n:translate`.
- [ ] **A new workspace package is a Docker COPY change.** `pnpm docker:check-copy` fails if `packages/cms-templates/package.json` is missing from the builder lists in `Dockerfile` and `Dockerfile.worker` (keep those lists identical). Prod-deps is a subset — adding the runtime member there is still manual.

## The recipe

Work in this order. Each step is independently verifiable; do not skip ahead to the admin UI.

### 1. Workspace package

Create `packages/cms-templates` (`package.json` name `@starter/cms-templates`, the Zod schemas, `serializeTemplate` via `z.toJSONSchema()`, `templates: Record<string, TemplateDefinition>` with `access: "public" | "private"`). Depend on `zod` from the catalog — it is already pinned; this is a new workspace package, not a new npm package, so no install confirmation.

Add `"@starter/cms-templates": "workspace:*"` to `packages/api/package.json` (and to `apps/web` if the web registry imports the schemas directly, which it should). Add `COPY packages/cms-templates/package.json packages/cms-templates/` to both Dockerfiles' builder stages and to the server/worker prod-deps lists (API is a runtime consumer). Run `pnpm docker:check-copy`.

### 2. Prisma models

Additive, so an ordinary `pnpm db:push` ([schema-changes-recipe.md](../schema-changes-recipe.md)):

Create `packages/db/prisma/schema/cms.prisma` with `Post`, `PostTranslation`, `Page`, `PageTranslation`, `PreviewToken`, plus the `PostStatus`, `PreviewTargetType`, `TranslationOrigin` enums. Back-relations on `User` (`PostAuthor`, `PageUpdatedBy`) and `Asset` (`PostHeroImage`). `Post.body` and `PostTranslation.body` need the `pg_trgm` GIN indexes (`gin_trgm_ops`) for the `asset:<id>` substring check — `pg_trgm` is already declared on the datasource in `packages/db/prisma/schema/schema.prisma`.

`Post.slug` and `Page.slug` are `@unique` with no cuid default. Soft-delete is `Post.deletedAt`; every read path hides those rows. `PreviewToken.token` stores the hash, not the plaintext.

### 3. Routers

Create `packages/api/src/routers/cms/{pages,posts,assets,index}.ts` and register `cms: cmsRouter` on `appRouter` in `packages/api/src/routers/index.ts`.

- **Pages** — `get({ slug, locale })` public (falls back to source with `translatedFromSourceFallback: true`); `list` / `update` admin. `update` `safeParse`s against the template Zod schema and, for `access: "public"`, rejects non-PUBLIC asset refs.
- **Posts** — public `list` / `get(slug)` / `getByPreviewToken`; admin `listAdmin`, `getAdmin`, `create`, `update`, `publish`, `unpublish`, `delete` / `restore` / `hardDelete`, `createPreviewToken`, translation endpoints. `list` and `listAdmin` take `cursorPageInput`. `create` derives the slug via `uniqueSlug` from `packages/api/src/lib/slug.ts` (already in tree) and maps Prisma P2002 to `CONFLICT`. Restricted-asset checks belong on `publish` (and on `update` / `upsertTranslation` of a `PUBLISHED` row), not on every draft save — see the property list.
- **Assets** — admin Finder search over existing `Asset` rows. Do not invent a second upload path; [assets.md](../assets.md) already owns presign / heartbeat / finalize.

Shared helpers that used to live at `packages/api/src/lib/cms-pages.ts` and `cms-translations.ts` (locale fallback, source-hash, enqueue-per-target-locale) belong next to the routers, not inlined in every handler. Creating those files is not enough: `packages/api/package.json` uses an explicit `exports` map, so add `"./lib/cms-pages"` and `"./lib/cms-translations"` next to `./lib/asset-cleanup`. The `translate-content` worker imports `@starter/api/lib/cms-pages` and `@starter/api/lib/cms-translations`; without the keys, module resolution fails.

### 4. Translate-content job

Follow [queue.md § Adding a new job](../queue.md#adding-a-new-job): schema in `packages/queue/src/jobs.ts`, queue in `packages/queue/src/index.ts`, worker in `apps/worker/src/runtime.ts` + `apps/worker/src/handlers/translate-content.ts`.

The worker is a **second runtime consumer** of `@starter/i18n-translate`. Today only `scripts/translate-locale-bundles.ts` calls that factory — restoring this job changes that. Add `"@starter/i18n-translate": "workspace:*"` to `apps/worker/package.json` (present at `61e82a9^`, absent now). It upserts translation rows asynchronously, skips `HUMAN` rows, and skips `MACHINE` rows whose `sourceHash` still matches. Saves enqueue one job per supported target locale.

Do not put this work on the `analyze-asset` or `chat-run` queues.

### 5. Web registry and public routes

```
apps/web/src/cms/pages/_registry.ts
apps/web/src/cms/pages/useCmsPage.ts
apps/web/src/cms/pages/cms-page-route.tsx   ← ssr: true, loader, head()
apps/web/src/cms/pages/assetRef.ts
apps/web/src/cms/pages/<slug>.tsx           ← one template per file
```

Mount public pages under `apps/web/src/routes/$lang/_public/` via `cmsPageRouteOptions`. Keep the shipped `index.tsx` as the `t()`-driven landing unless the product asks to make `home` a template.

`useCmsPage` is locale-aware (`useTranslation().i18n.language`) and re-runs the schema; a drifted stored row falls back to `defaultContent` rather than crashing.

### 6. Admin UI

- `/admin/content/pages` — auto-generated form from JSON Schema + Zod `.meta()` (`multiline`, `format: "asset"`, `format: "url"`).
- `/admin/content/posts` — layout + `index` + `new` + `$postId` workspace ([auth-and-routing.md § Route sections with index children](../auth-and-routing.md#route-sections-with-index-children)). Markdown editor with a preview pane that rewrites `asset:<id>` to `/api/images/<id>?w=…&format=webp`. Locale tab strip, machine-translated badge, **Re-translate from source** that refuses `HUMAN` rows.

`react-markdown` already ships (chat transcripts). Reuse it; do not add a second markdown library. `autoComplete` is required on every `TextField`; `inputMode` too unless `type` implies the keyboard ([forms.md](../forms.md)).

Add admin nav entries and the `cms-banner` / posts / pages locale keys. New English keys, then `pnpm i18n:translate`. Add `"cms-banner"` (or whatever namespaces you introduce) to `NAMESPACES` in `apps/web/src/i18n/config.ts` and to the namespace list in `AGENTS.md`, then `pnpm sync:agent-docs`.

### 7. Tests, matrix, docs

The deleted implementation's tests are the spec — write the equivalents (`packages/api/src/routers/cms/*.test.ts`, `packages/api/src/lib/cms-translations.test.ts`, `apps/worker/src/handlers/translate-content.test.ts`). Mock `@starter/db` with `mockDeep()`; never hit a real Postgres or Redis ([testing.md](../testing.md)).

Then:

- `sitemap.md` — admin content routes; about (if you restored that template + public route); cookie-policy (if you chose the CMS path). Do **not** add public post list/detail rows unless you also add those routes — the original shipped public oRPC only, no `$lang/_public/posts` pages and no `/posts/preview` UI. If you later add them (`ssr: true`, react-markdown, `asset:<id>` `urlTransform`), then and only then list them in `sitemap.md` and, if they are indexable, `PUBLIC_PATHS`.
- `apps/server/src/seo.ts` `PUBLIC_PATHS` — only the indexable public pages you actually mounted.
- `notes/02-users-and-roles.md` — implemented rows for every live procedure.
- `patterns/admin-dashboard.md` — add the content routes to the admin route map.
- This file — record anything you added that is not described here.

Run `pnpm verify:fast` before handing back. `pnpm policy:access-matrix` catches an unregistered builder or a missing matrix binding; `pnpm docs:check-citations` catches a broken `§` link.

## Optional: MCP tools

If you also restore the admin MCP server ([add-ins/mcp-server.md](./mcp-server.md)), register CMS procedures as tools that delegate to the oRPC router. Scope is enforced at the tool layer (`read` keys must not hit `cms.pages.update` / `cms.posts.publish`). Do not add a second permission model. Untrusted markdown and fetched pages go through `wrapUntrustedContent` ([agent-runtime.md](../agent-runtime.md)).

## Full source — the commits that had it

If your app still carries this template's git history, the complete implementation is recoverable from `61e82a9^`:

- Schema: `packages/db/prisma/schema/cms.prisma` and the `User` / `Asset` back-relations.
- Package: `packages/cms-templates/`.
- API: `packages/api/src/routers/cms/`, `packages/api/src/lib/cms-pages.ts`, `packages/api/src/lib/cms-translations.ts`.
- Worker: `apps/worker/src/handlers/translate-content.ts`.
- Web: `apps/web/src/cms/pages/`, `apps/web/src/components/admin/{locale-tabs,post-*,template-form,translation-status-badge}.tsx`, `apps/web/src/components/markdown-editor.tsx`, `apps/web/src/components/translated-by-banner.tsx`, `apps/web/src/routes/$lang/_app/admin/content/`, `apps/web/src/routes/$lang/_public/{about,cookie-policy}.tsx`.
- Locales: `packages/locales/src/<lang>/cms-banner.json` plus the admin/nav keys. Do not restore `marketing.json` — that namespace was demo-page copy for the deleted `$lang/_app/demo.tsx` route, not pages/posts.
- Docs: the original `patterns/cms.md` (how the shipped system worked) and `patterns/removable/cms.md` (the old rip-out recipe — do not restore it; this add-in replaced it).

Read the removal commit too (`git show 61e82a9`): it says what was load-bearing and why. The current `t()`-driven home and the slim consent banner were the replacements; do not blindly check the whole tree back out.

## Related

- [ssr-for-articles.md](../ssr-for-articles.md) — the `_public` / `_app` SSR split every CMS page has to satisfy.
- [assets.md](../assets.md) — storage behind hero images and `asset:<id>`.
- [i18n.md](../i18n.md) — locale prefix, bundle translation, and why editor-authored content is not a locale key.
- [overlays.md](../overlays.md) — route-based exception for long-form authoring.
- [golden-path.md](../golden-path.md) — the shipped example vertical (Projects). Copy its build order; do not make CMS the example.
- [add-ins/mcp-server.md](./mcp-server.md) — optional tool surface over the same procedures.
- [consent.md](../consent.md) — cookie-policy page, if you want one.
