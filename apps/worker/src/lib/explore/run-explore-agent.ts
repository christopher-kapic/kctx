import {
  type AgentLoopResult,
  type AgentMessage,
  type AgentTool,
  type AgentUsage,
  defineTool,
  runAgentLoop,
} from "@starter/agent-runtime";
import { z } from "zod";

import { buildChatSystemPrompt, EXPLORE_SYSTEM_PROMPT } from "../chat-prompts.js";
import { formatRepoMapForPrompt, generateRepoMap, type RepoMap } from "./repo-map.js";
import { buildExploreTools } from "./tools.js";

export type ExploreAgentOptions = {
  /** Absolute path to the dependency / codebase checkout. */
  root: string;
  /** Usage / investigation question. */
  question: string;
  /** Optional package context (kctxHelper-style notes). */
  packageContext?: string;
  apiKey: string;
  model?: string;
  maxIterations?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Prefer examples/docs before deep src exploration. */
  examplesFirst?: boolean;
  /**
   * Inject a precomputed repo map, generate one when `true` / omitted (default),
   * or skip when `false`.
   */
  repoMap?: RepoMap | boolean;
  /** When the loop stops on max-iterations/timeout, run a no-tool synthesis turn. */
  forceFinalAnswer?: boolean;
  /**
   * Master-agent mode: register `delegate_explore` so the model can fan out
   * read-only leaf scouts mid-flight (they do not get delegation themselves).
   */
  allowDelegation?: boolean;
  /** Max parallel leaf agents per delegate_explore call. */
  maxDelegateAgents?: number;
  /** Iteration budget for each leaf scout. */
  delegateMaxIterations?: number;
};

export const EXAMPLES_FIRST_PROMPT = `Workflow priority for usage questions:
1. Check README and paths under examplePaths / docs from the repo map (or glob \`examples/**\`, \`docs/**\`).
2. Only then search package source for the public API.
3. Stop as soon as you can cite a real example or export — do not explore beyond the brief.`;

export const MASTER_DELEGATE_PROMPT = `You are the master investigator for this query. Explore with glob/grep/read yourself first.

Use \`delegate_explore\` ONLY when parallel investigation of *different* subtrees would clearly help — e.g. a large monorepo question that spans docs + multiple packages, or after you discover the answer is split across distant areas. Pass 2–4 focused leaf briefs (different paths/concerns). Do NOT delegate a question you can finish with a few local tool calls.

Leaf agents are read-only and cannot delegate further. You synthesize their reports into the final answer and may verify with your own tools.`;

/**
 * One-shot dependency investigation against a confined source tree.
 */
