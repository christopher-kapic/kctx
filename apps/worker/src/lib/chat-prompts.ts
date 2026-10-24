import { type AgentTool, UNTRUSTED_CONTENT_SYSTEM_RULES } from "@starter/agent-runtime";

/**
 * Base system prompt for a chat session.
 *
 * Deliberately generic — it describes how to behave, not what the product is.
 * Replace or extend it with your domain instructions; the honesty and
 * tool-discipline clauses are the parts worth keeping, because they are what
 * stop the model from inventing a tool result it never received.
 */
export const CHAT_SYSTEM_PROMPT = `You are a helpful assistant embedded in this application.

Answer clearly and concisely. Prefer plain prose over bullet lists unless the user asks for a list. Use Markdown for code, and never for decoration.

When a tool can answer a question, call it instead of guessing — and when no tool can, say what you do not know rather than filling the gap. Never state or imply that you called a tool you did not call, and never present a tool's output as more certain than it is: report what it returned, including when it returned nothing.

If a request is ambiguous enough that a wrong assumption would waste the user's time, ask one clarifying question before acting.`;

/**
 * Appended when confined explore tools (glob / grep / read) are registered.
 *
 * Adapted from flycockpit's `docs-answerer` agent: answer dependency / codebase
 * questions from ACTUAL source under the explore root, with file:line citations.
 */
export const EXPLORE_SYSTEM_PROMPT = `You also have read-only tools to investigate a codebase rooted at a configured explore directory: \`glob\`, \`grep\`, and \`read\`. Your working set is that directory only — you cannot see outside it.

When the user asks how something works, what an API looks like, or how to use a library/package in that tree:
1. Use \`glob\` / \`grep\` to find the relevant API (public exports, examples/, types, docs).
2. \`read\` the most promising file(s) to confirm the real signature and usage.
3. Answer from what you read — not from training memory when the source is available.

Output format for investigation answers:
- Lead with the answer in one sentence (the concrete call/pattern).
- Follow with \`file:line\` citations into the explore tree.
- If the source does not show it, say so explicitly and name what you searched.
- Keep investigation answers under ~30 lines unless the user asks for more.

You have NO shell and cannot write files. Do not invent paths you have not seen in tool output.`;

/**
 * Compose the system prompt for a run.
 *
 * The untrusted-content rules are appended IF AND ONLY IF at least one
 * registered tool is marked `untrusted`. That coupling is the point: the rules
 * explain markers the model would otherwise never see, so emitting them
 * unconditionally trains it to ignore a section of its own prompt — and
 * omitting them when an untrusted tool IS registered leaves fetched content
 * indistinguishable from instructions. Deriving the decision from the tool list
 * means registering an untrusted tool (see `defineUntrustedTool` in
 * chat-tools.ts) turns the defense on automatically, with nothing to remember.
 *
 * Explore instructions are similarly derived: if glob/grep/read are present,
 * the docs-answerer workflow is appended so the model knows how to use them.
 */
export function buildChatSystemPrompt(tools: readonly AgentTool[]): string {
  const parts = [CHAT_SYSTEM_PROMPT];

  const hasExploreTools = tools.some(
    (tool) => tool.name === "glob" || tool.name === "grep" || tool.name === "read",
  );
  if (hasExploreTools) {
    parts.push(EXPLORE_SYSTEM_PROMPT);
  }

  const hasUntrustedTool = tools.some((tool) => tool.untrusted === true);
  if (hasUntrustedTool) {
    parts.push(UNTRUSTED_CONTENT_SYSTEM_RULES);
  }

  return parts.join("\n\n");
}
