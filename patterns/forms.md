# Forms

Uses `@tanstack/react-form` v1 with native Zod validation (no adapter package). Submits through an oRPC mutation; cache invalidation happens in `onSuccess`.

**Do not install `@tanstack/zod-form-adapter`.** TanStack Form v1 supports Zod natively — pass the schema directly to `validators`.

**Do not install `react-hook-form` or `@hookform/resolvers`.** The form library decision is made: this template uses TanStack Form, full stop. Reasons:

1. **One paradigm.** Every input wires through `<form.Field>` the same way — native, shadcn, custom. No `register` vs `Controller` split for an agent to get wrong.
2. **Native Zod with full type inference.** `validators: { onChange: schema }` plugs a Zod schema in directly; field names and value types flow from `defaultValues`. RHF + `@hookform/resolvers/zod` needs `useForm<z.input<typeof s>, _, z.output<typeof s>>(...)` generic threading the moment a schema has `.transform()`, `z.coerce`, or `.default()` — exactly the bug an agent will ship without noticing.
3. **Stack cohesion.** TanStack Router + TanStack Query + TanStack Form is one mental model. The i18n Zod error map and the `validation` namespace assume the schema is the source of truth, which lines up with how TanStack Form consumes it.

Tradeoff: TanStack Form is ~11 KB gz vs RHF's ~4 KB, with a smaller ecosystem. In a PWA already shipping TanStack Router + Query, the 7 KB is rounding error and the ecosystem gap is closed by this doc.

## Minimal form

Wire each string field through `TextField` (`@starter/ui/components/text-field`). It owns the `htmlFor`/`id` pairing, `aria-invalid`, `aria-describedby`, and the error message — do not hand-roll that stack.

`autoComplete` is **required by the type** on `TextField` and `TextareaField`, and `inputMode` is required on `TextField` whenever it cannot be inferred, because this ships as a mobile PWA: `inputMode` chooses the software keyboard and `autoComplete` is what makes browser and password-manager autofill work.

`TextField` derives `inputMode` from `type` when the type implies one keyboard — `email`, `url`, `tel`, `search`, `number`, and `password` (which gets the full `"text"` keyboard, never a numeric one). Pass `type` and leave `inputMode` off for those. Everything else, `type="text"` included, must say which keyboard it wants; the compiler asks. The common pairs:

| Field | `type` | `inputMode` | `autoComplete` |
| --- | --- | --- | --- |
| Email | `"email"` | inferred | `"email"` |
| Password (sign in) | `"password"` | inferred | `"current-password"` |
| Password (signup / reset / confirm) | `"password"` | inferred | `"new-password"` |
| Person's name | — | `"text"` | `"name"` |
| Slug | — | `"url"` | `"off"` |
| URL | `"url"` | inferred | `"url"` |
| Search | `"search"` | inferred | `"off"` |
| Number | — | `"numeric"` or `"decimal"` | `"off"` |
| One-time code | — | `"numeric"` | `"one-time-code"` |
| Free text with no autofill meaning | — | `"text"` | `"off"` |

Reach for `autoComplete="off"` only when no real autofill token describes the field — do not blanket every field with it.

`TextField` also prefixes the DOM `id` with a React `useId()`, so two forms rendering the same field name on one page (an invite dialog over a settings page, say) do not collide on `htmlFor` or `aria-describedby`.

```tsx
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@starter/ui/components/button";
import { toast } from "@starter/ui/components/sileo";
import { TextField } from "@starter/ui/components/text-field";
import { z } from "zod";
import { orpc } from "@/utils/orpc";

// Bare validators — inline messages bypass the locale error map
// (apps/web/src/i18n/zod.ts). See AGENTS.md "Content".
const schema = z.object({
  name: z.string().min(1),
  email: z.email(),
});

export function CreateUserForm({ onSuccess }: { onSuccess: () => void }) {
  const queryClient = useQueryClient();

  const createUser = useMutation(
    orpc.users.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.users.key() });
        toast.success("User created");
        onSuccess();
      },
    }),
  );

  const form = useForm({
    defaultValues: { name: "", email: "" },
    validators: { onChange: schema },
    onSubmit: async ({ value }) => {
      await createUser.mutateAsync(value);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      <form.Field name="name">
        {(field) => (
          <TextField field={field} label="Name" inputMode="text" autoComplete="name" />
        )}
      </form.Field>

      <form.Field name="email">
        {(field) => (
          <TextField field={field} label="Email" type="email" autoComplete="email" />
        )}
      </form.Field>

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button type="submit" className="w-full" disabled={!canSubmit || isSubmitting}>
            {isSubmitting ? "Creating..." : "Create user"}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
```

