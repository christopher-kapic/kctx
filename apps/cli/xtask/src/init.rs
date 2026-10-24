//! `cargo xtask init` — turn the template into your project.
//!
//! Replaces the template's crate name, Rust crate path, environment-variable
//! prefix, GitHub owner, author, and description everywhere they appear in text
//! files.
//!
//! Run once, right after forking. It edits files in place — review the diff and
//! commit. Then run `cargo xtask sync-docs` so the agent mirrors pick up your
//! new name, and the standard checks to confirm everything is still green.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use walkdir::WalkDir;

use crate::workspace_root;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// New crate/binary name (lowercase letters, digits, `-` or `_`).
    #[arg(long)]
    name: String,

    /// GitHub owner or org that will host the repo (used in URLs and the tap).
    #[arg(long)]
    owner: String,

    /// Author line for Cargo.toml, e.g. "Ada Lovelace <ada@example.com>".
    #[arg(long)]
    author: Option<String>,

    /// One-line crate description.
    #[arg(long)]
    description: Option<String>,

    /// Show what would change without writing files.
    #[arg(long)]
    dry_run: bool,
}

/// File extensions / names we rewrite. Anything else (images, binaries) is left
/// untouched.
const TEXT_FILES: &[&str] = &[
    "rs", "toml", "md", "yml", "yaml", "json", "sh", "ps1", "fish", "txt", "lock",
];
const TEXT_FILENAMES: &[&str] = &[
    ".cursorrules",
    ".gitignore",
    ".gitattributes",
    "LICENSE-APACHE",
    "LICENSE-MIT",
];

/// Directories never touched by init.
const SKIP_DIRS: &[&str] = &[".git", "target", "xtask"];

/// Placeholders for the optional flags. Defined once so the rewrite and the
/// post-init note can't drift apart.
const AUTHOR_PLACEHOLDER: &str = "Your Name <you@example.com>";
const DESCRIPTION_PLACEHOLDER: &str = "A fast, friendly command-line tool.";

pub fn run(args: Args) -> Result<()> {
    validate_name(&args.name)?;
    validate_owner(&args.owner)?;

    let lower = args.name.clone();
    let rust_crate = args.name.replace('-', "_");
    let upper = args.name.to_uppercase().replace('-', "_");

    let mut replacements: Vec<(String, String)> = vec![
        ("mycli::".to_string(), format!("{rust_crate}::")),
        ("MYCLI".to_string(), upper),
        ("mycli".to_string(), lower.clone()),
        ("OWNER".to_string(), args.owner.clone()),
    ];
    // Optional metadata: replace when given, otherwise leave the placeholder
    // in place and mention it at the end. Skipping a flag is not an error.
    let mut skipped: Vec<(&str, &str)> = Vec::new();
    match &args.author {
        Some(author) => replacements.push((AUTHOR_PLACEHOLDER.to_string(), author.clone())),
        None => skipped.push(("--author", AUTHOR_PLACEHOLDER)),
    }
    match &args.description {
        Some(desc) => replacements.push((DESCRIPTION_PLACEHOLDER.to_string(), desc.clone())),
        None => skipped.push(("--description", DESCRIPTION_PLACEHOLDER)),
    }

    let root = workspace_root();
    let mut changed = 0usize;

    for path in text_files(&root)? {
        let Ok(original) = fs::read_to_string(&path) else {
            continue; // not valid UTF-8 — skip
        };
        let mut updated = original.clone();
        for (from, to) in &replacements {
            updated = replace_placeholder(&updated, from, to);
        }
        if path.file_name().and_then(|name| name.to_str()) == Some("typos.toml") {
            updated = add_typos_allowlist_word(&updated, &lower);
        }
        if updated != original {
            if !args.dry_run {
                fs::write(&path, updated)?;
            }
            changed += 1;
            println!(
                "{} {}",
                if args.dry_run {
                    "would update"
                } else {
                    "updated"
                },
                path.strip_prefix(&root).unwrap_or(&path).display()
            );
        }
    }

    // Safety net: every token we replace should be gone after the rewrite. In
    // dry runs we simulate the rewrite so preview mode catches the same coverage
    // gaps a real run would catch.
    let leftovers = find_placeholders(&root, &replacements, args.dry_run)?;
    if !leftovers.is_empty() {
        bail!(
            "init left template placeholders behind:\n{}\nreview these matches, then rerun or edit deliberately",
            leftovers.join("\n")
        );
    }

    if args.dry_run {
        println!("\ndry run complete: `{lower}` would update {changed} file(s).");
        print_skipped(&skipped);
        return Ok(());
    }

    println!(
        "\ninit complete: renamed to `{lower}` across {changed} file(s).\n\nNext:\n  1. cargo xtask sync-docs        # refresh agent mirrors\n  2. cargo fmt --all --check\n  3. cargo clippy --workspace --all-targets --all-features -- -D warnings\n  4. cargo test --workspace --all-targets --locked\n  5. cargo test --workspace --doc --locked\n  6. cargo xtask sync-docs --check\n  7. review the diff & commit"
    );
    print_skipped(&skipped);
    Ok(())
}

/// Tell the user which optional placeholders are still in the tree.
fn print_skipped(skipped: &[(&str, &str)]) {
    for (flag, placeholder) in skipped {
        println!(
            "\nnote: {flag} not given — `{placeholder}` is still in the tree; rerun init with {flag}, or edit it by hand"
        );
    }
}

