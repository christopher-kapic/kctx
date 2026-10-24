//! `cargo xtask sync-docs` — keep harness-specific instruction files in sync
//! with the canonical `AGENTS.md`.
//!
//! AGENTS.md is the single source of truth. Every other agent harness gets a
//! generated mirror with a "do not edit" banner. A CI job runs
//! `sync-docs --check` and fails the build if any mirror has drifted — so the
//! rule that "you only edit AGENTS.md" is enforced by the repo, not by trust.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};

use crate::workspace_root;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Verify mirrors are up to date without writing. Exit non-zero on drift.
    #[arg(long)]
    check: bool,
}

/// The canonical source file.
const SOURCE: &str = "AGENTS.md";

/// Generated mirrors. Add a harness by appending a `(path, banner)` here.
/// (Copilot reads the repo-root instructions; this CLI directory only mirrors
/// the harness files that support nested scopes.)
fn targets() -> Vec<(PathBuf, String)> {
    let banner = "<!-- GENERATED FILE — DO NOT EDIT.\n     Edit AGENTS.md, then run `cargo xtask sync-docs`. -->\n\n";
    vec![
        (PathBuf::from("CLAUDE.md"), banner.to_string()),
        (PathBuf::from(".cursorrules"), banner.to_string()),
    ]
}

pub fn run(args: Args) -> Result<()> {
    let root = workspace_root();
    let source_path = root.join(SOURCE);
    let source = fs::read_to_string(&source_path)
        .with_context(|| format!("reading `{}`", source_path.display()))?;

    let mut drifted = Vec::new();

    for (rel, banner) in targets() {
        let path = root.join(&rel);
        let expected = format!("{banner}{source}");

        if args.check {
            let current = fs::read_to_string(&path).unwrap_or_default();
            if current != expected {
                drifted.push(rel.display().to_string());
            }
        } else {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("creating `{}`", parent.display()))?;
            }
            fs::write(&path, &expected).with_context(|| format!("writing `{}`", path.display()))?;
            println!("wrote {}", rel.display());
        }
    }

    if args.check && !drifted.is_empty() {
        bail!(
            "agent docs are out of sync: {}\n  fix with: cargo xtask sync-docs",
            drifted.join(", ")
        );
    }
    if !args.check {
        println!("agent docs are in sync with {SOURCE}");
    }
    Ok(())
}
