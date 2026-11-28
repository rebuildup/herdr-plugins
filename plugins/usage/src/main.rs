fn main() {
    // Rust ignores SIGPIPE at startup, which turns `plugin ... | head`
    // into an EPIPE panic (exit 101 + panic text on stderr). Restore the
    // default disposition so piped consumers terminate quietly, matching
    // the retired TypeScript implementation's behavior.
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        // `usage tui [--open]` — interactive TUI / open action.
        Some("tui") => std::process::exit(usage::tui::run(&args[1..])),
        // Everything else is the herdr-plugins.usage/v1 CLI.
        _ => std::process::exit(usage::cli::run(&args)),
    }
}
