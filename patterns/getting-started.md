# Getting Started — the one-time onboarding phase

> **This is the first thing that happens in a new project built from this template.** It is a guided conversation between **you (the agent)** and a developer who may not be technical. Your job is to walk the phases in order: Phase 0 readies the machine, Phase 1 captures the product decisions that shape everything built afterward, and the phases that follow turn those decisions into setup — hosting, roles, feature triage, build plan. Do not paste this document at them: read it yourself, then run it with them in plain language. Product definition (Phase 1) is asked one topic at a time; everything else that has a safe default is **proposed as one complete default set they confirm or override item by item** — they are never quizzed on thirty open questions. Write down every answer.

## Why this phase exists

This template ships a lot of working machinery (accounts and admin, background jobs, S3 assets, agentic chat, i18n, email, web push, PWA). A nontechnical developer with an AI agent can build something real on it — but only if the foundational decisions are made *before* feature work, not discovered halfway through. Every expensive mistake on this stack traces back to a decision that was never written down: a role that could see data it shouldn't, a feature half-built then ripped out, a hosting choice made under deadline.

The deliverable of this phase is **not code**. It is:

1. A working development machine.
2. A `./notes/` directory full of written product, user, and access decisions.
3. A hosting decision.
4. A list of features to use now, defer, or intentionally remove.
5. A build plan the harness can execute.

Only when those exist do you start building. Do not optimize the template before the developer has chosen the product shape; the hosting, storage, roles, removals, and build plan should all follow from that choice.

## How to run this phase

Work the phases below **in order**. Each phase ends with a written artifact. Do not move on until that artifact exists.

- **Ask what only they can answer; default the rest.** Phase 1 (what the app is) is a conversation, one topic at a time — a nontechnical developer won't absorb a 12-question wall. Everything after it that this doc gives a default for — hosting, the keep/defer/remove set, the standard access matrix, the dependent decisions — is proposed as one confirmable block per phase. **To override a default, they just name the item and the new choice** ("keep the mobile app", "no email at all", "we need staff roles"); you then update `./notes/` — and the access matrix, if roles changed — accordingly before moving on.
- **Write everything down.** Decisions live in `./notes/` (created in Phase 2), not chat history. Chat history is lost; `./notes/` is committed.
- **Flag business decisions explicitly.** When a choice is genuinely the developer's and has no safe default (pricing, what data to collect and retain, who can see what), say so clearly, present options with trade-offs in one sentence each, and record both the question and their answer.

---

## Phase 0 — The machine

Goal: a development machine that can run `pnpm dev`, Docker, and an agent harness. Do not skip checks because "it probably works" — verify each.

### 0.1 Operating system

Run `uname -s` (or check the platform).