export async function runExploreAgent(
  options: ExploreAgentOptions,
): Promise<AgentLoopResult & { map?: RepoMap; forcedFinal?: boolean; delegateCalls?: number }> {
  // Recommended defaults from lever + A/B/C experiments (see patterns/explore-investigation.md).
  const examplesFirst = options.examplesFirst ?? true;
  const forceFinalAnswer = options.forceFinalAnswer ?? true;
  const allowDelegation = options.allowDelegation ?? true;

  const map = resolveMap(options);
  const tools: AgentTool[] = [...buildExploreTools(options.root)];
  let delegateCalls = 0;

  if (allowDelegation) {
    tools.push(
      buildDelegateExploreTool({
        root: options.root,
        apiKey: options.apiKey,
        model: options.model,
        map,
        abortSignal: options.abortSignal,
        maxAgents: options.maxDelegateAgents ?? 3,
        delegateMaxIterations: options.delegateMaxIterations ?? 6,
        onDelegate: () => {
          delegateCalls += 1;
        },
      }),
    );
  }

  let systemPrompt = buildChatSystemPrompt(tools);
  if (map) {
    systemPrompt = `${systemPrompt}\n\n## Repo map (authoritative orientation; still verify with tools)\n\`\`\`json\n${formatRepoMapForPrompt(map)}\n\`\`\``;
  }
  if (examplesFirst) {
    systemPrompt = `${systemPrompt}\n\n${EXAMPLES_FIRST_PROMPT}`;
  }
  if (allowDelegation) {
    systemPrompt = `${systemPrompt}\n\n${MASTER_DELEGATE_PROMPT}`;
  }

  let userText = options.question.trim();
  if (options.packageContext?.trim()) {
    userText = `Context about this package:\n${options.packageContext.trim()}\n\n${userText}`;
  }

  const messages: AgentMessage[] = [
    {
      id: "explore-user-1",
      role: "user",
      parts: [{ type: "text", content: userText }],
    },
  ];

  const model = {
    provider: "openrouter" as const,
    model: options.model ?? "anthropic/claude-sonnet-4-5",
    apiKey: options.apiKey,
  };

  let result = await runAgentLoop({
    model,
    systemPrompt,
    messages,
    tools,
    maxIterations: options.maxIterations ?? 12,
    timeoutMs: options.timeoutMs ?? 180_000,
    abortSignal: options.abortSignal,
  });

  let forcedFinal = false;
  if (
    forceFinalAnswer &&
    (result.stopReason === "max-iterations" || result.stopReason === "timeout")
  ) {
    forcedFinal = true;
    const synthesis = await runAgentLoop({
      model,
      systemPrompt: `${EXPLORE_SYSTEM_PROMPT}\n\nYou must now produce the best final answer possible from the investigation transcript below. Do not claim tools you cannot call. If evidence is incomplete, say what you found and what is still unknown. Cite file:line when possible.`,
      messages: [
        ...result.messages,
        {
          id: "explore-force-final",
          role: "user",
          parts: [
            {
              type: "text",
              content:
                "The investigation budget ended. Write the final user-facing answer now from what you already learned.",
            },
          ],
        },
      ],
      tools: [],
      maxIterations: 1,
      timeoutMs: Math.min(options.timeoutMs ?? 180_000, 90_000),
      abortSignal: options.abortSignal,
    });
    result = {
      ...synthesis,
      stopReason: result.stopReason,
      usage: sumUsage(result.usage, synthesis.usage),
      messages: [...result.messages, ...synthesis.messages.filter((m) => m.role === "assistant")],
    };
  }

  return { ...result, map, forcedFinal, delegateCalls };
}

/**
 * Variant B: dedicated 1-turn planner chooses direct vs upfront parallel scouts.
 * Cannot change its mind later.
 */
export async function runExploreAgentWithPlanner(options: ExploreAgentOptions): Promise<
  AgentLoopResult & {
    map?: RepoMap;
    forcedFinal?: boolean;
    plan?: PlannerDecision;
    plannerMs?: number;
    scoutMs?: number;
  }
> {
  const map = resolveMap(options) ?? generateRepoMap(options.root);
  const plannerStarted = Date.now();
  const plan = await planExploreStrategy({
    question: options.question,
    map,
    apiKey: options.apiKey,
    model: options.model,
    abortSignal: options.abortSignal,
  });
  const plannerMs = Date.now() - plannerStarted;

  if (plan.strategy === "scouts" && plan.scouts.length >= 2) {
    const scoutStarted = Date.now();
    const scoutResults = await Promise.all(
      plan.scouts.slice(0, 4).map((scout) =>
        runExploreAgent({
          root: options.root,
          question: `Scout focus: ${scout.focus}\n\n${scout.question}`,
          packageContext: options.packageContext,
          apiKey: options.apiKey,
          model: options.model,
          maxIterations: options.delegateMaxIterations ?? 6,
          timeoutMs: Math.min(options.timeoutMs ?? 180_000, 90_000),
          abortSignal: options.abortSignal,
          examplesFirst: true,
          repoMap: map,
          forceFinalAnswer: true,
          allowDelegation: false,
        }),
      ),
    );
    const scoutMs = Date.now() - scoutStarted;
    const evidence = scoutResults
      .map(
        (result, index) =>
          `## Scout ${index + 1}: ${plan.scouts[index]?.focus}\n${exploreAgentAnswer(result) || "(empty)"}`,
      )
      .join("\n\n");

    const finalResult = await runExploreAgent({
      ...options,
      repoMap: map,
      examplesFirst: true,
      forceFinalAnswer: options.forceFinalAnswer ?? true,
      allowDelegation: false,
      question: `${options.question}\n\nPlanner chose parallel scouts. Evidence:\n\n${evidence}\n\nSynthesize the final answer; verify with tools only if critical gaps remain.`,
    });

    return {
      ...finalResult,
      map,
      plan,
      plannerMs,
      scoutMs,
      usage: scoutResults.reduce(
        (acc, result) => sumUsage(acc, result.usage),
        sumUsage({ inputTokens: 0, outputTokens: 0 }, finalResult.usage),
      ),
    };
  }

  const direct = await runExploreAgent({
    ...options,
    repoMap: map,
    examplesFirst: true,
    forceFinalAnswer: options.forceFinalAnswer ?? true,
    allowDelegation: false,
  });
  return { ...direct, map, plan, plannerMs };
}

