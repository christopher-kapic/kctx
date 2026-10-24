import { z } from "zod";

/**
 * Job schemas — define the shape of each job's payload here.
 * Both producers and workers import from this file so the contract is shared.
 */

export const echoJobSchema = z.object({
  message: z.string(),
});

export type EchoJobData = z.infer<typeof echoJobSchema>;

/**
 * Re-derive an Asset row's width/height/blurhash from the bytes in S3 and
 * flip metadataState to SERVER_VERIFIED. Enqueued by the presigned-upload
 * finalize handler so client-supplied hints are eventually replaced with
 * server-verified values.
 */
export const analyzeAssetJobSchema = z.object({
  assetId: z.string().min(1),
});

export type AnalyzeAssetJobData = z.infer<typeof analyzeAssetJobSchema>;

/**
 * Sweep orphan PENDING Asset rows, orphan S3 objects under the `assets/`
 * prefix, and incomplete multipart uploads. Triggered manually from the
 * admin cleanup page (`reason: "admin"`) or by the 24h cron (`reason: "cron"`).
 *
 * The thresholds default to: 5 minutes for PENDING rows, 15 minutes minimum
 * age for orphan S3 objects (the in-flight grace window), 24 hours for
 * incomplete multiparts. Override only from automated tests.
 */
export const cleanupAssetsJobSchema = z.object({
  reason: z.enum(["admin", "cron"]),
  pendingMaxAgeMs: z.number().int().positive().optional(),
  objectMinAgeMs: z.number().int().positive().optional(),
  multipartMaxAgeMs: z.number().int().positive().optional(),
});

export type CleanupAssetsJobData = z.infer<typeof cleanupAssetsJobSchema>;

/**
 * Run the database seed (`packages/db/prisma/seed.ts → runSeed()`). Admin-only,
 * on-demand — there is no cron for this. `requestedBy` is the admin user id,
 * logged by the worker so a seed run is attributable.
 *
 * The handler is single-attempt (`attempts: 1`): a seed is author-written and
 * may not be safe to auto-retry, so a failure surfaces to the admin who then
 * decides whether to re-run.
 */
export const seedJobSchema = z.object({
  requestedBy: z.string().min(1),
});

export type SeedJobData = z.infer<typeof seedJobSchema>;

/**
 * Run one turn of a durable chat session through the agent loop
 * (`packages/agent-runtime`), persisting every assistant turn to Postgres and
 * publishing it on Redis pub/sub for live subscribers.
 *
 * `userMessageSeq` is the `ChatMessage.seq` of the user turn being answered. It
 * is part of the payload — not looked up by the handler — because it is also
 * what makes the job id deterministic (`enqueueChatRun`), so a double-submit
 * collapses onto the same BullMQ job instead of producing two answers.
 *
 * `runGeneration` is `ChatSession.runGeneration` as it stood *after* the claim
 * that produced this job — a persisted counter bumped atomically by `send` and
 * `retry`. It is the other half of the job id, and it is what makes a manual
 * retry a genuinely new job even when the failed attempt persisted nothing at
 * all. It is never derived from message rows; see the field's comment in
 * `packages/db/prisma/schema/chat.prisma` for why that derivation collides.
 */
export const chatRunJobSchema = z.object({
  sessionId: z.string().min(1),
  userMessageSeq: z.number().int().nonnegative(),
  runGeneration: z.number().int().nonnegative(),
});

export type ChatRunJobData = z.infer<typeof chatRunJobSchema>;

/**
 * The deterministic BullMQ job id `enqueueChatRun` adds a chat run under.
 *
 * It lives here, beside the payload it is derived from and away from the queue
 * constructors in `index.ts`, so tests can assert the id a payload produces
 * without opening a Redis socket. Two payloads collide on this id if and only
 * if they describe the same claim of the same turn — see `enqueueChatRun`.
 */
export const chatRunJobId = (data: ChatRunJobData) =>
  `chat-run-${data.sessionId}-${data.userMessageSeq}-g${data.runGeneration}`;

/**
 * Release chat sessions that are stuck in `RUNNING` with nothing on its way to
 * answer them, so `chat.retry` becomes available again.
 *
 * Three distinct failures land in exactly this state, and none of them has any
 * other recovery path:
 *   * the process died between `chat.send`'s commit and its `enqueueChatRun`
 *     (the claim is durable, the job never existed);
 *   * a worker was SIGKILLed mid-run (RUNNING plus a stale `activeJobId` that
 *     locks every future job out of the session);
 *   * BullMQ exhausted its attempts without the handler's error path running.
 *
 * `staleAfterMs` overrides the derived threshold
 * (`CHAT_RUN_TIMEOUT_MS + CHAT_STALE_RUN_GRACE_MS`) and exists for tests only —
 * see `apps/worker/src/handlers/reap-stale-chat-runs.ts`.
 */
