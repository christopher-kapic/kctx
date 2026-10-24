/**
 * THE canonical description of every environment variable in this repo.
 *
 * Three things read this file:
 *   1. `pnpm generate:secrets`  (scripts/generate-secrets.ts)  — builds a
 *      ready-to-paste production env block, generating what it can and
 *      prompting for what it can't.
 *   2. `pnpm env:sync`          (scripts/sync-env-example.ts)  — regenerates
 *      `.env.example`, `apps/web/.env.example`, and `apps/native/.env.example`.
 *      Those three files are GENERATED. Do not hand-edit them; edit this
 *      manifest and re-run the script.
 *   3. `pnpm env:check`         (same script, `--check`)       — CI gate. Fails
 *      when a key declared in a `packages/env/src/vars/*.ts` Zod schema is
 *      missing here, or when a generated `.env.example` is stale.
 *
 * ---------------------------------------------------------------------------
 * ADDING A NEW ENVIRONMENT VARIABLE
 * ---------------------------------------------------------------------------
 *   1. Declare it in the right `packages/env/src/vars/*.ts` object (shared =
 *      server + worker, server = server-only, web = VITE_*, native =
 *      EXPO_PUBLIC_*) — never inline in the `createEnv({…})` call one
 *      directory up, which the scan cannot see.
 *   2. Add an entry to `ENV_VARS` below, in an existing group or a new one.
 *   3. Run `pnpm env:sync` and commit the regenerated `.env.example` files.
 *
 * Skipping step 2 fails CI — that is deliberate. A variable that the generator
 * doesn't know about is a variable that silently goes missing from a
 * production deploy and surfaces as a boot crash weeks later.
 *
 * REMOVING A FEATURE MODULE (patterns/removable/*.md): delete that module's
 * group and its vars from this file, then run `pnpm env:sync`.
 */

// ---------------------------------------------------------------------------
// Deploy targets
// ---------------------------------------------------------------------------

/**
 * Deploy targets the generator knows about. Dokploy on a VPS is the repo's
 * deployment target (`patterns/deployment-vps.md`); the cross-platform
 * contract is `infra-notes.md`.
 */
