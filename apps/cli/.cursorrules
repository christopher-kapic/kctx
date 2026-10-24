<!-- GENERATED FILE — DO NOT EDIT.
     Edit AGENTS.md, then run `cargo xtask sync-docs`. -->

# CLI agent & contributor guide

This file covers the Rust CLI under `apps/cli`. The repo-root `AGENTS.md` still
applies; use this file for CLI-specific conventions. Within this directory,
`CLAUDE.md` and `.cursorrules` are **generated copies** of this file.

> **Golden rule:** never edit the generated mirrors. Edit `AGENTS.md`, then run
> `cargo xtask sync-docs` (from `apps/cli`). CI fails if the mirrors drift
> (`sync-docs --check`).

---

## What this is

A companion Rust command-line tool that ships alongside the web app. The
template ships a small but complete example (`mycli hello`, `mycli config`,
`mycli completions`) plus the full machinery for shipping it: CI,
cross-platform release builds, and installers.

It is a **removable module**: if the product has no companion CLI, rip it out
via `patterns/removable/cli.md` during getting-started Phase 5. If you keep it,
rename it during the rebrand: run
`cargo xtask init --name <name> --owner <github-owner>` once from `apps/cli`,
then `cargo xtask sync-docs`. See `README.md` → "Start Here".

The CLI is intentionally **not** part of the pnpm/Turborepo graph — it has no
`package.json`, and `pnpm build` / `pnpm check-types` never touch it. All work
in here happens with `cargo`, run from `apps/cli`.

## Orientation — where things live

| Path | What's there |
|------|--------------|
| `src/lib.rs` | Shared implementation modules used by the binary and tests. |
| `src/main.rs` | Entry point: parse → init logging → dispatch → map errors to exit codes. Keep it thin. |
| `src/cli.rs` | All clap argument definitions. The *shape* of the CLI, no logic. |
| `src/commands/` | One file per subcommand, each exposing `Args` + `run(&Args)`. |
| `src/config.rs` | The TOML config struct, with `load()`/`save()`. |
| `src/paths.rs` | Cross-platform config/data directories (via `dirs`). |
| `src/logging.rs` | tracing setup. Logs go to **stderr**. |
| `src/exit.rs` | Stable process exit codes. |
| `tests/cli.rs` | Black-box tests that run the built binary. |
| `xtask/` | Project automation in Rust: `init`, `sync-docs`. Run via `cargo xtask`. |
| `docs/` | How to add optional pieces (tokio, SQLite, ratatui) and how releases work. |
| `tap/` | Notes for publishing the generated Homebrew formula. |

CLI CI lives at the **repo root**: `.github/workflows/cli-ci.yml` (checks),
`.github/workflows/release-preflight.yml` (pre-release gate), and the CLI jobs
in `.github/workflows/release.yml` (cargo-dist artifact builds). All of them run
cargo with `working-directory: apps/cli`.

## Setup & everyday commands

Run everything from `apps/cli`:

```sh
cargo build                       # build
cargo test                        # unit + integration tests
cargo clippy --workspace --all-targets --all-features -- -D warnings   # lint (warnings are errors)
cargo fmt                         # format (CI checks `cargo fmt --all --check`)
cargo run -- hello Ada            # run the CLI
cargo xtask sync-docs             # regenerate agent doc mirrors
```

Before you consider a change done, all of these must pass:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --locked
cargo test --workspace --doc --locked
cargo xtask sync-docs --check
```

(`cargo deny check` and `typos` also run in CI; install them with
`cargo install cargo-deny typos-cli` to check locally.)

---

## Agent safety rules (hard constraints)

These are non-negotiable. They exist because they're the mistakes that are
easy to make and expensive to undo. The repo-root Agent Safety Rules apply on
top of these.

1. **Never weaken the lint or CI gates to make a change "pass."** Do not add
   blanket `#[allow(...)]`, `// clippy::` overrides, or delete CI steps to get
   green. Fix the underlying issue. Narrow, commented `#[allow(...)]` on a
   single item is acceptable only with a one-line justification.
2. **Never bypass commit or CI checks** (`git commit --no-verify`, `--force`
   pushing to the default branch, editing generated files by hand).
3. **No `unsafe`.** It is `forbid`-den at the crate level. If you think you need
   it, stop and ask.
4. **No secrets in the repo.** No API keys, tokens, or credentials in source,
   tests, fixtures, or commit messages — even temporarily. If one is committed,
   flag it for rotation.
