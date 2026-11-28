//! rebuildup.artifacts CLI — artifact registry contract
//! (`herdr-plugins.artifacts/v1`, STABLE) for agents and external
//! clients. Single JSON document on stdout; diagnostics on stderr.
//! Exit 0 success, 1 handled error, 2 usage.
//!
//! Rust port of `plugins/artifacts/src/cli.ts`. Registry commands resolve
//! the live session via `session.snapshot` for host/session/owner
//! identity and owner_stale reporting; an unreachable session fails with
//! `session_unreachable` (contract error model). The plugin never
//! executes or renders artifact content (ADR-0024 §4); render-time
//! sandbox/CSP is a herdr-t3 requirement.
//!
//! `dispatch`/`run_cli` are shared with the in-process TUI: the TUI calls
//! the same `cmd_*` cores and parses the same JSON payloads the TS TUI
//! parsed from `runArtifactsCli` subprocess output.

use std::io::Read;

use hoxay_herdr_client::commands::CallOptions;
use hoxay_herdr_client::target::hostname;
use serde_json::{json, Map, Value};

use crate::model::{
    js_date_parse_ms, max_bytes_map, ARTIFACT_ID_PATTERN_SOURCE, ARTIFACT_KINDS, CONTRACT,
    CONTRACT_STATUS, CREATED_BY, IMPLEMENTED_COMMANDS, PLANNED_COMMANDS, PLUGIN_ID,
    PLUGIN_VERSION, STORAGE_MODES,
};
use crate::registry::{
    self, AnnotatedArtifact, DeliverOptions, DeliverTargetKind, GcOptions, ListFilter,
    RegError, RegisterOptions, RegistryError, SearchOptions, VerifyOptions,
};

// ---------------------------------------------------------------------------
// argv / flag parsing (port of parseArgs/parseFlags)
// ---------------------------------------------------------------------------

pub struct CliOptions {
    pub command: String,
    /// Positional args plus per-command `--flag value` pairs, in order.
    pub args: Vec<String>,
    pub session: Option<String>,
    pub socket_path: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// JS `Number(str)` approximation for flag values: trim, "" → 0,
/// "Infinity"/"-Infinity"/"+Infinity", "NaN", hex/octal/binary literals,
/// decimal with optional fraction/exponent.
fn js_number(raw: &str) -> f64 {
    let s = raw.trim();
    if s.is_empty() {
        return 0.0;
    }
    let (sign, body) = match s.strip_prefix('-') {
        Some(r) => (-1.0, r),
        None => (1.0, s.strip_prefix('+').unwrap_or(s)),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    if body == "NaN" {
        return f64::NAN;
    }
    let unsigned = if let Some(h) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        return sign * i64::from_str_radix(h, 16).map(|v| v as f64).unwrap_or(f64::NAN);
    } else if let Some(b) = body.strip_prefix("0b").or_else(|| body.strip_prefix("0B")) {
        return sign * i64::from_str_radix(b, 2).map(|v| v as f64).unwrap_or(f64::NAN);
    } else if let Some(o) = body.strip_prefix("0o").or_else(|| body.strip_prefix("0O")) {
        return sign * i64::from_str_radix(o, 8).map(|v| v as f64).unwrap_or(f64::NAN);
    } else {
        body
    };
    // Reject strings Rust would accept but JS rejects ("inf", "infinity",
    // underscores, trailing junk). Allow digits, one '.', exponent.
    let mut seen_dot = false;
    let mut seen_e = false;
    let mut prev_e = false;
    let bytes = unsigned.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c.is_ascii_digit() {
            prev_e = false;
        } else if c == '.' && !seen_dot && !seen_e {
            seen_dot = true;
        } else if (c == 'e' || c == 'E') && !seen_e && i > 0 && !prev_e {
            seen_e = true;
            prev_e = true;
            i += 1;
            if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
                i += 1;
            }
            continue;
        } else {
            return f64::NAN;
        }
        i += 1;
    }
    unsigned.parse::<f64>().map(|v| sign * v).unwrap_or(f64::NAN)
}

