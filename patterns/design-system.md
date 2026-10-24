# Design System — spacing, type, hierarchy, shadows, motion

The visual-design rules behind the terse **Styling** and **PWA — Native Mobile Feel** sections of `AGENTS.md`. Those sections are the law; this is the worked reasoning, adapted to this repo's actual tokens (Tailwind v4 + OKLCH theme variables in `packages/ui/src/styles/globals.css`).

Apply this whenever you build or redesign a component or page. None of it needs a new dependency — it's all Tailwind utilities + the CSS variables already defined in `globals.css`.

To **change** the palette itself — apply a shadcn theme-editor preset, regenerate the `--grey-*`/`--primary-*` ramps, or switch the Base UI ↔ Radix component variant — see [shadcn-theme-update.md](./shadcn-theme-update.md).

## Spacing

Use Tailwind's built-in 4px scale (`p-2` = 8px, `p-4` = 16px, `gap-6` = 24px …). Do not reach for arbitrary values (`p-[15px]`) when a scale step exists.

- **Start with more whitespace than you think you need**, then tighten.
- **Group with proximity.** Related elements get *less* space between them; distinct groups get *more*. Ambiguous spacing (everything equidistant) is the most common amateur tell.

```tsx
<form className="space-y-8">          {/* between sections */}
  <section className="space-y-4">     {/* within a section */}
    <h2>Personal information</h2>
    <Field name="name" />
    <Field name="email" />
  </section>
  <section className="space-y-4">
    <h2>Address</h2>
    <Field name="street" />
  </section>
</form>
```

## Typography

Stick to Tailwind's type scale (`text-sm` … `text-4xl`); avoid `text-[17px]`.

- **Body**: `text-base` (16px) or `text-lg`. **Captions/metadata**: `text-sm`. **Headings**: `text-xl`–`text-4xl` by hierarchy level.
- **Line length** 45–75 chars — use `max-w-prose` for long copy.
- **Line height**: relaxed for body (`leading-relaxed`), tight for headings (`leading-tight`).
- Limit to 2–3 font weights. Don't create hierarchy with size alone — combine size, weight, and color.

Repo-wide typography conventions — opt-in Tailwind utilities, not CSS-enforced (not restated in `AGENTS.md`):

- `text-wrap: balance` on headings (`text-balance`) — avoids orphans.
- `text-decoration-skip-ink: auto` on underlines — flows around descenders.
- `font-variant-numeric: tabular-nums` (`tabular-nums`) for any numbers that align in columns/KPIs/tables.
- Prefer curly quotes (“ ”) and the ellipsis character (…) over `"` and `...`. (User-facing copy lives in the i18n bundles — see [i18n.md](./i18n.md).)

## Visual hierarchy

Guide the eye with **size, weight, color, and position** — in that order of bluntness.

- Primary text: foreground color, bold for headings. Secondary: `text-muted-foreground`. Tertiary: a lighter muted tone.
- Primary action = filled/`default` Button. Secondary = `outline`/`ghost`. More important = visually heavier.
- **Never encode status with color alone.** Pair color with an icon or label so it survives color-blindness and grayscale. (Green check / red ✕, not just green / red.)
- **Optical over geometric alignment.** Nudge icons, triangles, and rounded shapes ±1–2px so they *look* aligned even when they are geometrically centered.

## Shadows & borders

- **Layered shadows** read as real depth — combine a tight ambient shadow with a softer spread one rather than one big blur.
- **Soft borders.** Prefer a low-contrast border (semi-transparent, ~border color from the theme) over a hard dark 1px line; combine a subtle border *and* a subtle shadow for crisp edges.
- On non-neutral backgrounds, tint borders/shadows toward the background hue for cohesion.

### Nested radii (already a repo rule)

`globals.css` defines a radius scale off one base:

```css
--radius: 0.45rem;
--radius-sm: calc(var(--radius) - 4px);
--radius-md: calc(var(--radius) - 2px);
--radius-lg: var(--radius);
--radius-xl: calc(var(--radius) + 4px);
/* … up to --radius-4xl */
```

Child radius must be ≤ parent radius and concentric. Use `rounded-lg` on outer containers (Card, Dialog) and `rounded-md`/`rounded-sm` on inner controls (Button, Input, Badge). When you hand-nest, **inner radius = outer radius − padding**.

## Motion

The repo's hard rules: never `transition: all` / `transition-all` (`AGENTS.md` → Styling; `scripts/policy-checks.sh` greps `apps/` + `packages/` and fails the build); always honor `prefers-reduced-motion`, falling back to instant (`AGENTS.md` → PWA — Native Mobile Feel).

