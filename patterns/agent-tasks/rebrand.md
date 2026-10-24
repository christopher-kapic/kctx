# Agent task: rebrand the starter

Recipe for giving an app its own public identity. Display branding is the default; internal renaming is an optional maintenance task. Designed to be handed to an agent verbatim.

## Goal

Give users the chosen app name, domain, icons, and content. Keep internal package, database, container, and volume names stable by default. There are three independently selectable kinds of work:

1. **Package scope** (`@starter/*` → `@<scope>/*`) and the root workspace name (`starter` → `<app-slug>`). These are structural — they break imports and `pnpm` resolution if missed.
2. **Display branding** (PWA name, page titles, header text, TOTP issuer, README). This is the normal onboarding path.
3. **Template provenance** (scaffolding metadata, template-speak in repo docs, the license). These are what makes a repo look template-built to anyone who opens it.

**Default path:** apply Step 2, the PWA details in [removable/rebrand.md](../removable/rebrand.md), Step 1h for a distinct local hostname, and only the public-name/description portions of Step 4. Configure the public domain through the chosen deployment recipe. **Always ask the Step 5 license question as part of this default path** — "keep the template license or switch to your own?" — and apply the answer: an app that ships with the template vendor's license is not an option. The rest of Steps 1a–1g/1i, 3, and 6 stays out of scope unless explicitly chosen. Verify with `pnpm verify` and report the completed display changes. Deferred CLI source needs no Rust toolchain or rename until it is used or published.

**Optional full internal rename:** use the remaining steps only for an explicit package/operations naming requirement. Scope renaming and database/volume renaming are separate decisions; choosing one does not authorize the other. Preserve local data, preview affected paths, and follow the relevant safety rules. The no-template-evidence sweep below applies only when the user requests this full mode.

## Inputs the user must provide

For display branding, use the app name, description, domain, and artwork decisions already in notes. Derive a local hostname from the app name and check for an existing choice. Ask only for missing decisions that affect the selected scope — with one exception: the Step 5 license question is always asked, even for display branding. The additional inputs below apply only to their optional operations:

| Variable | Example | Used in |
|---|---|---|
| **`<scope>`** — npm scope, only for an opted-in internal rename | `acme` | `@starter/*` → `@acme/*` |
| **`<slug>`** — operations slug, only for an opted-in internal rename | `acme-app` | root `package.json` `name`, docker image tags, DB name + container |
| **`<local-subdomain>`** — portless local dev slug | `acme-app` | `https://<local-subdomain>.localhost` and `https://api.<local-subdomain>.localhost` |
| **`<name>`** — display name | `Acme` | `VITE_APP_NAME` env var (header, tab title, PWA name) and the TOTP `issuer` string |
| **`<description>`** — one-line tagline | `Acme is a workout tracker` | `README.md` description sentence |
| **`<cli-name>`** — CLI binary name (only before using or publishing the CLI) | `acme` | `cargo xtask init` in step 6 |

If the user only gives you a name, derive the local subdomain (`Acme Tracker` → `acme-tracker`). It must be unique on the developer's machine so multiple projects can run at once. Keep the existing scope/database names. Confirm a package scope only if the user opted into renaming it; confirm the CLI binary name only if the CLI will be used or published.

Renaming the local database carries one guard consequence: `scripts/assert-local-database.sh` expects the DB name `starter` (configurable via `EXPECTED_DB`), so after the rename every `pnpm db:push` / `pnpm db:seed` needs `EXPECTED_DB=<new-name>` until the guard's default is updated in the same commit as the compose files.

## Step 1 — Rename package scope (`@starter/*` → `@<scope>/*`)

Opt-in only, except the independent local hostname change in Step 1h. Every internal package is named under `@starter` and consumed via that scope from every workspace and many source files.

### 1a. Rename the `name` field in each workspace `package.json`