pub fn parse_args(argv: &[String]) -> CliOptions {
    let mut args = argv.to_vec();
    let command = if args.is_empty() {
        String::new()
    } else {
        args.remove(0)
    };
    let mut options = CliOptions {
        command,
        args: Vec::new(),
        session: None,
        socket_path: None,
        timeout_ms: None,
    };
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--session" {
            i += 1;
            if i < args.len() {
                options.session = Some(args[i].clone());
            }
        } else if arg == "--socket" {
            i += 1;
            if i < args.len() {
                options.socket_path = Some(args[i].clone());
            }
        } else if arg == "--timeout" {
            i += 1;
            if i < args.len() {
                let value = js_number(&args[i]);
                if value.is_finite() && value > 0.0 {
                    options.timeout_ms = Some((value as u64).max(1));
                }
            }
        } else {
            rest.push(arg.clone());
        }
        i += 1;
    }
    options.args = rest;
    options
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum FlagVal {
    Str(String),
    Bool,
}

#[derive(Debug, Default)]
struct ParsedFlags {
    positionals: Vec<String>,
    flags: Map<String, FlagVal>,
    multi: Map<String, Vec<String>>,
}

struct FlagSpec {
    valued: &'static [&'static str],
    boolean: &'static [&'static str],
    multi: &'static [&'static str],
}

fn parse_flags(args: &[String], spec: &FlagSpec) -> Result<ParsedFlags, RunError> {
    let mut parsed = ParsedFlags::default();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if let Some(rest) = arg.strip_prefix("--") {
            let name = rest;
            if spec.boolean.contains(&name) {
                parsed.flags.insert(name.to_string(), FlagVal::Bool);
            } else if spec.valued.contains(&name) {
                i += 1;
                let value = args.get(i).ok_or_else(|| usage_fail(format!("missing value for --{}", name)))?;
                if spec.multi.contains(&name) {
                    parsed
                        .multi
                        .entry(name.to_string())
                        .or_default()
                        .push(value.clone());
                } else {
                    parsed.flags.insert(name.to_string(), FlagVal::Str(value.clone()));
                }
            } else {
                return Err(usage_fail(format!("unknown flag: {}", arg)));
            }
        } else {
            parsed.positionals.push(arg.clone());
        }
        i += 1;
    }
    Ok(parsed)
}

fn flag_value<'a>(flags: &'a Map<String, FlagVal>, name: &str) -> Option<&'a str> {
    match flags.get(name) {
        Some(FlagVal::Str(s)) => Some(s.as_str()),
        _ => None,
    }
}

fn flag_bool(flags: &Map<String, FlagVal>, name: &str) -> bool {
    matches!(flags.get(name), Some(FlagVal::Bool))
}

fn flag_int(flags: &Map<String, FlagVal>, name: &str) -> Result<Option<usize>, RunError> {
    let Some(raw) = flag_value(flags, name) else {
        return Ok(None);
    };
    let value = js_number(raw);
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 {
        return Err(usage_fail(format!("--{} must be a non-negative integer", name)));
    }
    Ok(Some(value as usize))
}

/// ISO-8601 filter bound; invalid input is a usage error, not silent.
fn flag_iso(flags: &Map<String, FlagVal>, name: &str) -> Result<Option<String>, RunError> {
    let Some(raw) = flag_value(flags, name) else {
        return Ok(None);
    };
    if js_date_parse_ms(raw).is_none() {
        return Err(usage_fail(format!("--{} must be an ISO-8601 timestamp", name)));
    }
    Ok(Some(raw.to_string()))
}

// ---------------------------------------------------------------------------
// Output / error model
// ---------------------------------------------------------------------------

/// A handled CLI failure: the `error` object written to stderr plus the
/// process exit code. `TuiRun` reuses this for in-process calls.
pub struct RunError {
    pub error: Map<String, Value>,
    pub exit: i32,
}

