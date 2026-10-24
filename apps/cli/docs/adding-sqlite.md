# Adding local storage (SQLite)

Use SQLite when your CLI needs to persist structured state between runs (history,
cache, an index). It's a single file, needs no server, and `rusqlite`'s
`bundled` feature compiles SQLite in — so there's **no system dependency** and
cross-compilation Just Works.

## Steps

1. Add the dependency:

   ```sh
   cargo add rusqlite --features bundled
   ```

2. Put the database in the data directory (already scaffolded in
   `src/paths.rs` — delete the `#[allow(dead_code)]` on `data_dir`):

   ```rust
   use anyhow::Context;

   pub fn db_path() -> anyhow::Result<std::path::PathBuf> {
       let dir = crate::paths::data_dir()?;
       std::fs::create_dir_all(&dir)
           .with_context(|| format!("creating data dir `{}`", dir.display()))?;
       Ok(dir.join("mycli.db"))
   }
   ```

3. Open + migrate on first use. Keep migrations as an ordered list and track the
   schema version with `PRAGMA user_version`:

   ```rust
   pub fn open() -> anyhow::Result<rusqlite::Connection> {
       let conn = rusqlite::Connection::open(db_path()?)?;
       conn.pragma_update(None, "journal_mode", "WAL")?;
       conn.pragma_update(None, "foreign_keys", "ON")?;
       migrate(&conn)?;
       Ok(conn)
   }

   fn migrate(conn: &rusqlite::Connection) -> anyhow::Result<()> {
       let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
       if version < 1 {
           conn.execute_batch(
               "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
                PRAGMA user_version = 1;",
           )?;
       }
       // if version < 2 { ... PRAGMA user_version = 2; }
       Ok(())
   }
   ```

## Guidance

- **One writer.** SQLite handles concurrent readers but serializes writers; WAL
  mode (above) makes this smooth for a CLI.
- **Test against a temp DB.** Use `rusqlite::Connection::open_in_memory()` or a
  `tempfile::tempdir()` path in tests — never the user's real DB.
- Add `rusqlite` to your mental model of `deny.toml`: it's MIT-licensed and on
  the allowlist already.