```
packages/agent-runtime/package.json    → @<scope>/agent-runtime
packages/api/package.json              → @<scope>/api
packages/auth/package.json             → @<scope>/auth
packages/config/package.json           → @<scope>/config
packages/db/package.json               → @<scope>/db
packages/db-applier/package.json       → @<scope>/db-applier
packages/env/package.json              → @<scope>/env
packages/i18n-translate/package.json   → @<scope>/i18n-translate
packages/locales/package.json          → @<scope>/locales
packages/mailer/package.json           → @<scope>/mailer
packages/queue/package.json            → @<scope>/queue
packages/test-utils/package.json       → @<scope>/test-utils
packages/ui/package.json               → @<scope>/ui
```

Enumerate the workspaces from disk (`ls packages/*/package.json`) rather than this list — workspaces are added over time and the agent should not assume the inventory is fixed.

`apps/web`, `apps/server`, and `apps/worker` keep their unscoped names (`web`, `server`, `worker`) — those are not published, only referenced via `pnpm -F`.

### 1b. Rename `workspace:*` deps in every workspace `package.json`

Every `"@starter/<x>": "workspace:*"` becomes `"@<scope>/<x>": "workspace:*"`. Do not rely on a memorized list — grep:

```bash
grep -lE '"@starter/' package.json apps/*/package.json packages/*/package.json
```

For reference, the current edges (as of writing) are:

```
package.json                          # @starter/config, @starter/env
apps/web/package.json                 # @starter/api, @starter/auth, @starter/config, @starter/env, @starter/locales, @starter/ui
apps/server/package.json              # @starter/api, @starter/auth, @starter/config, @starter/db, @starter/env, @starter/queue
apps/worker/package.json              # @starter/agent-runtime, @starter/api, @starter/auth, @starter/config, @starter/db, @starter/env, @starter/mailer, @starter/queue
packages/agent-runtime/package.json   # @starter/config
packages/api/package.json             # @starter/auth, @starter/config, @starter/db, @starter/env, @starter/mailer, @starter/queue
packages/auth/package.json            # @starter/config, @starter/db, @starter/env, @starter/mailer
packages/db/package.json              # @starter/config, @starter/env
packages/env/package.json             # @starter/config
packages/i18n-translate/package.json  # @starter/config, @starter/env
packages/locales/package.json         # @starter/config
packages/mailer/package.json          # @starter/config, @starter/env
packages/queue/package.json           # @starter/config, @starter/env
packages/test-utils/package.json      # @starter/api, @starter/auth, @starter/config, @starter/db
packages/ui/package.json              # @starter/config
```

`packages/config/package.json` and `packages/db-applier/package.json` have no internal scope dependencies.

Sort within each `dependencies` block alphabetically (the existing files do — keep it that way).

### 1c. Update `turbo -F` / `pnpm -F` filters in the root `package.json` scripts

Every `turbo -F @starter/<x>` or `pnpm -F @starter/<x>` gets the new scope. Don't memorize the list — grep first:

```bash
grep -nE 'turbo -F @starter/|pnpm -F @starter/' package.json
```

For reference, the current set is:

```jsonc
"db:push":           "turbo -F @<scope>/db db:push",
"db:push:dangerous": "turbo -F @<scope>/db db:push:dangerous",
"db:seed":           "turbo -F @<scope>/db db:seed",
"db:studio":         "turbo -F @<scope>/db db:studio",
"db:generate":       "turbo -F @<scope>/db db:generate",
"db:validate":       "turbo -F @<scope>/db db:validate",
"generate:vapid":    "pnpm -F @<scope>/api exec web-push generate-vapid-keys"
```

`dev:web`, `dev:server`, `dev:worker` use unscoped filters (`-F web`, `-F server`, `-F worker`) and stay as-is.

### 1d. Update every `extends` and import that references the old scope

Config files that extend `@starter/config` (grep first — `grep -lE '@starter/' tsconfig.json biome.json apps/*/tsconfig.json packages/*/tsconfig.json` will enumerate the current set):

