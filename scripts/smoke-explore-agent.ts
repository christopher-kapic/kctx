/**
 * One-shot smoke: run the explore agent against the sample-pkg fixture.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... pnpm exec tsx scripts/smoke-explore-agent.ts
 *   OPENROUTER_API_KEY=... pnpm exec tsx scripts/smoke-explore-agent.ts "How do I shout a greeting?"
 *
 * Does not need Postgres, Redis, or CHAT_ENABLED — it calls runExploreAgent
 * directly against apps/worker/src/lib/explore/fixtures/sample-pkg.
 */

import "@starter/env/load-dotenv";

import path from "node:path";
import { fileURLToPath } from "node:url";

const { exploreAgentAnswer, runExploreAgent } = await import(
  "../apps/worker/src/lib/explore/run-explore-agent.ts"
);

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY to run the explore-agent smoke.");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../apps/worker/src/lib/explore/fixtures/sample-pkg");
const question =
  process.argv.slice(2).join(" ").trim() ||
  "How do I use the greet function? Include the shout option.";

console.log(`[smoke-explore] root=${root}`);
console.log(`[smoke-explore] question=${question}`);

const result = await runExploreAgent({
  root,
  question,
  packageContext: "sample-pkg fixture: tiny TypeScript greeting helper",
  apiKey,
  model: process.env.CHAT_MODEL?.trim() || "anthropic/claude-haiku-4-5",
  maxIterations: 8,
  timeoutMs: 120_000,
});

console.log(`[smoke-explore] stopReason=${result.stopReason}`);
console.log("--- answer ---");
console.log(exploreAgentAnswer(result) || "(empty assistant text)");
process.exit(result.stopReason === "completed" ? 0 : 2);
