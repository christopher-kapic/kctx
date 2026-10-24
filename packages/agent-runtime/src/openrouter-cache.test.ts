import { describe, expect, it } from "vitest";

import {
  createAnthropicCacheBeforeRequestHook,
  injectAnthropicCacheBreakpoints,
} from "./openrouter-cache";

const EPHEMERAL = { type: "ephemeral" };

describe("injectAnthropicCacheBreakpoints", () => {
  it("promotes a string system message to a text part carrying cache_control", () => {
    const body = {
      messages: [
        { role: "system", content: "You are a helpful agent." },
        { role: "user", content: "hi" },
      ],
    };
    const changed = injectAnthropicCacheBreakpoints(body);
    expect(changed).toBe(true);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "You are a helpful agent.", cache_control: EPHEMERAL }],
    });
    // Non-system messages are untouched.
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("marks the last text part when the system content is already an array", () => {
    const body = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
    };
    injectAnthropicCacheBreakpoints(body);
    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b", cache_control: EPHEMERAL },
    ]);
  });

  it("attaches cache_control to the final tool definition only", () => {
    const body = {
      messages: [{ role: "system", content: "s" }],
      tools: [
        { type: "function", function: { name: "one" } },
        { type: "function", function: { name: "two" } },
      ],
    };
    injectAnthropicCacheBreakpoints(body);
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "one" } });
    expect(body.tools[1]).toEqual({
      type: "function",
      function: { name: "two" },
      cache_control: EPHEMERAL,
    });
  });

  it("no-ops on a body with neither a system message nor tools", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(injectAnthropicCacheBreakpoints(body)).toBe(false);
    expect(body).toEqual({ messages: [{ role: "user", content: "hi" }] });
  });

  it("tolerates non-object and malformed input without throwing", () => {
    expect(injectAnthropicCacheBreakpoints(null)).toBe(false);
    expect(injectAnthropicCacheBreakpoints("nope")).toBe(false);
    expect(injectAnthropicCacheBreakpoints({ messages: "bad", tools: 3 })).toBe(false);
    expect(injectAnthropicCacheBreakpoints({ tools: [] })).toBe(false);
  });
});

const jsonRequest = (body: unknown): Request =>
  new Request("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("createAnthropicCacheBeforeRequestHook", () => {
  it("rewrites the JSON body with cache breakpoints and preserves method/headers", async () => {
    const hook = createAnthropicCacheBeforeRequestHook();
    const original = jsonRequest({
      model: "anthropic/claude-sonnet-4-5",
      messages: [{ role: "system", content: "prefix" }],
      tools: [{ type: "function", function: { name: "t" } }],
    });
    const next = await hook(original);
    expect(next).toBeInstanceOf(Request);
    const rewritten = (await (next as Request).json()) as {
      messages: Array<{ content: unknown }>;
      tools: Array<{ cache_control: unknown }>;
    };
    expect(rewritten.messages[0]?.content).toEqual([
      { type: "text", text: "prefix", cache_control: EPHEMERAL },
    ]);
    expect(rewritten.tools[0]?.cache_control).toEqual(EPHEMERAL);
    expect((next as Request).method).toBe("POST");
    expect((next as Request).headers.get("content-type")).toBe("application/json");
    // Original request remains readable (we only cloned it).
    const originalBody = (await original.json()) as { messages: Array<{ content: unknown }> };
    expect(originalBody.messages[0]?.content).toBe("prefix");
  });

  it("leaves the request untouched (returns undefined) for non-JSON content types", async () => {
    const hook = createAnthropicCacheBeforeRequestHook();
    const req = new Request("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(await hook(req)).toBeUndefined();
  });

  it("returns undefined when the body cannot be parsed as JSON", async () => {
    const hook = createAnthropicCacheBeforeRequestHook();
    const req = new Request("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(await hook(req)).toBeUndefined();
  });

  it("returns undefined when there is nothing to cache", async () => {
    const hook = createAnthropicCacheBeforeRequestHook();
    const req = jsonRequest({ messages: [{ role: "user", content: "hi" }] });
    expect(await hook(req)).toBeUndefined();
  });
});
