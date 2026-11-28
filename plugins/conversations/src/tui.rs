//! rebuildup.conversations interactive TUI (contract `herdr-plugins.tui/v1`).
//!
//! Stub while the ratatui surface is being ported — `run` handles
//! `--open` and the non-TTY notice exactly like the TS entrypoint;
//! the interactive app lands in the next commit.

const PLUGIN_ID: &str = "rebuildup.conversations";
const HERDR_BIN: &str = "herdr";

/// `plugin.pane.open` argv (mirrors TS `paneOpenArgs`).
pub fn pane_open_args() -> Vec<String> {
    vec![
        "plugin".to_string(),
        "pane".to_string(),
        "open".to_string(),
        "--plugin".to_string(),
        PLUGIN_ID.to_string(),
        "--entrypoint".to_string(),
        "main".to_string(),
        "--placement".to_string(),
        "tab".to_string(),
    ]
}

/// `--open` action: ask herdr to open the `main` pane, then exit.
fn open_pane() -> i32 {
    let bin = std::env::var("HERDR_BIN_PATH")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| HERDR_BIN.to_string());
    let status = std::process::Command::new(&bin)
        .args(pane_open_args())
        .status();
    match status {
        Ok(s) if s.success() => 0,
        Ok(s) => {
            eprintln!(
                "conversations: failed to open TUI pane (herdr {}): exit {}",
                bin,
                s.code().unwrap_or(-1)
            );
            1
        }
        Err(e) => {
            eprintln!(
                "conversations: failed to open TUI pane (herdr {}): {}",
                bin, e
            );
            1
        }
    }
}

const NON_TTY_NOTICE: [&str; 2] = [
    "rebuildup.conversations TUI requires an interactive terminal.",
    "CLI equivalent: conversations <capability|index|refresh|sessions|history|search|show|usage>",
];

pub fn run(args: &[String]) -> i32 {
    if args.iter().any(|a| a == "--open") {
        return open_pane();
    }
    // Non-TTY: plain notice, exit 0 (mirrors TS main()).
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
        for line in NON_TTY_NOTICE {
            println!("{}", line);
        }
        return 0;
    }
    eprintln!("conversations: interactive TUI not yet available in this build");
    1
}
