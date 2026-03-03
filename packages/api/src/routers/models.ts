import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ORPCError } from "@orpc/server";

import { adminProcedure } from "../index";
import { env } from "@kctx/env/server";
import prisma from "@kctx/db";

export type OpencodeConfig = {
  $schema?: string;
  model?: string;
  provider?: Record<
    string,
    {
      npm?: string;
      name?: string;
      options?: Record<string, unknown>;
      models?: Record<string, unknown>;
      [key: string]: unknown;
    }
  >;
  agent?: Record<string, unknown> | string;
  [key: string]: unknown;
};

const DEFAULT_AGENT_PROMPT =
  "You are an AI agent whose job is to answer questions about the codebase you are asked about. Your primary responsibility is to help developers understand how to use dependencies and codebases effectively. When answering questions:\n\n1. Provide clear, practical answers with code examples when relevant\n2. Reference specific files, functions, or patterns in the codebase when possible\n3. Explain not just what the code does, but how to use it effectively\n4. If the question is ambiguous, ask clarifying questions\n5. Focus on helping developers understand how to integrate and use the dependency in their projects";

function defaultConfig(): OpencodeConfig {
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {},
    agent: {
      "kinetic-context": {
        mode: "primary",
        prompt: DEFAULT_AGENT_PROMPT,
        tools: { write: false, edit: false, bash: false },
      },
    },
  };
}

export async function readOpencodeConfig(
  configPath: string,
): Promise<OpencodeConfig> {
  try {
    if (!existsSync(configPath)) {
      return defaultConfig();
    }
    const content = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return defaultConfig();
    }

    // Clean up provider structure
    if (parsed.provider) {
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed.provider)) {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          cleaned[key] = value;
        }
      }
      parsed.provider = cleaned;
    }

    // Ensure kinetic-context agent exists
    if (!parsed.agent || typeof parsed.agent !== "object" || !(parsed.agent as Record<string, unknown>)["kinetic-context"]) {
      if (!parsed.agent || typeof parsed.agent !== "object") {
        parsed.agent = {};
      }
      (parsed.agent as Record<string, unknown>)["kinetic-context"] = {
        mode: "primary",
        prompt: DEFAULT_AGENT_PROMPT,
        tools: { write: false, edit: false, bash: false },
      };
    }

    return parsed as OpencodeConfig;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return defaultConfig();
    }
    throw error;
  }
}

export async function writeOpencodeConfig(
  configPath: string,
  config: unknown,
): Promise<void> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("Config must be an object");
  }

  const validated = { ...(config as Record<string, unknown>) };

  // Clean provider structure
  if (validated.provider && typeof validated.provider === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(validated.provider as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        cleaned[key] = value;
      }
    }
    validated.provider = cleaned;
  } else {
    validated.provider = {};
  }

  if (!validated.$schema) {
    validated.$schema = "https://opencode.ai/config.json";
  }

  // Ensure kinetic-context agent
  const agent = validated.agent as Record<string, unknown> | undefined;
  if (!agent || typeof agent !== "object" || !agent["kinetic-context"]) {
    if (!validated.agent || typeof validated.agent !== "object") {
      validated.agent = {};
    }
    (validated.agent as Record<string, unknown>)["kinetic-context"] = {
      mode: "primary",
      prompt: DEFAULT_AGENT_PROMPT,
      tools: { write: false, edit: false, bash: false },
    };
  }

  const configDir = dirname(configPath);
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(validated, null, 2), "utf-8");
}

