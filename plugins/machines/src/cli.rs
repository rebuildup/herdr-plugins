//! rebuildup.machines CLI — read-only saved-machine inventory and probe
//! (contract `herdr-plugins.machines/v1`, issue #161, parent #34,
//! boundary ADR-0028). Rust port of `plugins/machines/src/cli.ts`.
//!
//! Commands:
//! - `capability` — machine-readable contract discovery (offline).
//! - `list` — saved machines from `herdr machine list --json` merged
//!   with last-known probe metadata from plugin state (`last_probe`,
//!   null when never probed). No live probing.
//! - `probe <selector|--all>` — live probe via `herdr --machine <id>`:
//!   remote `api snapshot` (reachability + version/protocol) and remote
//!   `plugin list` (plugin surface, honest `unsupported` fallback).
//!   Results are recorded to plugin state as last-known metadata.
//!
//! Every command accepts the shared target flags `--socket PATH` and
//! `--session NAME` selecting the LOCAL herdr instance (forwarded to
//! spawned `herdr` CLI children as HERDR_SOCKET_PATH / HERDR_SESSION —
//! the herdr CLI has no target flags of its own).
//!
//! Machine lifecycle (add/remove/enable/disable/reconnect) is never
//! reimplemented — mutations go through the herdr CLI. No credential
//! handling: SSH auth is OpenSSH-owned.
//!
//! All commands emit a single JSON document on stdout; diagnostics go
//! to stderr. Exit code 0 on success, 1 on handled errors, 2 on usage.

use std::io::Write;

use serde_json::{json, Value};

use crate::model::{
    emit, error_envelope, IMPLEMENTED_COMMANDS, PLUGIN_ID, PLUGIN_SURFACES, PLUGIN_VERSION,
    PROBE_STATES, CONTRACT, CONTRACT_STATUS,
};
use crate::remote::{
    list_machines, probe_all_machines, probe_machine, HerdrTarget, RemoteError,
};
use crate::state::{self, record_probe};

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Write a payload to stdout and flush — `process::exit` does not run
/// destructors, so every emit path must flush explicitly (piped stdout
/// is block-buffered).
fn write_out(text: &str) {
    print!("{text}");
    let _ = std::io::stdout().flush();
}

fn fail(usage: bool, message: &str, kind: Option<&str>, extra: Option<Value>) -> ! {
    let envelope = error_envelope(usage, message, kind, extra);
    let _ = writeln!(std::io::stderr(), "{}", serde_json::to_string(&envelope).unwrap_or_default());
    let _ = std::io::stderr().flush();
    std::process::exit(if usage { 2 } else { 1 });
}

/// Usage failure shorthand (exit 2, `code: "usage"`).
fn usage_fail(message: &str) -> ! {
    fail(true, message, None, None)
}

/// Parsed command arguments. `--socket PATH` / `--session NAME` are the
/// shared plugin target flags; they select the LOCAL herdr instance
/// whose saved machines are listed/probed. Unknown arguments are usage
/// errors (exit 2).
#[derive(Default)]
struct ParsedArgs {
    target: HerdrTarget,
    positionals: Vec<String>,
    all: bool,
}

fn parse_args(args: &[String], allow_all: bool) -> ParsedArgs {
    let mut parsed = ParsedArgs::default();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--socket" || arg == "--session" {
            let value = args.get(i + 1);
            match value {
                Some(v) if !v.starts_with("--") => {
                    if arg == "--socket" {
                        parsed.target.socket_path = Some(v.clone());
                    } else {
                        parsed.target.session = Some(v.clone());
                    }
                    i += 2;
                    continue;
                }
                _ => usage_fail(&format!("option {arg} requires a value")),
            }
        } else if arg == "--all" && allow_all {
            parsed.all = true;
        } else if arg == "--help" || arg == "-h" {
            cmd_help();
            std::process::exit(0);
        } else if !arg.starts_with('-') {
            parsed.positionals.push(arg.clone());
        } else {
            usage_fail(&format!("unknown argument: {arg}"));
        }
        i += 1;
    }
    parsed
}

/// Target flags only; any leftover positional is a usage error.
fn parse_target_only(args: &[String]) -> HerdrTarget {
    let parsed = parse_args(args, false);
    if let Some(first) = parsed.positionals.first() {
        usage_fail(&format!("unexpected argument: {first}"));
    }
    parsed.target
}

