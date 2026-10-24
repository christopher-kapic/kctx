import { z } from "zod";
import { httpUrl, originUrl } from "../url.js";

// ---------------------------------------------------------------------------
// Worker-safe variable DECLARATIONS.
//
// Split out of ../shared.ts so that tooling can read the key set without
// importing that module — which runs validation that throws when the variables
// are unset (exactly the situation in CI). Nothing in this directory may have
// import side effects. Dotenv loading lives in ../load-dotenv.ts / ../root-env.ts
// and is imported only from process entrypoints.
//
// `pnpm env:check` (scripts/lib/env-schema.ts) enumerates every module in this
// directory and takes `Object.keys()` of each exported declaration object, so a
// new variable is visible to the manifest check the moment it is added here.
// Declaring one inline in ../shared.ts instead would hide it — the check fails
// on that too.
// ---------------------------------------------------------------------------

export const strictBooleanFlag = (defaultValue: boolean = false) =>
  z
    .enum(["true", "false"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => value === "true");

export const sharedVars = {
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // Max connections in this process's Postgres pool (node-postgres `max`).
  // Default 10 matches the driver default — raise it only against the
  // database's connection budget, since every server/worker replica holds its
  // own pool. See patterns/schema-guidelines.md § Connection pool size and transaction-mode poolers.
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // ---- Asset hosting (optional). When S3_BUCKET is unset, the asset and
  // image endpoints return 503; the rest of the app boots fine. To enable,
  // configure all four required values below. Works with any S3-compatible
  // provider (AWS S3, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean
  // Spaces, etc.) — set S3_ENDPOINT for non-AWS providers. The worker shares
  // this config to read raw uploads and write HLS segments / analyze assets.
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // `httpUrl`, not a bare `z.url()`: Zod's URL check accepts anything the
  // WHATWG parser swallows, including scheme-less values like `minio:9000`.
  // Those reach `new URL(...).origin` as the literal string "null", which the
  // browser then rejects as an invalid CSP source — so direct-to-S3 uploads
  // break with a confusing console error instead of failing here, at boot,
  // with a message naming the variable. See s3ConnectSrcOrigins in
  // apps/server/src/security-headers.ts.
  //
  // Deliberately NOT `originUrl`: a reverse-proxied MinIO/Ceph endpoint may
  // carry a path (`https://s3.example.com/minio`), which the AWS SDK accepts
  // and origin-only validation would reject.
  S3_ENDPOINT: httpUrl("S3_ENDPOINT").optional(),
  // MinIO and some self-hosted providers require path-style URLs
  // (https://endpoint/bucket/key) instead of virtual-hosted-style
  // (https://bucket.endpoint/key). Default false works for AWS / R2.
  S3_FORCE_PATH_STYLE: strictBooleanFlag(),
  // ---- Logical database backups (optional). The shell scripts under
  // scripts/ (backup.sh, db-applier.sh) read these directly; the worker reads
  // them here to run the backup FRESHNESS check — a scheduled job that lists
  // the backup bucket and alerts admins when the newest dump is older than
  // BACKUP_MAX_AGE_HOURS. A dead backup cron produces no error of its own, so
  // "the newest dump is too old" is the only signal that covers both "ran and
  // failed" and "never ran". The check runs whenever BACKUP_ENABLED is true —
  // including before a bucket exists (`setup-missing`) — and is omitted only on
  // the deliberate provider-only profile (BACKUP_ENABLED=false).
  // BACKUP_S3_* must be a dedicated backup-bucket key — never the S3_* app
  // upload key; a stolen upload credential must not be able to read dumps.
  BACKUP_ENABLED: strictBooleanFlag(true),
  BACKUP_S3_BUCKET: z.string().optional(),
  BACKUP_S3_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional(),
  // The worker only lists objects for freshness; it never reads or writes a
  // dump. Keep that ListBucket-only identity separate from the dump key.
  BACKUP_MONITOR_S3_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: z.string().optional(),
  BACKUP_S3_REGION: z.string().default("auto"),
  BACKUP_S3_ENDPOINT: httpUrl("BACKUP_S3_ENDPOINT").optional(),
  BACKUP_S3_PREFIX: z.string().default("database"),
  BACKUP_S3_FORCE_PATH_STYLE: strictBooleanFlag(),
  // Newest dump older than this = stale. 36h tolerates one missed nightly
  // run plus clock skew without paging anyone; two misses always alert.
  BACKUP_MAX_AGE_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(36),
  // One-shot destructive operation controls are read by the db-applier shell
  // path on server/worker and the optional dedicated applier. They stay
  // optional here because normal boot must not carry them.
  WAIT_FOR_SCHEMA: z.enum(["true", "false"]).optional(),
  SCHEMA_WAIT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(3600).optional(),
  RESTORE_CONFIRM_NONCE: z.string().min(8).max(128).optional(),
  RESTORE_BACKUP_S3_ETAG: z.string().min(1).optional(),
  RESTORE_BACKUP_S3_VERSION_ID: z.string().min(1).optional(),
  // Restore-only escape hatch: must name the current database exactly and is
  // rejected on ordinary server/worker boot alongside every other RESTORE_* var.
  RESTORE_ALLOW_ACTIVE_CONNECTIONS: z.string().min(1).optional(),
  RESTORE_TARGET_MODE: z.enum(["empty-target", "in-place"]).optional(),
  // ---- Translation provider (optional). Used by `pnpm i18n:translate` to
  // fill non-default locale bundles. The validator keeps both API keys optional so the rest of the
  // app boots without them; the provider factory throws at first use if the
  // key for the chosen provider is missing.
  //
  // Default provider is `openrouter` because it's the cheapest path to
  // claude-haiku-4-5 + gives a single account multi-model access for A/B
  // experiments. Set TRANSLATION_PROVIDER=anthropic to call the Anthropic
  // API directly with ANTHROPIC_API_KEY.
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  TRANSLATION_PROVIDER: z.enum(["openrouter", "anthropic"]).default("openrouter"),
  // Optional public origin metadata for translation providers such as
  // OpenRouter. This is not used for auth and is safe for worker-only env.
  PUBLIC_APP_URL: originUrl("PUBLIC_APP_URL").optional(),
  // ---- Email transport (optional). Shared because both the server and the
  // worker use @starter/mailer. Keeping SMTP here lets worker-only deploys
  // opt into failure-alert emails without setting Better-Auth server vars.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  // ---- Durable agentic chat (optional). Consumed by the BullMQ `chat-run`
  // worker via @starter/agent-runtime. There is NO chat-specific API key: the
  // run reuses OPENROUTER_API_KEY declared above (the same env-configured key
  // `pnpm i18n:translate` uses), and the handler throws an actionable error on the
  // first job when it is unset. See patterns/add-ins/chat.md.
  //
  // Model id in OpenRouter's `vendor/model` form. Sonnet by default because a
  // tool-calling chat loop is materially worse on a small model; drop to
  // `anthropic/claude-haiku-4-5` if cost matters more than tool reliability.
  CHAT_MODEL: z.string().min(1).default("anthropic/claude-sonnet-4-5"),
  // The explicit ON switch for chat. Chat runs when this is true AND
  // `OPENROUTER_API_KEY` is set.
  //
  // The key is the real dependency — deriving enablement from it is the same
  // opt-in idiom `S3_BUCKET` gives assets — but the key ALONE must not be
  // enough, because it is SHARED with `pnpm i18n:translate`. Without this flag,
  // every existing app that configured OpenRouter for translations would
  // gain a user-facing chat page and a paid tool-calling Sonnet loop for every
  // signed-in user, on the deploy that merely pulled this template forward.
  //
  // DEFAULT FALSE, like every other feature toggle here (`SIGNUP_ENABLED`,
  // `SSO_ENABLED`, `FORCE_SSO`): a flag whose wrong value silently spends money
  // and widens the product's surface defaults to off, and turning chat on is
  // one line in your env. See patterns/add-ins/chat.md.
  CHAT_ENABLED: strictBooleanFlag(false),
  // Max model dispatches per user turn. Each tool call costs one, so this is
  // the ceiling on tool-use depth before the run stops with `max-iterations`
  // and the session flips to ERROR (retryable from the UI).
  // High by default so explore/tool-heavy turns finish; wall-clock timeout is
  // the hard bound. Force-final synthesis in runExploreAgent covers exhaustion.
  CHAT_MAX_ITERATIONS: z.coerce.number().int().positive().default(100),
  // Wall-clock ceiling for one user turn, in milliseconds, forwarded to the
  // agent loop as `timeoutMs`. CHAT_MAX_ITERATIONS only counts *completed*
  // dispatches, so a provider request or a tool call that never resolves is
  // invisible to it and would pin the job and its session at RUNNING forever,
  // blocking every later message in that session. On expiry the loop aborts its
  // in-flight dispatch and stops with `timeout`, which is not `completed` and
  // therefore takes the same recoverable ERROR path as any other partial answer.
  // Default 5min — well past a normal tool-using turn, well short of a wedge.
  CHAT_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  // How long *past* a run's own wall-clock ceiling a session may sit at RUNNING
  // before the `reap-stale-chat-runs` cron declares it dead and hands it back as
  // ERROR (which is the state `chat.retry` accepts). The reaper's threshold is
  // DERIVED — `CHAT_RUN_TIMEOUT_MS + CHAT_STALE_RUN_GRACE_MS` — never an
  // independent number: a threshold at or below the run ceiling would reap
  // healthy in-flight runs, and expressing it as a positive grace on top of the
  // ceiling makes that impossible to misconfigure. The grace covers everything
  // between the claim and the loop's own timer: queue wait at saturated
  // concurrency, the BullMQ retry backoff, and the run's final writes. Default
  // 5min, so a chat wedged by a crashed worker is recoverable ~10min later.
  CHAT_STALE_RUN_GRACE_MS: z.coerce.number().int().positive().default(300000),
  // Worker concurrency for the chat-run queue. I/O bound on the model
  // provider, not local CPU — raise it against the provider's rate limit.
  CHAT_RUN_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // Optional absolute (or process-cwd-relative) path to a source tree the chat
  // agent may investigate with confined glob/grep/read tools. When unset, chat
  // keeps only its default tools. Overnight stand-in for per-package
  // `Repository.clonedPath` scoping that kctx's query_dependency used.
  CHAT_EXPLORE_ROOT: z.string().min(1).optional(),
  // Redis TTL, in seconds, for tool-result bodies that overflow a tool's
  // `maxResultChars` and get paged back via the runtime's
  // `retrieve_tool_result` tool. Default 6h — comfortably longer than any
  // single run, short enough that abandoned runs expire on their own.
  RESULT_STORE_TTL_SECONDS: z.coerce.number().int().positive().default(21600),
  // Per-call model override. Falls through to the provider's default
  // (`anthropic/claude-haiku-4-5` for OpenRouter, `claude-haiku-4-5` for
  // direct Anthropic) when unset.
  TRANSLATION_MODEL: z.string().min(1).optional(),
};
