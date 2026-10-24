import type { HTTPClient } from "@openrouter/sdk";

/**
 * Anthropic prompt-cache breakpoint injection for the Anthropic-via-OpenRouter path.
 *
 * `@tanstack/ai-openrouter` serializes the request through the OpenRouter SDK, which
 * strips any unknown fields (like `cache_control`) via its outbound zod schema before
 * the payload reaches the wire. The only place the fully-serialized JSON body is still
 * mutable — and past the schema — is the SDK's `HTTPClient.beforeRequest` hook, so we
 * attach the breakpoints there.
 *
 * For Anthropic, a `cache_control: { type: "ephemeral" }` breakpoint caches everything in
 * the prompt prefix up to and including the marked block. We mark the stable prefix:
 *   1. the tool-schema block (the last tool definition, which covers all tool schemas), and
 *   2. the system block (the system message),
 * which together are byte-identical across sibling nodes once the worker moved the
 * variable per-task bindings into a trailing context message.
 */

const CACHE_CONTROL = { type: "ephemeral" } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Attach `cache_control` to a chat message. String content is promoted to a single text
 * part carrying the breakpoint; array content gets the breakpoint on its last text part.
 * Returns whether a breakpoint was added.
 */
const applyCacheControlToMessage = (message: Record<string, unknown>): boolean => {
  const content = message.content;
  if (typeof content === "string") {
    if (content.length === 0) return false;
    message.content = [{ type: "text", text: content, cache_control: { ...CACHE_CONTROL } }];
    return true;
  }
  if (Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i -= 1) {
      const part = content[i];
      if (isRecord(part) && part.type === "text") {
        part.cache_control = { ...CACHE_CONTROL };
        return true;
      }
    }
  }
  return false;
};

/**
 * Mutate an OpenAI-compatible chat-completions request body in place, attaching Anthropic
 * `cache_control` breakpoints to the system block and the final tool schema. Tolerant of
 * any shape — returns `false` and changes nothing on unexpected input. Returns `true` when
 * at least one breakpoint was added.
 */
export const injectAnthropicCacheBreakpoints = (body: unknown): boolean => {
  if (!isRecord(body)) return false;
  let changed = false;

  const messages = body.messages;
  if (Array.isArray(messages)) {
    const system = messages.find(
      (message): message is Record<string, unknown> =>
        isRecord(message) && message.role === "system",
    );
    if (system) changed = applyCacheControlToMessage(system) || changed;
  }

  const tools = body.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const lastTool = tools[tools.length - 1];
    if (isRecord(lastTool)) {
      lastTool.cache_control = { ...CACHE_CONTROL };
      changed = true;
    }
  }

  return changed;
};

/**
 * A `beforeRequest` hook that rewrites the outgoing JSON body with Anthropic cache
 * breakpoints. No-ops (returns `undefined`, leaving the request untouched) for non-JSON or
 * unreadable bodies, or when nothing needed changing.
 */
export const createAnthropicCacheBeforeRequestHook =
  () =>
  async (request: Request): Promise<Request | undefined> => {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return undefined;

    let payload: unknown;
    try {
      payload = await request.clone().json();
    } catch {
      return undefined;
    }

    if (!injectAnthropicCacheBreakpoints(payload)) return undefined;

    // `new Request(request, { body })` copies method, headers, and signal from the
    // original and overrides only the (already-read-from-a-clone) body.
    return new Request(request, { body: JSON.stringify(payload) });
  };

/**
 * Build an OpenRouter SDK `HTTPClient` pre-wired with the Anthropic cache hook.
 * Returned as its own module boundary so `adapters.ts` never imports the SDK's hook types
 * directly.
 */
export const createAnthropicCacheHttpClient = (HttpClientCtor: typeof HTTPClient): HTTPClient => {
  const httpClient = new HttpClientCtor();
  httpClient.addHook("beforeRequest", createAnthropicCacheBeforeRequestHook());
  return httpClient;
};
