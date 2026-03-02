# Multi-stage build for kinetic-context (kctx)

# Stage 1: Base image with system dependencies
FROM node:20-slim AS base

# Install openssl (required by Prisma) and git (required for cloning repos at runtime)
RUN apt-get update -y && apt-get install -y openssl libssl-dev git && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

# Stage 2: Build
FROM base AS builder

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

# Stage 3: Runtime
FROM base AS runner

ENV NODE_ENV=production

WORKDIR /app

# Copy workspace config for pnpm install
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/
COPY packages/api/package.json packages/api/
COPY packages/env/package.json packages/env/
COPY packages/config/package.json packages/config/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built server and web
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Copy Prisma generated client and schema (needed at runtime)
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma

# Create directories for volumes
RUN mkdir -p /packages /data

WORKDIR /app/apps/server

EXPOSE 3000

CMD ["node", "dist/index.mjs"]