```
biome.json                                # extends @starter/config/biome.json
tsconfig.json                             # extends @starter/config/tsconfig.base.json
apps/web/tsconfig.json
apps/server/tsconfig.json
apps/worker/tsconfig.json
packages/agent-runtime/tsconfig.json
packages/api/tsconfig.json
packages/auth/tsconfig.json
packages/db/tsconfig.json
packages/env/tsconfig.json
packages/i18n-translate/tsconfig.json
packages/locales/tsconfig.json
packages/mailer/tsconfig.json
packages/queue/tsconfig.json
packages/test-utils/tsconfig.json
packages/ui/tsconfig.json
packages/ui/postcss.config.mjs            # `export { default } from "@starter/config/postcss.config.mjs"`
```

`apps/web/tsconfig.json` also has a paths alias `"@starter/ui/*": ["../../packages/ui/src/*"]` → `"@<scope>/ui/*": [...]`.
`packages/ui/tsconfig.json` has the same pattern locally.

Source files that import from the scope (use Grep — there are dozens, including every shadcn component in `packages/ui/src/components/**`, every route under `apps/web/src/routes/**`, hooks, utils, server entrypoints, and `apps/web/src/index.css`'s `@import "@starter/ui/globals.css"`):

```
Grep for: @starter/
```

Use a single repo-wide find/replace of `@starter/` → `@<scope>/`. After the replacement, **also** update:

- `apps/server/tsdown.config.ts` — the regex `alwaysBundle: [/@starter\/.*/]` becomes `[/@<scope>\/.*/]` (don't forget to escape the slash).
- `apps/web/components.json` and `packages/ui/components.json` — the shadcn aliases (`@starter/ui/components`, etc.).
- `AGENTS.md` — the canonical agent-rules file references `@starter/db`, `@starter/queue`, `@starter/api`, etc. in its testing and assets sections. Update them, then run `pnpm sync:agent-docs` to regenerate `CLAUDE.md`, `.cursorrules`, and `.github/copilot-instructions.md`. Do **not** edit the generated files directly — the next sync run will overwrite them.

### 1e. Update the `shadcn` CLI aliases

`apps/web/components.json` and `packages/ui/components.json` each contain alias maps with `@starter/ui/...` paths. After the global replace these are correct, but **verify** — shadcn will silently scaffold to the wrong place if any are missed.

### 1f. Update the patterns docs

The pattern files under `patterns/*.md` are full of import examples like `import { Button } from "@starter/ui/components/button";`. These are agent-facing recipes — if stale, the next agent writes code with the wrong scope. Run the same `@starter/` → `@<scope>/` replacement across `patterns/**/*.md`.

Do **not** touch `patterns/agent-tasks/rebrand.md` (this file) — it intentionally documents the old scope.

### 1g. Update the root `name`

`package.json` at the repo root: `"name": "starter"` → `"name": "<slug>"`.

### 1h. Update local portless hostnames

`portless.json` owns the stable local dev hostnames. Replace the template names
with the chosen local subdomain:

```json
{
  "script": "dev:raw",
  "apps": {
    "apps/web": { "name": "<local-subdomain>" },
    "apps/server": { "name": "api.<local-subdomain>" }
  }
}
```

Then set your local origin in the root **`.env`** (your own untracked file):

```env
BETTER_AUTH_URL=https://<local-subdomain>.localhost
```

> **Do not hand-edit `.env.example`.** It is generated from `scripts/lib/env-manifest.ts` by `pnpm env:sync`, and `pnpm env:check` fails in CI when it drifts. To change what a fresh clone sees, edit the manifest entry's `example` / `default` / `hint` and re-run `pnpm env:sync` — see [environment-variables](../environment-variables.md). The same applies everywhere below that mentions `.env.example`.

Vite reads `portless.json` to derive the default API proxy target, so there is
no second hostname to edit in code. Leave the raw-port fallback env vars unset;
they are used only by `pnpm dev:raw` and by non-portless tooling.

### 1i. Reinstall

```bash
pnpm install
```

This rewrites `pnpm-lock.yaml` with the new package names. Expect a clean install — an `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` (or similar) means you missed a `workspace:*` reference.

## Step 2 — Replace display branding

The header, page title, and PWA manifest all read the app name from the `VITE_APP_NAME` env var at runtime (see `packages/env/src/web.ts` — it defaults to `"App"` when unset, and `apps/web/src/routes/__root.tsx` / `apps/web/src/components/header.tsx` / `apps/web/vite.config.ts` consume it). That means the display name change is one env var, not eight per-file edits.

| File | Change |
|---|---|
| `apps/web/.env` | Set `VITE_APP_NAME=<name>` (it is a `VITE_*` var, so it lives in the **web** env file, not the root one). To change the default a fresh clone inherits, edit the `VITE_APP_NAME` entry's `default` in `scripts/lib/env-manifest.ts` and run `pnpm env:sync` — do not hand-edit `apps/web/.env.example`. |
| `packages/auth/src/index.ts` (~line 205) | `twoFactor({ issuer: "Starter" })` → `issuer: "<name>"`. This is the TOTP issuer shown in users' authenticator apps (Google Authenticator, 1Password, …) — get it right. |
| `packages/i18n-translate/src/openrouter.ts` (~line 13) | `"X-Title": "Starter Template Translation"` → `"<name> Translation"`. Sent to OpenRouter on every auto-translate call and shown on their dashboard — a third-party leak of the template identity. |

Optional / context-dependent:

- **PWA description**: `vite.config.ts` builds it as `${appName} - PWA Application`. If the user wants something other than the default `"<name> - PWA Application"`, edit `vite.config.ts` directly.
- **Landing-page copy**: the public home route (`apps/web/src/routes/$lang/_public/index.tsx`) renders the `home.title` / `home.description` keys from `packages/locales/src/en-US/common.json`, which ship as placeholders (`"App"` / `"A starter app. Replace this copy with your own."`). They aren't template-branded, but they are the literal copy a fresh app renders. Either write the user's real copy into the English bundle now and run `pnpm i18n:translate`, or note in the final report that the landing copy is still placeholder.

If the user has already replaced `apps/web/public/pwa-*.png` and `favicon.ico` with their own assets, leave those alone. If not, mention in the final report that the PWA icons are still the template defaults (regenerated via `pnpm -F web generate-pwa-assets`).

## Step 3 — Replace database / container names

Opt-in only. Keep these names for the default display-branding path. The dev database and containers are named `starter` in **two compose files plus the `DATABASE_URL` manifest entry**, and they all need to agree. Search first — `rg -n 'starter' docker-compose.dev.yml docker-compose.agent.yml scripts/lib/env-manifest.ts` — then:

| File | Change |
|---|---|
| `docker-compose.dev.yml` (repo root) | top-level `name: starter-dev` → `<slug>-dev`; `container_name: starter-dev-postgres` / `starter-dev-redis` → `<slug>-dev-*`; `POSTGRES_DB: starter` → `<slug>`; volumes `starter_dev_postgres` / `starter_dev_redis` (mount lines **and** the `volumes:` block) → `<slug>_dev_*` |
| `docker-compose.agent.yml` (repo root) | `POSTGRES_DB: starter` → `<slug>`; every `DATABASE_URL: postgresql://...:5432/starter` (there are several — grep) → `.../<slug>`; the network `name: ${COMPOSE_PROJECT_NAME:-starter-agent}_net` → `...:-<slug>-agent}_net`. The `pnpm -F @starter/db` lines inside this file are rewritten by the global scope replacement in step 1d — verify they were caught. |
| `.env` (repo root, your own untracked file) | `DATABASE_URL=postgresql://postgres:password@localhost:5432/starter` → `.../<slug>`. For the committed placeholder a fresh clone sees, edit the `DATABASE_URL` entry's `example` in `scripts/lib/env-manifest.ts` and run `pnpm env:sync` — `.env.example` is generated. |

If the user has an existing local DB volume from before the rebrand, **warn them**: renaming the volume orphans the old data. They may want to `pnpm db:push` against the new DB (or `pg_dump`/`pg_restore` from the old volume) before the old container is removed. Do not run any of this yourself.

## Step 4 — README and docs

Grep before editing — `grep -nE 'starter|template' README.md SECURITY.md infra-notes.md` — counts and call sites drift over time.

| File | Action |
|---|---|
| `README.md` | Rebrand the hero: the title at the top is a **shieldcn header image**, not a markdown heading — update `title=starter` (and the subtitle if desired) in **both** the `<source>` and `<img>` URLs of the `<picture>` block, plus the `alt` text. The stack badge row below it describes the tech stack and stays accurate as-is; keep or trim it as the user prefers. Replace the description sentence. Replace **all** docker tags (`docker build -t starter-server …` / `starter-worker …` / `docker run … starter-server`) with `<slug>-server` / `<slug>-worker`. Replace both `postgresql://...:5432/starter` connection-string examples. Replace local dev URLs (`https://starter.localhost`, `https://api.starter.localhost`) with the chosen portless names. Update import examples like `import { Button } from "@starter/ui/...";`. Update the directory-tree heading `starter/` → `<slug>/`. The `@starter/env/*` references in the env-vars section get rewritten by the global `@starter/` replacement in step 1d. Rewrite anything that describes the repo as a template — including the **License** section, which describes the template vendor's commercial license: replace it with the app's own license statement (see step 5). |
| `SECURITY.md` | Rewrite the template-speak: the "Template updates" section ("one-shot starting point… no pull-updates path") and "Defaults baked into this template" describe a template vendor's repo, not a product. Keep the reporting process and the security-controls list (they remain true), but rephrase as *this app's* policy — e.g. "This project's maintainers patch security issues in …" / "Security controls shipped by default in this project". |
| `infra-notes.md` | Contains `@starter/*` and `starter` references throughout (mostly rewritten by step 1d's global replacement) — grep for leftover literal `starter` strings and fix them. |

## Step 5 — Remove template provenance & set the license

- **Add the app's own license.** The template itself is licensed under the commercial license you received when you purchased it — that license governs your use of the template but is **not** your app's license and does not belong in your repo. Ask the user what license the app should carry (a private/proprietary app typically uses none or a proprietary notice; an open-source app picks an OSS license), add the appropriate `LICENSE` file if any, update the `"license"` field to match in the root **and every workspace** `package.json` (they all ship as `"UNLICENSED"`, which is already correct for a proprietary app), and make the README **License** section describe the app's license — not the template's.

## Step 6 — Rename the companion Rust CLI (`apps/cli`)

**Skip this step if the CLI is deferred or removed in Phase 5 triage.** Initialize it before first use or publication; simply retaining its source does not require this work ([removable/cli.md](../removable/cli.md)).

The CLI ships as `mycli` with an `OWNER` placeholder — that's template provenance too. Rename it with its own init tool (it only rewrites files under `apps/cli`; requires the Rust toolchain — [rustup](https://rustup.rs), no sudo):

```bash
cd apps/cli
cargo xtask init --name <cli-name> --owner <github-owner> \
  --author "<author>" --description "<one-line CLI description>" --dry-run
# review the file list, then rerun without --dry-run, then:
cargo xtask sync-docs
```

`init` assumes the GitHub repo is named after the CLI; in this monorepo it usually isn't. Afterwards fix by hand the `repository` / `homepage` / `documentation` URLs in `apps/cli/Cargo.toml`, and the `<github-owner>/<cli-name>` repo references `init` produced in `apps/cli/README.md` (the install URLs) and `apps/cli/tap/README.md` (the `gh release download --repo` line), to point at the app's actual GitHub repo. Also update `apps/cli/README.md`'s shieldcn header image title and any remaining template-speak, and align the CLI's `LICENSE-MIT` / `LICENSE-APACHE` (they carry a `Your Name` copyright placeholder) with the app license decided in step 5 — for a proprietary app, replace them with the app's own licensing.

Verify from `apps/cli`:

```bash
cargo fmt --all --check
cargo test --workspace --all-targets --locked
cargo xtask sync-docs --check
grep -rn 'mycli\|OWNER' --exclude-dir=target . || echo clean
```

## Step 7 — Files to leave alone

Do **not** rename or rewrite these:

- **`CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`** — these are **generated** from `AGENTS.md` by `pnpm sync:agent-docs`. Edit `AGENTS.md` (it has `@starter/` references in the testing and assets sections — see step 1d), then run the sync script. The CI `agent-docs` job will fail if you commit drift. The same applies to `apps/cli/CLAUDE.md` / `apps/cli/.cursorrules` — generated from `apps/cli/AGENTS.md` by `cargo xtask sync-docs` in step 6.
- **`patterns/agent-tasks/rebrand.md`** — this file. It documents how to rename `@starter/*`, so it must keep the old strings.
- **`pnpm-lock.yaml`** — never edit by hand. It will be regenerated by `pnpm install` in step 1i. (Same for `apps/cli/Cargo.lock` — cargo maintains it.)

## Step 8 — Verify

```bash
pnpm install            # already run in 1i, but rerun if you touched package.json again
pnpm sync:agent-docs    # regenerates CLAUDE.md / .cursorrules / copilot-instructions.md
pnpm verify
```

Run install only if dependency manifests changed, and sync only if agent instructions changed. Verification must be clean. Common failure modes:

- `check-types` fails with `Cannot find module '@starter/...'` → you missed a `workspace:*` rewrite or an import. `grep -rn '@starter/' .` should return empty (other than this file).
- `agent-docs` CI job complains in step 1d → you forgot `pnpm sync:agent-docs` after editing `AGENTS.md`.
- `pnpm install` errors with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` → a workspace `package.json` still references the old scope.

For an explicitly requested full internal rename only, run the no-template-evidence sweep:

```bash
grep -rin 'starter' --exclude-dir=node_modules --exclude=pnpm-lock.yaml .
```

In full mode, inspect remaining hits against the agreed rename scope and fix omissions in code and working examples. This recipe intentionally preserves the old names. In the default display mode, internal scope, database, and container references are expected and do not fail verification.

Then sanity-check the runtime branding:

```bash
pnpm dev
```

- Open the web app: header should show `<name>`, the tab title should be `<name>`, the PWA install prompt should use `<name>`. (If they all show `App`, you forgot to set `VITE_APP_NAME` in `.env`.)
- Set up TOTP in settings: the QR code's issuer should be `<name>`.
- If the database/container rename was selected, `docker ps` should show `<slug>-postgres`.

## Step 9 — Final report

Report only the operations that were selected; explicitly say internal names were retained when using the default display path:

1. **Scope rename**: confirm `@starter/*` → `@<scope>/*` is done, and note that this file intentionally keeps the old scope.
2. **Display branding**: list every file you changed in steps 2–4 with line numbers.
3. **Database**: confirm the new DB name and **warn about the orphaned volume** if they had a running dev DB.
4. **Provenance & license**: state what license the app now carries (file + `package.json` field).
5. **PWA assets**: if `apps/web/public/pwa-*.png` and the favicon are still template defaults, say so — the user needs to regenerate them with `pnpm -F web generate-pwa-assets` after dropping in a new source icon.
6. **Landing copy**: if `home.title` / `home.description` in `packages/locales/src/en-US/common.json` are still placeholders, say so — writing real copy (then `pnpm i18n:translate`) is a pre-launch step.
7. **Build / typecheck / lint status**: one line each.
8. **Anything you skipped**: e.g. files you intentionally left with the old scope, or PWA icon regeneration.

## Anti-patterns

- **Don't** edit `pnpm-lock.yaml` by hand. Run `pnpm install` and let it regenerate.
- **Don't** rename the unscoped app names (`web`, `server`, `worker`) — they're referenced via `pnpm -F` in too many places and the rename has no benefit.
- **Don't** leave `@starter/ui/components/...` import examples in the patterns docs after a rename. The next agent will copy-paste them and break the build.
- **Don't** drop the existing Postgres volume to "clean up" after the rename. The user may have dev data they care about. Surface the rename and let them decide.
- **Don't** run `pnpm db:push` or `docker compose down -v` yourself. Both can destroy the user's local data.
