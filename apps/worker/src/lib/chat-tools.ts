import { type AgentTool, defineTool, wrapUntrustedContent } from "@starter/agent-runtime";
import { env } from "@starter/env/shared";
import { z } from "zod";

import { buildExploreSessionBundle } from "./explore/session.js";

/**
 * THE TOOL SEAM for durable chat.
 *
 * `buildChatTools()` is the single place a consuming project registers the tools
 * its chat agent can call. The template ships one deliberately boring default
 * (`current_time`) so the seam is exercised end to end — a real tool call, a
 * real tool result, rendered by the UI — without pretending to know what your
 * product's agent should be able to do.
 *
 * When `CHAT_EXPLORE_ROOT` is set, the validated explore stack is registered
 * (map + examples-first + optional `delegate_explore`). See
 * patterns/explore-investigation.md.
 */

/** The shape `buildChatTools` needs from a ChatSession row. */
export type ChatToolSession = {
  id: string;
  ownerId: string;
};

export type ChatToolBundle = {
  tools: AgentTool[];
  /** Extra system-prompt sections (repo map, explore workflow). */
  systemPromptAddon?: string;
};

/**
 * Define a tool whose result is untrusted source material — anything authored
 * outside your system that a prompt-injection payload could be hiding in.
 *
 * This does BOTH halves of the defense together, because doing one without the
 * other is the actual failure mode:
 *
 *   1. Wraps the body in the runtime's untrusted-content markers, so the model
 *      can see where attacker-controlled text starts and stops. Paired with the
 *      rules `buildChatSystemPrompt` injects (see chat-prompts.ts), that is what
 *      tells the model to treat the span as data, never instructions.
 *   2. Sets `untrusted: true`, which makes the runtime re-wrap every slice
 *      returned by `retrieve_tool_result` when the body overflows into the
 *      result store — otherwise a large page's tail would come back unmarked
 *      and the defense would silently end at the truncation point.
 *
 * `execute` returns the raw text; the wrapping is applied here so a tool author
 * cannot forget it.
 */
export function defineUntrustedTool<TSchema extends z.ZodType>(options: {
  name: string;
  description: string;
  inputSchema: TSchema;
  /**
   * Resolve the untrusted text plus a provenance label shown to the model.
   * The run's `AbortSignal` is forwarded as a second argument — an untrusted
   * tool is almost always a network fetch, which is exactly the case worth
   * cancelling when the run's deadline elapses.
   */
  execute: (
    input: z.output<TSchema>,
    signal: AbortSignal,
  ) => Promise<{ content: string; sourceUrl: string }>;
  maxResultChars?: number;
}): AgentTool<TSchema> {
  return defineTool({
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema,
    maxResultChars: options.maxResultChars,
    untrusted: true,
    execute: async (input, signal) => {
      const { content, sourceUrl } = await options.execute(input, signal);
      return wrapUntrustedContent(content, { sourceUrl });
    },
  });
}

/**
 * Models have no clock — left to itself an agent will answer "today" with its
 * training cutoff. Cheap, side-effect-free, and useful in almost any product,
 * which is what makes it a reasonable default rather than a placeholder.
 */
const currentTimeTool = defineTool({
  name: "current_time",
  description:
    "Get the current date and time in UTC as an ISO-8601 timestamp. Use this whenever the answer depends on what 'now' is.",
  inputSchema: z.object({}),
  execute: () => ({ iso: new Date().toISOString(), timeZone: "UTC" }),
});

/**
 * Tools (+ optional explore system-prompt addon) for one chat session.
 */
export function buildChatTools(_session: ChatToolSession): Promise<ChatToolBundle> {
  const tools: AgentTool[] = [currentTimeTool];
  let systemPromptAddon: string | undefined;
  const exploreRoot = env.CHAT_EXPLORE_ROOT?.trim();
  if (exploreRoot) {
    try {
      const explore = buildExploreSessionBundle(exploreRoot);
      tools.push(...explore.tools);
      systemPromptAddon = explore.systemPromptAddon;
    } catch (error) {
      console.warn(
        "[chat-tools] CHAT_EXPLORE_ROOT is set but explore tools could not be registered:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  return Promise.resolve({ tools, systemPromptAddon });
}
