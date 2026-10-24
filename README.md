<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/header/graph.svg?title=starter&subtitle=Full-stack%20TypeScript%20PWA%20template%20%E2%80%94%20built%20for%20AI-agent%20development&logo=react&mode=dark" />
    <img alt="starter — full-stack TypeScript PWA template, built for AI-agent development" src="https://shieldcn.dev/header/graph.svg?title=starter&subtitle=Full-stack%20TypeScript%20PWA%20template%20%E2%80%94%20built%20for%20AI-agent%20development&logo=react&mode=light" />
  </picture>
</p>

<p align="center">
  <a href="https://react.dev"><img alt="React 19" src="https://shieldcn.dev/badge/React-19-087EA4.svg?logo=react" /></a>
  <a href="https://tanstack.com"><img alt="TanStack Router and Query" src="https://shieldcn.dev/badge/TanStack-Router%20%C2%B7%20Query-FF4154.svg?logo=tanstack" /></a>
  <a href="https://hono.dev"><img alt="Hono with oRPC" src="https://shieldcn.dev/badge/Hono-oRPC-E36002.svg?logo=hono" /></a>
  <a href="https://www.prisma.io"><img alt="Prisma and PostgreSQL" src="https://shieldcn.dev/badge/Prisma-PostgreSQL-2D3748.svg?logo=prisma" /></a>
  <a href="https://www.better-auth.com"><img alt="Better-Auth with 2FA and SSO" src="https://shieldcn.dev/badge/Better--Auth-2FA%20%C2%B7%20SSO-0F172A.svg?logo=betterauth" /></a>
  <a href="https://tailwindcss.com"><img alt="Tailwind CSS v4" src="https://shieldcn.dev/badge/Tailwind%20CSS-v4-06B6D4.svg?logo=tailwindcss" /></a>
</p>

<p align="center">
  <a href="#getting-started"><b>Getting started</b></a> ·
  <a href="./patterns/README.md"><b>Patterns playbook</b></a> ·
  <a href="./AGENTS.md"><b>Agent rules</b></a> ·
  <a href="#deploying-to-production"><b>Deploy</b></a>
</p>

A production-ready, full-stack TypeScript template — React, TanStack Router, Hono, oRPC, Prisma, and Better-Auth in a Turborepo monorepo — **designed to be built on with AI coding agents**. The `patterns/` playbook, agent safety rules, and getting-started onboarding flow are written *for* the agent: they are the guardrails that keep agent-driven development consistent instead of drifting.

## Features

**Core stack**

- **TypeScript everywhere** — end-to-end type safety from Prisma schema to React components
- **React 19 + TanStack Router** — file-based routing, SPA by default with per-route SSR opt-in
- **Hono + oRPC** — lightweight API server with end-to-end type-safe procedures and OpenAPI integration
- **Prisma + PostgreSQL** — TypeScript-first ORM with a push-based schema workflow
- **Better-Auth** — email verification, 2FA, SSO, admin roles, signup gating
- **BullMQ + Redis** — background jobs embedded in the app by default, with an optional dedicated worker
- **Tailwind CSS v4 + shadcn/ui** — shared component package with theming presets
- **Turborepo + pnpm catalog** — one pinned version of every shared dependency

**Product surface**

