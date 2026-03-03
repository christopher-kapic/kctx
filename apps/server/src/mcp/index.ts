import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import { simpleGit } from "simple-git";
import prisma from "@kctx/db";
import { env } from "@kctx/env/server";

export interface McpContext {
  userId: string;
  apiKeyId: string;
}

export const mcpContextStorage = new AsyncLocalStorage<McpContext>();

function getMcpContext(): McpContext {
  const ctx = mcpContextStorage.getStore();
  if (!ctx) {
    throw new Error("MCP context not available");
  }
  return ctx;
}

/**
 * Authenticate an API key from the Authorization header.
 * Returns the userId and apiKeyId if valid, or null if invalid.
 */
export async function authenticateApiKey(
  authHeader: string | undefined,
): Promise<McpContext | null> {
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const plainKey = authHeader.slice(7);
  const hashedKey = createHash("sha256").update(plainKey).digest("hex");

  const apiKey = await prisma.apiKey.findUnique({
    where: { hashedKey },
    select: { id: true, userId: true, revokedAt: true },
  });

  if (!apiKey || apiKey.revokedAt !== null) {
    return null;
  }

  return { userId: apiKey.userId, apiKeyId: apiKey.id };
}

async function getSettings() {
  return prisma.siteSettings.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

async function getModelFromConfig(): Promise<
  { providerID: string; modelID: string } | undefined
> {
  try {
    const configPath = env.OPENCODE_CONFIG_PATH;
    if (!existsSync(configPath)) return undefined;
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    const model = config?.model;
    if (typeof model !== "string" || !model.includes("/")) return undefined;
    const slashIndex = model.indexOf("/");
    return {
      providerID: model.slice(0, slashIndex),
      modelID: model.slice(slashIndex + 1),
    };
  } catch {
    return undefined;
  }
}

async function queryOpencode(
  repoPath: string,
  query: string,
  opencodeUrl: string,
  timeoutMs: number,
): Promise<{ response: string; sessionId: string }> {
  const fetchTimeout = Math.min(timeoutMs, 30000);

  // Create session
  const sessionRes = await fetchWithTimeout(
    `${opencodeUrl}/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Query: ${query.substring(0, 50)}`,
        directory: repoPath,
      }),
    },
    fetchTimeout,
  );

  if (!sessionRes.ok) {
    throw new Error(`Failed to create OpenCode session: HTTP ${sessionRes.status}`);
  }

  const sessionData = (await sessionRes.json()) as { id?: string };
  const sessionId = sessionData.id;
  if (!sessionId) {
    throw new Error("OpenCode session creation returned no session ID");
  }

  // Read configured model
  const model = await getModelFromConfig();

  // Send prompt
  const promptBody: Record<string, unknown> = {
    parts: [{ type: "text", text: query }],
  };
  if (model) {
    promptBody.model = model;
  }

  const promptRes = await fetchWithTimeout(
    `${opencodeUrl}/session/${encodeURIComponent(sessionId)}/prompt`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": repoPath,
      },
      body: JSON.stringify(promptBody),
    },
    fetchTimeout,
  );

  if (!promptRes.ok) {
    throw new Error(`Failed to send OpenCode prompt: HTTP ${promptRes.status}`);
  }

  const promptData = (await promptRes.json()) as {
    parts?: Array<{ type?: string; text?: string }>;
  };

  // Check for immediate response
  if (promptData.parts && Array.isArray(promptData.parts)) {
    const textParts = promptData.parts.filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof p.text === "string",
    );
    const lastPart = textParts[textParts.length - 1];
    if (lastPart) {
      return { response: lastPart.text, sessionId };
    }
  }

  // Poll for assistant response
  const pollInterval = 2000;
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const messagesRes = await fetchWithTimeout(
      `${opencodeUrl}/session/${encodeURIComponent(sessionId)}/message?limit=5`,
      {
        headers: { "x-opencode-directory": repoPath },
      },
      fetchTimeout,
    );

    if (!messagesRes.ok) continue;

    const messages = (await messagesRes.json()) as Array<{
      info?: { role?: string };
      parts?: Array<{ type?: string; text?: string }>;
    }>;

    if (!Array.isArray(messages)) continue;

    const assistantMsg = messages.find((m) => m.info?.role === "assistant");
    if (assistantMsg?.parts) {
      const textParts = assistantMsg.parts.filter(
        (p): p is { type: "text"; text: string } =>
          p.type === "text" && typeof p.text === "string",
      );
      const lastPart = textParts[textParts.length - 1];
      if (lastPart) {
        return {
          response: lastPart.text,
          sessionId,
        };
      }
    }
  }

  throw new Error(`OpenCode query timed out after ${timeoutMs}ms`);
}

