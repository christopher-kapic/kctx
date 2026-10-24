# Animation — vocabulary to recipe map for this stack

This is the motion playbook for this template. Use it when a developer asks for motion in plain language like "pop in", "stagger", "scroll reveal", "spring", or "page transition".

It is intentionally honest about scope:

- This stack ships **CSS-first motion**, not Framer Motion or another physics/layout engine.
- The default tools are `tw-animate-css`, the motion tokens in [`packages/ui/src/styles/globals.css`](../packages/ui/src/styles/globals.css), the shared primitives `<AnimateIn />`, `<Stagger />`, `<Skeleton variant="shimmer" />`, the app's page `view-transition` setup, and `useReducedMotion()`.
- If the requested motion needs physics, layout interpolation, or interruptible drag momentum, stop and ask before adding a library. See [agent-tooling.md](./agent-tooling.md#installing-a-new-pnpm-package).

For motion principles and the repo-wide styling rules, also read [design-system.md](./design-system.md).

## Principles

Use animation to explain change, not to decorate everything.

- **Purpose first.** Motion should clarify cause and effect, show hierarchy, or make a single deliberate moment land.
- **Shorter and subtler as frequency increases.** Repeated UI motion should usually use `--duration-fast` or `--duration-base`; save longer motion for rare, high-signal moments.
- **Animate `transform` and `opacity`, not layout.** Prefer `translate`, `scale`, `rotate`, and fades. Avoid animating `width`, `height`, `top`, `left`, or large box-shadows for frequent interactions.
- **Never use `transition: all` or `transition-all`.** Name the exact properties instead.
- **Honor `prefers-reduced-motion`.** CSS animations already inherit the global reduced-motion override in `globals.css`; JS-driven motion must gate on `useReducedMotion()`.
- **Use real tokens.** The shipped timing tokens are `--duration-fast`, `--duration-base`, `--duration-slow`, plus easing tokens including `ease-out`, `ease-in-out`, and `ease-spring`.

## What Ships

### Motion tokens

Defined in [`packages/ui/src/styles/globals.css`](../packages/ui/src/styles/globals.css):

- Durations: `--duration-fast`, `--duration-base`, `--duration-slow`
- Easings: `--ease-out`, `--ease-in`, `--ease-in-out`, `--ease-spring`, `--ease-emphasized`
- Global reduced-motion override: `@media (prefers-reduced-motion: reduce)` forces near-instant CSS animation/transition timing

### Primitives

- `<AnimateIn variant="fade" | "slide-up" | "slide-down" | "scale" | "pop" />`
- `<Stagger childVariant="fade" | "slide-up" | "slide-down" | "scale" | "pop" stepMs={50} />`
- `<Skeleton variant="pulse" | "shimmer" />`
- `useReducedMotion()` for JS-driven motion fallbacks

### Existing motion surfaces

- `tw-animate-css` utilities power enter/exit classes like `animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-bottom-2`
- Dialog / Popover / Drawer already use these classes for overlay enter/exit
- Page-level `view-transition` is enabled for pathname changes; `globals.css` defines `::view-transition-old(page)` / `::view-transition-new(page)`, `use-nav-direction.ts` sets forward/back direction, and `apps/web/src/lib/view-transition-policy.ts` blocks same-path state updates from starting a page transition

## Entrances & Exits

Use these when the user asks for "fade in", "slide up", "pop in", "zoom", "appear", "exit", or "dismiss".

### "Fade in" / "Appear"

Use `<AnimateIn variant="fade" />` for one element, or `animate-in fade-in-0` for existing primitives that already manage open/closed state.

```tsx
import { AnimateIn } from "@starter/ui/components/animate-in";

<AnimateIn variant="fade">
  <Card />
</AnimateIn>;
```

### "Slide up" / "Rise in"

Use `<AnimateIn variant="slide-up" />`. This combines a fade with a small upward travel, which reads cleaner than a large slide.

```tsx
<AnimateIn variant="slide-up" className="duration-[var(--duration-base)]">
  <section>...</section>
</AnimateIn>
```

### "Slide down"

Use `<AnimateIn variant="slide-down" />` for banners, inline alerts, or elements entering from above.

### "Pop in" / "Scale in"

Use `<AnimateIn variant="pop" />` when the request implies a slightly lively entrance. This uses `zoom-in-95` with `ease-spring`, which is the closest shipped approximation to a spring without physics.

```tsx
<AnimateIn variant="pop">
  <Button>Save</Button>
</AnimateIn>
```

### "Modal opens" / "Popover opens" / "Sheet opens"

Do not hand-roll these. Use the shipped overlay components from `packages/ui/src/components/`; they already use `tw-animate-css` enter/exit classes such as:

- `data-open:animate-in data-open:fade-in-0`
- `data-open:zoom-in-95`
- `data-closed:animate-out data-closed:fade-out-0`

That keeps overlays consistent with the repo's conventions in [overlays.md](./overlays.md).

## Sequencing & Timing

Use these when the user asks for "stagger", "cascade", "one after another", "delay", or "step through the list".

### "Stagger"

Use `<Stagger />` for lists, menus, cards, or grouped content. Default `stepMs={50}` is appropriate for most UI lists.

```tsx
import { Stagger } from "@starter/ui/components/stagger";

<Stagger childVariant="slide-up" stepMs={50} className="grid gap-3">
  {items.map((item) => (
    <Card key={item.id}>{item.name}</Card>
  ))}
</Stagger>;
```

Guidelines:

- 40–60ms step: dense lists
- 60–100ms step: hero sections or marketing blocks
- Keep the total sequence short; long staggers feel slow on repeat visits

### "Delay this a bit"

Prefer a single `animationDelay` or `transition-delay` on one element over stacking multiple nested delays. Use the duration tokens instead of arbitrary timing values where possible.

### "Snappier" / "More deliberate"

- Snappier: `--duration-fast` + `ease-out`
- Default UI: `--duration-base` + `ease-out`
- Deliberate emphasis: `--duration-slow` + `ease-emphasized`
- Lively pop: `--duration-base` + `ease-spring`

## Movement & Transforms

Use these when the user asks for "move", "nudge", "lift on hover", "press down", "float", or "rotate slightly".

### Hover lift

Use a small translate and shadow change, with explicit transition properties.

```tsx
<Card className="transition-[transform,box-shadow] duration-[var(--duration-fast)] ease-out hover:-translate-y-0.5 hover:shadow-md" />
```

### Press / tap

Use a tiny scale-down or downward nudge.

```tsx
<Button
  className="transition-transform duration-[var(--duration-fast)] active:scale-[0.98]"
  onClick={() => submit()}
/>
```

### Haptic presets

This is the canonical vocabulary for haptics on native (`haptic()` in
`apps/native/lib/haptics.ts`). Pick from this list rather than inventing a new
one. The web app has no haptics — `navigator.vibrate` support is too uneven to
build on, so web feedback is visual/toast only.

- `"light"` — taps and button presses
- `"success"` — save/submit succeeded
- `"error"` — validation or network failure
- `"selection"` — toggles, tabs, segmented controls
- `"warning"` — immediately before a destructive action

### Direction-aware movement

For page transitions, use the shipped `view-transition` system instead of ad hoc route animations. `use-nav-direction.ts` writes `html[data-nav-direction]`, and `globals.css` maps that to forward/back slide directions.

Page View Transitions are only for pathname changes. Query-string updates, hash updates, and history-state-only changes are state updates inside the same screen, so the router policy in `apps/web/src/lib/view-transition-policy.ts` returns `false` for those navigations before a page transition starts.

Use this vocabulary:

- "page transition" -> existing page `view-transition`
- "direction-aware transition" -> existing `data-nav-direction="forward" | "back" | "none"`

## Transitions Between States

Use these when the user asks for "expand", "collapse", "switch tabs", "change state smoothly", or "transition between screens".

### Open / close state

Prefer the component's existing stateful classes from `tw-animate-css` instead of custom JS. Dialogs, Popovers, and Drawers already do this.

### Swap one panel for another

If the panels are different content states in the same slot, use `AnimateIn` on the incoming state and key the container so React remounts it cleanly.

```tsx
<AnimateIn key={activeTab} variant="fade">
  <ActivePanel tab={activeTab} />
</AnimateIn>
```

### Page-to-page transition

Use the built-in `view-transition` support. Do not add a second route-transition system on top.

Keep page transitions route-level: pathname changes can animate; same-path query/hash/state updates must update instantly. If a page stores filters or table state in the URL with `nuqs`, do not add route-specific transition exceptions. Use the centralized policy in `apps/web/src/lib/view-transition-policy.ts`.

### Count-up / ticker / typewriter

These are JS-driven, so they must check `useReducedMotion()` and fall back to a static end state when motion should be reduced.

```tsx
const reduceMotion = useReducedMotion();
const displayedValue = reduceMotion ? value : animatedValue;
```

## Scroll

Use these when the user asks for "scroll reveal", "fade in on scroll", "sticky header settles", or "parallax".

### "Scroll reveal"

This stack does not ship a dedicated scroll-reveal component. The safe default is:

- Use `AnimateIn` for above-the-fold or immediately mounted content
- For below-the-fold reveals, only add JS if the feature truly benefits from it, and gate it with `useReducedMotion()`
- Keep the reveal simple: fade, slide-up, or pop

If you build a one-off reveal, use `IntersectionObserver` inside a custom hook in `apps/web/src/hooks/`, not a direct `useEffect` in a route/component file.

### Sticky header / scroll-state polish

Prefer tiny opacity, backdrop, shadow, or translate changes. Keep them subtle and avoid continuous large-motion effects tied to scroll position.

### Parallax

Use sparingly. It is easy to overdo, expensive on low-end phones, and must disable under `prefers-reduced-motion`. Usually the right answer in this template is "don't add parallax unless the user explicitly wants it."

## Feedback & Interaction

Use these when the user asks for "tap feedback", "success feedback", "error shake", or "make it feel more native".

### Tap / press feedback

Combine:

- a tiny transform change such as `active:scale-[0.98]`
- a short `transition-transform duration-[var(--duration-fast)]`

### Success / error feedback

- success: toast/banner
- error: inline error state

### Selection change

For tabs, segmented controls, or toggles, use short color/transform transitions.

### "Shake" / "wiggle"

Not a shipped primitive. If needed, keep it brief, only for validation/error emphasis, and disable it for reduced motion. Do not turn every invalid field into a constantly animated state.

## Easing

Use this when the user asks for "springy", "gentle", "snappy", "smooth", "ease out", or "ease in".

- `ease-out`: the default for most entrances, exits, and interaction feedback
- `ease-in-out`: good for balanced state changes
- `ease-emphasized`: stronger emphasis without feeling bouncy
- `ease-spring`: the closest shipped approximation to "springy" or "bouncy"

Important: `ease-spring` is still just a cubic-bezier. It is not true spring physics, does not carry velocity, and does not respond to interruption like a physics engine.

## Looping & Ambient Motion

Use these when the user asks for "pulse", "shimmer", "breathing", "idle motion", or "ambient movement".

### Loading shimmer

Use `<Skeleton variant="shimmer" />` for content placeholders. This is the shipped shimmer recipe.

```tsx
<Skeleton variant="shimmer" className="h-10 w-full rounded-md" />
```

### Pulse

Use `<Skeleton variant="pulse" />` or `animate-pulse` for simple loading placeholders.

### Ambient floating / breathing

Keep ambient motion rare and subtle. Use long durations, low amplitude transforms, and always verify that the motion still feels acceptable when reduced motion is enabled.

For most product UI in this template, ambient motion should be the exception, not the default.

## Polish & Effects

Use these when the user asks for "smooth polish", "shimmer", "glass blur settles in", "highlight the active thing", or "make this feel more premium".

### Shimmer

Use the shipped `Skeleton` shimmer for loading placeholders. Do not invent new shimmer systems unless the design genuinely needs a different shape.

### Blur / fade polish

The overlay components already pair subtle backdrop blur with `animate-in` / `animate-out`. Reuse those components instead of rebuilding blur-and-fade combinations.

### Active highlight / focus movement

Prefer animating opacity, color, transform, or background-position instead of layout. Keep focus rings instant and visible; do not make focus states slow or hard to track.

## Performance

Treat these as hard rules, not suggestions.

- Animate `transform` and `opacity` first.
- Avoid animating layout on frequent interactions.
- Avoid huge distances; most good UI motion moves only a few pixels.
- Use `will-change` only for a specific element that shows subpixel jitter during animation, as described in [design-system.md](./design-system.md).
- Do not stack many simultaneous infinite animations.
- Test on mobile-sized viewports; this is a mobile-first PWA.
- Respect `prefers-reduced-motion` everywhere.

## Needs A Library — Not Shipped

These terms are **not** provided by this template out of the box. Do not fake them with misleading claims. If the feature truly needs one of these, stop and follow the package-install workflow in [agent-tooling.md](./agent-tooling.md#installing-a-new-pnpm-package) before adding a dependency such as `motion`.

- **Spring physics**: stiffness, tension, damping, mass, bounce, overshoot driven by a physics solver
  Closest shipped approximation: `ease-spring` on a short scale/translate animation
- **Layout animation / FLIP**: animating an element from its old layout box to its new one
  Closest shipped approximation: fade/slide the new state in, or rely on page `view-transition` between full-page navigations
- **Shared-element transition beyond page view transitions**: one specific card/image/button morphing into its counterpart on the next screen
  Closest shipped approximation: the existing page `view-transition` system for whole-page transitions only
- **Morphing**: one shape/path smoothly becoming another
  Closest shipped approximation: cross-fade, scale, or swap states
- **Drag**, **drag-to-reorder**, **swipe-to-dismiss with momentum**, **rubber-banding**
  Closest shipped approximation: none worth pretending is equivalent
- **Interruptible / velocity-carrying motion**
  Closest shipped approximation: none; CSS timing curves do not preserve velocity across interruptions

## Quick Map: user words -> stack recipe

- "pop in" -> `<AnimateIn variant="pop" />`
- "fade in" -> `<AnimateIn variant="fade" />`
- "slide up" -> `<AnimateIn variant="slide-up" />`
- "stagger" -> `<Stagger childVariant="slide-up" stepMs={50} />`
- "scroll reveal" -> custom hook + `IntersectionObserver` only if needed; otherwise use normal entrance animation
- "spring" -> `ease-spring` if an approximation is acceptable; otherwise this **needs a library**
- "page transition" -> shipped `view-transition` for pathname changes only
- "direction-aware transition" -> shipped `use-nav-direction.ts` + `view-transition`
- "tap feedback" -> `active:` transform
- "loading shimmer" -> `<Skeleton variant="shimmer" />`

## Decision Rules For Agents

When the user's request is ambiguous:

1. Default to the simplest shipped primitive that matches the vocabulary.
2. Use shorter durations for repeated interactions.
3. Prefer `AnimateIn`, `Stagger`, overlay built-ins, `view-transition`, and `Skeleton` before inventing custom animation code.
4. If the request implies physics, layout interpolation, drag momentum, or shared-element choreography, say that the template does not ship that capability and ask before installing a library.
