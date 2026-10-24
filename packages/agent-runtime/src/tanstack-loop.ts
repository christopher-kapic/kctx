import {
  chat,
  convertMessagesToModelMessages,
  fromSpecTokenUsage,
  maxIterations,
  type StreamChunk,
  StreamProcessor,
  toolDefinition,
  type UIMessage,
} from "@tanstack/ai";

import { createModelAdapter, resolveMaxOutputTokens } from "./adapters";
import { pruneAgentMessages } from "./context-prune";
import { isDeadlineAbort, startDeadline } from "./deadline";
import { FatalToolError } from "./errors";
import { isTruncatedFinish, normalizeFinishReason } from "./finish-reason";
import { LoopGuard } from "./loop-guard";
import { MAX_FAILOVER_CANDIDATES } from "./retry";
import { createRetryFailoverAdapter } from "./retry-adapter";
import { executeToolWithAbort } from "./tool-execution";
import { buildRetrieveToolResultTool, serializeToolResultWithStore } from "./tools";
import type { AgentLoopOptions, AgentMessage, AgentMessagePart, AgentUsage } from "./types";

export interface TanstackLoopResult {
  messages: AgentMessage[];
  usage: AgentUsage;
  hitIterationLimit: boolean;
  /**
   * The model's output hit the token ceiling (any provider spelling of `length`), so its
   * final message — plausibly a long tool call — was cut off mid-stream. Never a clean
   * finish; see the `"output-truncated"` stop reason.
   */
  outputTruncated?: boolean;
  /** Raw provider finish reason of the last completed dispatch, when reported. */
  finishReason?: string;
  /** The wall-clock deadline elapsed. */
  timedOut?: boolean;
  vetoed?: boolean;
  vetoReason?: string;
}

const toUIMessage = (message: AgentMessage): UIMessage => ({
  id: message.id,
  role: message.role,
  parts: message.parts as UIMessage["parts"],
  createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
});

/** Read the first present, finite numeric field from a raw usage object; else undefined. */
const numericField = (source: Record<string, unknown>, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
};

const fromUIMessage = (message: UIMessage): AgentMessage => ({
  id: message.id,
  role: message.role,
  parts: message.parts as unknown as AgentMessagePart[],
  createdAt: message.createdAt?.toISOString(),
});

/**
 * Storage role for one turn. `AgentMessage.role` has no `"tool"` member — a tool
 * result arrives as a message whose parts are all `tool-result` — so it is derived
 * here rather than invented at each call site.
 */
const turnRole = (message: AgentMessage): string =>
  message.parts.length > 0 && message.parts.every((part) => part.type === "tool-result")
    ? "tool"
    : message.role;

