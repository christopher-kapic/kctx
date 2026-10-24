import { ORPCError } from "@orpc/server";
import { env } from "@starter/env/shared";

/**
 * Is the chat feature actually usable in this deployment?
 *
 * TWO CONDITIONS, and both are load-bearing:
 *
 *   • `OPENROUTER_API_KEY` is set. This is the real dependency — without it the
 *     worker throws on its first dispatch — and deriving enablement from the
 *     credential is the same opt-in idiom `S3_BUCKET` gives assets: no
 *     credential, no feature, and the rest of the app boots fine.
 *   • `CHAT_ENABLED` is true. The key alone must not be enough, because it is
 *     SHARED with the translation provider: without this flag, every existing app that
 *     configured OpenRouter to translate content would gain a user-facing chat
 *     page and a paid tool-calling loop for every signed-in user, on the deploy
 *     that merely pulled this template forward. It defaults to FALSE for the
 *     same reason every other feature toggle here does — turning chat on is a
 *     deliberate line in your env.
 *
 * Read at call time, never memoized at module load — these are plain env reads,
 * and a memo would only make the value harder to reason about in tests.
 */
export const chatEnabled = (): boolean => env.CHAT_ENABLED && Boolean(env.OPENROUTER_API_KEY);

/**
 * Refuse a chat procedure when the feature is off.
 *
 * SERVICE_UNAVAILABLE, not NOT_FOUND: the route exists and the caller is
 * allowed to be here — the server is not configured to serve it. That is the
 * same shape `/api/assets/*` returns when `S3_BUCKET` is unset.
 *
 * WHY THIS IS AT THE PROCEDURE BOUNDARY and not only in the UI: without it a
 * misconfigured deployment accepts the whole turn — a session row, a user
 * message, a RUNNING claim, a queued job — and only fails minutes later inside
 * the worker, where the user sees an unexplained "Response interrupted" and a
 * Retry that cannot ever succeed. Refusing at the edge turns a silent
 * misconfiguration into a legible one, and leaves no committed state behind.
 */
export function assertChatEnabled(): void {
  if (chatEnabled()) return;
  throw new ORPCError("SERVICE_UNAVAILABLE", {
    message: "Chat is not enabled on this server.",
  });
}
