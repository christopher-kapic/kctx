# Kinetic Context (kctx)

Team-deployable dependency documentation system with MCP integration.

## Monorepo Structure

pnpm workspaces + Turborepo. Package scope: `@kctx/*`.

```
apps/
  server/    — Hono API server (port 3000 internal, 7167 external)
  web/       — React 19 + Vite + TanStack Router + TanStack Query
  cli/       — CLI using citty + @clack/prompts
packages/
  api/       — oRPC routers (repository, package, settings, users, stats, apiKey)
  auth/      — better-auth with admin plugin
  db/        — Prisma schema (SQLite via LibSQL adapter)
  env/       — Environment variable validation (@t3-oss/env-core)
```

## Database

- **ORM**: Prisma with multi-file schema at `packages/db/prisma/schema/`
- **Database**: SQLite via LibSQL adapter
- **Schema push**: `pnpm db:push` (no traditional migrations)
- **Generate**: `pnpm db:generate` (required after schema changes)
- **Studio**: `pnpm db:studio`
- Models: Repository, Package, SiteSettings (singleton), ApiKey, plus better-auth tables (User, Session, Account, Verification)

## Authentication

- **Library**: better-auth with admin plugin
- **First signup**: Automatically becomes admin
- **Roles**: admin, user (via better-auth admin plugin)
- **Session**: Cookie-based for web/CLI, API key (Bearer token) for MCP

## API Layer

- **Framework**: oRPC with Zod v4 validation
- **Procedures**: `publicProcedure`, `protectedProcedure` (authenticated), `adminProcedure` (role=admin)
- **Client**: oRPC + TanStack React Query (client-side fetching with skeleton loading)

## MCP Server

- Endpoint: `/mcp` with Bearer token auth (API keys stored as SHA-256 hashes)
- Tools: `list_dependencies`, `query_dependency` (via OpenCode)
- Uses `AsyncLocalStorage` for context threading

## Deployment

- **Docker**: Multi-stage Dockerfile, `compose.yaml` with kinetic-context + opencode services
- **Single port**: Server serves Vite SPA in production (static files + SPA fallback)
- **Env vars**: See `.env.example` for required/optional variables
- `VITE_SERVER_URL` is optional in production (falls back to `window.location.origin`)
- `CORS_ORIGIN` is optional for same-origin deployments

## Running Locally

```bash
pnpm install
pnpm db:generate
pnpm dev            # starts server + web in parallel
```

Web runs on port 3001 (Vite dev server), server on port 3000. Set `VITE_SERVER_URL=http://localhost:3000` in `apps/web/.env` for development.

## Quality Checks

```bash
pnpm turbo check-types   # typecheck all packages
pnpm turbo lint           # lint all packages
pnpm turbo build          # build all packages
```

## Coding Conventions

See `.ktg/sp/SOLVED_PROBLEMS.md` for detailed patterns on:
- Prisma schema design (`prisma-schema`)
- oRPC usage (`web-orpc-usage`)
- Form patterns (`web-form`)
- Dashboard UI overlays (`web-shadcn-dashboard`)
- Docker with Prisma (`prisma-docker-no-database-url`)
- Same-origin deployment (`astro-hono-setup`)
- UI design spacing (`web-refactoring-ui-design`)
