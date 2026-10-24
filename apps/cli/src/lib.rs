//! Shared implementation for the `mycli` binary.
//!
//! The binary entry point stays thin, while command definitions, config, exit
//! codes, logging, paths, and output helpers live here so they can be tested and
//! documented like normal Rust code.

pub mod cli;
pub mod commands;
pub mod config;
pub mod exit;
pub mod logging;
pub mod output;
pub mod paths;
