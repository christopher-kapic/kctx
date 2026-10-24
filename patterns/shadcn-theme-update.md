# Changing the shadcn theme

How to take a theme you designed in the shadcn theme editor (or any `registry:theme` preset) and apply it to this repo — and, separately, how to switch the underlying component primitives between the **Base UI** and **Radix UI** variants of shadcn.

This is a sibling of [removable/rebrand.md](./removable/rebrand.md). **Rebrand** changes the app's *name, icons, and PWA manifest colors*; **this doc** changes the *color palette and design tokens* the whole UI renders with. They overlap on exactly one value — the PWA `theme_color` hex — which lives in a few non-CSS places and is not driven by the theme tokens (see [§ Don't forget the PWA chrome color](#dont-forget-the-pwa-chrome-color)).

All theme tokens live in one file: **`packages/ui/src/styles/globals.css`**. There is no `tailwind.config` color block and no second source of truth.

---

## TL;DR — pick the operation, not just the command

Changing the look splits into two very different operations. Match the tool to the one you mean:

| You want to change… | Operation | Tool |
|---|---|---|
| **colors, radius, font** (an at-will theme swap) | safe, repeatable | **`pnpm theme:apply <code>`** ([§ Fast path](#the-fast-path-pnpm-themeapply)) |
| **component style** (`lyra`→`mira`), **icon library**, alongside colors | one-time **re-skin**, regenerates components | the agent loop in [§ Re-skinning](#re-skinning-style--icons--font--colors-all-at-once-an-agent-pattern) |

**Fast path (at will):**

```bash
pnpm theme:apply <code>      # <code> from the shadcn editor's "Copy Preset" button
```

It runs `shadcn apply --only theme,font`, restores `components.json` (a theme swap must not change component config), and type-checks. It **does not touch any component file**, so the custom `--state-*`/`--grey-*`/`--primary-*` tokens and the `touch`/`icon-touch` sizes all survive. Run it as often as you like.

> 🛑 **Never run a bare `shadcn apply --preset <code>` (no `--only`) in this repo.** It regenerates every UI component and **breaks the build** — it drops the custom `touch`/`icon-touch` button sizes (44px PWA targets), strips `overscroll-contain` from overlays, and adds an orphan `apps/web/src/lib/utils.ts`. The only sanctioned full apply is `pnpm theme:reskin <code>`, which refuses on a dirty tree, dry-runs the blast radius so an agent can stop and ask, and runs the recovery checklist afterward. Use it only for a deliberate [re-skin](#re-skinning-style--icons--font--colors-all-at-once-an-agent-pattern) — never as a quick theme change.

**Manual path (most control):** paste values by hand — best when you want to tune the custom tokens at the same time.

1. Design your theme in the editor, click **Copy Code**, and choose the **OKLCH** tab (this repo is Tailwind v4 + OKLCH — not HSL).
2. Paste the values over the matching variables in the `:root` and `.dark` blocks of `globals.css`. **Map only the tokens that already exist** — this repo's theme is a superset of stock shadcn.
3. **Regenerate the custom ramps** (`--grey-*`, `--primary-*`) and the hue-linked tokens (`--ring`, `--sidebar-primary`, `--input`) so they match the new `--primary` hue — the editor does not produce these.
4. Leave the `@theme inline` block alone unless you added a *new* token name.
5. Update the PWA `theme_color` in the non-CSS spots ([§ PWA chrome color](#dont-forget-the-pwa-chrome-color)).
6. Rebuild and eyeball both light and dark mode.

---

## The fast path: `pnpm theme:apply`

For an at-will color/font swap, use the wrapper script — it encodes the safe recipe so neither you nor an agent can pick the build-breaking path:

```bash
pnpm theme:apply <code>      # e.g. pnpm theme:apply b2CPjyJD0
```

Get `<code>` from the shadcn editor's **Copy Preset** button. `pnpm dlx shadcn@latest preset decode <code>` shows what's inside it first (and warns you if its `style`/`iconLibrary`/heading-font differ from this repo — those are *not* applied by this path; see [Re-skinning](#re-skinning-style--icons--font--colors-all-at-once-an-agent-pattern)).

What the script does (`scripts/theme-apply.ts`), verified against this repo:

- Runs `shadcn apply --preset <code> --only theme,font` — updates the stock tokens in `globals.css` (`--background`, `--primary`, `--radius`, `--chart-*`, `--sidebar-*`, …) and the `--font-sans` + `@import`, in both `:root` and `.dark`.
- **Preserves** every token the registry doesn't know about — `--state-*`, the `--grey-50…900` / `--primary-50…900` ramps, `--duration-*`, `--ease-*`. The CLI merges by key; it does not rewrite the block.
- **Snapshots and restores both `components.json`** — `--only theme,font` otherwise rewrites `style`/`baseColor`/`menu*` to the preset's, which would silently switch your component variant away from `base-lyra`. A theme swap must not change component config, so the script reverts it verbatim.
- **Touches no component file**, then runs `pnpm check-types` as a safety gate.

It then prints the follow-ups it deliberately does **not** automate:

1. **Regenerate the `--primary-*` / `--grey-*` ramps** — the CLI updates `--primary` but not the numeric ramp, so the ramp still carries the old hue ([§ Regenerating the ramps](#regenerating-the---primary--and---grey--ramps)).
2. **Update the PWA hex** in `apps/web/vite.config.ts` + the runtime theme-color pair (`packages/config/src/theme-init.ts`, `apps/web/src/hooks/use-theme-color-meta.ts`) ([§ PWA chrome color](#dont-forget-the-pwa-chrome-color)).
3. **Font cleanup:** the new font is pinned in `packages/ui/package.json` (move it to the pnpm catalog like `@fontsource-variable/roboto`), and the previous font's `@import` may linger in `globals.css` — drop it if unused.

### A single prompt you can hand an agent

> Change the app theme to the shadcn preset `<code>`: run `pnpm theme:apply <code>`, then handle the three follow-ups it prints — regenerate the `--primary-*`/`--grey-*` ramps in `packages/ui/src/styles/globals.css` to the new `--primary` hue (keep the existing lightness/chroma curve; leave `--state-*`/motion/`@theme inline` alone), update the PWA `theme_color` hex in `apps/web/vite.config.ts` and the runtime theme-color pair in `packages/config/src/theme-init.ts` + `apps/web/src/hooks/use-theme-color-meta.ts` (keep the two in lockstep), and move any newly-added font dep into the pnpm catalog. Confirm `pnpm check-types` and `pnpm --filter web build` pass; report the changed files.

---

## What the shadcn editor actually exports

The theme editor (and the "Share"/"Copy Preset" buttons) can hand you the theme in four forms. Only the first two are CSS you can paste:

| Form | How you get it | Contents |
|---|---|---|
| **CSS-variables block** | **Copy Code** → OKLCH tab | `:root { --background: …; … } .dark { … }` — the real values. **Use this.** |
| **registry-item JSON** | `npx shadcn add <name-or-url>` | `{"type":"registry:theme","cssVars":{"light":{…},"dark":{…}}}` — the real values, keyed without the `--` prefix |
| **Shareable URL** | **Share** button | `…/create?preset=<base62>&item=<name>` |
| **Preset code** | **Copy Preset** → `--preset <base62>` | a CLI flag for `init`/`apply` |

### The "preset hash" is not CSS — and can't be decoded into CSS directly

The `--preset <base62>` code (and the `preset=` token in a share URL) encodes your *design-system choices* — base color, theme, chart palette, font, radius — in ~51 bits. It is **not** an encoding of the `oklch(...)` strings.

`npx shadcn preset decode <code>` exists, but it only prints those choices back (`style`, `baseColor`, `theme`, …) — **not** the CSS variable values. There is no command that turns a preset hash straight into a `:root {}` block.

`npx shadcn preset decode <code>` prints those choices, which is useful for a sanity check — e.g. confirming the preset's `style` and that its `font`/`iconLibrary` don't silently diverge from this repo's (Roboto + lucide):

```bash
pnpm dlx shadcn@latest preset decode <code>
# → style, baseColor, theme, chartColor, iconLibrary, font, radius, …
```

To get the actual CSS values, do one of:

- **Let `apply --only theme` write them for you** — the [fast path](#the-fast-path-pnpm-themeapply) above. This is the normal route.
- **Open the share URL in a browser**, then click **Copy Code → OKLCH** — when you want to read/edit values before pasting (the manual path).

---

## This repo's theme is a superset of stock shadcn

The editor only knows the **stock** shadcn tokens. Map those 1:1:

```
background  foreground  card  card-foreground  popover  popover-foreground
primary  primary-foreground  secondary  secondary-foreground
muted  muted-foreground  accent  accent-foreground  destructive
border  input  ring  radius
chart-1 … chart-5
sidebar  sidebar-foreground  sidebar-primary  sidebar-primary-foreground
sidebar-accent  sidebar-accent-foreground  sidebar-border  sidebar-ring
```

Everything else in `globals.css` is **custom to this template and the editor will not emit it**. Do not delete these, and expect to hand-tune them:

| Token group | What it is | What to do when the theme changes |
|---|---|---|
| `--state-success / -warning / -info / -action / -loading` (+ `-foreground`, `-bg`) | semantic status colors used by toasts, badges, alerts | Usually keep success=green / warning=amber / info=blue. Only retune if your new palette clashes. `-action`/`-loading` already alias `--accent`/`--muted-foreground`, so they follow automatically. |
| `--grey-50 … --grey-900` | a neutral ramp for app authors | Regenerate to match your new neutral hue (see below). |
| `--primary-50 … --primary-900` | a tint/shade ramp of your brand color | **Regenerate to match the new `--primary` hue** — otherwise the ramp points at the old brand color. |
| `--duration-*`, `--ease-*` | motion tokens | Not colors — leave alone. |
| `--font-sans` (in `@theme inline`) | the typeface | Change only if rebranding the font (see below). |

> Stock shadcn sometimes emits a `--destructive-foreground`. This repo doesn't define one — **drop it** when pasting. If a component you add later needs it, add it deliberately (and add a matching `--color-destructive-foreground` line in `@theme inline`).

### Don't touch `@theme inline` unless you add a token

The `@theme inline { … }` block at the bottom of `globals.css` is **wiring**, not values: it maps `--color-primary → var(--primary)` so Tailwind generates `bg-primary` etc. Changing a token's *value* in `:root`/`.dark` flows through automatically. Only edit `@theme inline` when you introduce a brand-new token *name* (then add both the `:root`/`.dark` definition and the `--color-<name>: var(--<name>)` mapping line).

---

## Re-skinning (style + icons + font + colors all at once): an agent pattern

`pnpm theme:apply` deliberately leaves two axes alone, because the shadcn CLI can't change them safely on its own:

- **Component `style`** (`lyra` → `mira`/`nova`): only changes by *regenerating every component*, which overwrites this template's customizations.
- **Icon library** (`lucide` → another): `shadcn apply` only rewrites registry components in `packages/ui`. This repo imports icons at **~45 sites, ~35 of them in app code** (`apps/web/src/components`, routes) the CLI never touches — so it needs a repo-wide codemod regardless.

Changing those is a **re-skin**: a deliberate, one-time operation, not an at-will swap. The apply step is scripted (`pnpm theme:reskin <code>`), but the recovery is not — it is a semantic merge into regenerated files, and most of its damage is *silent* (passes `check-types` but violates a rule), so it needs a human/agent driving a verify-fix loop. Don't reach for it unless you specifically want a new component style or icon set.

### What a full apply destroys (the known recovery set)

A bare `shadcn apply --preset <code>` regenerates `packages/ui/src/components/*` and:

- **Breaks the build (loud):** drops the custom CVA sizes **`touch`** and **`icon-touch` (`size-11` = 44px)** on `Button` → call sites (`mode-toggle.tsx`, `user-menu.tsx`, `language-switcher.tsx`) fail `check-types`.
- **Degrades silently (no type error):** strips **`overscroll-contain`** from Dialog/Sheet/Drawer (the [overlay scroll-bleed rule](./design-system.md)), drops `data-[size=touch]:h-11` touch sizing on Select, and resets the typographic scale (`text-xs/relaxed`). These **pass typecheck** — which is exactly why a "fix until green" loop is not enough; you must also re-check the rules.
- **Adds an orphan** `apps/web/src/lib/utils.ts` (imports `clsx`/`tailwind-merge`, which live in `packages/ui`; this repo aliases `utils` to `@starter/ui/lib/utils`).
- **Mutates deps** and **flips `components.json`** to the new style.

Colors are *not* in this list — `globals.css` tokens (incl. the custom `--state-*`/`--grey-*`/`--primary-*` superset) merge through even a full apply.

### The verify-fix loop (hand this to an agent)

The discipline that makes a re-skin safe: **establish a green baseline first, so every failure afterward is unambiguously yours to fix.** Then apply, then loop on the gate until only *pre-existing* issues remain.

> **Re-skin to shadcn preset `<code>` (new component style + icon library).**
>
> **1. Baseline.** On a clean tree, run `pnpm check-types`, `pnpm --filter web build`, and `pnpm lint`. Record the result. It should be green; if anything already fails, note it — those are *not* your problem to fix.
>
> **2. Apply everything.** Run `pnpm theme:reskin <code>` with no flags first. It refuses on a dirty tree (or a directory that is not a git repository) and prints every file it will regenerate and every customization it will strip, then exits with code 2 — that exit code means "dry run complete, nothing changed", not a crash. **Stop and show that list to the user.** Only after they agree, run `pnpm theme:reskin <code> --confirm`. It performs the full apply, deletes the orphan `apps/web/src/lib/utils.ts` if the apply created it (a tracked file at that path is left alone and flagged), reinstalls, type-checks, and prints which of the customizations it can grep for are now missing. A non-zero exit here is expected; it is the input to step 3. If the preset changes the icon library, also run a codemod replacing the old icon imports with the new library across **all** of `apps/web/src` and `packages/ui/src` (~45 sites), and swap the icon dep in the pnpm catalog.
>
> **3. Test → fix → test, looping on NEW failures only.** Run the gate:
> ```
> pnpm check-types && pnpm --filter web build && pnpm lint
> ```
> Compare against the step-1 baseline. Fix **only the NEW failures** (the ones the re-skin introduced); leave any pre-existing baseline issues alone. Re-run the gate. Repeat until the only remaining issues are the pre-existing baseline ones. Use `git diff HEAD -- packages/ui/src/components` (the `-` lines are the customizations the apply removed) to drive the fixes.
>
> **4. Re-assert the silent rules** (a green gate does not prove these — check them explicitly):
> - `touch` / `icon-touch` size variants restored in `button.tsx`.
> - `overscroll-contain` present on Dialog / Sheet / Drawer content.
> - 44px (`size-11` / `min-h-[44px]` / `data-[size=touch]:h-11`) touch targets restored on interactive controls.
> - No file still imports the old icon library; no orphan `utils.ts`.
> - `components.json` `style` matches the new variant in **both** files; the `--primary-*`/`--grey-*` ramps regenerated to the new hue; PWA hex updated.
>
> **5. Report** the changed files and confirm step-3 gate + step-4 checklist both pass.

### Accidentally ran a full apply? Just revert.

If you only wanted a theme change, throw the regen away and use the script:

```bash
git checkout -- packages/ui/src/components packages/ui/package.json pnpm-lock.yaml \
  apps/web/components.json packages/ui/components.json
rm -f apps/web/src/lib/utils.ts
pnpm install --frozen-lockfile
pnpm theme:apply <code>
```

---

## Step-by-step: apply a new theme

1. **Get the values** (Copy Code → OKLCH, per above).
2. **Open** `packages/ui/src/styles/globals.css`.
3. **Light mode** — in the `:root { … }` block, replace the value of each stock token with the editor's `light` value. Skip any token the editor emits that this repo doesn't have; never delete a custom token.
4. **Dark mode** — repeat in the `.dark { … }` block with the editor's `dark` values.
5. **Radius** — the editor emits a single `--radius`. This repo derives the whole radius scale from it in `@theme inline` (`--radius-sm = calc(var(--radius) - 4px)`, etc.), so you only set the one base value. Current default is `0.45rem`.
6. **Regenerate the hue-linked tokens** so they don't fight the new brand color:
   - `--ring` should be a desaturated/lighter relative of `--primary`.
   - `--sidebar-primary` (and `-foreground`) typically track `--primary`.
   - `--input` / `--border` track the neutral hue, not the brand — keep them aligned with your greys.
7. **Regenerate the numeric ramps** (`--grey-*`, `--primary-*`) — see next section.
8. **Retune `--state-*` only if needed** (a green-on-green clash, etc.).

### Regenerating the `--primary-*` and `--grey-*` ramps

These are 9-step OKLCH ramps. The pattern in the shipped theme: a roughly fixed **hue**, lightness descending from `~0.97` (50) to `~0.28` (900), chroma rising into the mid-steps and easing off at the extremes. In dark mode the lightness order is inverted (50 is darkest).

The editor won't generate these. Three ways to refresh them, fastest first:

- **Let an agent compute it.** Tell your agent the new `--primary` OKLCH value and ask it to rewrite `--primary-50 … --primary-900` (and the `.dark` counterparts) keeping the existing lightness/chroma curve but swapping in the new hue. Same for `--grey-*` with the neutral hue.
- **Use an OKLCH ramp tool** (e.g. the editor's own scale view, or any OKLCH palette generator) seeded with your brand color, then paste the nine steps.
- **By hand:** keep each step's L and C from the current file, change only the third number (hue) to your brand hue; nudge chroma down on 50/100 and 800/900 so the ends don't look muddy.

> **How much this matters:** today no shipped component uses `bg-primary-600`/`text-grey-400`-style utilities — the ramps are exposed for *your* app code via `@theme inline`. So a mismatched ramp won't visibly break the starter UI, but it will hand future code a `primary-*` scale pointing at the *old* brand color. Fix it now while the values are in front of you, or you'll ship a latent trap.

---

## Don't forget the PWA chrome color

Several values live **outside** the CSS and are not driven by the theme tokens — update them to match your new `--background`/brand so the mobile address bar and splash don't flash the old color:

- `apps/web/vite.config.ts` → `manifest.theme_color` / `background_color` (install-time manifest: splash screen + installed-app chrome).
- `packages/config/src/theme-init.ts` → the anti-FOUC inline script that *creates* the `theme-color` `<meta>` on the first frame. It carries the light/dark hex pair (`#0c0c0c` / `#ffffff`) **and** the matching `oklch()` values it sets as the root `backgroundColor`.
- `apps/web/src/hooks/use-theme-color-meta.ts` → the `THEME_COLORS` map that keeps the same meta in sync on later theme toggles. **Must stay in lockstep with `theme-init.ts`** — both mirror `--background` for `:root` / `.dark` in `globals.css`.

There is deliberately **no static `theme-color` meta in `__root.tsx`** — the meta is managed imperatively so it can track the resolved light/dark theme; don't add one. The meta values take a **hex** string, not `oklch()`. Full context (and the service-worker cache-busting caveat) is in [removable/rebrand.md § Files to update](./removable/rebrand.md).

---

## Verify

```bash
pnpm --filter web build      # fails loudly on a malformed oklch()/var()
pnpm dev:docker              # then drive the UI (see patterns/agent-ui-testing.md)
```

Check both modes on a real surface, not just a swatch:

- [ ] Toggle dark mode (next-themes) — every token has a `.dark` value; no element inherits a light value into dark.
- [ ] Primary buttons, focus **rings**, links, and the sidebar all read as the *new* brand color (catches a missed `--ring`/`--sidebar-primary`).
- [ ] Toasts/badges/alerts (`--state-*`) still read as success/warning/info and pass contrast against the new background.
- [ ] Muted text (`text-muted-foreground`) is legible on `--background` and on `--card` in both modes.
- [ ] If you use any `primary-*`/`grey-*` numeric utilities, they match the new hue.

Design rules (contrast, hierarchy, "never status-by-color-alone") live in [design-system.md](./design-system.md) — re-read it after a palette change.

---

## Switching Base UI ↔ Radix UI

shadcn ships **two component variants** from the same registry: a **Base UI** variant (primitives from `@base-ui/react`) and the original **Radix UI** variant (primitives from `@radix-ui/react-*` / `radix-ui`). **This template uses the Base UI variant** — every primitive in `packages/ui/src/components/*` imports from `@base-ui/react`, and `components.json` selects a `base-*` style.

### Themes are variant-agnostic — this is the key fact

A `registry:theme` is **pure CSS variables**. It has no dependency on Base UI vs Radix. The exact same theme block you paste into `globals.css` works identically under either variant. **Switching the theme never requires touching components, and switching the component variant never requires touching the theme.** Keep the two operations separate.

### How the variant is selected

`components.json` → `style`. The CLI reads the prefix:

```
base-*   (e.g. base-nova, base-lyra)  → Base UI  → @base-ui/react
anything else (radix-*, new-york-v4)  → Radix UI → @radix-ui/react-* / radix-ui
```

> This repo has **two** `components.json` files — `packages/ui/components.json` and `apps/web/components.json` — and both are pinned to the same style, **`base-lyra`** (Base UI). Keep them in sync: if you change the variant, change it in both. The shared components live in `packages/ui/`, so treat **`packages/ui/components.json`** as the source of truth and mirror any change into `apps/web/components.json`.

### What actually differs between the two variants

The CVA class definitions (`buttonVariants`, etc.) and the design tokens are **identical**. Only the primitive layer differs:

| | Base UI (this repo) | Radix UI |
|---|---|---|
| Import | `import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"` | `import { Dialog as DialogPrimitive } from "radix-ui"` (or `@radix-ui/react-dialog`) |
| npm dep | single `@base-ui/react` | one package **per primitive** (`@radix-ui/react-dialog`, `-checkbox`, …) |
| Composition | `render` prop | `asChild` + `Slot` |
| Some prop/part names | Base UI naming (`*.Backdrop`, `*.Popup`, …) | Radix naming (`*.Overlay`, `*.Content`, …) |

The **`asChild` ↔ `render` prop** difference is the one that reaches *application* code, not just the primitive files. Base UI replaces Radix's `asChild` with a `render` prop. So a swap is not just re-importing — any call site that polymorphs a component changes shape:

```tsx
// Radix variant
<Tooltip.Trigger asChild>
  <button>Hover</button>
</Tooltip.Trigger>

// Base UI variant (this repo)
<Tooltip.Trigger render={<button>Hover</button>} />
```

### To switch variants (the honest version)

This is a **migration, not a config flip.** To go Base UI → Radix (or back):

1. **Flip `style`** in `components.json` (both files) to the target variant's style (`base-*` ↔ a Radix style like `new-york-v4`).
2. **Re-pull every component** from the registry under the new style so the primitive imports regenerate — `npx shadcn@latest add <component>` for each file in `packages/ui/src/components/`. Don't hand-edit imports one by one; the variants differ in part names and props, not just the import line.
3. **Swap deps in the pnpm catalog** (`pnpm-workspace.yaml`) — add/remove `@base-ui/react` vs the set of `@radix-ui/react-*` packages. Follow [dependencies.md](./dependencies.md); don't edit versions in a workspace `package.json` directly. Confirm before installing per [agent-tooling.md](./agent-tooling.md#installing-a-new-pnpm-package).
4. **Fix every call site** that used the old polymorphism API: `asChild` → `render` (or the reverse), plus any renamed parts (`Overlay`↔`Backdrop`, `Content`↔`Popup`, etc.). `pnpm check-types` will surface most of these.
5. **Re-apply local customizations.** Several components here have hand-tuned tweaks (sizing, `data-slot`s). Re-pulling from the registry overwrites them — diff against git and port the deltas forward.
6. **Gate on CI:** `pnpm check-types && pnpm test && pnpm doctor:react`, then drive the UI per [agent-ui-testing.md](./agent-ui-testing.md). Overlays (dialog, sheet, popover, dropdown, tooltip, select) are where API drift bites — test each.

Because step 5 means re-doing this repo's component customizations, **don't switch variants without a real reason** (e.g. a required primitive only one library ships, or a hard a11y/behavior need). For a pure visual change, restyle with tokens instead — that's free and variant-agnostic.

---

## Related

- [design-system.md](./design-system.md) — the visual rules the tokens serve; radius scale, contrast, hierarchy.
- [removable/rebrand.md](./removable/rebrand.md) — name, icons, PWA manifest (the non-color half of branding).
- [getting-started.md](./getting-started.md) — onboarding does branding/theme up front, before feature work.
- [dependencies.md](./dependencies.md) / [agent-tooling.md](./agent-tooling.md) — catalog + install workflow for the variant-swap dep changes.
</content>
</invoke>
