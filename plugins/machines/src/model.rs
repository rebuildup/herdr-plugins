//! Contract model for `rebuildup.machines` — `herdr-plugins.machines/v1`
//! (issue #161, parent #34, boundary ADR-0028). Rust port of
//! `plugins/machines/src/model.ts`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const CONTRACT: &str = "herdr-plugins.machines/v1";
pub const CONTRACT_STATUS: &str = "draft";
pub const PLUGIN_ID: &str = "rebuildup.machines";
pub const PLUGIN_VERSION: &str = "0.1.0";
pub const STATE_SCHEMA_VERSION: u64 = 1;

/// Commands implemented by this plugin version.
pub const IMPLEMENTED_COMMANDS: [&str; 3] = ["capability", "list", "probe"];

/// Probe outcome taxonomy. Every value is honest — the plugin reports
/// what it observed, never a guessed success:
///
/// - `ok` — remote `api snapshot` answered; version/protocol recorded.
/// - `disabled` — herdr reports the machine disabled; not probed (no SSH
///   attempt). Enable via `herdr machine enable <id>`.
/// - `unreachable` — bridge/SSH/session failure before a remote answer.
/// - `unsupported_remote` — remote answered but lacks machine API
///   forwarding (`remote-api-bridge`, per ADR-0020).
/// - `error` — anything else (malformed output, unexpected failure).
pub const PROBE_STATES: [&str; 5] = [
    "ok",
    "disabled",
    "unreachable",
    "unsupported_remote",
    "error",
];

/// Remote plugin enumeration surface:
///
/// - `supported` — `herdr --machine <id> plugin list --json` returned a
///   `plugin_list` result envelope (API-backed).
/// - `unsupported` — the call failed or returned no usable result; the
///   remote may predate the `plugin.list` API method.
/// - `unknown` — not probed (machine disabled/unreachable).
pub const PLUGIN_SURFACES: [&str; 3] = ["supported", "unsupported", "unknown"];

/// One saved machine as reported by `herdr machine list --json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MachineEntry {
    pub id: String,
    pub label: String,
    /// SSH target (host alias / user@host) — passed to argv only.
    pub target: String,
    /// Remote herdr session name bound to the profile.
    pub session: String,
    pub enabled: bool,
    /// herdr's own "selected" marker when present; null when absent.
    pub selected: Option<bool>,
}

/// A plugin entry from remote `plugin list` (fields tolerated loosely).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RemotePluginEntry {
    pub id: String,
    pub name: Option<String>,
    pub version: Option<String>,
}

/// Result of probing one saved machine. Stored in plugin state as the
/// last-known probe metadata (timestamps, versions, reachability — never
/// credential-adjacent, ADR-0028 §3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MachineProbe {
    pub contract: String,
    pub machine_id: String,
    pub state: String,
    pub probed_at: String,
    /// Null when the machine was not probed (disabled).
    pub reachable: Option<bool>,
    /// Remote `session.snapshot` version; null when unreachable.
    pub server_version: Option<String>,
    /// Remote API protocol; null when unreachable.
    pub protocol: Option<f64>,
    pub plugin_surface: String,
    /// Remote plugin entries; null when not enumerated.
    pub plugins: Option<Vec<RemotePluginEntry>>,
    /// Why plugin_surface is not "supported"; null otherwise.
    pub plugin_surface_error: Option<String>,
    /// Coarse error kind when state != ok (e.g. remote_timeout).
    pub error_kind: Option<String>,
    /// Human-readable error detail; null on success.
    pub error: Option<String>,
}

/// Build a `MachineProbe` shell with every field at its null/unknown
/// default for the given state (port of `probeShell`).
pub fn probe_shell(machine: &MachineEntry, state: &str, probed_at: String) -> MachineProbe {
    MachineProbe {
        contract: CONTRACT.to_string(),
        machine_id: machine.id.clone(),
        state: state.to_string(),
        probed_at,
        reachable: match state {
            "ok" => Some(true),
            "disabled" => None,
            _ => Some(false),
        },
        server_version: None,
        protocol: None,
        plugin_surface: "unknown".to_string(),
        plugins: None,
        plugin_surface_error: None,
        error_kind: None,
        error: None,
    }
}

/// Serialize a payload to the CLI's pretty-printed stdout document
/// (JSON.stringify(payload, null, 2) + "\n" parity).
pub fn emit(payload: &Value) -> String {
    let mut s = serde_json::to_string_pretty(payload).unwrap_or_else(|_| "{}".to_string());
    s.push('\n');
    s
}

/// Build the shared `{contract, ok:false, error}` stderr envelope.
/// `usage` selects `code: "usage"` (exit 2) vs `"error"` (exit 1),
/// mirroring the TS `fail`. `extra` keys are merged into `error` last
/// (Object.assign semantics — they may overwrite `code`/`message`).
pub fn error_envelope(
    usage: bool,
    message: &str,
    kind: Option<&str>,
    extra: Option<Value>,
) -> Value {
    let mut error = Map::new();
    error.insert(
        "code".to_string(),
        json!(if usage { "usage" } else { "error" }),
    );
    error.insert("message".to_string(), json!(message));
    if let Some(k) = kind {
        error.insert("kind".to_string(), json!(k));
    }
    if let Some(Value::Object(map)) = extra {
        for (k, v) in map {
            error.insert(k, v);
        }
    }
    json!({
        "contract": CONTRACT,
        "ok": false,
        "error": Value::Object(error),
    })
}
