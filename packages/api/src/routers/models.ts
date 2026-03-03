import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ORPCError } from "@orpc/server";

import { adminProcedure } from "../index";
import { env } from "@kctx/env/server";

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
};
