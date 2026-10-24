import { type AgentTool } from "@starter/agent-runtime";
import { env } from "@starter/env/shared";
import { formatRepoMapForPrompt, generateRepoMap, type RepoMap } from "./repo-map.js";
import {
  buildDelegateExploreTool,
  EXAMPLES_FIRST_PROMPT,
  MASTER_DELEGATE_PROMPT,
} from "./run-explore-agent.js";
import { buildExploreTools } from "./tools.js";

export type ExploreSessionBundle = {
  root: string;
  map: RepoMap;
  tools: AgentTool[];
  /** Appended after {@link buildChatSystemPrompt}. */
  systemPromptAddon: string;
};

/**
 * Best-known explore stack for a checkout root:
 * confined glob/grep/read + optional mid-flight `delegate_explore`,
 * structured repo map, examples-first, master-delegate guidance.
 *
 * Used by durable chat when `CHAT_EXPLORE_ROOT` is set, and mirrors the
 * defaults of {@link runExploreAgent}.
 */
export function buildExploreSessionBundle(
  root: string,
  options: {
    apiKey?: string;
    model?: string;
    allowDelegation?: boolean;
  } = {},
): ExploreSessionBundle {
  const map = generateRepoMap(root);
  const tools: AgentTool[] = [...buildExploreTools(root)];
  const allowDelegation = options.allowDelegation !== false;
  const apiKey = options.apiKey ?? env.OPENROUTER_API_KEY;
  const model = options.model ?? env.CHAT_MODEL;

  if (allowDelegation && apiKey) {
    tools.push(
      buildDelegateExploreTool({
        root,
        apiKey,
        model,
        map,
        maxAgents: 3,
        delegateMaxIterations: 6,
      }),
    );
  }

  const addonParts = [
    `## Repo map (authoritative orientation; still verify with tools)\n\`\`\`json\n${formatRepoMapForPrompt(map)}\n\`\`\``,
    EXAMPLES_FIRST_PROMPT,
  ];
  if (allowDelegation && apiKey) {
    addonParts.push(MASTER_DELEGATE_PROMPT);
  }

  return {
    root,
    map,
    tools,
    systemPromptAddon: addonParts.join("\n\n"),
  };
}