/** Fixed upfront scouts (legacy experiment variant). */
export async function runExploreAgentWithScouts(
  options: ExploreAgentOptions,
): Promise<AgentLoopResult & { map?: RepoMap; forcedFinal?: boolean; scoutMs: number }> {
  const map = resolveMap(options) ?? generateRepoMap(options.root);

  const scoutStarted = Date.now();
  const shared = {
    root: options.root,
    apiKey: options.apiKey,
    model: options.model,
    maxIterations: Math.min(options.maxIterations ?? 12, 6),
    timeoutMs: Math.min(options.timeoutMs ?? 180_000, 90_000),
    abortSignal: options.abortSignal,
    examplesFirst: true,
    repoMap: map,
    forceFinalAnswer: true,
    allowDelegation: false,
  };

  const [examplesScout, apiScout] = await Promise.all([
    runExploreAgent({
      ...shared,
      question: `Scout only. Question: ${options.question}\n\nSearch README/examples/docs only. Return bullet findings with file:line. No final tutorial — just evidence.`,
      packageContext: options.packageContext,
    }),
    runExploreAgent({
      ...shared,
      question: `Scout only. Question: ${options.question}\n\nSearch public API source (package exports, lib entrypoints). Return bullet findings with file:line. No final tutorial — just evidence.`,
      packageContext: options.packageContext,
    }),
  ]);
  const scoutMs = Date.now() - scoutStarted;

  const evidence = [
    "## Examples/docs scout",
    exploreAgentAnswer(examplesScout) || "(no text)",
    "",
    "## API/source scout",
    exploreAgentAnswer(apiScout) || "(no text)",
  ].join("\n");

  const finalResult = await runExploreAgent({
    ...options,
    repoMap: map,
    examplesFirst: true,
    forceFinalAnswer: options.forceFinalAnswer ?? true,
    allowDelegation: false,
    maxIterations: Math.min(options.maxIterations ?? 12, 8),
    question: `${options.question}\n\nUse the scout evidence below; verify with tools only if something critical is missing.\n\n${evidence}`,
  });

  return {
    ...finalResult,
    map,
    scoutMs,
    usage: sumUsage(sumUsage(examplesScout.usage, apiScout.usage), finalResult.usage),
  };
}

export type PlannerDecision = {
  strategy: "direct" | "scouts";
  reason: string;
  scouts: Array<{ focus: string; question: string }>;
};

