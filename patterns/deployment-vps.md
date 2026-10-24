# Deployment — Dokploy on a VPS

> **The default deployment strategy for this repo.** A single VPS running [Dokploy](https://dokploy.com) is cheap (single Hetzner CX22 at ~€4/month) and keeps the app, Postgres, and Redis in infrastructure you control (no per-seat pricing and a portable Docker deployment). External services you configure — SMTP, S3-compatible storage, analytics, or model providers — still receive the data sent to them, so self-hosting is not by itself a promise that no PII leaves your tenancy. Those are real wins and real boundaries — and they are paid for in operational time you would not spend on a managed platform.
>
> ### What you own on this path
>
> Everything the managed platforms take care of becomes yours:
>
> | You own | What it actually means |
> |---|---|
> | The VPS itself | Provisioning, sizing, reboots, host-level failures. One box is a single point of failure until you add more. |
> | OS patching | `apt upgrade`, kernel updates, and security patches on a schedule you enforce — nobody else does. |
> | Postgres (via Dokploy's managed-database UI) | Version upgrades, `PG_MAJOR` client alignment (§ 4), connection limits, disk growth. The "managed" UI automates the container, not the operational diligence. |
> | Redis (same) | Persistence configuration, `noeviction` discipline (§ 5), memory ceilings. |
> | TLS edge cases | Let's Encrypt rate limits, renewal failures, DNS mistakes (§ 14). Managed platforms absorb these. |
> | Backup verification | Dumps landing off-site *and* a restore drill you have actually run (§ 11, [backup-and-restore.md](./backup-and-restore.md)). Nobody emails you when your bucket credentials expire. |
> | Out-of-disk incidents | A full disk is the classic single-VPS failure: Postgres stops writing, dumps fail, builds die. You monitor and clear it (§ 14). |
>
> If that list is longer than you want, use a managed alternative. The rest of this document assumes you are comfortable with SSH, Linux ops, Docker, certificate lifecycle, and Postgres backup/restore drills.
>
> **Deployment defaults:** the blessed path is the Compose file `pnpm dokploy:config` generates (§ 3) — Dokploy deploys it directly. The manual alternative builds native Applications from Git: development can deploy `main`/`master` automatically; production uses a manually selected immutable release tag. Either way the db-applier is the preferred schema leader, and app startup waits for a successful apply matching its schema, so independent Git build completion order cannot start it against an unapproved schema. Read [§ Schema deploy lifecycle](#schema-deploy-lifecycle).

Linear walkthrough for deploying the starter app to a single VPS using [Dokploy](https://dokploy.com), an open-source self-hosted PaaS.

Before admitting production traffic, complete [production-hardening](./production-hardening.md) and [launch-readiness](./launch-readiness.md). The agent verifies the app's notices, enabled providers, audience/data decisions, and evidence in `notes/06-launch-readiness.md`; unresolved applicable items block launch even when deployment healthchecks pass.

> **Looking for the deploy contract?** See [infra-notes.md](../infra-notes.md) for the full cross-platform deploy contract (env vars, `APPLY_SCHEMA` lifecycle, health probes, schema-leader selection).

> **What won't work.** Vercel, Netlify, and Cloudflare Pages are designed for stateless functions. This stack needs long-lived Node processes (Hono server with SSR, BullMQ worker polling Redis). Those platforms will time out, lack Redis access, or refuse persistent connections. Use a VPS with Docker instead.

---

## 1. What you'll need

| Requirement | Notes |
|---|---|
| Linux VPS | 2 vCPU / 4 GB RAM minimum. 8 GB recommended for builds (TypeScript + Prisma generate is memory-hungry). [Hetzner CX22](https://www.hetzner.com/cloud) is a solid default (~€4/month). |
| Domain | A or AAAA record pointing at the VPS IP. Dokploy handles Let's Encrypt certificates automatically. |
| Git repository | Connect the repository to Dokploy; the Dockerfiles build from it (via the generated Compose file in § 3, or native Applications). No container registry required. |
| SMTP provider | Any transactional SMTP service (Resend, Postmark, Amazon SES) or [Mailpit](https://github.com/axllent/mailpit) for staging. Needed for email verification. |

---

## 2. Install Dokploy

SSH into your VPS and run the official one-liner:

```bash
curl -sSL https://dokploy.com/install.sh | sh
```

After installation, open `https://<your-ip>:3000` to create the Dokploy admin account. Full docs: [dokploy.com/docs](https://docs.dokploy.com).

---

## 3. Create the project

In the Dokploy dashboard:

1. **Projects → New Project** — name it `my-app` (or whatever you like).
2. Inside the project, create `development` and `production` environments (or just production if no deployed development instance is wanted).

Repeat the setup below for each environment. Give each its own Postgres, Redis, database credentials, auth secret, app origin, and backup namespace. A deployed development instance still runs `NODE_ENV=production`; its name describes its purpose, not a reason to disable production security. Never connect development to the production database or copy production credentials into local files.

### Blessed path — deploy the generated Compose file

`pnpm dokploy:config` generates everything the blessed topology needs as a **Dokploy-consumable Compose file** (Dokploy deploys Compose directly): the `server` app with embedded background jobs, a one-shot `schema-apply` db-applier leader, Postgres 17, and Redis 7 with `noeviction`:

```sh
pnpm dokploy:config \
  --environment development --git-ref main \
  --url https://dev.example.com
```

The command writes `docker-compose.dokploy.yml` (a gitignored artifact — regenerate it, don't hand-edit it) and prints the JSON **settings checklist**: which env vars each service needs (`compose.environmentVariables`), the release contract, and the backup reminder. The file already bakes in the things the manual path makes you configure by hand:

- **Traefik routing + TLS + response compression** for `--url` — including the compress middleware from [§ 8](#8-create-the-server-application) that is off by default in Traefik.
- **The swarm update/rollback policy and stop-grace** from [§ 10](#10-git-builds-and-deployment-checks) (`start-first`, rollback, 30s grace).
- **The schema gate**: `schema-apply` runs `APPLY_SCHEMA=safe` on every deploy that recreates it (restart `none`); `server` runs `WORKER_MODE=embedded` with `APPLY_SCHEMA=off` + `WAIT_FOR_SCHEMA=true` and waits for the apply to complete successfully before booting.

Then:

3. **Your project → Compose → New Compose**, and paste (or upload) the generated file.
4. Fill the environment variables the checklist lists — complete literal values; the file gives secrets **no defaults**. At minimum: `POSTGRES_PASSWORD` and `REDIS_PASSWORD` (`openssl rand -hex 24` each), `BETTER_AUTH_SECRET` (`openssl rand -hex 32`), `ADMIN_EMAILS`, and the `SMTP_*` block. Connect the repository/branch so Dokploy builds the images from Git.
5. Deploy. On a fresh database, `schema-apply` initializes the schema before `server` boots; watch its logs for `Schema sync complete.`
6. Enable backups ([§ 11](#11-enable-postgres-backups)): the compose ships the `db-backup` schedule service commented out — uncomment it and fill its `BACKUP_S3_*` dump-writer values, or use Dokploy's managed-backup UI instead (never both).
7. Accept the deployment with `pnpm dokploy:verify` ([§ 10](#10-git-builds-and-deployment-checks)).

Using Dokploy's managed Postgres/Redis instead of the compose's own? Delete the `postgres`/`redis` services from the file and set `DATABASE_URL` / `REDIS_URL` on `server` + `schema-apply` with the internal hostnames from each database's overview page ([§ 4](#4-provision-managed-postgres), [§ 5](#5-provision-managed-redis)).

### Manual UI setup (fallback)

Prefer clicking through the dashboard, or need one of the other topologies (dedicated worker, app-entrypoint leader)? The rest of this section — § 4 through § 12 — remains the fully supported manual walkthrough. Generate a settings checklist before using the dashboard:

```sh
node --import tsx scripts/generate-dokploy-config.ts \
  --environment development --git-ref main --topology app-applier \
  --url https://dev.example.com
```

Use `master` when that is your default branch. The output is a reviewable JSON **settings checklist**, not a Dokploy import/API payload. It contains placeholders and direct references only, reads no credentials, and makes no remote changes. Choose `app`, `app-applier` (default), `app-worker`, or `full` — the blessed `app-applier` shape is what the Compose file above deploys, and the alternatives are catalogued in [infra-notes.md § Advanced topologies](../infra-notes.md#advanced-topologies). For production use `--environment production --git-ref release/<full-commit-sha> --url https://example.com`; create that immutable Git tag before selecting it in Dokploy. Do not move or overwrite release tags.

---

## 4. Provision managed Postgres

> **The database server itself must be PostgreSQL 17 or newer — this is a hard floor, not a client-tools detail.** Schema apply runs from the container entrypoint on every deploy and uses PostgreSQL 17 features such as `transaction_timeout`, so on a PostgreSQL 16 (or older) server every deploy fails with `Schema apply requires a PostgreSQL 17 or newer database server` and the app never boots — the only fix is re-provisioning the database, because no setting raises a server's major.

1. **Databases → New → PostgreSQL**.
2. Name: `my-app-postgres`.
3. Dokploy auto-generates credentials and creates a persistent volume.
4. Note the generated **user**, **password**, **database name**, and **internal hostname** — referenced in env vars below.
5. **Client alignment (secondary to the server floor above): check the Postgres major against `PG_MAJOR`.** Open the database overview and note the major version (17, 18, …). Every image that runs `pg_dump`/`psql` pins a client major with `ARG PG_MAJOR` — `Dockerfile`, `Dockerfile.worker`, and `Dockerfile.db-applier` (all three must agree; `pnpm docker:check-copy` verifies). `pg_dump` can dump an **older** server but never a **newer** one, so if Dokploy's image is newer than `PG_MAJOR`, `scripts/backup.sh` hard-fails every backup with `pg_dump is version X but the server is version Y`. A newer client against an older server is fine. Bump `PG_MAJOR` in all three Dockerfiles when you upgrade the database major. See [backup-and-restore.md § The `PG_MAJOR` rule](./backup-and-restore.md#the-pg_major-rule-when-you-upgrade-postgres).

---

## 5. Provision managed Redis

1. **Databases → New → Redis**.
2. Name: `my-app-redis`. Set a password.
3. Note the **password** and **internal hostname**.

Redis is shared between the BullMQ job queue and the rate limiter. If you configure Redis `maxmemory`, keep `maxmemory-policy noeviction`; BullMQ is not safe under eviction. A stock `redis:7-alpine` with no memory cap is fine until you add a cap.

---

## 6. Project-level env vars

Project variables are a reference store, **not inherited environment variables**. Keep environment-specific credentials in the corresponding environment. Project-level variables are optional for genuinely shared non-secret settings. Never put production database or auth credentials here when the project also contains development.

The following inventory belongs in each environment unless the setting is intentionally shared:

| Variable | Value |
|---|---|
| `POSTGRES_USER` | *(from step 4)* |
| `POSTGRES_PASSWORD` | *(from step 4)* |
| `POSTGRES_DB` | *(from step 4)* |
| `REDIS_PASSWORD` | *(from step 5)* |
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32` — run locally, paste the result |
| `ADMIN_EMAILS` | Comma-separated list of emails that should get admin access on sign-up (see [production-hardening.md](./production-hardening.md)) |
| `SMTP_HOST` | Your SMTP provider hostname |
| `SMTP_PORT` | Usually `587` (TLS) or `465` (SSL) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | `noreply@yourdomain.com` |

---

## 7. Environment-level env vars

Set these at the **environment** level as complete literal values. Do not put `${{project.*}}` references inside them: Dokploy does not recursively resolve project references stored in environment values. Copy the complete database connection strings from that environment's database overview; URL-encode credentials when constructing a URL manually.

| Variable | Value |
|---|---|
| `DATABASE_URL` | Complete PostgreSQL connection string for this environment |
| `REDIS_URL` | Complete Redis connection string for this environment |
| `BETTER_AUTH_URL` | `https://yourdomain.com` |
| `CORS_ORIGIN` | Only set if the web app is served from a different origin. Omit for same-origin. |
| `NODE_ENV` | `production` |

Each Application must explicitly map the values it consumes, for example `DATABASE_URL=${{environment.DATABASE_URL}}`. A value merely present in the environment or project is not automatically available to a container. The generator supplies the required per-Application mapping. Keep `APPLY_SCHEMA`, `WAIT_FOR_SCHEMA`, `WORKER_MODE`, and all confirmation variables on their specific Application, outside shared values. Runtime startup validates required variables without printing their values.

Replace `my-app-postgres` and `my-app-redis` with the actual Dokploy internal hostnames shown on each database's overview page.

### Build-time vs runtime env vars

Almost everything is runtime-overridable — build the Docker image once and deploy it to dev, staging, and prod with different env values. The Dockerfile deliberately does not copy any `.env` file into the image (`Dockerfile:84`); `scripts/docker-entrypoint.sh` validates required vars on container start.

**Runtime (change in Dokploy, restart the container, done):** the server's full env surface — `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `REDIS_URL`, `CORS_ORIGIN`, all `SSO_*`, `SMTP_*`, `VAPID_*`, `RATE_LIMIT_*`, `SIGNUP_ENABLED`, `ADMIN_EMAILS`, `NODE_ENV`. This surface is split across two modules: the worker-safe vars (`DATABASE_URL`, `REDIS_URL`, `NODE_ENV`, all `S3_*` and translation vars, and optional `SMTP_*` for worker alerts) are declared in `packages/env/src/vars/shared.ts` and validated by `packages/env/src/shared.ts`; the server-only vars (`BETTER_AUTH_*`, `CORS_ORIGIN`, `SSO_*`, `VAPID_*`, `RATE_LIMIT_*`, `SIGNUP_ENABLED`, `ADMIN_EMAILS`, image-proxy/asset caps) are declared in `packages/env/src/vars/server.ts` and validated by `packages/env/src/server.ts`, which `extends` the shared module so server code still sees one merged `env`. The worker imports only the shared module — see step 9.

**Baked at build time (a change requires rebuilding the web bundle):**

- **`VITE_*` vars**, declared in `packages/env/src/vars/web.ts` and validated by `packages/env/src/web.ts`. Vite statically replaces `import.meta.env.VITE_*` with string literals when it compiles the client bundle — wrapping them in `@t3-oss/env-core` does not change that. Setting them on the running container has no effect.
  - **`VITE_SERVER_URL`** has a runtime fallback to `window.location.origin` (the `VITE_SERVER_URL` getter in `packages/env/src/web.ts`). Leave it unset at build time and same-origin deployments just work. You only pay the build-time cost if the web app must talk to a backend on a different origin — set it as a Docker build arg and rebuild per environment.
  - **`VITE_APP_NAME`** falls back to `"App"`. A plain `docker build` (and Dokploy's build) does **not** auto-forward an Application's env vars into the build, so pass it explicitly if you want it baked in: `--build-arg VITE_APP_NAME=…`.
- **PWA manifest** (`name`, `short_name`, `description`, `theme_color`, `background_color`) is hardcoded in `apps/web/vite.config.ts:52-58`. Rebranding requires a rebuild. See [patterns/removable/rebrand.md](./removable/rebrand.md).
- **`BUILD_VERSION`** → `__APP_VERSION__` is a build identifier only — update detection is driven by the service-worker lifecycle (vite-plugin-pwa `autoUpdate`), not by comparing this string. **Pass it as a build arg wired to the full commit SHA** (`--build-arg BUILD_VERSION="$(git rev-parse HEAD)"`) so diagnostics identify the release and rebuilds of the same commit stay reproducible. `.git` is excluded from the build context, so if you omit it every rebuild mints a fresh random identifier into the bundle for no benefit.

**Implication for cross-origin deployments.** If you split the web app and API onto different domains, either (a) set `CORS_ORIGIN` on the server and pass `VITE_SERVER_URL` as a build arg to `docker build`, rebuilding the image per environment, or (b) front both with the same reverse proxy so they share an origin and the `window.location.origin` fallback keeps the client build environment-agnostic. Option (b) is simpler and is the default assumption of this starter.

---

## 8. Create the server Application

1. **Applications → New → Application**.
2. Name: `server`.
3. **Source type**: GitHub (or your connected Git provider). Select your repository and `main`/`master` for development. For production, select an immutable `release/<full-commit-sha>` tag using **Git / Custom Git** and its ref field if the provider dropdown only lists branches. A raw commit SHA is not a valid replacement for `git clone --branch`; use an existing tag.
4. **Build type**: Dockerfile; Dockerfile path `Dockerfile`; build context `.`. Disable **Create .env file**. Enable automatic deployment on development only. Production automatic deployment and push webhooks stay disabled.
5. **Command**: leave blank — the Dockerfile's default `CMD` starts the Hono server. (`scripts/docker-entrypoint.sh` runs the db-applier apply path before that if `APPLY_SCHEMA != off` on this Application — the entrypoint fallback, see [schema deploy lifecycle](#schema-deploy-lifecycle).)
6. **Environment variables**: use the generated explicit mapping. With an applier set `APPLY_SCHEMA=off`, `WAIT_FOR_SCHEMA=true`; without an applier set `APPLY_SCHEMA=safe`, `WAIT_FOR_SCHEMA=false` so this app applies before serving. Set `WORKER_MODE=embedded` when there is no dedicated worker, otherwise `external`.
7. **Domain**: add your domain, enable **Let's Encrypt** for automatic HTTPS.
8. **Port**: `3000`.

### Enable response compression (don't skip)

The Node server intentionally ships no compression middleware — that's the proxy's job ([infra-notes.md § Response compression](../infra-notes.md#response-compression-is-the-platforms-job)). Some managed platforms compress at their load balancer; **Traefik does not** — its compress middleware is off by default, so a fresh Dokploy deploy serves every HTML/JSON/JS response uncompressed. That can triple page weight for the SSR'd public pages and the SPA bundles, which hurts most on slow mobile connections.

Fix it once, at the Traefik layer: define a compress middleware and attach it to the server's router. In Dokploy, edit the server Application's Traefik config (**Advanced → Traefik**) to add the middleware; in the [generated Compose file](#docker-compose-alternative) the labels are already on the `server` service, and in a hand-rolled compose they are two labels:

```yaml
- "traefik.http.middlewares.server-compress.compress=true"
- "traefik.http.middlewares.server-compress.compress.encodings=zstd,br,gzip"
- "traefik.http.routers.server.middlewares=server-compress"
```

Traefik skips responses that are already encoded and bodies under 1 KB, so there is no double-compression hazard. Verify after deploy:

```sh
curl -sI -H 'Accept-Encoding: br, gzip' https://yourdomain.com/ | grep -i content-encoding
# expect: content-encoding: br (or gzip)
```

`pnpm dokploy:verify` performs this same check automatically after readiness passes — it requests the public site root (following the locale redirect) with `Accept-Encoding` and prints a non-fatal warning citing this section when the response comes back uncompressed.

---

## 9. Create the worker Application

1. **Applications → New → Application**.
2. Name: `worker`.
3. This Application is optional. Without it, the app runs the same background runtime with `WORKER_MODE=embedded`; queues, retries, and scheduled work stay available.
4. **Source type**: Git, same repository and ref as the server. Dockerfile `Dockerfile.worker`, build context `.`; leave the Command blank. Enable automatic deployment only for development. Set `APPLY_SCHEMA=off` and `WAIT_FOR_SCHEMA=true`; the applier (or server when no applier is selected) is the schema leader.
5. **Domain**: none — the worker healthcheck listens only inside its container.
6. **Replicas**: `1` (scale up if job throughput demands it).
7. **Environment variables**: the worker process imports only `@starter/env/shared`, so it needs just the worker-safe set: `DATABASE_URL`, `REDIS_URL`, `NODE_ENV`, plus any `S3_*`, translation-provider, or `SMTP_*` vars whose jobs this worker actually runs (asset analysis, asset cleanup, chat runs, seed, expired-auth-token reaping, backup-freshness checks, operational-alert email). For the default logical-backup profile, also set `BACKUP_ENABLED=true` and give it the non-secret `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ENDPOINT` / `BACKUP_S3_FORCE_PATH_STYLE` (when used), `BACKUP_S3_PREFIX`, `BACKUP_MAX_AGE_HOURS`, and a dedicated ListBucket-only `BACKUP_MONITOR_S3_ACCESS_KEY_ID` / `BACKUP_MONITOR_S3_SECRET_ACCESS_KEY` pair. Never give the normal worker the dump-writer `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` pair merely for freshness checks. It does **not** need `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `CORS_ORIGIN`, `SSO_*`, `VAPID_*`, or the `RATE_LIMIT_*` knobs. Keep `APPLY_SCHEMA=off` (or unset) on this worker Application in the golden-path setup. In all supported Dokploy topologies the worker stays `off` with `WAIT_FOR_SCHEMA=true`; the app is the fallback leader when there is no applier.

The server image includes the background runtime so fewer-container deployments retain features. A dedicated worker isolates its CPU/memory load. Both Dockerfiles share tooling and entrypoint contracts; when editing one, check the other ([AGENTS.md](../AGENTS.md)).

---

## 10. Git builds and deployment checks

The supported default uses native Dokploy Applications. There is no registry publish step or Compose configuration.

**Blessed topology** — the shape `pnpm dokploy:config` emits as `docker-compose.dokploy.yml` and § 3 imports:

| Selected containers | Schema leader | App jobs | Follower gate |
|---|---|---|---|
| **App + applier** (blessed) | Applier, `safe` | Embedded | App waits |

The other supported shapes — App, App + worker, App + applier + worker — remain fully supported **advanced variants**: the `--topology` flag still generates their settings checklists, and the full table with trade-offs lives in [infra-notes.md § Advanced topologies](../infra-notes.md#advanced-topologies). Postgres and Redis are required infrastructure in every configuration. Backup scheduling is configured separately in § 11; choose one backup schedule per database regardless of where background jobs execute.

**Development:** enable native automatic Git deployment on the selected Applications, following `main` or `master`. With Custom Git, configure its per-Application push webhook in your Git host. Build completion order may differ. Every follower uses `WAIT_FOR_SCHEMA=true`: before HTTP starts or any jobs are consumed, it waits for a successful receipt with the image's schema fingerprint, no pending/unknown operation, and an empty live Prisma schema diff, checked under the applier's advisory lock. The default wait budget is 300 seconds; `SCHEMA_WAIT_TIMEOUT_SECONDS` accepts 1–3600. It exits nonzero on timeout or shutdown.

This proves **schema compatibility at startup**, not identical source commits, matching queue payload contracts, or safety against a later incompatible schema edit. Keep queue payloads and database changes compatible across adjacent releases; use expand-contract. If the branch advances while builds are running, an older image whose schema no longer matches will refuse startup. Deploy the latest branch again to converge. No automatic database rollback occurs.

The runtime Docker healthchecks allow startup grace for the default schema wait. If you raise `SCHEMA_WAIT_TIMEOUT_SECONDS`, raise the corresponding Dokploy healthcheck start period beyond that budget too. Start the verifier after builds finish and set its `--timeout-seconds` long enough for the chosen schema wait plus runtime healthchecks; it does not wait for future Git builds.

Set **Advanced → Swarm Settings → Update Config** to `Parallelism: 1`, `Order: start-first`, `FailureAction: rollback`, and **Rollback Config** to `Parallelism: 1`, `Order: start-first`, as shown by the generator. These match Dokploy's Application defaults when the fields are unset; saving a partial settings object replaces those defaults. `stop-first` intentionally stops the old task before starting its replacement. `start-first` allows overlap but does not coordinate independent Applications or promise uninterrupted traffic during a schema wait. The server's Docker healthcheck uses `/health` (HTTP liveness); required worker queue coverage is checked by `/ready` during deployment verification and monitoring. A healthy Docker task alone does not establish consumer availability.

**Production:** keep automatic deployment disabled. Create an immutable Git tag `release/<full-commit-sha>` for the reviewed commit, and select that same tag on every role. Run the schema leader first; after success, deploy the app and optional worker. Selecting a production release does not change development's branch or database.

With a dedicated applier, confirm that the newly selected apply task actually exited zero before starting the runtime deployments; Dokploy's build notification is insufficient. Development's independent automatic builds retain the bounded follower gate: if the leader does not finish within the wait budget, inspect it and redeploy the latest branch after it succeeds.

Dokploy's **Deploy Success** means the build and Swarm service create/update request succeeded. It does **not** wait for app health or successful completion of the schema task. Verify the selected deployment after builds finish, using actual Swarm service names from Dokploy:

```sh
node scripts/verify-dokploy-deployment.mjs \
  --server production-server-actual-name \
  --applier production-schema-apply-actual-name \
  --worker production-worker-actual-name \
  --url https://example.com
```

Run this from a checkout of the template on the single VPS with Docker access. Omit `--worker`/`--applier` when absent. The verifier is read-only, uses a 600-second budget, checks the current service generation (historical tasks cannot pass), successful applier exit, every selected runtime container's healthcheck, and public `/ready`. A changed service, failed task, rollback, missing healthcheck, or timeout exits nonzero. It does not read env values or logs. Run it **after** Dokploy finishes selecting each new service spec; it cannot identify a future build that has not reached Swarm yet, or independently prove which Git commit a locally tagged image contains.

---

## 11. Enable Postgres backups

Dokploy's **Schedule Jobs** are `docker exec` commands run inside already-running containers — they cannot stand up the db-applier image as a one-shot on a schedule. So the **default profile on Dokploy is the in-container schedule**: a long-lived db-applier service that runs its own cron. The full profile guide (toggles, bucket lifecycle, versioning, freshness monitoring) lives in [backup-and-restore.md § Choose a backup profile](./backup-and-restore.md#choose-a-backup-profile); this section is the Dokploy shape.

### Default profile — db-applier schedule service

1. **Applications → New → Application**. Name: `db-backup`.
2. **Source type**: Git. Use the same repository/ref and `Dockerfile.db-applier`, build context `.`. No domain or command override; the mode comes from the environment. This optional long-running backup service is separate from the apply task. Use one replica and ordinary restart-on-failure behavior.
3. **Environment variables** on this Application (not the shared project level — it must never inherit the app's auth/SMTP secrets, and the app must never inherit its dump-writer key):

   | Variable | Value |
   |---|---|
   | `DB_APPLIER_MODE` | `schedule` |
   | `BACKUP_CRON` | `0 3 * * *` (5 fields, no seconds — the entrypoint refuses anything else) |
   | `BACKUP_ENABLED` | `true` |
   | `DATABASE_URL` | `${{environment.DATABASE_URL}}` |
   | `BACKUP_S3_BUCKET` | Your private backup bucket (versioning on) |
   | `BACKUP_S3_ACCESS_KEY_ID` | Dedicated dump-writer key (GetObject, PutObject, and AbortMultipartUpload only) |
   | `BACKUP_S3_SECRET_ACCESS_KEY` | — |
   | `BACKUP_S3_REGION` | Real AWS region, or `auto` **with** `BACKUP_S3_ENDPOINT` set for R2/B2/MinIO |
   | `BACKUP_S3_ENDPOINT` | Only for non-AWS S3-compatible storage |
   | `S3_ACCESS_KEY_ID` | *(optional)* non-secret app-upload key ID, so the writer can prove it is not reusing the app's credential |

4. The entrypoint writes `/app/db-applier.env`, validates the config, and runs `cron -f`; each tick dumps (`pg_dump -Fc`), smoke-checks, uploads, and logs to the container's stdout. Run **one restore drill** into a throwaway database before relying on it — [backup-and-restore.md § Restore drill](./backup-and-restore.md#restore-drill).

Do **not** also run Dokploy's managed backup against the same database — two schedules means double dumps and double cost, and only confusion about which copy restores.

### Opt-in — Dokploy's managed backup UI (or provider-only)

Dokploy's database **Backups** tab (S3 destination, daily snapshot, ≥14-day retention) can replace the schedule service if you prefer it. That is the **provider-only profile**: set `BACKUP_ENABLED=false` and `BACKUP_PRE_APPLY_ENABLED=false` on every container that could run schema apply, and remove the db-applier schedule service. One contractual consequence: with logical backups off, an `APPLY_SCHEMA=dangerous` deploy **refuses to run** until you also set `APPLY_SCHEMA_ACCEPT_PROVIDER_BACKUP=I_ACCEPT_PROVIDER_BACKUP_ONLY` for that deploy only — see [backup-and-restore.md § Provider-only profile](./backup-and-restore.md#provider-only-profile-opt-in).

Be honest about what daily snapshots are: **restore points on a 24-hour grid, not point-in-time recovery.** Anything written between the last snapshot and the incident is gone. If you need a tighter RPO, keep the logical-backup profile (or both layers) and size `BACKUP_CRON` accordingly.

---

## 12. First deploy

The preferred schema leader is a db-applier Application. The app entrypoint is the supported fallback when you choose no applier; it uses the same guarded implementation. **On the generated-Compose path (§ 3) none of this is manual** — the `schema-apply` service in `docker-compose.dokploy.yml` already is this one-shot leader; once it is deployed, continue from [First deploy steps](#first-deploy-steps).

### Create the one-shot schema-apply Application (manual golden path)

1. Create an Application named `schema-apply`, using the same Git repository/ref as the app, Dockerfile `Dockerfile.db-applier`, build context `.`, and no domain.
2. Set `DB_APPLIER_MODE=apply`, `APPLY_SCHEMA=safe`, and explicitly map `DATABASE_URL=${{environment.DATABASE_URL}}`. Give it backup-writer credentials only when configuring the logical pre-apply backup profile. Never give it app auth/SMTP secrets or any `RESTORE_*` variable.
3. In **Advanced → Swarm Settings → Mode**, select **Replicated**, replicas **1**. In restart policy select condition **none**. The successful task exits; it is not a long-running healthy service. The inspected Dokploy UI offers Replicated and Global, **not ReplicatedJob**.
4. Use normal **Deploy** to build the selected Git ref and create a new task. A previous completed task is not evidence that this deployment ran. On production, wait for this generation's task to complete with exit 0 before deploying runtime Applications.
5. Enable automatic deployment only for development. Ordinary deployments keep `safe` on this one leader; non-leaders stay `off` and enable `WAIT_FOR_SCHEMA`.

### First deploy steps

1. Apply the generated configuration and check that every Application targets this environment's database/Redis, not the other environment.
2. Deploy the schema leader. A fresh database is initialized by the guarded `safe` run and receives a schema receipt.
3. Confirm the new schema task completed successfully. If using the app as leader, its entrypoint must complete schema apply before the app starts.
4. Deploy the app and optional worker. The follower gate refuses missing receipts, receipts for a different schema, live drift, and pending/unknown schema operations. A failed or timed-out gate never starts HTTP or background consumers.
5. Run the verifier in § 10. Check HTTPS and sign-in separately before inviting users.

### Schema deploy lifecycle

One designated leader carries `APPLY_SCHEMA=safe` on ordinary Git deployments. This handles both schema changes and no-op changes, and refreshes the receipt even for an empty diff. It uses the shared classifier, bounded database lock/statement waits, backup gate, durable intent, and confirm-bound SQL execution. A follower never applies schema.

**Dangerous changes are manual in both environments.** First complete expand-contract and obtain the operator's specific approval. Disable automatic deployments while preparing this operation and pin all roles to the selected immutable release tag.

1. Run the leader in `dangerous` without confirmation to get the non-authoritative target ID, schema fingerprint, and plan SHA-256. The preview exits nonzero and mutates nothing.
2. On the leader only, set `APPLY_SCHEMA_CONFIRM=DANGEROUS:<target-id>:<schema-fingerprint>`. For the provider-only backup profile, the separate `APPLY_SCHEMA_ACCEPT_PROVIDER_BACKUP=I_ACCEPT_PROVIDER_BACKUP_ONLY` acknowledgement is also required.
3. Deploy the pinned leader. The applier checks the confirmation, takes the required backup, recollects the plan, and only applies when its hash still matches. A mismatch fails closed.
4. After success **or failure**, remove all confirmation/acceptance values and return the leader to `safe` before restoring development automatic deployment. Keep production automatic deployment disabled. Do not put confirmation values into shared env groups, build args, a Git file, or a reusable release checklist.
5. Confirm this generation's successful schema task before deploying the matching app/worker release and running the verifier. If the outcome is uncertain, verify it with read-only queries; do not blindly retry.

The target/fingerprint binding scopes a confirmation to one database and one schema. Dokploy persists Application env values, so cleanup is an explicit operation; this template does not pretend they are ephemeral platform secrets.

**Fallback:** omit the applier, set `APPLY_SCHEMA=safe`/`WAIT_FOR_SCHEMA=false` on the app, and `APPLY_SCHEMA=off`/`WAIT_FOR_SCHEMA=true` on any dedicated worker. The same startup, timeout, backup, confirmation, and recovery rules apply. `WORKER_MODE=embedded` retains background features when no worker is selected.

A refused `safe` plan does not change the database. The new app/worker revisions cannot start against that refused schema. Keep expand-contract: already running old revisions are not continuously gated and must tolerate the next approved schema.

---

## 13. First admin user

1. Open `https://yourdomain.com` and sign up with an email address listed in `ADMIN_EMAILS`.
2. Check your inbox for the verification email and click the link.
3. Once verified, admin-gated procedures are unlocked for your account.

If you don't receive the verification email, check the SMTP configuration and server logs. See [production-hardening.md](./production-hardening.md) for details on admin gating and email verification.

---

## 14. Troubleshooting

### Build OOMs

The Dockerfile runs `pnpm turbo build`, which compiles TypeScript across the monorepo. On a VPS with less than 4 GB RAM the build may be killed by the OOM killer.

- **Fix**: Increase swap (`fallocate -l 4G /swapfile && mkswap /swapfile && swapon /swapfile`) or use a VPS with 8 GB RAM.
- Dokploy shows build logs in the deployment detail view — look for `Killed` or exit code `137`.

### Let's Encrypt rate limits

Let's Encrypt enforces [rate limits](https://letsencrypt.org/docs/rate-limits/) — 5 duplicate certificates per week for the same domain. If you hit the limit:

- Wait for the rate limit window to reset (1 week).
- Make sure DNS is correctly pointed *before* enabling Let's Encrypt.

### Postgres hostname mismatch

If the server can't connect to Postgres, make sure `DATABASE_URL` uses the **internal Docker hostname** shown in Dokploy's database overview — not `localhost`, not the VPS public IP.

### Worker not picking up jobs

- Confirm `REDIS_URL` is identical for both server and worker.
- Check worker logs for connection errors.
- Verify a dedicated worker uses `Dockerfile.worker`, the server uses `WORKER_MODE=external`, and its schema startup gate passed. Without a dedicated worker use `WORKER_MODE=embedded` on the server. `/ready` must report background-runtime availability.

---

## Docker Compose alternative

`pnpm dokploy:config` generates the Compose stack — `docker-compose.dokploy.yml`, the file [§ 3](#3-create-the-project) imports in Dokploy Compose mode. It carries the blessed topology (server with embedded jobs, one-shot `schema-apply` leader, `postgres:17`, `redis:7` with `noeviction`), the Traefik routing/TLS/**compression** labels, the swarm update/rollback/stop-grace policy, loopback-free networking (no host ports on Postgres/Redis), and `${VAR:-}` interpolation so Dokploy per-service env (or a `.env` file) fills the values — secrets carry **no defaults**. The hand-written example that used to live here was removed: the generated file is the reviewed copy, and two copies drift (and have).

This section is the runbook for running that same generated file outside Dokploy — on any Docker host with plain `docker compose` — plus the two things to change when Dokploy is not in front.

> **Not on Dokploy? Two edits before exposing it to the internet.** The generated file assumes Dokploy: its Traefik labels target the `dokploy-network` external network and the `websecure`/`letsencrypt` resolver Dokploy ships. On a bare host:
> - Remove the `dokploy` external network and the `server` `networks:` block, and put your own proxy in front: **Caddy** — `caddy reverse-proxy --from yourdomain.com --to localhost:3000` (automatic Let's Encrypt, zero config); **Traefik** — add a Traefik service and keep the label block already on `server`; or **Nginx** — nginx + certbot (`certbot --nginx -d yourdomain.com`).
> - If you keep the Traefik labels, map the server port through the proxy instead; the compose deliberately publishes no host ports.

Deploy from one clean, immutable checkout. Build every release image before running the schema gate, then use `--no-build` for rollout so a later branch update cannot change the app artifacts between those steps:

```bash
test -z "$(git status --porcelain)" || { echo "Working tree must be clean" >&2; exit 1; }
export TARGET_SHA=$(git rev-parse --verify HEAD)
docker compose -f docker-compose.dokploy.yml build --pull server schema-apply

# Run for each release, including an unchanged schema, to refresh its receipt
# (schema-apply already carries APPLY_SCHEMA=safe):
docker compose -f docker-compose.dokploy.yml run --rm schema-apply

# Run only after the schema command exits 0 and logs `Schema sync complete.`:
docker compose -f docker-compose.dokploy.yml up -d --no-build server
```

Record `TARGET_SHA` in the deployment log and pass it as `BUILD_VERSION` (the file wires the build arg) so rebuilds of one commit keep a stable PWA version. For a destructive change, replace the single safe run with the two-step confirmation flow from [§ 12](#12-first-deploy); both runs and the final `up` must use this already-built checkout.

> **Backups come from the `db-backup` service** — the compose equivalent of § 11's schedule service, shipped commented out in the generated file. Uncomment it, fill the `BACKUP_S3_*` dump-writer values, and include it in the `build`/`up` commands above. It uploads `pg_dump -Fc` dumps to your `BACKUP_S3_BUCKET`; without those env vars set there is no off-site copy and you will lose data. Run a restore drill before relying on it ([backup-and-restore.md § Restore drill](./backup-and-restore.md#restore-drill)). An external cron invoking `docker run … backup` against the db-applier image is the documented alternative; a bare `scripts/backup.sh` crontab on the host works too but keeps dumps on the box unless `BACKUP_S3_*` is exported.
---

## Persistent volumes and file ownership

The shipped images drop privileges to the non-root `node` user (uid 1000) before the CMD runs, and neither one writes to disk — the server reads `/app`, and everything else goes to `/tmp` or over the network to Postgres, Redis, and S3. If you add a feature that needs a **persistent volume** (uploaded files kept on the box, a SQLite side-database, a generated-artifact cache), the mount point's ownership is the thing that bites.

A fresh Docker **named volume** inherits its mount point's ownership from the image — but only if that directory **already exists in the image**. Mount onto a path the image never created and Docker creates it for you, root-owned, and the container dies as `USER node` with:

```
EACCES: permission denied, mkdir '/app/data/uploads'
```

So the `mkdir` and `chown` must come **before** the `VOLUME` declaration and before `USER`:

```dockerfile
# Create and chown the mount point BEFORE VOLUME and before dropping privileges,
# so the fresh named volume inherits node:node instead of being created root-owned.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
```

Three things to keep in mind:

- **Bind mounts never inherit at all.** A host directory keeps its host ownership regardless of what the image did, so a host bind needs `chown 1000:1000 /opt/my-app/data` on the host side. Named volumes are the easier path on a single VPS; use a bind only when you specifically want the files browsable outside Docker.
- **Only an empty volume inherits.** The copy-on-first-use behaviour runs once. Fixing ownership after the volume already has content means `docker run --rm -u 0 -v my-app-data:/data alpine chown -R 1000:1000 /data`, not a rebuild.
- **Both images or neither.** If the server and the worker share a volume, the `mkdir`/`chown`/`VOLUME` block belongs in `Dockerfile` *and* `Dockerfile.worker`, with the same path and the same owner — see [AGENTS.md § Dockerfiles — keep server and worker in sync](../AGENTS.md#dockerfiles--keep-server-and-worker-in-sync).

---

## Prisma CLI and psql in the images

Both runtime images ship the Prisma CLI and `postgresql-client` by default. The designated leader delegates to `scripts/apply-schema.mjs`: one Node PostgreSQL session owns the advisory lock and applies the confirmed SQL, schema receipt, and completed operation in one transaction. The same path runs in the preferred db-applier Application. Followers carry `APPLY_SCHEMA=off` and `WAIT_FOR_SCHEMA=true`; their separate read-only gate uses psql and Prisma before starting the runtime command.

The tradeoff is image size: runtime images retain Prisma and PostgreSQL clients for follower admission, app-entrypoint apply, and backup preparation. On Dokploy the applier is the preferred leader and the app is the fallback; the worker always remains a follower. Do not strip these tools merely because a runtime never applies schema.

Keep these tools in followers too: `WAIT_FOR_SCHEMA` requires psql and Prisma for its read-only admission check — a separate applier image does not make a stripped follower viable.

---

## Restart policy and graceful shutdown

Both the server and worker processes handle `SIGTERM` and `SIGINT` for graceful shutdown:

- **Server**: withdraws readiness, waits five seconds for proxy routing to settle, then stops accepting requests and waits up to ten seconds for HTTP to close. This HTTP drain is best-effort and runs alongside embedded consumer shutdown. Shared Prisma/Redis clients disconnect after the HTTP wait finishes and the job drain succeeds; a failed or timed-out job drain exits without disconnecting shared clients underneath active handlers.
- **Dedicated worker**: withdraws readiness and its heartbeat, drains consumers, then closes shared dependencies. A failed or timed-out drain exits without disconnecting shared clients underneath active handlers.

Both processes retry initial dependency connectivity with bounded backoff. Consumer startup and shutdown budgets are owned by `apps/worker/src/runtime-lifecycle.ts`; host watchdogs enforce process exit when shutdown cannot finish.

For long-running app, worker, and backup-scheduler services, configure automatic restart (`restart: unless-stopped` in Compose; the Swarm restart policy in Dokploy). The one-shot schema-apply Application must use restart condition `none` so successful completion stays terminal.

The Compose example applies automatic restart only to its long-running services. In Dokploy use **Advanced → Swarm Settings → Restart Policy**; use the selected role's settings from `pnpm dokploy:config`.

---

## Branch protection

Protect your default branch (`main` or `master`) so broken code and force-pushes cannot reach production:

1. **GitHub → Settings → Branches → Add branch protection rule** for `main`.
2. Enable:
   - **Require a pull request before merging** (at least 1 approval for teams; solo devs can set 0 but still benefit from CI gating).
   - **Require status checks to pass before merging** — select the `pr-checks` workflow jobs (`lint`, `check-types`, `build`, `test`, `policy`).
   - **Do not allow force pushes**.
   - **Do not allow deletions**.
3. Optional but recommended:
   - **Require linear history** (squash or rebase merges only) — keeps `git log` clean.
   - **Require signed commits** if your team uses GPG/SSH signing.

These settings are free on public repos and available on GitHub Team/Enterprise for private repos.

---

## Rollback Procedure

Things will eventually go wrong — a bad deploy, a migration that breaks the schema, a feature flag flipped at the wrong moment. A rehearsed rollback path is the difference between five minutes of downtime and five hours.

### 1. Redeploy the previous image (fastest)

Select the previous reviewed immutable Git release tag on the server and worker, rebuild, and verify the new selected tasks. Do this only when the current database and queue contracts remain compatible with that code. The schema gate deliberately refuses an old schema fingerprint after a newer schema was applied; reapply a reviewed compatible target using the canonical leader or roll forward with a correction. Never disable the gate to force an old release to boot, and never automatically restore the database because an app revision failed.

The fingerprint rule is stricter than code compatibility: even an additive schema change that old code can tolerate prevents a newly started old image from passing the gate. Existing old processes can keep serving, but restarting them or Swarm's automatic image rollback cannot guarantee recovery after the receipt advances. Prefer a correction released against the current schema; changing the schema target again requires a reviewed canonical apply, including destructive-change confirmation where applicable.

### 2. Bad schema change — roll forward with a counter-change

There is no migration history, so there is nothing to "roll back" at the schema level in the `migrate deploy` sense. The fix path is always **roll forward**:

1. Revert the schema change on `main` (or author a follow-up schema edit that corrects the problem).
2. `pnpm db:push` (or `pnpm db:push:dangerous` if the corrective change is itself destructive) against your local DB to verify the intended diff.
3. Commit.
4. Run the schema-apply job with `APPLY_SCHEMA=safe` (or `dangerous` with the two-step confirm) to bring production's schema back in sync with the corrected `.prisma` file, then deploy the app Applications.

For destructive mistakes (you dropped a column you shouldn't have), you cannot undo the data loss — restore from backup (step 3 below). This is the main risk the expand-contract pattern exists to prevent; see [patterns/schema-changes-recipe.md](./schema-changes-recipe.md) before you ever use `APPLY_SCHEMA=dangerous`.

### 3. Restore from a backup

If a migration or a buggy write corrupted data and you need to roll the database itself back, the supported path is a **one-shot db-applier `restore` job** — the same shape as the `schema-apply` Application but with mode `restore`. Never pipe a dump into `psql`: the dumps are `pg_dump -Fc` custom format (restore with `pg_restore`, which the job runs for you), and the job adds the guards a manual restore skips (advisory lock, target snapshot, connection checks).

Follow the canonical [logical restore recipe](./backup-and-restore.md#restoring-a-logical-dump), then its complete [replacement database recovery handoff](./backup-and-restore.md#replacement-database-recovery-handoff). That handoff covers all four topologies in § 10: validate the data without launching app jobs/email, stop original writers during maintenance, move **every** database consumer, run the selected release's ordinary schema leader, then admit followers and verify runtime/data/backups. `Restore complete.` publishes no schema receipt. An `off`/`WAIT_FOR_SCHEMA=true` follower cannot start until its leader establishes one against the replacement.

Include `schema-apply`, `db-backup`, the embedded or dedicated freshness monitor, provider backup bindings, and external monitoring in the cutover. Updating `environment.DATABASE_URL` alone does not change already-running containers; redeploy every affected Application/job with its new configuration. Verify a newly uploaded, restorable backup under the replacement's target namespace and its recurring schedule/alerts before declaring recovery complete. Keep the original database intact; the canonical recipe explains why returning to it after replacement writes needs reconciliation. An uncertain restore still requires [outcome verification](./backup-and-restore.md#when-an-apply-or-restore-outcome-is-uncertain) before a new confirmed attempt.

Full drill recipe (into a throwaway database — never production): [backup-and-restore.md § Restore drill](./backup-and-restore.md#restore-drill).

### 4. Nuclear option — reset the database

Database reset is not a production recovery procedure. Use the guarded restore flow above. Disposable local-development resets follow the exact dev-stack procedure in [AGENTS.md](../AGENTS.md); ordinary stop/start commands do not imply a volume reset.

---

## Monitoring and Alerts

A healthcheck endpoint that nobody is watching is the same as no healthcheck. Before you go live, wire up at least one notification channel and one external uptime monitor.

### Dokploy built-in notifications

Dokploy can fire webhooks on deploy events out of the box:

1. **Settings → Notifications** in the Dokploy dashboard.
2. Add a channel — email, Discord, Slack, or generic webhook.
3. Subscribe to **Deploy Success** and **Deploy Failure** at minimum. Subscribe to **Database Backup** events if you're using Dokploy's managed backups.

These notifications cover build/service-update submission, not runtime health or apply-task completion. Run the verifier in § 10 for deployment acceptance. External readiness and missed-backup monitors cover later failures, including loss of the entire VPS.

### External uptime monitoring

Point an external monitor at `https://yourdomain.com/ready` for dependency-aware alerts, and at `https://yourdomain.com/health` for process liveness. `/ready` requires Postgres, Redis, and the selected embedded or external background runtime to be available; `/health` reports process liveness.

- **[UptimeRobot](https://uptimerobot.com/)** — free tier gives 50 monitors at 5-minute intervals, email/Slack/Discord alerts. Good default.
- **[Hetrix Tools](https://hetrixtools.com/)** — similar free tier, includes blacklist monitoring as a bonus.

Configure both on a single endpoint for redundancy — monitoring providers themselves have outages.

### Suggested alert thresholds

| Signal | Threshold | Why |
|---|---|---|
| Uptime (rolling 30 days) | alert if below **99%** | 99% = ~7h of downtime per month. Below this is user-visible pain. |
| Health check failures | alert after **2 consecutive** failures | Single-shot failures are usually a network blip. Two in a row is real. |
| Deploy failure | alert **immediately** | Know before the next push layers a second failure on top. |
| Response time (`/ready`) | alert if p95 > **2s** | `/ready` pings Postgres and Redis; over a second means a dependency or Node is struggling. |

---

## Other deployment targets

- **Docker Swarm**: Use the same `docker-compose.yml` with `docker stack deploy`. See the [Docker Swarm docs](https://docs.docker.com/engine/swarm/).
- **Kubernetes**: Translate the Dockerfile into a Deployment + Service manifest. Run schema sync as a one-shot `Job` from the `Dockerfile.db-applier` image with `command: ["apply"]` and `APPLY_SCHEMA=safe`/`dangerous`, then roll out the Deployment with `APPLY_SCHEMA=off`. See the [Kubernetes docs](https://kubernetes.io/docs/home/).
</content>
