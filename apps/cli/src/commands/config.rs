//! `mycli config` — inspect configuration and resolved paths.
//!
//! Subcommands:
//!   - `config path`  print the config file path (whether or not it exists)
//!   - `config show`  print the effective config (defaults + file) as TOML
//!   - `config init`  write a default config file if none exists

use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::Config;
use crate::output;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Emit JSON instead of human-readable text.
    // `global` only because this command has subcommands: it lets the flag
    // appear on either side (`config --json path` and `config path --json`).
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Sub,
}

#[derive(Debug, clap::Subcommand)]
enum Sub {
    /// Print the path to the config file.
    Path,
    /// Print the effective configuration (defaults merged with the file).
    Show,
    /// Create a default config file if one does not already exist.
    Init,
}

pub fn run(args: &Args) -> Result<()> {
    match args.command {
        Sub::Path => {
            let path = crate::paths::config_file()?;
            if args.json {
                output::json(&ConfigPath::new(&path))?;
            } else {
                output::line(path.display())?;
            }
        }
        Sub::Show => {
            let config = Config::load()?;
            if args.json {
                output::json(&config)?;
            } else {
                output::text(toml::to_string_pretty(&config)?)?;
            }
        }
        Sub::Init => {
            let path = crate::paths::config_file()?;
            let created = Config::default()
                .save_new()
                .context("writing the default config file")?;

            if args.json {
                output::json(&ConfigInit::new(&path, created))?;
            } else if created {
                output::line(format!("wrote default config to `{}`", path.display()))?;
            } else {
                output::line(format!("config already exists at `{}`", path.display()))?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct ConfigPath {
    path: String,
}

impl ConfigPath {
    fn new(path: &Path) -> Self {
        Self {
            path: path.display().to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
struct ConfigInit {
    path: String,
    created: bool,
}

impl ConfigInit {
    fn new(path: &Path, created: bool) -> Self {
        Self {
            path: path.display().to_string(),
            created,
        }
    }
}
