# Auth and Routing

File-based routes in `apps/web/src/routes/`. Every real route lives under the `$lang/` locale-param layout, so file paths are `apps/web/src/routes/$lang/...` and route IDs start with `/$lang/` (see the locale-routing contract in [i18n.md](./i18n.md)). Beneath `$lang/` the tree splits into two pathless branches: `$lang/_public/` (SSR-capable public/SEO pages) and `$lang/_app/` (the client-only app UI). The authentication gate is a pathless layout route (`$lang/_app/_auth.tsx`) that all protected routes live under.

## Route tree overview

```
apps/web/src/routes/
├── __root.tsx              # router context, <html>, <Outlet/>, global shell
├── index.tsx               # / — bounces a locale-less URL to /<detected-locale>
├── $lang.tsx               # /$lang — locale-param layout: validates :lang, sets i18n
└── $lang/                  # every real route lives here
    ├── _public/            # SSR-capable public/SEO branch (see ssr-for-articles.md)
    │   ├── route.tsx       # public layout shell — static logged-out chrome
    │   └── index.tsx       # /$lang/ — static landing page (the only public page shipped)
    └── _app/               # client-only app branch (ssr: false)
        ├── route.tsx       # app shell — session-aware header, bottom nav, PWA hooks
        ├── login.tsx       # /$lang/login — redirects to /$lang/dashboard if signed in
        ├── signup.tsx      # /$lang/signup
        ├── forgot-password.tsx  # /$lang/forgot-password
        ├── reset-password.tsx   # /$lang/reset-password
        ├── verify-email.tsx # /$lang/verify-email — verification-link landing + resend
        ├── _auth.tsx       # pathless layout — auth gate; adds `session` to context
        ├── _auth/
        │   ├── chat.tsx        # /$lang/chat — durable agentic chat (removable)
        │   ├── dashboard.tsx   # /$lang/dashboard
        │   ├── settings.tsx    # /$lang/settings layout — <Outlet /> only
        │   └── settings/
        │       ├── index.tsx   # /$lang/settings
        │       └── security.tsx # /$lang/settings/security
        ├── admin.tsx       # /$lang/admin layout — admin-or-404 gate
        └── admin/
            ├── index.tsx       # /$lang/admin
            ├── settings.tsx    # /$lang/admin/settings
            ├── users.tsx       # /$lang/admin/users
            ├── jobs.tsx        # /$lang/admin/jobs
            └── seed.tsx        # /$lang/admin/seed
```

That is the whole shipped tree. The template ships one public page (the locale root, the only entry in `PUBLIC_PATHS`); everything else is behind the auth gate or the admin gate. Feature routes are yours to add.

`sitemap.md` is the authoritative route list; the tree above is a structural
map. `patterns/project-audit.md § 3h. Sitemap drift` has a command that diffs the
two when you want to confirm neither has fallen behind.

The `$lang` segment is a required dynamic param: top-level `index.tsx` bounces a locale-less URL to `/$lang/`, and `$lang.tsx` validates the locale and provides i18n context to everything beneath it. The `_` prefix means "pathless" — `_public/`, `_app/`, and `_auth.tsx` add no URL segment; each is a layout wrapper that shares state (like the session) with its children. (`_public` and `_app` are directories whose layout lives in `route.tsx`, as the tree above shows; `_auth` is a single pathless file.) Note the pathless segments **do** appear in route IDs (`createFileRoute("/$lang/_app/_auth/dashboard")`) even though they never appear in the URL (`/$lang/dashboard`).

## Route sections with index children

If a route has child routes, its component must render `<Outlet />`. Do not put a list page directly in the parent route file when detail pages live below it, or the parent list will stay on screen for URLs like `/admin/things/:thingId`.

**The one shipped example:** `apps/web/src/routes/$lang/_app/_auth/settings.tsx` + `settings/index.tsx` + `settings/security.tsx` — a settings sub-nav whose layout file renders the shared heading and tab strip around `<Outlet />`. No other section in the template has child routes yet, so the shape below is the pattern to follow rather than something you can diff against a second instance.

