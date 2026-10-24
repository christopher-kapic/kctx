# Adding async (tokio)

The template is **synchronous** by default — most CLIs don't need an async
runtime, and leaving it out keeps builds fast and the dependency tree small. Add
tokio only when you have real concurrency or async I/O (HTTP, many subprocesses,
network servers).

## Steps

1. Add the dependency with **only the features you use** (never `features =
   ["full"]` — it pulls in the whole runtime and slows builds):

   ```sh
   cargo add tokio --features rt-multi-thread,macros,io-util,time
   ```

   Common additions: `process` (spawning subprocesses), `net` (sockets),
   `signal` (Ctrl-C), `sync` (channels, semaphores), `fs` (async files).

2. Make `main` async. Replace the body of `src/main.rs`:

   ```rust
   #[tokio::main]
   async fn main() {
       let cli = Cli::parse();
       logging::init(cli.log_format, cli.verbose, cli.quiet);
       let code = match run(&cli).await {
           Ok(()) => ExitCode::Success,
           Err(err) => {
               let _ = output::diagnostic(format!("error: {}", exit::message_for(&err)));
               exit::code_for(&err)
           }
       };
       let _ = output::flush_stdout();
       std::process::exit(code as i32);
   }

   async fn run(cli: &Cli) -> anyhow::Result<()> { /* .await on commands */ }
   ```

3. Make command `run` functions `async fn` and `.await` them in the dispatch.

## Guidance

- Don't make a command async unless it actually awaits something. Mixing sync
  and async commands is fine.
- For CPU-bound work, use `tokio::task::spawn_blocking` or `rayon`, not async.
- Keep `panic = "abort"` (set in `Cargo.toml`) — it's compatible with tokio and
  yields smaller binaries.
