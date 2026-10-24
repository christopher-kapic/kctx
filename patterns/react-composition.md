# React Composition

Use this when designing component APIs, splitting large route files, or adding a React context/provider. The goal is simple, explicit composition that matches React 19 and this repo's TanStack Router + React Query conventions.

## Component APIs

Prefer explicit variants and named components over boolean prop modes when a component has more than two meaningful states.

```tsx
// Avoid: impossible combinations are easy to represent.
<StatusPanel isPending={isPending} isError={isError} />

// Prefer: every render path is intentional.
type LoadState<T> =
  | { status: "pending" }
  | { status: "error"; retry?: () => void }
  | { status: "ready"; data: T };

<StatusPanel state={state} />
```

Do not apply this mechanically. A boolean is fine when it maps to independent platform behavior (`disabled`, `required`, `checked`) or one clear visual switch. Reach for a discriminated union when boolean combinations create unclear or impossible states.

## Children First

Use `children` composition for static structure instead of render props:

```tsx
function AdminSection({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
```

Use render props only when the child genuinely needs values produced by the parent during render.

## Splitting Route Files

TanStack Router already code-splits route components, so splitting a large route file is primarily about readability and composition, not bundle size.

- Keep route params, authorization-derived context, and top-level queries in the route component.
- Move page regions into non-exported local section components first.
- Do not export component functions from route files; exported route components can rejoin the eager graph. See [performance-and-bundling.md](./performance-and-bundling.md).
- Extract shared admin UI only after a second route needs the same behavior.

Good local section names are concrete: `UsersToolbar`, `UsersTable`, `AssetCleanupPanel`, `PostsEmptyState`. Avoid generic wrappers until duplication proves the abstraction.

## Compound Components

Use compound components when reusable UI has shared internal state and caller-owned structure:

```tsx
<AdminListPage>
  <AdminListPage.Header actions={<CreateButton />}>
    <AdminListPage.Title />
  </AdminListPage.Header>
  <AdminListPage.Toolbar />
  <AdminListPage.Content />
</AdminListPage>
```

Do not convert compact controlled inputs into compound APIs just because they render multiple items. Components like a segmented control are usually clearer with an `items` array unless callers need custom per-item structure.

## Context Shape

When React context acts as a dependency-injection boundary, shape the value as `{ state, actions, meta }`:

```tsx
type AssetPickerContextValue = {
  state: { selectedId: string | null };
  actions: { select: (id: string) => void; clear: () => void };
  meta: { isDirty: boolean };
};
```

This keeps reads predictable and makes providers easier to extend without mixing mutable actions into state. Existing Zustand stores can stay as stores; this rule is for new React context boundaries.

## Data Fetching Composition

Keep independent queries in the same render pass so React Query can run them in parallel. Use `enabled` or `skipToken` only for genuine dependencies. If a list needs per-item details, prefer a batch server procedure over one query per row.

Do not replace the repo's loading/error conventions with Suspense-first data fetching globally. This template intentionally uses `isPending`, layout-matching skeletons, explicit `isError` states, and oRPC query options. See [data-fetching.md](./data-fetching.md) and [loading-and-errors.md](./loading-and-errors.md).

## React 19

For new local code, accept `ref` as a regular prop when that is compatible with the wrapped primitive. Keep existing `forwardRef` wrappers when they are part of a third-party or shadcn-style API surface.

For context reads in React 19 code, `use(SomeContext)` is acceptable and concise. Keep hook order stable exactly as with `useContext`; `use()` still belongs before early returns when it is used as a hook-like context read.
