import { type AgentTool, defineTool, UNTRUSTED_CONTENT_SYSTEM_RULES } from "@starter/agent-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildChatSystemPrompt,
  CHAT_SYSTEM_PROMPT,
  EXPLORE_SYSTEM_PROMPT,
} from "./chat-prompts.js";

const tool = (name: string, untrusted?: boolean): AgentTool =>
  defineTool({
    name,
    description: "test",
    inputSchema: z.object({}),
    untrusted,
    execute: () => "ok",
  });

describe("CHAT_SYSTEM_PROMPT", () => {
  it("forbids claiming a tool call that never happened", () => {
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain(
      "never state or imply that you called a tool you did not call",
    );
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain("say what you do not know");
  });
});

describe("buildChatSystemPrompt", () => {
  it("omits the untrusted-content rules when no tool returns untrusted data", () => {
    const prompt = buildChatSystemPrompt([tool("current_time")]);
    expect(prompt).toBe(CHAT_SYSTEM_PROMPT);
    expect(prompt).not.toContain(UNTRUSTED_CONTENT_SYSTEM_RULES);
  });

  it("omits them for an empty tool list", () => {
    expect(buildChatSystemPrompt([])).toBe(CHAT_SYSTEM_PROMPT);
  });

  // The security property: registering an untrusted tool must turn the defense
  // on by itself. If this ever needs a second manual flag, fetched content and
  // instructions become indistinguishable to the model.
  it("appends the untrusted-content rules as soon as one tool is untrusted", () => {
    const prompt = buildChatSystemPrompt([tool("current_time"), tool("fetch_page", true)]);
    expect(prompt).toContain(CHAT_SYSTEM_PROMPT);
    expect(prompt).toContain(UNTRUSTED_CONTENT_SYSTEM_RULES);
  });

  it("appends explore instructions when glob/grep/read are registered", () => {
    const prompt = buildChatSystemPrompt([
      tool("current_time"),
      tool("glob"),
      tool("grep"),
      tool("read"),
    ]);
    expect(prompt).toContain(CHAT_SYSTEM_PROMPT);
    expect(prompt).toContain(EXPLORE_SYSTEM_PROMPT);
    expect(prompt).toContain("file:line");
  });

  it("does not append explore instructions for the default tool alone", () => {
    expect(buildChatSystemPrompt([tool("current_time")])).not.toContain(EXPLORE_SYSTEM_PROMPT);
  });
});
