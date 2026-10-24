# Project audit

End-to-end health check for this repo. Designed to be handed to an agent verbatim ("run the project audit"). The audit does three things:

1. **Runs the CI checks locally** and dispatches a subagent to clean up each failure. (`pnpm verify` is the authoritative gate — the command list below is the audit's expanded walk-through of it. If the two ever diverge, `package.json`'s `verify` script wins.)
2. **Audits monorepo structure** for catalog drift, workspace drift, and lockfile drift.
3. **Audits for AGENTS.md rule violations** that linters don't catch.

The audit **reports and fixes** — it does not open PRs, push, or bump dependencies. For a dedicated dependency-update pass, see [patterns/agent-tasks/update-dependencies.md](./agent-tasks/update-dependencies.md).

## When to run

- Before cutting a release
- After a merge that touched many workspaces
- Weekly, as a hygiene task
- Any time the user asks for a "health check" or "project audit"

## How the audit works

This is a **coordinated sweep**: the top-level agent runs each check, and for anything that fails or warns, spawns a **narrow-scope subagent** to fix only that failure. The top-level agent never fixes everything in one context — that's how audits turn into 4000-line diffs with unrelated changes.

Subagent prompts should always include:

- The exact command that failed
- The exact output (truncated to the relevant lines)
- The file(s) implicated
- A rule reference from `AGENTS.md` or a pattern doc
- A hard instruction: "fix only this failure; do not refactor adjacent code"

## Step 1 — CI checks

Run each, in order. Do not short-circuit on the first failure — collect them all first, then dispatch fixes in parallel.

```bash
pnpm install --frozen-lockfile    # lockfile drift
pnpm verify                       # the full merge gate (see package.json)
pnpm build                        # Turbo build for every app
pnpm knip:production              # stricter: production-only graph
pnpm doctor                       # repo-level health script (scripts/doctor.ts)
```

`pnpm verify` bundles `check:ci`, `check-types`, `test`, `knip`, and the policy
gates (`policy:checks`, `policy:agents-size`, `policy:test-colocation`,
`policy:queue-wiring`, `policy:access-matrix`, `policy:schema-diff`), plus
`env:check`, `env:check-entrypoints`, `docker:check-copy`, `docs:check-citations`,
and `deps:check-excludes`. Running the sub-commands individually is fine for
triage, but an audit that skips `pnpm verify` can report green on a tree that
fails merge. (`pnpm verify:fast` is the smaller pre-handoff gate; the
template-tooling self-tests live in `pnpm verify:tooling`, run nightly.)

### What each one is looking for

| Command | What it catches | Common fix |
|---|---|---|
| `pnpm install --frozen-lockfile` | `pnpm-lock.yaml` out of sync with `package.json` files | Run `pnpm install`, commit lockfile |
| `pnpm check:ci` | Biome lint/format violations and forbidden Prisma result casts | Run `pnpm check` for Biome fixes, then rerun `pnpm check:ci` and fix any Prisma diagnostic at its reported location |
| `pnpm check-types` | TS errors anywhere in the workspace | Fix the type mismatch — **never** `any` / `as any` |
| `pnpm test` | Broken unit tests | Fix the test or the code it exercised |
| `pnpm build` | Build-time errors (Vite, tsdown, container build inputs) | Fix the root cause; no `@ts-ignore` |
| `pnpm knip` | Unused files, unused exports, unused deps | Delete or wire them up |
| `pnpm knip:production` | Same, but ignoring dev-only imports — stricter | Same |
| `pnpm doctor` | Repo-level drift (env var schema, config sanity) | Follow the script's remediation output |

### Subagent recipe for CI failures

For each failure, spawn one subagent with this shape:

```
Task: Fix a single CI failure in the starter monorepo.

Command that failed: <pnpm ...>
Output (relevant lines only):
<paste>

Rules:
- Fix only this failure. Do not touch unrelated files.
- Do not add `any` / `as any` / `@ts-ignore` / `@ts-expect-error`.
- Do not bypass pre-commit hooks.
- Follow the rules in AGENTS.md and the patterns/ directory.
- When done, re-run the command to confirm it passes.

Report: the diff and a one-line explanation of the root cause.
```

Run these in parallel — they are independent (each scoped to one failure). After they return, re-run the full CI pass in the top-level agent to confirm the suite is green.

## Step 2 — Monorepo structure audit

Mechanical — no subagents needed unless a finding is non-trivial.

### 2a. Catalog drift

Find deps in two or more workspaces that are **not** catalog-managed — these should be promoted:

