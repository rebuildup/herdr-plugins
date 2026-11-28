//! Provider slash-command passthrough table for `rebuildup.controls`
//! (Issue #101 / parent #27 T3). Rust port of `plugins/controls/src/
//! commands.ts`.
//!
//! Mechanism (verified against herdr 0.9.5): `agent.prompt` types `text`
//! into the agent pane as bracketed-paste bytes followed by an encoded
//! Enter key. There is no structured "run command" API — a slash command
//! is prompt text that must *start the message* for the provider TUI to
//! interpret it. `command` builds `/name args...` and forwards it
//! through the same `agent.prompt` path as `send`.
//!
//! Honesty constraints (unchanged): whether `/name` is a real provider
//! command is provider-TUI business; the per-provider table is advisory,
//! version-dependent, and explicitly unverified — `known_command:
//! false` results are still forwarded.

use serde_json::{json, Value};

use crate::identity::ControlsError;
use crate::launch::canonical_kind;

/// Advisory slash-command table per canonical herdr agent kind.
/// Entries record commands documented by the provider or by T3 Code's
/// provider docs; they are a hint for `capability`/result echo only —
/// never a gate. Providers absent from the table have no verified
/// entries (`commands: []`).
pub const PROVIDER_COMMANDS: &[(&str, &[&str])] = &[
    (
        "claude",
        &[
            "model", "clear", "compact", "resume", "init", "review", "status", "doctor",
            "config", "agents", "mcp", "permissions", "cost", "goal",
        ],
    ),
    (
        "codex",
        &[
            "model", "approvals", "review", "new", "init", "compact", "diff", "status",
            "mcp", "mention", "logout", "goal",
        ],
    ),
    (
        "gemini",
        &[
            "model", "compress", "chat", "restore", "stats", "memory", "tools", "mcp",
            "extensions", "auth", "vim", "theme", "editor",
        ],
    ),
    ("opencode", &["model", "agent", "init", "compact", "themes", "editor"]),
    ("agy", &["compact", "clear", "goal", "plan", "logout"]),
    ("kiro", &["compact"]),
];

pub const COMMAND_TABLE_NOTE: &str = "Advisory per-provider slash-command list from provider/T3 Code docs; provider-version dependent and unverified — the provider TUI decides whether a command exists.";

/// Advisory command list for a canonical kind (empty when the provider
/// has no table entry). Used by `capability` and `command_info_for`.
pub fn provider_commands_pub(kind: &str) -> Vec<&'static str> {
    provider_commands(kind).to_vec()
}

fn provider_commands(kind: &str) -> &'static [&'static str] {
    PROVIDER_COMMANDS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, cmds)| *cmds)
        .unwrap_or(&[])
}

/// `/name` token: letter followed by letters/digits/_/- (case preserved
/// verbatim).
fn is_command_name(slash_command: &str) -> bool {
    let Some(rest) = slash_command.strip_prefix('/') else {
        return false;
    };
    let mut chars = rest.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Control characters would let args inject extra PTY submissions;
/// reject them. Mirrors TS `hasControlChars`: code point < 0x20 or
/// == 0x7f (C0 + DEL; C1 0x80–0x9f is NOT rejected upstream).
fn has_control_chars(value: &str) -> bool {
    value
        .chars()
        .any(|c| (c as u32) < 0x20 || (c as u32) == 0x7f)
}

pub struct CommandBuild {
    /// Canonical command name without the leading slash, e.g. `model`.
    pub name: String,
    /// Full prompt text submitted via agent.prompt; always starts `/`.
    pub text: String,
}

/// Validate `<slash-command>` + args and build the prompt text. The
/// command must start the message (T3 contract rule); args are joined
/// with single spaces exactly like `send` — no quoting layer exists.
pub fn build_command_text(
    slash_command: &str,
    args: &[String],
) -> Result<CommandBuild, ControlsError> {
    if !is_command_name(slash_command) {
        return Err(ControlsError::usage(format!(
            "command must be a slash command like /model, got: {}",
            slash_command
        )));
    }
    let name = slash_command[1..].to_string();
    for arg in args {
        if arg.is_empty() || has_control_chars(arg) {
            return Err(ControlsError::usage(format!(
                "command args must be non-empty and contain no control characters, got: {}",
                serde_json::to_string(arg).unwrap_or_else(|_| format!("\"{}\"", arg))
            )));
        }
    }
    let text = if args.is_empty() {
        slash_command.to_string()
    } else {
        format!("{} {}", slash_command, args.join(" "))
    };
    Ok(CommandBuild { name, text })
}

/// Advisory command-table lookup for a resolved agent kind.
pub fn command_info_for(agent_kind: Option<&str>, name: &str) -> Value {
    let kind = agent_kind.map(canonical_kind);
    let commands: Vec<Value> = kind
        .as_deref()
        .map(provider_commands)
        .unwrap_or(&[])
        .iter()
        .map(|c| json!(c))
        .collect();
    json!({
        "kind": kind,
        "commands": commands,
        "known_command": kind
            .as_deref()
            .map(|k| provider_commands(k).contains(&name))
            .unwrap_or(false),
        "note": COMMAND_TABLE_NOTE,
    })
}