- **Accounts and admin** — email verification, password reset, 2FA, SSO, a role-scoped force-2FA policy (required for admins by default, with a 24-hour enrollment grace window), and a 404-hidden admin area for users, jobs, settings, and seeding
- **i18n with AI translation** — locale-prefixed routing, localized Zod errors, and `pnpm i18n:translate` to fill missing keys in the JSON locale bundles via an LLM
- **Landing-page copy lives in the i18n bundles** — the home page reads `home.*` from `packages/locales/src/<lang>/common.json`. That is the deliberate replacement for a CMS: one place to edit, translated by the same script as the rest of the UI, no content database to operate. A typed CMS (pages + posts) and an HLS video pipeline are add-ins, restored only when the product needs them — [patterns/add-ins/cms.md](./patterns/add-ins/cms.md), [patterns/add-ins/video.md](./patterns/add-ins/video.md).
- **Asset pipeline** — S3-compatible storage (opt-in via `S3_BUCKET`), sharp image transforms, blurhash placeholders, orphan cleanup
- **Agentic chat** — a durable, resumable streaming chat surface with its own rate budgets (opt-in via `CHAT_ENABLED` + an LLM key)
- **BullMQ worker** — background jobs embedded in the app by default, or split into a dedicated worker container
- **Email** — transactional mail over SMTP, with a local mail sink for development
- **PWA** — offline fallback, install prompts, web push, native-feel navigation
- **Expo mobile app** — native iOS/Android starter (`apps/native`) wired to the same Better-Auth and oRPC backend. Removable, and removing it is the right default for a first app.
- **Companion Rust CLI** — production-minded clap starter (`apps/cli`) with its own CI and cargo-dist release pipeline (shell/PowerShell/Homebrew installers). Also removable by default.

**Built for AI-agent development**

- **`patterns/` playbook** — 40+ copy-pasteable recipes (data fetching, forms, overlays, schema changes, deployment) the agent reads before each task
- **Agent safety rules** — hard "never do this" rails for auth, schema, secrets, and destructive commands
- **Getting-started onboarding** — a guided phase where the agent pins down product definition, roles, and hosting before feature work
- **Removable feature modules and add-ins** — rip-out guides for the Expo app, the Rust CLI, i18n, the queue/worker, email, web push, the PWA layer, and the admin seed trigger; add-in recipes for agentic chat (ships off), an admin MCP server, a typed CMS, and HLS video
- **Agent UI testing** — a disposable docker-compose stack with a mail sink so agents can drive real signup/2FA flows headlessly
- **Deploy recipe** — a step-by-step Dokploy-on-a-VPS guide, the single documented deployment target, with backups and restore drills to match

## Getting Started

### Prerequisites

- Node.js 24.11+ or 26+; Node 24 LTS recommended (the production Docker images build on `node:24-slim`)
- Corepack enabled; this repo pins pnpm 11.28.3 in `packageManager`
- Docker or Podman — required for local PostgreSQL, Redis, and the mailpit mail sink
- `portless` installed globally (`npm install -g portless`) — `pnpm dev` uses it to expose local apps at stable `https://*.localhost` names without choosing ports
- PostgreSQL, Redis, and local email — all three start with `pnpm dev:services` (uses `docker-compose.dev.yml` at repo root via docker or podman); the mailpit sink captures verification email locally so signup works with zero SMTP credentials

