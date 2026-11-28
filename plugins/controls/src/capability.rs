//! Capability matrix for `rebuildup.controls` (`herdr-plugins.controls/v1`).
//! Rust port of `plugins/controls/src/capability.ts`.
//!
//! Every operation maps 1:1 onto a herdr `agent.*` socket method, so the
//! matrix is uniform across agent kinds: herdr resolves `target` (pane id
//! or agent name) and enforces agent-ness server-side. What differs per
//! kind is only what the *provider* does with the injected input — the
//! plugin cannot and does not verify provider semantics.
//!
//! Honest limits (see ADR-0017/0018/0019): `interrupt` is PTY-level key
//! injection; `read` is scrollback not history; `send`/`command` to a
//! `blocked` agent surface `requires_interactive_input`; queue/steer and
//! structured dialogs are upstream gaps reported `unsupported`.

use serde_json::{json, Map, Value};

use crate::commands::{provider_commands_pub, COMMAND_TABLE_NOTE};
use crate::launch::launch_capability;

pub const CONTRACT: &str = "herdr-plugins.controls/v1";
pub const PLUGIN_ID: &str = "rebuildup.controls";
pub const PLUGIN_VERSION: &str = "0.6.0";

/// herdr 0.9.5 detection-manifest agent kinds (TS `KNOWN_AGENT_KINDS`).
pub const KNOWN_AGENT_KINDS: &[&str] = &[
    "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp",
    "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok",
    "hermes", "kilo", "qodercli", "qwen", "letta", "maki", "muse",
];

const OPERATION_NOTES_SEND: &str = "agent.prompt submits text via bracketed paste + Enter; a blocked agent is rejected before input is sent (surfaced as requires_interactive_input). Optional wait observes post-submit status only — it does not track turns.";
const OPERATION_NOTES_WAIT: &str = "agent.wait blocks server-side until agent_status matches until[] (default idle/done/blocked) or timeout_ms elapses (structured timeout error).";
const OPERATION_NOTES_INTERRUPT: &str = "PTY-level only: agent.send_keys injects key names (default esc) into the terminal. No structured interrupt API exists upstream; effect depends on the provider's keybindings.";
const OPERATION_NOTES_READ: &str = "agent.read returns bounded terminal scrollback (source visible|recent|recent_unwrapped|detection; format text|ansi). Not structured history — use rebuildup.conversations for conversation events.";
const OPERATION_NOTES_RENAME: &str = "agent.rename sets the display name; name=null clears it.";
const OPERATION_NOTES_START: &str = "agent.start launches a detected agent kind in an existing shell pane; args are provider CLI flags built from the per-provider launch table (model/reasoning/permission-mode/resume) plus validated --arg passthrough. herdr waits for interactive readiness up to timeout_ms.";
const OPERATION_NOTES_COMMAND: &str = "Provider slash-command passthrough: agent.prompt submits the literal `/name args` text (bracketed paste + Enter upstream), so the command must start the message. Provider TUI decides whether the command exists — fragile and provider-version dependent; the advisory per-provider table is unverified.";

/// Structured-dialog surface (Issue #102 / ADR-0019). herdr has no
/// dialog events or response API, so every entry is `unsupported`; the
/// table exists so consumers feature-detect instead of probing.
/// `interactive_fallback` names the sanctioned PTY-level tools.
fn dialog_capabilities() -> Map<String, Value> {
    let mut map = Map::new();
    map.insert(
        "approval".to_string(),
        json!({
            "status": "unsupported",
            "reason": "No structured approval events or response API; a blocked agent rejects agent.prompt (requires_interactive_input). Resolve dialogs via the PTY interactive fallback or upstream herdrdev/herdr#6196.",
            "upstream": "herdrdev/herdr#6196",
        }),
    );
    map.insert(
        "question".to_string(),
        json!({
            "status": "unsupported",
            "reason": "No structured question/option events or answers; same blocked-agent boundary as approval. PTY fallback only until herdrdev/herdr#6196.",
            "upstream": "herdrdev/herdr#6196",
        }),
    );
    map.insert(
        "attachments".to_string(),
        json!({
            "status": "unsupported",
            "reason": "No structured attachment channel. File-path references inside prompt text via send/command are the only v1 path; whether the provider attaches anything is provider-TUI dependent and unverified. Binary/image payloads are out of scope.",
        }),
    );
    map.insert(
        "goals".to_string(),
        json!({
            "status": "unsupported",
            "reason": "No goal state surface upstream. Provider slash commands (e.g. /goal) pass through `command` as fragile text; goal state tracking is unsupported.",
        }),
    );
    map.insert(
        "subagent_approvals".to_string(),
        json!({
            "status": "unsupported",
            "reason": "No aggregation of child/subagent approval prompts onto the parent pane upstream; same gap as approval (herdrdev/herdr#6196 follow-up scope).",
            "upstream": "herdrdev/herdr#6196",
        }),
    );
    map
}

