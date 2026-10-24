//! Filesystem locations.
//!
//! Resolves the per-user config/data directories in a cross-platform way
//! via the `dirs` crate:
//!
//!   | Dir    | Linux                     | macOS                              | Windows                       |
//!   |--------|---------------------------|------------------------------------|-------------------------------|
//!   | config | ~/.config/mycli           | ~/Library/Application Support/mycli | %APPDATA%\mycli               |
//!   | data   | ~/.local/share/mycli      | ~/Library/Application Support/mycli | %APPDATA%\mycli               |
//!
//! Any of these can be overridden with the `MYCLI_CONFIG_DIR` / `MYCLI_DATA_DIR`
//! environment variables — useful for tests and for users who want everything
//! in one place.

use std::path::PathBuf;

use anyhow::{Context, Result};

/// Application directory name. Renamed by `cargo xtask init`.
const APP: &str = "mycli";

/// The directory holding the user's editable configuration file.
pub fn config_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("MYCLI_CONFIG_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let base = dirs::config_dir().context("could not determine the user config directory")?;
    Ok(base.join(APP))
}

/// The directory for application-managed data (databases, caches, state).
///
/// Scaffolding: unused until your CLI stores data. Delete the `allow` once you
/// call it (e.g. from a SQLite setup — see `docs/adding-sqlite.md`).
#[allow(dead_code)]
pub fn data_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("MYCLI_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let base = dirs::data_dir().context("could not determine the user data directory")?;
    Ok(base.join(APP))
}

/// Full path to the config file (`config.toml` inside [`config_dir`]).
pub fn config_file() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}
