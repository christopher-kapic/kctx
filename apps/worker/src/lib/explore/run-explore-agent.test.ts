import { beforeEach, describe, expect, it, vi } from "vitest";

const runAgentLoop = vi.fn();

vi.mock("@starter/agent-runtime", async () => {
  const actual =
    await vi.importActual<typeof import("@starter/agent-runtime")>("@starter/agent-runtime");
  return {
    ...actual,
    runAgentLoop,
  };
});

vi.mock("./tools.js", () => ({
  buildExploreTools: () => [
    {
      name: "glob",
      description: "test",
      inputSchema: {},
      maxResultChars: 1000,
      execute: () => ({ matches: [] }),
    },
  ],
}));

vi.mock("./repo-map.js", () => ({
  generateRepoMap: () => ({
    generatedAt: "t",
    rootName: "x",
    languages: ["typescript"],
    manifests: ["package.json"],
    entrypoints: ["README.md"],
    examplePaths: ["examples"],
    docPaths: [],
    topLevel: ["src"],
    notablePackages: [],
    hints: ["Prefer examples"],
  }),
  formatRepoMapForPrompt: () => '{"rootName":"x"}',
}));

const { exploreAgentAnswer, runExploreAgent } = await import("./run-explore-agent.js");

describe("runExploreAgent", () => {
  beforeEach(() => {
    runAgentLoop.mockReset();
    runAgentLoop.mockResolvedValue({
      stopReason: "completed",
      messages: [
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", content: "Call `greet(name)` — src/greet.ts:2" }],
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  });

  it("dispatches a confined explore loop with OpenRouter", async () => {
    const result = await runExploreAgent({
      root: "/tmp/whatever",
      question: "How do I greet someone?",
      packageContext: "tiny greeting package",
      apiKey: "test-key",
      model: "anthropic/claude-haiku-4-5",
      // Opt out of defaults that need a real filesystem root / nested loops.
      repoMap: false,
      examplesFirst: false,
      allowDelegation: false,
      forceFinalAnswer: false,
    });

    expect(runAgentLoop).toHaveBeenCalledOnce();
    const options = runAgentLoop.mock.calls[0]?.[0] as {
      model: { provider: string; model: string; apiKey: string };
      messages: Array<{ parts: Array<{ content: string }> }>;
      tools: unknown[];
    };
    expect(options.model).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4-5",
      apiKey: "test-key",
    });
    expect(options.messages[0]?.parts[0]?.content).toContain("tiny greeting package");
    expect(exploreAgentAnswer(result)).toContain("greet(name)");
  });

  it("defaults to map + examples-first + delegate guidance", async () => {
    await runExploreAgent({
      root: "/tmp/whatever",
      question: "q",
      apiKey: "k",
      forceFinalAnswer: false,
    });
    const options = runAgentLoop.mock.calls[0]?.[0] as {
      systemPrompt: string;
      tools: Array<{ name: string }>;
    };
    expect(options.systemPrompt).toContain("Repo map");
    expect(options.systemPrompt).toContain("Workflow priority");
    expect(options.systemPrompt).toContain("delegate_explore");
    expect(options.tools.some((tool) => tool.name === "delegate_explore")).toBe(true);
  });

  it("force-final runs a no-tool synthesis after max-iterations", async () => {
    runAgentLoop
      .mockResolvedValueOnce({
        stopReason: "max-iterations",
        messages: [
          {
            id: "a1",
            role: "assistant",
            parts: [{ type: "text", content: "Still looking at builders…" }],
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
      })
      .mockResolvedValueOnce({
        stopReason: "completed",
        messages: [
          {
            id: "a2",
            role: "assistant",
            parts: [{ type: "text", content: "Use AgentBuilder::new(model).tool(t).build()" }],
          },
        ],
        usage: { inputTokens: 3, outputTokens: 4 },
      });

    const result = await runExploreAgent({
      root: "/tmp/whatever",
      question: "how tools?",
      apiKey: "k",
      forceFinalAnswer: true,
    });

    expect(runAgentLoop).toHaveBeenCalledTimes(2);
    expect(result.forcedFinal).toBe(true);
    expect(exploreAgentAnswer(result)).toContain("AgentBuilder");
    const synth = runAgentLoop.mock.calls[1]?.[0] as { tools: unknown[] };
    expect(synth.tools).toEqual([]);
  });
});