```bash
# List every dep reference across workspaces
for pj in package.json apps/*/package.json packages/*/package.json; do
  jq -r --arg f "$pj" '
    (.dependencies // {}) + (.devDependencies // {}) + (.peerDependencies // {})
    | to_entries[]
    | "\($f)\t\(.key)\t\(.value)"
  ' "$pj"
done | sort -k2,2 > /tmp/deps.tsv

# Deps in ≥2 workspaces that aren't "catalog:" anywhere
awk -F'\t' '$3 != "catalog:" { print $2 }' /tmp/deps.tsv | sort | uniq -c | awk '$1 >= 2 { print $2 }'
```

Anything printed is a catalog promotion candidate. Cross-check with `pnpm-workspace.yaml` — if it's already cataloged, the workspace is ignoring the catalog and should be fixed.

### 2b. Version drift

Find deps that resolve to **different versions** across workspaces (the catalog should prevent this, but escape-hatch per-workspace versions can drift):

```bash
# Same deps.tsv from above — group by name, flag multiple distinct non-catalog versions
awk -F'\t' '$3 != "catalog:"' /tmp/deps.tsv \
  | awk -F'\t' '{ print $2, $3 }' \
  | sort -u \
  | awk '{ count[$1]++; versions[$1] = versions[$1] ", " $2 } END { for (n in count) if (count[n] > 1) print n, versions[n] }'
```

### 2c. Lockfile / peer warnings

Capture the `pnpm install` output. Anything that isn't a **known-safe** peer warning (currently `vite-plugin-pwa` ↔ `vite@8`) should be added to `peerDependencyRules.allowedVersions` in `pnpm-workspace.yaml` or investigated.

### 2d. `allowBuilds`

If `pnpm install` prints "Ignored build scripts" warnings, the listed packages (`esbuild`, `sharp`, `msw`, etc.) are missing from `allowBuilds` in `pnpm-workspace.yaml` (pnpm 11 no longer reads the `pnpm` field in `package.json`). Add them.

### 2e. `packageManager` field

```bash
jq -r '.packageManager' package.json
```

Verify it matches the current stable `pnpm@<version>` the team uses. Stale values trip up CI runners that honor the field.

### 2f. Workspace health

- Every `packages/*` and `apps/*` has a `package.json` with a `name` field scoped `@starter/*` (apps can be unscoped).
- `turbo.json` tasks declare inputs and outputs; long-running tasks are `persistent: true`, one-shot tasks are not.
- `packages/config` exists and is referenced as `workspace:*` from other packages. Even if it's a stub, do not delete it.

## Step 3 — Rule audit (things linters don't catch)

### 3a. `useEffect` policy

`useEffect` calls in `apps/web/src/components/**` or `apps/web/src/routes/**` must be tagged `// effect:audited — <reason>` on the immediately preceding line, or refactored away. Custom hooks in `apps/web/src/hooks/` are exempt.

```bash
# Find useEffect without an audited-tag on the preceding line
grep -rn --include='*.tsx' --include='*.ts' 'useEffect(' apps/web/src/components apps/web/src/routes
```

Hand any untagged hit to a subagent with the five refactor patterns from [react-hooks-and-effects.md § Approved escape hatches](./react-hooks-and-effects.md) and ask for a refactor.

### 3b. `any` / `as any`

```bash
grep -rn --include='*.ts' --include='*.tsx' -E '\bas any\b|: any\b' apps packages
```

Any hit in non-test code is a finding. The fix is a proper type, never a suppression comment.

### 3c. Dangerous prisma commands in tracked files

```bash
grep -rn --include='*.sh' --include='*.ts' --include='*.json' --include='*.yml' \
  -E 'migrate reset|migrate dev|db push --force-reset|db drop' \
  scripts apps packages
```

Any match should be removed or justified. See `AGENTS.md#dangerous-commands--never-run-these`.

### 3d. Secrets in the tree

```bash
grep -rn --include='*.ts' --include='*.tsx' --include='*.json' --include='*.yml' --include='*.env*' \
  -E '(api[_-]?key|secret|password|bearer)\s*[:=]\s*["\x27]' \
  apps packages scripts
```

Findings must move to `packages/env` and be pulled from the environment at runtime.

### 3e. `.env` files tracked by git

```bash
git ls-files '*.env' '.env*' 2>/dev/null
```

Only `.env.docker.defaults` and `.env.example` (if present) should appear. Anything else is a leak — stop, warn the user, do not auto-remove.

### 3f. Environment manifest drift

```bash
pnpm env:check
```

Must exit 0. Failures mean a schema key has no entry in `scripts/lib/env-manifest.ts`, a manifest entry names a key no schema declares, or a generated `.env.example` is stale (`pnpm env:sync` fixes the last one).

