//! Saved-machine transport for `rebuildup.machines` (#161, ADR-0028).
//! Rust port of `plugins/machines/src/remote.ts`.
//!
//! Read-only probe path, deliberately minimal and self-contained
//! (ADR-0028 §2):
//!
//! - `herdr machine list --json` enumerates saved machines.
//! - `herdr --machine <id> api snapshot` proves reachability and yields
//!   remote `version` / `protocol`.
//! - `herdr --machine <id> plugin list --json` enumerates the remote
//!   plugin surface.
//!
//! Every call is a stateless CLI spawn with a timeout; ambient `HERDR_*`
//! context is stripped from children (ADR-0020 rule 1). No credential
//! material is read or stored — SSH auth is OpenSSH-owned.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::model::{probe_shell, MachineEntry, MachineProbe, RemotePluginEntry};

// --- Errors -----------------------------------------------------------------

/// Structured remote/transport failure. `kind` is the coarse taxonomy
/// (`machine_list_failed`, `remote_timeout`, `remote_<code>`,
/// `remote_command_failed`, `remote_malformed`, `machine_not_found`,
/// `machine_ambiguous`, `unknown`); `extra` merges into the CLI error
/// envelope exactly like the TS `RemoteError.extra`.
#[derive(Debug)]
pub struct RemoteError {
    pub message: String,
    pub kind: String,
    pub extra: Option<Value>,
}

impl RemoteError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        RemoteError {
            message: message.into(),
            kind: kind.to_string(),
            extra: None,
        }
    }
    pub fn with_extra(kind: &str, message: impl Into<String>, extra: Value) -> Self {
        RemoteError {
            message: message.into(),
            kind: kind.to_string(),
            extra: Some(extra),
        }
    }
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for RemoteError {}

// --- Process runner ------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RunResult {
    /// Exit code; `None` when the child could not be spawned or was
    /// killed by a signal (mirrors Node's `code: null`).
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// True when the runner killed the child at its timeout.
    pub timed_out: bool,
    /// True when a cooperative cancel flag killed the child.
    pub cancelled: bool,
}

/// Explicit local-herdr target parsed from `--socket PATH` / `--session
/// NAME` CLI flags. The `herdr` CLI has no target flags of its own — the
/// equivalent knobs are the `HERDR_SOCKET_PATH` / `HERDR_SESSION` env
/// vars, which `spawn_herdr` injects into each child.
#[derive(Debug, Clone, Default)]
pub struct HerdrTarget {
    pub socket_path: Option<String>,
    pub session: Option<String>,
}

/// Ambient herdr vars that must never leak into remote CLI children.
const STRIPPED_ENV: [&str; 6] = [
    "HERDR_SOCKET_PATH",
    "HERDR_CLIENT_SOCKET_PATH",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "HERDR_SESSION",
];

/// Default `herdr` binary; HERDR_BIN_PATH overrides (test/dev hook).
pub fn herdr_bin() -> String {
    std::env::var("HERDR_BIN_PATH")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "herdr".to_string())
}

/// Environment for a spawned `herdr` CLI child: ambient `HERDR_*`
/// context stripped (ADR-0020 rule 1 — exactly the STRIPPED_ENV set,
/// other vars pass through verbatim), then explicit `--socket` /
/// `--session` flags re-injected as `HERDR_SOCKET_PATH` /
/// `HERDR_SESSION` — the flag > env > default resolution order. When
/// both flags are given both vars are set and herdr's own precedence
/// (`HERDR_SOCKET_PATH` > `HERDR_SESSION`) applies.
pub fn herdr_child_env(target: Option<&HerdrTarget>) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for (key, value) in std::env::vars() {
        if STRIPPED_ENV.contains(&key.as_str()) {
            continue;
        }
        env.insert(key, value);
    }
    if let Some(t) = target {
        if let Some(socket) = &t.socket_path {
            env.insert("HERDR_SOCKET_PATH".to_string(), socket.clone());
        }
        if let Some(session) = &t.session {
            env.insert("HERDR_SESSION".to_string(), session.clone());
        }
    }
    env
}