export const executeTanstackLoop = async (
  options: AgentLoopOptions,
  abortController: AbortController,
): Promise<TanstackLoopResult> => {
  let currentMessages: AgentMessage[] = options.messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => ({ ...p })),
  }));
  let callbackQueue = Promise.resolve();
  let fatalError: FatalToolError | undefined;
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
  let runCount = 0;
  let finalFinishReason: string | null = null;
  let outputTruncated = false;
  let lastDispatchAt: number | null = null;
  // `null` maxIterations = unlimited; the deadline and the loop guard are then the
  // only backstops (see AgentLoopOptions.maxIterations).
  const iterationCap =
    options.maxIterations === null ? Number.POSITIVE_INFINITY : options.maxIterations;

  // When a store is injected, register `retrieve_tool_result` so the agent can page
  // any body that overflowed a tool's cap.
  const runtimeTools = options.resultStore
    ? [...options.tools, buildRetrieveToolResultTool(options.resultStore)]
    : options.tools;

  // Back-to-back identical tool calls waste iterations; the guard synthesizes a
  // stable error result instead of re-executing. Even tools whose results could
  // change from *sibling* agents cannot observe new writes from *this* agent
  // without an intervening call — so consecutive identical calls are safe to block.
  // ── Per-turn observability ────────────────────────────────────────────────────
  // `seq` is the APPEND ORDER of turns, not a position in `currentMessages`. Two
  // things make a positional scheme wrong: the pre-dispatch prune pass rewrites
  // message bodies in place (and may in future compact them), and the stream
  // processor returns a freshly constructed array on every dispatch. Tracking which
  // messages have already been announced by IDENTITY keeps `seq` stable and monotonic
  // across both. The counter only ever moves forward.
  let nextTurnSeq = 0;
  const announcedTurns = new Set<string>();
  const turnKey = (message: AgentMessage, index: number): string =>
    message.id ? `id:${message.id}` : `pos:${index}:${message.role}`;

  /**
   * Announce every message not yet seen, in array order. Never throws: an
   * observability hook must not be able to fail the agent loop.
   */
  const announceTurns = async (messages: AgentMessage[]): Promise<void> => {
    const onTurn = options.onTurn;
    if (!onTurn) return;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) continue;
      const key = turnKey(message, index);
      if (announcedTurns.has(key)) continue;
      announcedTurns.add(key);
      const seq = nextTurnSeq;
      nextTurnSeq += 1;
      try {
        await onTurn({ seq, role: turnRole(message), message });
      } catch (error) {
        console.warn(`[agent-runtime] onTurn hook failed at seq=${seq}`, error);
      }
    }
  };

  const loopGuard = new LoopGuard(options.loopGuardThreshold);
  const allToolNames = runtimeTools.map((tool) => tool.name);

  const tools = runtimeTools.map((tool) =>
    toolDefinition({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }).server(async (input) => {
      const guarded = loopGuard.check(tool.name, input, allToolNames);
      if (guarded !== null) {
        return guarded;
      }
      try {
        // Raced against the run's abort signal, which the deadline fires. A
        // tool that never settles would otherwise hold the loop open forever
        // and the wall-clock bound would not exist — see tool-execution.ts.
        // Nothing below this line runs for an abandoned call, so a late result
        // can never be stored, returned, or announced.
        const output = await executeToolWithAbort(tool, input, abortController.signal);
        return await serializeToolResultWithStore(output, tool.maxResultChars, {
          store: options.resultStore,
          untrusted: tool.untrusted,
        });
      } catch (error) {
        if (error instanceof FatalToolError) {
          fatalError = error;
          abortController.abort(error);
        }
        throw error;
      }
    }),
  );

  const cacheOpts = {
    enabled: options.cache !== false,
    cacheKey: options.cacheKey,
  };
  const modelCandidates = [options.model, ...(options.fallbackModels ?? [])].slice(
    0,
    MAX_FAILOVER_CANDIDATES,
  );
  const { adapter, modelOptions, getServingModelId } = createRetryFailoverAdapter({
    candidates: modelCandidates.map((model) => {
      const bundle = createModelAdapter(model, cacheOpts);
      return { ...bundle, modelId: model.model };
    }),
    abortSignal: abortController.signal,
    onFailover: (serving, primary) => {
      console.warn(`[agent-runtime] model failover: primary=${primary} serving=${serving}`);
    },
  });

  // Wall-clock backstop. Expiry aborts the same controller the dispatch already uses,
  // so an in-flight stream is cut off instead of running to completion.
  const deadline = startDeadline(options, abortController);
  let timedOut = false;

  // Explicit output ceiling — never rely on the provider default (see
  // DEFAULT_MAX_OUTPUT_TOKENS: a low default truncates long tool calls).
  const maxOutputTokens = resolveMaxOutputTokens(options.maxOutputTokens);

  try {
    // The seed messages are turns too: without them the persisted history opens
    // mid-conversation, with no record of the prompt the node was actually given.
    await announceTurns(currentMessages);

    // Harness-driven iterations so we own the message array between dispatches
    // (onBeforeDispatch + prune seam). Each chat() call runs a single model turn.
    for (let iteration = 0; iteration < iterationCap; iteration += 1) {
      if (deadline.expired()) {
        timedOut = true;
        break;
      }
      if (abortController.signal.aborted) {
        if (isDeadlineAbort(abortController.signal.reason)) timedOut = true;
        break;
      }

      // Built-in prune pass (first registered use of the pre-dispatch seam).
      if (options.prune?.enabled !== false && options.resultStore) {
        const pruneStats = await pruneAgentMessages(currentMessages, options.resultStore, {
          enabled: options.prune?.enabled,
          cacheTtlMs: options.prune?.cacheTtlMs,
          tokenThreshold: options.prune?.tokenThreshold,
          lastDispatchAt,
        });
        if (pruneStats.ran) {
          await options.onPruneStats?.(pruneStats);
        }
      }

      const hookResult = await options.onBeforeDispatch?.({
        messages: currentMessages,
        iteration,
        lastDispatchAt,
      });
      if (hookResult && typeof hookResult === "object" && "veto" in hookResult) {
        await callbackQueue;
        return {
          messages: currentMessages,
          usage,
          hitIterationLimit: false,
          vetoed: true,
          vetoReason: hookResult.veto.reason,
        };
      }

      lastDispatchAt = Date.now();
      const uiMessages = currentMessages.map(toUIMessage);
      const processor = new StreamProcessor({
        initialMessages: uiMessages,
        events: {
          onMessagesChange: (messages) => {
            const serializable = messages.map(fromUIMessage);
            currentMessages = serializable;
            callbackQueue = callbackQueue.then(() => options.onMessagesChange?.(serializable));
          },
        },
      });

      const stream = chat({
        adapter,
        messages: convertMessagesToModelMessages(uiMessages),
        systemPrompts: [options.systemPrompt],
        tools,
        abortController,
        agentLoopStrategy: maxIterations(1),
        ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
        ...(modelOptions ? { modelOptions } : {}),
      });

      async function* observe(): AsyncIterable<StreamChunk> {
        for await (const chunk of stream) {
          await options.onChunk?.(chunk);
          if (chunk.type === "RUN_FINISHED") {
            runCount += 1;
            finalFinishReason =
              chunk.finishReason ?? chunk.metadata?.tanstack?.finishReason ?? null;
            // Any provider spelling of "hit the output ceiling" — the chunk's own field,
            // a passed-through native reason, or an incomplete-details reason.
            if (isTruncatedFinish(chunk) || isTruncatedFinish(chunk.metadata?.tanstack)) {
              outputTruncated = true;
            }
            // AG-UI reports an array; the public normalizer also restores cache details
            // from TanStack metadata. Older adapters still report the legacy object.
            const tokenUsage = Array.isArray(chunk.usage)
              ? fromSpecTokenUsage(chunk.usage, chunk.metadata?.tanstack?.usage)
              : chunk.usage;
            if (tokenUsage) {
              const turnUsage: AgentUsage = {
                inputTokens: tokenUsage.promptTokens,
                outputTokens: tokenUsage.completionTokens,
                model: getServingModelId(),
              };
              const rawUsage = tokenUsage as unknown as Record<string, unknown>;
              const cachedInputTokens =
                tokenUsage.promptTokensDetails?.cachedTokens ??
                numericField(rawUsage, ["cachedTokens", "cached_tokens"]);
              const cacheCreationInputTokens =
                tokenUsage.promptTokensDetails?.cacheWriteTokens ??
                numericField(rawUsage, [
                  "cacheCreationTokens",
                  "cache_creation_input_tokens",
                  "cacheCreationInputTokens",
                ]);
              if (cachedInputTokens !== undefined) {
                turnUsage.cachedInputTokens = cachedInputTokens;
                usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + cachedInputTokens;
              }
              if (cacheCreationInputTokens !== undefined) {
                turnUsage.cacheCreationInputTokens = cacheCreationInputTokens;
                usage.cacheCreationInputTokens =
                  (usage.cacheCreationInputTokens ?? 0) + cacheCreationInputTokens;
              }
              usage.inputTokens += turnUsage.inputTokens;
              usage.outputTokens += turnUsage.outputTokens;
              if (usage.model === undefined) usage.model = turnUsage.model;
              await options.onUsage?.(turnUsage);
            }
          }
          yield chunk;
        }
      }

      try {
        await processor.process(observe());
      } catch (error) {
        if (fatalError) throw fatalError;
        throw error;
      }
      if (fatalError) throw fatalError;

      currentMessages = processor.getMessages().map(fromUIMessage);

      // Only now — the dispatch completed. The retry/failover adapter buffers a whole
      // attempt before yielding, so a mid-stream failure never reaches here and partial
      // assistant text is never announced as a turn. A truncated-but-finished turn IS
      // announced (it is real output, and the stop reason says it was cut off).
      await announceTurns(currentMessages);

      // A truncated turn is never a reason to dispatch again: whatever the model was
      // emitting (very plausibly a long tool call) is incomplete, and the caller must be
      // told rather than shown a clean-looking stop.
      if (outputTruncated) break;

      // Continue only when the model requested more tools.
      if (normalizeFinishReason(finalFinishReason) !== "tool-calls") break;
    }

    await callbackQueue;
    if (fatalError) throw fatalError;

    return {
      messages: currentMessages,
      usage,
      hitIterationLimit:
        !outputTruncated &&
        !timedOut &&
        runCount >= iterationCap &&
        normalizeFinishReason(finalFinishReason) === "tool-calls",
      ...(outputTruncated ? { outputTruncated: true } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      ...(finalFinishReason !== null ? { finishReason: finalFinishReason } : {}),
    };
  } finally {
    deadline.cancel();
  }
};
