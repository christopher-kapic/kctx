/**
 * Batch quality eval for runExploreAgent against local clones.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... pnpm exec tsx scripts/eval-explore-agent.ts
 *
 * Reads cases from ../.scratch/eval-cases.json (relative to kc3/).
 * Writes results to ../.scratch/eval-results.jsonl + summary markdown.
 */
import "@starter/env/load-dotenv";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { exploreAgentAnswer, runExploreAgent } = await import(
  "../apps/worker/src/lib/explore/run-explore-agent.ts"
);

type EvalCase = {
  id: string;
  repo: string;
  root: string;
  question: string;
  /** Short notes for the human grader about what a good answer should mention. */
  expectHints: string[];
};

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, "../../.scratch");
const casesPath = path.join(scratch, "eval-cases.json");
const outJsonl = path.join(scratch, "eval-results.jsonl");
const outMd = path.join(scratch, "eval-summary.md");

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENROUTER_API_KEY required");
  process.exit(1);
}

const model = process.env.CHAT_MODEL?.trim() || "deepseek/deepseek-v4-flash";
const maxIterations = Number(process.env.CHAT_MAX_ITERATIONS ?? 12);
const timeoutMs = Number(process.env.CHAT_RUN_TIMEOUT_MS ?? 240_000);

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8")) as EvalCase[];
fs.writeFileSync(outJsonl, "");
fs.writeFileSync(
  outMd,
  `# Explore-agent eval\n\nModel: \`${model}\`\nStarted: ${new Date().toISOString()}\n\n`,
);

console.log(`[eval] ${cases.length} cases · model=${model}`);

for (const evalCase of cases) {
  console.log(`\n[eval] >>> ${evalCase.id} (${evalCase.repo})`);
  console.log(`[eval] Q: ${evalCase.question}`);
  if (!fs.existsSync(evalCase.root)) {
    const row = {
      ...evalCase,
      ok: false,
      error: `root missing: ${evalCase.root}`,
    };
    fs.appendFileSync(outJsonl, `${JSON.stringify(row)}\n`);
    fs.appendFileSync(outMd, `## ${evalCase.id}\n\n**ERROR:** root missing\n\n`);
    continue;
  }

  const started = Date.now();
  try {
    const result = await runExploreAgent({
      root: evalCase.root,
      question: evalCase.question,
      packageContext: `Repository: ${evalCase.repo}. Answer from the source tree only.`,
      apiKey,
      model,
      maxIterations,
      timeoutMs,
    });
    const answer = exploreAgentAnswer(result);
    const elapsedMs = Date.now() - started;
    const toolCalls = result.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "tool-call"),
    ).length;
    const hintsHit = evalCase.expectHints.filter((hint) =>
      answer.toLowerCase().includes(hint.toLowerCase()),
    );
    const row = {
      id: evalCase.id,
      repo: evalCase.repo,
      question: evalCase.question,
      stopReason: result.stopReason,
      elapsedMs,
      toolCalls,
      hintsHit,
      hintsMissed: evalCase.expectHints.filter((h) => !hintsHit.includes(h)),
      answer,
      usage: result.usage,
    };
    fs.appendFileSync(outJsonl, `${JSON.stringify(row)}\n`);
    fs.appendFileSync(
      outMd,
      [
        `## ${evalCase.id}`,
        "",
        `**Repo:** ${evalCase.repo}`,
        `**Question:** ${evalCase.question}`,
        `**stopReason:** \`${result.stopReason}\` · **${elapsedMs}ms** · **${toolCalls} tool-calls**`,
        `**hint hits:** ${hintsHit.length}/${evalCase.expectHints.length} (${hintsHit.join(", ") || "none"})`,
        "",
        "### Answer",
        "",
        answer || "_(empty)_",
        "",
        "---",
        "",
      ].join("\n"),
    );
    console.log(
      `[eval] <<< ${evalCase.id} stop=${result.stopReason} ${elapsedMs}ms tools=${toolCalls} hints=${hintsHit.length}/${evalCase.expectHints.length}`,
    );
    console.log(answer.slice(0, 400).replace(/\n/g, " "));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fs.appendFileSync(
      outJsonl,
      `${JSON.stringify({ id: evalCase.id, repo: evalCase.repo, ok: false, error: message })}\n`,
    );
    fs.appendFileSync(outMd, `## ${evalCase.id}\n\n**ERROR:** ${message}\n\n---\n\n`);
    console.error(`[eval] <<< ${evalCase.id} ERROR: ${message}`);
  }
}

console.log(`\n[eval] wrote ${outMd}`);
