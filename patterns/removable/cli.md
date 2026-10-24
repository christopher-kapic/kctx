# Removable: Companion Rust CLI

Rip out the Rust command-line tool (`apps/cli`) and everything that exists only
to support it. Use this if the product has no companion CLI — the CLI is for
products whose users want a terminal client (sync agents, relay daemons, admin
tooling, CI integrations). For a first web milestone, defer using/publishing it
without requiring local Rust setup. Physical removal is an explicit maintenance
choice and is not a prerequisite to the first feature.

## What you'll lose

- The `apps/cli` cargo workspace (clap starter, TOML config, completions,
  black-box tests, xtask automation, cargo-dist release config)
- CLI CI: `.github/workflows/cli-ci.yml` and
  `.github/workflows/release-preflight.yml`
- The CLI jobs in the manual `Release` workflow; the helper retains validated
  GHCR app, worker, and db-applier container publication
- The Dependabot cargo ecosystem entry and the `cli-change` PR label

## What stays untouched

- Everything Node-side. The CLI has no `package.json`, so pnpm, turbo, knip,
  biome, vitest, and every `apps/*`/`packages/*` workspace never referenced it.
- The Dockerfiles and images — they never shipped the CLI (`.dockerignore`
  excludes it).
- `build-image.yml`, `pr-checks.yml`, and the rest of Node CI.

## Steps

### Maintained helper (recommended)

After the owner explicitly chooses removal, run:

```bash
pnpm template:remove cli
```

This defaults to a complete preview: exact tracked deletions plus all dependent
edits. Review it with the owner, then run the printed
`--apply --confirm <hash>` command. `native cli` previews both clients in one
plan. The helper keeps container releases, generates agent mirrors in a
temporary snapshot, refuses dirty overlaps and recipe drift, and leaves the
actual changes unstaged. It never commits or recursively wipes a source tree.

See [the native helper workflow](./native.md#maintained-helper-recommended) for
the shared confirmation, offline generation, ignored-data protection, and
interruption/recovery contract. After apply, run `pnpm verify` before committing.
The following steps remain the maintained inventory for reviewing the helper
or carrying out a separately reviewed manual removal.

### 1. Delete the files

Read every step first and inventory the shared files to edit alongside these
deletions. Run `git status --short --untracked-files=all`; refuse if any planned
path overlaps existing staged, unstaged, or untracked work. Preserve the owner's
changes before continuing. Preview the exact tracked file set:

```bash
git rm --dry-run -r -- apps/cli .github/workflows/cli-ci.yml .github/workflows/release-preflight.yml patterns/cli.md
```

Once the owner has chosen removal and reviewed the file set, run the same
scoped `git rm -r --` command without `--dry-run` and without force flags. It
stages tracked deletions but does not commit. Retain ignored local files such
as `apps/cli/target`; never recursively sweep the source directory. Complete
all dependent edits below as the same verified change.

### 2. `.github/workflows/release.yml` — retain container publishing

The default helper keeps this workflow and strips its CLI branch. Remove the
`release-preflight`, `plan-cli-release`, both `build-cli-*`, and
`publish-cli-release` jobs; their `needs:` entries and result conditions; the
`cli_present` output and Cargo version check; and the CLI summary line.
Retain version validation, `node-checks`, all three container matrix entries,
and the summary gated on successful container publishing.

**Do not simply delete `release-preflight.yml` and leave a skipped `uses:` job
pointing at it.** GitHub still validates the reusable-workflow reference even
when the job condition would skip execution.

If the owner separately chooses to drop versioned GHCR publication, preview
the additional deletion:

```bash
git rm --dry-run -- .github/workflows/release.yml
```

If that deletion was selected and its path is clean, repeat without `--dry-run`.

The helper deliberately does not offer a workflow-deletion flag; deleting
container publishing is a separate reviewed choice.

### 3. `.github/dependabot.yml` — remove the cargo block

```yaml
# Cargo — covers the companion Rust CLI workspace (`apps/cli`). …
- package-ecosystem: cargo
  directory: /apps/cli
  …
```

### 4. `.github/labeler.yml` — remove the CLI entries

Delete the `cli-change:` block and the two `apps/cli/Cargo.*` lines under
`new-deps:`.

### 5. Root ignore files

- `.gitignore`: replace `apps/cli/target/` with `/apps/cli/`, so ignored build,
  release, and local env data remains ignored after the leaf ignore file goes.
- `.dockerignore`: retain `apps/cli` with a comment explaining that it protects
  retained local artifacts from entering the build context.

### 6. Docs

- **AGENTS.md**: delete the `### Rust CLI — Companion Command-Line Tool`
  section, the `Rust CLI ([removable/cli](./patterns/removable/cli.md))` item in
  the `## Stack` paragraph's "Optional/removable" list, and the `apps/cli/`
  line in Project Structure. (The `removable-cli` marker comment sits in the
  section itself and lists these same edit sites; the Stack item and the
  Project Structure line carry no marker of their own.)
  Then run `pnpm sync:agent-docs`.
- **README.md**: remove the "Companion Rust CLI" feature bullet, the
  `cli/` line in Project Structure, and "the Rust CLI" from the removable
  feature modules bullet.
- **patterns/README.md**: remove the "Work on the companion Rust CLI" row;
  retain the removal recipe link as helper documentation.
- **patterns/getting-started.md**: remove the Rust CLI row in the Phase 5
  triage table and the CLI-specific default guidance and initialization link.
- Keep this file and the native removal recipe as maintained helper documentation.

### 7. Verify

```bash
pnpm sync:agent-docs
git grep -n -E 'apps/cli|cli-ci|cargo xtask|dist-workspace'
pnpm verify
```

Review any tracked compatibility/documentation hits instead of demanding a
blank search. This search does not read local `.env` files or ignored artifacts.

## Sanity checks

### After removal

- `git grep "apps/cli"` returns no active consumers; retained conditional release
  logic and absent-workspace guards are expected compatibility references.
- The Actions tab shows no `CLI CI` / `Release Preflight` workflows on the next
  push. `Release` may remain if versioned container publication was selected.
- Node CI (`pr-checks.yml`, `build-image.yml`) is untouched and green.

### If you change your mind

The CLI was fully self-contained with no inbound dependencies, so re-adding it
later is a clean `git revert` of the removal commit (or copy `apps/cli` plus
steps 2–6 back from the template repo).