export const DEPLOY_TARGETS = [
  {
    id: "vps",
    label: "VPS / Dokploy",
    doc: "patterns/deployment-vps.md",
    injects: [],
    note: "You own the Postgres and Redis instances, so you supply both connection strings.",
  },
  {
    id: "other",
    label: "Other / not sure",
    doc: "infra-notes.md",
    injects: [],
    note: "Prompting for every non-defaulted variable. Delete anything your platform injects for you.",
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which .env file a variable belongs to. */
export type EnvFile = "root" | "web" | "native";

interface EnvGroup {
  id: string;
  /** Section heading in the generated .env.example. */
  title: string;
  file?: EnvFile;
  /** Always included; never prompted for. */
  always?: boolean;
  /**
   * Yes/no question gating the whole group in `pnpm generate:secrets`.
   * Omitted for `always` groups and for `tuning` groups.
   */
  prompt?: string;
  /** Default answer to `prompt`. */
  default?: boolean;
  /**
   * Tuning-only group: every var has a schema default, so the generator emits
   * the whole group commented out and never prompts.
   */
  tuning?: boolean;
  /**
   * Force this group on (skipping its yes/no) when an earlier answer makes it
   * mandatory — e.g. SMTP is not optional once SIGNUP_ENABLED is true, because
   * the server hard-throws at boot without it. Without this, the contradiction
   * only surfaces in the final validation pass, after every prompt has been
   * answered, and the whole run has to be redone.
   */
  requiredWhen?: { key: string; equals: string; because: string };
  /**
   * Offer to reuse this group's values from the shell environment the script
   * runs in, when they are already set there. Meant for credentials you hold
   * once and point several prototype apps at (SMTP, object storage, an LLM
   * key) — not for per-app values like BETTER_AUTH_URL or DATABASE_URL, where
   * silently inheriting another app's value is a footgun.
   */
  reuseFromEnv?: boolean;
  /** Comment block emitted above the section. */
  comment?: string[];
}

export interface EnvVar {
  key: string;
  group: string;
  /**
   * - `generate`: the script produces a value with `generator`.
   * - `prompt`:   only you know it — the script asks.
   * - `confirm`:  yes/no question; emits `"true"` only when the answer is yes
   *               (schema default covers the no case).
   * - `enable`:   when this var's group is selected, emit `"true"` automatically
   *               (feature flags that must flip on with their optional block).
   * - `default`:  a documented default value covers it, so the generator never
   *               asks and omits the key (shown commented out under `--all`).
   * - `manual`:   deliberate opt-in with no useful prompt; same emission as
   *               `default`, but documented in `.env.example` (rare — prefer
   *               `prompt`).
   */
  source: "generate" | "prompt" | "confirm" | "enable" | "default" | "manual";
  generator?: "secret32" | "vapid-public" | "vapid-private";
  /**
   * The effective default, for documentation only — setting this changes
   * nothing at runtime. Usually mirrors a Zod `.default()`; see `defaultFrom`
   * for the handful that come from application code instead.
   */
  default?: string;
  /**
   * Where `default` actually comes from. `"schema"` (the assumed case) means a
   * Zod `.default()`. `"app"` means the schema field is optional and the
   * fallback lives in application code — say so explicitly, because
   * `pnpm env:check` compares key sets, not defaults, and cannot catch this
   * drifting.
   */
  defaultFrom?: "schema" | "app";
  /**
   * Fixed set of valid values. Rendered as an `Allowed: …` line in
   * `.env.example`, and offered as a pick-list instead of a free-text prompt.
   */
  choices?: Array<{ value: string; label?: string; description?: string }>;
  /**
   * Shape-check applied at the prompt, mirroring the Zod refinement that would
   * otherwise only fire in the final validation pass — so a typo costs one
   * retry instead of the whole run.
   */
  format?: "origin" | "push-subject";
  /**
   * Set `false` to keep this var OUT of its group's reuse-from-environment
   * offer, even when the group has `reuseFromEnv`. For values that identify one
   * specific app rather than a shared provider account — inheriting those
   * silently points the new app at the previous one's resources.
   */
  reusable?: boolean;
  /**
   * Let the operator skip this otherwise-required var (empty answer = omit).
   * For values a platform may supply out of band — the generator records the
   * omission in the output header instead of blocking on it.
   */
  omittable?: boolean;
  /** Required once its group is enabled. Prompts are re-asked until answered. */
  required?: boolean;
  /** Question text for `source: "prompt"` / `source: "confirm"`. */
  prompt?: string;
  /** Default answer for `source: "confirm"` (false when omitted). */
  confirmDefault?: boolean;
  /** Extra guidance printed under the prompt. */
  hint?: string;
  /** Placeholder shown in the generated .env.example. */
  example?: string;
  /**
   * Emit this var UNCOMMENTED in the generated .env.example. Reserve it for
   * vars whose `example` is a working local-dev value — a live line with a
   * non-functional placeholder is worse than a commented one, because
   * `emptyStringAsUndefined` won't save you from a wrong value.
   * `source: "generate"` vars are always emitted live but empty.
   */
  exampleSet?: boolean;
  /** True for values that must never be echoed back or logged. */
  secret?: boolean;
  file?: EnvFile;
  /**
   * Set `false` for variables read outside the Zod schemas (e.g. by a shell
   * entrypoint). Excludes the key from the schema-coverage check's expectation
   * that every manifest key is also a schema key.
   */
  inSchema?: boolean;
  /** Comment lines emitted above the var. */
  comment?: string[];
  /**
   * Render into the trailing "Advanced tuning" section of the root
   * `.env.example` instead of the var's own feature section — for one-off
   * knobs a nontechnical operator should never touch (rate-limit budgets,
   * codec settings, cache TTLs). Always commented with the default shown.
   * The manifest and `generate:secrets --all` are unaffected; only the
   * `.env.example` placement moves.
   */
  advanced?: boolean;
  /**
   * Omit from the generated `.env.example` entirely. For deep one-shot knobs
   * (restore confirmations, db-applier modes) whose audience
   * reads `patterns/` docs, not the example file — the full catalog stays
   * here and in the Zod schema. Only valid on `source: "default"` /
   * `"manual"` vars (never on anything prompted, generated, or enabling).
   */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const ENV_GROUPS: EnvGroup[] = [
  {
    id: "core",
    title: "Datastores — [shared] (server + worker)",
    always: true,
  },
  {
    id: "runtime",
    title: "Runtime + schema sync — [shared]",
    always: true,
    comment: [
      "APPLY_SCHEMA gates whether `prisma db push` runs at container start, and",
      "how aggressively. Set it to `safe` on EXACTLY ONE image (the schema",
      "leader) for a schema-changing deploy, then flip it back to `off`.",
      "dangerous additionally requires a target/fingerprint-bound",
      "APPLY_SCHEMA_CONFIRM. Full contract: infra-notes.md § The APPLY_SCHEMA contract.",
    ],
  },
  {
    id: "backups",
    title: "Database backups — [shared]",
    prompt: "Configure off-site database backups (S3/R2)?",
    default: true,
    comment: [
      "Logical pg_dump backups uploaded to a private bucket. Production",
      "requires a dedicated BACKUP_S3_ACCESS_KEY_ID (not the app upload key),",
      "limited to GetObject, PutObject, and AbortMultipartUpload on the backup bucket. The freshness",
      "worker should use a distinct ListBucket-only monitor credential, not the",
      "dump-writer key.",
      "The db-applier image runs scheduled backups (BACKUP_CRON) and optional",
      "pre-apply dumps before APPLY_SCHEMA. Restore runs on the db-applier",
      "image only (RESTORE_BACKUP_S3_KEY + RESTORE_CONFIRM). See",
      "patterns/backup-and-restore.md.",
    ],
  },
  {
    id: "auth",
    title: "Auth — [server-only]",
    always: true,
  },
  {
    id: "admin",
    title: "Admin + signup — [server-only]",
    always: true,
  },
  {
    id: "smtp",
    reuseFromEnv: true,
    title: "Email (SMTP) — [shared]",
    prompt: "Configure outgoing email (SMTP)?",
    default: true,
    requiredWhen: {
      key: "SIGNUP_ENABLED",
      equals: "true",
      because:
        "public signup is enabled, and Better-Auth enforces email verification — " +
        "the server refuses to boot in production without SMTP",
    },
    comment: [
      "REQUIRED if SIGNUP_ENABLED=true — Better-Auth enforces email verification",
      "on signup, and the server refuses to boot in production without it.",
      "Local dev: `pnpm dev:services` starts a mailpit sink and `pnpm run setup`",
      "  fills these three lines automatically; read captured mail at",
      "  http://localhost:8025",
    ],
  },
  {
    id: "sso",
    title: "SSO / enterprise login — [server-only]",
    prompt: "Configure SSO (OIDC) login?",
    default: false,
    comment: [
      "Optional. FORCE_SSO=true in production requires SSO_ENABLED plus all",
      "three SSO_CLIENT_ID / SSO_CLIENT_SECRET / SSO_ISSUER values, or the",
      "server throws at boot.",
    ],
  },
  {
    id: "push",
    title: "Web Push (VAPID) — [server-only]",
    prompt: "Enable web push notifications?",
    default: false,
    comment: [
      "Optional — the app runs fine without these. Set ALL THREE or none.",
      "The keypair is generated for you by `pnpm generate:secrets`; you supply",
      "VAPID_SUBJECT, a real mailto: or https: URL push services use to reach",
      "YOU about delivery problems. See patterns/removable/push.md.",
    ],
  },
  {
    id: "s3",
    reuseFromEnv: true,
    title: "Asset storage (S3-compatible) — [shared]",
    prompt: "Enable object storage (uploads, avatars, media)?",
    default: false,
    comment: [
      "Optional. With S3_BUCKET unset, /api/assets/* and /api/images/* return",
      "503 and the rest of the app boots. Works with AWS S3,",
      "Cloudflare R2, MinIO, Backblaze B2, DigitalOcean Spaces. See",
      "patterns/assets.md.",
    ],
  },
  {
    id: "translation",
    reuseFromEnv: true,
    title: "Translation provider — [shared]",
    prompt: "Enable i18n bundle translation?",
    default: false,
    comment: [
      "Used by `pnpm i18n:translate`.",
      "The app boots without these; the worker throws on the first job if the",
      "chosen provider's key is missing. Default provider is `openrouter` with",
      "`anthropic/claude-haiku-4-5` (~$0.05 for a full UI bundle). See patterns/i18n.md.",
    ],
  },
  {
    id: "chat",
    title: "Durable agentic chat — [shared]",
    // No interactive enable prompt: every CHAT_* / RESULT_STORE_* var has a
    // schema default, so a yes/no would be a no-op. Chat is on whenever the
    // worker runs and OPENROUTER_API_KEY (translation group above) is set.
    tuning: true,
    comment: [
      "Optional tuning for the durable chat runtime (packages/agent-runtime +",
      "the BullMQ chat-run worker). Requires the worker and an OpenRouter key —",
      "chat deliberately reuses OPENROUTER_API_KEY from the translation group",
      "above rather than declaring a second provider secret. Every value has a",
      "working default; override only to tune. See patterns/add-ins/chat.md.",
    ],
  },
  {
    id: "ratelimit",
    title: "Rate limiting — [server-only]",
    tuning: true,
    comment: [
      "Five named budgets (AUTH, RPC, UPLOAD, EMAIL, CHAT), two knobs",
      "each. Each budget describes its family's reference member; every other",
      "limiter in the family scales with it at its designed ratio, so setting",
      "a budget re-tunes the whole family coherently. Defaults are sensible;",
      "tighter is not safer — if a surface 429s legitimate users, split the",
      "surface instead of shrinking a budget. See patterns/rate-limiting.md.",
    ],
  },
  {
    id: "images",
    title: "Image proxy + transforms — [server-only]",
    tuning: true,
    comment: [
      "Optional tuning. IMAGE_PROXY_ALLOWED_HOSTS is an SSRF guard: empty means",
      "external URL proxying is disabled and only stored assets can be",
      "transformed. Set it only when you intentionally proxy remote images.",
    ],
  },
  {
    id: "limits",
    title: "Upload + cache limits — [server-only]",
    tuning: true,
    comment: ["Optional tuning. Sensible defaults are built in."],
  },
  // --- apps/web/.env ---
  {
    id: "web",
    title: "Web app (build-time, public)",
    file: "web",
    always: true,
    comment: [
      "These are BUILD-TIME client vars — they are inlined into the browser",
      "bundle and are therefore public. Never put a secret here.",
    ],
  },
  // --- apps/native/.env ---
  {
    id: "native",
    title: "Expo app (build-time, public)",
    file: "native",
    always: true,
    comment: [
      "EXPO_PUBLIC_* is public client config baked into the app binary.",
      "Never put a secret here. See patterns/native.md.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export const ENV_VARS: EnvVar[] = [
  // --- core ----------------------------------------------------------------
  {
    key: "DATABASE_URL",
    group: "core",
    source: "prompt",
    required: true,
    omittable: true,
    secret: true,
    prompt: "PostgreSQL connection string",
    hint: "e.g. postgresql://user:password@host:5432/dbname — or leave blank to omit and set it on the platform",
    example: "postgresql://postgres:password@localhost:5432/starter",
    exampleSet: true,
  },
  {
    key: "REDIS_URL",
    group: "core",
    source: "prompt",
    required: true,
    omittable: true,
    secret: true,
    prompt: "Redis connection string",
    hint: "e.g. redis://default:password@host:6379 (BullMQ + rate limiting) — or leave blank to omit and set it on the platform",
    example: "redis://localhost:6379",
    exampleSet: true,
  },
  {
    key: "DATABASE_POOL_MAX",
    group: "core",
    source: "default",
    default: "10",
    advanced: true,
    comment: [
      "Max connections in this process's Postgres pool (node-postgres `max`).",
      "Default 10 matches the driver default — raise it only against the",
      "database's connection budget, since every server/worker replica holds its own pool.",
      "Full pooler note: patterns/schema-guidelines.md § Connection pool size and transaction-mode poolers.",
    ],
  },

  // --- runtime -------------------------------------------------------------
  {
    key: "NODE_ENV",
    group: "runtime",
    source: "default",
    default: "development",
    choices: [{ value: "production" }, { value: "development" }, { value: "test" }],
    example: "production",
    comment: [
      "Set to `production` on every deployed environment. Several env guards",
      "escalate from a warning to a hard boot failure when this is `production`",
      "— that is intentional, do not weaken it to silence a startup error.",
    ],
  },
  {
    key: "APPLY_SCHEMA",
    group: "runtime",
    source: "default",
    default: "off",
    choices: [{ value: "off" }, { value: "safe" }, { value: "dangerous" }],
    inSchema: false,
    example: "off",
    comment: [
      "off | safe | dangerous. Read by scripts/docker-entrypoint.sh and",
      "scripts/db-applier.sh, not by the Zod env schemas. Keep this `off`",
      "for a normal deploy. dangerous requires APPLY_SCHEMA_CONFIRM.",
    ],
  },
  {
    key: "WAIT_FOR_SCHEMA",
    hidden: true,
    group: "runtime",
    source: "default",
    default: "false",
    example: "false",
    choices: [{ value: "false" }, { value: "true" }],
    comment: [
      "App/worker with an external applier: wait for its matching successful schema receipt and an empty live diff before starting. Requires APPLY_SCHEMA=off.",
    ],
  },
  {
    key: "SCHEMA_WAIT_TIMEOUT_SECONDS",
    hidden: true,
    group: "runtime",
    source: "default",
    default: "300",
    example: "300",
    comment: [
      "Startup schema wait budget (1-3600 seconds). Timeout fails deployment; it never bypasses the schema gate.",
    ],
  },
  {
    key: "APPLY_SCHEMA_CONFIRM",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    example: "",
    comment: [
      "For dangerous apply: DANGEROUS:<target-id>:<schema-fingerprint>. The",
      "applier prints both values after it obtains the advisory lock. Unset",
      "after the one-shot deploy.",
    ],
  },
  {
    key: "APPLY_SCHEMA_ACCEPT_PROVIDER_BACKUP",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    example: "",
    comment: [
      "Leave empty. Only set to I_ACCEPT_PROVIDER_BACKUP_ONLY when",
      "APPLY_SCHEMA=dangerous and logical backups are disabled (provider-only",
      "profile). Unset after the deploy completes.",
    ],
  },
  {
    key: "BACKUP_ENABLED",
    group: "backups",
    source: "default",
    default: "true",
    choices: [{ value: "true" }, { value: "false" }],
    example: "true",
    comment: [
      "Master switch for logical pg_dump backups. When false, scheduled and",
      "manual backup runs log a warning and exit without dumping.",
    ],
  },
  {
    key: "BACKUP_PRE_APPLY_ENABLED",
    hidden: true,
    group: "backups",
    source: "default",
    default: "true",
    inSchema: false,
    choices: [{ value: "true" }, { value: "false" }],
    example: "true",
    comment: [
      "When false, APPLY_SCHEMA deploys skip the pre-push pg_dump and log a",
      "warning. Use with scheduled backups or provider snapshots only.",
    ],
  },
  {
    key: "BACKUP_CRON",
    hidden: true,
    group: "backups",
    source: "default",
    default: "0 3 * * *",
    inSchema: false,
    example: "0 3 * * *",
    comment: [
      "5-field cron for scheduled backups. A platform scheduler does not read",
      "this from env — mirror the value there when one drives the backup job.",
      "In-container schedule: DB_APPLIER_MODE=schedule on",
      "Dockerfile.db-applier reads it at service startup.",
    ],
  },
  {
    key: "DB_APPLIER_MODE",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    default: "backup",
    choices: [{ value: "backup" }, { value: "apply" }, { value: "restore" }, { value: "schedule" }],
    comment: [
      "supported db-applier entrypoint (Dockerfile.db-applier). Never set this on the",
      "web or worker services. schedule runs BACKUP_CRON in-container.",
    ],
  },
  {
    key: "RESTORE_BACKUP_S3_KEY",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    secret: true,
    comment: [
      "One-shot db-applier job only, in restore mode (container command",
      "`restore`, or DB_APPLIER_MODE=restore). The S3 object key of the dump to",
      "restore. With a matching RESTORE_CONFIRM the restore runs and the job",
      "exits. Every other mode — including the recurring db-backup cron — fails",
      "at start while any RESTORE_* variable is set, and the web and worker",
      "entrypoints refuse to boot. Never set this on a scheduled service.",
    ],
  },
  {
    key: "RESTORE_CONFIRM",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    secret: true,
    comment: [
      "For restore: RESTORE:<target-id>:<source-sha256>:<fresh-nonce>. The applier",
      "downloads with RESTORE_BACKUP_S3_ETAG (and optional version ID), prints the",
      "target/source identities, and refuses a mismatched confirmation.",
    ],
  },
  {
    key: "RESTORE_CONFIRM_NONCE",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    secret: true,
    comment: ["Fresh 8-128 character nonce bound into the one-shot restore confirmation."],
  },
  {
    key: "RESTORE_BACKUP_S3_ETAG",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    secret: true,
    comment: [
      "Required exact ETag of RESTORE_BACKUP_S3_KEY. The applier performs HeadObject",
      "and conditional GetObject before any mutation, so an object replacement cannot",
      "silently change the selected source dump.",
    ],
  },
  {
    key: "RESTORE_BACKUP_S3_VERSION_ID",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    secret: true,
    comment: ["Optional exact object version ID for versioned S3-compatible buckets."],
  },
  {
    key: "RESTORE_TARGET_MODE",
    hidden: true,
    group: "runtime",
    source: "default",
    choices: [{ value: "empty-target" }, { value: "in-place" }],
    comment: [
      "Restore job only. Omitted means empty-target: require a new empty destination, preserve the original database. in-place additionally requires RESTORE-IN-PLACE confirmation and a target snapshot. Never set on app/worker.",
    ],
  },
  {
    key: "RESTORE_ALLOW_ACTIVE_CONNECTIONS",
    hidden: true,
    group: "runtime",
    source: "default",
    inSchema: false,
    secret: true,
    comment: [
      "Restore-only escape hatch. It must exactly name the target database when an unavoidable pooler or provider monitor holds a connection; ordinary web/worker boot refuses it.",
    ],
  },
  {
    key: "PORT",
    hidden: true,
    group: "runtime",
    source: "default",
    comment: [
      "[server-only] Injected by most platforms. Leave unset unless you are",
      "running the container by hand.",
    ],
  },
  {
    key: "SERVER_PORT",
    hidden: true,
    group: "runtime",
    source: "default",
    default: "3000",
    defaultFrom: "app",
    comment: [
      "[server-only] Raw local runs (`pnpm dev:raw`) and container overrides",
      "only. Leave unset for the default portless dev flow — portless injects",
      "PORT per app. The schema field is optional with no Zod default; 3000 is",
      "the fallback in apps/server/src/index.ts.",
    ],
  },

  {
    key: "WORKER_MODE",
    group: "runtime",
    source: "default",
    default: "embedded",
    comment: [
      "[server-only] embedded runs background jobs in the app (default).",
      "Set external only when deploying a dedicated worker with the same Redis/database.",
      "External mode never silently falls back; /ready fails if consumers disappear.",
    ],
  },

  // --- auth ----------------------------------------------------------------
  {
    key: "BETTER_AUTH_SECRET",
    group: "auth",
    source: "generate",
    generator: "secret32",
    required: true,
    secret: true,
    comment: [
      "REQUIRED, minimum 32 characters. The env validator rejects weak and",
      "placeholder values in production. Rotating this invalidates every",
      "existing session — generate once per environment and keep it stable.",
      "",
      "For LOCAL dev this is filled in for you by `pnpm run setup`; to mint one",
      "by hand use `pnpm generate:secret` and paste it below. For a PRODUCTION",
      "environment prefer `pnpm generate:secrets`, which generates this along",
      "with the rest of the block and validates the result.",
    ],
  },
  {
    key: "BETTER_AUTH_URL",
    format: "origin",
    group: "auth",
    source: "prompt",
    required: true,
    prompt: "Public app origin (used by auth callbacks and for SEO URLs)",
    hint: "Origin only — no path, query, hash, or credentials. e.g. https://app.example.com",
    example: "https://starter.localhost",
    exampleSet: true,
  },
  {
    key: "CORS_ORIGIN",
    format: "origin",
    group: "auth",
    source: "manual",
    example: "https://app.example.com",
    comment: [
      "Optional. Set ONLY when the browser app runs on a different origin than",
      "the API (raw web dev, Expo web, split-origin deploys). Leave unset for",
      "the default same-origin flow. No path, query, or hash.",
    ],
  },
  {
    key: "TRUST_PROXY_HOPS",
    advanced: true,
    group: "auth",
    source: "manual",
    example: "1",
    comment: [
      "Number of reverse-proxy hops in front of the app, for deriving the real",
      "client IP used as the anonymous rate-limit key. LEAVE UNSET — the default",
      "auto-detects a client behind a private-network proxy (e.g. Dokploy/nginx)",
      "and keys on the socket peer otherwise. Set it only",
      "when a proxy in front of the app has a PUBLIC IP (e.g. Cloudflare): the",
      "exact hop count. 0 disables X-Forwarded-For entirely.",
    ],
  },

  // --- admin ---------------------------------------------------------------
  {
    key: "ADMIN_EMAILS",
    group: "admin",
    source: "prompt",
    required: true,
    prompt: "Admin email addresses (comma-separated)",
    hint: "These accounts get admin privileges. Emails are trimmed and lowercased. Bootstrap-only: after provisioning, admins persist in the database and this list can be cleared. An empty list with SIGNUP_ENABLED=false (the default) only warns at boot — on a fresh install with no admin yet, nobody can become admin.",

    example: "admin@example.com,other@example.com",
  },
  {
    key: "SIGNUP_ENABLED",
    group: "admin",
    source: "confirm",
    confirmDefault: false,
    prompt: "Enable public signup",
    hint: "Leave off for internal tools. On requires SMTP below — email verification is enforced and production refuses to boot without it.",
    default: "false",
    example: "false",
    comment: [
      "DISABLED by default: account creation is rejected and the signup form is",
      "hidden — the safe default for internal tools. Set `true` for a",
      "customer-facing app, which also REQUIRES SMTP below (email verification",
      "is enforced on signup and the server refuses to boot without it).",
    ],
  },

  // --- smtp ----------------------------------------------------------------
  {
    key: "SMTP_HOST",
    group: "smtp",
    source: "prompt",
    required: true,
    prompt: "SMTP host",
    hint: "e.g. smtp.resend.com, smtp.postmarkapp.com, email-smtp.us-east-1.amazonaws.com",
    example: "localhost",
  },
  {
    key: "SMTP_PORT",
    group: "smtp",
    source: "prompt",
    required: true,
    prompt: "SMTP port",
    hint: "587 for STARTTLS (most providers), 465 for implicit TLS, 1025 for a local mailpit sink",
    example: "1025",
  },
  {
    key: "SMTP_USER",
    group: "smtp",
    source: "prompt",
    prompt: "SMTP username (blank if your provider doesn't require auth)",
    example: "",
  },
  {
    key: "SMTP_PASS",
    group: "smtp",
    source: "prompt",
    secret: true,
    prompt: "SMTP password / API key (blank if not required)",
    example: "",
  },
  {
    key: "SMTP_FROM",
    group: "smtp",
    source: "prompt",
    required: true,
    // Excluded from the group's reuse offer: this is the app's own From:
    // identity, so inheriting it sends the new app's mail branded as the old.
    reusable: false,
    prompt: "From: address for outgoing mail",
    hint: 'e.g. "App Name <no-reply@yourdomain.com>". Required whenever SMTP_HOST is set.',
    example: "noreply@example.com",
  },

  // --- sso -----------------------------------------------------------------
  {
    key: "SSO_ENABLED",
    group: "sso",
    // Flipped to true automatically when the SSO group is enabled — credentials
    // alone do not turn SSO on (packages/auth gates on this flag).
    source: "enable",
    default: "false",
    example: "true",
  },
  {
    key: "SSO_CLIENT_ID",
    group: "sso",
    source: "prompt",
    required: true,
    prompt: "SSO client ID",
    example: "",
  },
  {
    key: "SSO_CLIENT_SECRET",
    group: "sso",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "SSO client secret",
    example: "",
  },
  {
    key: "SSO_ISSUER",
    group: "sso",
    source: "prompt",
    required: true,
    prompt: "SSO issuer URL",
    hint: "e.g. https://your-org.okta.com",
    example: "https://your-org.okta.com",
  },
  {
    key: "SSO_PROVIDER_NAME",
    group: "sso",
    source: "prompt",
    default: "SSO",
    prompt: "SSO provider display name (shown on the login button)",
    hint: 'e.g. "Okta", "Entra ID", "Google Workspace"',
    example: "Okta",
  },
  {
    key: "FORCE_SSO",
    advanced: true,
    group: "sso",
    source: "default",
    default: "false",
    example: "false",
    comment: [
      "true disables password login entirely. In production this requires",
      "SSO_ENABLED plus all three SSO credentials or the server throws at boot.",
    ],
  },

  // --- push ----------------------------------------------------------------
  {
    key: "VAPID_PUBLIC_KEY",
    group: "push",
    source: "generate",
    generator: "vapid-public",
    required: true,
  },
  {
    key: "VAPID_PRIVATE_KEY",
    group: "push",
    source: "generate",
    generator: "vapid-private",
    required: true,
    secret: true,
  },
  {
    key: "VAPID_SUBJECT",
    format: "push-subject",
    group: "push",
    source: "prompt",
    required: true,
    prompt: "VAPID contact URI",
    hint: "A mailto: or https: URL push services use to contact YOU about delivery problems. Use a real, monitored address.",
    example: "mailto:you@yourdomain.com",
  },

  // --- s3 ------------------------------------------------------------------
  {
    key: "S3_BUCKET",
    group: "s3",
    source: "prompt",
    required: true,
    // Excluded from the group's reuse offer. Sharing an S3 *account* across
    // prototypes is the point, but each app still needs its own namespace —
    // either its own bucket, or its own `bucket/prefix` slice of a shared one
    // (parseBucketSpec in packages/api/src/lib/storage.ts scopes every key,
    // LIST, and cleanup sweep to the prefix). A bare shared bucket name would
    // commingle two apps' uploads, avatars, and media.
    reusable: false,
    prompt: "S3 bucket name (or bucket/prefix to share one bucket across apps)",
    example: "",
    comment: [
      "Accepts `bucket` or `bucket/prefix`. With a prefix, all objects live",
      "under `prefix/` and LISTs + cleanup sweeps are scoped to it — several",
      "dev apps can share one bucket, one prefix each. See patterns/assets.md.",
    ],
  },
  {
    key: "S3_REGION",
    group: "s3",
    source: "prompt",
    default: "auto",
    prompt: "S3 region",
    hint: '"auto" for Cloudflare R2; a real region (e.g. us-east-1) for AWS S3',
    example: "auto",
  },
  {
    key: "S3_ACCESS_KEY_ID",
    group: "s3",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "S3 access key ID",
    example: "",
  },
  {
    key: "S3_SECRET_ACCESS_KEY",
    group: "s3",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "S3 secret access key",
    example: "",
  },
  {
    key: "S3_ENDPOINT",
    // The schema uses `httpUrl`, which allows a path (reverse-proxied MinIO),
    // so `format: "origin"` would be stricter than the schema and reject a
    // value the app accepts. Left unset deliberately — see packages/env/src/url.ts.
    group: "s3",
    source: "prompt",
    prompt: "S3 endpoint URL (blank for AWS S3)",
    hint: "Include the scheme. Required for non-AWS providers, e.g. https://<account>.r2.cloudflarestorage.com",
    example: "",
  },
  {
    key: "S3_FORCE_PATH_STYLE",
    group: "s3",
    source: "default",
    default: "false",
    example: "false",
    comment: [
      "MinIO and some self-hosted providers need path-style URLs",
      "(https://endpoint/bucket/key). The default works for AWS and R2.",
    ],
  },

  // --- backups -------------------------------------------------------------
  {
    key: "BACKUP_S3_BUCKET",
    group: "backups",
    source: "prompt",
    required: true,
    reusable: false,
    prompt: "Backup bucket name",
    hint: "Private bucket for pg_dump custom-format dumps. Prefer a dedicated bucket, not the app-assets bucket.",
    example: "",
  },
  {
    key: "BACKUP_S3_ACCESS_KEY_ID",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup S3 access key ID",
    hint: "Required for dump writers. Must be a distinct GetObject/PutObject/AbortMultipartUpload key — never S3_ACCESS_KEY_ID.",
    example: "",
  },
  {
    key: "BACKUP_S3_SECRET_ACCESS_KEY",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup S3 secret access key",
    example: "",
  },
  {
    key: "BACKUP_MONITOR_S3_ACCESS_KEY_ID",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup-monitor S3 access key ID",
    hint: "ListBucket-only key for the worker freshness check; never reuse the dump read/write key.",
    example: "",
  },
  {
    key: "BACKUP_MONITOR_S3_SECRET_ACCESS_KEY",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup-monitor S3 secret access key",
    example: "",
  },
  {
    key: "BACKUP_S3_REGION",
    group: "backups",
    source: "prompt",
    default: "auto",
    prompt: "Backup S3 region",
    hint: '"auto" for Cloudflare R2; a real region for AWS S3',
    example: "auto",
  },
  {
    key: "BACKUP_S3_ENDPOINT",
    group: "backups",
    source: "prompt",
    prompt: "Backup S3 endpoint URL (blank for AWS S3; required for R2/MinIO/B2/Spaces)",
    example: "",
  },
  {
    key: "BACKUP_S3_PREFIX",
    hidden: true,
    group: "backups",
    source: "default",
    default: "database",
    example: "database",
  },
  {
    key: "BACKUP_S3_FORCE_PATH_STYLE",
    hidden: true,
    group: "backups",
    source: "default",
    default: "false",
    example: "false",
  },
  {
    key: "BACKUP_S3_SSE",
    hidden: true,
    group: "backups",
    source: "default",
    inSchema: false,
    example: "",
    comment: [
      "Leave empty for R2 and most S3-compatible providers. Set to AES256 only",
      "for AWS S3 when you want SSE-S3 on backup objects.",
    ],
  },
  {
    key: "BACKUP_MAX_AGE_HOURS",
    hidden: true,
    group: "backups",
    source: "default",
    default: "36",
    example: "36",
    comment: [
      "Backup freshness check (worker, every 6h): alert admins and flag the",
      "admin dashboard when the newest dump in BACKUP_S3_BUCKET is older than",
      "this many hours. 36 tolerates one missed nightly run; two always alert.",
    ],
  },
  {
    key: "BACKUP_KEEP_LOCAL",
    hidden: true,
    group: "backups",
    source: "default",
    inSchema: false,
    default: "7",
    example: "7",
    comment: [
      "How many dumps scripts/backup.sh keeps on the container's local disk",
      "after uploading (older ones are deleted). Off-site copies are never",
      "pruned here — use the bucket's lifecycle rule for those. Container-only:",
      "the backup container's disk is ephemeral.",
    ],
  },
  {
    key: "BACKUP_HEARTBEAT_URL",
    hidden: true,
    group: "backups",
    source: "default",
    inSchema: false,
    example: "",
    comment: [
      "Optional dead-man's-switch ping. After a dump uploads successfully,",
      "scripts/backup.sh sends one HTTP GET to this URL (healthchecks.io,",
      "Cronitor, Uptime Kuma push, or any self-hosted endpoint). Leave empty to",
      "skip. The service you point it at alerts when the ping stops arriving.",
    ],
  },

  // --- translation ---------------------------------------------------------
  {
    key: "PUBLIC_APP_URL",
    hidden: true,
    format: "origin",
    group: "translation",
    source: "manual",
    example: "https://app.example.com",
    comment: [
      "Optional origin metadata sent to translation providers such as",
      "OpenRouter. Not used for auth — it is declared in the shared schema, so",
      "a worker-only deploy can set it.",
    ],
  },
  {
    key: "TRANSLATION_PROVIDER",
    group: "translation",
    source: "prompt",
    default: "openrouter",
    prompt: "Translation provider",
    choices: [
      {
        value: "openrouter",
        label: "OpenRouter (default)",
        description: "Cheapest path to claude-haiku-4-5, plus multi-model access from one account",
      },
      {
        value: "anthropic",
        label: "Anthropic direct",
        description: "Calls the Anthropic API directly with ANTHROPIC_API_KEY",
      },
    ],
    example: "openrouter",
  },
  {
    key: "OPENROUTER_API_KEY",
    group: "translation",
    source: "prompt",
    secret: true,
    prompt: "OpenRouter API key (blank if using anthropic)",
    hint: "Required when TRANSLATION_PROVIDER=openrouter",
    example: "",
  },
  {
    key: "ANTHROPIC_API_KEY",
    group: "translation",
    source: "prompt",
    secret: true,
    prompt: "Anthropic API key (blank if using openrouter)",
    hint: "Required when TRANSLATION_PROVIDER=anthropic",
    example: "",
  },
  {
    key: "TRANSLATION_MODEL",
    hidden: true,
    group: "translation",
    source: "manual",
    example: "anthropic/claude-haiku-4-5",
    comment: [
      "Per-call model override. Defaults to `anthropic/claude-haiku-4-5`",
      "(OpenRouter) or `claude-haiku-4-5` (Anthropic direct) when unset.",
    ],
  },

  // --- chat (tuning) -------------------------------------------------------
  {
    key: "CHAT_ENABLED",
    group: "chat",
    source: "default",
    default: "false",
    hint: 'Master switch for the chat feature — set to "true" to turn it on. Chat needs this AND OPENROUTER_API_KEY; with either missing the procedures return 503 and the nav entry disappears. Off by default because OPENROUTER_API_KEY is shared with `pnpm i18n:translate`, so a key configured for translations must not silently buy a paid tool-calling loop for every signed-in user.',
  },
  {
    key: "CHAT_MODEL",
    group: "chat",
    source: "default",
    default: "anthropic/claude-sonnet-4-5",
    hint: "OpenRouter model id for the chat agent loop. Sonnet by default — a tool-calling loop degrades sharply on a small model.",
  },
  {
    key: "CHAT_MAX_ITERATIONS",
    advanced: true,
    group: "chat",
    source: "default",
    default: "100",
    hint: "Max model dispatches per user turn. Each tool call costs one. Default 100 so explore/tool-heavy turns can finish; CHAT_RUN_TIMEOUT_MS is the hard wall-clock bound. Exhaustion stops as `max-iterations` (explore force-final synthesizes; chat marks ERROR/retryable).",
  },
  {
    key: "CHAT_RUN_TIMEOUT_MS",
    advanced: true,
    group: "chat",
    source: "default",
    default: "300000",
    hint: "Wall-clock ceiling per user turn (ms), passed to the agent loop as `timeoutMs`. The only backstop against a hung provider request or tool call — iterations count completed dispatches only. Expiry stops the run as `timeout` and the session flips to ERROR (retryable).",
  },
  {
    key: "CHAT_STALE_RUN_GRACE_MS",
    advanced: true,
    group: "chat",
    source: "default",
    default: "300000",
    hint: "Grace period (ms) ON TOP OF CHAT_RUN_TIMEOUT_MS before the reap-stale-chat-runs cron hands a session stuck at RUNNING back as ERROR (retryable). Covers queue wait and the run's final writes; the threshold is the sum, never this value alone.",
  },
  {
    key: "CHAT_EXPLORE_ROOT",
    advanced: true,
    group: "chat",
    source: "default",
    default: "",
    example: "/data/repos/example-package",
    hint: "Optional directory the chat agent may investigate with confined glob/grep/read tools (flycockpit docs-answerer style). Leave blank to keep chat's default tools only. Temporary until per-package clonedPath scoping lands.",
  },
  {
    key: "CHAT_RUN_CONCURRENCY",
    advanced: true,
    group: "chat",
    source: "default",
    default: "4",
    hint: "Worker concurrency for the chat-run queue. Bound by the model provider's rate limit, not local CPU.",
  },
  {
    key: "RESULT_STORE_TTL_SECONDS",
    advanced: true,
    group: "chat",
    source: "default",
    default: "21600",
    hint: "Redis TTL for oversized tool-result bodies the agent pages back with retrieve_tool_result. Default 6h.",
  },

  // --- ratelimit (tuning) --------------------------------------------------
  // Five named budgets, two knobs per family.
  // Family-scaling semantics: a budget describes its family's
  // REFERENCE member; every other member keeps its ratio to that reference,
  // so POINTS multiplies every member's points by (provided/reference) and
  // WINDOW_SECONDS multiplies every member's window AND block duration by the
  // same factor. Burst/sustained ratios, bucket keying, and fail-open vs
  // fail-closed stay fixed in code (packages/api/src/lib/rate-limit-families.ts
  // + apps/server/src/rate-limit.ts). Tighter is not safer — if one surface
  // 429s legitimate users, split the surface instead of shrinking a budget.
  // Full tables: patterns/rate-limiting.md.
  {
    key: "RATE_LIMIT_AUTH_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "30",
    hint: "Auth family reference: requests per IP per window on the general /api/auth/* surface (password reset, verification, session ops). Setting it rescales the whole fail-closed auth family at each member's designed ratio: credential 10, credential-burst 3/10s, signup 10/h, 2FA-OTP 3/15min.",
  },
  {
    key: "RATE_LIMIT_AUTH_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "60",
    hint: "Window (seconds) for the auth family reference. Scales every auth-family window AND block duration by the same factor.",
  },
  {
    key: "RATE_LIMIT_RPC_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "100",
    hint: "RPC family reference: requests per user (per IP signed out) per window on /rpc/*. /ready (60) and the SSR catch-all (300) scale with it. One batched request can carry up to ORPC_BATCH_MAX_SIZE procedures.",
  },
  {
    key: "RATE_LIMIT_RPC_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "60",
    hint: "Window (seconds) for the RPC family reference; scales /ready and SSR with it.",
  },
  {
    key: "RATE_LIMIT_UPLOAD_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "200",
    hint: "Upload family reference: /api/assets/* GETs per key per window. Images (300) scale with it — a page legitimately costs many media requests.",
  },
  {
    key: "RATE_LIMIT_UPLOAD_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "60",
    hint: "Window (seconds) for the upload family reference; scales the image bucket with it.",
  },
  {
    key: "RATE_LIMIT_EMAIL_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "3",
    hint: "Email family reference: mails per RECIPIENT per window on the anonymous send-mail endpoints (verification resend, password reset). Signup (6) and sign-in-triggered mails (10) scale with it. Keyed on the mailbox, so rotating IPs cannot flood one inbox. 0 disables the whole recipient family.",
  },
  {
    key: "RATE_LIMIT_EMAIL_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "3600",
    hint: "Window (seconds) for the email family reference; scales all three recipient buckets with it.",
  },
  {
    key: "RATE_LIMIT_CHAT_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "20",
    hint: "Chat family reference: accepted chat turns (chat.send + chat.retry) per USER per window. One point buys one queued run worth up to CHAT_MAX_ITERATIONS paid model dispatches — a spend limiter that fails closed. Session creation (30) and the SSE stream (60) scale with it.",
  },
  {
    key: "RATE_LIMIT_CHAT_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "60",
    hint: "Window (seconds) for the chat family reference; scales the session-creation and stream buckets with it.",
  },

  // --- images (tuning) -----------------------------------------------------
  {
    key: "IMAGE_PROXY_ALLOWED_HOSTS",
    advanced: true,
    group: "images",
    source: "default",
    default: "",
    example: "cdn.example.com,images.partner.com",
  },
  {
    hidden: true,
    key: "IMAGE_PROXY_TIMEOUT_MS",
    group: "images",
    source: "default",
    default: "5000",
  },
  {
    key: "IMAGE_PROXY_MAX_BYTES",
    hidden: true,
    group: "images",
    source: "default",
    default: "10485760",
  },
  {
    key: "IMAGE_TRANSFORM_MAX_INPUT_PIXELS",
    advanced: true,
    group: "images",
    source: "default",
    default: "50000000",
  },
  {
    key: "IMAGE_TRANSFORM_CACHE",
    hidden: true,
    group: "images",
    source: "default",
    default: "true",
    comment: [
      "S3 write-back cache for sharp transforms. false disables cache read AND",
      "write, restoring transform-on-every-request.",
    ],
  },
  {
    key: "IMAGE_TRANSFORM_CACHE_MAX_VARIANTS",
    hidden: true,
    group: "images",
    source: "default",
    default: "32",
    comment: [
      "Transform params are caller-controlled, so this caps storage growth per",
      "asset. Past the cap transforms still run, they just stop being cached.",
    ],
  },

  // --- limits (tuning) -----------------------------------------------------
  {
    key: "ASSET_UPLOAD_MAX_BYTES",
    advanced: true,
    group: "limits",
    source: "default",
    default: "10485760",
    comment: ["The server's own request body limit applies independently."],
  },
  {
    key: "SSR_CACHE_TTL_SECONDS",
    advanced: true,
    group: "limits",
    source: "default",
    default: "60",
    comment: [
      "In-memory SSR HTML cache for anonymous GETs of public routes. 0 disables",
      "it. Public content edits can take up to this long to appear live.",
      "See patterns/ssr-for-articles.md.",
    ],
  },

  // --- apps/web/.env -------------------------------------------------------
  {
    key: "VITE_APP_NAME",
    group: "web",
    file: "web",
    source: "default",
    default: "App",
    // Not a Zod default: web.ts declares this `.optional()` and applies "App"
    // through a getter on the exported env object.
    defaultFrom: "app",
    example: "My Business App",
    comment: ["Used in the app shell title/header."],
  },
  {
    key: "VITE_SERVER_URL",
    group: "web",
    file: "web",
    source: "manual",
    example: "http://localhost:3000",
    comment: [
      "API origin. Defaults to window.location.origin at runtime — leave unset",
      "for the portless/Vite proxy flow. No path, query string, or hash.",
    ],
  },
  {
    key: "VITE_DEV_PORT",
    group: "web",
    file: "web",
    source: "manual",
    example: "3001",
    comment: [
      "Raw dev-server knobs. Leave unset with portless, which assigns ports and",
      "proxies /api, /rpc, /sw, /ws. Without portless, Vite listens on",
      "3001 and proxies to 3000.",
    ],
  },
  {
    key: "VITE_DEV_SERVER_URL",
    group: "web",
    file: "web",
    source: "manual",
    example: "http://localhost:3000",
  },

  // --- apps/native/.env ----------------------------------------------------
  {
    key: "EXPO_PUBLIC_SERVER_URL",
    group: "native",
    file: "native",
    // `prompt`/`hint` here feed `.env.example` rendering only:
    // `generate:secrets` builds a server-side production block and walks the
    // root file's groups, so it never asks for web or native build-time vars.
    source: "prompt",
    required: true,
    prompt: "API origin the Expo app should call",
    hint: "Simulator: http://localhost:3000 · Android emulator: http://10.0.2.2:3000 · Physical device: your LAN IP or a tunnel",
    example: "http://localhost:3000",
    exampleSet: true,
    comment: [
      "Required. No path, query string, or hash.",
      "",
      "iOS simulator with raw local dev:  http://localhost:3000",
      "Android emulator with raw local dev:  http://10.0.2.2:3000",
      "Physical devices need an origin reachable from the device — usually your",
      "machine's LAN IP or a tunnel.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function groupsForFile(file: EnvFile): EnvGroup[] {
  return ENV_GROUPS.filter((g) => (g.file ?? "root") === file);
}

export function varsInGroup(groupId: string): EnvVar[] {
  return ENV_VARS.filter((v) => v.group === groupId);
}