/// Spawn the local `herdr` CLI. Each remote call is a fresh process: the
/// `--machine` bridge lifetime is bound to the CLI invocation upstream.
///
/// Mirrors the TS `spawnHerdr` runner: env is fully replaced by
/// `herdr_child_env`, stdio is ignore/pipe/pipe, the child is killed at
/// `timeout_ms` (reported as `timed_out`), and `cancel` (when provided)
/// kills it cooperatively (reported as `cancelled`). Spawn failures
/// resolve with `code: None` and the error text appended to stderr —
/// never an exception — matching the TS `child.on("error")` path.
pub fn spawn_herdr(
    args: &[String],
    timeout_ms: u64,
    target: Option<&HerdrTarget>,
    cancel: Option<Arc<AtomicBool>>,
) -> RunResult {
    let env = herdr_child_env(target);
    let mut command = Command::new(herdr_bin());
    command
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            return RunResult {
                code: None,
                stdout: String::new(),
                stderr: e.to_string(),
                timed_out: false,
                cancelled: false,
            };
        }
    };

    let mut stdout_pipe = child.stdout.take().expect("stdout piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr piped");
    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let (code, timed_out, cancelled) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), false, false),
            Ok(None) => {
                if cancel
                    .as_ref()
                    .map(|c| c.load(Ordering::SeqCst))
                    .unwrap_or(false)
                {
                    let _ = child.kill();
                    let _ = child.wait();
                    break (None, false, true);
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break (None, true, false);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break (None, false, false),
        }
    };

    // Child reaped → pipes at EOF → readers finish; join cannot block
    // indefinitely on a live child.
    let stdout_bytes = stdout_handle.join().unwrap_or_default();
    let stderr_bytes = stderr_handle.join().unwrap_or_default();
    RunResult {
        code,
        stdout: String::from_utf8_lossy(&stdout_bytes).to_string(),
        stderr: String::from_utf8_lossy(&stderr_bytes).to_string(),
        timed_out,
        cancelled,
    }
}

// --- Envelope parsing ---------------------------------------------------------

#[derive(Debug, Default)]
struct CliEnvelope {
    has_result: bool,
    has_error: bool,
    result: Value,
    error: Option<Value>,
}

/// Extract the last JSON envelope line from stdout (or stderr for
/// errors). Port of `parseEnvelope`: scans stdout bottom-up first, then
/// stderr bottom-up; a candidate must parse to an object carrying a
/// `result` or `error` key.
fn parse_envelope(run: &RunResult) -> CliEnvelope {
    for text in [&run.stdout, &run.stderr] {
        let lines: Vec<&str> = text
            .split('\n')
            .map(|l| l.trim())
            .filter(|l| l.starts_with('{') && l.ends_with('}'))
            .collect();
        for line in lines.iter().rev() {
            if let Ok(parsed) = serde_json::from_str::<Value>(line) {
                if let Value::Object(map) = &parsed {
                    let has_result = map.contains_key("result");
                    let has_error = map.contains_key("error");
                    if has_result || has_error {
                        return CliEnvelope {
                            has_result,
                            has_error,
                            result: map.get("result").cloned().unwrap_or(Value::Null),
                            error: map.get("error").cloned(),
                        };
                    }
                }
            }
        }
    }
    CliEnvelope::default()
}

fn as_record(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn str_field<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(|v| v.as_str())
}