The check is mechanical, so also eyeball the manifest for the things it can't verify — a group for a feature module that was ripped out ([removable/*](./removable/)), a `default` that no longer matches the schema, a `hint` naming a dashboard or provider that changed, or a prompt for a credential nothing uses anymore. See [environment-variables](./environment-variables.md).

### 3g. `transition: all`

```bash
grep -rn --include='*.css' --include='*.tsx' --include='*.ts' 'transition:\s*all\|transition-all' apps packages
```

Replace with explicit property lists per `AGENTS.md#styling`.

### 3h. Sitemap drift

Both sides need normalizing before they can be compared: the route tree carries
pathless `_app` / `_public` / `_auth` segments and TanStack's `$param` syntax,
neither of which appears in a URL, and `sitemap.md` documents routes in a
**table**, not a bullet list.

```bash
# Routes in the tree → URL shape.
# Drops layout shells (route.tsx, $lang.tsx) and pathless segments, collapses
# `/index`, rewrites `$param` → `:param`, and turns flat-route dots into slashes.
find apps/web/src/routes -name '*.tsx' \
     -not -name '_*' -not -name 'route.tsx' -not -name '$lang.tsx' \
  | sed 's|apps/web/src/routes||; s|\.tsx$||; s|/_app||g; s|/_public||g; s|/_auth||g;
         s|/index$||; s|\$lang|{lang}|; s|\$\([A-Za-z]\)|:\1|g; s|\.|/|g' \
  | grep -v '^$' | sort -u > /tmp/routes.txt

# Routes documented in sitemap.md — first backticked cell of each table row.
grep -oE '^\| *`[^`]+`' sitemap.md | sed 's/^| *//; s/`//g; s|/$||' | sort > /tmp/sitemap.txt

diff /tmp/routes.txt /tmp/sitemap.txt
```

A clean diff means no drift. Lines prefixed `<` are routes that exist but are
undocumented; `>` means `sitemap.md` describes a route that no longer exists.
The rule in `AGENTS.md#sitemap` says the sitemap must be kept current.

### 3i. `CLAUDE.md` / `AGENTS.md` sync

`CLAUDE.md` is generated from `AGENTS.md` by `pnpm sync:agent-docs`. If they're out of sync, re-run the script:

```bash
for m in CLAUDE.md .cursorrules .github/copilot-instructions.md; do
  diff <(tail -n +3 "$m") AGENTS.md >/dev/null || { pnpm sync:agent-docs; break; }
done
```

(`.cursorrules` uses a blockquote banner, so its offset may differ — when in
doubt just run `pnpm sync:agent-docs` and check `git status`.)

### 3j. Dead pattern links

```bash
# Every pattern link in AGENTS.md should resolve to an existing file
grep -oE '\./patterns/[a-z0-9/-]+\.md' AGENTS.md | sort -u | while read p; do
  [ -f "${p#./}" ] || echo "MISSING: $p"
done
```

Any `MISSING:` line means the index is out of date.

### 3k. Merge conflict markers

```bash
grep -rn --include='*.ts' --include='*.tsx' --include='*.md' --include='*.json' \
  -E '^(<<<<<<<|=======|>>>>>>>)' apps packages scripts patterns
```

Zero tolerance — any hit is a bad merge.

## Step 4 — Report

Produce one report, four sections. Keep each tight; link to line numbers, don't paste large blocks.

1. **CI status** — one line per check (`pass` / `fail → fixed by subagent #N` / `fail → needs user`).
2. **Monorepo findings** — catalog promotions, version drift, peer-warning surface, `packageManager` staleness.
3. **Rule violations** — grouped by rule, with file:line references and fix status.
4. **What the audit did not fix** — anything that needed judgment calls or touched more than one file deserves an explicit handoff to the user.

End the report with one of:

- ✅ **All clean** — every check passed, nothing to fix.
- 🟡 **Fixed N issues, M remain** — list the remaining ones.
- 🔴 **Audit blocked** — something requires user input before the audit can continue.

## Anti-patterns

- **Don't** fan one subagent out to "fix all the type errors" — scope each subagent to one failure. Mixing unrelated fixes in one diff defeats review.
- **Don't** run `pnpm update` or bump any dependency as part of the audit. That's a separate task.
- **Don't** auto-remove `.env` files or anything flagged as a secret — stop and warn.
- **Don't** mark the audit ✅ if `knip` has warnings. "Unused export" counts.
- **Don't** skip `pnpm build` because `check-types` passed. Build catches Vite and bundler config issues that tsc doesn't.
- **Don't** commit the audit report to the repo. It's a hand-off artifact, not source.
