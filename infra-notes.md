# Infra Notes

> Handoff doc for the agent (or human) configuring this template's deployment infrastructure. Reading this should be sufficient to stand the app up on **Dokploy on a VPS** (the deployment target documented in this repo) or any other Docker-based platform without touching application code. Platform-specific walkthrough: [Dokploy/VPS](./patterns/deployment-vps.md).

## Contents

1. [What ships](#what-ships) — images, what they do, what they need
2. [Required environment variables](#required-environment-variables) — the full contract
3. [The `APPLY_SCHEMA` contract](#the-apply_schema-contract) — the schema-sync lifecycle
4. [Picking the schema leader](#picking-the-schema-leader) — which container runs the push
5. [Health endpoints](#health-endpoints)
6. [Advisory lock](#advisory-lock) — how multi-replica schema pushes stay safe
7. [Deploy workflow](#deploy-workflow) — the four-step dance for every deploy
8. [Platform notes: Dokploy](#platform-notes-dokploy-vps) — pointer to [deployment-vps.md](./patterns/deployment-vps.md) (default)
9. [Running on another Docker platform](#running-on-another-docker-platform) — the portability contract in one place
10. [CI recommendations](#ci-recommendations)
11. [Hard rules for the infra agent](#hard-rules-for-the-infra-agent)
12. [Quick reference — env var matrix](#quick-reference--env-var-matrix)
13. [Advanced topologies](#advanced-topologies) — supported alternatives to the blessed per-platform topology

---

## What ships

Three images, built from three Dockerfiles at the repo root:

| Image | Dockerfile | Purpose | CMD | Exposes |
|---|---|---|---|---|
| **server** | `Dockerfile` | Hono API + server-side renderer + static web SPA; embedded background runtime unless `WORKER_MODE=external`. | `node apps/server/dist/index.mjs` | `3000/tcp` |
| **worker** | `Dockerfile.worker` | BullMQ job consumer; container-local healthcheck. | `node apps/worker/dist/index.mjs` | none |
| **db-applier** | `Dockerfile.db-applier` | Deploy-gated one-shot `apply` jobs on Dokploy (or any orchestrator that can run a one-shot before the runtimes), backup / restore jobs, plus the scheduled dump path (platform cron one-shot or in-container `schedule` mode). No app server. | none by default — the container command (or `DB_APPLIER_MODE`) selects the mode | none |

The server and worker images share `scripts/docker-entrypoint.sh` as their `ENTRYPOINT`. It validates env vars, refuses every restore-only variable, runs schema sync via `scripts/db-applier.sh apply` when `APPLY_SCHEMA != off`, or read-only admission when `WAIT_FOR_SCHEMA=true`, then `exec`s the CMD. Dokploy prefers a Git-backed db-applier Application (`Dockerfile.db-applier`, command `apply`); without it, the app entrypoint leads. See [§ Picking the schema leader](#picking-the-schema-leader).

The db-applier image has its own entrypoint (`scripts/db-applier-entrypoint.sh`) and deliberately **no default command** — the mode is the container command if one is given, else `DB_APPLIER_MODE`, else `backup`. It is the only supported restore entrypoint. Backups, restore drills, and the recovery procedure live in [patterns/backup-and-restore.md](./patterns/backup-and-restore.md); an infra agent that stands up only server + worker has standing up the backup path still to do.

Production roles use the same reviewed immutable Git release tag (or shared commit SHA when using registry builds). Native Git development Applications may finish builds from adjacent branch commits in any order; followers use `WAIT_FOR_SCHEMA=true` to check the image's schema fingerprint, successful receipt, absence of pending/unknown intent, and empty live diff before startup. This proves schema compatibility at that moment, not matching source revisions or queue payload compatibility. Expand-contract and backward-compatible job payloads remain required.

### Shared tooling

The server and worker images install the same schema-sync tooling by default:

- `postgresql-client-<PG_MAJOR>` — psql owns the restore and follower-admission locks; pg_dump/pg_restore prepare backups and restores. Ordinary schema apply uses one Node PostgreSQL connection for both its lock and SQL (see [§ Advisory lock](#advisory-lock)). Installed from the upstream PostgreSQL apt repo (PGDG) and pinned by `ARG PG_MAJOR` in each Dockerfile (`pnpm docker:check-copy` enforces that the three Dockerfiles agree). Bump it when you upgrade the database major — see [patterns/backup-and-restore.md](./patterns/backup-and-restore.md#knowing-backups-ran).
- The Prisma CLI + query engine binary — the db-applier uses it to compute the `prisma migrate diff` plan.
- The Prisma schema files (`packages/db/prisma/schema/`).

`APPLY_SCHEMA` selects the schema leader. Followers also need Prisma and psql for `WAIT_FOR_SCHEMA`, so keep both tools in runtime images — a separate applier image does not make a stripped follower viable ([schema-push § Keeping the Dockerfiles in sync](./patterns/schema-push.md#keeping-the-dockerfiles-in-sync)).

### Response compression is the platform's job

The Node server does **not** compress responses — HTTP compression belongs at the TLS-terminating proxy, where it's free (and often better: Brotli) compared to burning app CPU. **Dokploy/Traefik does not** compress by default — Traefik's compress middleware is off by default and must be attached to the router, or every HTML/JSON/JS response ships uncompressed. See [patterns/deployment-vps.md](./patterns/deployment-vps.md) for the one-line middleware config. On any other platform, verify compression at the edge with `curl -H 'Accept-Encoding: br, gzip' -sI https://<app>/ | grep -i content-encoding` before go-live. Do not add compression middleware to the app to work around a proxy gap — fix the proxy.

---

## Required environment variables

The variables below are read at container start. The `Both images?` column reflects the env-module split: the worker validates only `@starter/env/shared`, so server-only rows are marked `Server only`. The entrypoint shell additionally hard-checks `DATABASE_URL` and `REDIS_URL` in both images before Node starts, and `BETTER_AUTH_SECRET` only when the server command is starting (see the validation-layers note after the table), exiting `1` with a `FATAL:` message if any are missing.

| Variable | Required | Both images? | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ | ✅ | Postgres connection string. Must be reachable from the container network. |
| `REDIS_URL` | ✅ | ✅ | Redis connection string. Shared between rate limiter (server) and job queue (both). BullMQ requires `noeviction` when Redis has a maxmemory policy. |
| `BETTER_AUTH_SECRET` | ✅ | Server only | 32+ byte random hex. Prefer `pnpm generate:secrets` for a full production block (generates this + validates). One-off: `pnpm generate:secret` or `openssl rand -hex 32`. |
| `APPLY_SCHEMA` | Optional | Both | `off` (default) \| `safe` \| `dangerous`. Exactly one selected schema leader; Dokploy keeps it `safe` for ordinary Git deploys. See [§ the APPLY_SCHEMA contract](#the-apply_schema-contract). |
| `WAIT_FOR_SCHEMA` | Dokploy followers | Both | `true` waits for receipt + live schema match before startup; reject when combined with a non-`off` leader. |
| `SCHEMA_WAIT_TIMEOUT_SECONDS` | Optional | Both | Default 300, range 1–3600. Raise healthcheck startup grace too when increasing this value. |
| `WORKER_MODE` | Optional | Server only | `embedded` (default) hosts background work in the app; `external` requires a dedicated healthy worker. |
| `NODE_ENV` | ✅ | ✅ | Set to `production`. Turns on security-sensitive defaults (admin email warnings, CORS strictness, etc.). |
| `NODE_OPTIONS` | Optional | Both | Both images ship a default V8 heap cap (`--max-old-space-size=512` server, `256` worker) so they behave predictably on small hosts. Override per deploy if you have headroom. Set the container's memory **limit** ~25–50% above the heap cap — native memory (sharp's pixel buffers, any child process) lives outside the V8 heap. |
| `BETTER_AUTH_URL` | ✅ (server only) | Server only | Public HTTPS URL of the app, e.g. `https://app.example.com`. The worker does **not** validate or require this — its import graph uses `@starter/env/shared`, which omits it. (OpenRouter auto-translate reads `PUBLIC_APP_URL ?? BETTER_AUTH_URL` off raw `process.env` purely as optional leaderboard-attribution metadata; an unset value just omits the `HTTP-Referer` header.) |
| `ADMIN_EMAILS` | Recommended | Server only | Comma-separated list of email addresses that get admin on the explicit email/password bootstrap sign-up path. Without this, no one can reach admin-gated routes. |
| `CORS_ORIGIN` | Conditional | Server only | Set only if the web app runs on a different origin than the API. Omit for same-origin deployments. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | ✅ (prod) | ✅ | Required for email verification on the server and optional worker failure alerts. Any transactional SMTP provider works. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional | Both | Required only if Web Push is enabled. Prefer `pnpm generate:secrets` (enable push when prompted); keypair-only: `pnpm generate:vapid`. |
| `RATE_LIMIT_*` | Optional | Server only | Five named budgets (`AUTH`, `RPC`, `UPLOAD`, `EMAIL`, `CHAT`; a `POINTS` + `WINDOW_SECONDS` pair each) for the Redis-backed rate limiter. A budget scales its whole limiter family at the designed member ratios; defaults are sensible and reproduce the shipped numbers. See [patterns/rate-limiting.md](./patterns/rate-limiting.md). |
| `SSO_*` | Optional | Server only | Only if SSO providers are configured. |
| `SIGNUP_ENABLED` | Optional | Server only | Defaults to a secure value. When `false`, blocks email/password signup and SSO just-in-time user creation; existing SSO users can still sign in. Do not flip without reviewing the admin gate logic. |
| `S3_BUCKET` | Optional | Server only | Enables `/api/assets/*` + `/api/images/*`. With this unset, those routes return 503 and the app boots fine. See [patterns/assets.md](./patterns/assets.md). |
| `S3_REGION` | Optional | Server only | Default `auto` (works for Cloudflare R2). AWS users typically set `us-east-1`. |
| `S3_ENDPOINT` | Optional | Server only | Set for non-AWS S3-compatible providers (R2, B2, MinIO, DO Spaces). Omit for AWS. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Required if `S3_BUCKET` set | Server only | Treat as secrets; inject via the orchestrator's secret store. |
| `S3_FORCE_PATH_STYLE` | Optional | Server only | `true` for MinIO and similar self-hosted providers. Default `false`. |
| `IMAGE_PROXY_ALLOWED_HOSTS` | Optional | Server only | Comma-separated allowlist of hostnames the image transform endpoint may proxy. Empty (default) = stored assets only. |
| `ASSET_UPLOAD_MAX_BYTES` | Optional | Server only | Per-file upload cap in bytes. Default 10 MB. The Hono body limit (also 10 MB) applies independently. |

The env package is split into two Zod-validated modules, and **the two images validate different surfaces** (the declarations each one validates live beside them in `packages/env/src/vars/` — see [patterns/environment-variables.md](./patterns/environment-variables.md)):

- **`packages/env/src/shared.ts`** (`@starter/env/shared`) — the worker-safe surface. Validates only what the worker import graph (`apps/worker/**`, `@starter/db`, `@starter/queue`, `@starter/api/lib/storage`, `@starter/i18n-translate`, `@starter/mailer`) actually reads: `DATABASE_URL`, `REDIS_URL`, `NODE_ENV`, the `S3_*` block, the translation knobs (`OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `TRANSLATION_PROVIDER` / `TRANSLATION_MODEL`), and optional `SMTP_*` for operational-alert email. This is the **only** env module the worker loads.
- **`packages/env/src/server.ts`** (`@starter/env/server`) — `createEnv({ extends: [sharedEnv], … })`. It re-validates everything in the shared surface **plus** the server-only variables: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CORS_ORIGIN`, all `SSO_*`, `FORCE_SSO`, `SIGNUP_ENABLED`, all `VAPID_*`, every `RATE_LIMIT_*`, `ADMIN_EMAILS`, the `IMAGE_*` knobs, and `ASSET_UPLOAD_MAX_BYTES`. Only the server (and any module in its import graph) loads this.

Practical consequence: a **worker-only deployment is not required to set the server-only variables** (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CORS_ORIGIN`, the `RATE_LIMIT_*` knobs, `SSO_*`, `VAPID_*`, `ADMIN_EMAILS`, `IMAGE_*`). It needs only the shared set: `DATABASE_URL`, `REDIS_URL`, `NODE_ENV`, the `S3_*` block if asset storage is used, the translation keys if auto-translate is enabled, and `SMTP_*` only if you want worker failure-alert emails. Both surfaces are still enforced by Zod at startup - a missing or malformed required value crashes the container immediately. Do not work around this by making fields optional.

The entrypoint and the runtime validate different layers:

- `scripts/docker-entrypoint.sh` hard-fails before Node starts on `DATABASE_URL` and `REDIS_URL` for both images. It also requires `BETTER_AUTH_SECRET` when the server command is starting, but not for the worker command path; `@starter/env/shared` intentionally does not validate Better Auth server-only values.
- Once the process starts, the worker validates **only** `@starter/env/shared` and the server validates `@starter/env/server` (which extends the shared surface). The merged `env` the server sees is identical to before the split — server-side code is unchanged.

### Tables created by schema apply

The Prisma schema is split across files under `packages/db/prisma/schema/`. As of the current plan, these tables ship by default:

- **Auth** (`auth.prisma`): `user`, `session`, `account`, `verification`, `two_factor`, `push_subscription`.
- **Assets** (`assets.prisma`): `asset` and `folder` (S3-backed file metadata; opt-in via `S3_BUCKET`).
- **Chat** (`chat.prisma`): `chat_session`, `chat_message` (durable agentic chat — see [patterns/add-ins/chat.md]).

No special handling for any of these — they are created (and dropped, when removed) by the same db-applier apply flow in [§ The `APPLY_SCHEMA` contract](#the-apply_schema-contract). When a deploy adds a new model or column, set `APPLY_SCHEMA=safe` on the leader; when it drops a model (e.g. ripping out a feature via one of the `patterns/removable/` recipes), follow the destructive-change shape and set `APPLY_SCHEMA=dangerous` for that one deploy.

### Secret handling

- **No `.env` file is baked into the image.** Production values must be injected by the orchestrator (Dokploy environment variables, Kubernetes Secrets, etc.).
- `BETTER_AUTH_SECRET` should be **unique per environment**. Reusing it across staging + production lets tokens issued in one environment validate in the other.
- Do not log env var values. The entrypoint only logs names of missing vars, never contents.

---

## The `APPLY_SCHEMA` contract

`APPLY_SCHEMA` is the central lever the infra agent owns. It gates whether the Prisma schema is synced to the database on a given deploy, and how aggressively (`off` / `safe` / `dangerous`).

### Contract vs mechanism

`APPLY_SCHEMA` is the **contract**. Its values and safety guards are shared; the mechanism and flag lifecycle are platform-specific:

| Platform | Mechanism | Notes |
|---|---|---|
| Dokploy / VPS (default) | **Git-backed db-applier Application** | Replicated mode, one replica, restart none. Production manually selects one immutable Git tag and waits for successful apply before deploying runtimes. Development may auto-deploy branch updates; followers wait for receipt + live-schema compatibility before startup. [deployment-vps.md](./patterns/deployment-vps.md). |

Both mechanisms run the same `scripts/db-applier.sh` under the same advisory lock — there is exactly one canonical mutating path; what differs is which container hosts it and how the platform gates application rollout. Where the rest of this section says "the leader runs the push," that means a deploy-gated one-shot job or an app-entrypoint leader; both honor the same `off`/`safe`/`dangerous` values.

| Value | Behavior | When to use |
|---|---|---|
| `off` (default when unset) | Skip schema mutation; `WAIT_FOR_SCHEMA=true` still gates runtime startup. | Followers; also the idle leader on platforms that explicitly toggle apply per schema-changing release. Not the Dokploy Git leader's ordinary setting. |
| `safe` | Apply the guarded `prisma migrate diff` SQL. The applier refuses destructive DDL in that plan (DROP COLUMN / DROP TABLE / ALTER COLUMN … TYPE) and exits non-zero. | Dokploy's single leader on every ordinary Git deploy, including no-op receipt refreshes; other platforms' non-destructive schema deploys. |
| `dangerous` | Apply that SQL (including destructive DDL) after `APPLY_SCHEMA_CONFIRM` binds target and schema fingerprint. | Only after reviewing the diff locally and intentionally dropping or narrowing something. Typically the third phase of an expand-contract rename (see [patterns/schema-changes-recipe.md](./patterns/schema-changes-recipe.md)). |

Any other value crashes the container on boot with `FATAL: APPLY_SCHEMA=<value> is invalid`.

### Lifecycle

The lifecycle below describes explicitly triggered one-shot/entrypoint deployments. **Dokploy native Git uses the variant in [Platform notes: Dokploy](#platform-notes-dokploy-vps): keep `safe` on the single designated leader, `off` + `WAIT_FOR_SCHEMA=true` on followers.** This supports automatic development deployments and no-op receipt refreshes without toggling flags after every push.

The intended flow for a deploy that changes the schema:

1. **Steady state**: `APPLY_SCHEMA=off` (or unset) on every container.
2. **PR lands** that edits `packages/db/prisma/schema/`.
3. **Build or select the target artifacts** and keep app rollout gated. The schema leader and app artifacts must identify the same full commit SHA. For Dokploy's native Git workflow, use [Platform notes: Dokploy](#platform-notes-dokploy-vps) instead of this toggle lifecycle.
4. **Run the designated leader** with `APPLY_SCHEMA=safe` (or reviewed and confirmed `dangerous`). A one-shot job must exit 0 before app rollout begins; an entrypoint leader applies before its own CMD starts.
5. **Verify** — the job exited 0 with `Schema sync complete.` before deploying the app artifacts, or the entrypoint leader is healthy (`/health` on the server, or worker logs showing `Schema sync complete.` followed by `Worker started`).
6. **Flip** `APPLY_SCHEMA` back to `off` on the leader. The next run/restart will skip schema sync.

Step 6 is defense in depth: if `APPLY_SCHEMA` stays at `safe` and a later deploy introduces an accidental destructive change, Prisma exits non-zero and the deploy fails noisily — desired behavior, but easier to reason about when schema-changing deploys are explicitly opted in.

### Failure modes

- **`APPLY_SCHEMA=safe` with a destructive diff** → the applier refuses the guarded SQL and exits non-zero. In a correctly gated job flow, app rollout never begins and the previous revisions keep serving the previous schema. With an entrypoint leader, the new leader container fails to boot and the platform keeps traffic on the previous healthy revision. Either way the database is unchanged. Fix: review the diff locally, follow the expand-contract pattern, or flip to `dangerous` after confirming the data loss is intentional.
- **`APPLY_SCHEMA=dangerous` with an unexpected diff** → the hashed SQL is applied. Data loss is permanent. Recover from backup. This is why `dangerous` should never be flipped casually, and why the confirm SHA must still match after the pre-apply backup.
- **Two images with `APPLY_SCHEMA != off`** → Both try to push. The advisory lock serializes their operations, but different schema targets are not necessarily no-ops or compatible. Pick one leader; serialization does not select the right release for you.

---

## Picking the schema leader

Exactly one role should push the schema on a given deploy. Prefer the db-applier. **One topology per platform is the blessed, documented path** — everything else is an advanced variant ([§ Advanced topologies](#advanced-topologies)):

| Platform | Blessed topology | Schema leader |
|---|---|---|
| **Dokploy / VPS (default)** | **App + applier**: `server` with embedded jobs (`WORKER_MODE=embedded`) + one-shot db-applier + Postgres 17 + Redis 7 (`noeviction`). `pnpm dokploy:config` emits it as a Dokploy-consumable Compose file (`docker-compose.dokploy.yml`) plus the manual-UI settings checklist. | db-applier (`schema-apply`), `APPLY_SCHEMA=safe` on every ordinary Git deploy including no-ops; the server stays a follower (`off` + `WAIT_FOR_SCHEMA=true`). |

On Dokploy, production orders its successful task before runtimes; automatic development relies on the follower admission gate, not a cross-Application platform dependency:

> **One-shot db-applier, mode `apply`.** Run it for every ordinary Dokploy Git deployment with `safe`, including an unchanged schema. Server and worker stay `APPLY_SCHEMA=off` with `WAIT_FOR_SCHEMA=true`. Other platforms' ordered-job flows run the selected artifact before rolling out their matching app images.

Why this is the recommendation:

- **Separates schema-sync failure from app startup.** An ordered production rollout does not deploy runtimes after a failed apply. Automatic development may already be starting a follower, which refuses startup without admission. Existing app compatibility and availability still depend on expand-contract and the platform's rollout behavior.
- **Centralizes schema ownership.** One selected role handles schema work. The advisory lock remains required for overlapping deploys, restarts, and restore operations.
- **The applier's guards are identical.** The db-applier image's entrypoint runs the same `scripts/db-applier.sh` under the same advisory lock: the pre-apply backup gate, the `starter_control` schema-release receipt, and the dangerous-apply confirm protocol all behave exactly as they do on an app-entrypoint leader.
- **One canonical mutating container.** The db-applier is also the backup container, so there is one image that talks to the database with write intent, one log stream to read, and one thing to audit.

| Platform | Leader | Notes |
|---|---|---|
| Dokploy / VPS (default) | **Git-backed db-applier Application** | Replicated mode, one replica, restart none. Production manually selects one immutable Git tag and waits for successful apply before deploying runtimes. Development may auto-deploy branch updates; followers wait for receipt + live-schema compatibility before startup. [deployment-vps.md](./patterns/deployment-vps.md). |

### The entrypoint mechanism

On Dokploy without an applier, the **app** entrypoint is the leader: keep `APPLY_SCHEMA=safe` and `WAIT_FOR_SCHEMA=false`; a dedicated worker stays `off` with `WAIT_FOR_SCHEMA=true`. Do not infer worker leadership merely because the image can apply schema. An entrypoint leader is reasonable when:

- The operator wants **fewer containers** overall and accepts coupling schema sync to one app boot.
- The deployment has **deliberately chosen provider-only backups** (no db-applier deployed at all — [backup-and-restore.md § Provider-only profile](./patterns/backup-and-restore.md#provider-only-profile-opt-in)).

The entrypoint keeps all the discipline: one leader per deploy, `dangerous` never steady-state, the same confirm protocol, no ad-hoc pushes outside the canonical scripts.

Use the chosen platform's supported topology and deployment ordering, not an arbitrary mix of the alternatives.

Do not:

- Set `APPLY_SCHEMA=safe|dangerous` on two containers (or a job plus a container) simultaneously. The advisory lock prevents schema corruption, but two pushers is a misconfiguration — decide on one leader.
- Run schema sync from an unattended schedule or an ad-hoc script that points at production `DATABASE_URL`. Schema sync is deploy-scoped, never time-scoped. A one-shot apply job must be launched by the ordered deploy workflow; bypassing the canonical scripts with an ad-hoc shell push skips the advisory lock, the schema receipt, and the audit trail of deploy logs.
- Leave `APPLY_SCHEMA=dangerous` set after the deploy completes. It is a per-deploy flag on both job and entrypoint leaders.

Why single-leader discipline matters: applying schema SQL does not take an advisory lock by itself (see below). Concurrent applies race and can leave the schema inconsistent. Binding schema sync to one container per deploy — and, via `APPLY_SCHEMA`, to one moment — keeps that clean.

---

## Health endpoints

| Endpoint | Status | Semantics | Intended consumer |
|---|---|---|---|
| `GET /health` | 200 while the Node process is alive | Liveness probe. It does not touch Postgres or Redis, so orchestrators do not restart healthy containers during transient dependency failovers. | Docker healthcheck, Dokploy rolling update liveness gate, any orchestrator's startup/liveness probe. |
| `GET /ready` | 200 when Postgres and Redis respond, 503 otherwise | Readiness probe. Uses short dependency timeouts before a deploy receives traffic. | Dokploy's health-check path, Kubernetes readiness probes, external dependency-aware monitors. |

The server image's `HEALTHCHECK` directive already uses Node's built-in `fetch()` against `http://localhost:$PORT/health`, where the port is computed as `SERVER_PORT` || `PORT` || `3000` (3000 unless overridden). Its `--start-period=480s` is deliberately larger than the schema startup gate — `SCHEMA_WAIT_TIMEOUT_SECONDS` (default 300s in `scripts/wait-for-schema.mjs`) plus schema-apply time — so followers legitimately waiting on the schema gate are not marked unhealthy mid-wait; `scripts/check-docker-copy.ts` fails CI if that coupling drifts. Platforms that honor Docker healthchecks (Dokploy, Docker Swarm) pick this up automatically. For platforms that require explicit probe definitions, use `/health` for liveness and `/ready` for readiness/traffic routing.

Suggested probe tuning:

| Probe | Initial delay | Period | Failure threshold |
|---|---|---|---|
| Startup (gate traffic until app boots) | 10s | 10s | 50 (~8m 20s — above the images' 480s `HEALTHCHECK --start-period`) |
| Liveness (restart if wedged) | 30s | 30s | 3 |
| Readiness (gate traffic on degradation) | 10s | 10s | 2 |

The startup budget is sized for the schema gate, not just process boot: a follower may wait up to `SCHEMA_WAIT_TIMEOUT_SECONDS` (default 300s) for the schema leader, and an `APPLY_SCHEMA=safe/dangerous` leader additionally spends backup + DDL time before serving. The images' `HEALTHCHECK --start-period=480s` exists for exactly that window (wait default + apply budget, coupling enforced by `scripts/check-docker-copy.ts`); keep platform startup probes at or above it. Tune down if your schema is small and the wait/apply completes in seconds.

**Stop grace must exceed the drain.** On `SIGTERM` the server holds `/ready` at 503 for 5s *before* closing the listener and then drains in-flight requests for up to 10s more, so give every platform at least 20s of shutdown grace — `stop_grace_period: 20s` on the Compose service (the default is **10s**, which `SIGKILL`s the process mid-drain and produces exactly the 502s the readiness delay exists to prevent), and the equivalent shutdown-grace setting on any other orchestrator (`terminationGracePeriodSeconds` on Kubernetes).

The dedicated worker exposes a container-local healthcheck, without public ingress. Its health proves startup of the shared background runtime. The server's `/ready` also checks its embedded runtime or an external worker heartbeat according to `WORKER_MODE`; dependency failures must fail deployment readiness rather than be mistaken for a successful rollout.

---

## Advisory lock

Schema SQL does not acquire an advisory lock by itself. `scripts/db-applier.sh apply` delegates to `scripts/apply-schema.mjs`: one Node PostgreSQL session (`application_name=starter-db-applier-session`) takes `pg_advisory_lock(1145389648)` before planning and backup, then executes the approved SQL itself. After `BEGIN`, it also takes the same transaction-level lock. SQL, the schema receipt, and the completion commit atomically on that connection.

Cancellation closes that SQL connection and drains preparation children before returning. Every live Prisma comparison uses the pinned CLI adapter that owns its native schema engine; continuation requires its final drain acknowledgement. The whole apply — preview, backup, plan re-verification, DDL, and receipt — runs in one transaction on that session, so an interrupted apply is either fully applied or fully rolled back; never assume which. After a crash, verify the outcome with read-only queries (`starter_control.schema_releases` plus the live schema) before retrying; once the outcome is known, a retry is always safe.

`restore` retains a dedicated psql lock owner (`application_name=starter-db-applier-lock`) and a supervised shell effect. It shares ordinary apply's lock key. Its native clients drain before cleanup; losing a restore client or its lock session does not prove the server effect stopped — inspect the destination with read-only queries before any retry. See [schema-push § The advisory lock](./patterns/schema-push.md#the-advisory-lock) for the owner, timeout, and outcome boundaries.

Lock ID `1145389648` is `0x44414450` (`DADP` in ASCII) — a template-specific magic number chosen to avoid colliding with application-level locks.

**Do not wrap `db-applier.sh` in your own `pg_advisory_lock` session.** A session-level advisory lock is not re-entrant across sessions: an outer psql wrapper holding the same ID blocks the applier's own acquire until the 300-second `lock_timeout` fails the deploy. The entrypoint calls `bash /app/scripts/db-applier.sh apply` directly — copy that, never an outer psql wrapper.

Implications for the infra agent:

- **Multi-replica rollouts are safe.** Replica A acquires the lock and applies; replicas B, C, D block on `pg_advisory_lock` until A completes; when they acquire the lock, the live diff is already in sync and they no-op.
- **The 300-second `lock_timeout`** is belt-and-suspenders. If something hangs longer than five minutes, the deploy fails noisily rather than blocking indefinitely.
- **If you observe replicas blocking**, inspect granted and waiting rows in `pg_locks` with `pg_stat_activity` to identify the owning application/session and current deployment. A closed backend releases its locks; waiting alone does not establish that the owner crashed. Identify the active apply, restore, or follower before cancelling its owning job/revision through the platform, then allow its SQL and preparation clients to drain. Cancellation is not an outcome proof: verify the applied state with read-only queries before retrying. Keep rollout gated until the outcome is established.

### Why this matters when replicas auto-scale

Any platform that runs an app at more than one replica hits this. If you lead schema sync from the server and it is the auto-scaled service, multiple replicas boot simultaneously on a new revision and the advisory lock keeps them correct — without it, you'd see `column already exists` errors on all but one replica.

If you lead from a one-shot applier job or a singleton worker entrypoint, the lock is belt-and-suspenders — only ever one pusher. A deploy-gated one-shot converts a multi-replica hazard into a trivially serial flow.

---

## Deploy workflow

The explicit deployment flows below cover platforms that toggle their leader per deployment. The native Dokploy Git path instead keeps `safe` on one leader and uses follower startup admission, as specified in [Platform notes: Dokploy](#platform-notes-dokploy-vps).

### Shape A — No schema change

The PR does not touch `packages/db/prisma/schema/`.

1. Leave `APPLY_SCHEMA=off` everywhere (its steady-state value).
2. Trigger the deploy.
3. New revisions boot, entrypoints skip schema sync, CMDs start. Done.

### Shape B — Additive schema change

The PR adds a model, adds an optional column, adds an index, or otherwise introduces no destructive operations.

1. Set `APPLY_SCHEMA=safe` on the designated leader (see [§ Picking the schema leader](#picking-the-schema-leader)) — the one-shot db-applier apply job or the entrypoint leader container.
2. Run the job or trigger the entrypoint-led deploy.
3. The leader runs the db-applier apply path and applies the guarded migrate-diff SQL. Safe because the applier refuses destructive DDL in that plan.
4. Verify — the job exited 0 with `Schema sync complete.` in its logs, or the entrypoint leader is healthy (server: `/health` → 200; worker: logs show `Schema sync complete.` followed by `Worker started`).
5. Set `APPLY_SCHEMA=off` on the leader.

If apply exits non-zero during step 3, keep rollout gated and inspect its diagnostic. A destructive diff needs review or an expand-contract change; a preparation failure or acknowledged SQL rollback needs its cause corrected. After a connection loss the outcome is unknown until verified: confirm it with read-only queries (see [§ Advisory lock](#advisory-lock)) before retrying.

### Shape C — Destructive schema change

The PR drops a column, narrows a type, adds `NOT NULL` to an existing column without a default, or otherwise includes a destructive operation.

1. **Before deploying, confirm this PR is the final phase of an expand-contract rollout.** The application code must already be deployed reading/writing the new column, and any data backfill must already have run. See [patterns/schema-changes-recipe.md § Recipe 3](./patterns/schema-changes-recipe.md).
2. When logical backups are enabled (`BACKUP_ENABLED=true` and `BACKUP_PRE_APPLY_ENABLED=true`), a successful pre-apply pg_dump upload is **required** before `dangerous` runs. On the provider-only profile, set `APPLY_SCHEMA_ACCEPT_PROVIDER_BACKUP=I_ACCEPT_PROVIDER_BACKUP_ONLY` for that deploy only. See [patterns/backup-and-restore.md](./patterns/backup-and-restore.md).
3. First run the leader without a valid dangerous confirmation to obtain a non-authoritative preview of target id and schema fingerprint (it exits non-zero by design — nothing was mutated). For the follow-up, set `APPLY_SCHEMA_CONFIRM=DANGEROUS:<target-id>:<fingerprint>`. The applier then takes its required backup, re-collects the authoritative live plan and refuses any drift, and applies it in one transaction; the target-bound protocol applies identically on the one-shot db-applier job and on server/worker entrypoint leaders.
4. Run the leader (job) or trigger the deploy (fallback).
5. The applier applies the confirm-bound hashed SQL. The destructive operation is applied.
6. Verify — job exit 0 / leader healthy.
7. **Immediately** set `APPLY_SCHEMA=off`. Do not leave `dangerous` on as steady state. Unset `APPLY_SCHEMA_ACCEPT_PROVIDER_BACKUP` if you set it.

If step 4 went wrong (applied more than intended), data loss is permanent. Recover from backup using the documented restore path in [patterns/backup-and-restore.md](./patterns/backup-and-restore.md).

---

## Platform notes: Dokploy (VPS)

Dokploy is the default target. Applications build directly from Git; a registry and Compose are optional. The detailed settings and generated configuration checklist live in [patterns/deployment-vps.md](./patterns/deployment-vps.md).

**The blessed path is the generated Compose file**: `pnpm dokploy:config` writes `docker-compose.dokploy.yml` (server with embedded jobs + one-shot `schema-apply` leader + `postgres:17` + `redis:7` with `noeviction`, Traefik routing/TLS/compression labels, swarm update/rollback/stop-grace policy, `${VAR:-}` env interpolation) which Dokploy deploys directly in Compose mode — import it, fill the per-service env vars the checklist lists, deploy. The manual native-Git Applications below remain the fully supported fallback and the only path for the advanced topologies.

Create separate development and production environments, each with its own Postgres, Redis, auth secret, app origin, and backup namespace. Store complete connection strings and credentials in the corresponding environment. Applications explicitly reference `${{environment.VAR}}`; there is no automatic inheritance or recursive reference expansion.

### Per-deploy workflow

The blessed configuration is **App + applier** (the Compose above; first row of the topology table in [§ Advanced topologies](#advanced-topologies)): the applier carries `APPLY_SCHEMA=safe` for ordinary Git deployments, jobs run embedded in the app, and the app is the follower (`off` + `WAIT_FOR_SCHEMA=true`). The server uses `WORKER_MODE=embedded` when no worker is selected, otherwise `external`. Backups remain a separate required operational setup for every configuration.

Development may automatically deploy `main` or `master` on every selected Application. Follower startup checks a successful receipt for its baked schema fingerprint, no pending/unknown intent, and an empty live schema diff under the same advisory lock. Missing approval, drift, or the default 300-second deadline refuses startup. It does not claim that independently built code revisions are identical; queue contracts and changes to a live schema must remain backward compatible.

Production automatic deployment stays disabled. Select the same existing immutable `release/<full-commit-sha>` Git tag on every role. Custom Git accepts an existing branch/tag in its ref input; a raw SHA does not satisfy Dokploy's `git clone --branch` workflow. Deploy the applier first with Replicated mode, one replica, and restart condition none; wait for its new task to exit successfully, then deploy runtimes. The UI has no ReplicatedJob choice.

Dokploy's Deploy Success notification covers build and Swarm service update submission. It is not a health/job-completion gate. After builds finish, run `scripts/verify-dokploy-deployment.mjs` on the VPS against the selected service names and public URL. It checks the current task generation, apply exit, every runtime healthcheck, and public `/ready`, with bounded waiting. Old completions, failed/rolled-back tasks, a missing healthcheck, and a changed deployment cannot pass.

Dangerous changes require a manually pinned release and fresh target/fingerprint approval, with auto-deploy disabled during the operation in either environment. Set confirmation values only on the schema leader and remove them after either success or failure; return it to `safe`. Dokploy environment values persist until removed.

### Multi-replica on Dokploy

Start with one app replica and, if selected, one worker replica. The advisory lock serializes schema work and the follower gate checks admission before startup. Configure a startup healthcheck grace longer than the schema wait budget and at least 20 seconds for shutdown draining. Do not infer zero downtime from Dokploy's build success message.

### What NOT to do on Dokploy

- Do not add independent schema commands to Application Command fields. Use the canonical db-applier or app entrypoint.
- Do not enable automatic production deployment, share production databases with development, or place confirm values in shared env groups.
- Do not configure multiple schema leaders or disable the follower gate after a failed apply.
- Do not treat a historic successful task or a 200 response from an old container as proof that a pending new build deployed.

---

## Running on another Docker platform

Dokploy is the only *walked-through* target, not the only supported one. The three images are deliberately ordinary — `node:24-slim`, non-root `USER node`, tini as PID 1, no privileged capabilities, no Docker socket, no mounted `/app/.env` — so any host that runs standard containers and a managed (or self-hosted) PostgreSQL 17 + Redis 7 can run them. What follows is the whole portability contract in one place; the per-platform walkthrough does not exist on purpose (four half-tested walkthroughs rot faster than one tested contract).

The rules, whatever the platform:

1. **Run the images as-is.** `Dockerfile` (server), `Dockerfile.worker` (worker), `Dockerfile.db-applier` (one-shot schema/backup/restore). Build them with plain `docker build` / the platform's build step; `README` has copy-paste examples.
2. **Inject environment, never files.** Required vars per image are in [§ Quick reference — env var matrix](#quick-reference--env-var-matrix). The entrypoint fails fast with the missing names — that is the contract working.
3. **Pick exactly one schema leader per deploy** and set `APPLY_SCHEMA=safe` (or `dangerous` behind its confirmation protocol) there, `APPLY_SCHEMA=off` + `WAIT_FOR_SCHEMA=true` on every follower. Full semantics: [§ The `APPLY_SCHEMA` contract](#the-apply_schema-contract). The advisory lock serializes concurrent leaders, but the one-leader discipline is still the documented topology.
4. **Wire the health endpoints.** See [§ Health endpoints](#health-endpoints) for paths and expected codes; the images' built-in healthchecks already use them, so a platform that has its own probe fields should point at the same paths.
5. **Allow ≥ 20 s graceful shutdown** (stop-grace / termination drain) so BullMQ jobs and in-flight requests finish; SIGTERM handling is wired through tini.
6. **Redis must be `noeviction`** — rate-limit and queue correctness depend on keys not being silently evicted. See [§ What ships](#what-ships).
7. **Serverless function platforms do not apply.** Long-lived Node processes + persistent Redis rule out Vercel/Netlify/Cloudflare Pages style runtimes regardless of vendor.

If the platform cannot run a one-shot job container, use the app-entrypoint leader topology (the app image applies schema on boot) — first supported row in [§ Advanced topologies](#advanced-topologies). Backups are platform-independent: `Dockerfile.db-applier` in `backup` mode plus the S3-compatible block in [patterns/backup-and-restore.md](./patterns/backup-and-restore.md).

---

## CI recommendations

Two gates worth adding to the PR pipeline. Neither is strictly required; both are cheap insurance.

### 1. Boot smoke test

After building the server image, run it against an ephemeral Postgres + Redis in CI and poll `/health` until it returns 200. Catches env wiring, entrypoint bugs, Prisma client / schema compatibility, and dependency install regressions — all the ways "builds in CI" can diverge from "boots in prod."

Sketch:

```yaml
# .github/workflows/pr-checks.yml
services:
  postgres:
    image: postgres:17
    env: { POSTGRES_PASSWORD: test }
    ports: [5432:5432]
  redis:
    image: redis:7
    ports: [6379:6379]

steps:
  - run: docker build -t server-test .
  - run: |
      docker run -d --name server \
        --network host \
        -e DATABASE_URL=postgresql://postgres:test@localhost:5432/postgres \
        -e REDIS_URL=redis://localhost:6379 \
        -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
        -e BETTER_AUTH_URL=http://localhost:3000 \
        -e APPLY_SCHEMA=safe \
        -e NODE_ENV=production \
        server-test
      for i in {1..30}; do
        curl -fs http://localhost:3000/health && exit 0
        sleep 2
      done
      docker logs server
      exit 1
```

### 2. Schema diff preview

On PRs that touch `packages/db/prisma/schema/`, run a job that:

- Starts an ephemeral Postgres and applies the **previous** schema (from `main`).
- Runs `prisma migrate diff --from-schema <base> --to-schema <head> --script` against the current PR's schema.
- Posts the summary as a PR comment.

If the summary contains any destructive operation, require a PR label (e.g. `schema:dangerous`) to pass the check. Makes it impossible to accidentally merge a destructive change without explicit opt-in.

---

## Hard rules for the infra agent

- **Do not set `APPLY_SCHEMA=dangerous` as the steady state.** After success or failure, clear confirmation/acceptance values and return the leader to its ordinary setting: `safe` on Dokploy native Git, `off` on explicitly toggled workflows. Followers stay `off`; never disable their schema gate to bypass a failed apply.
- **Do not set `APPLY_SCHEMA=safe|dangerous` on more than one container simultaneously.** Pick one leader per deploy.
- **Do not apply schema SQL from outside the canonical scripts.** The deploy mechanism — the one-shot db-applier job or the container entrypoint, both running `scripts/db-applier.sh apply` — is the canonical path; bypassing it with an ad-hoc shell push skips the advisory lock, the confirm-bound plan SHA, and the audit trail of deploy logs.
- **Do not add a third path that mutates the schema** (unattended cron, CI post-deploy hook, ad-hoc admin action). The one-leader-per-deploy discipline depends on there being exactly one.
- **Do not bake `.env` files into the image.** All production values are injected at runtime by the orchestrator.
- **Do not disable the startup probe** to "speed up" deploys. It is what gates traffic away from a failed boot — without it, a failed schema push would immediately cause user-visible 500s.
- **Do not use `sudo` on the host.** If a platform operation requires it (apt install, systemctl, privileged ports), surface the command to the user and have them run it. The Dockerfile images are built without privileged operations; the host rarely needs them either.
- **Do not remove the advisory lock from the entrypoint.** Even if the current deploy is single-replica, a future scale-up would race.

---

## Quick reference — env var matrix

| | Server image | Worker image | Job (schema-sync, db-applier image) |
|---|---|---|---|
| Image | `Dockerfile` | `Dockerfile.worker` | `Dockerfile.db-applier` |
| `DATABASE_URL` | ✅ | ✅ | ✅ |
| `REDIS_URL` | ✅ | ✅ | — (the applier script never reads it) |
| `BETTER_AUTH_SECRET` | ✅ | - | - |
| `BETTER_AUTH_URL` | ✅ | — (not validated by `@starter/env/shared`) | — |
| `NODE_ENV=production` | ✅ | ✅ | baked into the image |
| `APPLY_SCHEMA` | Dokploy: `safe` if leader, otherwise `off` | Dokploy: always `off`; other platforms may explicitly select it as leader | Dokploy: `safe` ordinarily; explicit-toggle platforms: `off` between runs. `dangerous` is temporary everywhere |
| `WAIT_FOR_SCHEMA` | Dokploy: `true` if follower, otherwise `false` | Dokploy: `true` | Not a runtime follower |
| `BACKUP_S3_*` | only if it leads via entrypoint | only if it leads via entrypoint | ✅ for the required pre-apply dump |
| `ADMIN_EMAILS` | recommended | — | — |
| `SMTP_*` | ✅ (prod) | optional alerts | — |
| `CORS_ORIGIN` | conditional | — | — |
| Command override | default | default | `apply` (or `DB_APPLIER_MODE=apply`) |
| Ingress | external, :3000 | disabled | N/A (one-shot Job) |
| Health probe | `/health` liveness, `/ready` readiness | Container-local runtime health | N/A |
| Replicas | ≥ 1 | ≥ 1 | 1; Dokploy Replicated + restart none |

Exactly one leader — the one-shot apply job or one app entrypoint — carries apply authority. Dokploy keeps that role `safe` on ordinary Git deployments, including no-op changes; other platforms follow their documented per-deploy lifecycle. See [§ Picking the schema leader](#picking-the-schema-leader).

`BETTER_AUTH_SECRET` is required by the server runtime and by the entrypoint when the server command starts. The worker command path does not require it, and the db-applier apply job never reads it: the image runs no app code, and `scripts/db-applier.sh` requires only `DATABASE_URL` (plus the `BACKUP_S3_*` dump-writer pair when the pre-apply backup gate applies, and the `APPLY_SCHEMA_CONFIRM*` pair for a `dangerous` run). It does not validate `REDIS_URL` — the applier talks only to Postgres. `BETTER_AUTH_URL` and the other server-only variables are not required by the worker at all.

---

## Advanced topologies

Every platform's blessed topology ([§ Picking the schema leader](#picking-the-schema-leader)) is the documented path. These variants remain fully supported — each still has exactly one schema leader per deploy and the same follower gates; they trade container count for isolation or coupling. `pnpm dokploy:config --topology <id>` still generates the manual-UI settings checklist for each Dokploy variant.

| Topology | Schema leader | Jobs | Followers | When it is the right call |
|---|---|---|---|---|
| **App + applier** *(blessed)* | Applier, `safe` | Embedded in app | App waits | The default. Schema-sync failure stays out of app startup; one canonical mutating container. |
| App | App entrypoint, `safe` | Embedded | None | Fewest containers. Couples schema sync to one app boot; reasonable with the provider-only backup profile ([backup-and-restore.md § Provider-only profile](./patterns/backup-and-restore.md#provider-only-profile-opt-in)). |
| App + worker | App entrypoint, `safe` | Dedicated worker | Worker waits | Isolates job CPU/memory (chat, translations) from the API while keeping containers minimal. |
| App + applier + worker | Applier, `safe` | Dedicated worker | Both wait | Maximum separation: schema, API, and jobs each scale and fail independently. |

Postgres and Redis are required infrastructure in every configuration. Whatever the shape, the single-leader discipline of [§ Picking the schema leader](#picking-the-schema-leader) and the hard rules above still apply: exactly one `APPLY_SCHEMA != off` role per deploy, followers gated by `WAIT_FOR_SCHEMA=true`, `dangerous` never steady-state, and one backup schedule per database.

---

## See also

- [patterns/deployment-vps.md](./patterns/deployment-vps.md) — **the default deployment target** (Dokploy on a VPS; domain, HTTPS, backups, monitoring).
- [patterns/schema-changes-recipe.md](./patterns/schema-changes-recipe.md) — the workflow for evolving the schema, including the required expand-contract pattern for destructive changes.
- [patterns/schema-push.md](./patterns/schema-push.md) — the deploy mechanics (entrypoint internals, advisory lock, seed scripts, slim-app variant).
- [patterns/backup-and-restore.md](./patterns/backup-and-restore.md) — production backup posture, logical dumps, and restore drills.
- [patterns/production-hardening.md](./patterns/production-hardening.md) — pre-go-live checklist for admin gating, email verification, rate limiting, CSRF.
- [AGENTS.md](./AGENTS.md) — rules for agents working in this repo, including the Dangerous Commands list and the schema-leader discipline summary.