If pnpm fails with a path like `mkdir '/Users'` on Linux/WSL, your shell has a stale macOS `PNPM_HOME`. Run `unset PNPM_HOME`, remove the stale export from your shell profile, and rerun `pnpm install`. The full check is in [patterns/getting-started.md](./patterns/getting-started.md#03-pnpm-via-corepack).

### Quickstart

First, get the code into a git repository, then ask your AI coding agent to get started. The agent should read `AGENTS.md`, run the getting-started phase in `patterns/getting-started.md`, and generate the app-specific `notes/` files before feature work begins.

Start with the app name, intended users, first useful feature, and hosting choice. Onboarding records future endpoints as planned, applies display branding, and defers optional native/CLI clients unless you need them now. Internal package/database renames and source removal are explicit later choices; the agent can preview native/CLI removal with `pnpm template:remove`.

If you received this template as an archive (zip) download, initialize git **before** installing — `pnpm install` sets up git hooks (lefthook) and fails without a `.git` directory:

```bash
cd <your-unzipped-directory>
git init
git add -A
git commit -m "Initial commit from template"
corepack enable
pnpm install
pnpm run setup
pnpm dev
```

If you already pushed the template to your own git host, clone instead of `git init`:

```bash
git clone <your-repo-url>
cd <your-repo-directory>
corepack enable
pnpm install
pnpm run setup
pnpm dev
```

`pnpm run setup` is the one-command path from a fresh clone to runnable, and is idempotent (re-run any time without harm). Use the explicit `run` form — `setup` is also a pnpm builtin, and on some pnpm versions the bare `pnpm setup` invokes the builtin (which edits your shell profile) instead of this script. It:

- creates the root `.env` from `.env.example` if missing,
- creates `apps/web/.env` from `apps/web/.env.example` if missing,
- creates `apps/native/.env` from `apps/native/.env.example` if missing,
- generates a `BETTER_AUTH_SECRET` if it is empty,
- asks for your email and writes it to `ADMIN_EMAILS` in `.env` (if not already set), so your first local sign-up becomes the admin — non-interactive shells can pass `--admin-email <you@example.com>` or set `ADMIN_EMAIL`,
- points `SMTP_*` at the local mailpit sink (if `SMTP_HOST` is unset), so the signup verification email has somewhere to land,
- starts local PostgreSQL, Redis, **and** the mailpit sink (`pnpm dev:services`),
- waits for all three to accept connections,
- applies the Prisma schema (`pnpm db:push`).

If something looks wrong, run `pnpm doctor` to validate environment, database, Redis, and (optionally) SMTP connectivity. It exits non-zero with actionable hints if any required check fails.

Run the test suite with `pnpm test`.

### First login: create your admin account

Signup is disabled by default (`SIGNUP_ENABLED=false`) and no admin user exists yet, but `pnpm run setup` already did the two things first login needs: it wrote your email to `ADMIN_EMAILS` (the signup allowlist) and pointed `SMTP_*` at the mailpit sink. So with `pnpm dev` running:

1. Open [https://starter.localhost](https://starter.localhost) and sign up with the exact email from `ADMIN_EMAILS` — that address is the only one signup accepts, and the account it creates carries the admin role.
2. Open [http://localhost:8025](http://localhost:8025) (the mailpit sink), find the "Verify your email" message, and click the link. You're in — email verification is enforced, so this step can't be skipped.

If you skipped the setup email prompt, stop `pnpm dev`, set `ADMIN_EMAILS=you@example.com` in `.env`, and restart. If you pointed `SMTP_*` at a real provider instead of the sink, the verification email lands there.

In production the mail sink is replaced by a real SMTP provider; see the [Deploying to Production](#deploying-to-production) checklist below. Your AI agent can walk you through this — it's also covered in the getting-started phase it runs first.

The sections below describe each manual setup step in detail in case you want to do it by hand.

### 1. Install dependencies

```bash
pnpm install
```

### 2. Set up environment variables

All server-side environment variables live in a single `.env` file **at the repo root**. Copy the template and edit it:

```bash
cp .env.example .env
```

The web app has its own small env file for Vite-public variables:

```bash
cp apps/web/.env.example apps/web/.env
```

The Expo app has its own public API URL:

```bash
cp apps/native/.env.example apps/native/.env
```

#### Server (`.env` at repo root)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | **Yes** | — | Auth secret, min 32 characters |
| `BETTER_AUTH_URL` | **Yes** | — | Public app origin used by auth callbacks (default local dev: `https://starter.localhost`). Do not include a path, query, hash, or credentials. |
| `CORS_ORIGIN` | No | — | Exact browser origin allowed to call the API directly. Do not include a path, query, hash, or credentials. |
| `SERVER_PORT` | No | `3000` | Raw local/container API listen override. Leave unset with portless. |
| `PORT` | No | — | Injected by portless and production platforms; used when `SERVER_PORT` is unset |
| `NODE_ENV` | No | `development` | `development`, `production`, or `test` |
| `SSO_ENABLED` | No | `false` | Enable enterprise SSO login |
| `SSO_CLIENT_ID` | No | — | SSO OAuth client ID |
| `SSO_CLIENT_SECRET` | No | — | SSO OAuth client secret |
| `SSO_ISSUER` | No | — | SSO issuer URL (e.g. `https://your-org.okta.com`) |
| `SSO_PROVIDER_NAME` | No | `SSO` | Display name for the SSO provider |
| `FORCE_SSO` | No | `false` | Redirect all logins through SSO |
| `VAPID_PUBLIC_KEY` | No | — | Web Push public key |
| `VAPID_PRIVATE_KEY` | No | — | Web Push private key |
| `VAPID_SUBJECT` | With push | — | Web Push contact URI (`mailto:` or `https:`); required alongside the VAPID keys |

#### Web (`apps/web/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_SERVER_URL` | No | `window.location.origin` | Server API origin; leave unset for the default portless/Vite proxy flow. Do not include a path, query, hash, or credentials. |
| `VITE_DEV_PORT` | No | `3001` | Raw Vite dev-server listen port. Leave unset with portless. |
| `VITE_DEV_SERVER_URL` | No | `http://localhost:3000` or the `apps/server` hostname from `portless.json` under portless | API origin for the Vite dev proxy. Do not include a path, query, hash, or credentials. |
| `VITE_APP_NAME` | No | `App` | App-shell name used in the header, document title, and PWA manifest. Inlined at build time — changing it needs a rebuild, not a restart. |

#### Native (`apps/native/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `EXPO_PUBLIC_SERVER_URL` | **Yes** | — | API server origin reachable from the simulator, emulator, or physical device. Do not include a path, query, or hash. Use `http://localhost:3000` for iOS simulator/raw local dev, `http://10.0.2.2:3000` for Android emulator/raw local dev, or a LAN/tunnel origin for physical devices. |

Environment variables are validated at startup by `packages/env` using [t3-env](https://env.t3.gg/) and Zod. The app will fail to start if required variables are missing or malformed.

### 3. Set up the database

Start PostgreSQL and Redis with docker or podman:

```bash
pnpm dev:services
```

Then apply the schema to your local database:

```bash
pnpm db:push
```

> **Adding or changing a model?** Don't edit the database directly. Edit the relevant file in `packages/db/prisma/schema/` (`auth.prisma`, `assets.prisma`, `chat.prisma`). `schema.prisma` holds the datasource and generator blocks. Then run `pnpm db:push` to apply it. See [patterns/schema-changes-recipe.md](./patterns/schema-changes-recipe.md) for the full workflow, including the required expand-contract pattern for destructive changes.

### 4. Run the development server

```bash
pnpm run dev
```

- Web app: [https://starter.localhost](https://starter.localhost)
- API server: [https://api.starter.localhost](https://api.starter.localhost)

`pnpm dev` runs through the globally installed `portless` CLI. Portless assigns process ports automatically, registers the local HTTPS hostnames from `portless.json`, and lets Vite proxy `/api`, `/rpc`, `/sw`, and `/ws` to the API server. Leave `VITE_SERVER_URL`, `VITE_DEV_PORT`, `VITE_DEV_SERVER_URL`, `SERVER_PORT`, and `CORS_ORIGIN` unset unless you intentionally want the raw fallback flow.

#### Running multiple apps on one machine

Start the shared Postgres + Redis stack once with `pnpm dev:services`, then give each app clone its own database, Redis logical DB, and local subdomain slug.

Root `.env` for a second app:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/my_second_app
REDIS_URL=redis://localhost:6379/4
BETTER_AUTH_URL=https://my-second-app.localhost
```

`portless.json` for that app:

```json
{
  "script": "dev:raw",
  "apps": {
    "apps/web": { "name": "my-second-app" },
    "apps/server": { "name": "api.my-second-app" }
  }
}
```

Then run `EXPECTED_DB=<db-name> pnpm db:push` once for that app — the local-database guard refuses a non-default database name unless it is announced via `EXPECTED_DB` — and start it with `pnpm dev`. If you cannot use portless, `pnpm dev:raw` keeps the old Turbo flow and you can set `SERVER_PORT`, `VITE_DEV_PORT`, and `VITE_DEV_SERVER_URL` manually.

### 5. Run the mobile app

The native app lives in `apps/native` and uses Expo Router, Better-Auth's Expo client, and the same `@starter/api` oRPC router as the web app.

For the simplest simulator setup, run the API on its raw local port and point Expo at the API origin:

```bash
# root .env
SERVER_PORT=3000

# apps/native/.env for iOS simulator
EXPO_PUBLIC_SERVER_URL=http://localhost:3000

# apps/native/.env for Android emulator
EXPO_PUBLIC_SERVER_URL=http://10.0.2.2:3000
```

Then start the backend and Expo app:

```bash
pnpm dev:server
pnpm dev:native
```

`pnpm dev:native` runs `pnpm doctor:native` first. It fails if `apps/native/.env` is missing, `EXPO_PUBLIC_SERVER_URL` is invalid or includes a path/query/hash, or generated `apps/native/ios` / `apps/native/android` directories exist. The template stays managed Expo by default; only introduce generated native projects when you intentionally move to a prebuild/bare workflow.

Use `pnpm native:ios`, `pnpm native:android`, or `pnpm native:web` when you want Expo to open a specific managed target. Physical devices need `EXPO_PUBLIC_SERVER_URL` to be an origin the device can reach, such as your machine's LAN IP or a tunnel. Expo web runs in a browser on its own origin, so raw local Expo web also needs the root `.env` `CORS_ORIGIN` set to the exact Expo web origin printed by the CLI. See [patterns/native.md](./patterns/native.md) before changing native auth, env, Metro, or Expo SDK dependencies.

### Optional: Generate VAPID keys for Web Push

```bash
pnpm run generate:vapid
```

Add the output to `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in your root `.env`, and set `VAPID_SUBJECT` to a contact URI (`mailto:you@example.com` or an `https:` URL).

## Production (Docker)

The repo ships three Dockerfiles:

- `Dockerfile` — Hono API + SSR bundle + static web SPA + embedded background consumers by default.
- `Dockerfile.worker` — optional dedicated BullMQ consumers, with a private loopback health endpoint.
- `Dockerfile.db-applier` — one-shot schema `apply` / backup / restore / recover / status jobs. No app server.

Dokploy builds Applications directly from Git, or deploys the Compose file `pnpm dokploy:config` generates (the blessed app + applier topology with Postgres and Redis). Development can follow `main`/`master` automatically; production manually selects the same immutable release tag for each Application. The advanced shapes — app, app + worker, or all three — stay available through the same generator's settings checklist. Postgres and Redis remain required in every configuration.

Exactly one leader uses `APPLY_SCHEMA=safe` for ordinary deployments: preferably the applier, otherwise the app entrypoint. Followers use `WAIT_FOR_SCHEMA=true` and start only after a matching receipt, no active operation, and an empty live diff. Every path uses the same guarded schema runner. `pnpm dokploy:verify` checks the selected tasks and runtime readiness after the Git builds finish.

Without a worker container, the app runs the same background jobs using `WORKER_MODE=embedded`. A dedicated worker requires `WORKER_MODE=external` on the app; readiness checks its heartbeat. Omitting the worker container never removes jobs — it only moves them. See [infra-notes.md](./infra-notes.md), [patterns/schema-push.md](./patterns/schema-push.md), and the default [Dokploy walkthrough](./patterns/deployment-vps.md).

### Build

```bash
docker build -t starter-server -f Dockerfile .
docker build -t starter-worker -f Dockerfile.worker .
```

### Run

```bash
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/starter" \
  -e REDIS_URL="redis://host:6379" \
  -e BETTER_AUTH_SECRET="your-secret-min-32-chars" \
  -e BETTER_AUTH_URL="https://your-domain.com" \
  -e APPLY_SCHEMA=safe \
  -e WORKER_MODE=external \
  starter-server

docker run \
  -e DATABASE_URL="postgresql://user:pass@host:5432/starter" \
  -e REDIS_URL="redis://host:6379" \
  -e WAIT_FOR_SCHEMA=true \
  starter-worker
```

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | **Yes** (both images) | PostgreSQL connection string |
| `REDIS_URL` | **Yes** (both images) | Redis connection string for BullMQ + rate limiting |
| `BETTER_AUTH_SECRET` | **Yes** (server only) | Auth secret, min 32 characters. Required by the server runtime and by the entrypoint when the server command starts; worker and schema-sync job command paths do not require it. |
| `BETTER_AUTH_URL` | **Yes** (server only) | Public URL of the deployed app. The worker validates only `@starter/env/shared` and does not require it. |
| `WORKER_MODE` | No (server only) | Defaults to `embedded`. Select `external` only when deploying the dedicated worker, as in the example above. |
| `APPLY_SCHEMA` / `WAIT_FOR_SCHEMA` | Per topology | Exactly one leader applies; followers wait for its matching schema receipt. Use the generated Dokploy mappings. |
| All other server vars | No | SSO, VAPID, SMTP, etc. — server image only; same as the server table above. The worker image needs only the shared set (DB, Redis, plus `S3_*`, the LLM key, and `SMTP_*` if the jobs it runs need them). |

In production, `CORS_ORIGIN` is typically not needed since the server serves the web app on the same origin.

## Deploying to Production

Before your first production deploy, read these two docs in order:

1. [patterns/production-hardening.md](./patterns/production-hardening.md) — security hardening checklist (admin gating, email verification, rate limiting, CSRF)
2. [patterns/deployment-vps.md](./patterns/deployment-vps.md) — step-by-step Dokploy-on-a-VPS deployment guide (the default, and the only deployment target documented in this template).

Then walk through the pre-flight checklist below.

### Required environment variables

The `Scope` column reflects the env-package split: the worker validates only the
worker-safe surface (`@starter/env/shared`), so a worker-only deployment does
**not** need the `server` vars below. The container entrypoint hard-checks
`DATABASE_URL` and `REDIS_URL` in both images, and adds `BETTER_AUTH_SECRET`
only when the server command is starting. See [infra-notes.md](./infra-notes.md)
for the full split.

| Variable | Scope | Why |
|---|---|---|
| `DATABASE_URL` | server + worker | PostgreSQL connection string for the production database |
| `REDIS_URL` | server + worker | Redis connection string for BullMQ and rate limiting |
| `BETTER_AUTH_SECRET` | server | Auth signing secret — min 32 random characters, unique per environment |
| `BETTER_AUTH_URL` | server | Public URL of the deployed app (e.g. `https://app.example.com`). Not validated/required by the worker. |
| `ADMIN_EMAILS` | server | Comma-separated list of email addresses that receive the `admin` role |
| `SMTP_HOST` | server | SMTP server hostname for transactional email |
| `SMTP_PORT` | server | SMTP server port (usually `587` for STARTTLS) |
| `SMTP_USER` | server | SMTP authentication username |
| `SMTP_PASS` | server | SMTP authentication password |
| `SMTP_FROM` | server | Default `From:` address (e.g. `"App Name <no-reply@example.com>"`) |
| `CORS_ORIGIN` | server | Set only if the web app runs on a different origin than the API; use the exact browser origin only |

### Quick sanity checks

- [ ] `ADMIN_EMAILS` is set — without it no user can reach admin routes
- [ ] SMTP credentials are valid — email verification is enabled in production
- [ ] `BETTER_AUTH_SECRET` is unique and not reused from another environment
- [ ] Exactly one schema leader completed the deployment; followers passed their schema gate. See [infra-notes.md](./infra-notes.md) for the `APPLY_SCHEMA` lifecycle.
- [ ] `/ready` reports database, Redis, and background consumer availability; `pnpm dokploy:verify` passes for the selected deployment

## Architecture & Documentation

Detailed pattern docs live in `patterns/` — each one is a self-contained recipe with copy-pasteable code for a single concern (data fetching, forms, overlays, auth, testing, etc.).

→ **[patterns/README.md](./patterns/README.md)** — full index with "I want to…" quick picks

`AGENTS.md` is the source of truth; `CLAUDE.md`, `.cursorrules`, and `.github/copilot-instructions.md` are machine-generated mirrors of it, regenerated by `pnpm sync:agent-docs` — never hand-edit them. See [patterns/agent-instructions.md](./patterns/agent-instructions.md) for the workflow.

## UI Customization

React web apps in this stack share shadcn/ui primitives through `packages/ui`.

- Change design tokens and global styles in `packages/ui/src/styles/globals.css`
- Update shared primitives in `packages/ui/src/components/*`
- Adjust shadcn aliases or style config in `packages/ui/components.json` and `apps/web/components.json`

### Add more shared components

Run this from the project root to add more primitives to the shared UI package:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components like this:

```tsx
import { Button } from "@starter/ui/components/button";
```

### Add app-specific blocks

If you want to add app-specific blocks instead of shared primitives, run the shadcn CLI from `apps/web`.

## Project Structure

```
starter/
├── apps/
│   ├── web/         # Frontend application (React + TanStack Router)
│   ├── server/      # Backend API (Hono, oRPC)
│   ├── worker/      # Background job processor (BullMQ)
│   └── cli/         # Companion Rust CLI (cargo workspace, outside pnpm/turbo)
├── packages/
│   ├── ui/          # Shared shadcn/ui components and styles
│   ├── api/         # API layer / business logic
│   ├── auth/        # Authentication configuration & logic
│   ├── db/          # Database schema & queries
│   └── env/         # Environment variable validation (t3-env + Zod)
```

## Available Scripts

The shortlist — everything a normal session needs is in this first group; the rest are for specific workflows (deploying, theming, translations, policy tooling) and safe to ignore until a task names them:

- `pnpm run setup`: First-run onboarding — see Quickstart above (idempotent; creates `.env`, generates secret, starts Docker, pushes schema)
- `pnpm doctor`: Validate environment variables and test database, Redis, and SMTP connectivity
- `pnpm dev`: Start all applications through portless at `https://*.localhost`
- `pnpm dev:services`: Start Postgres, Redis, and the mailpit mail sink via Docker Compose
- `pnpm test`: Run the full test suite (Vitest, server-side unit tests)
- `pnpm check-types`: Check TypeScript types across all apps
- `pnpm db:push`: Apply the current schema to the local database
- `pnpm verify:fast`: Lint, policy checks, and affected typecheck/tests — run before handing work off

The full list:

- `pnpm dev:raw`: Start all applications with raw Turbo dev scripts, bypassing portless
- `pnpm build`: Build all applications
- `pnpm dev:web`: Start only the web application
- `pnpm dev:server`: Start only the server
- `pnpm db:generate`: Regenerate the Prisma client
- `pnpm db:studio`: Open Prisma Studio to browse the local database
- `pnpm generate:secrets`: Build a validated production env block (entropy + prompts; see [patterns/environment-variables.md](./patterns/environment-variables.md))
- `pnpm generate:secret`: Print a 32-byte random hex string (for `BETTER_AUTH_SECRET`)
- `pnpm generate:vapid`: Generate VAPID keys for Web Push (low-level; prefer `generate:secrets` for new deploys)
- `pnpm env:sync` / `pnpm env:check`: Regenerate / verify the `.env.example` files from the env manifest
- `cd apps/web && pnpm generate-pwa-assets`: Generate PWA assets

## License

This template is commercial software, governed by the Commercial Template License you agreed to at purchase (available where you bought the template). In short: build and ship unlimited End Products (commercial or open source), but don't republish or resell the template itself as a starter/boilerplate. Third-party open-source components keep their own licenses — the ones with attribution requirements are collected in [THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md). Your app carries its **own** license, not the template's — the rebrand task ([patterns/agent-tasks/rebrand.md](./patterns/agent-tasks/rebrand.md)) walks you through setting it.

A note on `pnpm audit`: the template intentionally ships with zero high/critical advisories. You may see a small number of low/moderate findings that resolve exclusively through the **dev/build toolchain of the removable Expo app** (`apps/native`) — they are not part of the server or worker production runtime, and removing the native module ([patterns/removable/native.md](./patterns/removable/native.md)) clears them entirely. See [patterns/dependency-vulnerabilities.md](./patterns/dependency-vulnerabilities.md) for how CVE responses are handled.
