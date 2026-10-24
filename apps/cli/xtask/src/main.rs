//! Project automation, in Rust (the `xtask` pattern).
//!
//! Run via the `cargo xtask` alias (see `.cargo/config.toml`):
//!
//!   cargo xtask init --name zap --owner your-name   # rename the template
//!   cargo xtask sync-docs                           # regenerate harness mirrors
//!   cargo xtask sync-docs --check                   # CI: fail on drift
//!
//! Written in Rust (not bash) so it behaves identically on every platform and
//! needs no tools beyond cargo.

mod init;
mod sync;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "xtask", about = "Project automation tasks")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// One-time: rename the template crate and fill in metadata.
    Init(init::Args),
    /// Regenerate harness-specific docs (CLAUDE.md, .cursorrules) from the
    /// canonical AGENTS.md.
    SyncDocs(sync::Args),
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Init(args) => init::run(args),
        Command::SyncDocs(args) => sync::run(args),
    }
}

/// Locate the workspace root (the directory containing the root `Cargo.toml`
/// with a `[workspace]` table) by walking up from this crate.
fn workspace_root() -> std::path::PathBuf {
    // CARGO_MANIFEST_DIR for xtask is `<root>/xtask`; its parent is the root.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask is always nested under the workspace root")
        .to_path_buf()
}