/// The `capability` command payload (offline; works without a session).
pub fn capability_payload(plugin_version: &str, generated_at: &str) -> Value {
    let mut operations = Map::new();
    for (name, api, pty, note) in [
        ("send", "agent.prompt", false, OPERATION_NOTES_SEND),
        ("wait", "agent.wait", false, OPERATION_NOTES_WAIT),
        ("interrupt", "agent.send_keys", true, OPERATION_NOTES_INTERRUPT),
        ("read", "agent.read", true, OPERATION_NOTES_READ),
        ("rename", "agent.rename", false, OPERATION_NOTES_RENAME),
        ("start", "agent.start", false, OPERATION_NOTES_START),
        ("command", "agent.prompt", false, OPERATION_NOTES_COMMAND),
    ] {
        operations.insert(
            name.to_string(),
            json!({ "api": api, "pty_level": pty, "note": note }),
        );
    }

    let providers: Vec<Value> = KNOWN_AGENT_KINDS
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "status": "supported",
                "operations": ["send", "command", "wait", "interrupt", "read", "rename", "start"],
                "launch": launch_capability(id),
                "commands": {
                    "known": provider_commands_pub(id),
                    "fragile": true,
                    "verified": false,
                    "note": COMMAND_TABLE_NOTE,
                },
                "notes": "Uniform agent.* surface; provider-specific behavior of injected input is not verified by this plugin.",
            })
        })
        .collect();

    let mut dialogs = dialog_capabilities();
    dialogs.insert(
        "interactive_fallback".to_string(),
        json!({
            "status": "pty_level",
            "commands": ["interrupt", "read"],
            "note": "PTY key injection + scrollback reads are the labeled fallback for driving open dialogs by hand; fragile and never reported as a structured dialog API (ADR-0019).",
        }),
    );

    json!({
        "contract": CONTRACT,
        "command": "capability",
        "plugin": PLUGIN_ID,
        "version": plugin_version,
        "read_only": false,
        "mutation_commands": ["send", "command", "interrupt", "rename", "start"],
        "commands": ["capability", "send", "command", "wait", "interrupt", "read", "rename", "start"],
        "operations": Value::Object(operations),
        "providers": providers,
        "dialogs": Value::Object(dialogs),
        "upstream_gaps": [
            "structured interrupt API (interrupt is PTY-level key injection)",
            "queued message / steer session concept (agent.prompt during a working turn is provider-dependent follow-up behavior, not a herdr guarantee; plugin-side queue deferred — herdrdev/herdr#6197, see docs/specs/controls.md)",
            "structured approval/question dialog events and responses (blocked agents reject agent.prompt; upstream request herdrdev/herdr#6196, ADR-0019)",
            "structured conversation history (agent.read is scrollback; see rebuildup.conversations)",
            "agent_session_path is not exposed for claude/codex, so path-kind resume is unavailable there; resume uses the reported session id only (herdrdev/herdr#6191, closed upstream not-planned)",
        ],
        "notes": [
            "target accepts a herdr agent target (pane id or agent name); agent.get resolves and validates it before every operation.",
            "Optional --expect-pane/--expect-state-seq/--expect-agent-session guards reject stale generations before any mutation (stale_generation).",
            "Unknown agent kinds remain operable through the same surface; the providers list enumerates kinds from herdr 0.9.5 detection manifests.",
        ],
        "generated_at": generated_at,
    })
}