/// Run a remote CLI command and return its `result` payload. Throws
/// RemoteError on transport failure, nonzero exit, or an `{error}`
/// envelope — the remote server's own error code/message is preserved.
fn run_remote(
    selector: &str,
    cli_args: &[String],
    timeout_ms: u64,
    target: Option<&HerdrTarget>,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<Value, RemoteError> {
    let mut args = vec!["--machine".to_string(), selector.to_string()];
    args.extend(cli_args.iter().cloned());
    let run = spawn_herdr(&args, timeout_ms, target, cancel);
    if run.cancelled {
        return Err(RemoteError::new("cancelled", "probe cancelled"));
    }
    if run.timed_out {
        return Err(RemoteError::with_extra(
            "remote_timeout",
            format!(
                "herdr --machine {} {} timed out after {}ms",
                selector,
                cli_args.join(" "),
                timeout_ms
            ),
            json!({ "args": args }),
        ));
    }
    let envelope = parse_envelope(&run);
    if envelope.has_error {
        if let Some(Value::Object(err_map)) = &envelope.error {
            let code = err_map
                .get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("remote_error")
                .to_string();
            let message = err_map
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("remote command failed")
                .to_string();
            return Err(RemoteError::with_extra(
                &format!("remote_{code}"),
                format!("{code}: {message}"),
                json!({ "code": code, "message": message }),
            ));
        }
        // `"error": null` or a non-object: the TS code would throw a
        // TypeError reading `.code`; surface an honest generic failure.
        return Err(RemoteError::new(
            "remote_error",
            "remote command returned a malformed error envelope",
        ));
    }
    if run.code != Some(0) {
        let detail = {
            let d = if !run.stderr.trim().is_empty() {
                run.stderr.trim()
            } else {
                run.stdout.trim()
            };
            d.chars().take(400).collect::<String>()
        };
        let detail = if detail.is_empty() {
            "no output".to_string()
        } else {
            detail
        };
        return Err(RemoteError::with_extra(
            "remote_command_failed",
            format!(
                "herdr --machine {} exited {}: {}",
                selector,
                run.code.map(|c| c.to_string()).unwrap_or_else(|| "?".to_string()),
                detail
            ),
            json!({
                "exit_code": run.code,
                "stderr": run.stderr.chars().take(2000).collect::<String>(),
            }),
        ));
    }
    if !envelope.has_result {
        let snippet = if !run.stdout.is_empty() {
            &run.stdout
        } else {
            &run.stderr
        };
        return Err(RemoteError::new(
            "remote_malformed",
            format!(
                "herdr --machine {} returned no result envelope: {}",
                selector,
                snippet.chars().take(300).collect::<String>()
            ),
        ));
    }
    Ok(envelope.result)
}

// --- Saved machines ------------------------------------------------------------

pub const DEFAULT_CALL_TIMEOUT_MS: u64 = 45_000;

/// Enumerate saved machines via `herdr machine list --json`. Throws
/// RemoteError(`machine_list_failed`) on any failure — an inventory that
/// cannot enumerate must fail honestly, never return a partial guess.
pub fn list_machines(target: Option<&HerdrTarget>) -> Result<Vec<MachineEntry>, RemoteError> {
    let args = vec![
        "machine".to_string(),
        "list".to_string(),
        "--json".to_string(),
    ];
    let run = spawn_herdr(&args, DEFAULT_CALL_TIMEOUT_MS, target, None);
    if run.code != Some(0) {
        let detail: String = if !run.stderr.trim().is_empty() {
            run.stderr.trim()
        } else {
            run.stdout.trim()
        }
        .chars()
        .take(300)
        .collect();
        return Err(RemoteError::new(
            "machine_list_failed",
            format!("herdr machine list failed: {detail}"),
        ));
    }
    let parsed: Value = serde_json::from_str(run.stdout.trim()).map_err(|_| {
        RemoteError::new(
            "machine_list_failed",
            "herdr machine list --json returned non-JSON output",
        )
    })?;
    let arr = parsed.as_array().ok_or_else(|| {
        RemoteError::new(
            "machine_list_failed",
            "herdr machine list --json returned a non-array",
        )
    })?;
    let mut machines = Vec::new();
    for entry in arr {
        let e = as_record(entry);
        let (Some(id), Some(target_str)) = (str_field(&e, "id"), str_field(&e, "target")) else {
            continue;
        };
        machines.push(MachineEntry {
            id: id.to_string(),
            label: str_field(&e, "label")
                .map(|s| s.to_string())
                .unwrap_or_else(|| id.to_string()),
            target: target_str.to_string(),
            session: str_field(&e, "session")
                .map(|s| s.to_string())
                .unwrap_or_else(|| "default".to_string()),
            enabled: e.get("enabled").and_then(|v| v.as_bool()) != Some(false),
            selected: e.get("selected").and_then(|v| v.as_bool()),
        });
    }
    Ok(machines)
}

/// Resolve a probe selector (machine id or label) against the saved
/// machine list. Labels match case-insensitively; ids match exactly.
/// Ambiguity and unknown selectors are usage errors (exit 2 upstream).
pub fn resolve_machine(selector: &str, machines: &[MachineEntry]) -> Result<MachineEntry, RemoteError> {
    if let Some(m) = machines.iter().find(|m| m.id == selector) {
        return Ok(m.clone());
    }
    let lower = selector.to_lowercase();
    let by_label: Vec<&MachineEntry> = machines
        .iter()
        .filter(|m| m.label.to_lowercase() == lower)
        .collect();
    if by_label.len() == 1 {
        return Ok(by_label[0].clone());
    }
    if by_label.len() > 1 {
        return Err(RemoteError::with_extra(
            "machine_ambiguous",
            format!(
                "machine selector \"{selector}\" matches multiple machines; use the machine id"
            ),
            json!({
                "matches": by_label.iter().map(|m| m.id.clone()).collect::<Vec<_>>()
            }),
        ));
    }
    Err(RemoteError::with_extra(
        "machine_not_found",
        format!("unknown machine \"{selector}\""),
        json!({ "selector": selector }),
    ))
}

// --- Probe ---------------------------------------------------------------------

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn fail_probe(
    machine: &MachineEntry,
    state: &str,
    kind: &str,
    message: String,
) -> MachineProbe {
    let mut probe = probe_shell(machine, state, now_iso());
    probe.error_kind = Some(kind.to_string());
    probe.error = Some(message);
    probe
}

/// Classify a remote `api snapshot` failure into an honest probe state.
/// Mirrors the TS taxonomy (ADR-0020): bridge-less remotes are
/// `unsupported_remote`, transport/exit failures are `unreachable`,
/// everything else is `error`.
fn classify_snapshot_error(machine: &MachineEntry, err: &RemoteError) -> MachineProbe {
    let msg = &err.message;
    let lower = msg.to_lowercase();
    if lower.contains("remote-api-bridge")
        || lower.contains("machine api forwarding")
        || lower.contains("does not support")
    {
        return fail_probe(
            machine,
            "unsupported_remote",
            &err.kind,
            format!(
                "remote machine \"{}\" runs a herdr without machine API forwarding (needs remote-api-bridge); upgrade herdr on {}",
                machine.label, machine.target
            ),
        );
    }
    if err.kind == "remote_command_failed" || err.kind == "remote_timeout" {
        return fail_probe(
            machine,
            "unreachable",
            &err.kind,
            format!(
                "remote machine \"{}\" ({}) unreachable: {}",
                machine.label, machine.target, msg
            ),
        );
    }
    fail_probe(machine, "error", &err.kind, msg.clone())
}

/// Parse remote `plugin list --json` result into contract entries.
fn parse_plugin_entries(result: &Value) -> Vec<RemotePluginEntry> {
    let record = as_record(result);
    let raw = record
        .get("plugins")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut entries = Vec::new();
    for item in &raw {
        let e = as_record(item);
        let id = str_field(&e, "plugin_id")
            .or_else(|| str_field(&e, "id"))
            .map(|s| s.to_string());
        let Some(id) = id else { continue };
        entries.push(RemotePluginEntry {
            id,
            name: str_field(&e, "name").map(|s| s.to_string()),
            version: str_field(&e, "version").map(|s| s.to_string()),
        });
    }
    entries
}

/// Probe the remote plugin surface after a successful snapshot. Any
/// failure degrades to `plugin_surface: "unsupported"` with the detail
/// preserved — never a fabricated inventory (ADR-0028 §4/§5).
fn probe_plugin_surface(
    machine: &MachineEntry,
    probe: &mut MachineProbe,
    target: Option<&HerdrTarget>,
    cancel: Option<Arc<AtomicBool>>,
) {
    let cli_args = vec!["plugin".to_string(), "list".to_string(), "--json".to_string()];
    match run_remote(
        &machine.id,
        &cli_args,
        DEFAULT_CALL_TIMEOUT_MS,
        target,
        cancel,
    ) {
        Ok(result) => {
            let record = as_record(&result);
            if !record.get("plugins").map(|v| v.is_array()).unwrap_or(false) {
                probe.plugin_surface = "unsupported".to_string();
                let snippet: String = serde_json::to_string(&result)
                    .unwrap_or_default()
                    .chars()
                    .take(200)
                    .collect();
                probe.plugin_surface_error = Some(format!(
                    "remote plugin list returned no plugins array: {snippet}"
                ));
                return;
            }
            probe.plugin_surface = "supported".to_string();
            probe.plugins = Some(parse_plugin_entries(&result));
        }
        Err(err) => {
            probe.plugin_surface = "unsupported".to_string();
            probe.plugin_surface_error = Some(err.message);
        }
    }
}

/// Probe one saved machine: check `enabled`, then `api snapshot` +
/// `plugin list` over the SSH bridge. Always returns a MachineProbe —
/// failures are data, not exceptions (selector resolution stays a
/// usage error upstream).
pub fn probe_machine_entry(
    machine: &MachineEntry,
    target: Option<&HerdrTarget>,
    cancel: Option<Arc<AtomicBool>>,
) -> MachineProbe {
    if !machine.enabled {
        return probe_shell(machine, "disabled", now_iso());
    }

    let cli_args = vec!["api".to_string(), "snapshot".to_string()];
    let result = match run_remote(
        &machine.id,
        &cli_args,
        DEFAULT_CALL_TIMEOUT_MS,
        target,
        cancel.clone(),
    ) {
        Ok(r) => r,
        Err(err) => return classify_snapshot_error(machine, &err),
    };

    let record = as_record(&result);
    // `record.snapshot ?? result` (TS `??`: null/undefined fall through).
    let snapshot_source = match record.get("snapshot") {
        Some(v) if !v.is_null() => v.clone(),
        _ => result.clone(),
    };
    let snap = as_record(&snapshot_source);
    let mut probe = probe_shell(machine, "ok", now_iso());
    probe.server_version = str_field(&snap, "version").map(|s| s.to_string());
    probe.protocol = snap.get("protocol").and_then(|v| v.as_f64());

    probe_plugin_surface(machine, &mut probe, target, cancel);
    probe
}

/// Probe a selector (id or label) against the saved machine list.
/// Throws RemoteError for `machine_not_found` / `machine_ambiguous` /
/// `machine_list_failed`; all probe outcomes are returned as data.
pub fn probe_machine(
    selector: &str,
    target: Option<&HerdrTarget>,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<MachineProbe, RemoteError> {
    let machines = list_machines(target)?;
    let machine = resolve_machine(selector, &machines)?;
    Ok(probe_machine_entry(&machine, target, cancel))
}

/// Probe every saved machine sequentially — each probe re-opens the SSH
/// bridge per call, so parallelism would multiply connection churn for
/// no correctness gain. Stops early when `cancel` fires.
pub fn probe_all_machines(
    target: Option<&HerdrTarget>,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<Vec<MachineProbe>, RemoteError> {
    let machines = list_machines(target)?;
    let mut probes = Vec::new();
    for machine in &machines {
        if cancel
            .as_ref()
            .map(|c| c.load(Ordering::SeqCst))
            .unwrap_or(false)
        {
            break;
        }
        probes.push(probe_machine_entry(machine, target, cancel.clone()));
    }
    Ok(probes)
}