export const modelsRouter = {
  getConfig: adminProcedure.handler(async () => {
    return readOpencodeConfig(env.OPENCODE_CONFIG_PATH);
  }),

  updateConfig: adminProcedure
    .input(z.object({ config: z.unknown() }))
    .handler(async ({ input }) => {
      try {
        await writeOpencodeConfig(env.OPENCODE_CONFIG_PATH, input.config);
        return { success: true };
      } catch (error) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: `Failed to write config: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  fetchOpencodeZenModels: adminProcedure
    .input(
      z.object({
        apiKey: z.string().min(1, "API key is required"),
        baseURL: z.string().url().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const baseURL = input.baseURL || "https://opencode.ai/zen/v1";
      try {
        const response = await fetch(`${baseURL}/models`, {
          headers: { Authorization: `Bearer ${input.apiKey}` },
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch models: ${response.statusText}`);
        }
        const data = (await response.json()) as any;
        if (data.data && Array.isArray(data.data)) {
          return {
            models: data.data.map((model: any) => ({
              id: model.id as string,
              name: model.id as string,
            })),
          };
        }
        throw new Error("Invalid response format");
      } catch (error) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: error instanceof Error ? error.message : "Failed to fetch models",
        });
      }
    }),

  fetchOpenrouterModels: adminProcedure
    .input(z.object({ baseURL: z.string().url().optional() }))
    .handler(async ({ input }) => {
      const baseURL = input.baseURL || "https://openrouter.ai/api/v1";
      try {
        const response = await fetch(`${baseURL}/models`);
        if (!response.ok) {
          throw new Error(`Failed to fetch models: ${response.statusText}`);
        }
        const data = (await response.json()) as any;
        if (data.data && Array.isArray(data.data)) {
          return {
            models: data.data.map((model: any) => ({
              id: model.id as string,
              name: (model.id.split("/").pop() || model.id) as string,
            })),
          };
        }
        throw new Error("Invalid response format");
      } catch (error) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: error instanceof Error ? error.message : "Failed to fetch models",
        });
      }
    }),

  startGithubCopilotAuth: adminProcedure
    .input(
      z.object({
        enterpriseUrl: z.string().url().optional().or(z.literal("")),
      }),
    )
    .handler(async () => {
      const settings = await prisma.siteSettings.upsert({
        where: { id: "default" },
        create: { id: "default" },
        update: {},
      });
      const opencodeUrl = settings.opencodeUrl;
      const timeoutMs = settings.opencodeTimeoutMs;
      if (!opencodeUrl) {
        throw new ORPCError("BAD_REQUEST", {
          message: "OpenCode URL is not configured. Set it in Settings.",
        });
      }
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(
          `${opencodeUrl}/provider/github-copilot/oauth/authorize`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ method: 0 }),
            signal: controller.signal,
          },
        );
        clearTimeout(timeoutId);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `OpenCode auth failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`,
          );
        }
        const data = (await response.json()) as { url?: string; instructions?: string };
        const url = typeof data.url === "string" ? data.url : "";
        const instructions =
          typeof data.instructions === "string"
            ? data.instructions
            : "Enter the code shown in OpenCode.";
        return { url, instructions };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: "OpenCode server request timed out",
          });
        }
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: error instanceof Error ? error.message : "GitHub Copilot auth not available",
        });
      }
    }),

  completeGithubCopilotAuth: adminProcedure.handler(async () => {
    const settings = await prisma.siteSettings.upsert({
      where: { id: "default" },
      create: { id: "default" },
      update: {},
    });
    const opencodeUrl = settings.opencodeUrl;
    const timeoutMs = Math.max(settings.opencodeTimeoutMs, 120_000);
    if (!opencodeUrl) {
      throw new ORPCError("BAD_REQUEST", {
        message: "OpenCode URL is not configured. Set it in Settings.",
      });
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(
        `${opencodeUrl}/provider/github-copilot/oauth/callback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: 0 }),
          signal: controller.signal,
        },
      );
      clearTimeout(timeoutId);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `OpenCode callback failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`,
        );
      }
      const result = await response.json();
      return { success: result === true };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "Authentication timed out. Complete the device flow on GitHub and try again.",
        });
      }
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: error instanceof Error ? error.message : "GitHub Copilot auth failed",
      });
    }
  }),

  fetchGithubCopilotModels: adminProcedure
    .input(
      z.object({
        enterpriseUrl: z.string().url().optional().or(z.literal("")),
      }),
    )
    .handler(async () => {
      const settings = await prisma.siteSettings.upsert({
        where: { id: "default" },
        create: { id: "default" },
        update: {},
      });
      const opencodeUrl = settings.opencodeUrl;
      const timeoutMs = settings.opencodeTimeoutMs;

      const FALLBACK_COPILOT_MODELS = [
        { id: "gpt-5.2-codex", name: "GPT-5.2-Codex" },
        { id: "gpt-5.1-codex", name: "GPT-5.1-Codex" },
        { id: "gpt-5.1-codex-max", name: "GPT-5.1-Codex-Max" },
        { id: "gpt-5.1-codex-mini", name: "GPT-5.1-Codex-Mini" },
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
        { id: "grok-code-fast-1", name: "Grok Code Fast 1" },
      ];

      if (!opencodeUrl) {
        return { models: FALLBACK_COPILOT_MODELS };
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(`${opencodeUrl}/provider`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
          return { models: FALLBACK_COPILOT_MODELS };
        }
        const data = (await response.json()) as {
          all?: Array<{ id?: string; models?: Record<string, { name?: string }> }>;
        };
        const all = data.all ?? [];
        const copilot = all.find((p) => p.id === "github-copilot");
        if (copilot?.models && typeof copilot.models === "object") {
          const models = Object.entries(copilot.models).map(([id, meta]) => ({
            id,
            name: meta?.name ?? id,
          }));
          if (models.length > 0) {
            return { models };
          }
        }
        return { models: FALLBACK_COPILOT_MODELS };
      } catch {
        return { models: FALLBACK_COPILOT_MODELS };
      }
    }),
};