Beyond those:

- **Animate only to clarify cause-and-effect** (a panel expanding from the button that opened it) **or for one deliberate high-impact moment** (page load). Prefer one coherent sequence over scattered micro-interactions.
- **Prefer compositor-friendly properties.** `transform` and `opacity` are GPU-composited and don't trigger layout. Animating `width`/`height`/`top`/`left` forces reflow on every frame — avoid it for anything that runs more than once.
- **Anchor `transform-origin`** to where the motion physically starts. For SVGs, animate a wrapping `<div>` (or set `transform-box: fill-box; transform-origin: center`) — many browsers don't hardware-accelerate transforms applied directly to SVG nodes.
- **Animations should be interruptible** by user input; avoid long non-skippable transitions.

### Page transition direction

The app's page-level View Transition animation reads `html[data-nav-direction]` and supports three values:

- `forward` — default; old page slides left and new page slides in from the right.
- `back` — reverse the slide direction for earlier nav items or child → parent navigation.
- `none` — defensive CSS fallback for explicit same-path transitions. Normal same-path URL changes such as `nuqs` search-param updates should be blocked before a page View Transition starts by `apps/web/src/lib/view-transition-policy.ts`.

Nav order is defined in [`apps/web/src/lib/nav-items.ts`](../apps/web/src/lib/nav-items.ts). When you add a new sibling destination to the app shell, add it to the appropriate ordered nav list there so both the rendered nav and the forward/back transition logic stay in sync.

### Subpixel shifts during animation → `will-change`

If an element shifts unexpectedly by a pixel or two during an animation — text re-anti-aliases, a layer "snaps," a child nudges — and you can't trace the cause, promote it to its own GPU compositing layer:

```css
.thing { will-change: transform; }   /* or: opacity, whichever you animate */
```

`will-change` (and the older `transform: translateZ(0)` hack) forces the browser to give the element a dedicated layer up front, removing the rounding/re-rasterization jitter that happens when an element is composited mid-animation.

**Use it sparingly.** Every promoted layer costs GPU memory; sprinkling `will-change` across many elements *hurts* performance. Add it to the specific element that misbehaves, not as a blanket rule, and remove it if the artifact was actually caused by something else.

