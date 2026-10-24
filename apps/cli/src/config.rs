//! User configuration.
//!
//! The config file is TOML (comments allowed, friendly to hand-editing) and
//! lives at [`crate::paths::config_file`]. Loading is tolerant: a missing file
//! yields [`Config::default`], so a fresh install Just Works.
//!
//! Add a field: give it a `#[serde(default)]` (or make the whole struct default
//! via `#[serde(default)]` as below) so old config files keep parsing.

use std::io::{ErrorKind, Write};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

/// Top-level configuration. `#[serde(default)]` means any missing key falls back
/// to its `Default`, so adding fields never breaks existing config files. Unknown
/// keys are ignored so newer config files remain usable with older binaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Example setting: the default name used by `mycli hello` when none is
    /// given. Replace with real settings for your tool.
    pub greeting_name: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            greeting_name: "world".to_string(),
        }
    }
}

impl Config {
    /// Load config from disk, returning defaults if the file does not exist.
    pub fn load() -> Result<Self> {
        let path = crate::paths::config_file()?;
        match std::fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text)
                .with_context(|| format!("parsing config file `{}`", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e).with_context(|| format!("reading config file `{}`", path.display())),
        }
    }

    /// Write config to disk, creating the config directory if needed.
    pub fn save(&self) -> Result<()> {
        let (path, file) = self.write_temp()?;
        file.persist(&path)
            .map_err(|err| err.error)
            .with_context(|| format!("moving temporary config file to `{}`", path.display()))?;
        sync_parent_dir(&path)?;
        Ok(())
    }

    /// Write config only if no config file exists yet.
    pub fn save_new(&self) -> Result<bool> {
        let path = crate::paths::config_file()?;
        if path
            .try_exists()
            .with_context(|| format!("checking whether config file `{}` exists", path.display()))?
        {
            return Ok(false);
        }

        let (path, file) = self.write_temp()?;
        match file.persist_noclobber(&path) {
            Ok(_) => {
                sync_parent_dir(&path)?;
                Ok(true)
            }
            Err(err) if err.error.kind() == ErrorKind::AlreadyExists => Ok(false),
            Err(err) => Err(err.error)
                .with_context(|| format!("moving temporary config file to `{}`", path.display())),
        }
    }

    fn write_temp(&self) -> Result<(std::path::PathBuf, NamedTempFile)> {
        let dir = crate::paths::config_dir()?;
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("creating config directory `{}`", dir.display()))?;
        let path = crate::paths::config_file()?;
        let text = toml::to_string_pretty(self).context("serializing config")?;
        let mut file = NamedTempFile::new_in(&dir)
            .with_context(|| format!("creating temporary config file in `{}`", dir.display()))?;
        file.write_all(text.as_bytes())
            .with_context(|| format!("writing temporary config file for `{}`", path.display()))?;
        file.as_file()
            .sync_all()
            .with_context(|| format!("syncing temporary config file for `{}`", path.display()))?;
        Ok((path, file))
    }
}

/// Flush the directory entry created by the rename, so the config file itself
/// survives a crash — not just its contents. `sync_all` on the temp file makes
/// the *data* durable; fsync'ing the parent makes the *rename* durable. Opening
/// a directory as a file handle is a Unix concept, so this is a no-op elsewhere.
#[cfg(unix)]
fn sync_parent_dir(path: &std::path::Path) -> Result<()> {
    let Some(dir) = path.parent() else {
        return Ok(());
    };
    std::fs::File::open(dir)
        .and_then(|dir_file| dir_file.sync_all())
        .with_context(|| format!("syncing config directory `{}`", dir.display()))
}

#[cfg(not(unix))]
fn sync_parent_dir(_path: &std::path::Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_toml() {
        let cfg = Config {
            greeting_name: "Ada".to_string(),
        };
        let text = toml::to_string_pretty(&cfg).expect("serialize");
        let back: Config = toml::from_str(&text).expect("deserialize");
        assert_eq!(cfg, back);
    }

    #[test]
    fn empty_file_is_default() {
        let cfg: Config = toml::from_str("").expect("empty toml is valid");
        assert_eq!(cfg, Config::default());
    }

    #[test]
    fn ignores_unknown_fields() {
        let cfg: Config =
            toml::from_str("greeting_name = \"Ada\"\nfuture_setting = true\n").expect("parse");
        assert_eq!(cfg.greeting_name, "Ada");
    }
}