`TextareaField` is the same contract for multi-line fields. Pass a TanStack `field` object; the UI package takes a narrow `{ name, state, handleBlur, handleChange }` shape and does not depend on `@tanstack/react-form`. Extra `<Input>` props (`placeholder`, `maxLength`, a custom `onChange`) forward through. It requires `autoComplete` for the same reason `TextField` does; `inputMode` is optional there and defaults to `"text"`.

### A custom `onChange` runs *in addition to* the field update

Both components always call `field.handleChange(event.target.value)` first, then your `onChange`. So a side-effect handler is safe on its own — it cannot freeze the input:

```tsx
<TextField
  field={field}
  label="Title"
  inputMode="text"
  autoComplete="off"
  // The field is already updated; this only mirrors into another field.
  onChange={(e) => form.setFieldValue("slug", slugify(e.target.value))}
/>
```

Do **not** call `field.handleChange` yourself inside that handler — you would set the same value twice.

```tsx
<form.Field name="excerpt">
  {(field) => <TextareaField field={field} label="Excerpt" autoComplete="off" rows={2} />}
</form.Field>
```

### Escape hatch — raw Label / Input

Use this only when the control is not a text input (Select, Checkbox, a 2FA code field driven by local state, a disabled display value). You still own `htmlFor`/`id`, `aria-invalid`, and `aria-describedby` pointing at the error id:

```tsx
import { Input } from "@starter/ui/components/input";
import { Label } from "@starter/ui/components/label";
import { FieldError } from "@starter/ui/components/text-field";

<form.Field name="name">
  {(field) => {
    const invalid = field.state.meta.errors.length > 0;
    const errorId = `${field.name}-error`;
    return (
      <div className="space-y-2">
        <Label htmlFor={field.name}>Name</Label>
        <Input
          id={field.name}
          name={field.name}
          autoComplete="name"
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(e) => field.handleChange(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
        />
        <FieldError id={errorId} errors={field.state.meta.errors} />
      </div>
    );
  }}
</form.Field>
```

## `validators` — where to put the schema

| Key | When it runs | Use when |
|---|---|---|
| `onChange` | Every keystroke | You want instant feedback as the user types |
| `onBlur` | When a field loses focus | Less noisy; good default for "required" errors |
| `onSubmit` | When the form submits | The form is short and you don't want error noise until submit |

The `login.tsx` signin form uses `onSubmit`; the create form above uses `onChange`. Pick based on how aggressive you want the validation UX.

## Mobile keyboard / autofill attributes

This is a PWA — mobile keyboard matters. Always set `autoComplete`; set `inputMode` unless `type` implies it (see above):

| Field | `type` | `inputMode` | `autoComplete` |
|---|---|---|---|
| Email | `email` | inferred | `email` |
| Password (login) | `password` | inferred | `current-password` |
| Password (signup) | `password` | inferred | `new-password` |
| One-time code | `text` | `numeric` | `one-time-code` |
| Phone | `tel` | inferred | `tel` |
| Name | `text` | `text` | `name` |
| URL | `url` | inferred | `url` |
| Numeric (not a count) | `text` | `decimal` | — |
| Search | `search` | inferred | — |

"inferred" applies to `TextField`. A raw `<Input>` has no such inference — set `inputMode` yourself there when it matters.

## Autosuggest fields

