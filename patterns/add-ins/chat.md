# Add-in: Durable agentic chat

The template ships a resumable, streaming chat agent as an **opt-in add-in**: a `ChatSession` / `ChatMessage` schema, a `chat` oRPC router, a Hono SSE endpoint with `Last-event-ID` replay, a process-wide Redis subscriber, and a BullMQ `chat-run` worker that drives `@starter/agent-runtime`.

**It ships dormant and is safe to ignore.** Chat runs only when `CHAT_ENABLED=true` **and** `OPENROUTER_API_KEY` is set. With either missing, `chat.createSession` / `send` / `retry` return `SERVICE_UNAVAILABLE`, `chat.config` reports `{ enabled: false }`, the nav entry disappears, and the `/{lang}/chat` page renders an explanation instead of a composer. Unused, it costs a dormant table pair, one inactive queue, and three rate-limit buckets — nothing runs and nothing spends.

## Turning it on (it ships off)

One line, because the API key is the real dependency and `S3_BUCKET`-style key-derived enablement is the template's opt-in idiom:

```bash
CHAT_ENABLED=true
```

Why two conditions rather than one: the key alone must not be enough, because it is shared with translation runs — every existing app that configured OpenRouter to translate content would otherwise gain a user-facing chat page and a paid tool-calling loop for every signed-in user, on the deploy that merely pulled this template forward. A flag whose wrong value silently spends money defaults to off. To turn a running deployment back off, set `CHAT_ENABLED=false` and redeploy; turns already in the queue are released as `ERROR` rather than dispatched, so the switch stops committed spend too.

The twelve `CHAT_*` / `RESULT_STORE_*` / `RATE_LIMIT_CHAT_*` variables all have schema defaults — see `packages/env/src/vars/shared.ts` and `apps/server/src/rate-limit.ts`. After enabling, set `OPENROUTER_API_KEY` (or Anthropic) and make sure the worker is running.

## Before enabling chat for real users

Complete [launch-readiness](../launch-readiness.md). Keep the translated disclosure in `apps/web/src/routes/$lang/_app/_auth/chat.tsx` visible before the first message and throughout the conversation; do not replace it with model-generated self-identification. It tells users the assistant is AI, can make mistakes, and sends their messages to an AI provider.

The worker sends conversation context through OpenRouter to the configured model provider (`apps/worker/src/handlers/chat-run.ts`). Inventory those providers, persisted conversations, Redis tool results, and each tool's data flows and permissions. Resolve retention/deletion and vendor settings with the owner, then reflect the actual behavior in the privacy notice. A chat flag and API key are technical prerequisites, not approval to transfer sensitive data. Child-facing, companion, or regulated-advice products require additional applicability review; a generic AI notice is not enough.

## What it is

- **Postgres is authoritative; Redis pub/sub is best-effort.** Every assistant turn is written under a monotonic per-session `seq` before it is published, and the SSE endpoint replays from a cursor on connect — a browser refresh, a sleeping laptop, a killed proxy, or a server restart costs nothing.
- **The tool seam.** `apps/worker/src/lib/chat-tools.ts` is where a consuming project registers what its agent can do, including the `defineUntrustedTool` prompt-injection defense.
- **Spend control.** A fail-closed per-user spend bucket on sends and a separate session-creation bucket live in `packages/api/src/lib/chat-rate-limit.ts`, plus the server-side stream limiter.

Full engineering reference: [durable-streaming.md](../durable-streaming.md) (the replay contract), [agent-runtime.md](../agent-runtime.md) (the loop), and the comments in `apps/worker/src/handlers/chat-run.ts` / `apps/server/src/chat-routes.ts`.

## Removal is a custom-fork decision

There is no maintained removal recipe: the feature is deliberately cheap to leave dormant. If your fork must delete it, that is your own reviewed change — the inventory to unwind is the schema pair, the router, the two server modules, the two workers (`chat-run`, `reap-stale-chat-runs`) with their queue/scheduler wiring, the web page/components/hooks, the `chat` locale namespace, the twelve env vars, and the `chat.*` baseline rows in `scripts/access-matrix-pre-notes-baseline.json`.
