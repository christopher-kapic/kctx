# Adding a TUI (ratatui)

Add a terminal UI only when interactivity earns its keep (browsing/editing a
list, a live dashboard). A TUI is a meaningful amount of code and dependencies —
many great CLIs never need one.

## Steps

1. Add the dependencies:

   ```sh
   cargo add ratatui crossterm
   ```

2. Gate the TUI behind explicit intent. A good default convention:
   **bare invocation in a terminal launches the TUI; any flag or a non-TTY runs
   plain/non-interactive.** This keeps the tool scriptable.

   ```rust
   use std::io::IsTerminal;
   let interactive = std::io::stdout().is_terminal() && /* no output flags set */;
   ```

3. Standard ratatui loop: enter raw mode + alternate screen, draw on each tick,
   handle key events, restore the terminal on normal return/error paths. Use a
   guard for cleanup, and avoid panics entirely — release builds use
   `panic = "abort"`, so destructors will not run after a panic.

## Design rules

- **Vim-friendly, not vim-exclusive.** `j/k/h/l` *and* arrow keys; `enter`/`l`
  to descend, `q`/`esc` to go back.
- **`?` opens a help overlay** listing every binding for the current view.
  Discoverability is one keystroke away.
- **State is a pure function of input.** Model each view as a state struct with
  `handle_key(KeyEvent) -> Action`; render is a pure function of state. This is
  what makes a TUI testable.
- **Esc always backs out**; `Ctrl-C` always hard-cancels.
- **Restore the terminal on every normal exit path.** A `Drop` guard that leaves
  raw mode + alternate screen is the safest pattern for returns and errors.

## Testing

Test the state transitions (`handle_key`) as pure functions — you don't need a
real terminal. Reserve manual testing for layout/rendering.