async function planExploreStrategy(options: {
  question: string;
  map: RepoMap;
  apiKey: string;
  model?: string;
  abortSignal?: AbortSignal;
}): Promise<PlannerDecision> {
  const result = await runAgentLoop({
    model: {
      provider: "openrouter",
      model: options.model ?? "anthropic/claude-sonnet-4-5",
      apiKey: options.apiKey,
    },
    systemPrompt: `You are a planner for a read-only codebase investigation agent. Given a repo map and user question, choose:
- "direct" — one agent can answer without parallel fan-out
- "scouts" — need 2-4 parallel leaf scouts on different subtrees

Reply with ONLY JSON:
{"strategy":"direct"|"scouts","reason":"...","scouts":[{"focus":"path or concern","question":"brief"}]}
If strategy is direct, scouts must be [].`,
    messages: [
      {
        id: "plan-1",
        role: "user",
        parts: [
          {
            type: "text",
            content: `Question:\n${options.question}\n\nRepo map:\n${formatRepoMapForPrompt(options.map, 4000)}`,
          },
        ],
      },
    ],
    tools: [],
    maxIterations: 1,
    timeoutMs: 60_000,
    abortSignal: options.abortSignal,
  });

  const text = exploreAgentAnswer(result);
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1)) as PlannerDecision;
      if (parsed.strategy === "direct" || parsed.strategy === "scouts") {
        return {
          strategy: parsed.strategy,
          reason: String(parsed.reason ?? ""),
          scouts: Array.isArray(parsed.scouts) ? parsed.scouts : [],
        };
      }
    }
  } catch {
    // fall through
  }
  return { strategy: "direct", reason: "planner parse failed; defaulting to direct", scouts: [] };
}

export function buildDelegateExploreTool(options: {
  root: string;
  apiKey: string;
  model?: string;
  map?: RepoMap;
  abortSignal?: AbortSignal;
  maxAgents: number;
  delegateMaxIterations: number;
  onDelegate?: () => void;
}): AgentTool {
  return defineTool({
    name: "delegate_explore",
    description:
      "Run 2–4 read-only leaf explore agents in parallel on different focuses, then return their reports. Use only when fan-out across distant subtrees would help. Leaves cannot delegate.",
    inputSchema: z.object({
      agents: z
        .array(
          z.object({
            focus: z
              .string()
              .min(1)
              .describe("Subtree or concern, e.g. docs/01-app or packages/next"),
            question: z.string().min(1).describe("Self-contained brief for that leaf"),
          }),
        )
        .min(2)
        .max(4),
    }),
    maxResultChars: 24_000,
    execute: async ({ agents }) => {
      options.onDelegate?.();
      const limited = agents.slice(0, options.maxAgents);
      const results = await Promise.all(
        limited.map(async (agent) => {
          const leaf = await runExploreAgent({
            root: options.root,
            question: `Focus: ${agent.focus}\n\n${agent.question}\n\nReturn bullet findings with file:line. No long tutorial.`,
            apiKey: options.apiKey,
            model: options.model,
            maxIterations: options.delegateMaxIterations,
            timeoutMs: 90_000,
            abortSignal: options.abortSignal,
            examplesFirst: true,
            repoMap: options.map,
            forceFinalAnswer: true,
            allowDelegation: false,
          });
          return {
            focus: agent.focus,
            stopReason: leaf.stopReason,
            report: exploreAgentAnswer(leaf) || "(empty)",
            usage: leaf.usage,
          };
        }),
      );
      return { parallel: true, agents: results };
    },
  });
}

function resolveMap(options: ExploreAgentOptions): RepoMap | undefined {
  if (options.repoMap === false) return undefined;
  if (options.repoMap === true || options.repoMap === undefined) {
    return generateRepoMap(options.root);
  }
  return options.repoMap;
}

/** Pull the final assistant text out of a completed explore run. */
export function exploreAgentAnswer(result: AgentLoopResult): string {
  for (let index = result.messages.length - 1; index >= 0; index--) {
    const message = result.messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.parts
      .filter((part): part is { type: "text"; content: string } => part.type === "text")
      .map((part) => part.content)
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

function sumUsage(a?: AgentUsage, b?: AgentUsage): AgentUsage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    cachedInputTokens: (a?.cachedInputTokens ?? 0) + (b?.cachedInputTokens ?? 0),
    cacheCreationInputTokens:
      (a?.cacheCreationInputTokens ?? 0) + (b?.cacheCreationInputTokens ?? 0),
    costUsd:
      a?.costUsd !== undefined || b?.costUsd !== undefined
        ? (a?.costUsd ?? 0) + (b?.costUsd ?? 0)
        : undefined,
    model: b?.model ?? a?.model,
  };
}
