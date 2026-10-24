# Admin Dashboard

The starter ships an opinionated admin back office mounted at `/admin`. The whole tree is **404-hidden** — non-admins (and unauthenticated visitors) get the same response as a route that does not exist. There is no `/admin` redirect to `/login` and no "you're not allowed" screen, because either reveals that admin endpoints exist.

Covers: the `/admin` layout and 404-hiding gate, the `adminOr404Procedure` backing every admin-only oRPC call, the navigation list, and the recipe for adding a new admin page.

For the auth/routing model in general (the `_auth` gate, role checks, typed router context), read [auth-and-routing.md](./auth-and-routing.md) first.

## Why 404, not redirect

A `/admin` that redirects to `/login`, or returns a 401/403, leaks structure: a curious visitor learns the app has an admin tree, and probably which sub-routes exist. Returning `notFound()` makes the admin surface invisible. Combined with `adminOr404Procedure` on every oRPC call the admin pages use, neither the route shell nor its data can confirm the tree's existence to a non-admin.

This is defense in depth — the role check is still the actual gate. But it removes one rung an attacker would otherwise climb (enumerating admin endpoints) and keeps logs free of "403 on /admin/x" noise from honest users who clicked the wrong link.

## The layout

`apps/web/src/routes/$lang/_app/admin.tsx`:

```tsx
export const Route = createFileRoute("/$lang/_app/admin")({
  beforeLoad: async () => {
    const decision = decideAdminRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "not-found") throw notFound();
    return { session: decision.session };
  },
  component: AdminLayout,
});
```

Notes:

- `notFound()` from `@tanstack/react-router` renders the router's not-found component (the same one shown for an unknown URL).
- The layout uses the server-backed `getRouteSession()` helper and pure `decideAdminRouteAccess()` decision, so a Better Auth/database outage is a retryable route error rather than a fake 404.
- The route-safe session projection lands in route context so child routes read user fields without a second session call or token-bearing session data.

### Admin route map

Child routes live under `apps/web/src/routes/$lang/_app/admin/`:

| Path | Files | Notes |
|------|-------|-------|
| `/$lang/admin` | `index.tsx` | Overview dashboard |
| `/$lang/admin/settings` | `settings.tsx` | Admin-only settings |
| `/$lang/admin/users` | `users.tsx` | Single-page section |
| `/$lang/admin/jobs` | `jobs.tsx` | Single-page section — BullMQ queue inspector |
| `/$lang/admin/seed` | `seed.tsx` | Single-page section |

