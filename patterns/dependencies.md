# Dependencies — pnpm Catalog

How this monorepo manages shared dependency versions with pnpm's `catalog:` feature, and how to add, bump, or override them.

Before adding a **new** dependency at all, vet it and confirm with the user — the checklist lives in [agent-tooling § Vetting checklist](./agent-tooling.md#vetting-checklist).

## Why a catalog

Every workspace package depending on React, Zod, TypeScript, Hono, or any shared library should use the **same version**. Without enforcement, `apps/web` can drift to React 19.3 while `apps/server` stays on 19.2 — subtle type mismatches, duplicate bundles, runtime errors.

pnpm's `catalog:` field in `pnpm-workspace.yaml` solves this: declare the version **once**, and every `package.json` references it with `"catalog:"` instead of a semver range. pnpm resolves the actual version from the workspace file at install time.

## The rule

> **Catalog-managed deps are bumped in `pnpm-workspace.yaml` only, never in a workspace `package.json`.**

If a `package.json` says `"react": "catalog:"`, the version lives in `pnpm-workspace.yaml` under `catalog:`. Editing the `package.json` version directly will break the catalog reference.

## How it works

### pnpm-workspace.yaml (source of truth)

```yaml
catalog:
  react: ^19.2.8
  react-dom: ^19.2.8
  zod: ^4.4.3
  typescript: ^7.0.2
  # ... every shared dep
```

### package.json (consumer)

```jsonc
{
  "dependencies": {
    "react": "catalog:",
    "react-dom": "catalog:"
  },
  "devDependencies": {
    "typescript": "catalog:"
  }
}
```

The string `"catalog:"` tells pnpm "look up the version in the default catalog." No version number appears in the `package.json`.

## Add a new dependency to the catalog

1. **Add the entry** to `pnpm-workspace.yaml` under `catalog:`:

   ```yaml
   catalog:
     # existing entries...
     new-lib: ^2.0.0
   ```

2. **Reference it** in the consuming package's `package.json`:

   ```jsonc
   {
     "dependencies": {
       "new-lib": "catalog:"
     }
   }
   ```

3. **Install**:

   ```bash
   pnpm install
   ```

4. **Commit** both `pnpm-workspace.yaml` and the updated `pnpm-lock.yaml`.

## Bump an existing catalog dependency

1. **Edit the version** in `pnpm-workspace.yaml`:

   ```yaml
   catalog:
     react: ^19.3.0        # was ^19.2.5
     react-dom: ^19.3.0    # was ^19.2.5
   ```

2. **Install** to update the lockfile:

   ```bash
   pnpm install
   ```

3. **Verify** the lockfile updated (check `pnpm-lock.yaml` diff).

4. **Commit both files together** — the workspace file and the lockfile must stay in sync.

That's it. No `package.json` files need to change because they all say `"catalog:"`.

> **If the bump changes the library's configuration surface** — a renamed environment variable, a newly required one, a changed default, or a credential the provider no longer needs — update `packages/env/src/vars/*.ts` **and** `scripts/lib/env-manifest.ts` in the same commit, then run `pnpm env:sync`. `pnpm env:check` catches a schema key with no manifest entry, but it cannot catch a stale hint or a prompt for a key that is no longer used. See [environment-variables](./environment-variables.md).

### Worked example: React 19.2.8 → 19.3.0

Three packages (`apps/web`, `apps/server`, `packages/ui`) all depend on React. Without the catalog you'd edit three `package.json` files and hope you didn't miss one. With the catalog:

```diff
 # pnpm-workspace.yaml
 catalog:
-  react: ^19.2.8
-  react-dom: ^19.2.8
+  react: ^19.3.0
+  react-dom: ^19.3.0
```

```bash
pnpm install
git add pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "deps: bump React to 19.3.0"
```

One file edit, one install, one commit. Every workspace package picks up the new version.

## What does *not* belong in the catalog: root-only tooling

The catalog prevents **drift between workspace packages** — one `react`, one
`zod`, so two packages can't disagree at runtime. A dependency with exactly one
consumer has no drift to prevent, so cataloguing it buys nothing and costs a
layer of indirection: you read `"catalog:"`, jump to `pnpm-workspace.yaml`, and
find an entry used once.

So repo tooling that only ever runs from the root `package.json` keeps a plain
semver range there:

```jsonc
// package.json (root)
"devDependencies": {
  "@biomejs/biome": "^2.5.9",      // lint/format
  "@inquirer/prompts": "^8.6.0",   // prompts for `pnpm generate:secrets`
  "knip": "^6.32.2",               // unused-code scan
  "lefthook": "^2.1.10",           // git hooks
  "react-doctor": "^0.9.12",       // React health checks
  "turbo": "^2.10.11"              // task runner
}
```

The line is *who imports it*, not what kind of package it is: `tsx`,
`typescript`, `vitest`, and `@types/node` are also tooling, but workspace
members import them too, so those **are** `"catalog:"`.

Practically the range is near-moot either way — `pnpm-lock.yaml` pins the
resolved version and CI installs `--frozen-lockfile`, so the caret only matters
when someone deliberately runs `pnpm update`. Matching the neighbours keeps it
unremarkable.

**When in doubt, catalog it.** A second consumer appearing later is the common
case, and that's exactly the drift the catalog exists to stop.

## Escape hatch: per-package version override

Occasionally a package legitimately needs a different version than the rest of the monorepo (e.g., a legacy integration pinned to an older major). Two options:

### Option A: Remove from catalog

Take the dependency out of the `catalog:` block and specify the version directly in the package's `package.json`:

```jsonc
{
  "dependencies": {
    "legacy-lib": "^1.0.0"
  }
}
```

Other packages can still use `"catalog:"` for their version.

### Option B: Named catalogs (preferred for multiple packages)

pnpm supports named catalogs for when you need two distinct version tracks:

```yaml
# pnpm-workspace.yaml
catalog:
  some-lib: ^3.0.0

catalogs:
  legacy:
    some-lib: ^2.0.0
```

Reference the named catalog in the package that needs the older version:

```jsonc
{
  "dependencies": {
    "some-lib": "catalog:legacy"
  }
}
```

Named catalogs are the escape hatch, not the default. Most deps should use the unnamed `catalog:`.

## Automated dependency updates

Dependabot is already configured — `.github/dependabot.yml` opens weekly version-update PRs for npm, GitHub Actions, Docker base images, and the Cargo CLI, with cooldowns aligned to pnpm's `minimumReleaseAge` gate ([dependency-vulnerabilities](./dependency-vulnerabilities.md)). If you add Renovate later, configure it to target `pnpm-workspace.yaml` for catalog-managed entries, **not** individual `package.json` files. Otherwise the bot will try to edit `"catalog:"` strings that aren't real semver ranges and fail.

## Optional: syncpack for CI enforcement

[syncpack](https://github.com/JamieMason/syncpack) can lint your monorepo to ensure no `package.json` bypasses the catalog with a hardcoded version. Add it as a CI check if version drift becomes a recurring problem:

```bash
pnpm add -Dw syncpack
npx syncpack lint
```

## Agent task

For a step-by-step agent task that bumps every dependency in the monorepo to its latest stable release, see [agent-tasks/update-dependencies.md](./agent-tasks/update-dependencies.md).
