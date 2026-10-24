import path from "node:path";

import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

// ---------------------------------------------------------------------------
// This file is the ONE deliberate exception to "never hand-roll dotenv" — see
// patterns/environment-variables.md § Validation vs loading (do not mix)
//
// It cannot import `@starter/env/root-env` the way every other entrypoint does.
//
// Why: `packages/db` has a `postinstall` that runs `prisma generate`, so both
// Dockerfiles must load this config during `pnpm install --frozen-lockfile` —
// which runs BEFORE `COPY . .`. At that point the build context holds only the
// workspace `package.json` files plus `packages/db/prisma*`; no workspace
// SOURCE exists. An import of `@starter/env/root-env` there fails with
// "Cannot find module '/app/packages/env/src/root-env.ts'" and takes the whole
// image build down. Verified the hard way — do not "fix" this to match the
// other entrypoints without rebuilding both images.
//
// The fixed `../../.env` hop is safe here in a way it was not in
// packages/env/src/shared.ts: Prisma requires this file at the package root, it
// is never bundled, and it is never relocated — so the depth cannot drift.
//
// `pnpm env:check-entrypoints` knows about this exemption
// (DIRECT_DOTENV_ALLOWLIST in scripts/check-load-dotenv-contract.ts); it is an
// enforced carve-out, not an oversight.
//
// dotenv won't override an existing DATABASE_URL, so external values still win.
// ---------------------------------------------------------------------------
dotenv.config({
  path: path.resolve(import.meta.dirname, "../../.env"),
  // Prisma --script stdout is SQL consumed by deployment and CI.
  quiet: true,
});

export default defineConfig({
  schema: path.join("prisma", "schema"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.cli.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
