# Companion Rust CLI (`apps/cli`)

A production-minded Rust CLI that ships alongside the app — for products whose
users want a terminal client (sync agents, relay daemons, admin tooling,
CI integrations). It's a full starter: clap commands, TOML config,
shell completions, structured logging, stable exit codes, its own CI, and
cross-platform release automation (shell/PowerShell/Homebrew installers via
cargo-dist).

It is a **removable module**: decide in [getting-started](./getting-started.md)
Phase 5 whether the product needs it, and remove it via
[removable/cli.md](./removable/cli.md) if not. If you keep it, rename it during
the rebrand (see below).

## The contract with the monorepo

- **Outside the pnpm/Turborepo graph.** `apps/cli` has no `package.json` — pnpm
  and turbo skip it entirely; `pnpm build` / `pnpm lint` / `pnpm test` never
  touch it. Don't add a `package.json` to "integrate" it; the separation is
  deliberate (different toolchain, different release cadence).
- **Its own toolchain.** Rust stable via [rustup](https://rustup.rs)
  (`curl … rustup.rs | sh` installs to `$HOME`, no sudo). MSRV is pinned in
  `apps/cli/Cargo.toml` (`rust-version`) and enforced by CI.
- **Its own CI.** `.github/workflows/cli-ci.yml` runs fmt, clippy, tests
  (3 OSes), MSRV, cargo-deny, typos, docs drift, and policy greps — all with
  `working-directory: apps/cli`. `pr-checks.yml` (Node-side) does not gate Rust
  and vice versa.
- **Its own agent docs.** `apps/cli/AGENTS.md` is the canonical instruction
  file for CLI work — read it before changing anything there. Its `CLAUDE.md` /
  `.cursorrules` mirrors regenerate with `cargo xtask sync-docs` (drift fails
  CLI CI); this is separate from the root `pnpm sync:agent-docs`.
- **Not in the containers.** `.dockerignore` excludes `apps/cli`, so the app
  and worker images never see Rust sources and CLI-only commits don't
  invalidate Docker layer caches.
- **Its own dependency flow.** The pnpm catalog does not apply. Cargo deps are
  pinned in `apps/cli/Cargo.toml`/`Cargo.lock`, license/bans-gated by
  `apps/cli/deny.toml`, and bumped by a dedicated Dependabot cargo entry in
  `.github/dependabot.yml`.

## Everyday commands

```sh
cd apps/cli
cargo build
cargo run -- hello Ada
cargo test --workspace --all-targets --locked
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo fmt
```

Before handing off a CLI change, run the full gate (same as CI):

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --locked
cargo test --workspace --doc --locked
cargo xtask sync-docs --check
```

## Rebrand step — rename `mycli`

The CLI ships as `mycli` with an `OWNER` placeholder. As part of the Phase 5
rebrand ([agent-tasks/rebrand.md](./agent-tasks/rebrand.md)):

```sh
cd apps/cli
cargo xtask init --name <cli-name> --owner <github-owner> \
  --author "Name <email>" --description "One-line description." --dry-run
# review, then run again without --dry-run, then:
cargo xtask sync-docs
```

`init` only rewrites files under `apps/cli` and assumes the GitHub repo is
named after the CLI. In this monorepo it usually isn't — afterwards fix, by
hand, the `repository` / `homepage` / `documentation` URLs in
`apps/cli/Cargo.toml` and the `OWNER/mycli` repo references in
`apps/cli/README.md` and `apps/cli/tap/README.md` to point at the app's actual
GitHub repo. The `tap = "<owner>/homebrew-tap"` line in
`apps/cli/dist-workspace.toml` is rewritten by `init` and is correct as-is.

## Talking to the app's API

The server is a plain HTTP API, so the CLI calls it like any other client:

- **Auth**: the template ships cookie-session browser auth only. A CLI needs a
  credential the app does not have yet — an API key for headless use, or the
  OAuth 2.0 device-authorization flow (RFC 8628) for interactive logins. Adding
  either means a Better-Auth plugin, a Prisma model, an admin surface, and a
  gate on the plugin's own endpoints; decide it deliberately rather than
  assuming it is there.
- Keep the server base URL in the CLI's TOML config (`src/config.rs`), never
  hardcoded.
- Follow the CLI's own conventions for output: results to stdout (with
  `--json` support), diagnostics to stderr.

## Adding a command

See `apps/cli/AGENTS.md` → "Adding a command" — copy
`src/commands/hello.rs`, register it in `src/commands/mod.rs`, add the clap
variant in `src/cli.rs` and the match arm in `src/main.rs`, and add black-box
tests in `tests/cli.rs`.

For async (tokio), SQLite storage, or a ratatui TUI, follow the guides in
`apps/cli/docs/` instead of wiring them ad hoc.

## Releasing

Releases are manual and versioned in lockstep with the containers:

1. Bump `version` in `apps/cli/Cargo.toml`; merge to the default branch.
2. Run the root **Release** workflow (Actions tab) with `version = vX.Y.Z`.

The workflow validates the tag matches `apps/cli/Cargo.toml`, runs the
`release-preflight.yml` gate, publishes the app + worker + db-applier images to
GHCR, and builds/publishes the CLI's cross-platform artifacts as a GitHub
Release.
Homebrew tap publishing stays a manual copy step by default
(`apps/cli/tap/README.md`). Details: `apps/cli/docs/releasing.md`.

## Removing

[removable/cli.md](./removable/cli.md) — deletes `apps/cli`, the three CLI
workflows, and the handful of root-config references.
