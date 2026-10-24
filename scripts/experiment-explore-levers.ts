/**
 * A/B levers for explore quality/speed/cost.
 *
 * OPENROUTER_API_KEY=... pnpm exec tsx scripts/experiment-explore-levers.ts
 */
import "@starter/env/load-dotenv";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  exploreAgentAnswer,
  runExploreAgent,
  runExploreAgentWithScouts,
} from "../apps/worker/src/lib/explore/run-explore-agent.ts";

type Case = {
  id: string;
  repo: string;
  root: string;
  question: string;
  expectHints: string[];
};

type Variant =
  | "baseline"
  | "examples_first"
  | "map"
  | "map_examples"
  | "map_examples_force"
  | "scouts_map_examples";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, "../../.scratch");
const casesPath = path.join(scratch, "experiment-cases.json");
const outJsonl = path.join(scratch, "experiment-results.jsonl");
const outMd = path.join(scratch, "experiment-summary.md");

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENROUTER_API_KEY required");
  process.exit(1);
}

const model = process.env.CHAT_MODEL?.trim() || "deepseek/deepseek-v4-flash";
const variants = (process.env.EXPERIMENT_VARIANTS?.split(",").filter(Boolean) ?? [
  "baseline",
  "examples_first",
  "map",
  "map_examples",
  "map_examples_force",
  "scouts_map_examples",
]) as Variant[];

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8")) as Case[];
fs.writeFileSync(outJsonl, "");
fs.writeFileSync(
  outMd,
  `# Explore lever experiment\n\nModel: \`${model}\`\nStarted: ${new Date().toISOString()}\nVariants: ${variants.join(", ")}\n\n`,
);

console.log(`[exp] ${cases.length} cases × ${variants.length} variants · ${model}`);

for (const evalCase of cases) {
  for (const variant of variants) {
    const runId = `${evalCase.id}__${variant}`;
    console.log(`\n[exp] >>> ${runId}`);
    const started = Date.now();
    try {
      const common = {
        root: evalCase.root,
        question: evalCase.question,
        packageContext: `Repository: ${evalCase.repo}`,
        apiKey,
        model,
        maxIterations: Number(process.env.CHAT_MAX_ITERATIONS ?? 12),
        timeoutMs: Number(process.env.CHAT_RUN_TIMEOUT_MS ?? 240_000),
      };

      let result: Awaited<ReturnType<typeof runExploreAgent>> & { scoutMs?: number };
      switch (variant) {
        case "baseline":
          result = await runExploreAgent(common);
          break;
        case "examples_first":
          result = await runExploreAgent({ ...common, examplesFirst: true });
          break;
        case "map":
          result = await runExploreAgent({ ...common, repoMap: true });
          break;
        case "map_examples":
          result = await runExploreAgent({
            ...common,
            repoMap: true,
            examplesFirst: true,
          });
          break;
        case "map_examples_force":
          result = await runExploreAgent({
            ...common,
            repoMap: true,
            examplesFirst: true,
            forceFinalAnswer: true,
            // Intentionally tighter budget to exercise force-final on hard repos.
            maxIterations: Number(process.env.FORCE_MAX_ITERATIONS ?? 8),
          });
          break;
        case "scouts_map_examples":
          result = await runExploreAgentWithScouts({
            ...common,
            repoMap: true,
            examplesFirst: true,
            forceFinalAnswer: true,
          });
          break;
        default:
          throw new Error(`unknown variant ${variant}`);
      }

      const elapsedMs = Date.now() - started;
      const answer = exploreAgentAnswer(result);
      const toolCalls = result.messages.flatMap((m) =>
        m.parts.filter((p) => p.type === "tool-call"),
      ).length;
      const hintsHit = evalCase.expectHints.filter((h) =>
        answer.toLowerCase().includes(h.toLowerCase()),
      );
      const row = {
        runId,
        caseId: evalCase.id,
        repo: evalCase.repo,
        variant,
        stopReason: result.stopReason,
        forcedFinal: result.forcedFinal ?? false,
        elapsedMs,
        scoutMs: result.scoutMs,
        toolCalls,
        hintsHit: hintsHit.length,
        hintsTotal: evalCase.expectHints.length,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
        answerPreview: answer.slice(0, 500),
        answer,
      };
      fs.appendFileSync(outJsonl, `${JSON.stringify(row)}\n`);
      fs.appendFileSync(
        outMd,
        [
          `## ${runId}`,
          "",
          `- stop=\`${result.stopReason}\` forcedFinal=${row.forcedFinal} time=${elapsedMs}ms tools=${toolCalls} hints=${row.hintsHit}/${row.hintsTotal}`,
          `- tokens in=${row.inputTokens} out=${row.outputTokens} cached=${row.cachedInputTokens}`,
          "",
          answer.slice(0, 1200) || "_(empty)_",
          "",
          "---",
          "",
        ].join("\n"),
      );
      console.log(
        `[exp] <<< ${runId} ${result.stopReason} ${elapsedMs}ms tools=${toolCalls} hints=${row.hintsHit}/${row.hintsTotal} in=${row.inputTokens}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fs.appendFileSync(
        outJsonl,
        `${JSON.stringify({ runId, variant, caseId: evalCase.id, error: message })}\n`,
      );
      console.error(`[exp] <<< ${runId} ERROR ${message}`);
    }
  }
}

// Aggregate
const rows = fs
  .readFileSync(outJsonl, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);
const byVariant = new Map<string, typeof rows>();
for (const row of rows) {
  if (row.error) continue;
  const v = String(row.variant);
  byVariant.set(v, [...(byVariant.get(v) ?? []), row]);
}
fs.appendFileSync(outMd, `\n# Aggregate\n\n`);
for (const [variant, list] of byVariant) {
  const n = list.length;
  const avg = (key: string) => list.reduce((s, r) => s + Number(r[key] ?? 0), 0) / Math.max(n, 1);
  fs.appendFileSync(
    outMd,
    `- **${variant}** n=${n} avgMs=${avg("elapsedMs").toFixed(0)} avgTools=${avg("toolCalls").toFixed(1)} avgInTok=${avg("inputTokens").toFixed(0)} avgHints=${avg("hintsHit").toFixed(2)}\n`,
  );
}
console.log(`[exp] wrote ${outMd}`);
