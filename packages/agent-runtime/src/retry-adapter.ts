import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";

import type { ModelAdapter } from "./adapters";
import { AgentRuntimeError } from "./errors";
import {
  computeBackoffMs,
  DEFAULT_MAX_ATTEMPTS_PER_MODEL,
  DEFAULT_MAX_WAIT_MS,
  getErrorStatus,
  isTransientModelError,
  MAX_FAILOVER_CANDIDATES,
  parseRetryAfterMs,
  sleepWithAbort,
} from "./retry";

type RetryFailoverCandidate = ModelAdapter & { modelId: string };

export type RetryFailoverOptions = {
  candidates: RetryFailoverCandidate[];
  abortSignal?: AbortSignal;
  maxAttemptsPerModel?: number;
  maxWaitMs?: number;
  baseDelayMs?: number;
  /** Called when a successful dispatch used a non-primary model. */
  onFailover?: (servingModelId: string, primaryModelId: string) => void;
  /** Test seam: override delay scheduling (receives ms). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam: fixed random for deterministic backoff. */
  random?: () => number;
};

/**
 * Wrap one or more model adapters so each `chatStream` call retries on transient
 * failures, then fails over to the next candidate (cap {@link MAX_FAILOVER_CANDIDATES}).
 *
 * CHUNKS ARE FORWARDED AS THEY ARRIVE, and the retry window closes with the
 * first one. That pairing is the whole design, so it is worth stating plainly:
 *
 *   • A dispatch that fails BEFORE emitting anything is retried and failed over
 *     freely. This is the overwhelming majority of transient failures — 429s,
 *     5xx, connection resets — because they happen while establishing the
 *     request, before a single token exists.
 *   • Once a chunk has been yielded, the attempt is COMMITTED. A retry would
 *     replay the answer from the top on top of text the consumer has already
 *     rendered and published, so a mid-stream failure is surfaced as an error
 *     instead. The worker turns that into a recoverable ERROR the user can
 *     retry deliberately, which is the honest outcome: only the user knows
 *     whether a half-written answer is worth paying for twice.
 *
 * The alternative — buffering the whole stream and yielding it only on success —
 * makes every failure retryable, and it is what this adapter used to do. It is
 * not worth it: it silently defeats streaming for EVERY successful response, the
 * common case. `onChunk` cannot fire until the model has finished, so a durable
 * SSE stream publishes nothing for the length of the answer and the UI sits
 * frozen until it arrives whole. Buying a rarer retry with the feature's entire
 * reason for existing is the wrong trade.
 */
export const createRetryFailoverAdapter = (
  options: RetryFailoverOptions,
): {
  adapter: AnyTextAdapter;
  modelOptions?: Record<string, unknown>;
  getServingModelId: () => string;
} => {
  const candidates = options.candidates.slice(0, MAX_FAILOVER_CANDIDATES);
  if (candidates.length === 0) {
    throw new Error("createRetryFailoverAdapter requires at least one candidate");
  }
  const primary = candidates[0]!;
  const maxAttempts = options.maxAttemptsPerModel ?? DEFAULT_MAX_ATTEMPTS_PER_MODEL;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const sleep = options.sleep ?? sleepWithAbort;
  let servingModelId = primary.modelId;

  const chatStream = async function* (
    streamOptions: Parameters<AnyTextAdapter["chatStream"]>[0],
  ): AsyncIterable<StreamChunk> {
    let lastError: unknown;
    let modelsTried = 0;
    let attemptsTotal = 0;
    // Has any chunk been handed to the consumer? Once true, no retry and no
    // failover can happen — see the note on this module's export.
    let committed = false;

    for (const candidate of candidates) {
      modelsTried += 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        attemptsTotal += 1;
        if (options.abortSignal?.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        try {
          for await (const chunk of candidate.adapter.chatStream(streamOptions)) {
            if (options.abortSignal?.aborted) {
              throw Object.assign(new Error("aborted"), { name: "AbortError" });
            }
            if (!committed) {
              // First chunk of this dispatch: the model is answering, so record
              // the serving id and announce a failover BEFORE any of it is
              // handed on. A consumer must never see text attributed to the
              // wrong model, and there is no later point to correct it from.
              committed = true;
              servingModelId = candidate.modelId;
              if (candidate.modelId !== primary.modelId) {
                options.onFailover?.(candidate.modelId, primary.modelId);
              }
            }
            yield chunk;
          }
          // A stream that completed without emitting anything is still a
          // success — an empty completion is a legitimate model response, and
          // the caller decides what it means.
          if (!committed) {
            servingModelId = candidate.modelId;
            if (candidate.modelId !== primary.modelId) {
              options.onFailover?.(candidate.modelId, primary.modelId);
            }
          }
          return;
        } catch (error) {
          lastError = error;
          if (
            (error instanceof Error && error.name === "AbortError") ||
            options.abortSignal?.aborted
          ) {
            throw error;
          }
          // COMMITTED: chunks are already downstream, rendered and very likely
          // published. Restarting would replay the answer from the top on top of
          // them. Transient or not, this one is over.
          if (committed) {
            throw error;
          }
          if (!isTransientModelError(error)) {
            throw error;
          }
          const isLastAttemptOnModel = attempt >= maxAttempts - 1;
          const isLastCandidate = candidate === candidates[candidates.length - 1];
          if (isLastAttemptOnModel && isLastCandidate) {
            break;
          }
          if (isLastAttemptOnModel) {
            // Fail over to next candidate without sleeping.
            break;
          }
          const delay = computeBackoffMs(attempt, {
            baseDelayMs: options.baseDelayMs,
            maxWaitMs,
            retryAfterMs: parseRetryAfterMs(error),
            random: options.random,
          });
          await sleep(delay, options.abortSignal);
        }
      }
    }

    const message =
      `Model dispatch failed after ${attemptsTotal} attempt(s) across ${modelsTried} model(s)` +
      (lastError instanceof Error ? `: ${lastError.message}` : "");
    throw new AgentRuntimeError(message, {
      retryable: true,
      status: getErrorStatus(lastError),
      cause: lastError,
    });
  };

  const adapter = {
    ...primary.adapter,
    model: primary.adapter.model,
    chatStream,
  } as AnyTextAdapter;

  return {
    adapter,
    modelOptions: primary.modelOptions,
    getServingModelId: () => servingModelId,
  };
};