Use a layout route plus an index child:

```text
apps/web/src/routes/$lang/_app/admin/things.tsx            # /$lang/admin/things layout, renders <Outlet />
apps/web/src/routes/$lang/_app/admin/things/index.tsx      # /$lang/admin/things list page
apps/web/src/routes/$lang/_app/admin/things/$thingId.tsx   # /$lang/admin/things/:thingId detail page
```

```tsx
// apps/web/src/routes/$lang/_app/admin/things.tsx
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/$lang/_app/admin/things")({
  component: ThingsLayout,
});

function ThingsLayout() {
  return <Outlet />;
}
```

```tsx
// apps/web/src/routes/$lang/_app/admin/things/index.tsx
export const Route = createFileRoute("/$lang/_app/admin/things/")({
  component: ThingsList,
});
```

The flat dotted filename convention (`things.$thingId.tsx` as a sibling of `things.tsx`) is only for exceptional routes that share a URL prefix but should **not** share layout. Prefer a directory (`things/$thingId.tsx`) once the section has a layout parent — the shipped `settings/` tree follows the directory form.

Nav links and `Link` `to` props can keep using the section root (`/$lang/settings`, `/$lang/admin/things`); TanStack Router resolves those to the index child. Child routes use their full path (`/$lang/settings/security`, `/$lang/admin/things/$thingId`).

