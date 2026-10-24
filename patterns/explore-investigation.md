# Explore / dependency investigation

Validated stack for asking usage questions against a checked-out codebase (the
in-app replacement for kctx’s OpenCode `query_dependency` path).

## Recommended defaults

| Piece | Choice |
| --- | --- |
| Tools | Confined `glob` / `grep` / `read` (+ mid-flight `delegate_explore`) |
| Orientation | Deterministic **repo map** JSON in the system prompt |
| Search order | **Examples-first** (README / examples / docs before deep `src/`) |
| Orchestration | **One master agent**; may call `delegate_explore` for parallel leaf scouts on distant subtrees |
| Reliability | High `CHAT_MAX_ITERATIONS` (default 100) + wall-clock timeout; `runExploreAgent` **force-final** synthesizes on budget exhaustion |
| Leaves | Read-only; no further delegation |

Do **not** default to: a dedicated planner turn, always-on scouts, or examples-first without a map.

## Code entrypoints

| Path | Role |
| --- | --- |
| `apps/worker/src/lib/explore/run-explore-agent.ts` | One-shot MCP-style runner (`runExploreAgent`) with best defaults |
| `apps/worker/src/lib/explore/session.ts` | Bundle for durable chat (`buildExploreSessionBundle`) |
| `apps/worker/src/lib/chat-tools.ts` | Registers explore when `CHAT_EXPLORE_ROOT` is set |
| `scripts/smoke-explore-agent.ts` | OpenRouter smoke against the sample fixture |

## Enable in chat (dev)

```bash
CHAT_ENABLED=true
OPENROUTER_API_KEY=sk-or-...
CHAT_EXPLORE_ROOT=/absolute/path/to/checkout
```

## Planned (UX / product — not in this slice)

- Per-package `clonedPath` instead of global `CHAT_EXPLORE_ROOT`
- Default-branch pull + per-sha maps + worktree prune (7d, env-configurable)
- Language-scoped LSPs with 30s idle stop
- MCP `query_dependency` + durable query ids