For picker-style inputs backed by server search (e.g. assignee), use the `AsyncCombobox` pattern — see [autosuggest.md](./autosuggest.md). The form stores the ID; the combobox displays the name.

## Select fields

A field-bound select uses `SelectField` from `@starter/ui/components/text-field` — the select counterpart to `TextField`, owning the id/label/aria/error wiring (the `htmlFor={field.name}` policy rule rejects hand-rolled copies):

```tsx
<form.Field name="role">
  {(field) => (
    <SelectField field={field} label={t("admin:users.roleLabel")}>
      <SelectItem value="user">{t("admin:users.roleUser")}</SelectItem>
      <SelectItem value="admin">{t("admin:users.roleAdmin")}</SelectItem>
    </SelectField>
  )}
</form.Field>
```

The trigger keeps its 44px mobile touch target and defaults to full width (`triggerClassName` overrides). `placeholder` (optional) shows while no option is chosen — pair it with an empty-string `<SelectItem>` if "no choice" is a real state. For options backed by server search, prefer `AsyncCombobox` over a long `SelectItem` list.

## Edit forms — reset via `key={id}`

When switching which record is being edited, **do not** `useEffect` to reset form state — force a remount:

```tsx
{selectedItem && (
  <EditForm key={selectedItem.id} item={selectedItem} onClose={handleClose} />
)}
```

Changing `key` tears down the old form and mounts a fresh one — the cleanest possible reset.

## Field arrays

```tsx
<form.Field name="tags" mode="array">
  {(field) => (
    <>
      {field.state.value.map((_, index) => (
        <form.Field key={index} name={`tags[${index}]`}>
          {(sub) => (
            <Input
              value={sub.state.value}
              onChange={(e) => sub.handleChange(e.target.value)}
            />
          )}
        </form.Field>
      ))}
      <Button type="button" onClick={() => field.pushValue("")}>
        Add tag
      </Button>
    </>
  )}
</form.Field>
```

## Anti-patterns

- ❌ **Don't install `@tanstack/zod-form-adapter`, `react-hook-form`, or `@hookform/resolvers`.** v1 has native Zod support; the library choice is settled (see top of this doc).
- ❌ **Don't put validation in two places.** Let Zod do shape validation; backend validates again at the procedure boundary.
- ❌ **Don't forget `e.preventDefault()` (and `e.stopPropagation()`) on the `<form onSubmit>` handler.** TanStack Form does *not* call them for you — if you omit them, the browser submits the form via GET and reloads the page. Every form in this repo follows the pattern shown above: `e.preventDefault(); e.stopPropagation(); form.handleSubmit();`.
- ❌ **Don't read from `form.useStore` (or `<form.Subscribe>`) without a `selector`.** Omitting the selector subscribes to *every* state change, which re-renders the consumer on every keystroke. Always narrow: `selector={(s) => ({ canSubmit: s.canSubmit, isSubmitting: s.isSubmitting })}`.
- ❌ **Don't call `field.handleChange` inside a `TextField` / `TextareaField` `onChange`.** The component already did it; yours is the extra side effect, not the replacement.
- ❌ **Don't call `field.handleChange` with raw DOM events.** Pass `e.target.value` for text, `e.target.checked` for checkboxes. For numeric inputs use `e.target.valueAsNumber` (or `Number(e.target.value)`) — `<input type="number">` still gives you a string, and shoving a string into a `number` field will pass Zod silently in some cases and fail loudly in others.
- ❌ **Don't use `useEffect` to sync form state with props.** Use `key={id}` to remount.
- ❌ **Don't hand-roll mutation wrappers.** Spread `mutationOptions()` into `useMutation` — see [mutations.md](./mutations.md).
- ❌ **Don't submit when disabled; don't bypass `form.handleSubmit()`.** The submit button must call `form.handleSubmit()` via the `<form onSubmit>` handler, and be gated on `canSubmit && !isSubmitting`.

## Reference

- Example forms (login, signup): `apps/web/src/routes/$lang/_app/login.tsx`
- TanStack Form v1 Zod support: schema passes directly to `validators`, no adapter.
