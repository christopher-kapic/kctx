import "@starter/env/load-dotenv";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  exploreAgentAnswer,
  runExploreAgent,
} from "../apps/worker/src/lib/explore/run-explore-agent.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, "../../.scratch");
const [evalCase] = JSON.parse(
  fs.readFileSync(path.join(scratch, "fanout-probe-case.json"), "utf8"),
) as Array<{
  id: string;
  repo: string;
  root: string;
  question: string;
}>;

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENROUTER_API_KEY required");
  process.exit(1);
}

console.log("[fanout] start", evalCase.id);
const started = Date.now();
const result = await runExploreAgent({
  root: evalCase.root,
  question: evalCase.question,
  packageContext: `Repository: ${evalCase.repo}`,
  apiKey,
  model: process.env.CHAT_MODEL?.trim() || "deepseek/deepseek-v4-flash",
  maxIterations: Number(process.env.CHAT_MAX_ITERATIONS ?? 24),
  timeoutMs: Number(process.env.CHAT_RUN_TIMEOUT_MS ?? 360_000),
  repoMap: true,
  examplesFirst: true,
  forceFinalAnswer: true,
  allowDelegation: true,
  maxDelegateAgents: 4,
  delegateMaxIterations: 8,
});

const elapsedMs = Date.now() - started;
const answer = exploreAgentAnswer(result);
const toolNames = result.messages.flatMap((message) =>
  message.parts
    .filter((part): part is { type: "tool-call"; name: string } => part.type === "tool-call")
    .map((part) => part.name),
);
const row = {
  id: evalCase.id,
  elapsedMs,
  stopReason: result.stopReason,
  forcedFinal: result.forcedFinal,
  delegateCalls: result.delegateCalls,
  toolNames,
  delegateInvoked: toolNames.includes("delegate_explore"),
  inputTokens: result.usage?.inputTokens,
  outputTokens: result.usage?.outputTokens,
  answerPreview: answer.slice(0, 800),
  answer,
};
fs.writeFileSync(path.join(scratch, "fanout-probe-result.json"), JSON.stringify(row, null, 2));
console.log(
  JSON.stringify(
    {
      elapsedMs,
      stopReason: row.stopReason,
      delegateCalls: row.delegateCalls,
      delegateInvoked: row.delegateInvoked,
      toolNames,
      inputTokens: row.inputTokens,
      preview: row.answerPreview,
    },
    null,
    2,
  ),
);