/// The `capability` document — single source shared by the CLI command
/// and the TUI info view so the two surfaces cannot drift.
pub fn capability_value() -> Value {
    json!({
        "contract": CONTRACT,
        "contract_status": CONTRACT_STATUS,
        "command": "capability",
        "plugin": PLUGIN_ID,
        "version": PLUGIN_VERSION,
        "read_only": true,
        "mutation_commands": [],
        "commands": IMPLEMENTED_COMMANDS,
        "implemented_commands": IMPLEMENTED_COMMANDS,
        "probe_states": PROBE_STATES,
        "plugin_surfaces": PLUGIN_SURFACES,
        "transport": "herdr machine list --json + herdr --machine <id> <cli> (SavedSshApiBridge)",
        "state_file": state::state_file_path().to_string_lossy(),
        "notes": [
            "Read-only inventory (ADR-0028): machine lifecycle — add/remove/rename/enable/disable/reconnect — is owned by the herdr CLI (`herdr machine …`); this plugin never mutates it.",
            "No credential handling: SSH keys/agent and machine auth are OpenSSH/herdr-owned; the plugin passes target strings to argv only and stores probe metadata (timestamps, versions, reachability) under HERDR_PLUGIN_STATE_DIR.",
            "probe performs remote `api snapshot` (reachability, server_version, protocol) then remote `plugin list --json` (plugin surface). Disabled machines report state=disabled without any SSH attempt; unreachable/bridge-less remotes report unreachable/unsupported_remote — success is never assumed.",
            "plugin_surface=unsupported means the remote answered api snapshot but `plugin list` failed or returned no usable result (older herdr without the plugin.list API method); upstream gap candidate recorded in ADR-0028.",
            "list merges live `herdr machine list --json` with last-known probe metadata (state.probes); it never probes live — run `probe` to refresh.",
            "Global flags --socket PATH / --session NAME select the local herdr target; the herdr CLI has no target flags, so they are forwarded to spawned children as HERDR_SOCKET_PATH / HERDR_SESSION (explicit flag beats ambient env).",
        ],
        "generated_at": now_iso(),
    })
}

fn cmd_capability() {
    write_out(&emit(&capability_value()));
}

fn cmd_help() {
    let payload = json!({
        "contract": CONTRACT,
        "plugin": PLUGIN_ID,
        "version": PLUGIN_VERSION,
        "usage": format!(
            "machines <capability|help|list|probe> [--socket PATH] [--session NAME] — \
             list [saved machines + last probe]; probe <machine-id|label|--all>"
        ),
    });
    write_out(&emit(&payload));
}

fn list_payload(target: &HerdrTarget) -> Result<Value, RemoteError> {
    let machines = list_machines(Some(target))?;
    let state = state::load_state().map_err(|e| RemoteError::new("state_error", e))?;
    let items: Vec<Value> = machines
        .iter()
        .map(|machine| {
            json!({
                "machine": machine,
                "last_probe": state.probes.get(&machine.id).cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(json!({
        "contract": CONTRACT,
        "command": "list",
        "total": items.len(),
        "machines": items,
        "state_file": state::state_file_path().to_string_lossy(),
        "generated_at": now_iso(),
    }))
}

fn cmd_list(target: HerdrTarget) {
    match list_payload(&target) {
        Ok(payload) => write_out(&emit(&payload)),
        Err(err) => fail_with_remote(err),
    }
}

fn probe_payload(
    selector: Option<&str>,
    all: bool,
    target: &HerdrTarget,
) -> Result<Vec<crate::model::MachineProbe>, RemoteError> {
    let probes = if all {
        probe_all_machines(Some(target), None)?
    } else {
        vec![probe_machine(
            selector.expect("selector required"),
            Some(target),
            None,
        )?]
    };
    // Persist last-known probe metadata (lock + atomic rename).
    for probe in &probes {
        record_probe(probe).map_err(|e| RemoteError::new("state_error", e))?;
    }
    Ok(probes)
}

fn cmd_probe(args: &[String]) {
    let parsed = parse_args(args, true);
    let pos = &parsed.positionals;
    if parsed.all && !pos.is_empty() {
        usage_fail("probe accepts either <selector> or --all, not both");
    }
    if !parsed.all && pos.len() != 1 {
        usage_fail("probe requires exactly one <machine-id|label> or --all");
    }

    match probe_payload(
        pos.first().map(|s| s.as_str()),
        parsed.all,
        &parsed.target,
    ) {
        Ok(probes) => {
            let results: Vec<Value> = probes
                .iter()
                .map(|p| serde_json::to_value(p).unwrap_or(Value::Null))
                .collect();
            let payload = json!({
                "contract": CONTRACT,
                "command": "probe",
                "total": results.len(),
                "results": results,
                "state_file": state::state_file_path().to_string_lossy(),
                "generated_at": now_iso(),
            });
            write_out(&emit(&payload));
        }
        Err(err) => fail_with_remote(err),
    }
}

/// Map a RemoteError onto the CLI error envelope: usage kinds exit 2,
/// everything else exit 1; `kind` and `extra` are preserved.
fn fail_with_remote(err: RemoteError) -> ! {
    let usage_kinds = ["machine_not_found", "machine_ambiguous"];
    let usage = usage_kinds.contains(&err.kind.as_str());
    fail(
        usage,
        &err.message,
        Some(&err.kind),
        err.extra.clone(),
    )
}

/// CLI entrypoint; returns the process exit code.
pub fn run_cli(args: &[String]) -> i32 {
    let command = args.first().map(|s| s.as_str()).unwrap_or("help");
    let rest = &args[1.min(args.len())..];
    match command {
        "capability" => {
            parse_target_only(rest);
            cmd_capability();
        }
        "help" | "--help" | "-h" => cmd_help(),
        "list" => cmd_list(parse_target_only(rest)),
        "probe" => cmd_probe(rest),
        other => usage_fail(&format!("unknown command: {other}")),
    }
    0
}

/// Kept for callers that want the list payload as a Value (TUI plain
/// fallback); errors surface as RemoteError.
pub fn list_payload_for_tui(target: &HerdrTarget) -> Result<Value, RemoteError> {
    list_payload(target)
}

/// Capability payload shared by CLI + TUI info view.
pub fn capability_payload() -> Value {
    capability_value()
}