fn usage_fail(message: impl Into<String>) -> RunError {
    let mut error = Map::new();
    error.insert("code".to_string(), json!("usage"));
    error.insert("message".to_string(), json!(message.into()));
    RunError { error, exit: 2 }
}

fn cli_fail(message: impl Into<String>, kind: Option<&str>) -> RunError {
    let mut error = Map::new();
    error.insert("code".to_string(), json!("error"));
    error.insert("message".to_string(), json!(message.into()));
    if let Some(k) = kind {
        error.insert("kind".to_string(), json!(k));
    }
    RunError { error, exit: 1 }
}

fn reg_fail(err: RegError) -> RunError {
    match err {
        RegError::Domain(e) => domain_fail(e),
        RegError::Plain(message) => cli_fail(message, None),
    }
}

fn domain_fail(e: RegistryError) -> RunError {
    let mut error = Map::new();
    error.insert("code".to_string(), json!(e.code));
    error.insert("message".to_string(), json!(e.message));
    error.insert("kind".to_string(), json!(e.kind));
    if let Some(extra) = e.extra {
        for (k, v) in extra {
            error.insert(k, v);
        }
    }
    let exit = if error.get("code").and_then(|c| c.as_str()) == Some("usage") {
        2
    } else {
        1
    };
    RunError { error, exit }
}

fn emit(payload: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(payload).unwrap_or_default())
}

