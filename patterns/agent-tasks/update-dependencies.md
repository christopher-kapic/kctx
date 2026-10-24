# Agent task: update dependencies

End-to-end recipe for bumping every dependency in the monorepo to its latest stable release. Designed to be handed to an agent verbatim.

## Goal

For every workspace (`apps/*`, `packages/*`, and root), bump each dependency to the latest **stable** release (no `next`, `beta`, `rc`, `canary`, or other prerelease tags). For any major or minor bump that requires code changes, audit how we consume the package and update our usage. Verify build, typecheck, and lint are clean at the end.

## Inputs the agent should already have

- Working tree at the repo root (this template)
- Network access for `npm view` / `pnpm outdated` and for fetching changelogs

## Step 1 — Inventory

Read the root `package.json`, the workspace catalog, and **every** workspace `package.json` — enumerate them rather than relying on a fixed list (workspaces are added over time):

```bash
ls package.json pnpm-workspace.yaml apps/*/package.json packages/*/package.json
```

`pnpm-workspace.yaml` contains the `catalog:` block. As of this writing the workspaces are `apps/{web,native,server,worker}` and `packages/{agent-runtime,api,auth,config,db,db-applier,env,i18n-translate,locales,mailer,queue,test-utils,ui}`, but trust the glob, not this sentence.

Cataloged deps live in `pnpm-workspace.yaml` under `catalog:` and are referenced from workspaces as `"<dep>": "catalog:"`. **Always update the catalog entry, never the workspace reference**, for cataloged deps.

## Step 2 — Find what's outdated

Run both of these — they answer different questions:

```bash
# What can be bumped within current ranges?
pnpm outdated -r

# What is the absolute latest stable on npm? (catches major bumps that pnpm outdated hides)
for pkg in <every unique dep name>; do
  printf "%-40s %s\n" "$pkg" "$(npm view $pkg version)"
done
```

`pnpm outdated -r` only reports versions that satisfy current ranges, so it **misses major-version bumps**. Always cross-check with `npm view <pkg> version` to know whether a new major exists.

