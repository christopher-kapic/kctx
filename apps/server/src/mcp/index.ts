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
import { createOpencodeClient } from "@opencode-ai/sdk";

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
  const settings = await prisma.siteSettings.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });

  // Fall back to OPENCODE_URL env var if not set in database
  if (!settings.opencodeUrl && env.OPENCODE_URL) {
    settings.opencodeUrl = env.OPENCODE_URL;
  }

  return settings;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage?: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(errorMessage || `Operation timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
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

function createClient(opencodeUrl: string, repoPath: string) {
  return createOpencodeClient({
    baseUrl: opencodeUrl,
    directory: repoPath,
  });
}

const DEFAULT_AGENT_PROMPT = `You are an AI agent whose job is to answer questions about the codebase you are asked about. Your primary responsibility is to help developers understand how to use dependencies and codebases effectively. When answering questions:

1. Provide clear, practical answers with code examples when relevant
2. Reference specific files, functions, or patterns in the codebase when possible
3. Explain not just what the code does, but how to use it effectively
4. If the question is ambiguous, ask clarifying questions
5. Focus on helping developers understand how to integrate and use the dependency in their projects
6. If you need to explore the repository (e.g. read files, run commands), do so first, then give your full answer in the same response. Do not send only a short placeholder (e.g. "Let me explore...") and then stop—include your findings and complete answer in one reply.

IMPORTANT: The working directory for this session is set to the repository root. When executing shell commands, you should operate from this directory.`;

async function getAgentPrompt(repoPath: string, kctxHelper?: string): Promise<string> {
  try {
    const configPath = env.OPENCODE_CONFIG_PATH;
    if (existsSync(configPath)) {
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      if (config?.agent && typeof config.agent === "object") {
        const kcAgent = config.agent["kinetic-context"];
        if (kcAgent && typeof kcAgent === "object" && typeof kcAgent.prompt === "string") {
          let prompt = kcAgent.prompt;
          prompt += `\n\nIMPORTANT: The repository you are analyzing is located at: ${repoPath}`;
          if (kctxHelper?.trim()) {
            prompt = `Repository summary (for context):\n\n${kctxHelper}\n\n---\n\n${prompt}`;
          }
          return prompt;
        }
      }
    }
  } catch {
    // Fall through to default
  }
  let prompt = DEFAULT_AGENT_PROMPT;
  prompt += `\n\nIMPORTANT: The repository you are analyzing is located at: ${repoPath}`;
  if (kctxHelper?.trim()) {
    prompt = `Repository summary (for context):\n\n${kctxHelper}\n\n---\n\n${prompt}`;
  }
  return prompt;
}

async function queryOpencode(
  repoPath: string,
  query: string,
  opencodeUrl: string,
  timeoutMs: number,
  options?: { packageId?: string; ownerId?: string },
): Promise<{ response: string; sessionId: string }> {
  console.log(`[MCP] queryOpencode: url=${opencodeUrl}, repoPath=${repoPath}, timeout=${timeoutMs}ms`);

  const client = createClient(opencodeUrl, repoPath);
  const fetchTimeout = Math.min(timeoutMs, 900000);

  // Create session
  const sessionResult = await withTimeout(
    client.session.create({
      body: { title: `Query: ${query.substring(0, 50)}` },
    }),
    fetchTimeout,
    `Session creation timed out after ${fetchTimeout}ms`,
  ) as { error?: { message?: string }; data?: { id: string } };

  if (sessionResult.error || !sessionResult.data) {
    throw new Error(
      `Failed to create OpenCode session: ${sessionResult.error?.message || "Unknown error"}`,
    );
  }

  const sessionId = sessionResult.data.id;
  console.log(`[MCP] Session created: ${sessionId}`);

  // Create DB conversation if packageId and ownerId are provided
  if (options?.packageId && options?.ownerId) {
    try {
      await prisma.conversation.create({
        data: {
          id: sessionId,
          title: query.substring(0, 100),
          packageId: options.packageId,
          ownerId: options.ownerId,
        },
      });
      await prisma.chatMessage.create({
        data: {
          conversationId: sessionId,
          role: "user",
          content: query,
        },
      });
    } catch (error) {
      console.error("[MCP] Failed to create conversation record:", error instanceof Error ? error.message : String(error));
    }
  }

  // Read configured model
  const model = await getModelFromConfig();

  // Send prompt
  const promptResult = await withTimeout(
    client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text" as const, text: query }],
        agent: "kinetic-context",
        ...(model ? { model } : {}),
      },
    }),
    fetchTimeout,
    `Prompt send timed out after ${fetchTimeout}ms`,
  ) as { error?: { message?: string }; data?: { parts?: Array<{ type?: string; text?: string }> } };

  if (promptResult.error) {
    throw new Error(
      `Failed to send OpenCode prompt: ${promptResult.error?.message || "Unknown error"}`,
    );
  }

  // Check for immediate response
  if (promptResult.data?.parts && Array.isArray(promptResult.data.parts)) {
    const textParts = promptResult.data.parts.filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof p.text === "string",
    );
    const lastPart = textParts[textParts.length - 1];
    if (lastPart) {
      if (options?.packageId && options?.ownerId) {
        await prisma.chatMessage.create({
          data: { conversationId: sessionId, role: "assistant", content: lastPart.text },
        }).catch(() => {});
      }
      return { response: lastPart.text, sessionId };
    }
  }

  // Poll for assistant response using the SDK
  const pollInterval = 2000;
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      const messagesRes = await fetch(
        `${opencodeUrl}/session/${encodeURIComponent(sessionId)}/message?limit=5`,
        { headers: { "x-opencode-directory": repoPath } },
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
          if (options?.packageId && options?.ownerId) {
            await prisma.chatMessage.create({
              data: { conversationId: sessionId, role: "assistant", content: lastPart.text },
            }).catch(() => {});
          }
          return { response: lastPart.text, sessionId };
        }
      }
    } catch {
      continue;
    }
  }

  throw new Error(`OpenCode query timed out after ${timeoutMs}ms`);
}

export interface OpencodeModel {
  providerID: string;
  modelID: string;
}

export async function* queryOpencodeStream(
  repoPath: string,
  query: string,
  opencodeUrl: string,
  model?: OpencodeModel,
  sessionId?: string,
  kctxHelper?: string,
): AsyncGenerator<{ text: string; done: boolean; sessionId?: string; thinking?: string }, void, unknown> {
  console.log(`[MCP] queryOpencodeStream: url=${opencodeUrl}, repoPath=${repoPath}`);

  const client = createClient(opencodeUrl, repoPath);

  // Create or reuse session
  let currentSessionId = sessionId;
  if (!currentSessionId) {
    const sessionTitle = `Query: ${query.substring(0, 50)}`;
    const sessionResult = await withTimeout(
      client.session.create({
        body: { title: sessionTitle },
      }),
      30000,
      "Session creation timed out",
    ) as { error?: { message?: string }; data?: { id: string } };

    if (sessionResult.error || !sessionResult.data) {
      throw new Error(
        `Failed to create session: ${sessionResult.error?.message || "Unknown error"}`,
      );
    }

    currentSessionId = sessionResult.data.id;

    // Send agent prompt for new sessions
    const agentPrompt = await getAgentPrompt(repoPath, kctxHelper);
    try {
      await withTimeout(
        client.session.prompt({
          path: { id: currentSessionId },
          body: {
            agent: "kinetic-context",
            noReply: true,
            parts: [{ type: "text" as const, text: agentPrompt }],
          },
        }),
        30000,
        "Agent prompt send timed out",
      );
    } catch (error) {
      console.error(`[MCP] Error sending agent prompt:`, error instanceof Error ? error.message : String(error));
    }
  }

  // Subscribe to events
  const events = await withTimeout(
    client.event.subscribe(),
    30000,
    "Event subscription timed out",
  ) as { stream: AsyncIterable<{ type: string; properties?: Record<string, unknown> }> };

  // Send prompt (fire-and-forget)
  void client.session.prompt({
    path: { id: currentSessionId },
    body: {
      parts: [{ type: "text" as const, text: query }],
      agent: "kinetic-context",
      ...(model ? { model } : {}),
    },
  }).catch((error: unknown) => {
    console.error("[MCP] Prompt send error:", error);
  });

  let accumulatedText = "";
  const accumulatedThinking: string[] = [];
  let lastFullThinkingText = "";
  let assistantMessageId: string | null = null;
  let streamComplete = false;
  let waitingForAssistant = true;

  const streamStartTime = Date.now();
  const overallTimeoutMs = 300000; // 5 minutes

  try {
    for await (const event of events.stream) {
      const elapsed = Date.now() - streamStartTime;
      if (elapsed > overallTimeoutMs) {
        throw new Error(`Stream timed out after ${overallTimeoutMs}ms`);
      }

      if (event.type === "message.updated") {
        const messageInfo = event.properties?.info as { sessionID?: string; role?: string; id?: string } | undefined;
        if (messageInfo?.sessionID === currentSessionId && messageInfo?.role === "assistant") {
          assistantMessageId = messageInfo.id ?? null;
          waitingForAssistant = false;
        }
      }

      if (event.type === "message.part.updated") {
        const part = event.properties?.part as {
          sessionID?: string;
          messageID?: string;
          type?: string;
          text?: string;
          time?: { end?: unknown };
          messageInfo?: { role?: string };
          tool?: string;
          name?: string;
          state?: { status?: string; input?: { filePath?: string } };
        };

        if (!part || part.sessionID !== currentSessionId) continue;

        // Handle reasoning/thinking parts
        if (part.type === "reasoning" && typeof part.text === "string") {
          if (waitingForAssistant && part.messageID) {
            assistantMessageId = part.messageID;
            waitingForAssistant = false;
          }
          if (lastFullThinkingText && part.text.startsWith(lastFullThinkingText)) {
            if (accumulatedThinking.length > 0) {
              accumulatedThinking[accumulatedThinking.length - 1] = part.text;
            } else {
              accumulatedThinking.push(part.text);
            }
          } else if (!accumulatedThinking.includes(part.text)) {
            accumulatedThinking.push(part.text);
          }
          lastFullThinkingText = part.text;
          yield { text: "", done: false, sessionId: currentSessionId, thinking: accumulatedThinking.join("\n\n") };
          continue;
        }

        // Identify assistant message
        if (waitingForAssistant && part.messageID) {
          if (part.messageInfo?.role === "assistant" || part.type === "tool" || part.type === "reasoning") {
            assistantMessageId = part.messageID;
            waitingForAssistant = false;
          } else if (part.messageInfo?.role === "user") {
            continue;
          }
        }

        if (!assistantMessageId || part.messageID !== assistantMessageId) continue;

        // Handle text content
        if (part.type === "text" && typeof part.text === "string") {
          if (part.text.length > accumulatedText.length) {
            const newText = part.text.slice(accumulatedText.length);
            accumulatedText = part.text;
            const thinkingText = accumulatedThinking.length > 0 ? accumulatedThinking.join("\n\n") : undefined;
            yield { text: newText, done: false, sessionId: currentSessionId, thinking: thinkingText };
          } else {
            accumulatedText = part.text;
          }
        } else if (part.type && part.type !== "text" && part.type !== "reasoning") {
          // Tool usage
          const toolName = part.tool || part.name || "unknown";
          const toolState = part.state;
          if (toolState?.status === "running") {
            accumulatedThinking.push(`Tool: ${toolName} (running)`);
          } else if (toolState?.status === "completed") {
            accumulatedThinking.push(`Tool: ${toolName} (completed)`);
          }
          yield { text: "", done: false, sessionId: currentSessionId, thinking: accumulatedThinking.join("\n\n") };
        }
      }

      if (event.type === "session.error" || event.type === "message.error") {
        const error = event.properties?.error;
        throw new Error(
          `OpenCode error: ${error && typeof error === "object" && "message" in error ? String((error as { message?: string }).message) : JSON.stringify(error) || "Unknown error"}`,
        );
      }

      if (event.type === "session.idle") {
        const sessionIdFromEvent = (event.properties as { sessionID?: string })?.sessionID;
        if (sessionIdFromEvent === currentSessionId && !streamComplete) {
          streamComplete = true;
          const thinkingText = accumulatedThinking.length > 0 ? accumulatedThinking.join("\n\n") : undefined;
          yield { text: "", done: true, sessionId: currentSessionId, thinking: thinkingText };
          return;
        }
      }
    }

    if (accumulatedText && !streamComplete) {
      const thinkingText = accumulatedThinking.length > 0 ? accumulatedThinking.join("\n\n") : undefined;
      yield { text: "", done: true, sessionId: currentSessionId, thinking: thinkingText };
    }
  } catch (error) {
    console.error("[MCP] Stream error:", error instanceof Error ? error.message : String(error));
    throw error;
  }
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
      const mcpCtx = getMcpContext();

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
          { packageId: pkg.id, ownerId: mcpCtx.userId },
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
