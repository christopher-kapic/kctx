//! `mycli hello` — example command.
//!
//! This exists to show the shape of a command: typed args, config lookup,
//! human vs. `--json` output, a unit test. Replace it with your real command.

use anyhow::Result;
use serde::Serialize;

use crate::config::Config;
use crate::output;

/// Greet someone.
#[derive(Debug, clap::Args)]
pub struct Args {
    /// Who to greet. Defaults to `greeting_name` from your config.
    pub name: Option<String>,

    /// Emit a JSON object instead of human-readable text.
    #[arg(long)]
    pub json: bool,
}

/// Machine-readable shape of the output. Keeping a typed struct (rather than
/// building JSON ad hoc) means `--json` output stays consistent and testable.
#[derive(Debug, Serialize)]
struct Greeting<'a> {
    name: &'a str,
    message: String,
}

pub fn run(args: &Args) -> Result<()> {
    let config = Config::load()?;
    let name = args.name.as_deref().unwrap_or(&config.greeting_name);
    tracing::debug!(name, json = args.json, "rendering greeting");

    let greeting = Greeting {
        name,
        message: render(name),
    };

    if args.json {
        output::json(&greeting)?;
    } else {
        output::line(greeting.message)?;
    }
    Ok(())
}

/// Pure formatting function — easy to unit test without touching the filesystem
/// or stdout.
fn render(name: &str) -> String {
    format!("Hello, {name}!")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_greeting() {
        assert_eq!(render("Ada"), "Hello, Ada!");
    }
}
