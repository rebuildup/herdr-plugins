//! Interactive TUI surfaces (`git tui main|forge [--open]`).
//!
//! Rust port of `plugins/git/src/tui.ts` + `tui-forge.ts` (contract
//! herdr-plugins.tui/v1). In progress — see Issue #292.

use std::process::exit;

pub fn run(args: &[String]) -> ! {
    // TODO(#292): port tui/app.ts, tui/model.ts, tui/repo.ts,
    // tui-forge.ts, tui-forge-views.ts.
    let _ = args;
    eprintln!(
        "{}",
        serde_json::json!({
            "contract": "herdr-plugins.git/v1",
            "ok": false,
            "error": { "code": "error", "message": "git tui is not yet implemented in the native binary" },
        })
    );
    exit(2);
}