To check dist-tags (confirm `latest` isn't a prerelease):

```bash
npm view <pkg> dist-tags
```

A few packages publish prereleases under `latest` — if you see something like `1.0.0-rc.4` as `latest`, dig deeper and pick the highest stable version from `npm view <pkg> versions --json`.

## Step 3 — Audit breaking changes for any non-patch bump

For every dep getting a **minor** or **major** bump, read the changelog between the old and new versions (the package's GitHub releases page or repo `CHANGELOG.md`, via `WebFetch`/`gh`) and look specifically for changes in our consumption surface. Skip patch bumps.

Before reading, grep our codebase for the APIs we actually use so you know what to look for:

```bash
# Example for better-auth
grep -rn "freshAge\|secondaryStorage\|provisionUser\|saml\|InResponseTo\|twoFactor\|skipVerificationOnEnable" .
```

If the changelog flags a breaking change touching code we own, **fix it in the same change set as the version bump** — don't leave the bump half-broken.

### Known historical gotchas (worth a deliberate look every time)

| Package | Watch out for |
|---|---|
| `better-auth` | New columns on auth tables (e.g. `TwoFactor.verified` added in 1.6 — needs `verified Boolean @default(true)` in `packages/db/prisma/schema/auth.prisma` so legacy rows are treated as verified). Session `freshAge` semantics. Plugin deprecations. |
| `@base-ui/react` | Component prop renames between minor versions. Check Dialog/Sheet/Popover/Combobox/Command props. |
| `@tanstack/react-router` | File-based routing config and `createFileRoute` signatures shift between minors. |
| `prisma` | Schema generator output path, client constructor changes, adapter package changes. |
| `vite` | Plugin peer-dep ranges (vite-plugin-pwa lags behind by a major; usually safe to ignore the warning). |
| `tailwindcss` (v4) | `@theme` block, `globals.css` directives. |
| `zod` | v3 → v4 was disruptive. v4.x minors are usually safe but check `.parse()` error shape. |

## Step 4 — Apply the version bumps

**Order of operations matters.** Do the catalog first, then the per-workspace bumps, then `pnpm install`.

1. **Catalog (`pnpm-workspace.yaml`)** — bump every dep under the `catalog:` block. **That block is the authoritative inventory — read it directly; do not work from a list memorized here, it goes stale.** It currently spans ~90 entries (the React / `@tanstack/*` / `@orpc/*` / `@aws-sdk/*` families, `better-auth`, `prisma`, `hono`, `tailwindcss`, `typescript`, `vite`, `bullmq`, `ioredis`, `nodemailer`, the i18n deps, etc.). **Any time you bump a dep that lives in two or more workspaces, promote it to the catalog** rather than editing each workspace.

2. **Per-workspace `package.json`** — bump anything not in the catalog. Use exact semver floors (e.g. `^4.12.12`, not `^4.12`). For deps that appear with bare or wildcard versions like `"^6"`, replace with the precise stable (e.g. `"^6.0.2"`).

3. **`biome.json`** — both the root `biome.json` and the shared `packages/config/biome.json` it extends embed Biome's CLI version in `$schema` (e.g. `https://biomejs.dev/schemas/2.5.9/schema.json`). After bumping `@biomejs/biome`, update both URLs to match or `pnpm lint` prints a migration notice.

4. **Install:**
   ```bash
   pnpm install
   ```

   Read the install output. Expect peer-dep warnings only for known-stale peer ranges (currently `vite-plugin-pwa@1.3.0` does not list `vite@8` and `@tanstack/react-start` pulls a `crossws` mismatch via `h3`). Anything else, investigate before moving on.

> **The 7-day release-age gate will block fresh releases.** `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` (7 days) with `minimumReleaseAgeStrict: true`. `pnpm install` **hard-fails** (it does not silently downgrade) on any version published less than 7 days ago — and "latest stable" is frequently days old. When that happens you have two correct moves: (a) pin the catalog/`package.json` floor to the newest version that is ≥7 days old instead of the absolute latest (preferred — just bump to a slightly older stable), or (b) only if a security fix forces the very latest, add a **dated** entry to `minimumReleaseAgeExclude` per [patterns/dependency-vulnerabilities.md § 4. The release-age trap](../dependency-vulnerabilities.md#4-the-release-age-trap). Do **not** lower `minimumReleaseAge`, flip off `minimumReleaseAgeStrict`, or blanket-add packages to the Exclude list to push a routine bump through. Check publish dates up front with `npm view <pkg> time --json` to avoid the failed-install round-trip.
>
> Bumps can also make an entry in the `overrides:` block redundant (the dependency graph now resolves clear on its own). If so, delete the stale override and re-resolve — see the cleanup note in the same doc.

## Step 5 — Handle schema changes

If any dep change touches `packages/db/prisma/schema/**.prisma`, the user needs to push the schema after pulling. **Surface this prominently in the final summary** with the exact command:

```bash
pnpm db:push
```

Do **not** run the push yourself — the dev DB is the user's call.

## Step 6 — Verify

Run all four, in order:

```bash
pnpm build
pnpm check-types
pnpm lint
pnpm test
```

All four must be clean. `pnpm test` matters here specifically — a dependency bump can break runtime behavior without breaking the build or types. Cached results from a previous run are fine — Turborepo replays the logs. If anything fails, fix the root cause; do not bypass with `--no-verify` or by reverting the bump.

## Step 7 — Monorepo audit (optional, only if user asks)

If the user explicitly asks for a monorepo-setup audit, spawn an `Explore` subagent with a self-contained brief that investigates:

- **Catalog under-use** — deps duplicated across workspaces at the same version that should be promoted
- **`packages/config`** — already hosts the shared `tsconfig.base.json`, `biome.json`, `postcss.config.mjs`, and locale source. Check it isn't drifting from what workspaces actually consume (orphaned exports, configs duplicated back into a workspace)
- **`turbo.json`** — `persistent: true` should only be on long-running processes (`dev`, `db:studio`); not on `db:push`
- **`packageManager`** field in root `package.json` — verify `pnpm@<x>` is current
- **`allowBuilds`** (`pnpm-workspace.yaml`) — `pnpm install` warnings about ignored build scripts (`esbuild`, `sharp`, `msw`) point at missing entries (pnpm 11 no longer reads the `pnpm` field in root `package.json`)
- **`peerDependencyRules.allowedVersions`** (`pnpm-workspace.yaml`) — silence known-good peer warnings (e.g. `vite-plugin-pwa` ↔ `vite@8`)
- **Workspace `exports`** — catch-all `"./*"` patterns leak internals; explicit named exports are better

The subagent should **only report findings**, not make changes. Pass them back to the user as a prioritized punch list.

## Step 8 — Final report

Tell the user:

1. Every catalog and per-workspace bump that landed (grouped, not one-by-one — group by "catalog" vs "per-workspace")
2. Any **code** changes you made because of a breaking change, with file path and line numbers
3. Any **schema push** they need to run (`pnpm db:push`)
4. Build / typecheck / lint status (one line each)
5. Anything you intentionally **did not** bump (e.g. a dep stuck on a major because of a peer conflict)
6. Monorepo audit findings (only if asked)

## Anti-patterns

- **Don't** use `pnpm update --latest` — it edits package.json files but ignores the catalog and silently picks prereleases for some packages.
- **Don't** edit a `"<dep>": "catalog:"` line in a workspace package.json. Edit the catalog entry instead.
- **Don't** bump a dep and skip the breaking-change check just because the build passes — TypeScript and runtime can diverge for things like Better-Auth schema columns.
- **Don't** apply the monorepo audit recommendations during a dependency-update task. They are a separate change set.
- **Don't** run `pnpm db:push` or any other DB-mutating command yourself.
- **Don't** delete or rename `packages/config` — it's referenced as `workspace:*` from every other workspace and now hosts the shared `tsconfig.base.json` / `biome.json` / `postcss.config.mjs` / locale source.

## See also

- [dependencies.md](../dependencies.md) — catalog policy and dependency conventions
- [dependency-vulnerabilities.md](../dependency-vulnerabilities.md) — scoped `overrides`, the `minimumReleaseAge` gate + Exclude list, OS base-image CVE patches