Reach for this nested shape — not an overlay — whenever create/edit is long-form authoring. A markdown or rich-text workspace needs a refreshable, bookmarkable URL, and the list page should stay a list rather than owning editor state. See [overlays § Route-Based Exceptions](./overlays.md#route-based-exceptions).

## Dynamic segments — slugs in user-facing URLs, IDs in admin

A dynamic segment (`$postId`, `$slug`) is part of your product's public surface. Pick what goes in it deliberately.

**Public, shareable pages address entities by a human-readable slug.**

```
✅ /$lang/blog/$slug          →  /en-US/blog/how-we-cut-load-times
❌ /$lang/blog/$postId        →  /en-US/blog/clx7f9a2b0000qk3m8h2n4p1x
```

The cuid2 version works, so it survives review by "it works" — but it costs you real things: search engines and link previews get no signal from the URL, users cannot tell what a pasted link points at, the URL cannot be typed or read aloud, and analytics rows become unreadable. None of that shows up as a bug report; it shows up as worse organic traffic and support tickets asking "which one is this link?".

**Admin routes and edit workspaces use the raw `id`.** This is not an inconsistency — a slug is derived from a mutable title, so an admin URL keyed on the slug breaks the moment someone renames the thing. Give the admin detail route a `$thingId` and leave the slug to the public page.

**Unguessable URLs use an opaque `publicId`, never the primary key.** Share links, draft previews, and any resource where a readable slug would leak a private title or invite enumeration. Model side: [schema-guidelines § Slugs and public identifiers](./schema-guidelines.md#slugs-and-public-identifiers).

Building a slug route needs three things:

1. **A `slug String @unique` column** with no `@default(cuid(2))`. When the *server* derives the slug (from a title), populate it with `slugify()` + `uniqueSlug()` from `@starter/api/lib/slug`. Note what actually ships: both helpers exist and are unit-tested (`packages/api/src/lib/slug.test.ts`), but they have **zero production call sites** — no shipped model has a slug. They are the prescribed helpers for a new server-derived slug, not something you can point at a working example of.
2. **A lookup procedure keyed on the slug**, not the id — a `publicProcedure` taking `{ slug, locale }` rather than `{ id }`. On the write side, whether the author supplies the slug or the server derives it, map the `@unique` constraint's Prisma P2002 error to a `CONFLICT`. Keep that mapping even when you use `uniqueSlug()` — the helper reads-then-writes, so it is best-effort, not atomic.
3. **The route param named `$slug`**, and the page registered in `PUBLIC_PATHS` (`apps/server/src/seo.ts`) if it is indexable, plus a line in `sitemap.md`.

> **No shipped slug route.** The template's only public page is the locale root. The three points above are the contract to satisfy when you add the first one; there is no in-repo example to copy.

## Client-only app branch

The root route and `/$lang` route stay SSR-capable so public pages can render full HTML. Browser/auth/app surfaces live under the pathless `/$lang/_app` branch, which sets `ssr: false`. That means:

- The branch remains client-rendered; `beforeLoad` and loaders run during client hydration/navigation.
- Route access checks call the server-backed `getRouteSession()` server function in `apps/web/src/server/auth-session.ts`. That function reads request headers with TanStack Start and calls the canonical Better Auth `auth.api.getSession()` instance.
- App shell hooks, session-aware header/menu, bottom nav, admin setup banner, devtools, and PWA/update hooks live here.

Do not add `ssr: true` under `_app`; descendants cannot re-enable SSR once the parent disabled it.

Public SEO routes belong under `/$lang/_public`; app/auth/admin routes belong under `/$lang/_app`. See [ssr-for-articles.md](./ssr-for-articles.md).

### SSR-safe public chrome with optional client leaves

The `_public` layout's header always renders the logged-out nav (`getNavItems({ placement: "desktop", isAuthenticated: false })` in `apps/web/src/routes/$lang/_public/route.tsx`). That is deliberate: public marketing pages stay fully static — no session fetch, no better-auth client chunk, and the SSR HTML never depends on who is looking at it.

If the product wants public pages to reflect the session (e.g. "Dashboard" instead of "Login" for a signed-in visitor):

1. Keep the anonymous version as the SSR and Suspense fallback.
2. Lazy-load the session-aware control as a client-only leaf (do not import `useAuthSession()`, `UserMenu`, `BottomNav`, or Better Auth client code into static public route modules).
3. Keep anonymous and hydrated variants layout-stable so hydration does not shift the header/footer.

Tradeoffs: the better-auth client chunk may load after first paint and the nav may swap once the session resolves. Crawlers still receive stable anonymous public chrome.

Public SSR shell and client-only app shell remain distinct contracts — do not copy app-frame geometry into public routes or vice versa. See [design-system.md](./design-system.md) for site shell geometry.

## Auth gate

`apps/web/src/routes/$lang/_app/_auth.tsx`:

```tsx
import { createFileRoute, redirect, Outlet } from "@tanstack/react-router";
import { decideProtectedRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

export const Route = createFileRoute("/$lang/_app/_auth")({
  beforeLoad: async ({ params }) => {
    const decision = decideProtectedRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-to-login") {
      throw redirect({ to: "/$lang/login", params: { lang: params.lang } });
    }
    return { session: decision.session };
  },
  component: AuthLayout,
});

function AuthLayout() {
  // session is typed — comes from beforeLoad's return value
  const { session } = Route.useRouteContext();
  return <Outlet />;
}
```

**Key points:**

- Throw `redirect(...)` from `beforeLoad` to short-circuit into another route.
- Session lookup outages throw a route error (retryable via the route error boundary), not a login redirect.
- Return `{ session: decision.session }` — a route-safe projection without token-bearing session fields. TanStack Router types this and propagates it to child routes' `context`. It carries `createdAt` as epoch milliseconds, because the forced-2FA enrollment grace window is measured from it and a `Date` would not survive the `createServerFn` boundary intact.
- `AuthLayout` also enforces the forced-2FA policy: an unenrolled user whose role requires a second factor (admins, **by default**) gets the enrollment flow instead of `<Outlet />` once their 24-hour grace window has closed. Both the defaults and the window come from `@starter/auth/two-factor-policy`, the same module the server gates read — see [production-hardening.md § Forced two-factor authentication](./production-hardening.md#forced-two-factor-authentication). The takeover *is* the enrollment flow, so it never strands the admin it blocks.
- In child routes, access it via `Route.useRouteContext()` or through the `context` argument in their own `beforeLoad`.

## Protected child route

```tsx
export const Route = createFileRoute("/$lang/_app/_auth/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  const { session } = Route.useRouteContext(); // typed: { session, orpc, queryClient }
  return <h1>Welcome, {session.user.name}</h1>;
}
```

No extra `beforeLoad` — the parent's gate is enough.

## Role-gated route

```tsx
export const Route = createFileRoute("/$lang/_app/_auth/some-admin-page")({
  beforeLoad: ({ context, params }) => {
    // context.session is typed because _auth.tsx's beforeLoad contributed it
    if (!hasRole(context.session.user.role, "admin")) {
      throw redirect({ to: "/$lang/settings", params: { lang: params.lang } });
    }
  },
  component: SomeAdminPage,
});
```

**Do not** cast `context as any`. The type flows through from the parent route — if it doesn't, the fix is in the parent, not the child.

## Admin route group (`/admin`)

Pages that should not even *exist* for non-admins live under `apps/web/src/routes/$lang/_app/admin/`. The `admin.tsx` layout checks the role in `beforeLoad` and throws `notFound()` (instead of `redirect()`) when the visitor isn't an admin — so unauthorized callers get the same response as a nonexistent route and can't probe whether `/admin/...` is real.

```tsx
// apps/web/src/routes/$lang/_app/admin.tsx
import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { decideAdminRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

export const Route = createFileRoute("/$lang/_app/admin")({
  beforeLoad: async () => {
    const decision = decideAdminRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "not-found") throw notFound();
    return { session: decision.session };
  },
  component: () => <Outlet />,
});
```

`admin.tsx` is intentionally **not** nested under `_auth.tsx` — both are siblings under the pathless `_app` branch, and `admin.tsx` runs its own server-backed session probe. Confirmed non-admin and anonymous users get `notFound()`; session lookup outages are route errors, not 404s.

This guard checks identity and role, not the forced-2FA policy — the server procedures behind every admin page enforce that, and the layout's `TwoFactorNudge` banner explains the state (grace deadline, or already blocked) rather than bouncing the admin somewhere. Enrollment lives under `_auth`, which is where the blocking takeover happens.

### Admin oRPC procedures

The matching server-side procedure is `adminOr404Procedure` (in `packages/api/src/index.ts`). It mirrors the verified-admin check in `adminProcedure` but throws `NOT_FOUND` for every failure mode (missing session, unverified email, role list without `admin`) — so admin endpoints don't leak their existence either.

Use `hasRole(session.user.role, "admin")` for checks. Better-Auth roles may be comma-separated, so `role === "admin"` is not reliable.

```ts
// packages/api/src/routers/your-admin-router.ts
import { adminOr404Procedure } from "../index";

export const yourAdminRouter = {
  list: adminOr404Procedure.handler(async ({ context }) => {
    // hasRole(context.session.user.role, "admin") is guaranteed here
    return prisma.thing.findMany();
  }),
};
```

Use `adminOr404Procedure` for every procedure that backs an `/admin/*` UI. The original `adminProcedure` (which throws `FORBIDDEN`/`UNAUTHORIZED`) is still exported for cases where the existence of the endpoint isn't sensitive.

## Login page — redirect if already signed in

```tsx
export const Route = createFileRoute("/$lang/_app/login")({
  beforeLoad: async ({ params }) => {
    const decision = decideAnonymousOnlyRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-authenticated") {
      throw redirect({ to: "/$lang/dashboard", params: { lang: params.lang } });
    }
  },
  component: LoginPage,
});
```

## Authoritative client session state

Better Auth is the only reactive client session store. Do not mirror its session data into React Query, React context state, Zustand, browser storage, IndexedDB, or another cookie.

Browser components and hooks consume `useAuthSession()` from `apps/web/src/hooks/use-auth-session.ts`. Do not call `authClient.useSession()` directly. Route files must not call browser `authClient.getSession()`; route access uses `getRouteSession()` plus the pure decisions in `apps/web/src/lib/route-session-access.ts`. Narrow imperative `authClient.getSession()` calls remain allowed for action helpers that must confirm a just-completed Better Auth client flow, such as post-signup routing. Direct `authClient` imports remain valid for sign-in, sign-out, 2FA, password reset, change password, and other auth actions.

The hook returns a discriminated `{ state, actions, meta }` contract:

| `state.status` | Meaning |
|---|---|
| `pending` | Better Auth has not made an initial session decision. |
| `authenticated` | Session data is confirmed. `state.session` remains available during transient or offline degradation. |
| `anonymous` | A successful response or unauthorized response confirmed session loss. |
| `error` | Initial resolution failed before any identity was confirmed. |

Confirmed data has classification precedence over non-401 errors. A transient request failure must not collapse authenticated chrome to signed out; `meta.isDegraded` and `meta.isOffline` describe that continuity state without exposing the raw Better Auth error. `actions.refetch` and `actions.retry` both preserve Better Auth's stable refetch action. The network signal is an SSR-safe `useSyncExternalStore` presentation hint only; `navigator.onLine` does not prove that the API is reachable.

Session revalidation stays inside Better Auth: refetch on focus, never refetch while offline, and no polling. Retained identity is only presentation continuity; every protected operation remains server-authorized.

The policy check rejects every production `.useSession()` call outside `use-auth-session.ts`, including calls made through an aliased client import. This leaves the adapter as the only reactive Better Auth session call site.

## Authenticated change-password settings

Signed-in users with a password-bearing credential account can change their password from `/$lang/settings/security`. The form is gated by `orpc.auth.passwordCapabilities`, which returns only `{ canChangePassword: boolean }` — never account internals or password hashes. Force-SSO deployments and SSO-only accounts do not see the form.

Submit with Better Auth's `authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true })`. Keep the current device signed in; tell the user other devices are signed out. Do not create custom password hashing, custom password mutations, or schema fields for this flow.

## Better-Auth and role field

This starter uses Better-Auth's `admin` plugin, which adds `role` to the user type. Admin bootstrap is controlled by `ADMIN_EMAILS`: an email/password signup whose email appears in that comma-separated allowlist is promoted to `admin` (see `packages/auth/src/index.ts` and the pre-auth guard in `apps/server/src/index.ts`). Everyone else defaults to `role: "user"`; the first user is not promoted automatically.

Other plugins in use:
- `twoFactor` — adds `twoFactorEnabled` to the user type, powers the `/settings/security` flow.
- `genericOAuth` (conditional) — adds SSO when `SSO_ENABLED=true` and the SSO env vars are set. With `SIGNUP_ENABLED=false`, existing SSO users can sign in but SSO just-in-time creation of new user rows is blocked.

## Authenticating server procedures

Server-side, Better-Auth reads the session from the incoming cookie. oRPC procedures receive it via `context.session`:

```ts
// packages/api/src/routers/example.ts
import { protectedProcedure } from "../index";

export const getMyStuff = protectedProcedure.handler(async ({ context }) => {
  // context.session.user is guaranteed non-null by protectedProcedure middleware
  return prisma.stuff.findMany({ where: { userId: context.session.user.id } });
});
```

See [server-procedures.md](./server-procedures.md) for the full procedure definitions.

## Anti-patterns

- ❌ **Casting `context` with `as any`.** If the type isn't flowing, fix the parent's `beforeLoad` return type.
- ❌ **Fetching data in a route `loader` for dashboard content.** Use `useQuery` in the component. Loaders are reserved for SSR (articles).
- ❌ **Duplicating the auth check in every child route.** The parent `_auth.tsx` handles it once.
- ❌ **Calling `authClient.getSession()` from public SSR loaders or route files.** Use `getRouteSession()` + pure access decisions for route guards.
- ❌ **Calling `authClient.useSession()` outside `use-auth-session.ts`.** Use `useAuthSession()`.
- ❌ **Mirroring session data into Zustand / React Query / localStorage.** Better Auth is the only reactive client session store.
- ❌ **Rendering a list page in a parent route file that has child routes.** The parent must be a thin `<Outlet />` layout; the list belongs in `index.tsx`. See [admin-dashboard.md](./admin-dashboard.md) for the full admin route map.
