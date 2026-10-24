# React Hooks & Effects

The two React discipline rules in this repo — **hooks at the top level** and **no raw `useEffect` in component files** — with the worked examples, the replacement table, and the smell tests. The one-line rules and the enforceable guardrail live in AGENTS.md; this is the detail.

CI enforces both: Biome's `correctness/useHookAtTopLevel` (`pnpm lint`) for hook order, and the `useEffect` ban via the `apps/web/src/components/**` + `apps/web/src/routes/**` audit.

## Rules of Hooks — call order must be stable

Hooks must be called in the same order on every render. The most common break is an early return *above* a hook call:

```tsx
// ❌ BROKEN — `useQuery` is skipped when `id` is missing, so the hook order
//    changes between renders and React will throw or silently corrupt state.
function Profile({ id }: { id?: string }) {
  if (!id) return <Empty />;
  const { data } = useQuery(orpc.user.get.queryOptions({ input: { id } }));
  return <div>{data?.name}</div>;
}

// ✅ Correct — all hooks run unconditionally; branch on the result instead.
function Profile({ id }: { id?: string }) {
  const { data } = useQuery({
    ...orpc.user.get.queryOptions({ input: { id: id ?? "" } }),
    enabled: !!id, // or use `skipToken`
  });
  if (!id) return <Empty />;
  return <div>{data?.name}</div>;
}
```

- Every `use*` call must appear at the top of the component, *before* any `if (...) return`, `throw`, `?:` short-circuit, loop, or nested function.
- Use `enabled` / `skipToken` (TanStack Query) for conditional fetching — never gate the `useQuery` call itself. See [data-fetching.md](./data-fetching.md).
- If a component genuinely needs different hooks for different states, split it into two components and pick which one to render.

Do not disable Biome's `correctness/useHookAtTopLevel` without discussion.

## useEffect Policy — banned in component files

**Direct `useEffect` calls are banned in component files.** Most `useEffect` usage compensates for something React already gives better primitives for.

### Approved escape hatches

1. **`useMountEffect()`** — one-time external sync on mount (defined in `apps/web/src/hooks/use-mount-effect.ts`). This is `useEffect(fn, [])` wrapped in a named hook.
2. **Custom hooks** — `useEffect` inside a purpose-built hook (`useStickToBottom`, `useThemeColorMeta`, `useMobileKeyboard`, etc.) is acceptable when it truly syncs with an external system. Custom hooks in `apps/web/src/hooks/` are exempt — they are the approved encapsulation boundary.
3. **Existing code** — legacy `useEffect` calls are tracked for removal. New code must not add more.

### Five patterns that replace useEffect

| Instead of… | Do this |
|---|---|
| `useEffect(() => setX(derive(y)), [y])` | Compute inline: `const x = derive(y)` or `useMemo` |
| `useEffect(() => { fetch(url)... }, [url])` | `useQuery` (TanStack Query) |
| `useEffect(() => { if (flag) { doAction(); setFlag(false) } }, [flag])` | Call `doAction()` in the event handler |
| `useEffect(() => { setLocalState(init) }, [propId])` | Use `key={propId}` to force remount |
| `useEffect(() => { setup(); return cleanup }, [])` | `useMountEffect(() => { setup(); return () => cleanup() })` |

### Smell tests — stop and refactor if you see

- `useEffect(() => setX(...), [y])` — derived state, compute inline
- State that only mirrors other state or props — redundant, remove it
- `fetch()` + `setState()` inside an effect — use `useQuery`
- "set flag → effect runs → reset flag" choreography — call from event handler
- Effect whose only job is resetting state when an ID/prop changes — use `key`
- Dependency arrays longer than 3 items — effect is doing too much, decompose

### Guardrail — refactor away or tag as audited

Every `useEffect` call in `apps/web/src/components/**` and `apps/web/src/routes/**` must be either:

1. **Refactored away** (preferred) — use the five patterns above.
2. **Tagged as audited** — add a comment on the line immediately before:

```ts
// effect:audited — <reason>
useEffect(() => { ... }, [...]);
```