export const reapStaleChatRunsJobSchema = z.object({
  reason: z.enum(["cron"]),
  staleAfterMs: z.number().int().positive().optional(),
});

export type ReapStaleChatRunsJobData = z.infer<typeof reapStaleChatRunsJobSchema>;

/**
 * Backup freshness check — lists the backup bucket, records the age of the
 * newest dump in Redis, and alerts admins when it exceeds BACKUP_MAX_AGE_HOURS.
 * Cron-only.
 */
export const checkBackupFreshnessJobSchema = z.object({
  reason: z.enum(["cron"]),
});

export type CheckBackupFreshnessJobData = z.infer<typeof checkBackupFreshnessJobSchema>;

/**
 * Delete short-lived credential rows past their `expiresAt` — Session,
 * Verification (`packages/api/src/lib/auth-token-retention.ts`).
 *
 * Nothing else prunes those tables: expiry was only ever enforced by rejecting
 * the credential at read time, so expired rows accumulated forever. This is a bounded Postgres delete that owes nothing to
 * object storage, so its scheduler is registered unconditionally.
 *
 * Cron-only; `attempts: 1` like the other sweeps, because the next daily
 * firing is the retry and the delete is idempotent by construction.
 */
export const reapExpiredAuthTokensJobSchema = z.object({
  reason: z.enum(["cron"]),
});

export type ReapExpiredAuthTokensJobData = z.infer<typeof reapExpiredAuthTokensJobSchema>;

/**
 * Queue names — use these constants instead of string literals.
 */
export const QUEUE_NAMES = {
  echo: "echo",
  analyzeAsset: "analyze-asset",
  cleanupAssets: "cleanup-assets",
  seed: "seed",
  chatRun: "chat-run",
  reapStaleChatRuns: "reap-stale-chat-runs",
  reapExpiredAuthTokens: "reap-expired-auth-tokens",
  checkBackupFreshness: "check-backup-freshness",
} as const;

/** Stable BullMQ Job Scheduler ID for the expired-auth-token sweep. */
export const REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID = "reap-expired-auth-tokens";

/**
 * Once a day at 04:17 UTC — deliberately off the 03:15 / 03:45 / 04:30 marks
 * the other daily sweeps fire on, so four bounded-delete loops never share a
 * window. Daily is the right cadence for rows whose only cost is existing:
 * an expired credential is dead the moment it ages out, and sweeping more
 * often would re-scan the same indexed range for nothing.
 */
export const REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN = "17 4 * * *";

/** Stable BullMQ Job Scheduler ID for the backup freshness check. */
export const CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID = "check-backup-freshness";

/**
 * Every 6 hours at :20. Nightly dumps land at 03:00 and BACKUP_MAX_AGE_HOURS
 * defaults to 36, so a missed run is noticed within a quarter-day of crossing
 * the threshold; more often would only re-list the bucket for the same answer.
 */
export const CHECK_BACKUP_FRESHNESS_CRON_PATTERN = "20 */6 * * *";

/** Stable BullMQ Job Scheduler ID for the stale-chat-run sweep. */
export const REAP_STALE_CHAT_RUNS_JOB_SCHEDULER_ID = "reap-stale-chat-runs";

/**
 * Every 5 minutes. This is a *latency* knob, not a safety one: the sweep only
 * ever touches sessions that have been RUNNING past
 * `CHAT_RUN_TIMEOUT_MS + CHAT_STALE_RUN_GRACE_MS`, so firing more often only
 * shortens how long a wedged conversation stays unusable, and firing less often
 * only lengthens it. The sweep is two indexed statements per stuck session, so
 * 5 minutes is cheap even with none to reap.
 */
export const REAP_STALE_CHAT_RUNS_CRON_PATTERN = "*/5 * * * *";

/** Stable BullMQ Job Scheduler ID for the 24h asset-cleanup schedule. */
export const CLEANUP_ASSETS_JOB_SCHEDULER_ID = "cleanup-assets-daily";

/** Once a day at 03:15 UTC. Quiet hours for most consumer apps. */
export const CLEANUP_ASSETS_CRON_PATTERN = "15 3 * * *";
