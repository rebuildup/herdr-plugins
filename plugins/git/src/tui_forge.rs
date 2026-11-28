//! GitHub forge TUI (`git tui forge [--cwd DIR] [--open]`).
//!
//! Rust port of `plugins/git/src/tui-forge.ts` +
//! `tui-forge-views.ts` + `tui-forge-support.ts` (contract
//! herdr-plugins.tui/v1, Issue #239). In progress — see Issue #292.

use std::io::{self, IsTerminal};

/// `git tui forge` entrypoint; returns the process exit code.
pub fn run_forge_tui(_cwd: Option<&str>) -> i32 {
    // TODO(#292): port tui-forge.ts / tui-forge-views.ts /
    // tui-forge-support.ts.
    if !io::stdin().is_terminal() {
        eprintln!(
            "git-tui-forge: interactive UI requires a TTY.\n\
             Use the CLI instead: bin/git pr|issue <action> <pane_id>"
        );
        return 1;
    }
    eprintln!("git-tui-forge: forge TUI is not yet implemented in the native binary");
    2
}
