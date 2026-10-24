import { HTTPClient } from "@openrouter/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createModelAdapter } from "./adapters";
import type { AgentModel } from "./types";

// Capture the args each provider factory is called with so we can assert the config
// (notably the injected `httpClient`) without reaching into adapter internals.
const openRouterCalls: unknown[][] = [];
const openaiCalls: unknown[][] = [];

vi.mock("@tanstack/ai-openrouter", () => ({
  createOpenRouterText: (...args: unknown[]) => {
    openRouterCalls.push(args);
    return { name: "openrouter-adapter" };
  },
}));
vi.mock("@tanstack/ai-openai", () => ({
  createOpenaiChat: (...args: unknown[]) => {
    openaiCalls.push(args);
    return { name: "openai-adapter" };
  },
}));

const openai: AgentModel = { provider: "openai-compat", model: "gpt-4o", apiKey: "test-key" };
const anthropic: AgentModel = {
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4-5",
  apiKey: "test-key",
};
const nonAnthropicOpenRouter: AgentModel = {
  provider: "openrouter",
  model: "openai/gpt-4o",
  apiKey: "test-key",
};

/** The config (third) argument the OpenRouter factory was last called with. */
const lastOpenRouterConfig = (): Record<string, unknown> | undefined =>
  openRouterCalls.at(-1)?.[2] as Record<string, unknown> | undefined;

beforeEach(() => {
  openRouterCalls.length = 0;
  openaiCalls.length = 0;
});

describe("createModelAdapter — OpenAI-compatible caching", () => {
  it("sets a stable prompt_cache_key for OpenAI-compatible providers", () => {
    const bundle = createModelAdapter(openai, { enabled: true, cacheKey: "run-1:person" });
    expect(bundle.adapter).toBeDefined();
    expect(bundle.modelOptions).toEqual({ prompt_cache_key: "run-1:person" });
  });

  it("produces byte-identical cache key wiring across sibling calls with the same key", () => {
    const a = createModelAdapter(openai, { enabled: true, cacheKey: "run-1:person" });
    const b = createModelAdapter(openai, { enabled: true, cacheKey: "run-1:person" });
    expect(a.modelOptions).toEqual(b.modelOptions);
  });

  it("omits the cache key when caching is disabled (debug off-switch)", () => {
    const bundle = createModelAdapter(openai, { enabled: false, cacheKey: "run-1:person" });
    expect(bundle.modelOptions).toBeUndefined();
  });

  it("omits the cache key when no key is provided", () => {
    const bundle = createModelAdapter(openai, { enabled: true });
    expect(bundle.modelOptions).toBeUndefined();
  });
});

describe("createModelAdapter — Anthropic-via-OpenRouter cache breakpoints", () => {
  it("wires a beforeRequest HTTPClient for Anthropic models when caching is on", () => {
    const bundle = createModelAdapter(anthropic, { enabled: true, cacheKey: "run-1:person" });
    expect(bundle.adapter).toBeDefined();
    // OpenRouter never uses modelOptions (breakpoints are injected at the HTTP layer).
    expect(bundle.modelOptions).toBeUndefined();
    expect(lastOpenRouterConfig()?.httpClient).toBeInstanceOf(HTTPClient);
  });

  it("defaults caching on when the flag is unset", () => {
    createModelAdapter(anthropic);
    expect(lastOpenRouterConfig()?.httpClient).toBeInstanceOf(HTTPClient);
  });

  it("does not wire the HTTPClient when caching is disabled (off-switch)", () => {
    createModelAdapter(anthropic, { enabled: false, cacheKey: "run-1:person" });
    expect(lastOpenRouterConfig()?.httpClient).toBeUndefined();
  });

  it("is a no-op for non-Anthropic OpenRouter models", () => {
    const bundle = createModelAdapter(nonAnthropicOpenRouter, { enabled: true, cacheKey: "k" });
    expect(bundle.adapter).toBeDefined();
    expect(bundle.modelOptions).toBeUndefined();
    expect(lastOpenRouterConfig()?.httpClient).toBeUndefined();
  });

  it("forwards baseUrl as serverURL and still wires the cache hook", () => {
    createModelAdapter(
      { ...anthropic, baseUrl: "https://proxy.example/api/v1" },
      { enabled: true },
    );
    const config = lastOpenRouterConfig();
    expect(config?.serverURL).toBe("https://proxy.example/api/v1");
    expect(config?.httpClient).toBeInstanceOf(HTTPClient);
  });

  it("does not throw when no cache options are provided", () => {
    expect(() => createModelAdapter(openai)).not.toThrow();
    expect(() => createModelAdapter(anthropic)).not.toThrow();
    expect(() => createModelAdapter(nonAnthropicOpenRouter)).not.toThrow();
  });
});