- **macOS or Linux** → good. Continue.
- **Windows** → this stack is not happy on native Windows (Prisma, Docker socket paths, shell scripts). Two supported paths — present both, recommend the first:

  **Option A (recommended): WSL2 + Ubuntu.** Have the developer run, in **PowerShell as Administrator**:

  ```powershell
  wsl --install -d Ubuntu
  ```

  Then walk this checklist with them, one step at a time:

  1. **Reboot when the installer asks.** WSL2 isn't actually installed until Windows restarts.
  2. After the reboot an Ubuntu window opens: pick a UNIX username and password there (memorable is fine; it never leaves the machine).
  3. In PowerShell (no admin needed now), verify: `wsl --status` should name Ubuntu as the default distribution and version 2 as the default. If it says version 1, run `wsl --set-default-version 2`.
  4. **Re-clone (or re-unzip) the project into the Linux filesystem** — in the Ubuntu shell, `mkdir -p ~/projects` and clone the repo to `~/projects/<name>`. The project must live under the Linux filesystem (`~/projects/...`), **not** `/mnt/c/...` — file watching and performance are broken across the Windows mount, and a repo that starts on `/mnt/c` keeps those problems even after everything else is correct.
  5. From here on, every command in this template runs in the Ubuntu shell, not PowerShell. If their editor/harness supports a "connect to WSL" / remote mode, have them use it so the agent runs inside Linux too.

  Your agent can verify the result: `wsl --status` reports version 2, and inside Ubuntu `uname -s` prints `Linux` and `git -C ~/projects/<name> status` works — any path still containing `/mnt/c/` means step 4 was skipped.

  **Option B: a cloud VPS running Ubuntu.** Good when their machine is locked down or underpowered. Walk them through:
  1. Create an account at a provider (DigitalOcean, Hetzner, Vultr, Linode are all fine — Hetzner is cheapest, DigitalOcean has the friendliest UI).
  2. Create an Ubuntu 24.04 LTS server. 2 vCPU / 4 GB RAM is the realistic floor for this stack (Postgres + Redis + two Node apps + a build); 8 GB is comfortable.
  3. Add an SSH key during creation (the provider's UI explains how; on their machine `ssh-keygen -t ed25519` then paste the `.pub`).
  4. SSH in: `ssh root@<server-ip>`.
  5. Create a non-root user and continue Phase 0 as that user. (Provider quickstart docs cover `adduser` + `usermod -aG sudo`.)

  Do **not** run the VPS setup end-to-end without the developer — account creation, billing, and SSH key handling are theirs. Guide, don't drive.

### 0.2 Node, via nvm

Check: `node --version`. Need **24.11+ or 26+**; the production Docker images build on `node:24-slim`, and local development should match that major. Node 25 is unsupported by the build and test tools.

If missing or too old, recommend nvm (per-user, no `sudo`, easy to upgrade later). Tell the developer to run these themselves (the agent should not edit shell profiles):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# then open a NEW terminal (or source ~/.nvm/nvm.sh), then:
nvm install 24
nvm use 24
nvm alias default 24
```

Re-check `node --version` in a fresh shell before continuing.

### 0.3 pnpm, via corepack

This repo pins its package manager in `package.json` (`packageManager` field). The correct way to get the matching pnpm is corepack, which ships with Node:

```bash
corepack enable
```

If `corepack enable` prints a permission error (common on system-wide Node installs), that is exactly why we recommend nvm in 0.2 — with nvm, corepack writes into the per-user Node dir and needs no `sudo`. Do not tell the developer to `sudo corepack enable`; fix the Node install instead.

Verify from the repo root: `pnpm --version` succeeds and matches the `packageManager` line in `package.json`. Do not run `corepack prepare pnpm@latest --activate`; "latest" can move past the version this repo pins.

If the developer plans to run the mobile app, note that `pnpm run setup` also creates `apps/native/.env` from `apps/native/.env.example`. The API URL in `EXPO_PUBLIC_SERVER_URL` must be reachable from the chosen target: `http://localhost:3000` for the iOS simulator or Expo web, `http://10.0.2.2:3000` for the Android emulator, and a LAN/tunnel URL for physical devices.

Before `pnpm install`, check for a stale cross-OS pnpm home. This usually happens after copying shell profiles between macOS, Linux, WSL, or dev containers:

```bash
printf '%s\n' "${PNPM_HOME:-<unset>}"
```

`PNPM_HOME` is safe to leave unset. If it is set, it must point at a path that exists on the current OS. For example, `/Users/...` is macOS-only and will break Linux/WSL with errors like `ENOENT: no such file or directory, mkdir '/Users'`. On Linux/WSL, fix the current shell with:

```bash
unset PNPM_HOME
mkdir -p "$HOME/.local/share/pnpm"
```

Then remove or correct the stale `export PNPM_HOME=...` line in the developer's shell profile (`~/.zshrc`, `~/.bashrc`, `~/.profile`, etc.) before opening a new shell. Do not commit a project `.npmrc` with a machine-specific store path to paper over this; fix the user-level pnpm environment.

### 0.4 An agent harness

The developer needs an agentic coding harness to do the build with. If they are reading this, they likely already have one — confirm which and note it. Any of these work; the template is harness-agnostic (`AGENTS.md` is the source, and `pnpm sync:agent-docs` mirrors it into `CLAUDE.md`, `.cursorrules`, and `.github/copilot-instructions.md`):

- Claude Code, Codex (OpenAI), opencode, droid (Factory), GitHub Copilot CLI, Cursor — or whatever they prefer.

If they don't have one, ask which they want and point them at that tool's install docs. Do not install it for them silently. Note the chosen harness in `./notes/00-environment.md` (Phase 2) — it changes how Phase 6 (the build plan) is wired.

If the harness is Claude Code: `pnpm run setup` (Phase 0.8) writes a personal `.claude/settings.json` that turns on the repo's safety hook (`pnpm claude:hooks:install` does it on its own). The first time Claude Code opens the repo afterwards it asks whether to trust those hooks. Say yes. That prompt is the safety net turning on — the hook blocks the AGENTS.md Dangerous Commands list before they run. See [claude-code-setup](./claude-code-setup.md).

### 0.5 Docker or Podman (with compose)

Local Postgres and Redis run in containers, and the agent-UI-testing flow ([agent-ui-testing.md](./agent-ui-testing.md)) boots a disposable stack. Check: `docker --version && docker compose version` (or `podman --version && podman compose version`).

If missing:
- **macOS:** Docker Desktop (or `brew install --cask docker`). Podman Desktop also works. Installing is not running — on macOS the developer must launch Docker Desktop itself (offer to enable "Start Docker Desktop when you sign in") before `pnpm dev:services` will connect.
- **Linux / WSL2 Ubuntu:** Docker Engine via the official convenience script is the least painful and needs no interactive `apt`:
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER   # then log out and back in (or `newgrp docker`)
  ```
  This one `sudo` is unavoidable for Docker Engine — present the block and let the developer run it; do not run `sudo` yourself (Agent Safety Rules). Podman is the rootless alternative if they cannot use `sudo` at all (`CONTAINER_RUNTIME=podman` is honored by the dev scripts).

Verify the daemon actually runs: `docker run --rm hello-world` (or `podman run --rm hello-world`).

### 0.6 GitHub CLI (recommended)

`gh` makes repo creation, PRs, and CI status one command, and several patterns assume it. Check `gh --version` then `gh auth status`.

Install (no `sudo` paths exist per-OS — `brew install gh` on macOS; on Ubuntu the official apt repo needs `sudo`, so for a no-sudo machine use the prebuilt binary or `webi`). Then the developer authenticates interactively:

```bash
gh auth login
```

This is theirs to run (it opens a browser / asks for a device code). If they do not have a GitHub account, guide them through creating one first.

If the template arrived as an archive download rather than a clone, there is no `.git` directory yet — initialize the repository first (this must happen before `pnpm install`, whose postinstall registers git hooks via lefthook):

```bash
git init
git add -A
git commit -m "Initial commit from template"
```

Then help them create a private repo and push this template there before feature work starts:

```bash
git status
gh repo create <repo-name> --private --source=. --remote=origin --push
```

If they decline `gh`, that's fine — guide them through creating a private GitHub repo in the browser, then add the remote and push:

```bash
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
```

If their branch is named `master`, push `master` instead of `main`. Record the repo URL in `./notes/00-environment.md`.

### 0.7 Portless

`pnpm dev` uses [`portless`](https://www.npmjs.com/package/portless) to expose
local apps at stable `https://*.localhost` hostnames without making the
developer pick ports. Treat it like Docker or `gh`: it is a global machine
tool, not an app dependency.

Check:

```bash
portless --version
```

If missing, have the developer install it globally:

```bash
npm install -g portless
```

Then run the trust/proxy setup the CLI asks for. If it requests elevated
permissions to bind 443 or trust its local CA, the developer runs that command;
the agent must not run `sudo` itself. Record in `./notes/00-environment.md`
whether portless is installed and whether the proxy is configured.

### 0.8 Prove the environment

From the repo root:

```bash
pnpm install
pnpm run setup    # idempotent: creates root .env, generates BETTER_AUTH_SECRET, asks for the developer's email (-> ADMIN_EMAILS), points SMTP at the mailpit sink, starts Postgres/Redis/mailpit, pushes schema (use `run` — bare `pnpm setup` can hit pnpm's builtin instead)
cp -n apps/web/.env.example apps/web/.env
pnpm doctor       # validates env, DB, Redis, (optional) SMTP — exits non-zero with hints
pnpm dev          # app should come up; visit the printed portless URL
```

`pnpm run setup` asks for the developer's email and writes it to `ADMIN_EMAILS` in `.env`, because that address is what makes their first local sign-up become the admin (see 0.9) — ask them for it before running setup if you (the agent) are driving this from a non-interactive shell, and pass it through with `pnpm run setup --admin-email <their-email>` (or `ADMIN_EMAIL=<their-email> pnpm run setup`); a bare non-interactive run just skips the prompt and leaves `ADMIN_EMAILS` for 0.9 to set by hand.

Use development-only environment variables here. Do **not** paste production secrets into local `.env` files: agents may need to inspect local config while debugging, and if they ever accidentally read a real secret, the developer must rotate it. Local `.env` files are gitignored and for disposable development credentials only; production secrets belong in the hosting provider's secret/env store.

### 0.9 First login — cut the first key before handing the app over

The template boots locked: `SIGNUP_ENABLED=false` (signup off) and no admin exists, so a fresh install has no way in. Say it plainly — "the app starts with the doors locked; here's how we cut the first key" — then walk the developer through first login:

1. `ADMIN_EMAILS` and the `SMTP_*` sink lines should already be set in the root `.env` by `pnpm run setup` (setup writes the admin email it prompted for, and points SMTP at the mailpit container `pnpm dev:services` started). Check both — if setup ran non-interactively with no email passed, set `ADMIN_EMAILS` to **their** real email by hand.
2. With `pnpm dev` running, they open the app and sign up with the exact `ADMIN_EMAILS` address — that address is the bootstrap allowlist, and the account it creates carries the admin role.
3. Signup enforces email verification; the message lands in mailpit at `http://localhost:8025`. They click the link and are in.

Do not flip `SIGNUP_ENABLED` to work around a failed first login — the bootstrap path above is the supported day-one route.

If `pnpm doctor` is green, `pnpm dev` serves a page, and 0.9 got them signed in, Phase 0 is done. **Write `./notes/00-environment.md`** (you'll create `./notes/` in Phase 2 — for now hold these facts): OS/WSL/VPS, Node version, pnpm version, container runtime, portless status, chosen harness, whether `gh` is authed, and the bootstrap admin email + mailpit SMTP values from 0.9. This is the record of *how to reproduce this machine*.

---

## Phase 1 — What is the app?

Goal: an exhaustive, written product definition. The single biggest failure mode for a nontechnical+AI build is a fuzzy idea that mutates every session. Pin it down. Drive a structured conversation covering, at minimum:

1. **One-sentence purpose.** "What does this app do, for whom?" Push until it fits in a sentence.
2. **The core entities / data.** What *things* does it manage? (Users, orders, posts, properties, patients, lessons…). For each: what does it contain, who creates it, who edits it, what is it related to. This becomes the Prisma schema later — [schema-guidelines.md](./schema-guidelines.md).
3. **The features, by vertical.** Group features into coherent areas ("accounts", "billing", "messaging", "admin reporting"). For each feature: who triggers it, what it changes, what the success and failure look like.
4. **Out of scope (explicitly).** What is the developer *not* building in the first milestone? Writing this down is as important as the in-scope list — it's what stops scope creep mid-build.
5. **Content vs. structure.** Remember this template's rule: user-facing copy is i18n-managed, not hardcoded ([i18n.md](./i18n.md)) — every string goes through `t()` and lives in `packages/locales/`. Note which screens are "marketing/content" vs. "app" (functional).
6. **Business decisions you must escalate.** Any feature whose behavior depends on a policy choice — what data to collect and retain, what's free vs. paid, what an "approved" record means, refund rules, who gets notified — is the *developer's* call. Do not invent a default and move on. Write the question, present options with trade-offs, record their answer.
7. **Launch audience and data use.** As each feature comes up, identify launch regions, whether children or sensitive data are involved, and whether it sends data to tracking, email, AI, storage, or payment providers. Follow [launch-readiness](./launch-readiness.md). The agent proposes safe technical defaults (no tracking, replay, or marketing integration until needed) and identifies launch work; the owner answers product/policy questions. Do not make them discover these requirements themselves.

When a question is genuinely a business decision, say so out loud: *"This is a business decision, not a technical one — here are the options and what each implies, you choose."*

---

## Phase 2 — Set up `./notes/` and write the product definition

Create the decision record. This directory is committed and is the source of truth for the build.

```bash
mkdir -p notes
```

Structure it by vertical (one folder per feature area from Phase 1), plus a few cross-cutting files:

```
notes/
  00-environment.md      # Phase 0 machine facts
  01-product.md          # one-sentence purpose, entities, in/out of scope
  02-users-and-roles.md  # Phase 3 — the access matrix (security-critical)
  03-hosting.md          # Phase 4 — chosen platform + why + backup profile
  04-features-kept.md    # Phase 5 — removable-feature triage decisions
  05-build-plan.md       # Phase 6 — how the harness will execute
  06-launch-readiness.md # applicability, owner decisions, blockers, and verification evidence
  verticals/
    accounts/README.md
    billing/README.md
    <vertical>/README.md # one folder per Phase 1 vertical, exhaustive
```

> If the developer's harness has its own first-class plan/notes mechanism (a plan file, a tasks system, a `/ goal`-style command), you may use that *in addition*, but `./notes/` is the durable, harness-independent record — always write it. A plan that only lives in one harness's memory is lost the moment they switch tools or the context resets.

Each `verticals/<name>/README.md` documents that area exhaustively: the entities it owns, every feature, the rules, the open business questions and their resolved answers, and the user roles that touch it (forward-reference Phase 3). "Exhaustive" is the bar — if a future session would have to guess, it isn't done.

Commit `./notes/` now and after every phase. It is project memory, not scratch.

---

## Phase 3 — Users, roles, and the access matrix (security-critical)

> **Be diligent here. This is the single highest-stakes part of onboarding.** Getting the access matrix wrong is how nontechnical+AI builds leak data. The Agent Safety Rules in AGENTS.md forbid weakening auth — this phase is where you make sure auth is *specified correctly in the first place*.

### 3.1 Enumerate every user type

Ask: "Who are all the different kinds of people who will use this?" Push for completeness — but only when the answer is more than the standard shape. Typical buckets — adapt to their domain:

- **Anonymous public** (no account) — what can they see?
- **Authenticated user** (has an account) — the default logged-in person.
- **Staff roles** — these are usually domain-specific and the developer must enumerate them: e.g. HR, associate, partner, manager, support agent, instructor, dispatcher. Do not assume; ask.
- **Admin** — full operational control. This template gates admin via `ADMIN_EMAILS` and the 404-hidden `/admin` group ([admin-dashboard.md](./admin-dashboard.md)).
- **Developer/operator** — whoever deploys and runs it. Not an app role; note it for hosting.

**The standard shape is the default.** Most first apps need exactly three app roles: anonymous public, authenticated user, admin. If Phase 1 turned up no domain-specific staff roles, say so — "most apps like this need just visitors, signed-in users, and an admin (you)" — get a yes, and pre-fill the default matrix in 3.2. The full enumeration above is required only when the product defines custom staff roles; then every one of them gets named and filled in deliberately.

### 3.2 Build the access matrix

For **every feature from Phase 1 × every role from 3.1**, record one of: **none / read / write / full**. Put this table in `notes/02-users-and-roles.md`.

**Start from the default matrix — you draft it; the developer never reviews the raw table.** With the standard three roles, pre-fill this shape, then replace the product rows with the Phase 1 verticals, one row per meaningful action (`—` enforcing cells are the not-level-checked case below; fill them in as verticals name procedures):

| Feature | Status | Anonymous | User | Admin | Enforcing procedure |
|---|---|---|---|---|---|
| View the public landing page | implemented | read | read | read | — |
| Manage their own account (email, password, sessions) | implemented | none | own | full | — |
| Use the app's product features (one row per vertical) | planned | none | read/write | full | — |
| Admin dashboard and user management | implemented | none | none | full | `users.list` |

**What the developer confirms is a short run of plain-language questions you derive from the draft, one vertical at a time:** *"Can signed-in users see each other's orders?"*, *"Should someone who isn't signed in see this at all?"*, *"Who can delete a booking?"* You translate each answer into the matrix cells yourself — never hand them a table of `Status` values and procedure tokens to approve; they cannot evaluate those.

**Custom staff roles have no default.** If the product defines them, add one `Staff:<Role>` column per role ([custom-roles.md](./custom-roles.md)) and fill **every** feature × role cell deliberately, splitting "own" from "all" access into separate rows — the rules below apply, just with more columns.

**Everything from here to the end of 3.2 is yours to implement, not the developer's to read.** The column names, cell vocabulary, `Status` values, and procedure tokens below are requirements on the matrix *you* write and what CI verifies — the developer has already answered the plain-language questions above; you encode their answers here.

**The `Enforcing procedure` column is checked in CI.** `pnpm policy:access-matrix` parses this table, derives the minimum required level from the cells (anonymous granted → `public`; anonymous denied but some other role granted → `authenticated`; Admin-only → `admin`), then parses `packages/api/src/routers/**` and fails the build if an implemented procedure's builder is weaker than the row demands — an Admin-only row enforced by `protectedProcedure`, or an authenticated row enforced by `publicProcedure`. Fill it with backticked `router.procedure` tokens, comma-separated if a row needs more than one. The check cannot see ownership scoping inside a handler ("own orders" vs "all orders" look identical to it) — that still needs tests.

**Plan before implementation.** Use `Status: planned` for a feature that has no live procedure yet. Its permissions are still specified and vocabulary-checked; its enforcing cell may name future procedures or remain `—` until the implementation plan chooses names. An all-planned matrix passes onboarding while the shipped endpoint baseline remains enforced. Mark the row `implemented` in the same change that registers its procedure. A planned binding that already exists in the live router fails, even if another implemented row also names it.

**Every live product procedure needs an implemented binding.** Once notes exist, a procedure outside the shipped baseline fails verification unless an implemented row names it. Leaving it out, mentioning it in prose, or leaving it planned cannot bypass this check. An explicit status cell must be `planned` or `implemented`; blank or unknown values fail. An implemented row with an empty enforcing cell is reported as *not level-checked* (for example, Better-Auth's non-oRPC endpoints need their own tests), and it never covers a live oRPC procedure. A matrix with neither level-checked rows nor exclusively planned rows still fails.

Your matrix **adds to, rather than replaces,** `scripts/access-matrix-pre-notes-baseline.json`: that reviewed endpoint floor remains enforced after onboarding, so omitting a shipped endpoint from the product matrix cannot downgrade it. When intentionally removing a feature, delete only its exact baseline entries in the same reviewed change, following its `patterns/removable/*` recipe; never regenerate or auto-rebaseline the file.

**A `Staff:<Role>`-only row is level-checked to `authenticated`, not to the role.** "Staff:HR full, User none" and "any signed-in user" are the same builder from outside the handler, so the gate proves the caller is *signed in* and stops there — it reports how many such rows it found for exactly that reason. What proves the role is a registered middleware plus tests: enforce it with `.use(requireRole("hr"))` registered in `middlewareAccessLevels` and cover the row with the per-role tests in [custom-roles.md § When to create a middleware](./custom-roles.md#when-to-create-a-middleware).

**Column names are the contract.** Columns are matched by name, never by position, so you may order them however reads best — but every name must be one the check knows, or the run fails with the header quoted:

| Column | Required | Accepted names |
|---|---|---|
| Feature | yes | anything starting with `Feature` |
| Status | yes | `Status`; values `planned` or `implemented` |
| Anonymous | yes | `Anonymous`, `Public`, `Guest`, `Visitor`, `Unauthenticated`, `Logged out`, `Signed out` |
| Authenticated | yes, ≥1 | `User`, `Authenticated`, `Member`, `Registered user`, `Logged in`, `Signed in` — plus one column per custom role, written `Staff:<Role>` or `Role:<Role>` ([custom-roles.md](./custom-roles.md)) |
| Admin | yes | any heading starting with `Admin` (or `Administrator` / `Superadmin`) |
| Enforcing procedure | yes | anything starting with `Enforc` |
| Notes | no | `Notes`, `Note`, `Comments`, `Risk`, `Rationale` — free prose, ignored by the check |

**Cell vocabulary.** Every role cell must be written with these words (combine granted words with `/`, e.g. `read/write`); anything else fails the run naming the row and the cell:

| Meaning | Write one of |
|---|---|
| Denied | `none`, `no`, `n/a`, `na`, `-`, `—` (em dash), `–` (en dash), `❌`, or an empty cell |
| Granted | `read`, `write`, `full`, `own`, `yes`, `✓`, `✔`, `✅` |

Do **not** write `x` or `✗`: in the wild an "X" means *granted* about as often as *denied*, so the check rejects it in both directions rather than risk reading your whole matrix with the polarity inverted. Put prose ("only their own", "⚠️ PII") in the `Notes` column, not in a role cell.

Rules while filling it in:

- **Default deny.** If a cell is unspecified, it is `none`. Make the developer say "yes, this role can do this" explicitly for every non-`none` cell.
- **Prefer overly granular rows.** If "write" includes multiple meaningful actions — create, edit, delete, approve, publish, refund, invite, impersonate, export, bulk update — split them into separate rows. A long precise matrix is safer than a short permissive one.
- **Separate "own" from "all".** "A user can see orders" almost always means *their own*. "Read all" is a different, higher privilege — never conflate them.
- **Name the boundary in code terms.** Each row maps to a procedure level in [server-procedures.md](./server-procedures.md), a custom role check from [custom-roles.md](./custom-roles.md), and a route gate in [auth-and-routing.md](./auth-and-routing.md): `publicProcedure` (anonymous), `protectedProcedure` (any authed user), `authenticatedProcedure` (auth without the force-2FA gate, rare), role-checked, or `adminOr404Procedure` (admin). Put that procedure in the `Enforcing procedure` column so the builder has no ambiguity and CI can check it. The matrix is a specification, not enforcement by itself; the build plan must include the middleware/tests that make each non-`none` row true.
- **Call out the dangerous rows.** Anything where one role can see or mutate another user's data, or money moves, or PII is exposed — mark it ⚠️ and write a sentence on how it's enforced and what the failure mode is.

This matrix is a hard input to every feature the harness builds. A procedure that doesn't match it is a security bug, not a style nit.

If the product needs a public site while the operations app must have no public
ingress, record that as a hosting/access decision in `notes/` now — the anonymous
field allowlist, freshness/revocation promise, media delivery, and the
private-ingress mechanism are design decisions, not details to defer until
implementation.

---

## Phase 4 — Hosting strategy

Goal: a hosting decision with its dependent defaults written in `notes/03-hosting.md`, before building, because it shapes asset/email/secret decisions. **Default: Dokploy on a VPS** ([deployment-vps.md](./deployment-vps.md)) — the primary documented target — presented as one confirmable default, not a platform comparison, with the operational responsibility stated plainly:

> **Hosting default — the trade-off to say to the developer, in one breath.** The default is a small rented server (a VPS, roughly €4–10/month all-in) running Dokploy: on that path **you own everything** — OS patching, database upgrades, backups and restore drills, disk space — and no platform takes care of any of it for you. Managed platforms exist that take over most of that list for more money, but this template does not document any of them, so choosing one means writing the deploy runbook yourself. Confirm the default, record it and why in `notes/03-hosting.md`, and move on.

> **Agent-facing mechanics of the default** (your checklist, not user conversation material). Applications build directly from Git: development auto-deploys `main`/`master`, production deployments are manual and pinned to one reviewed immutable Git tag. Each environment gets its own Postgres, Redis, auth secrets, and origin; Let's Encrypt TLS is automatic. Prefer a db-applier Application (ordinary Replicated mode, one replica, restart condition none); server/worker startup waits for a matching successful schema apply; jobs run embedded unless a dedicated worker is selected. Generate the reviewable settings checklist with `node --import tsx scripts/generate-dokploy-config.ts` (arguments in the deployment guide). Read [infra-notes.md](../infra-notes.md) once so you can answer their questions. Dokploy keeps its selected leader `safe` on ordinary Git deployments. If the developer insists on a different platform, the `APPLY_SCHEMA` / `WAIT_FOR_SCHEMA` contract in [infra-notes.md](../infra-notes.md) is portable — the walkthrough is not; say so plainly rather than improvising one.

- **Email (SMTP).** Default: no real provider — the mailpit sink from Phase 0.9 captures verification email locally, and real users get nothing until a provider exists. When production email matters (verification, password reset, transactional mail), have the developer create an account at **Resend** (`smtp.resend.com`), **Postmark** (`smtp.postmarkapp.com`), or **Amazon SES** (its region SMTP endpoint), verify their sending domain in that provider's dashboard (SES additionally needs production-mode approval to leave its sandbox), and put the issued credentials in the root env: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. The agent can walk them through account creation and the DNS records. Not wanting email at all is a Phase 5 override.
- **Object storage (S3-compatible).** Default: off until the first upload feature ships. When it arrives, the developer creates an account with any S3-compatible provider (AWS S3, Cloudflare R2, MinIO), creates a bucket plus API credentials there, and the agent walks them through putting those in the root env: `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, plus `S3_ENDPOINT` for non-AWS providers. Quick starts in [assets.md](./assets.md).
- **Domain name.** The one dependent item that eventually needs their input: Dokploy wants a domain (or subdomain) pointed at the VPS's IP, and TLS is then automatic. Default: build and deploy on a throwaway subdomain of a domain they already own, attach the real one before launch.
- **Secrets.** Never hardcoded, always via `packages/env` and the platform's env/secret store. Default: production values are minted at deploy time with **`pnpm generate:secrets --target vps`** — it prompts only for what it can't know and validates against the real Zod schemas; see [environment-variables.md](./environment-variables.md). Locally, `pnpm run setup` already minted disposable dev secrets.
- **Signup, bootstrap, and SSO promotion.** Default: stays as shipped, `SIGNUP_ENABLED=false` — intentional for internal tools; it blocks email/password self-signup and SSO just-in-time provisioning. Bootstrap admin through the documented `ADMIN_EMAILS` email/password path, then invite everyone else; flip signup on only for customer-facing products that intentionally allow public registration and have SMTP configured. SSO-created users are never auto-promoted from `ADMIN_EMAILS` — the developer (default) approves the first SSO admin; record who.
- **LLM spend controls.** Two features can call an LLM, and neither is on by default: `pnpm i18n:translate` (a build-time script that fills the locale bundles) and the agentic chat surface (`CHAT_ENABLED`). Both read `OPENROUTER_API_KEY`. If either is enabled, the developer creates an OpenRouter account and sets a **credit limit in its dashboard** before launch — this template documents cost expectations and rate-limits chat per user, but ships no in-app spend cap. Chat is the one that scales with traffic; translation is a cost you pay once per batch of new keys.
- **Backups.** On the Dokploy default, nothing backs the database up until you configure it. Default profile: full logical backups to S3-compatible storage on the in-container schedule, configured and recorded in `notes/03-hosting.md` before production traffic, plus one restore drill against a throwaway database ([backup-and-restore.md](./backup-and-restore.md)). There is no provider fallback here — a VPS Postgres container that nobody dumps is data with no second copy. Say that out loud.
- **Budget expectation.** State the monthly floor now, not at launch: a Dokploy VPS is roughly €4–10/month all-in, plus whatever object storage the backups and any uploads use (cents to a couple of dollars at small scale).

### Deploy triage for agents

If the first deploy fails, do not ask the developer to "check the logs" with no instructions. Use the deployment logs — Dokploy shows them per application in the deployment detail view — then triage these common failures:

| Symptom / log text | Likely fix |
|---|---|
| Pushed to the default branch but nothing changed in production | Expected on Dokploy: production deployments are manual. Development follows the default branch automatically. Select the reviewed production tag and follow [deployment-vps.md § 10. Git builds and deployment checks](./deployment-vps.md#10-git-builds-and-deployment-checks). |
| Schema changed in Git but production DB unchanged | On Dokploy, deploy the designated leader with `APPLY_SCHEMA=safe`, confirm the newly created task completed, then deploy runtimes. Ordinary native Git deployments keep `safe` on that one leader and followers `off` with `WAIT_FOR_SCHEMA=true`. See [infra-notes.md § Deploy workflow](../infra-notes.md#deploy-workflow). |
| `BETTER_AUTH_URL` mismatch, cookies not sticking, OAuth callback rejected | Set `BETTER_AUTH_URL` to the exact public origin, including scheme and `www` choice: `https://app.example.com`, not `http://`, not a different subdomain. |
| SMTP validation failure in production | Either configure `SMTP_*` or keep `SIGNUP_ENABLED=false` until email is ready. |
| `APPLY_SCHEMA=... is invalid` | Use only `off`, `safe`, or `dangerous`; unset behaves as `off`. |
| Schema startup gate timed out | Check the selected leader's new task, matching Git refs, live-schema drift, and db-applier `status`. A previous receipt or a green Dokploy build notification does not prove the new schema was applied. Never disable the gate to make startup pass. |
| Asset/upload failures | Confirm `S3_BUCKET`, credentials, endpoint, and bucket CORS. Provider quick starts (including Cloudflare R2) and the CORS policy are in [assets.md](./assets.md). |
| Worker connects but jobs stick | Confirm `REDIS_URL` is identical on server and worker, and that Redis keeps `maxmemory-policy noeviction` when a memory cap is set (managed Redis providers usually ship `maxmemoryPolicy: noeviction` on request). |

---

## Phase 5 — Keep-or-remove triage

This template ships features many apps don't need. Present the default set below in one pass and ask the developer to confirm it or name exceptions; record **use now**, **defer**, or **remove** per feature in `notes/04-features-kept.md`. Deferring a client or an opt-in feature keeps its source available without making physical removal a prerequisite to the first feature. A deferred feature that still exposes an enabled API is still part of the security surface; record that fact and review it before launch. Use existing feature flags only where they exist; do not invent a flag or claim that a note disables code. Physical removal is a separate, explicitly chosen maintenance task using the relevant recipe:

| Feature | Keep if… | Remove via |
|---|---|---|
| i18n (`/$lang/`, bundle auto-translation) | you ship in more than one language | [removable/i18n.md](./removable/i18n.md) |
| BullMQ jobs + worker (shared Redis stays) | you have background work: image analysis, cleanup sweeps, chat runs, scheduled jobs | [removable/queue.md](./removable/queue.md) |
| Email / SMTP | you need verification or transactional mail | [removable/email.md](./removable/email.md) |
| Web push | you send push notifications | [removable/push.md](./removable/push.md) |
| PWA / service worker | installable / offline matters | [removable/pwa.md](./removable/pwa.md) |
| Admin seed trigger (`/admin/seed`) | operators seed demo/staging data from the browser — the `prisma db seed` CLI stays either way | [removable/seed.md](./removable/seed.md) |
| Cookie-consent banner + analytics gate (ships **on**) | keep; consider removal only after the data inventory confirms no optional tracking/storage requires it | [consent.md § Removing the banner](./consent.md#removing-the-banner) |

**The default set** — what a typical first app ships with:

- **Keep:** email (accounts need verification, password reset, transactional mail), BullMQ jobs + worker (a dedicated worker container is a deployment choice, not a reason to delete queued features), i18n, PWA, and the assets pipeline — S3 itself stays off until the first upload feature (Phase 4).
- **Keep, review before launch:** web push and the admin seed trigger. Decide each from the product's requirements, and remove one only when that outcome is explicitly chosen.
- **Off until switched on:** agentic chat (`CHAT_ENABLED` + an LLM key) and S3 uploads (`S3_BUCKET`). These need no removal to stay out of the way — but a feature that is merely unconfigured is still code in the image, so if the product will never use it, say so in `notes/04-features-kept.md` rather than leaving it undecided.
- **Not shipped at all:** add-ins, not removals — built only when the product asks for them:
  - Admin MCP server (Claude Desktop / Claude Code tools over `/mcp`, with API-key or device-code credentials) — a standing admin credential surface: [add-ins/mcp-server.md](./add-ins/mcp-server.md).
  - Typed CMS (pages + posts). Landing copy stays in the i18n bundles until someone without repo access must author content weekly: [add-ins/cms.md](./add-ins/cms.md).
  - HLS video pipeline (upload, ffmpeg transcode, playback). S3 assets already cover images and files: [add-ins/video.md](./add-ins/video.md).

Complete a selected removal and all of its dependent edits as **one verified change**; a half-removed feature is not a valid checkpoint.

### The two optional clients — ask last, remove by default

Raise these at the **end** of the triage, after the rest of the set is confirmed, because both are whole applications and neither belongs in a first milestone unless the product genuinely requires it.

| Client | Keep if… | Remove via |
|---|---|---|
| Expo mobile app (`apps/native`) | you need a real App Store / Play Store presence — the PWA already covers installable mobile web | [removable/native.md](./removable/native.md) |
| Companion Rust CLI (`apps/cli`) | your users need a terminal client — a sync agent, local daemon, or admin/CI tooling | [removable/cli.md](./removable/cli.md) |

**The stated default for a first app is remove, for both.** Say it that way — "unless you're shipping to the App Store in this milestone, we take the mobile app out now" — rather than offering a neutral choice. Carrying an unused Expo app means an Expo SDK to keep coordinated and a native env for `pnpm doctor:native` to check; carrying an unused Rust CLI means a second toolchain and a second CI pipeline. Both are much cheaper to add back later than to maintain unused.

If the developer wants one kept but not yet built, that is a **defer**, not a keep: record it in `notes/04-features-kept.md`, do not launch or publish that client, and note that the Rust CLI needs `cargo xtask init` before anyone uses it ([cli.md](./cli.md)). Preview either removal with `pnpm template:remove native` / `pnpm template:remove cli`, which prints the inventory before touching anything.

Record **branding** here: display name, local subdomain, public domain, and any supplied icons/colors. Follow the default display-branding path in [agent-tasks/rebrand.md](./agent-tasks/rebrand.md). Keep internal `@starter/*` package names and local database/volume names by default; changing those does not improve the app experience and can break imports or disconnect local data. The full internal rename remains an opt-in task for a concrete naming requirement. Final artwork and marketing copy can be launch tasks; their absence need not delay the first working feature.

---

## Phase 6 — The build plan

Goal: `notes/05-build-plan.md` — an ordered list of work the harness will execute, derived from the verticals and the access matrix.

Sequence it sensibly:

1. **Display branding and selected setup** (Phase 5 decisions). Carry deferred modules forward; schedule only explicitly chosen removals, with their complete recipes and verification.
2. **Schema** — the entities from Phase 1, following [schema-guidelines.md](./schema-guidelines.md) and the [schema-changes-recipe.md](./schema-changes-recipe.md).
3. **Auth & roles** — wire the roles and gates from the Phase 3 matrix before any feature that depends on them.
4. **Verticals, one at a time** — each fully built, UI-tested ([agent-ui-testing.md](./agent-ui-testing.md)), and committed before the next. Before the first one, read [golden-path.md](./golden-path.md): it walks a shipped example feature end to end and names every file a vertical touches, in build order. The template's own `Projects` example is there to be copied and then deleted — its "Evolve or delete" section is the removal list.
5. **Production hardening and launch readiness** before launch — [production-hardening.md](./production-hardening.md), [launch-readiness.md](./launch-readiness.md), and [rate-limiting.md](./rate-limiting.md) if your app adds any surface that can be hit hard (media, search, public APIs). Create `notes/06-launch-readiness.md` during onboarding, track unresolved decisions and work there, and schedule the final evidence pass before production traffic. Applicable incomplete items block launch; an initial plan is not a sign-off.
6. **Deploy** — the Phase 4 platform.

**How to have the harness execute it** — pick based on the harness chosen in Phase 0:

- **Harness-native planning** (a `/ goal`-style command, a plan/todo system, a spec file the harness consumes): fine for work that fits in a session or two. Feed it `notes/05-build-plan.md` and the relevant `verticals/` files.
- **A sequential step plan** (whatever mechanism the harness offers for it): the right shape for a multi-vertical build that exceeds one session. The properties that matter, regardless of tool: each step starts with **fresh context** (a 10-step build shouldn't accumulate a whole session's noise), steps run **one at a time** (no two agents racing on the same files), and verification is a **first-class, non-skippable step** after every vertical — not an afterthought. A typical plan:

  ```text
  1. Feature configuration     — per notes/04-features-kept.md, configure enabled features; record deferred modules.
  2. Display branding          — apply the default path in patterns/agent-tasks/rebrand.md with the name/colors in notes/.
  3. Schema                     — model entities from notes/01-product.md per schema-guidelines.md; pnpm db:push.
  4. Auth & roles               — implement each feature's permissions; change its matrix row from planned to implemented with the procedure and tests.
  5. Vertical: accounts         — build per notes/verticals/accounts/README.md.
  6. Verify: accounts           — boot pnpm dev:docker on a free port, drive the UI with agent-browser, report console + a11y issues; fix.
     …one build+verify pair per vertical…
  N. Production hardening       — walk patterns/production-hardening.md and patterns/launch-readiness.md; resolve launch blockers and record evidence.
  ```

  Commit at the end of each step so every vertical lands as a reviewable unit.

Whatever the mechanism, every build step's instructions must point back at the relevant `notes/` file and the relevant `patterns/` recipe. The notes are the spec; the patterns are how.

---

## Phase 7 — Close out the getting-started phase

When Phases 0–6 are done — machine works, `./notes/` is written and committed, hosting chosen, triage decided, build plan exists — the project no longer needs the loud "start here" banner in `AGENTS.md`. Demote it to a normal reference so future sessions aren't told to re-onboard.

1. Open **`AGENTS.md`** (the canonical file — never edit the generated mirrors).
2. Find the section that begins with the heading **`## 🚦 First time in this repo? Start here.`** and contains the marker comment `<!-- getting-started:active … -->`. **Delete that entire section** (heading, blockquote, and marker comment).
3. Confirm the normal reference to the doc remains in the `## Patterns (read first)` section — today that is the sentence ending `First-time: [getting-started](./patterns/getting-started.md).` If the wording has drifted, what matters is that **some** link to `./patterns/getting-started.md` survives outside the deleted banner: `grep -n 'patterns/getting-started.md' AGENTS.md` must still return at least one hit. The doc stays a useful reference (re-running triage, onboarding a teammate); only the loud top-of-file banner goes away.
4. Regenerate the harness mirrors so `CLAUDE.md` / `.cursorrules` match:
   ```bash
   pnpm sync:agent-docs
   ```
5. Clear any fork-local planning notes that should not steer the app after onboarding. The template itself should not ship template-internal TODOs, prompt queues, or app-specific `notes/`.
6. **Template-maintainer CI leftovers.** `.github/workflows/nightly-tooling.yml` is the template author's self-test cron — it self-skips now that `notes/` exists, but delete it too (one less workflow, zero minutes) unless the developer is maintaining a template fork. `cli-ci.yml` stays only if the Rust CLI was kept.
7. Commit: `AGENTS.md`, the regenerated mirrors, and the full `./notes/` directory together. Message e.g. `chore: complete getting-started onboarding`.

After this, the build proceeds from `notes/05-build-plan.md`. The onboarding phase is over.

---

## Other considerations to raise with the developer

Things a nontechnical developer won't think to ask but will regret skipping. Surface the relevant ones during the phases above:

- **Source control hygiene.** A real git repo, on a remote, from day one — work is committed every step (every `./notes/` change, every vertical). Phase 0.6 covers GitHub account/repo setup and the first push. Never commit `.env`; only `.env.example` / `.env.docker.defaults` are tracked.
- **Secrets discipline.** No keys in code, `notes/`, commits, screenshots, or chat. Everything through `packages/env` and local/host env files. Say this explicitly — a nontechnical developer will paste an API key into a file if not told not to. Development uses disposable dev credentials; production secrets stay in the host secret store.
- **Data privacy & legal.** Follow [launch-readiness](./launch-readiness.md) during onboarding and before launch. Inventory actual data and processors, establish retention/request handling, and write truthful privacy information with links where collection occurs. Conditional requirements for children, sensitive data, tracking, marketing, subscriptions, AI, and uploads are agent-owned launch work, not optional suggestions left for the developer to discover. Record applicability, unresolved owner decisions, and verification evidence in `notes/06-launch-readiness.md`; do not invent legal approval or publish a placeholder policy as finished.
- **Accessibility & mobile.** This is a mobile-first PWA with hard rules (44px touch targets, reduced-motion, skeletons-not-spinners — see the PWA section of AGENTS.md; safe-area insets are handled in `globals.css`, not stated as a rule). `react-doctor` enforces a11y in CI. Set the expectation that these are requirements, not polish.
- **Don't over-scope the first milestone.** The most useful thing you can do for a nontechnical developer is hold the line on the Phase 1 "out of scope" list. Ship a small correct thing, then iterate. Record cut features in the backlog for a later milestone rather than building them "while we're here."
- **A maintenance rhythm.** Dependencies, security patches, and schema drift accumulate. Point them at [project-audit.md](./project-audit.md) as a periodic health check (and `/schedule` it if their harness supports recurring agents).
- **Testing expectations.** Server-side unit tests are the standard here ([testing.md](./testing.md)); tests must pass in CI with every external boundary mocked. Set this expectation before the build, not after the first red CI run.

## Anti-patterns

- **Don't** dump this document on the developer. Read it; *converse* it.
- **Don't** start writing features before `./notes/` exists and the access matrix is filled in. Unspecified roles are how data leaks.
- **Don't** re-ask what this doc already defaults. Present each default set once; only a named override reopens an item — and once overridden, write it into `./notes/` before moving on.
- **Don't** invent answers to business decisions to keep moving. Stop, present options, record their choice.
- **Don't** steer a nontechnical developer off the Dokploy/VPS default without walking them through the operational trade-off and recording their explicit choice. It is the only deploy target this repo documents; anywhere else, the runbook is theirs to write.
- **Don't** run `sudo`, edit shell profiles, create cloud accounts, or pipe installer scripts to a shell *for* the developer. Present the commands; they run the privileged/account ones.
- **Don't** leave the `## 🚦 First time…` banner in `AGENTS.md` once Phase 7's conditions are genuinely met — and don't remove it before they are.
- **Don't** treat `./notes/` as scratch. It is the committed spec the rest of the build reads from. Keep it current.
