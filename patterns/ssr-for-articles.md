# SSR for Articles and Public Content

The app is split into two localized pathless route branches:

- `apps/web/src/routes/$lang/_public/**` is SSR-capable and is where public, indexable pages live — the landing page today, plus whatever legal, article, or product pages you add.
- `apps/web/src/routes/$lang/_app/**` sets `ssr: false` and owns the client-only app shell: auth/session sync, PWA update hooks, viewport/keyboard hooks, admin banner, devtools, and authenticated/admin pages.

**What ships today.** `_public` contains exactly one page: `index.tsx`, the landing page, whose copy comes from the `home.*` keys in `packages/locales/src/<lang>/common.json`. There is no content database and no content router in this template — a page that needs editor-authored or database-backed content is a feature you add. The typed CMS add-in ([add-ins/cms.md](./add-ins/cms.md)) is the maintained recipe; this doc is the SSR contract that page has to satisfy either way.

This split is required because TanStack Start's selective SSR setting is inherited downward. A child route can only make inherited SSR more restrictive (`true` → `data-only`/`false`, or `data-only` → `false`). A route under a parent with `ssr: false` cannot turn full SSR back on with `ssr: true`.

## When to use SSR

✅ **Use SSR when:**

- The content is public (no auth required).
- Search engines need to index it (blog posts, landing pages, product pages, docs, legal pages).
- The page has a canonical URL that users will share.
- The content is mostly static or changes infrequently.

❌ **Don't use SSR for:**

- Dashboards, tables, or anything behind `/$lang/_app/_auth` or `/$lang/_app/admin`.
- Anything that depends on browser/session chrome in `beforeLoad` (auth gates belong under `/$lang/_app` with `getRouteSession()`).
- Personalized content.
- Pages with browser-only rendering requirements such as video players, canvas-heavy tools, or device flows.

## How it works in this repo

`apps/web/vite.config.ts` enables `tanstackStart()`, which produces an SSR bundle. In production (`NODE_ENV=production`), `apps/server/src/index.ts` mounts that bundle at `/*` after static asset routes. In dev, the Vite dev server handles the SSR render.

The root route (`apps/web/src/routes/__root.tsx`) and locale route (`apps/web/src/routes/$lang.tsx`) are SSR-capable. They provide the document shell, providers, locale validation, and i18n locale preloading. They must not contain browser-only auth/PWA shell behavior.

Public pages sit under `/$lang/_public`, whose pathless layout renders SSR-safe public chrome. Authenticated/app-only pages sit under `/$lang/_app`, whose pathless layout sets `ssr: false` and renders the full client-only app shell.

## Adding an SSR public page

Put public pages under `apps/web/src/routes/$lang/_public/` so their parent chain remains SSR-capable. The `_public` segment is pathless, so the URL does not include `_public`.

A static page needs no loader — the shipped landing page is just a component reading `t()`. The shape below is for a page whose content comes from the database, using an `articles` router you would add yourself ([server-procedures.md](./server-procedures.md), [schema-guidelines.md](./schema-guidelines.md)):

```tsx
// apps/web/src/routes/$lang/_public/articles/$slug.tsx
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_public/articles/$slug")({
  ssr: true,
  loader: async ({ params, context }) => {
    const article = await context.queryClient.ensureQueryData(
      orpc.articles.get.queryOptions({ input: { slug: params.slug } }),
    );
    if (!article) throw notFound();
    return { article };
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData?.article.title },
      { name: "description", content: loaderData?.article.excerpt },
      { property: "og:title", content: loaderData?.article.title },
      { property: "og:description", content: loaderData?.article.excerpt },
      { property: "og:type", content: "article" },
    ],
  }),
  component: ArticlePage,
});

function ArticlePage() {
  const { slug } = Route.useParams();
  const { data: article } = useQuery(
    orpc.articles.get.queryOptions({ input: { slug } }),
  );
  if (!article) return null;
  return (
    <article>
      <h1>{article.title}</h1>
      <ArticleBody source={article.body} />
    </article>
  );
}
```

Key points:

