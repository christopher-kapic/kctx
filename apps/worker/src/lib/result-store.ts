import type { ResultSlice, ResultStore, StoredResult } from "@starter/agent-runtime";
import { env } from "@starter/env/shared";
import { createRedisConnection } from "@starter/queue";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

// Dedicated untimed connection for result-store traffic. The shared producer
// connection carries `commandTimeout: 5000 / maxRetriesPerRequest: 3`, sized
// for HTTP producers — a `get` issued by a minute-long agent run must never
// be cut off mid-turn by that budget. Created the same way the worker builds
// its own consumer connection in runtime.ts, rather than reusing the producer
// handle; closed alongside it via `closeResultStoreConnection()`.
const resultStoreConnection = createRedisConnection({ commandTimeout: undefined });

export function closeResultStoreConnection(): void {
  resultStoreConnection.disconnect();
}

/**
 * Redis-backed {@link ResultStore} for overflowed tool-result bodies.
 *
 * When a tool returns more than its `maxResultChars`, the agent runtime stores
 * the full body here and hands the model a bounded head plus a marker; the
 * model pages the tail with the auto-registered `retrieve_tool_result` tool.
 * Without a store, oversized results are hard-truncated and the remainder is
 * simply lost.
 *
 * Keys are namespaced by `namespace` (a run or session id) so a retrieve can
 * never reach another conversation's body, and entries expire after
 * `RESULT_STORE_TTL_SECONDS`. Uses the dedicated untimed connection above
 * rather than the shared producer handle — this is long-lived worker traffic,
 * not producer traffic.
 */
export function createRedisResultStore(namespace: string): ResultStore {
  const key = (id: string) => `result-store:${namespace}:${id}`;
  return {
    async put(id: string, entry: StoredResult): Promise<void> {
      await resultStoreConnection.set(
        key(id),
        JSON.stringify(entry),
        "EX",
        env.RESULT_STORE_TTL_SECONDS,
      );
    },
    async get(id: string, offset: number, limit: number): Promise<ResultSlice | null> {
      const raw = await resultStoreConnection.get(key(id));
      if (raw === null) return null;
      const entry = JSON.parse(raw) as StoredResult;
      const total = entry.body.length;
      // Clamp, never reject: `offset`/`limit` come from the model, and a
      // nonsensical pair should return an empty slice rather than fail the turn.
      const start = clamp(Math.trunc(offset), 0, total);
      const end = clamp(start + Math.max(0, Math.trunc(limit)), start, total);
      const slice = entry.body.slice(start, end);
      return {
        slice,
        offset: start,
        total,
        untrusted: entry.untrusted,
        hasMore: end < total,
      };
    },
  };
}
