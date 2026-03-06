# kctx (Kinetic Context v2)

**kctx** is an MCP server that gives AI coding agents real-time access to dependency source code. Rather than relying on stale training data, agents can query actual library code to understand APIs, patterns, and usage — powered by [OpenCode](https://opencode.ai).

This is the successor to [kinetic-context](https://github.com/christopher-kapic/kinetic-context), rebuilt as a self-hosted web application with a CLI, web dashboard, and MCP interface.

## How It Works

1. **Register packages** — Add dependencies (npm, pip, cargo, etc.) by linking their Git repositories
2. **Repositories are cloned and indexed** — Source code is cloned locally, with optional RAG embeddings for faster retrieval
3. **AI agents query via MCP** — Agents call `list_dependencies` and `query_dependency` tools to ask questions about how to use a library
4. **OpenCode analyzes the source** — Queries are routed to an OpenCode instance that reads the actual codebase and provides answers with full context

## Features

- **MCP Server** — Exposes `list_dependencies` and `query_dependency` tools for AI coding agents
- **RAG-powered search** — Optional embedding-based retrieval to enrich queries with relevant code chunks
- **Web Dashboard** — Manage packages, repositories, conversations, and settings via a React UI
- **CLI** — Manage packages, repos, API keys, and settings from the terminal
- **Web Terminal** — Built-in terminal access for admin users
- **Auto-pull** — Public repositories are automatically pulled before queries to stay up to date
- **Conversation history** — Queries and responses are saved and shareable
- **Multi-user auth** — Better-Auth with API key authentication for MCP access
- **Self-hosted** — Runs on your own infrastructure with SQLite/Turso

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **Server**: [Hono](https://hono.dev)
- **Frontend**: React, TanStack Router, TailwindCSS, shadcn/ui
- **API**: [oRPC](https://orpc.unnoq.com) (end-to-end type-safe RPCs with OpenAPI)
- **Database**: SQLite / [Turso](https://turso.tech) via Prisma
- **Auth**: [Better-Auth](https://better-auth.com)
- **MCP**: [@modelcontextprotocol/sdk](https://modelcontextprotocol.io)
- **AI Backend**: [OpenCode](https://opencode.ai) (via @opencode-ai/sdk)
- **Monorepo**: Turborepo + pnpm workspaces

## Project Structure

```
kctx/
├── apps/
│   ├── cli/          # CLI tool (citty) — manage packages, repos, API keys
│   ├── server/       # Hono server — API, MCP endpoint, terminal WebSocket
│   └── web/          # React frontend (Vite + TanStack Router)
├── packages/
│   ├── api/          # Business logic, oRPC routers, RAG (embeddings + search)
│   ├── auth/         # Better-Auth configuration
│   ├── config/       # Shared TypeScript config
│   ├── db/           # Prisma schema & client (SQLite/Turso)
│   └── env/          # Type-safe environment variables (t3-env)
```

## Getting Started

### Prerequisites

- Node.js
- pnpm (`packageManager: pnpm@10.20.0`)
- An [OpenCode](https://opencode.ai) instance for answering queries

### Install

```bash
pnpm install
```

### Database Setup

This project uses SQLite with Prisma. Optionally start a local SQLite database:

```bash
pnpm run db:local
```

Update your `.env` file in `apps/server` with the appropriate connection details, then push the schema:

```bash
pnpm run db:push
```

### Development

```bash
pnpm run dev
```

- Web app: [http://localhost:3001](http://localhost:3001)
- API server: [http://localhost:3000](http://localhost:3000)
- MCP endpoint: `http://localhost:3000/mcp` (requires API key)

### MCP Configuration

To use kctx as an MCP server in your AI coding tool, configure it with the MCP endpoint and an API key:

```
URL: http://<your-host>:3000/mcp
Authorization: Bearer <your-api-key>
```

API keys can be created via the web dashboard or the CLI (`kctx api-keys create`).

## Available Scripts

- `pnpm run dev` — Start all apps in development mode
- `pnpm run build` — Build all apps
- `pnpm run dev:web` — Start only the web app
- `pnpm run dev:server` — Start only the server
- `pnpm run check-types` — TypeScript type checking across all packages
- `pnpm run db:push` — Push schema changes to database
- `pnpm run db:generate` — Generate Prisma client
- `pnpm run db:migrate` — Run database migrations
- `pnpm run db:studio` — Open Prisma Studio
- `pnpm run db:local` — Start a local SQLite database

## CLI

The `kctx` CLI provides commands for managing your instance:

```
kctx login           # Authenticate with the server
kctx packages list   # List registered packages
kctx packages add    # Add a new package
kctx packages remove # Remove a package
kctx packages update # Update a package
kctx repos list      # List repositories
kctx repos update    # Update a repository
kctx api-keys list   # List API keys
kctx api-keys create # Create an API key
kctx api-keys revoke # Revoke an API key
kctx settings get    # View settings
kctx settings set    # Update settings
```
