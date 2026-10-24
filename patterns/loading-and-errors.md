# Loading and Error States

Every query on the page has three visual states. Ship all three.

| State | Use |
|---|---|
| Pending (no data yet) | `<Skeleton>` shapes that mirror the final layout |
| Error | Inline "Try again" card occupying the same slot as the content |
| Success | The actual content |

The only spinner that should exist is inside a loading button or the router's `defaultPendingComponent`. Content areas never use spinners.

## Pending state — skeletons

Skeletons should **match the final layout exactly**: same heights, widths, spacing. A skeleton that doesn't mirror causes a layout jump when real content appears.

```tsx
import { Skeleton } from "@starter/ui/components/skeleton";

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />      {/* page title */}
      <Skeleton className="h-5 w-64" />      {/* subtitle */}
      <div className="mt-8 space-y-3">
        <Skeleton className="h-32 w-full rounded-lg" />  {/* card 1 */}
        <Skeleton className="h-32 w-full rounded-lg" />  {/* card 2 */}
      </div>
    </div>
  );
}
```

**Rules:**

- Match real heights (`h-8` for `text-2xl`, `h-5` for `text-sm`, etc.).
- Match `rounded-*` of the real element (cards use `rounded-lg`; inputs use `rounded-md`).
- For lists, render N skeleton rows where N is the typical page size or ~5.
- Consider a show-delay (~150–300ms) so fast responses don't flash a skeleton.

## Error state — QueryBoundary + InlineRetry

Do not teach a local `QueryError`. Use `QueryBoundary` (`apps/web/src/components/query-boundary.tsx`) so pending / error / empty / success cannot be mixed. The error branch is the shared `InlineRetry` (`apps/web/src/components/inline-retry.tsx`). Loading uses the provided skeleton, never a spinner.

```tsx
import { QueryBoundary } from "@/components/query-boundary";
import { SkeletonList } from "@/components/skeleton-list";
import { EmptyState } from "@/components/empty-state";

function Page() {
  const q = useQuery(orpc.posts.list.queryOptions());
  return (
    <QueryBoundary
      query={q}
      skeleton={<SkeletonList count={5} />}
      errorMessage="Failed to load posts."
      isEmpty={(data) => data.length === 0}
      empty={<EmptyState title="No posts yet" description="Create the first one." />}
    >
      {(posts) => <PostsList posts={posts} />}
    </QueryBoundary>
  );
}
```

`QueryBoundary` checks `isPending` first, so it cannot represent `isPending && isError`. Pass a destructured `{ data, isPending, isError, refetch }` or the query object.

**A failed refetch never wipes data that already loaded.** TanStack Query keeps the last successful `data` and flips `status` to `"error"` when a background refetch — or a `fetchNextPage`, or the refetch that follows a mutation's `invalidateQueries` — fails. So `QueryBoundary` branches on the data, not on `isError` alone:

| Situation | What renders |
|---|---|
| `isPending` (nothing loaded yet) | the skeleton |
| Error, `data === undefined` | `InlineRetry` in the content's slot |
| Error, data already loaded | the content, with a small `InlineRetry` (destructive variant) banner above it |
| Success | the content (or `empty`) |

Do not wrap a `skipToken` / `enabled: false` query in it. A disabled query settles as `data === undefined` with neither `isPending` nor `isError`, which is indistinguishable from "loaded nothing" and renders `empty` (or the retry card). Render disabled queries yourself.

Throwing a rendered list away because a background refetch failed costs the user their scroll position and everything they were reading, over a failure that may already have healed — so the content stays and the banner offers the retry.

If you are outside a list and only need the error card, render `InlineRetry` directly:

```tsx
import { InlineRetry } from "@/components/inline-retry";

if (q.isError) {
  return <InlineRetry message="Failed to load posts." onRetry={() => q.refetch()} />;
}
```

**Rules:**

- Never show a blank screen on error.
- Error copy should name what failed ("Failed to load posts"), not the raw exception.
- Don't expose stack traces or status codes in production.
- Don't invent a per-page `QueryError` — `InlineRetry` is the inline retry card.

## Mutation errors — toasts, not inline

When a mutation fails, the user's context is the form they just submitted; a toast gets their attention without redrawing the UI. The router sets up a global `MutationCache.onError` in `apps/web/src/router.tsx` that automatically toasts any mutation error — you don't need to handle it yourself unless you want custom treatment.

To skip the global toast (e.g. you want inline form errors):

```tsx
const m = useMutation({
  ...orpc.foo.create.mutationOptions(),
  meta: { skipGlobalErrorToast: true },
  onError: (err) => {
    // custom inline handling
  },
});
```

## Query errors — `QueryCache.onError` toast AND inline state

The router also wires up a global `QueryCache.onError` toast with a "retry" action. This is a safety net — you should **still** render an inline error state in the component, because the toast is ephemeral and the page would otherwise be blank.

Both coexist: the toast is the "hey this failed" nudge, the inline card is the persistent state.

## Empty states

"No data yet" is a third state, distinct from error. Pass `empty` + `isEmpty` to `QueryBoundary` (see above) rather than a fourth `if` after the query. `EmptyState` (`apps/web/src/components/empty-state.tsx`) is the visual: title, optional description, optional action.

Distinguish "you haven't created any yet" (primary CTA: Create) from "filters produced zero results" (primary action: Clear filters).

## Router-level fallbacks

The router sets these defaults in `apps/web/src/router.tsx`:

- `defaultPendingComponent: () => <Loader />` — shown during route transitions
- `defaultErrorComponent: ErrorState` — shown on uncaught route errors

`Loader` and `ErrorState` are the only spinner/error components at the route-transition level. **Do not reuse `Loader` for in-component loading** — use a skeleton instead.

## Anti-patterns

- ❌ **Spinner for content loading.** Use `<Skeleton>`.
- ❌ **`isLoading` for the initial-load check.** Use `isPending`. (`isLoading` is true during background refetches too and will flash skeletons over stale content.)
- ❌ **Silently ignoring query errors.** If you only handle `isLoading`, an error renders blank.
- ❌ **Replacing loaded content with an error card because `isError` is true.** Check `data === undefined` first; a failed background refetch keeps its data.
- ❌ **Dumping raw error messages to the user.** Translate to user copy.
- ❌ **Skeletons that don't match layout.** Causes a jump.

## Reference

- `QueryBoundary`: `apps/web/src/components/query-boundary.tsx`
- `InlineRetry`: `apps/web/src/components/inline-retry.tsx`
- `EmptyState`: `apps/web/src/components/empty-state.tsx`
- `SkeletonList`: `apps/web/src/components/skeleton-list.tsx`
- `Skeleton`: `packages/ui/src/components/skeleton.tsx`
- `ErrorState` (route-level): `apps/web/src/components/error-state.tsx`
- `Loader` (route-level): `apps/web/src/components/loader.tsx`
- Global cache error handlers: `apps/web/src/router.tsx`
