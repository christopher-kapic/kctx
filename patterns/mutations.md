# Mutations

Mutations use oRPC's `mutationOptions()` spread into `useMutation`. Cache invalidation uses the `queryKey()` / `key()` helpers off the oRPC utils.

## Canonical pattern

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@starter/ui/components/sileo";
import { useTranslation } from "react-i18next";
import { orpc } from "@/utils/orpc";

function PostForm() {
  const queryClient = useQueryClient();
  const { t } = useTranslation(["posts", "common"]);

  const createPost = useMutation(
    orpc.posts.create.mutationOptions({
      onSuccess: () => {
        // Invalidate the whole `posts` namespace — covers .list, .get, etc.
        queryClient.invalidateQueries({ queryKey: orpc.posts.key() });
        toast.success(t("posts:createSuccess"));
      },
    }),
  );

  return (
    <button
      onClick={() => createPost.mutate({ title: "Hello", body: "World" })}
      disabled={createPost.isPending}
    >
      {createPost.isPending ? t("common:actions.creating") : t("common:actions.create")}
    </button>
  );
}
```

## `useEntityMutation` — the common case, in one call

`apps/web/src/hooks/use-entity-mutation.ts` wraps the pattern above: success toast, invalidate a namespace. Reach for it when a mutation's whole success story is "tell the user it worked, then refresh the list".

```tsx
const remove = useEntityMutation(
  orpc.posts.delete.mutationOptions({
    onSuccess: () => setDeleteId(null),
  }),
  { invalidateKey: orpc.posts.key(), successMessage: t("admin:posts.deletedSuccess") },
);
```

`successMessage` is optional — omit it (autosave, a background preference sync) and you still get the invalidation, with no toast on every keystroke.

The invalidation is **not** awaited. React Query keeps a mutation `pending` until `onSuccess` resolves, so awaiting a refetch of a ten-page infinite list would leave the button stuck on "Deleting…" seconds after the delete landed. Feedback fires first; the refetch catches up. If a call site genuinely needs fresh data before its next step — navigating to a screen that must not show the stale row — `await queryClient.invalidateQueries(...)` in that call site's own `onSuccess`.

Use a plain `useMutation(orpc.x.y.mutationOptions())` instead when any of these is true:

| Situation | Why not `useEntityMutation` |
|---|---|
| Optimistic update (`onMutate` + rollback) | The cache write, not a refetch, is the point — see below |
| You render the mutation's result instead of a list | Nothing to invalidate |
| The call site handles its own errors or an expected non-error branch (`meta: { skipGlobalErrorToast: true }`) | You own the toast *and* any local error state — see [Handling errors](#handling-errors) |
| Success needs something other than one toast (a dialog, a redirect with fresh data, a multi-step flow) | The wrapper's fixed shape gets in the way |

## Invalidation helpers

| Helper | What it matches | Use when |
|---|---|---|
| `orpc.posts.key()` | All queries under the `posts` namespace (`.list`, `.get`, `.search`, …) | A mutation could affect multiple queries in the same router |
| `orpc.posts.list.queryKey()` | All `posts.list` queries regardless of input | A mutation only affects one query shape |
| `orpc.posts.list.queryKey({ input: { authorId } })` | A specific query with a specific input | Surgical invalidation |

**Default to `orpc.foo.key()`** for namespace-wide invalidation unless you have a reason to be surgical. It's almost never wrong.

## ❌ Anti-pattern

```tsx
// Don't wrap .call() manually in a mutationFn.
const m = useMutation({
  mutationFn: async (input) => orpc.posts.create.call(input),
  onSuccess: () => {
    queryClient.invalidateQueries({
      // Don't reach through .queryOptions().queryKey — use .queryKey() / .key().
      queryKey: orpc.posts.list.queryOptions().queryKey,
    });
  },
});
```

This works, but you lose `mutationOptions()`'s type inference and the code is longer. Do this instead:

```tsx
const m = useMutation(
  orpc.posts.create.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.posts.key() });
    },
  }),
);
```

## Handling errors

The router sets up a global `MutationCache.onError` (see `apps/web/src/router.tsx`) that toasts any failed mutation. You **don't need to toast errors yourself** for simple cases.

### The rule

> If your `onError` calls `toast.error(...)` (or otherwise surfaces the failure to the user), you **must** set `meta: { skipGlobalErrorToast: true }`. Otherwise the user sees two toasts for one failure.

The global handler doesn't know what your local `onError` is doing — it always fires unless you opt out. There is no "skip the global if a local handler exists" rule, because the local handler might be orthogonal (a state reset) and not handle the user-visible error at all.

### Pick one path per mutation

**Path A — trust the global toast (simplest).** Don't define `onError`, or define one that doesn't show a toast (e.g. only state cleanup). The global handler shows `friendly(error)` for free.

```tsx
const archive = useMutation(
  orpc.users.archive.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.users.key() });
      toast.success(t("admin:users.userArchived"));
    },
    // No onError → global handler shows friendly(error).
  }),
);
```

**Path B — show your own toast (route-specific copy or inline form error).** Set the meta opt-out and own the user-facing message.

```tsx
const archive = useMutation({
  ...orpc.users.archive.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.users.key() });
      setArchiveId(null);
      toast.success(t("admin:users.userArchived"));
    },
    onError: (err) => {
      // We own the error UX → must suppress the global toast.
      toast.error(friendly(err, t("admin:users.archiveFailed")));
    },
  }),
  meta: { skipGlobalErrorToast: true },
});
```

If the local `onError` would only be `toast.error(friendly(err, t("ns:key")))`, don't write one: `meta: { errorFallbackKey: "ns:key" }` makes the global toast resolve that key and pass it to `friendly()` as the fallback copy (typed next to `skipGlobalErrorToast` in `apps/web/src/router.tsx`).

Inline-form-error variant:

```tsx
const m = useMutation({
  ...orpc.posts.create.mutationOptions(),
  meta: { skipGlobalErrorToast: true },
  onError: (error) => {
    form.setFieldMeta("title", (prev) => ({
      ...prev,
      errors: [error.message],
    }));
  },
});
```

The `meta.skipGlobalErrorToast` flag is typed in `apps/web/src/router.tsx`, in the `declare module "@tanstack/react-query"` block that augments `interface Register` with a `mutationMeta` shape (around lines 135–140).

### Why not auto-detect a local toast?

The global handler runs after the local `onError` and can't introspect what it did, so the opt-out must be declared by the call site. Review heuristic for a `useMutation` block: *"does this `onError` call `toast.error`? If yes, check that `meta.skipGlobalErrorToast: true` is set."*

## Optimistic updates

Use React Query's `onMutate` / `onError` rollback pattern when the UI needs to feel instant:

```tsx
const toggleLike = useMutation(
  orpc.posts.toggleLike.mutationOptions({
    onMutate: async ({ postId }) => {
      await queryClient.cancelQueries({ queryKey: orpc.posts.get.queryKey({ input: { id: postId } }) });
      const previous = queryClient.getQueryData(
        orpc.posts.get.queryKey({ input: { id: postId } }),
      );
      queryClient.setQueryData(
        orpc.posts.get.queryKey({ input: { id: postId } }),
        (old) => old && { ...old, liked: !old.liked },
      );
      return { previous };
    },
    onError: (_err, { postId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          orpc.posts.get.queryKey({ input: { id: postId } }),
          context.previous,
        );
      }
    },
    onSettled: (_data, _err, { postId }) => {
      queryClient.invalidateQueries({
        queryKey: orpc.posts.get.queryKey({ input: { id: postId } }),
      });
    },
  }),
);
```

## When optimistic updates aren't enough (sync engines)

Sometimes "the UI shouldn't wait on the network" tempts a bigger rewrite: a Linear-style sync engine (client as source of truth, transaction log, rollback on reject). **Don't.** That is a data-layer replacement, not a feature, and it inverts this stack's server-as-truth invariant — `requireAuth`/`requireAdmin` gates, asset-URL permission checks, SSR/SEO pages, rate limits, and money-as-integer-cents all assume the server decides first. Steal the UX instead:

- **Optimistic by default on reversible, low-stakes writes** — toggles, reorder, rename, draft text — using the `onMutate` / rollback pattern above. **Never** optimistic-write money, permissions, deletes of shared records, or publish actions.
- **Coalesce noisy writes** (autosave, drag) with debounce or a [Zustand](./zustand.md) outbox, then flush as one oRPC mutation. That is "batch at the server's pace" without a sync engine.
- **Live invalidation only where two people stare at the same data.** Reuse the chat shape from [durable-streaming](./durable-streaming.md) (SSE + Redis pub/sub + Postgres cursor) to push "this query key is stale" — never to replicate the database client-side.

If the product ever genuinely becomes a dense, always-open collaborative workspace, adopt a replica library (Zero, Electric, PowerSync, Replicache-class) as an **island** for that one surface — never hand-rolled, never the app backbone. oRPC + Query keep auth, billing, assets, and public pages. Answer these before changing the recommendation:

- [ ] Getting-started is done and `./notes/` names a collaborative workspace as the product.
- [ ] The working set for a typical session fits in client memory.
- [ ] Instant local writes are a product requirement, not a polish item on a few screens.
- [ ] Two-or-more people concurrently mutating the same records is a normal path, not an edge.
- [ ] Public/SSR, auth, assets, and billing can stay off the replica (island, not backbone).

If most of those are still "no," keep Query + optimistic mutations.

## Reference

- Example mutation: `apps/web/src/routes/$lang/_app/admin/settings.tsx`
- Global mutation error toast: `apps/web/src/router.tsx`
