/**
 * A/B/C orchestration experiment:
 *   A — direct master (map + examples + force-final, no delegation)
 *   B — 1-turn planner then direct|upfront scouts
 *   C — master with mid-flight delegate_explore (user's idea)
 *
 * OPENROUTER_API_KEY=... pnpm exec tsx scripts/experiment-abc-orchestration.ts
 */
import "@starter/env/load-dotenv";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  exploreAgentAnswer,
  runExploreAgent,
  runExploreAgentWithPlanner,
} from "../apps/worker/src/lib/explore/run-explore-agent.ts";

type Case = {
  id: string;
  repo: string;
  root: string;
  question: string;
  expectHints: string[];
};

type Variant = "A_direct" | "B_planner" | "C_master_delegate";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, "../../.scratch");
const cases = JSON.parse(fs.readFileSync(path.join(scratch, "abc-cases.json"), "utf8")) as Case[];
const outJsonl = path.join(scratch, "abc-results.jsonl");
const outMd = path.join(scratch, "abc-summary.md");

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENROUTER_API_KEY required");
  process.exit(1);
}

const model = process.env.CHAT_MODEL?.trim() || "deepseek/deepseek-v4-flash";
const variants: Variant[] = ["A_direct", "B_planner", "C_master_delegate"];

fs.writeFileSync(outJsonl, "");
fs.writeFileSync(
  outMd,
  `# A/B/C orchestration\n\nModel: \`${model}\`\nStarted: ${new Date().toISOString()}\n\n`,
);

console.log(`[abc] ${cases.length} cases × ${variants.length} · ${model}`);

for (const evalCase of cases) {
  for (const variant of variants) {
    const runId = `${evalCase.id}__${variant}`;
    console.log(`\n[abc] >>> ${runId}`);
    const started = Date.now();
    try {
      const common = {
        root: evalCase.root,
        question: evalCase.question,
        packageContext: `Repository: ${evalCase.repo}`,
        apiKey,
        model,
        maxIterations: Number(process.env.CHAT_MAX_ITERATIONS ?? 20),
        timeoutMs: Number(process.env.CHAT_RUN_TIMEOUT_MS ?? 300_000),
        repoMap: true as const,
        examplesFirst: true,
        forceFinalAnswer: true,
      };

      let result: Awaited<ReturnType<typeof runExploreAgent>> & {
        plan?: { strategy: string; reason: string };
        plannerMs?: number;
        delegateCalls?: number;
      };

      if (variant === "A_direct") {
        result = await runExploreAgent({ ...common, allowDelegation: false });
      } else if (variant === "B_planner") {
        result = await runExploreAgentWithPlanner(common);
      } else {
        result = await runExploreAgent({
          ...common,
          allowDelegation: true,
          maxDelegateAgents: 3,
          delegateMaxIterations: 6,
        });
      }

      const elapsedMs = Date.now() - started;
      const answer = exploreAgentAnswer(result);
      const toolCalls = result.messages.flatMap((m) =>
        m.parts.filter((p) => p.type === "tool-call"),
      ).length;
      const delegateToolCalls = result.messages.flatMap((m) =>
        m.parts.filter(
          (p) => p.type === "tool-call" && "name" in p && p.name === "delegate_explore",
        ),
      ).length;
      const hintsHit = evalCase.expectHints.filter((h) =>
        answer.toLowerCase().includes(h.toLowerCase()),
      );

      const row = {
        runId,
        caseId: evalCase.id,
        variant,
        stopReason: result.stopReason,
        forcedFinal: result.forcedFinal ?? false,
        elapsedMs,
        toolCalls,
        delegateToolCalls,
        delegateCalls: result.delegateCalls ?? 0,
        planStrategy: result.plan?.strategy,
        planReason: result.plan?.reason,
        plannerMs: result.plannerMs,
        hintsHit: hintsHit.length,
        hintsTotal: evalCase.expectHints.length,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
        answerPreview: answer.slice(0, 400),
        answer,
      };
      fs.appendFileSync(outJsonl, `${JSON.stringify(row)}\n`);
      fs.appendFileSync(
        outMd,
        [
          `## ${runId}`,
          "",
          `- stop=\`${row.stopReason}\` ms=${elapsedMs} tools=${toolCalls} delegateCalls=${row.delegateCalls} plan=${row.planStrategy ?? "-"} hints=${row.hintsHit}/${row.hintsTotal}`,
          `- tokens in=${row.inputTokens} out=${row.outputTokens}`,
          row.planReason ? `- plan reason: ${row.planReason}` : "",
          "",
          answer.slice(0, 1500) || "_(empty)_",
          "",
          "---",
          "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      console.log(
        `[abc] <<< ${runId} ${row.stopReason} ${elapsedMs}ms tools=${toolCalls} del=${row.delegateCalls} plan=${row.planStrategy ?? "-"} hints=${row.hintsHit}/${row.hintsTotal} in=${row.inputTokens}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fs.appendFileSync(outJsonl, `${JSON.stringify({ runId, error: message })}\n`);
      console.error(`[abc] <<< ${runId} ERROR ${message}`);
    }
  }
}

console.log(`[abc] wrote ${outMd}`);
