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
        // `inbox hook` — herdr event-hook entrypoint (HERDR_PLUGIN_EVENT_JSON).
        Some("hook") => inbox::hook::run(&args[1..]),
        // `inbox tui [--open]` — interactive TUI / open action helper.
        Some("tui") => inbox::tui::run(&args[1..]),
        // Everything else is the herdr-plugins.inbox/v1 CLI surface.
        _ => inbox::cli::run(&args),
    }
}
