//! Black-box integration tests: run the built binary and assert on its
//! behavior (stdout, stderr, exit code). This is the highest-value test layer
//! for a CLI — it exercises argument parsing, dispatch, and output formatting
//! exactly as a user would.
//!
//! Tests use a throwaway config dir via `MYCLI_CONFIG_DIR` so they never touch
//! the developer's real config.

use assert_cmd::Command;
use predicates::prelude::*;
use serde_json::Value;
use std::fs;

/// Build a `Command` for the binary with an isolated, empty config dir.
fn cli(config_dir: &std::path::Path) -> Command {
    let mut cmd = Command::cargo_bin("mycli").expect("binary builds");
    cmd.env("MYCLI_CONFIG_DIR", config_dir);
    // Log-filter env vars from the developer's shell would override the flags
    // under test.
    cmd.env_remove("MYCLI_LOG");
    cmd.env_remove("RUST_LOG");
    cmd
}

fn json_stdout(mut cmd: Command) -> Value {
    let stdout = cmd.assert().success().get_output().stdout.clone();
    serde_json::from_slice(&stdout).expect("stdout is valid JSON")
}

#[test]
fn hello_uses_builtin_default_without_config() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .arg("hello")
        .assert()
        .success()
        .stdout(predicate::str::contains("Hello, world!"));
}

#[test]
fn hello_uses_default_from_config() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(
        tmp.path().join("config.toml"),
        "greeting_name = \"Grace\"\n",
    )
    .unwrap();
    cli(tmp.path())
        .arg("hello")
        .assert()
        .success()
        .stdout(predicate::eq("Hello, Grace!\n"));
}

#[test]
fn hello_accepts_a_name() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .args(["hello", "Ada"])
        .assert()
        .success()
        .stdout(predicate::eq("Hello, Ada!\n"));
}

#[test]
fn hello_json_is_machine_readable() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cmd = cli(tmp.path());
    cmd.args(["hello", "Ada", "--json"]);
    let value = json_stdout(cmd);

    assert_eq!(value["name"], "Ada");
    assert_eq!(value["message"], "Hello, Ada!");
}

#[test]
fn config_path_json_is_machine_readable() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cmd = cli(tmp.path());
    cmd.args(["config", "--json", "path"]);
    let value = json_stdout(cmd);

    assert!(value["path"].as_str().is_some_and(|path| !path.is_empty()));
}

#[test]
fn config_show_json_is_machine_readable() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cmd = cli(tmp.path());
    cmd.args(["config", "--json", "show"]);
    let value = json_stdout(cmd);

    assert_eq!(value["greeting_name"], "world");
}

#[test]
fn config_init_json_reports_whether_it_created_the_file() {
    let tmp = tempfile::tempdir().unwrap();
    let mut first = cli(tmp.path());
    first.args(["config", "--json", "init"]);
    let first_value = json_stdout(first);

    let mut second = cli(tmp.path());
    second.args(["config", "--json", "init"]);
    let second_value = json_stdout(second);

    assert_eq!(first_value["created"], true);
    assert_eq!(second_value["created"], false);
    assert_eq!(first_value["path"], second_value["path"]);
}

#[test]
fn config_init_then_show() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path()).args(["config", "init"]).assert().success();
    cli(tmp.path())
        .args(["config", "show"])
        .assert()
        .success()
        .stdout(predicate::str::contains("greeting_name"));
}

#[test]
fn completions_generates_shell_script() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .args(["completions", "bash"])
        .assert()
        .success()
        .stdout(predicate::str::contains("_mycli"));
}

#[test]
fn unknown_command_is_a_usage_error() {
    let tmp = tempfile::tempdir().unwrap();
    // clap exits 2 for usage errors.
    cli(tmp.path())
        .arg("definitely-not-a-command")
        .assert()
        .code(2);
}

#[test]
fn version_prints_package_version() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .arg("--version")
        .assert()
        .success()
        .stdout(predicate::str::contains(env!("CARGO_PKG_VERSION")));
}

#[test]
fn help_lists_commands() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("Commands:"))
        .stdout(predicate::str::contains("hello"))
        .stdout(predicate::str::contains("config"))
        .stdout(predicate::str::contains("completions"));
}

#[test]
fn global_log_flags_do_not_pollute_stdout() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .args(["--verbose", "--log-format", "json", "hello", "Ada"])
        .assert()
        .success()
        .stdout(predicate::eq("Hello, Ada!\n"))
        .stderr(predicate::str::contains(r#""level":"DEBUG""#))
        .stderr(predicate::str::contains("rendering greeting"));
}

#[test]
fn quiet_conflicts_with_verbose() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .args(["--quiet", "--verbose", "hello"])
        .assert()
        .code(2);
}

#[test]
fn config_path_text_prints_path() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .args(["config", "path"])
        .assert()
        .success()
        .stdout(predicate::str::contains("config.toml"));
}

#[test]
fn config_show_text_prints_toml() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .args(["config", "show"])
        .assert()
        .success()
        .stdout(predicate::str::contains("greeting_name = \"world\""));
}
