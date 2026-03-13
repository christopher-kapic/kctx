# Multi-stage build for kinetic-context (kctx)

# Stage 1: Runtime base (no build tools)
FROM node:20-slim AS runtime-base

# Install openssl (required by Prisma) and git (required for cloning repos at runtime)
RUN apt-get update -y && apt-get install -y \
  openssl libssl-dev git \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

# Stage 2: Build base (adds build tools for native module compilation)
FROM runtime-base AS build-base

RUN apt-get update -y && apt-get install -y \
  build-essential g++ python3 make \
  && rm -rf /var/lib/apt/lists/*

# Stage 3: Build
FROM build-base AS builder

WORKDIR /app

# Copy workspace configuration and all package.json files for dependency installation
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/
COPY packages/api/package.json packages/api/
COPY packages/env/package.json packages/env/
COPY packages/config/package.json packages/config/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/

# Install all dependencies (including devDependencies for building)
RUN pnpm install --frozen-lockfile

# Copy all source code
COPY packages packages
COPY apps/web apps/web
COPY apps/server apps/server

# Generate Prisma client (no DATABASE_URL needed — schema has no url field)
RUN cd packages/db && pnpm prisma generate

# Build all packages (turborepo handles the dependency graph)
RUN pnpm build

# Verify build outputs
RUN test -f apps/server/dist/index.mjs && test -d apps/web/dist

# Stage 4: Production dependencies (needs build tools for native modules like node-pty)
FROM build-base AS prod-deps

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/
COPY packages/api/package.json packages/api/
COPY packages/env/package.json packages/env/
COPY packages/config/package.json packages/config/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --prod

# Stage 5: Runtime (clean image, no build tools)
FROM runtime-base AS runner

ENV NODE_ENV=production

WORKDIR /app

# Copy workspace config (needed for pnpm --filter @kctx/db db:push)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/
COPY packages/api/package.json packages/api/
COPY packages/env/package.json packages/env/
COPY packages/config/package.json packages/config/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# Copy production node_modules from prod-deps stage (native modules already compiled)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules

# Install opencode CLI (needed for terminal feature)
RUN npm i -g opencode-ai

# Copy built server and web
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Copy Prisma generated client, schema, and config (needed at runtime)
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/packages/db/prisma.config.ts ./packages/db/prisma.config.ts

# Create directories for volumes
RUN mkdir -p /packages /data

EXPOSE 3000

CMD ["sh", "-c", "[ \"$APPLY_SCHEMA\" = \"true\" ] && cd /app && pnpm --filter @kctx/db db:push; cd /app/apps/server && node dist/index.mjs"]
