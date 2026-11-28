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
    let code = match args.first().map(|s| s.as_str()) {
        // `controls tui [open|main]` — interactive TUI / open action helper.
        Some("tui") => controls::tui::run(&args[1..]),
        // Everything else is the herdr-plugins.controls/v1 CLI surface.
        _ => controls::cli::run(&args),
    };
    std::process::exit(code);
}