> Note: `motion` (Framer Motion) is **not** a dependency of this template. CSS transitions/animations cover the cases above. If a feature genuinely needs spring physics or FLIP layout animation, follow the package-install workflow in [agent-tooling.md](./agent-tooling.md#installing-a-new-pnpm-package) — don't assume it's available.

## Interaction details

- `:focus-visible` (not `:focus`) for focus rings — keyboard users see it, pointer users don't. Every focusable element must show a visible ring.
- Mobile input font size **≥ 16px** or iOS Safari auto-zooms on focus.
- `touch-action: manipulation` on interactive controls (already global in `globals.css`) kills the 300ms double-tap delay.
- Axis-specific overscroll containment (see below) — do not blanket `overscroll-contain` on horizontal-only regions.
- `scrollbar-gutter: stable` on the scrolling container when scroll locking, opening an overlay, or toggling `overflow-y` causes centered/fixed content to shift as the browser scrollbar appears or disappears.
- Hover/active/focus states should have *more* contrast than the rest state.
- Expand hit targets generously: **≥ 44px on mobile** (the hard rule, in `AGENTS.md` → PWA — Native Mobile Feel), **≥ 24px on desktop** (this doc's recommendation, not an AGENTS.md rule).
- Destructive actions require explicit confirmation or an Undo — see the type-to-confirm recipe in [overlays.md](./overlays.md).

## Accessibility acceptance before launch

Follow [launch-readiness](./launch-readiness.md) on the actual app surfaces. Verify keyboard navigation and visible focus, accessible names, labels and form errors, meaningful image alternatives, status announcements, contrast in both themes, and zoom/reflow. Include auth, consent, overlays, privacy notices, and cancellation. Automated diagnostics and the interaction rules above support this pass; they do not certify WCAG conformance. Record manual checks and unresolved limitations in the consuming app's launch notes.

## Axis-specific overscroll

`overscroll-behavior: contain` is correct for bounded vertical surfaces (modals, drawers, nested vertical panes). It is too broad for horizontal-only regions such as wide tables, tab rows, segmented controls, and filter strips: containing both axes can trap vertical wheel/touch gestures over the table and make the page feel stuck.

Use:

| Region | Classes |
|---|---|
| Horizontal-only (tables, tab rows, filter strips) | `overflow-x-auto overflow-y-hidden overscroll-x-contain` |
| Vertical-only nested region when the page should not receive scroll at the boundary | `overflow-y-auto overflow-x-clip overscroll-y-contain` |
| Bounded panes, drawers, dialogs, modal content | `overflow-y-auto overflow-x-clip overscroll-contain` |
| When scroll chaining to the page is desirable | no overscroll containment |

Never set `overflow-y: auto` / `overflow-y-auto` without an explicit `overflow-x`. An omitted `overflow-x: visible` computes to `auto` and turns the page into a horizontal scroller. Flex/grid children that wrap wide content need `min-w-0` (and usually `max-w-full`) so min-content width cannot inflate the page.

`min-w-0` fixes an **item**, not a container. `min-width: auto` is the automatic-minimum-size rule, and it only applies to flex and grid items — putting `min-w-0` on a `position: fixed` panel that already has a definite width (`DialogContent`, `SheetContent`, `AlertDialogContent`) changes nothing. Two places actually need it:

- **The track.** A `grid` with no explicit template gets `auto` columns, whose minimum is min-content — one long unbroken string (an API key, a URL, a temp password) widens the track past the panel. `DialogContent` and `AlertDialogContent` therefore declare `grid-cols-[minmax(0,1fr)]`.
- **The item.** Every direct child of that grid is itself a grid item with the same automatic minimum, so the wrapper you drop in a dialog needs `min-w-0` — `<div className="min-w-0 space-y-2">`. `TextField` and `TextareaField` already carry it on their own wrapper.

A `SheetContent` needs neither: it is a flex column with a definite width (`w-3/4 sm:max-w-sm`), so that width is what clamps its children — they still want `min-w-0` if they are flex items that wrap a long value.

Get both and a long value truncates or scrolls inside the dialog. Get neither and the dialog grows past the viewport on a phone.

Intentional horizontal scroll belongs in `WideContent` (`apps/web/src/components/wide-content.tsx`) — `min-w-0 max-w-full overflow-x-auto overflow-y-hidden overscroll-x-contain` — not on the page shell.

```html
<WideContent>
  <table class="w-max min-w-full">...</table>
</WideContent>
```

Acceptance:

- Horizontal table/card-row scrolling does not create sideways page drift.
- Vertical wheel/touch gestures over a horizontal table still let the page scroll naturally.
- Agents do not use broad `overscroll-contain` on horizontal-only wrappers by default.

## Site shell geometry

Shared site chrome and frame geometry should live behind one shell contract. The shipped app shell is `apps/web/src/routes/$lang/_app/route.tsx` (client-only). Public pages use the `_public` layout. Routes own content and local loading/error/empty states — not app-frame wrappers.

The shell owns:

- Public document layout for SSR-capable pages vs client-only app viewport layout for authenticated/admin pages.
- Safe-area padding (`var(--safe-area-*)`).
- Footer placement and BottomNav clearance (`pb-[calc(3.5rem_+_var(--safe-area-bottom))]` when the software keyboard is closed, `md:pb-0`).
- Main scroll ownership (`min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain [scrollbar-gutter:stable]`).
- Page transition naming (`viewTransitionName: "page"`).
- Software-keyboard detection via `useMobileKeyboard()`. Header stays visible. BottomNav may hide only when a mobile software keyboard is actually open — never from `visualViewport` height or similar resize heuristics alone.

Routes own their content, local navigation that is content navigation (not global chrome), and local loading/error/empty states. Do not copy `h-svh` grid frames, safe-area padding, or BottomNav clearance into individual route files.

## Split-pane scroll ownership

For long authenticated desktop workspaces with persistent side navigation (admin, settings, account portals, editors, inboxes, dashboards), use one bounded split-pane layout instead of route-local sticky/fixed patches.

Contract:

- The app shell owns viewport height, safe-area padding, header/footer placement, bottom-nav clearance, and the top-level scroll region.
- The split-pane owns the desktop workspace region inside that app shell.
- Sidebar and content are siblings in a `min-h-0` grid/flex layout.
- Sidebar has explicit header/body/footer slots; only the sidebar body scrolls.
- Content owns its own long-page scrolling with `overflow-y-auto overflow-x-clip`, `overscroll-contain`, and `scrollbar-gutter: stable`.
- Mobile falls back to normal flow plus a Sheet/FAB/inline nav as needed. Do not add another fixed mobile nav bar.

Do not fix full-height sidebars with hard-coded content offsets, `position: fixed` sidebars, resize observers or scroll listeners, bigger `top-*` values, or route-local `sticky + h-full` wrappers.

## Sticky and fixed UI audit

Before adding `sticky` or `fixed`, classify the UI:

| Case | Prefer |
|---|---|
| Full-height app workspace navigation | Split-pane scroll ownership |
| Route-local aside inside content flow (e.g. map beside results) | `lg:sticky lg:top-*` is acceptable |
| Mobile primary navigation | Canonical BottomNav only |
| Mobile secondary/workspace navigation | Sheet/FAB or inline wrapping nav, offset from BottomNav and `var(--safe-area-bottom)` |
| Transient fixed chrome (compare trays, selection action bars, dismissible banners) | Account for BottomNav, safe areas, z-index, and print hiding |
| Overlays | Modal content owns bounded scrolling with `overscroll-contain`; the page behind should not scroll |
| Editors/detail sidebars | Ordinary content asides unless they need persistent full-height navigation |

Acceptance: no second mobile nav bar; fixed controls do not overlap BottomNav or safe-area insets; route-local sticky regions do not become global app sidebars by accident; overlay scroll remains separate from page scroll.

## Horizontal selector rows

A horizontal row of selectors — segmented controls, tab bars, filter pills, the
settings sub-nav — can render wider than the viewport on mobile. If it overflows
the page, the whole document scrolls sideways (headings, body, bottom nav all
drift off-screen), which feels broken on a PWA. **Contain the overflow in the
row's own region** so the bar scrolls within itself and the page body stays
fixed.

**The required implementation is the `SelectorRow` component**
(`packages/ui/src/components/selector-row.tsx`) — it encapsulates the recipe
below, enforces `shrink-0` on children via `[&>*]:shrink-0`, and takes
`className` (outer scroll region) + `innerClassName` (the flex track, e.g.
`gap-1 px-4 py-2`). Hand-rolling the classNames for a new selector row instead
of composing `SelectorRow` is a review failure. Tables and other wide content
use `WideContent`, not `SelectorRow`.

What `SelectorRow` bakes in (so you can recognize — and fix — a broken
hand-rolled row):

```html
<!-- constrained-width ancestor: a flex child needs min-w-0 (default is min-width:auto) -->
<div class="min-w-0 max-w-full overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar">
  <!-- single-line inner row that does not shrink -->
  <div class="inline-flex w-max gap-1 ...">
    <button class="shrink-0 min-h-[44px] ...">…</button>
    <!-- more non-shrinking items -->
  </div>
</div>
```

Three things must hold for `overflow-x-auto` to engage instead of the row
growing the page:

1. **Constrained-width ancestor.** Somewhere up the chain there must be a
   `min-w-0` (flex children default to `min-width: auto`, which lets them expand
   to fit content and push the page). The scroll container itself uses
   `min-w-0 max-w-full` when it sits inside a `flex ... justify-between` row so it
   doesn't shove its siblings.
2. **Non-shrinking items** — `shrink-0` on each item (or wrap them in a `w-max`
   inner row) so they keep their natural width and the row overflows rather than
   squashing.
3. **Hidden scrollbar** — add the `no-scrollbar` utility (defined in
   `packages/ui/src/styles/globals.css`: `scrollbar-width: none` +
   `::-webkit-scrollbar { display: none }`) for the native-app feel.

Optional full-bleed refinement for a row inside a `container ... px-4`: add
`-mx-4 px-4` (mobile only) so the bar scrolls edge-to-edge and the last item
clears the container padding.

The admin nav (`apps/web/src/routes/$lang/_app/admin.tsx`) is the in-tree
`SelectorRow` reference. The recipe is also baked into the shared
`SegmentedControl` (`apps/web/src/components/segmented-control.tsx`) and
`LocaleTabs` (`apps/web/src/components/admin/locale-tabs.tsx`) so every call
site of those is covered, and applied inline at the settings sub-nav
(`apps/web/src/routes/$lang/_app/_auth/settings.tsx`, which stays hand-rolled
because it flips to a vertical column at `md:`). Do **not** add scroll-snap or
edge-fade gradients — `SelectorRow` is a layout primitive, not a tab system;
compose it with `ToggleGroup`, pill buttons, or links.

## Copyable text and code

Any user-copyable value uses the shared components from `packages/ui` — a
hand-rolled `<pre>` or ad-hoc clipboard button in app code is a review failure
(and CI's policy-checks job greps `apps/web/src` for raw `<pre`):

- **`CopyField`** (`packages/ui/src/components/copy-field.tsx`) — single-line
  value (shell command, API key, URL, confirm token) + copy button.
- **`CodeSnippet`** (`packages/ui/src/components/code-snippet.tsx`) —
  multi-line block (JSON, config, env block) with the copy button pinned
  top-right.

Both encapsulate the `min-w-0 max-w-full` + `overflow-x-auto
overscroll-x-contain` containment contract — the value region scrolls itself,
never the page — so they are **safe inside `DialogContent` by default**. Both
share one clipboard behavior (`packages/ui/src/hooks/use-copy-to-clipboard.ts`:
`navigator.clipboard.writeText` with a `document.execCommand("copy")` fallback,
check-icon feedback for ~1.5 s); a bespoke copy button that can't compose the
components must at least use that hook. Wire toasts at the
call site via `onCopied` / `onCopyError` — `packages/ui` never imports from
`apps/web`. The copy button's `aria-label` defaults to hardcoded accessibility
text (the allowed i18n exception); pass `copyLabel` where the call site has a
translated string. In-tree references: the temp-password reveal
(`apps/web/src/routes/$lang/_app/admin/users.tsx`) and `ConfirmDeleteDialog`
(`apps/web/src/components/confirm-delete-dialog.tsx`). The one sanctioned raw
`<pre>` left in `apps/web/src` is the react-markdown renderer in
`markdown-editor.tsx` (it renders arbitrary markdown children, not a copyable
string) — it is explicitly excluded in the CI grep.

## Full-bleed admin page container

Most admin routes keep a centered reading measure, so forms and prose stay
legible on a wide monitor:

```tsx
<div className="container mx-auto max-w-7xl px-4 py-8">…</div>
```

Operational grids — dense tables an admin scans and edits all day — need the
full monitor width instead. They **opt out per route**. Do not rebuild the app
shell or the split-pane layout to get width: width is a container className
concern on one page, independent of the layout contracts above.

The full-bleed opt-in (classNames only, no new component):

```tsx
{/* w-full min-w-0 max-w-none — drop container + max-w-*; keep horizontal padding */}
<div className="w-full min-w-0 max-w-none px-4 md:px-6 py-8">…</div>
```

Rules:

1. **Per-route only.** Public and authenticated member pages stay centered.
   Other admin pages keep their existing `container max-w-*` until they opt in.
2. **The page body never scrolls horizontally.** A wide table keeps its overflow
   inside `WideContent` (`apps/web/src/components/wide-content.tsx`) — same
   containment rule as [Horizontal selector rows](#horizontal-selector-rows).
   Pair it with `min-w-0` on flex/grid ancestors so the region can actually
   shrink.
3. **Sticky table chrome** — a sticky header row, and optionally a sticky first
   column — sticks relative to that same overflow region, not the page. Give the
   region a bounded `max-h-*` when you want a sticky `thead` while both axes
   scroll together.
4. **Density stays an independent axis.** Going full-bleed is a width decision;
   it does not change type scale, row height, or any information-density setting
   the page already has.

## Loading & empty states

Covered in depth by [loading-and-errors.md](./loading-and-errors.md). The design-level rules:

- Skeletons mirror final layout exactly (no layout shift). Never a spinner for content.
- If you show a loader, add a ~150–300ms show-delay and a ~300–500ms minimum visible time to avoid flicker on fast responses.
- Empty state ≠ error state ≠ loading state. Each is explicit and visually distinct; an empty state should offer the next action.

## Common mistakes

1. Arbitrary spacing/type values instead of the scale.
2. Ambiguous spacing — no clear grouping.
3. Hierarchy by size only; everything competing for attention.
4. Color-only status (no icon/label backup).
5. `transition: all` (also a CI failure).
6. Animations with no reduced-motion fallback.
7. Missing `:focus-visible` rings.
8. Mobile inputs < 16px (causes iOS zoom).
9. Spinner where a skeleton belongs.
10. Unbounded horizontal selector row that scrolls the whole page instead of itself — use `SelectorRow` from `packages/ui`, which contains the row in its own `overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar` region with a `min-w-0` contract + `shrink-0` items (see "Horizontal selector rows").
11. `overflow-y-auto` without an explicit `overflow-x` — the omitted axis computes to `auto` and the page becomes a horizontal scroller. Pair vertical panes with `overflow-x-clip` (or `overflow-x-hidden`) and put intentional wide content in `WideContent`.