- Put the file under `/$lang/_public`, not under `/$lang/_app`.
- Use `ssr: true` on public indexable routes for clarity, even though the branch is SSR-capable by default.
- Use `context.queryClient.ensureQueryData(...)` in the loader so React Query has the same data during server render and client hydration.
- Keep loaders public and server-safe. Do not call the browser auth client or browser APIs.
- The lookup is keyed on a `slug`, not an id — see [auth-and-routing § Dynamic segments](./auth-and-routing.md#dynamic-segments--slugs-in-user-facing-urls-ids-in-admin).

### Never render user-authored bodies as raw HTML

The moment a public SSR route renders content somebody typed, that content lands in the initial HTML of every visitor's page — including crawlers, and including visitors who are not signed in and have no session to lose but plenty of cookies to steal. There is no server-side sanitization step in this template, so the renderer *is* the XSS boundary.

`react-markdown` ships (the chat transcript uses it in `apps/web/src/components/chat/message-parts.tsx`) and its default configuration is the safe one: it escapes embedded HTML and runs URLs through `defaultUrlTransform`, stripping `javascript:` and friends. Render markdown bodies with `<Markdown>` and nothing else.

Concretely, on a public SSR route:

- **Do not** use `dangerouslySetInnerHTML`, and do not add a markdown-to-HTML step whose output you inject.
- **Do not** add `rehype-raw` (or `rehype-katex`'s `trust` option, or any plugin that re-enables raw HTML) to the renderer.
- If you genuinely need raw HTML in bodies, add `rehype-sanitize` with an explicit schema **first**, in the same commit.

If you restrict authoring to admins, the blast radius is small — until you add a lower-privilege author role. Whoever adds that role inherits this constraint; write it into the access matrix row when you do.

## Adding a client-only app page

Put browser/auth/admin pages under `apps/web/src/routes/$lang/_app/`. The `_app` segment is pathless, so URLs stay clean:

- `apps/web/src/routes/$lang/_app/login.tsx` → `/$lang/login`
- `apps/web/src/routes/$lang/_app/_auth/dashboard.tsx` → `/$lang/dashboard`
- `apps/web/src/routes/$lang/_app/admin/users.tsx` → `/$lang/admin/users`

Do not add `ssr: true` under `_app`; the parent has `ssr: false`, so a child cannot re-enable SSR there.

## Data-only SSR

Use `ssr: "data-only"` only when the loader should run on the server but the component should not render server-side:

```tsx
export const Route = createFileRoute("/$lang/_public/articles/$slug")({
  ssr: "data-only",
  loader: async ({ params, context }) => {
    return context.queryClient.ensureQueryData(
      orpc.articles.get.queryOptions({ input: { slug: params.slug } }),
    );
  },
  component: ArticlePage,
});
```

This is rarely right for SEO because crawlers need the HTML. Use full `ssr: true` for articles and public content.

## Sitemap and routing

Add public, indexable routes to `sitemap.md`. Also add them to `PUBLIC_PATHS` in `apps/server/src/seo.ts` so `/sitemap.xml` and `/llms.txt` include them for every supported locale.

## Server-side query key considerations

`setupRouterSsrQueryIntegration` (wired up in `apps/web/src/router.tsx`) handles dehydration on the server and hydration on the client. As long as you use `ensureQueryData` with the oRPC `queryOptions()` in the loader, the query keys match on both sides automatically.

## In-memory SSR cache

Public SSR output is a pure function of (pathname, locale-in-path): the public header always renders logged-out, theme is applied client-side, and locale copy is keyed by the locale already in the path. So `apps/server/src/ssr-cache.ts` keeps a small, bounded in-memory LRU (max 200 entries) of the rendered HTML and replays it to the next anonymous visitor.

- **Key**: the full request pathname, locale segment included (e.g. `/en-US/`).
- **Eligibility**: only a `GET` with an empty querystring, no Better-Auth session cookie, and a pathname that is one of `SUPPORTED_LOCALES × PUBLIC_PATHS` (from `apps/server/src/seo.ts`). A public page that is **not** in `PUBLIC_PATHS` is never cached — one more reason to keep `PUBLIC_PATHS` current when you add or remove a public page.
- **TTL**: `SSR_CACHE_TTL_SECONDS` (default **60s**; `0` disables the cache entirely). Invalidation is TTL-only, so a content change can take up to the TTL to appear on the live public URL. (A mutation that changes public content could call the module's `clear()` to drop the cache immediately; that hook is intentionally not wired up, since nothing shipped mutates public content.)
- **Nonce safety**: `secureHeaders` mints a fresh CSP nonce per request, so the cache stores the render-time nonce and swaps it for the current request's nonce on every hit, keeping the cached inline hydration scripts valid under `script-src 'nonce-…'`. Responses carrying `Set-Cookie`, non-`200` responses, and non-HTML responses are never cached.
- **Verification**: eligible responses carry an `X-SSR-Cache: hit | miss` header — `curl -sI https://…/en-US/` twice should flip `miss` → `hit`.

## Anti-patterns

- ❌ **Putting public SEO pages under `_app`.** `_app` has `ssr: false`; descendants cannot override it.
- ❌ **Setting `ssr: false` on root or `/$lang`.** That disables full SSR for every descendant.
- ❌ **Enabling SSR on authenticated routes.** Browser-auth `beforeLoad` checks belong under `_app`.
- ❌ **Duplicating the fetch in `loader` and the component with different keys.** Use `ensureQueryData` in the loader and the same `useQuery` options in the component.
- ❌ **Calling oRPC via raw fetch in the loader.** Use the same `orpc.*.queryOptions()` + `ensureQueryData` so keys match.
- ❌ **Trying to SSR the dashboard.** It's behind auth; there's no SEO benefit. Use skeletons under `_app`.

## Reference

- SSR-capable root/document/providers: `apps/web/src/routes/__root.tsx`
- Locale validation and i18n preload: `apps/web/src/routes/$lang.tsx`
- Per-request server i18n instance (prevents cross-request locale bleed): `createRequestI18n` in `apps/web/src/i18n/index.ts`, wired via `getI18n` in `apps/web/src/router.tsx`
- Pre-hydration locale preload (SSR'd matches don't re-run `beforeLoad` on the client): `apps/web/src/client.tsx`
- Public SSR shell: `apps/web/src/routes/$lang/_public/route.tsx`
- Client-only app shell: `apps/web/src/routes/$lang/_app/route.tsx`
- Vite SSR plugin: `apps/web/vite.config.ts` (`tanstackStart()`)
- SSR query hydration: `apps/web/src/router.tsx` (`setupRouterSsrQueryIntegration`)
- Production SSR mount: `apps/server/src/index.ts`