async function generateKctxHelperIfNeeded(
  packageId: string,
  packageName: string,
  packageManager: string,
  repoPath: string,
  opencodeUrl: string,
  timeoutMs: number,
) {
  try {
    const pkg = await prisma.package.findUnique({ where: { id: packageId }, select: { kctxHelper: true } });
    if (pkg?.kctxHelper?.trim()) return;

    const prompt = `You are analyzing a repository for the package "${packageName}" (${packageManager}).
Provide a concise guide that will help future AI queries about this package be answered faster. Include:
1. What this package/library does (1-2 sentences)
2. The key source files and directories most relevant to understanding "${packageName}" — list specific paths
3. Main exports, entry points, or APIs that users of this package interact with
4. Important patterns, conventions, or architectural decisions in the codebase
5. Any configuration files or build setup relevant to this package
Reply with only the guide text, no preamble or markdown headers.`;

    const result = await queryOpencode(repoPath, prompt, opencodeUrl, timeoutMs * 3);

    await prisma.package.update({
      where: { id: packageId },
      data: { kctxHelper: result.response },
    });
  } catch {
    // Fire-and-forget — don't block the main query
  }
}

export function createMcpServer(): McpServer {
  const mcpServer = new McpServer(
    {
      name: "kinetic-context",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Tool: list_dependencies
  mcpServer.tool(
    "list_dependencies",
    "Lists all available dependencies that have been configured in the system. These dependencies can be queried using query_dependency to ask usage questions about how to use them.",
    {},
    async (): Promise<CallToolResult> => {
      getMcpContext(); // Ensure authenticated

      try {
        const packages = await prisma.package.findMany({
          select: {
            identifier: true,
            displayName: true,
            packageManager: true,
            defaultTag: true,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                packages.map((pkg) => ({
                  identifier: pkg.identifier,
                  display_name: pkg.displayName,
                  package_manager: pkg.packageManager,
                  default_tag: pkg.defaultTag,
                })),
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing dependencies: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Tool: query_dependency
  mcpServer.tool(
    "query_dependency",
    "Ask questions about how to use a dependency. Analyzes the dependency's source code using OpenCode to provide intelligent answers about usage patterns, APIs, and best practices. Call list_dependencies first to ensure the correct package identifier is used.",
    {
      identifier: z.string().describe("The dependency identifier to query"),
      query: z
        .string()
        .describe("The question to ask about how to use the dependency"),
      timeout: z
        .number()
        .optional()
        .describe(
          "Optional timeout in seconds. Uses the configured default if not provided.",
        ),
    },
    async ({ identifier, query, timeout }): Promise<CallToolResult> => {
      getMcpContext(); // Ensure authenticated

      try {
        const pkg = await prisma.package.findUnique({
          where: { identifier },
          include: { Repository: true },
        });

        if (!pkg) {
          return {
            content: [
              {
                type: "text",
                text: `Dependency "${identifier}" not found`,
              },
            ],
            isError: true,
          };
        }

        if (!pkg.Repository.clonedPath) {
          return {
            content: [
              {
                type: "text",
                text: `Repository for "${identifier}" has not been cloned yet`,
              },
            ],
            isError: true,
          };
        }

        // Auto-pull for public repos (best-effort)
        if (!pkg.Repository.isPrivate && pkg.Repository.clonedPath) {
          try {
            await simpleGit(pkg.Repository.clonedPath).pull();
          } catch {
            // Proceed even if pull fails
          }
        }

        const settings = await getSettings();

        if (!settings.opencodeUrl) {
          return {
            content: [
              {
                type: "text",
                text: "OpenCode URL is not configured. Set it in Settings.",
              },
            ],
            isError: true,
          };
        }

        const timeoutMs = timeout
          ? timeout * 1000
          : settings.opencodeTimeoutMs;

        // Prepend kctxHelper as context if available
        let enrichedQuery = query;
        if (pkg.kctxHelper?.trim()) {
          enrichedQuery = `Context about this package:\n${pkg.kctxHelper}\n\n${query}`;
        }

        const result = await queryOpencode(
          pkg.Repository.clonedPath,
          enrichedQuery,
          settings.opencodeUrl,
          timeoutMs,
        );

        // Fire-and-forget: generate helper text if missing
        if (!pkg.kctxHelper?.trim()) {
          generateKctxHelperIfNeeded(
            pkg.id,
            pkg.identifier,
            pkg.packageManager,
            pkg.Repository.clonedPath,
            settings.opencodeUrl,
            timeoutMs,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  response: result.response,
                  sessionId: result.sessionId,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error querying dependency: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return mcpServer;
}