5. **Don't add dependencies casually.** Each new crate is attack surface,
   license risk, and build time. Prefer the standard library. Before adding one,
   confirm it's needed, check it passes `cargo deny check`, and mention it. See
   "Dependencies".
6. **Don't print to stdout for anything but command output.** Logs, progress,
   and diagnostics go to **stderr** (use `tracing`). stdout must stay clean so
   `--json` output can be piped. See "Conventions".
7. **No `unwrap()` / `panic!` / `todo!` / `dbg!` in non-test code.** Clippy
   enforces this. Use `?` with `anyhow::Context`, or `expect("reason")` only
   when the invariant is truly local and documented.
8. **Don't run destructive shell commands** (`rm -rf`, `git reset --hard`,
   force-push) or `sudo` on the user's behalf. Ask first.
9. **Don't create backup copies** (`*.bak`, `*.old`, `foo copy.rs`). Git is the
   backup. Edit in place.

## Conventions

- **Error handling.** Application code returns `anyhow::Result<T>`. Add context
  at each boundary: `.with_context(|| format!("reading `{}`", path.display()))`.
  Reserve `thiserror` for a stable public library API (see
  `docs/error-handling.md`).
- **Error messages.** Quote identifiers and paths in `` `backticks` ``, never
  'single quotes'. Lowercase, no trailing period: `` error: no profile named `default` ``.
- **Exit codes** are a public contract; see `src/exit.rs`. `0` success, `1`
  generic failure, `2` usage (clap), `3` not-found. To set a specific code,
  attach `CodedError::new(ExitCode::…)`.
- **stdout vs stderr.** Results → stdout. Everything else → stderr.
- **`--json`.** Any command that prints data should support `--json` and emit it
  from a typed `Serialize` struct (see `src/commands/hello.rs` and
  `src/commands/config.rs`), not hand-built strings. Declare the flag on the
  command's own `Args`; if the command has subcommands, add `global = true` so
  it works on either side of the subcommand. Use `src/output.rs` for stdout
  writes so command output stays deliberate and diagnostics stay on stderr.
- **Tests live next to code** (`#[cfg(test)] mod tests`) for pure logic, and in
  `tests/` for black-box CLI behavior. `.unwrap()` is fine in tests.
- **Talking to the app's API.** The server is a plain HTTP API. Call it with a
  small HTTP client (e.g. `ureq`) against its routes, and keep base URLs in the
  CLI's TOML config, never hardcoded. The app ships cookie-session browser auth
  only, so a headless credential (an API key, the device-authorization flow) is
  something you add first — see the repo-root `patterns/cli.md`.

## Adding a command

1. Copy `src/commands/hello.rs` to `src/commands/<name>.rs`; rename `Args`,
   write `run`.
2. Register the module in `src/commands/mod.rs`.
3. Add a variant to `Command` in `src/cli.rs` and a match arm in `src/main.rs`.
4. Add black-box tests in `tests/cli.rs`.

## Dependencies

- Versions live in `[dependencies]` in `Cargo.toml`. Keep the set small. The
  pnpm catalog does **not** apply here; Dependabot covers `apps/cli` with a
  dedicated cargo ecosystem entry in the root `.github/dependabot.yml`.
- Prefer crates that are widely used, actively maintained, and license-compatible
  with `deny.toml`'s allowlist (MIT/Apache/BSD/ISC/etc.).
- For async, storage, or a TUI, follow the guides in `docs/` rather than wiring
  them ad hoc — they keep feature flags and conventions consistent.

## Releasing

CLI releases are cut by the **root** `Release` GitHub Actions workflow
(`.github/workflows/release.yml`), which drives `dist` (cargo-dist). The flow:

1. Bump `version` in `apps/cli/Cargo.toml` and merge it to the default branch.
2. In GitHub Actions, run the **Release** workflow with `version = vX.Y.Z`. It
   validates the tag against `apps/cli/Cargo.toml`, runs the preflight gates,
   builds all platforms, generates installers + checksums, and publishes a
   GitHub Release. The Homebrew formula is generated as a release artifact;
   copying it into your tap is a manual step by default (see `tap/README.md`).

Release **orchestration** lives in the root `.github/workflows/release.yml`;
cargo-dist **artifact** settings (targets, installers, tap) live in
`dist-workspace.toml` here. When you change `dist-workspace.toml`, run
`dist generate` locally to inspect the generated workflow and port the relevant
changes into the root workflow deliberately — CI has no release-drift check.
See `docs/releasing.md`.
