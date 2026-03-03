import { ORPCError, eventIterator } from "@orpc/server";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { simpleGit } from "simple-git";
import { createOpencodeClient } from "@opencode-ai/sdk";

import prisma from "@kctx/db";
import { env } from "@kctx/env/server";

import { protectedProcedure } from "../index";

const DEFAULT_AGENT_PROMPT = `You are an AI agent whose job is to answer questions about the codebase you are asked about. Your primary responsibility is to help developers understand how to use dependencies and codebases effectively. When answering questions:

1. Provide clear, practical answers with code examples when relevant
2. Reference specific files, functions, or patterns in the codebase when possible
3. Explain not just what the code does, but how to use it effectively
4. If the question is ambiguous, ask clarifying questions
5. Focus on helping developers understand how to integrate and use the dependency in their projects
6. If you need to explore the repository, do so first, then give your full answer in the same response.

IMPORTANT: The working directory for this session is set to the repository root.`;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage?: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage || `Timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

async function getAgentPrompt(repoPath: string, kctxHelper?: string): Promise<string> {
  try {
    const configPath = env.OPENCODE_CONFIG_PATH;
    if (existsSync(configPath)) {
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      if (config?.agent && typeof config.agent === "object") {
        const kcAgent = config.agent["kinetic-context"];
        if (kcAgent && typeof kcAgent === "object" && typeof kcAgent.prompt === "string") {
          let prompt = kcAgent.prompt as string;
          prompt += `\n\nIMPORTANT: The repository is at: ${repoPath}`;
          if (kctxHelper?.trim()) {
            prompt = `Repository summary:\n\n${kctxHelper}\n\n---\n\n${prompt}`;
          }
          return prompt;
        }
      }
    }
  } catch {
    // Fall through
  }
  let prompt = DEFAULT_AGENT_PROMPT;
  prompt += `\n\nIMPORTANT: The repository is at: ${repoPath}`;
  if (kctxHelper?.trim()) {
    prompt = `Repository summary:\n\n${kctxHelper}\n\n---\n\n${prompt}`;
  }
  return prompt;
}

export const packageRouter = {
  list: protectedProcedure.handler(async () => {
    return prisma.package.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        Repository: {
          select: {
            id: true,
            gitProvider: true,
            orgOrUser: true,
            repoName: true,
            cloneStatus: true,
          },
        },
      },
    });
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input }) => {
      const pkg = await prisma.package.findUnique({
        where: { id: input.id },
        include: {
          Repository: true,
        },
      });
      if (!pkg) {
        throw new ORPCError("NOT_FOUND", { message: "Package not found" });
      }
      return pkg;
    }),

  create: protectedProcedure
    .input(
      z.object({
        identifier: z.string().min(1),
        displayName: z.string().min(1),
        packageManager: z.string().min(1),
        defaultTag: z.string().min(1),
        kctxHelper: z.string().optional(),
        urls: z.record(z.string(), z.string()).default({}),
        repositoryId: z.string(),
      }),
    )
    .handler(async ({ input }) => {
      // Verify repository exists
      const repo = await prisma.repository.findUnique({
        where: { id: input.repositoryId },
      });
      if (!repo) {
        throw new ORPCError("NOT_FOUND", {
          message: "Repository not found",
        });
      }

      // Check for duplicate identifier
      const existing = await prisma.package.findUnique({
        where: { identifier: input.identifier },
      });
      if (existing) {
        throw new ORPCError("CONFLICT", {
          message: "A package with this identifier already exists",
        });
      }

      return prisma.package.create({
        data: {
          identifier: input.identifier,
          displayName: input.displayName,
          packageManager: input.packageManager,
          defaultTag: input.defaultTag,
          kctxHelper: input.kctxHelper,
          urls: input.urls as Record<string, string>,
          repositoryId: input.repositoryId,
        },
        include: {
          Repository: {
            select: {
              id: true,
              gitProvider: true,
              orgOrUser: true,
              repoName: true,
            },
          },
        },
      });
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        displayName: z.string().min(1).optional(),
        packageManager: z.string().min(1).optional(),
        defaultTag: z.string().min(1).optional(),
        kctxHelper: z.string().nullable().optional(),
        urls: z.record(z.string(), z.string()).optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, urls, ...rest } = input;

      const existing = await prisma.package.findUnique({
        where: { id },
      });
      if (!existing) {
        throw new ORPCError("NOT_FOUND", { message: "Package not found" });
      }

      return prisma.package.update({
        where: { id },
        data: {
          ...rest,
          ...(urls !== undefined ? { urls: urls as Record<string, string> } : {}),
        },
        include: {
          Repository: {
            select: {
              id: true,
              gitProvider: true,
              orgOrUser: true,
              repoName: true,
            },
          },
        },
      });
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input }) => {
      const existing = await prisma.package.findUnique({
        where: { id: input.id },
      });
      if (!existing) {
        throw new ORPCError("NOT_FOUND", { message: "Package not found" });
      }

      await prisma.package.delete({ where: { id: input.id } });

      return { success: true };
    }),

  getAvailableModels: protectedProcedure.handler(async () => {
    const configPath = env.OPENCODE_CONFIG_PATH;
    let defaultModel: string | undefined;
    const models: Array<{ providerId: string; modelId: string }> = [];

    try {
      if (existsSync(configPath)) {
        const content = await readFile(configPath, "utf-8");
        const config = JSON.parse(content);
        defaultModel = typeof config?.model === "string" ? config.model : undefined;

        if (config?.provider && typeof config.provider === "object") {
          for (const [providerId, providerConfig] of Object.entries(config.provider)) {
            const provider = providerConfig as { models?: Record<string, unknown> };
            if (provider?.models && typeof provider.models === "object") {
              for (const modelId of Object.keys(provider.models)) {
                models.push({ providerId, modelId });
              }
            }
          }
        }
      }
    } catch {
      // Return empty on error
    }

    return { models, defaultModel };
  }),

  getAgentInfo: protectedProcedure.handler(async () => {
    const configPath = env.OPENCODE_CONFIG_PATH;
    try {
      if (existsSync(configPath)) {
        const content = await readFile(configPath, "utf-8");
        const config = JSON.parse(content);
        if (config?.agent && typeof config.agent === "object") {
          const kcAgent = (config.agent as Record<string, unknown>)["kinetic-context"];
          if (kcAgent && typeof kcAgent === "object") {
            return { name: "kinetic-context" };
          }
        }
      }
    } catch {
      // Fall through
    }
    return { name: "kinetic-context" };
  }),

  chat: protectedProcedure
    .input(
      z.object({
        identifier: z.string(),
        message: z.string().min(1),
        model: z.string().optional(),
        conversationId: z.string().optional(),
      }),
    )
    .output(
      eventIterator(
        z.object({
          text: z.string(),
          done: z.boolean(),
          sessionId: z.string().optional(),
          thinking: z.string().optional(),
        }),
      ),
    )
    .handler(async function* ({ input, context }) {
      const userId = context.session.user.id;
      const pkg = await prisma.package.findUnique({
        where: { identifier: input.identifier },
        include: { Repository: true },
      });

      if (!pkg) {
        throw new ORPCError("NOT_FOUND", {
          message: `Package "${input.identifier}" not found`,
        });
      }

      if (!pkg.Repository.clonedPath) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Repository for "${input.identifier}" has not been cloned yet`,
        });
      }

      const settings = await prisma.siteSettings.upsert({
        where: { id: "default" },
        create: { id: "default" },
        update: {},
      });

      let opencodeUrl = settings.opencodeUrl;
      if (!opencodeUrl && env.OPENCODE_URL) {
        opencodeUrl = env.OPENCODE_URL;
      }
      if (!opencodeUrl) {
        throw new ORPCError("BAD_REQUEST", {
          message: "OpenCode URL is not configured. Set it in Settings.",
        });
      }

      // Auto-pull for public repos
      if (!pkg.Repository.isPrivate && pkg.Repository.clonedPath) {
        try {
          await simpleGit(pkg.Repository.clonedPath).pull();
        } catch {
          // Continue even if pull fails
        }
      }

      // Parse model
      let model: { providerID: string; modelID: string } | undefined;
      if (input.model) {
        const parts = input.model.split("/");
        if (parts.length >= 2) {
          model = {
            providerID: parts[0]!,
            modelID: parts.slice(1).join("/"),
          };
        }
      }

      const repoPath = pkg.Repository.clonedPath;
      const client = createOpencodeClient({
        baseUrl: opencodeUrl,
        directory: repoPath,
      });

      // Create or reuse session
      const isNewSession = !input.conversationId;
      let currentSessionId = input.conversationId;
      if (!currentSessionId) {
        const sessionResult = await withTimeout(
          client.session.create({
            body: { title: `Chat: ${input.message.substring(0, 50)}` },
          }),
          30000,
          "Session creation timed out",
        ) as { error?: { message?: string }; data?: { id: string } };

        if (sessionResult.error || !sessionResult.data) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: `Failed to create session: ${sessionResult.error?.message || "Unknown error"}`,
          });
        }

        currentSessionId = sessionResult.data.id;

        // Create DB conversation with the opencode session ID
        await prisma.conversation.create({
          data: {
            id: currentSessionId,
            title: input.message.substring(0, 100),
            packageId: pkg.id,
            ownerId: userId,
          },
        });

        // Save the user message
        await prisma.chatMessage.create({
          data: {
            conversationId: currentSessionId,
            role: "user",
            content: input.message,
          },
        });

        // Send agent prompt for new sessions
        const agentPrompt = await getAgentPrompt(repoPath, pkg.kctxHelper ?? "");
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
            "Agent prompt timed out",
          );
        } catch (error) {
          console.error("[Chat] Agent prompt error:", error instanceof Error ? error.message : String(error));
        }
      } else {
        // Existing conversation — save the user message
        await prisma.chatMessage.create({
          data: {
            conversationId: currentSessionId,
            role: "user",
            content: input.message,
          },
        });
      }

      if (!currentSessionId) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "No session ID available",
        });
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
          parts: [{ type: "text" as const, text: input.message }],
          agent: "kinetic-context",
          ...(model ? { model } : {}),
        },
      }).catch((error: unknown) => {
        console.error("[Chat] Prompt send error:", error);
      });

      let accumulatedText = "";
      const accumulatedThinking: string[] = [];
      let lastFullThinkingText = "";
      let assistantMessageId: string | null = null;
      let streamComplete = false;
      let waitingForAssistant = true;
      const streamStartTime = Date.now();
      const overallTimeoutMs = 300000;

      try {
        for await (const event of events.stream) {
          if (Date.now() - streamStartTime > overallTimeoutMs) {
            throw new Error("Stream timed out");
          }

          if (event.type === "message.updated") {
            const info = event.properties?.info as { sessionID?: string; role?: string; id?: string } | undefined;
            if (info?.sessionID === currentSessionId && info?.role === "assistant") {
              assistantMessageId = info.id ?? null;
              waitingForAssistant = false;
            }
          }

          if (event.type === "message.part.updated") {
            const part = event.properties?.part as {
              sessionID?: string;
              messageID?: string;
              type?: string;
              text?: string;
              messageInfo?: { role?: string };
              tool?: string;
              name?: string;
              state?: { status?: string; input?: { filePath?: string } };
            };

            if (!part || part.sessionID !== currentSessionId) continue;

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

            if (waitingForAssistant && part.messageID) {
              if (part.messageInfo?.role === "assistant" || part.type === "tool" || part.type === "reasoning") {
                assistantMessageId = part.messageID;
                waitingForAssistant = false;
              } else if (part.messageInfo?.role === "user") {
                continue;
              }
            }

            if (!assistantMessageId || part.messageID !== assistantMessageId) continue;

            if (part.type === "text" && typeof part.text === "string") {
              if (part.text.length > accumulatedText.length) {
                const newText = part.text.slice(accumulatedText.length);
                accumulatedText = part.text;
                const thinking = accumulatedThinking.length > 0 ? accumulatedThinking.join("\n\n") : undefined;
                yield { text: newText, done: false, sessionId: currentSessionId, thinking };
              } else {
                accumulatedText = part.text;
              }
            } else if (part.type && part.type !== "text" && part.type !== "reasoning") {
              const toolName = part.tool || part.name || "unknown";
              if (part.state?.status === "running") {
                accumulatedThinking.push(`Tool: ${toolName} (running)`);
              } else if (part.state?.status === "completed") {
                accumulatedThinking.push(`Tool: ${toolName} (completed)`);
              }
              yield { text: "", done: false, sessionId: currentSessionId, thinking: accumulatedThinking.join("\n\n") };
            }
          }

          if (event.type === "session.error" || event.type === "message.error") {
            const error = event.properties?.error;
            throw new Error(
              `OpenCode error: ${error && typeof error === "object" && "message" in error ? String((error as { message?: string }).message) : "Unknown error"}`,
            );
          }

          if (event.type === "session.idle") {
            const sid = (event.properties as { sessionID?: string })?.sessionID;
            if (sid === currentSessionId && !streamComplete) {
              streamComplete = true;

              // Save assistant message to DB
              if (accumulatedText) {
                const thinking = accumulatedThinking.length > 0 ? accumulatedThinking.join("\n\n") : undefined;
                await prisma.chatMessage.create({
                  data: {
                    conversationId: currentSessionId,
                    role: "assistant",
                    content: accumulatedText,
                    thinking,
                  },
                });
              }

              const thinking = accumulatedThinking.length > 0 ? accumulatedThinking.join("\n\n") : undefined;
              yield { text: "", done: true, sessionId: currentSessionId, thinking };
              return;
            }
          }
        }

        if (accumulatedText && !streamComplete) {
          const thinking = accumulatedThinking.length > 0 ? accumulatedThinking.join("\n\n") : undefined;
          yield { text: "", done: true, sessionId: currentSessionId, thinking };
        }
      } catch (error) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: error instanceof Error ? error.message : "Failed to stream chat response",
        });
      }
    }),
};
