# Dashboard UI conventions

How create/edit/delete flows, feedback, and shareable state fit together in this repo's stack (shadcn/ui **Base UI** variant + oRPC + TanStack Query). Most heavy lifting already has a dedicated pattern — this file ties them together and documents the pieces that don't live anywhere else yet.

## Already covered — go here

| Concern | Pattern |
|---|---|
| Create → Dialog, Edit → Sheet, Delete → AlertDialog (type-to-confirm + copy), responsive Dialog/Drawer, Base UI `render` trigger | [overlays.md](./overlays.md) |
| Skeletons, inline error/retry, empty states, router-level fallbacks | [loading-and-errors.md](./loading-and-errors.md) |
| `mutationOptions()`, invalidation helpers, **optimistic updates** | [mutations.md](./mutations.md) |
| User-facing error copy (no sensitive leakage) | [error-messages.md](./error-messages.md) |
| Spacing, type, hierarchy, shadows, nested radii, motion, autofill | [design-system.md](./design-system.md) |

This doc only adds: **toast feedback**, **URL-as-state**, and two composition recipes (**list-management card**, **invite-by-email dialog**).

> **Not in this template:** the generic "shadcn dashboard" advice elsewhere recommends `motion` for resize animation and `torph` for animated text. **Neither is a dependency here.** CSS transitions cover resize/label changes; if you genuinely need spring/FLIP animation, follow the package-install workflow in [agent-tooling.md](./agent-tooling.md#installing-a-new-pnpm-package) first — do not write `import { motion } from "motion/react"` and assume it resolves.

## Toasts — the `sileo` wrapper

The toast library is [`sileo`](https://www.npmjs.com/package/sileo) (physics-based), wrapped in `packages/ui/src/components/sileo.tsx` so the app imports a stable, theme-aware API. `<Toaster />` is already mounted once in `apps/web/src/routes/__root.tsx` — **do not add a second one.**

```tsx
import { toast } from "@starter/ui/components/sileo";

toast.success("Saved");
toast.error("Couldn’t save — try again");
toast.info("Heads up");
toast.warning("This can’t be undone");

// With an action button + custom duration:
toast.success("Item deleted", {
  duration: 6000,
  action: { label: "Undo", onClick: () => restore() },
});

toast.dismiss(); // or toast.clear()
```

The wrapper exposes exactly `message | success | error | info | warning` plus `dismiss`/`clear`. **There is no `toast.promise`** — for async flows, await the work and call `toast.success`/`toast.error` yourself (or rely on the global handlers below).

**You usually don't call `toast.error` for query/mutation failures at all.** `apps/web/src/router.tsx` wires global `MutationCache.onError` and `QueryCache.onError` handlers that toast automatically. Opt out per-mutation with `meta: { skipGlobalErrorToast: true }` for inline handling instead. See [loading-and-errors.md](./loading-and-errors.md) and [mutations.md](./mutations.md) for the full rule (pick one error path per mutation).

Reserve manual toasts for **success** confirmations and non-error notices.

## URL as state — `nuqs`

Persist filter / tab / pagination / "which panel is open" state in the URL so refresh, share, and Back/Forward all work. `nuqs` is installed in `apps/web`. **`<NuqsAdapter>` from `nuqs/adapters/tanstack-router` is mounted in `apps/web/src/routes/__root.tsx`** around `<Outlet />` — without that adapter, `useQueryState` throws.

```tsx
import { useQueryState, parseAsInteger, parseAsStringLiteral } from "nuqs";

const [tab, setTab] = useQueryState("tab", { defaultValue: "overview" });
const [page, setPage] = useQueryState("page", parseAsInteger.withDefault(1));
const [status, setStatus] = useQueryState(
  "status",
  parseAsStringLiteral(["all", "DRAFT", "PUBLISHED"]).withDefault("all"),
);
```

Shipped usage: the admin posts status filter (`apps/web/src/routes/$lang/_app/admin/content/posts/index.tsx`).

Rule of thumb: any `useState` the user would expect to survive a refresh or be shareable belongs in the URL instead. (Genuinely ephemeral, non-shareable client state still goes in Zustand — see [zustand.md](./zustand.md).)

## Recipe: list-management card

A card listing items with per-row actions (toggle / remove / edit) — settings pages for shares, API keys, team members, webhooks. Zero-padding card body so dividers run edge-to-edge.

```tsx
<Card>
  <CardHeader className="flex flex-row items-center justify-between">
    <CardTitle>Shares</CardTitle>
    <Button size="sm" onClick={onAdd}>Add</Button>
  </CardHeader>
  <CardContent className="p-0">
    <div className="divide-y">
      {items.map((item) => (
        <div key={item.id} className="flex items-center justify-between px-4 py-3">
          <span className="text-sm">{item.label}</span>
          <div className="flex gap-2">
            <Switch checked={item.active} onCheckedChange={(v) => onToggle(item.id, v)} />
            <Button variant="ghost" size="icon" onClick={() => onRemove(item.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
      {items.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          {/* empty-state copy via i18n — see i18n.md */}
        </div>
      )}
    </div>
  </CardContent>
</Card>
```

For >10 items add a search input in the header or virtualize. Mutations (toggle/remove) follow [mutations.md](./mutations.md) (optimistic update + rollback on error).

## Recipe: invite-by-email dialog

Create-overlay (Dialog) with an email input, inline "not found" error, success toast, and form reset on close. Note the **Base UI `render` prop** on the trigger — this repo uses the Base UI shadcn variant, not Radix `asChild` (see [overlays.md](./overlays.md#overlay-base--base-ui-render-prop)).

```tsx
const [open, setOpen] = useState(false);
const [email, setEmail] = useState("");
const [error, setError] = useState<string | null>(null);

const invite = useMutation({
  ...orpc.shares.invite.mutationOptions(),
  meta: { skipGlobalErrorToast: true }, // we render the error inline instead
  onSuccess: () => {
    setOpen(false);
    setEmail("");
    toast.success("Invitation sent"); // copy via i18n in real code
  },
  onError: (err) => setError(/* map err → user copy, see error-messages.md */),
});

<Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEmail(""); setError(null); } }}>
  <DialogTrigger render={<Button size="sm">Share</Button>} />
  <DialogContent>
    <DialogHeader>
      <DialogTitle>{/* t("...") */}</DialogTitle>
      <DialogDescription>{/* t("...") */}</DialogDescription>
    </DialogHeader>
    <form onSubmit={(e) => { e.preventDefault(); invite.mutate({ email }); }}>
      <Input
        type="email"
        value={email}
        onChange={(e) => { setEmail(e.target.value); setError(null); }}
        inputMode="email"
        autoComplete="email"
        placeholder="user@example.com"
      />
      {error && <p className="text-sm text-destructive mt-1">{error}</p>}
      <DialogFooter className="mt-4">
        <Button type="submit" disabled={!email || invite.isPending}>Share</Button>
      </DialogFooter>
    </form>
  </DialogContent>
</Dialog>
```

Real forms with more than one field should use TanStack Form — see [forms.md](./forms.md). The single-input case above is fine with local state.

## Recipe: reveal-a-secret dialog (CopyField / CodeSnippet)

Any copyable value goes through the shared components — never a hand-rolled
`<pre>` or ad-hoc clipboard button (see
[design-system § Copyable text and code](./design-system.md#copyable-text-and-code)).
Wire toasts at the call site via `onCopied` / `onCopyError`:

```tsx
import { CodeSnippet } from "@starter/ui/components/code-snippet";
import { CopyField } from "@starter/ui/components/copy-field";

<DialogContent>
  {/* single-line value: temp password, shell command, token */}
  <CopyField
    value={revealed.tempPassword}
    copyLabel={t("admin:users.copyTempPasswordAriaLabel")}
    onCopied={() => toast.success(t("admin:users.passwordCopied"))}
    onCopyError={() => toast.error(t("errors:couldNotCopy"))}
  />
  {/* multi-line block: JSON config, env block. preClassName for max-h / wrapping */}
  <CodeSnippet
    code={configJson}
    copyLabel={t("admin:users.copyTempPasswordAriaLabel")}
    preClassName="max-h-72 overflow-y-auto"
    onCopied={() => toast.success(t("admin:users.passwordCopied"))}
    onCopyError={() => toast.error(t("errors:couldNotCopy"))}
  />
</DialogContent>
```

Both are dialog-safe by default (`min-w-0 max-w-full` + self-contained
horizontal scroll). Shipped reference: the temp-password reveal
(`apps/web/src/routes/$lang/_app/admin/users.tsx`).

## Dashboard content rules

- Don't repeat the same KPIs in header + cards + sidebar. Prefer a small chart over a big icon for a metric.
- Collapse secondary row actions into a `DropdownMenu` (triple-dot); keep the primary action visible.
- Sidebar: only navigation that's relevant; don't duplicate a tab that already exists on the page.
- Remove decorative cards that don't do anything.
- `tabular-nums` on numeric columns/KPIs; `text-balance` on headings; `text-decoration-skip-ink: auto` on underlines (all in [design-system.md](./design-system.md)).
- Keep components small — split when a file grows past one clear responsibility.

## Reference

- Toast wrapper: `packages/ui/src/components/sileo.tsx`; `<Toaster />` mounted in `apps/web/src/routes/__root.tsx`
- Global query/mutation error toasts: `apps/web/src/router.tsx`
- Reusable confirm-delete dialog: `apps/web/src/components/confirm-delete-dialog.tsx`
- Inline retry / error-state components: `apps/web/src/components/inline-retry.tsx`, `error-state.tsx`