fn fail_doc(error: &Map<String, Value>) -> String {
    let doc = json!({
        "contract": CONTRACT,
        "ok": false,
        "error": Value::Object(error.clone()),
    });
    format!("{}\n", serde_json::to_string(&doc).unwrap_or_default())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn session_name(
    snapshot: &hoxay_herdr_client::snapshot::SessionSnapshot,
    options: &CliOptions,
) -> String {
    if let Some(name) = snapshot
        .session
        .as_ref()
        .and_then(|s| s.get("name"))
        .and_then(|n| n.as_str())
    {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    options
        .session
        .clone()
        .or_else(|| std::env::var("HERDR_SESSION").ok())
        .unwrap_or_else(|| "default".to_string())
}

fn call_options(options: &CliOptions) -> CallOptions {
    CallOptions {
        timeout_ms: options.timeout_ms,
        session: options.session.clone(),
        socket_path: options.socket_path.clone(),
        mutation: false,
    }
}

fn snapshot_or_fail(options: &CliOptions) -> Result<hoxay_herdr_client::snapshot::SessionSnapshot, RunError> {
    registry::snapshot_or_fail(&call_options(options)).map_err(|e| match e {
        RegError::Domain(d) => domain_fail(d),
        RegError::Plain(m) => cli_fail(m, None),
    })
}

// ---------------------------------------------------------------------------
// Commands — each returns the stdout JSON document
// ---------------------------------------------------------------------------

fn parse_kind(raw: Option<&str>) -> Result<Option<String>, RunError> {
    match raw {
        None => Ok(None),
        Some(v) if ARTIFACT_KINDS.contains(&v) => Ok(Some(v.to_string())),
        Some(_) => Err(usage_fail(format!(
            "--kind must be one of: {}",
            ARTIFACT_KINDS.join(", ")
        ))),
    }
}

fn parse_storage(raw: Option<&str>) -> Result<Option<String>, RunError> {
    match raw {
        None => Ok(None),
        Some(v) if STORAGE_MODES.contains(&v) => Ok(Some(v.to_string())),
        Some(_) => Err(usage_fail(format!(
            "--storage must be one of: {}",
            STORAGE_MODES.join(", ")
        ))),
    }
}

fn parse_created_by(raw: Option<&str>) -> Result<Option<String>, RunError> {
    match raw {
        None => Ok(None),
        Some(v) if CREATED_BY.contains(&v) => Ok(Some(v.to_string())),
        Some(_) => Err(usage_fail(format!(
            "--created-by must be one of: {}",
            CREATED_BY.join(", ")
        ))),
    }
}

fn read_stdin() -> Vec<u8> {
    let mut buf = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut buf);
    buf
}

fn cmd_capability() -> Value {
    json!({
        "contract": CONTRACT,
        "contract_status": CONTRACT_STATUS,
        "command": "capability",
        "plugin": PLUGIN_ID,
        "version": PLUGIN_VERSION,
        "read_only": false,
        "mutation_commands": ["register", "delete", "deliver", "gc"],
        "commands": IMPLEMENTED_COMMANDS.iter().chain(PLANNED_COMMANDS.iter()).collect::<Vec<_>>(),
        "implemented_commands": IMPLEMENTED_COMMANDS,
        "planned_commands": PLANNED_COMMANDS,
        "kinds": ARTIFACT_KINDS,
        "storage_modes": STORAGE_MODES,
        "artifact_id_pattern": ARTIFACT_ID_PATTERN_SOURCE,
        "limits": {
            "max_bytes": max_bytes_map(),
            "path_ref_oversize": "warn",
        },
        "notes": [
            "Contract herdr-plugins.artifacts/v1 is STABLE (T4 #143): register/list/get/search/verify/delete/deliver/gc/export are all implemented; additive changes only from here.",
            "Plugin never executes or renders artifact content; render-time sandbox/CSP/network isolation is a herdr-t3 requirement (ADR-0024, docs/contracts/artifacts-v1.md).",
            "state_copy (default) enforces per-kind caps at register; path_ref records oversize as a warning flag and reports vanished targets as missing_ref.",
            "kind validation: html refuses non-.html/.htm path names and non-document leading bytes (upstream HtmlRender rules); image/pdf/file/other report mime_mismatch / extension_mime_mismatch warnings instead of refusing.",
            "verify re-checks payload existence, sha256, size, mime, and metadata consistency; per-artifact status is ok|corrupt|missing (honest report, exit 0).",
            "deliver sends the artifact's stable absolute path inside agent.prompt (--agent) or pane.send_text (--pane) text; stale panes/agents and missing payloads are refused, upstream RPC codes surface as delivery_failed.rpc_code.",
            "gc collects only unreferenced records older than --older-than; refs-carrying artifacts are skipped (referenced), --dry-run previews, path_ref external files are never deleted.",
            "export emits the complete annotated index for client sync (herdr-t3 read surface); metadata + resolved_path only, never payload bytes.",
            "Registry commands resolve the live session via session.snapshot; unreachable session fails with session_unreachable. gc is pure plugin-state work and needs no session.",
            "v1 attachment delivery is the artifact's stable absolute path inside agent.prompt/pane.send_text text; no structured attachment API exists in herdr protocol 22 (upstream gap candidate, ADR-0024).",
            "SnapShots (OS capture), browser import, and MCP Apps UI are out of plugin scope: herdr-t3/desktop or upstream-blocked on #30 (ADR-0024 section 5).",
        ],
        "generated_at": now(),
    })
}

fn cmd_help() -> Value {
    json!({
        "contract": CONTRACT,
        "plugin": PLUGIN_ID,
        "version": PLUGIN_VERSION,
        "usage": format!(
            "bun run src/cli.ts <capability|help|register|list|get|search|verify|delete|deliver|gc|export> — planned: {}",
            if PLANNED_COMMANDS.is_empty() {
                "none".to_string()
            } else {
                PLANNED_COMMANDS.join("|")
            }
        ),
    })
}

fn annotated_list(artifacts: &[AnnotatedArtifact]) -> Vec<Value> {
    artifacts.iter().map(|a| a.to_json()).collect()
}

fn cmd_register(options: &CliOptions) -> Result<Value, RunError> {
    let spec = FlagSpec {
        valued: &["path", "kind", "storage", "title", "pane", "created-by", "ref"],
        boolean: &["stdin"],
        multi: &["ref"],
    };
    let parsed = parse_flags(&options.args, &spec)?;
    if !parsed.positionals.is_empty() {
        return Err(usage_fail(format!("unexpected argument: {}", parsed.positionals[0])));
    }
    let path_value = flag_value(&parsed.flags, "path");
    let use_stdin = flag_bool(&parsed.flags, "stdin") || path_value == Some("-");
    if use_stdin && path_value.is_some() && path_value != Some("-") {
        return Err(usage_fail("--stdin cannot be combined with --path"));
    }
    if !use_stdin && path_value.is_none() {
        return Err(usage_fail("register requires --path FILE or --stdin"));
    }
    let snapshot = snapshot_or_fail(options)?;
    let pane_id = flag_value(&parsed.flags, "pane").map(|s| s.to_string());
    let agent_session = pane_id
        .as_ref()
        .and_then(|p| registry::agent_session_for_pane(&snapshot, p));
    let record = registry::register_artifact(&RegisterOptions {
        source_path: if use_stdin { None } else { path_value.map(|s| s.to_string()) },
        bytes: if use_stdin { Some(read_stdin()) } else { None },
        kind: parse_kind(flag_value(&parsed.flags, "kind"))?,
        storage: parse_storage(flag_value(&parsed.flags, "storage"))?,
        title: flag_value(&parsed.flags, "title").map(|s| s.to_string()),
        pane_id: pane_id.clone(),
        agent_session,
        created_by: parse_created_by(flag_value(&parsed.flags, "created-by"))?,
        refs: parsed.multi.get("ref").cloned(),
        host: hostname(),
        session: session_name(&snapshot, options),
    })
    .map_err(reg_fail)?;
    Ok(json!({
        "contract": CONTRACT,
        "ok": true,
        "command": "register",
        "artifact": serde_json::to_value(&record).unwrap_or(Value::Null),
        "generated_at": now(),
    }))
}

fn filter_from_flags(
    parsed: &ParsedFlags,
) -> Result<(ListFilter, Option<String>, Option<String>, Option<usize>), RunError> {
    Ok((
        ListFilter {
            kind: parse_kind(flag_value(&parsed.flags, "kind"))?,
            pane_id: flag_value(&parsed.flags, "pane").map(|s| s.to_string()),
            agent_session: flag_value(&parsed.flags, "agent").map(|s| s.to_string()),
            created_by: parse_created_by(flag_value(&parsed.flags, "created-by"))?,
            session: flag_value(&parsed.flags, "session").map(|s| s.to_string()),
            limit: None, // set by caller
        },
        flag_iso(&parsed.flags, "since")?,
        flag_iso(&parsed.flags, "until")?,
        flag_int(&parsed.flags, "limit")?,
    ))
}

fn cmd_list(options: &CliOptions) -> Result<Value, RunError> {
    let spec = FlagSpec {
        valued: &["kind", "pane", "agent", "created-by", "session", "limit"],
        boolean: &[],
        multi: &[],
    };
    let parsed = parse_flags(&options.args, &spec)?;
    if !parsed.positionals.is_empty() {
        return Err(usage_fail(format!("unexpected argument: {}", parsed.positionals[0])));
    }
    let snapshot = snapshot_or_fail(options)?;
    let (mut filter, _, _, limit) = filter_from_flags(&parsed)?;
    filter.limit = limit;
    let result = registry::list_artifacts(&filter, Some(&snapshot)).map_err(reg_fail)?;
    Ok(json!({
        "contract": CONTRACT,
        "ok": true,
        "command": "list",
        "session": session_name(&snapshot, options),
        "artifacts": annotated_list(&result.artifacts),
        "total": result.total,
        "orphans": result.orphans,
        "corrupt": result.corrupt,
        "generated_at": now(),
    }))
}

fn cmd_get(options: &CliOptions) -> Result<Value, RunError> {
    let spec = FlagSpec {
        valued: &[],
        boolean: &[],
        multi: &[],
    };
    let parsed = parse_flags(&options.args, &spec)?;
    let id = parsed.positionals.first().cloned();
    if id.is_none() || parsed.positionals.len() != 1 {
        return Err(usage_fail("get requires exactly one artifact_id"));
    }
    let snapshot = snapshot_or_fail(options)?;
    let artifact = registry::get_artifact(id.as_deref().unwrap_or(""), Some(&snapshot))
        .map_err(reg_fail)?;
    Ok(json!({
        "contract": CONTRACT,
        "ok": true,
        "command": "get",
        "session": session_name(&snapshot, options),
        "artifact": artifact.to_json(),
        "generated_at": now(),
    }))
}

fn cmd_search(options: &CliOptions) -> Result<Value, RunError> {
    let spec = FlagSpec {
        valued: &["kind", "pane", "agent", "created-by", "session", "since", "until", "limit"],
        boolean: &[],
        multi: &[],
    };
    let parsed = parse_flags(&options.args, &spec)?;
    let query = parsed.positionals.first().cloned();
    if query.is_none() || parsed.positionals.len() != 1 {
        return Err(usage_fail("search requires exactly one query"));
    }
    let snapshot = snapshot_or_fail(options)?;
    let (mut filter, since, until, limit) = filter_from_flags(&parsed)?;
    filter.limit = limit;
    let result = registry::search_artifacts(
        &SearchOptions {
            filter,
            query: query.unwrap_or_default(),
            since,
            until,
        },
        Some(&snapshot),
    )
    .map_err(reg_fail)?;
    Ok(json!({
        "contract": CONTRACT,
        "ok": true,
        "command": "search",
        "session": session_name(&snapshot, options),
        "artifacts": annotated_list(&result.artifacts),
        "total": result.total,
        "query": result.query,
        "orphans": result.orphans,
        "corrupt": result.corrupt,
        "generated_at": now(),
    }))
}

fn cmd_verify(options: &CliOptions) -> Result<Value, RunError> {
    let spec = FlagSpec {
        valued: &[],
        boolean: &[],
        multi: &[],
    };
    let parsed = parse_flags(&options.args, &spec)?;
    let id = parsed.positionals.first().cloned();
    if parsed.positionals.len() > 1 {
        return Err(usage_fail("verify accepts at most one artifact_id"));
    }
    let snapshot = snapshot_or_fail(options)?;
    let result = registry::verify_artifacts(
        &VerifyOptions {
            artifact_id: id,
        },
        Some(&snapshot),
    )
    .map_err(reg_fail)?;
    let report = result.to_json();
    Ok(json!({
        "contract": CONTRACT,
        "ok": true,
        "command": "verify",
        "session": session_name(&snapshot, options),
        "results": report.get("results").cloned().unwrap_or(Value::Null),
        "summary": report.get("summary").cloned().unwrap_or(Value::Null),
        "orphans": report.get("orphans").cloned().unwrap_or(Value::Null),
        "corrupt": report.get("corrupt").cloned().unwrap_or(Value::Null),
        "generated_at": now(),
    }))
}

fn cmd_delete(options: &CliOptions) -> Result<Value, RunError> {
    let spec = FlagSpec {
        valued: &[],
        boolean: &["force"],
        multi: &[],
    };
    let parsed = parse_flags(&options.args, &spec)?;
    let id = parsed.positionals.first().cloned();
    if id.is_none() || parsed.positionals.len() != 1 {
        return Err(usage_fail("delete requires exactly one artifact_id"));
    }
    let snapshot = snapshot_or_fail(options)?;
    let result = registry::delete_artifact(id.as_deref().unwrap_or(""), flag_bool(&parsed.flags, "force"))
        .map_err(reg_fail)?;
    Ok(json!({
        "contract": CONTRACT,
        "ok": true,
        "command": "delete",
        "session": session_name(&snapshot, options),
        "artifact_id": result.artifact_id,
        "storage_mode": result.storage_mode,
        "removed_payload": result.removed_payload,
        "generated_at": now(),
    }))
}

fn cmd_deliver(options: &CliOptions) -> Result<Value, RunError> {
    let spec = FlagSpec {
        valued: &["pane", "agent", "note"],
        boolean: &[],
        multi: &[],
    };
    let parsed = parse_flags(&options.args, &spec)?;
    let pane_id = flag_value(&parsed.flags, "pane");
    let agent_pane_id = flag_value(&parsed.flags, "agent");
    if (pane_id.is_none()) == (agent_pane_id.is_none()) {
        return Err(usage_fail("deliver requires exactly one of --pane PANE or --agent PANE"));
    }
    let id = parsed.positionals.first().cloned();
    if id.is_none() || parsed.positionals.len() != 1 {
        return Err(usage_fail("deliver requires exactly one artifact_id"));
    }
    let snapshot = snapshot_or_fail(options)?;
    let session = session_name(&snapshot, options);
    let result = registry::deliver_artifact(&DeliverOptions {
        artifact_id: id.unwrap_or_default(),
        target_kind: if pane_id.is_some() {
            DeliverTargetKind::Pane
        } else {
            DeliverTargetKind::Agent
        },
        pane_id: (pane_id.or(agent_pane_id)).unwrap_or_default().to_string(),
        note: flag_value(&parsed.flags, "note").map(|s| s.to_string()),
        snapshot,
        call_options: call_options(options),
    })
    .map_err(reg_fail)?;
    let result_json = result.to_json();
    let mut payload = Map::new();
    payload.insert("contract".to_string(), json!(CONTRACT));
    payload.insert("ok".to_string(), json!(true));
    payload.insert("command".to_string(), json!("deliver"));
    payload.insert("session".to_string(), json!(session));
    if let Value::Object(fields) = result_json {
        for (k, v) in fields {
            payload.insert(k, v);
        }
    }
    payload.insert("generated_at".to_string(), json!(now()));
    Ok(Value::Object(payload))
}

fn cmd_gc(options: &CliOptions) -> Result<Value, RunError> {
    let spec = FlagSpec {
        valued: &["older-than"],
        boolean: &["dry-run"],
        multi: &[],
    };
    let parsed = parse_flags(&options.args, &spec)?;
    if !parsed.positionals.is_empty() {
        return Err(usage_fail(format!("unexpected argument: {}", parsed.positionals[0])));
    }
    let older_than = flag_iso(&parsed.flags, "older-than")?;
    let Some(older_than) = older_than else {
        return Err(usage_fail("gc requires --older-than ISO-8601"));
    };
    // gc is pure plugin-state work: no session.snapshot, works offline.
    let result = registry::gc_artifacts(&GcOptions {
        older_than,
        dry_run: flag_bool(&parsed.flags, "dry-run"),
    })
    .map_err(reg_fail)?;
    let report = result.to_json();
    let mut payload = Map::new();
    payload.insert("contract".to_string(), json!(CONTRACT));
    payload.insert("ok".to_string(), json!(true));
    payload.insert("command".to_string(), json!("gc"));
    for key in [
        "policy",
        "dry_run",
        "evaluated",
        "expired",
        "entries",
        "totals",
        "orphans",
        "corrupt",
    ] {
        if let Some(v) = report.get(key) {
            payload.insert(key.to_string(), v.clone());
        }
    }
    payload.insert("generated_at".to_string(), json!(now()));
    Ok(Value::Object(payload))
}

fn cmd_export(options: &CliOptions) -> Result<Value, RunError> {
    let spec = FlagSpec {
        valued: &["kind", "pane", "agent", "created-by", "session", "limit"],
        boolean: &[],
        multi: &[],
    };
    let parsed = parse_flags(&options.args, &spec)?;
    if !parsed.positionals.is_empty() {
        return Err(usage_fail(format!("unexpected argument: {}", parsed.positionals[0])));
    }
    let snapshot = snapshot_or_fail(options)?;
    // Export is the complete client read surface: no default page cap —
    // --limit N truncates honestly and `complete` reports the truncation.
    let limit = flag_int(&parsed.flags, "limit")?.unwrap_or(0);
    let mut filter = ListFilter {
        kind: parse_kind(flag_value(&parsed.flags, "kind"))?,
        pane_id: flag_value(&parsed.flags, "pane").map(|s| s.to_string()),
        agent_session: flag_value(&parsed.flags, "agent").map(|s| s.to_string()),
        created_by: parse_created_by(flag_value(&parsed.flags, "created-by"))?,
        session: flag_value(&parsed.flags, "session").map(|s| s.to_string()),
        limit: Some(limit),
    };
    filter.limit = Some(limit);
    let result = registry::list_artifacts(&filter, Some(&snapshot)).map_err(reg_fail)?;
    // `filters` echoes only the flags that were actually provided.
    let mut filters = Map::new();
    if let Some(v) = flag_value(&parsed.flags, "kind") {
        filters.insert("kind".to_string(), json!(v));
    }
    if let Some(v) = flag_value(&parsed.flags, "pane") {
        filters.insert("pane".to_string(), json!(v));
    }
    if let Some(v) = flag_value(&parsed.flags, "agent") {
        filters.insert("agent".to_string(), json!(v));
    }
    if let Some(v) = flag_value(&parsed.flags, "created-by") {
        filters.insert("created-by".to_string(), json!(v));
    }
    if let Some(v) = flag_value(&parsed.flags, "session") {
        filters.insert("session".to_string(), json!(v));
    }
    Ok(json!({
        "contract": CONTRACT,
        "ok": true,
        "command": "export",
        "session": session_name(&snapshot, options),
        "artifacts": annotated_list(&result.artifacts),
        "total": result.total,
        "returned": result.artifacts.len(),
        "complete": result.artifacts.len() >= result.total,
        "filters": Value::Object(filters),
        "orphans": result.orphans,
        "corrupt": result.corrupt,
        "generated_at": now(),
    }))
}

/// Dispatch one parsed command line to its handler. Returns the stdout
/// document on success or a `RunError` (stderr doc + exit code).
pub fn dispatch(options: &CliOptions) -> Result<Value, RunError> {
    match options.command.as_str() {
        "capability" => Ok(cmd_capability()),
        "help" | "--help" | "-h" => Ok(cmd_help()),
        "register" => cmd_register(options),
        "list" => cmd_list(options),
        "get" => cmd_get(options),
        "search" => cmd_search(options),
        "verify" => cmd_verify(options),
        "delete" => cmd_delete(options),
        "deliver" => cmd_deliver(options),
        "gc" => cmd_gc(options),
        "export" => cmd_export(options),
        other => {
            if PLANNED_COMMANDS.contains(&other) {
                let mut error = Map::new();
                error.insert("code".to_string(), json!("contract_draft"));
                error.insert(
                    "message".to_string(),
                    json!(format!(
                        "command '{}' is part of the draft contract but not implemented yet (T4: #143)",
                        other
                    )),
                );
                error.insert("kind".to_string(), json!("contract_draft"));
                error.insert("command".to_string(), json!(other));
                return Err(RunError { error, exit: 1 });
            }
            Err(usage_fail(format!("unknown command: {}", options.command)))
        }
    }
}

/// Full CLI entry: parse argv, dispatch, format stdout/stderr.
/// Returns (exit_code, stdout, stderr) — the binary prints them; the TUI
/// consumes them in-process.
pub fn run_cli(argv: &[String]) -> (i32, String, String) {
    let options = parse_args(argv);
    match dispatch(&options) {
        Ok(payload) => (0, emit(&payload), String::new()),
        Err(err) => (err.exit, String::new(), fail_doc(&err.error)),
    }
}