That is every admin route the template ships; each is a single flat file. The moment a section grows a **detail or utility child URL** (`things/:thingId`, `things/cleanup`), convert it to a thin layout file that renders `<Outlet />` plus an `index.tsx` for the list page. Putting the list UI directly in the layout file leaves it on screen for every child URL. See [auth-and-routing.md § Route sections with index children](./auth-and-routing.md#route-sections-with-index-children).

## The procedure helper

`packages/api/src/index.ts` exports `adminOr404Procedure`:

```ts
const requireAdminOr404 = o.middleware(async ({ context, next }) => {
  const notFound = () => new ORPCError("NOT_FOUND", { message: "Not found" });
  if (!context.session?.user) throw notFound();
  if (!context.session.user.emailVerified) throw notFound();
  if (!isAdminRole(context.session.user.role)) throw notFound();
  if (!(await isTwoFactorPolicySatisfied(context.session.user))) throw notFound();
  return next({ context: { session: context.session } });
});

export const adminOr404Procedure = publicProcedure.use(requireAdminOr404);
```

Sibling of `adminProcedure`, which throws `UNAUTHORIZED` or `FORBIDDEN` with descriptive messages. The split exists because:

- **`adminProcedure`** is for endpoints whose existence is fine to acknowledge — surfaces invoked by non-admin UI that needs to know "you can't do this." Returns the right status code and error message.
- **`adminOr404Procedure`** is for endpoints backing the 404-hidden `/admin` tree. Every failure mode (no session, unverified email, role list without `admin`, required 2FA not enabled) collapses to a single `NOT_FOUND`. A non-admin probing `/rpc/users/list` cannot tell whether the procedure exists or whether they merely lack the role.

Use `isAdminRole(session.user.role)` rather than `role === "admin"` because Better-Auth may store comma-separated roles.

**Rule of thumb:** if a procedure is only ever called from `/admin/**` UI, use `adminOr404Procedure`. If it is reachable from non-admin UI (e.g. a settings panel where some toggles are admin-only), use `adminProcedure` so the error is debuggable.

TOTP is available to every account, and for admins it is **required by default**: with no `force2faInternalUsers` AppSetting row the gates above demand a second factor, and a new admin account has a 24-hour enrollment grace window (measured from `User.createdAt`) before that starts rejecting them. So walk the owner through enrolling (Settings → Security) inside that window — the admin dashboard nudges them with the deadline until they do. Rules and the shared constants: [production-hardening.md § Forced two-factor authentication](./production-hardening.md#forced-two-factor-authentication).

## Navigation

`AdminNav` in `apps/web/src/routes/$lang/_app/admin.tsx` is a flat list of links — no collapsible sidebar, no drawer. Items live in the `NAV_ITEMS` array. To add a new top-level admin section, append an entry there, then create the matching route file.

Touch targets follow the PWA rule: every link is `min-h-[44px]`. Do not relax this — the same admin runs on a phone.

## Page width (centered vs full-bleed)

Admin pages default to a centered container (`container mx-auto max-w-* px-4`) so forms and prose keep a readable measure. A wide operational grid — a dense table an admin scans across the whole monitor — opts into a **full-bleed page container** on that route only:

```tsx
// Default
<div className="container mx-auto max-w-7xl px-4 py-8">…

// Full-bleed (wide operational grids)
<div className="w-full min-w-0 max-w-none px-4 md:px-6 py-8">…
```

Do not introduce a second admin shell for this. Full recipe, plus the overflow and sticky-chrome rules that make it safe: [design-system.md § Full-bleed admin page container](./design-system.md#full-bleed-admin-page-container). Width and information density are separate axes — going full-bleed does not change type scale or row height.

## Adding a new admin page

Concrete recipe. Pretend you are adding `/admin/audit-log`.

**Single URL, no child routes** — one file is enough (like `users.tsx`, `jobs.tsx`). **List + detail (or list + utility child)** — use the layout + `index` + child pattern from [auth-and-routing.md](./auth-and-routing.md#route-sections-with-index-children) (no admin section ships that shape today; the `_auth/settings/` tree is the closest in-repo reference).

1. **Create the route file.** `apps/web/src/routes/$lang/_app/admin/audit-log.tsx`:

   ```tsx
   import { createFileRoute } from "@tanstack/react-router";
   import { useQuery } from "@tanstack/react-query";
   import { Card, CardContent, CardHeader, CardTitle } from "@starter/ui/components/card";
   import { Skeleton } from "@starter/ui/components/skeleton";
   import { Button } from "@starter/ui/components/button";

   import { orpc } from "@/utils/orpc";

   export const Route = createFileRoute("/$lang/_app/admin/audit-log")({
     component: AdminAuditLog,
   });

   function AdminAuditLog() {
     const list = useQuery(orpc.auditLog.list.queryOptions({ input: { limit: 50 } }));
     return (
       <div className="container mx-auto max-w-3xl px-4 py-8">
         <Card>
           <CardHeader><CardTitle>Audit log</CardTitle></CardHeader>
           <CardContent>
             {list.isPending ? (
               <Skeleton className="h-32 w-full" />
             ) : list.isError ? (
               <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
                 <p className="font-medium text-destructive">{list.error.message}</p>
                 <Button variant="outline" size="sm" className="mt-2" onClick={() => list.refetch()}>
                   Try again
                 </Button>
               </div>
             ) : (
               /* render the rows */ null
             )}
           </CardContent>
         </Card>
       </div>
     );
   }
   ```

2. **Back it with `adminOr404Procedure`.** In `packages/api/src/routers/audit-log.ts`:

   ```ts
   import { adminOr404Procedure } from "../index";
   import { z } from "zod";

   export const auditLogRouter = {
     list: adminOr404Procedure
       .input(z.object({ limit: z.number().min(1).max(200).default(50) }))
       .handler(async ({ input }) => {
         return prisma.auditEntry.findMany({ take: input.limit });
       }),
   };
   ```

   Register it on `appRouter` in `packages/api/src/routers/index.ts`. New procedures show up on the client immediately as `orpc.auditLog.*` — no codegen.

3. **Add a nav entry.** In `apps/web/src/routes/$lang/_app/admin.tsx`:

   ```ts
   { to: "/$lang/admin/audit-log" as const, label: "Audit log", icon: ScrollText, exact: false },
   ```

4. **Update [sitemap.md](../sitemap.md).** Append a row to the **Admin Routes** table. The sitemap is the canonical map of routes; reviewers check it.

5. **Test.** Add `apps/web/src/routes/$lang/_app/admin/audit-log.tsx`'s data flow as a server-side test on the procedure (see [testing.md](./testing.md)). The frontend is intentionally not unit-tested.

## What you should not do

- **Don't put a list page in a layout route file when child URLs exist.** If `/admin/things/:id` is a real route, `things.tsx` must render `<Outlet />` and the list belongs in `things/index.tsx`. Otherwise the list stays mounted for every child URL.
- **Don't redirect non-admins to `/login` from `/admin`.** That leaks the existence of the admin tree. Always `notFound()`.
- **Don't add admin links to navigation visible to non-admins.** `AdminNav` is rendered inside the layout, after the role check passed. Non-admins never see it. Adding an "Admin" item to the public header would defeat the 404 hide.
- **Don't replace `adminOr404Procedure` with `adminProcedure` to "fix" a confusing 404 in dev.** The 404 is the contract. If you need a clearer error in dev, pull the role-failure branch into a Vitest unit test rather than weakening the production response.
- **Don't gate UI inside the page component on `session.user.role`.** The layout already did that. A second check inside the page is dead code that drifts.