fn validate_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase());
    if !ok {
        bail!(
            "invalid name `{name}`: use lowercase letters/digits/`-`/`_`, starting with a letter"
        );
    }
    Ok(())
}

fn validate_owner(owner: &str) -> Result<()> {
    let ok = (1..=39).contains(&owner.len())
        && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && owner
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && owner
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && !owner.contains("--");
    if !ok {
        bail!(
            "invalid owner `{owner}`: use a GitHub owner/org name of 1-39 letters, digits, or single hyphens, starting and ending with a letter or digit"
        );
    }
    Ok(())
}

/// Every text file under `root` that init may rewrite, honoring `SKIP_DIRS`.
fn text_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_entry(|e| {
        // Skip the directories listed above, anywhere in the tree.
        !e.file_name()
            .to_str()
            .is_some_and(|n| e.file_type().is_dir() && SKIP_DIRS.contains(&n))
    }) {
        let entry = entry?;
        if entry.file_type().is_file() && is_text_file(entry.path()) {
            files.push(entry.into_path());
        }
    }
    Ok(files)
}

fn is_text_file(path: &Path) -> bool {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if TEXT_FILENAMES.contains(&name) {
            return true;
        }
    }
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| TEXT_FILES.contains(&ext))
}

/// Report `file:line` for every remaining occurrence of rewritten placeholders.
fn find_placeholders(
    root: &Path,
    replacements: &[(String, String)],
    dry_run: bool,
) -> Result<Vec<String>> {
    let mut matches = Vec::new();
    let tokens: Vec<&str> = replacements.iter().map(|(from, _)| from.as_str()).collect();
    for path in text_files(root)? {
        let Ok(mut text) = fs::read_to_string(&path) else {
            continue;
        };
        if dry_run {
            for (from, to) in replacements {
                text = replace_placeholder(&text, from, to);
            }
        }
        for (line_index, line) in text.lines().enumerate() {
            if tokens.iter().any(|token| contains_placeholder(line, token)) {
                let rel = path.strip_prefix(root).unwrap_or(&path);
                matches.push(format!("{}:{}", rel.display(), line_index + 1));
            }
        }
    }
    Ok(matches)
}

fn replace_placeholder(text: &str, from: &str, to: &str) -> String {
    if from == "OWNER" {
        return replace_bare_owner(text, to);
    }
    text.replace(from, to)
}

fn contains_placeholder(text: &str, token: &str) -> bool {
    if token == "OWNER" {
        return find_bare_owner(text).is_some();
    }
    text.contains(token)
}

fn replace_bare_owner(text: &str, to: &str) -> String {
    let mut remaining = text;
    let mut out = String::with_capacity(text.len());
    while let Some(index) = find_bare_owner(remaining) {
        out.push_str(&remaining[..index]);
        out.push_str(to);
        remaining = &remaining[index + "OWNER".len()..];
    }
    out.push_str(remaining);
    out
}

fn find_bare_owner(text: &str) -> Option<usize> {
    let mut start = 0;
    while let Some(relative) = text[start..].find("OWNER") {
        let index = start + relative;
        let before = text[..index].chars().next_back();
        let after = text[index + "OWNER".len()..].chars().next();
        if !is_ident_char(before) && !is_ident_char(after) {
            return Some(index);
        }
        start = index + "OWNER".len();
    }
    None
}

fn is_ident_char(ch: Option<char>) -> bool {
    ch.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn add_typos_allowlist_word(text: &str, word: &str) -> String {
    let allowlist_entry = format!("{word} = \"{word}\"");
    if text.lines().any(|line| line.trim() == allowlist_entry) {
        return text.to_string();
    }

    let mut out = String::with_capacity(text.len() + allowlist_entry.len() + 1);
    let mut inserted = false;
    for line in text.lines() {
        out.push_str(line);
        out.push('\n');
        if !inserted && line.trim() == "[default.extend-words]" {
            out.push_str(&allowlist_entry);
            out.push('\n');
            inserted = true;
        }
    }
    if !inserted {
        out.push_str("\n[default.extend-words]\n");
        out.push_str(&allowlist_entry);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typos_allowlist_gets_new_crate_name() {
        let text = "[default.extend-words]\nratatui = \"ratatui\"\n";
        let updated = add_typos_allowlist_word(text, "my-test-tool");

        assert!(updated.contains("my-test-tool = \"my-test-tool\""));
        assert_eq!(updated.matches("my-test-tool").count(), 2);
    }

    #[test]
    fn typos_allowlist_does_not_duplicate_new_crate_name() {
        let text = "[default.extend-words]\nmy-test-tool = \"my-test-tool\"\n";
        let updated = add_typos_allowlist_word(text, "my-test-tool");

        assert_eq!(updated.matches("my-test-tool").count(), 2);
    }

    #[test]
    fn validates_github_owner_names() {
        assert!(validate_owner("acme").is_ok());
        assert!(validate_owner("acme-tools").is_ok());
        assert!(validate_owner("a1").is_ok());
    }

    #[test]
    fn rejects_invalid_github_owner_names() {
        assert!(validate_owner("").is_err());
        assert!(validate_owner("-acme").is_err());
        assert!(validate_owner("acme-").is_err());
        assert!(validate_owner("acme/tools").is_err());
        assert!(validate_owner("acme tools").is_err());
        assert!(validate_owner("acme--tools").is_err());
        assert!(validate_owner("abcdefghijklmnopqrstuvwxyzabcdefghijklmn").is_err());
    }
}
