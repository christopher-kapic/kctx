# Autosuggest / Combobox

Use `AsyncCombobox` from `@starter/ui/components/async-combobox` for any field where the user picks an entity from a server-driven list — tagging, assignee pickers, linked records, address lookups, etc.

## The rule

> **IDs travel, names display.** Store the entity **ID** in form state (it's what mutations need). Render the human-readable **name** in the UI.

Mutations receive `{ authorId: "clx123..." }`, never `{ authorName: "Jane Doe" }`. The autocomplete is the layer that maps name → ID.

## The other rule

> **Do NOT use React Query for suggestions.** Call the oRPC procedure directly (`orpc.foo.bar.call(...)`) with an `AbortController`. React Query's caching semantics don't fit "cancel the previous fetch on every keystroke".

`AsyncCombobox` handles debounce, cancellation, and cleanup for you — you just provide the `onSearch` function.

## Edit flow — seeding the initial value

When editing an existing record you have the **ID** (`record.assigneeId`) but not the full `{ id, name, email }` the trigger needs to display a name. You must hydrate `value` with a real label, not a placeholder. There are two correct ways and one trap.

### Preferred path — include the related entity in the record query

Fetch the related row alongside the record so you have its name without an extra round trip, then seed component state with it:

```tsx
// server: include the relation
const task = await prisma.task.findUnique({
  where: { id },
  include: { assignee: { select: { id: true, name: true, email: true } } },
});

// client: seed state from the included entity
const [assignee, setAssignee] = useState<UserOption | null>(task.assignee);
```

### One-shot fetch — hydrate the label when you only have the ID

If the record query can't include the relation, run a single `orpc.<router>.get.call({ id })` to hydrate the full shape. Because there are no hooks involved beyond `useQuery`, gate it with the ID and map the response into state:

```tsx
import { useQuery } from "@tanstack/react-query";
import { skipToken } from "@tanstack/react-query";

function EditAssignee({ assigneeId }: { assigneeId: string | null }) {
  const [assignee, setAssignee] = useState<UserOption | null>(null);

  // Hydrate the picker label once from the ID. `key={assigneeId}` on the
  // surrounding form remounts on a different record — no reset-on-prop effect.
  const seed = useQuery(
    orpc.users.get.queryOptions({
      input: assigneeId ? { id: assigneeId } : skipToken,
    }),
  );

  return (
    <AsyncCombobox<UserOption>
      value={assignee ?? seed.data ?? null}
      onSelect={setAssignee}
      onSearch={(q, signal) => orpc.users.search.call({ query: q, limit: 10 }, { signal })}
      getKey={(u) => u.id}
      getLabel={(u) => u.name}
      renderItem={(u) => <span>{u.name}</span>}
    />
  );
}
```

### ❌ Anti-pattern — hydrating `value` with an ID placeholder

Do **not** reach for an `{ id, name: id }` placeholder when you only have the ID. It type-checks, but `getKey(value) === getLabel(value)`, so the trigger renders the raw ID (`ghk2v9t7eca3rp1oel8o0j2b`) instead of a name:

```tsx
// ❌ BROKEN — the trigger will display the ID, not a human-readable name.
<AsyncCombobox<UserOption>
  value={{ id: record.assigneeId, name: record.assigneeId }}
  getKey={(u) => u.id}
  getLabel={(u) => u.name} // getLabel(value) === getKey(value) === the id
  // ...
/>
```

`AsyncCombobox` ships a dev-mode `console.warn` that fires exactly when `getKey(value) === getLabel(value)` — it's the safety net that catches this. Hydrate with a real label (one of the two paths above) instead.

## Minimal example

```tsx
import { AsyncCombobox } from "@starter/ui/components/async-combobox";
import { orpc } from "@/utils/orpc";

type UserOption = { id: string; name: string; email: string };

function AssigneePicker({
  value,
  onChange,
}: {
  value: UserOption | null;
  onChange: (user: UserOption | null) => void;
}) {
  return (
    <AsyncCombobox<UserOption>
      value={value}
      onSelect={onChange}
      onSearch={(query, signal) =>
        orpc.users.search.call({ query, limit: 10 }, { signal })
      }
      getKey={(u) => u.id}
      getLabel={(u) => u.name}
      renderItem={(u) => (
        <div>
          <div className="font-medium">{u.name}</div>
          <div className="text-xs text-muted-foreground">{u.email}</div>
        </div>
      )}
      placeholder="Select assignee…"
      searchPlaceholder="Search users…"
    />
  );
}
```

**Key points:**

- `onSearch: (query, signal) => Promise<T[]>` — oRPC's `.call()` accepts a second arg `{ signal }` that threads the `AbortSignal` through to the server. Pass it through.
- `getKey` returns the ID (the thing you'll submit).
- `getLabel` returns what the trigger button shows when an item is selected.
- `renderItem` controls how items render inside the dropdown — can be richer than just the label (avatar, secondary text, etc.).

## Form integration — store ID, pass ID

Using TanStack Form: keep the full `UserOption` in component state so you can display the name, but `field.handleChange` receives just the ID so the form value is what the mutation expects.

```tsx
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@starter/ui/components/button";
import { Label } from "@starter/ui/components/label";
import { AsyncCombobox } from "@starter/ui/components/async-combobox";
import { orpc } from "@/utils/orpc";

type UserOption = { id: string; name: string; email: string };

function AssignTaskForm({ taskId }: { taskId: string }) {
  const [assignee, setAssignee] = useState<UserOption | null>(null);

  const assignTask = useMutation(orpc.tasks.assign.mutationOptions());

  const form = useForm({
    defaultValues: { assigneeId: "" },
    validators: {
      onSubmit: z.object({ assigneeId: z.string().min(1) }),
    },
    onSubmit: async ({ value }) => {
      await assignTask.mutateAsync({ taskId, assigneeId: value.assigneeId });
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      <form.Field name="assigneeId">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>Assignee</Label>
            <AsyncCombobox<UserOption>
              value={assignee}
              onSelect={(user) => {
                setAssignee(user);
                field.handleChange(user?.id ?? "");
              }}
              onSearch={(query, signal) =>
                orpc.users.search.call({ query, limit: 10 }, { signal })
              }
              getKey={(u) => u.id}
              getLabel={(u) => u.name}
              renderItem={(u) => (
                <div>
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                </div>
              )}
              placeholder="Select assignee…"
            />
            {field.state.meta.errors.map((err) => (
              <p key={err?.message} className="text-sm text-destructive">
                {err?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>

      <Button type="submit" disabled={form.state.isSubmitting}>
        Assign
      </Button>
    </form>
  );
}
```

## Multi-select

For picking **several** entities (tags, assignees, a list of states) use `MultiAsyncCombobox` from `@starter/ui/components/multi-async-combobox`. It shares the same search loop as `AsyncCombobox` (`useAsyncSearch` / `useDebounce` from `@starter/ui/hooks/use-async-search`) and the same "IDs travel, names display" rule — selected items render as removable chips, each labelled via `getLabel(item)`.

### The state contract

> **Component state holds `T[]` (full objects); form state holds `string[]` (ids).**

`MultiAsyncCombobox`'s `value` prop is typed `T[]`, **not** `string[]`. This is load-bearing: it makes the classic bug — storing ids and rendering them as chip labels — a type error rather than a runtime surprise. Chips are always derived with `getLabel(T)`, so they can only show names. Keep the full objects in a `useState`; map them down to `string[]` of ids when you hand the value to form state.

Selecting an item toggles it into/out of `value` and the popover **stays open** (selected items show a checkmark). It closes only on click-outside or Esc. Each chip's X button calls `onChange` with that item filtered out.

### Form integration — `T[]` in state, `string[]` in the form

```tsx
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@starter/ui/components/button";
import { Label } from "@starter/ui/components/label";
import { MultiAsyncCombobox } from "@starter/ui/components/multi-async-combobox";
import { orpc } from "@/utils/orpc";

type TagOption = { id: string; name: string };

function TagTaskForm({ taskId }: { taskId: string }) {
  // Full objects live here so chips can show names.
  const [tags, setTags] = useState<TagOption[]>([]);

  const tagTask = useMutation(orpc.tasks.setTags.mutationOptions());

  const form = useForm({
    defaultValues: { tagIds: [] as string[] },
    validators: {
      onSubmit: z.object({ tagIds: z.array(z.string()).min(1) }),
    },
    onSubmit: async ({ value }) => {
      await tagTask.mutateAsync({ taskId, tagIds: value.tagIds });
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      <form.Field name="tagIds">
        {(field) => (
          <div className="space-y-2">
            <Label>Tags</Label>
            <MultiAsyncCombobox<TagOption>
              value={tags}
              onChange={(items) => {
                setTags(items); // T[] in component state
                field.handleChange(items.map((i) => i.id)); // string[] in form state
              }}
              onSearch={(query, signal) =>
                orpc.tags.search.call({ query, limit: 10 }, { signal })
              }
              getKey={(t) => t.id}
              getLabel={(t) => t.name}
              renderItem={(t) => <span>{t.name}</span>}
              placeholder="Select tags…"
              searchPlaceholder="Search tags…"
            />
            {field.state.meta.errors.map((err) => (
              <p key={err?.message} className="text-sm text-destructive">
                {err?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>

      <Button type="submit" disabled={form.state.isSubmitting}>
        Save tags
      </Button>
    </form>
  );
}
```

### Edit flow — seed `T[]` from a Prisma `include`

Seeding the initial selection is the **consumer's** responsibility (there's no hydration machinery in the component). The cheapest path is the same as the single picker: `include` the relation when you load the record, so you already have the full objects — no second round trip.

```ts
// server: include the related rows
const task = await prisma.task.findUnique({
  where: { id },
  include: { tags: { select: { id: true, name: true } } },
});
```

```tsx
// client: seed component state with the full T[] (key the form by task.id so a
// different record remounts — no reset-on-prop effect)
const [tags, setTags] = useState<TagOption[]>(task.tags);
```

Just like the single picker, `MultiAsyncCombobox` ships a dev-mode `console.warn` that fires when **any** item in `value` satisfies `getKey(item) === getLabel(item)` — your safety net against seeding id placeholders.

### Multi-select anti-patterns

- ❌ **Storing `string[]` of IDs in component state and rendering chips from that array** — the chips will display IDs, not names. Use `MultiAsyncCombobox`, which makes this impossible: its `value` is `T[]` and chips are always `getLabel(item)`.
- ❌ **Closing the popover after each selection.** Multi-select stays open so the user can pick several without reopening.

## Server side

The autocomplete procedure should be a simple, narrow public/protected query returning only what the dropdown needs (id, label, maybe a secondary). Keep page size small (10–20). Propagate the `signal` into downstream IO if your DB client supports it.

```ts
// packages/api/src/routers/users.ts
import { z } from "zod";
import { protectedProcedure } from "../index";

export const usersRouter = {
  search: protectedProcedure
    .input(z.object({ query: z.string(), limit: z.number().max(50).default(10) }))
    .handler(async ({ input, signal }) => {
      // signal is an AbortSignal — forwarded from the client's AbortController.
      const users = await prisma.user.findMany({
        where: { name: { contains: input.query, mode: "insensitive" } },
        take: input.limit,
        select: { id: true, name: true, email: true },
      });
      return users;
    }),
};
```

## Anti-patterns

- ❌ **Using `useQuery` for suggestions.** Wrong tool — you don't want caching, you want cancellation.
- ❌ **Storing the full entity in form state and submitting it.** Store just the ID.
- ❌ **Filtering client-side with cmdk.** `AsyncCombobox` sets `shouldFilter={false}`; the server does the filtering. Don't change this.
- ❌ **Making an autocomplete that returns 200 results.** Cap at 10–20 — it's a picker, not a list page.

## Reference

- Component: `packages/ui/src/components/async-combobox.tsx`
- Debounce default: 300ms
