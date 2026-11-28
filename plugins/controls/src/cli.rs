//! `rebuildup.controls` CLI — agent operation core contract
//! (`herdr-plugins.controls/v1`). Rust port of
//! `plugins/controls/src/cli.ts`.
//!
//! Single JSON document on stdout; diagnostics on stderr.
//! Exit 0 success, 1 handled error, 2 usage.
//!
//! All operations go through herdr's `agent.*` socket API — never PTY
//! text scraping, never fabricated agent state (ADR-0017). `interrupt`
//! is explicitly PTY-level key injection; `read` is scrollback, not
//! structured history.
//!
//! The command cores return `Result<Value, CliFailure>` so the TUI can
//! invoke the same code paths in-process (no self-respawn); only the
//! process entrypoint (`run`) maps failures to the stderr document +
//! exit code.

use std::collections::{HashMap, HashSet};

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};

use crate::agentapi::{self, AgentApiError, AgentCallOptions};
use crate::capability::{capability_payload, CONTRACT};
use crate::commands::{build_command_text, command_info_for};
use crate::identity::{
    check_generation, identity_for_agent, resolve_agent, ControlsError, GenerationExpectation,
    ResolvedAgent,
};
use crate::launch::{build_launch_args, canonical_kind, LaunchRequest, PERMISSION_MODES};

pub const PLUGIN_VERSION: &str = "0.6.0";

const START_TIMEOUT_MIN_MS: i64 = 3000;
const START_TIMEOUT_MAX_MS: i64 = 300000;

// --- failure surface -----------------------------------------------------------

/// Structured CLI failure: maps 1:1 onto the TS `fail(message, code,
/// kind?, extra?)` stderr document. `exit_code` 2 renders `code:"usage"`
/// with no `kind`; otherwise `code:"error"` plus optional `kind`.
#[derive(Debug)]
pub struct CliFailure {
    pub message: String,
    pub exit_code: i32,
    pub kind: Option<String>,
    pub extra: Option<Map<String, Value>>,
}

impl CliFailure {
    fn new(message: impl Into<String>, exit_code: i32) -> Self {
        CliFailure {
            message: message.into(),
            exit_code,
            kind: None,
            extra: None,
        }
    }

    fn usage(message: impl Into<String>) -> Self {
        CliFailure::new(message, 2)
    }

    fn handled(message: impl Into<String>, kind: impl Into<String>) -> Self {
        CliFailure {
            message: message.into(),
            exit_code: 1,
            kind: Some(kind.into()),
            extra: None,
        }
    }

    fn with_extra(mut self, extra: Map<String, Value>) -> Self {
        self.extra = Some(extra);
        self
    }

    /// TS `fail` document: `{contract, ok:false, error:{code,message,kind?,...extra}}`.
    pub fn error_doc(&self) -> Value {
        let mut error = Map::new();
        error.insert(
            "code".to_string(),
            json!(if self.exit_code == 2 { "usage" } else { "error" }),
        );
        error.insert("message".to_string(), json!(self.message));
        if let Some(kind) = &self.kind {
            error.insert("kind".to_string(), json!(kind));
        }
        if let Some(extra) = &self.extra {
            for (k, v) in extra {
                error.insert(k.clone(), v.clone());
            }
        }
        json!({ "contract": CONTRACT, "ok": false, "error": Value::Object(error) })
    }
}

impl std::fmt::Display for CliFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for CliFailure {}

/// Map a `ControlsError` (identity/launch/commands validation) onto the
/// CLI failure surface — identical to the TS `catch` blocks:
/// `kind === "usage"` → exit 2 without a `kind` field; otherwise exit 1
/// with `kind` + `extra`.
fn controls_failure(err: ControlsError) -> CliFailure {
    if err.kind == "usage" {
        CliFailure::usage(err.message)
    } else {
        let mut f = CliFailure::handled(err.message, err.kind);
        f.extra = err.extra;
        f
    }
}

/// Map an `AgentApiError` onto the CLI failure surface — identical to
/// the TS `isAgentRpcError` / transport split: RPC rejections keep
/// herdr's error `code` as `kind`; everything else is
/// `session_unreachable`.
fn agent_failure(err: AgentApiError) -> CliFailure {
    match err {
        AgentApiError::Rpc { code, message } => CliFailure::handled(message, code),
        AgentApiError::Other(message) => CliFailure::handled(
            format!("herdr session unreachable: {}", message),
            "session_unreachable",
        ),
    }
}

// --- argv parsing ---------------------------------------------------------------

#[derive(Debug, Default)]
pub struct CliOptions {
    pub command: String,
    pub args: Vec<String>,
    pub session: Option<String>,
    pub socket_path: Option<String>,
    pub timeout_ms: Option<u64>,
}

impl CliOptions {
    fn call_options(&self) -> AgentCallOptions {
        AgentCallOptions {
            timeout_ms: self.timeout_ms,
            session: self.session.clone(),
            socket_path: self.socket_path.clone(),
        }
    }
}

/// TS `parseArgs`: first arg is the command (`help` default); `--session`,
/// `--socket`, `--timeout` are consumed anywhere in the tail; everything
/// else is positional command args.
fn parse_args(argv: &[String]) -> CliOptions {
    let mut args: Vec<String> = argv.to_vec();
    let command = if args.is_empty() {
        "help".to_string()
    } else {
        args.remove(0)
    };
    let mut options = CliOptions {
        command,
        ..Default::default()
    };
    let mut rest = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
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
                // JS `Number(v)`: finite && > 0 → timeoutMs; anything
                // else (NaN, 0, negative, missing) is ignored silently.
                if let Ok(v) = args[i].trim().parse::<f64>() {
                    if v.is_finite() && v > 0.0 {
                        options.timeout_ms = Some(v as u64);
                    }
                }
            }
        } else {
            rest.push(arg.to_string());
        }
        i += 1;
    }
    options.args = rest;
    options
}

// --- output helpers -------------------------------------------------------------

fn emit(payload: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(payload).unwrap_or_default()
    );
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

// --- per-command argument parsing -----------------------------------------------

#[derive(Debug, Default)]
struct ParsedArgs {
    positionals: Vec<String>,
    /// Last value per option name.
    values: HashMap<String, String>,
    /// All values per option name, for repeatable options.
    multi: HashMap<String, Vec<String>>,
    flags: HashSet<String>,
}

impl ParsedArgs {
    fn push(&mut self, name: &str, value: String) {
        self.values.insert(name.to_string(), value.clone());
        self.multi
            .entry(name.to_string())
            .or_default()
            .push(value);
    }
}

/// Split command args into positionals, `--name value`/`--name=value`
/// options, and bare boolean flags (same convention as the TS
/// `parseCommandArgs`). Usage errors return `CliFailure` (exit 2).
fn parse_command_args(args: &[String], value_flags: &HashSet<&str>) -> Result<ParsedArgs, CliFailure> {
    let mut parsed = ParsedArgs::default();
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if let Some(rest) = arg.strip_prefix("--") {
            let _ = rest;
            if let Some(eq) = arg.find('=') {
                if eq > 0 {
                    let name = arg[..eq].to_string();
                    let value = arg[eq + 1..].to_string();
                    parsed.push(&name, value);
                    i += 1;
                    continue;
                }
            }
            if value_flags.contains(arg) {
                i += 1;
                if i >= args.len() {
                    return Err(CliFailure::usage(format!("{} requires a value", arg)));
                }
                parsed.push(arg, args[i].clone());
            } else {
                parsed.flags.insert(arg.to_string());
            }
        } else {
            parsed.positionals.push(arg.to_string());
        }
        i += 1;
    }
    Ok(parsed)
}

const EXPECT_VALUE_FLAGS: [&str; 3] = [
    "--expect-pane",
    "--expect-state-seq",
    "--expect-agent-session",
];

fn expectation_flags() -> HashSet<&'static str> {
    HashSet::from(EXPECT_VALUE_FLAGS)
}

fn expectation_from(parsed: &ParsedArgs) -> Result<GenerationExpectation, CliFailure> {
    let mut expected = GenerationExpectation::default();
    if let Some(pane) = parsed.values.get("--expect-pane") {
        expected.pane = Some(pane.clone());
    }
    if let Some(seq_raw) = parsed.values.get("--expect-state-seq") {
        // JS Number + Number.isInteger + >= 0.
        let seq = seq_raw.trim().parse::<f64>().unwrap_or(f64::NAN);
        if !seq.is_finite() || seq.fract() != 0.0 || seq < 0.0 {
            return Err(CliFailure::usage(format!(
                "--expect-state-seq must be a non-negative integer, got: {}",
                seq_raw
            )));
        }
        expected.state_seq = Some(seq);
    }
    if let Some(session) = parsed.values.get("--expect-agent-session") {
        expected.agent_session = Some(session.clone());
    }
    Ok(expected)
}

/// Resolve + generation-guard the target. RPC errors keep herdr's error
/// code as the structured `kind` (e.g. `agent_not_found`, `timeout`);
/// transport failures become `session_unreachable`.
fn resolve_guarded(
    target: &str,
    options: &AgentCallOptions,
    parsed: &ParsedArgs,
) -> Result<ResolvedAgent, CliFailure> {
    let resolved = resolve_agent(target, options).map_err(agent_failure)?;
    let expected = expectation_from(parsed)?;
    check_generation(&resolved, &expected).map_err(controls_failure)?;
    Ok(resolved)
}

fn parse_statuses(values: Option<&Vec<String>>, flag: &str) -> Result<Option<Vec<String>>, CliFailure> {
    let Some(values) = values else {
        return Ok(None);
    };
    let mut out = Vec::new();
    for value in values {
        if !agentapi::AGENT_STATUSES.contains(&value.as_str()) {
            return Err(CliFailure::usage(format!(
                "{} must be one of {}, got: {}",
                flag,
                agentapi::AGENT_STATUSES.join("|"),
                value
            )));
        }
        out.push(value.clone());
    }
    Ok(Some(out))
}

fn parse_timeout_ms(parsed: &ParsedArgs) -> Result<Option<f64>, CliFailure> {
    let Some(raw) = parsed.values.get("--timeout-ms") else {
        return Ok(None);
    };
    let value = raw.trim().parse::<f64>().unwrap_or(f64::NAN);
    if !value.is_finite() || value < 0.0 {
        return Err(CliFailure::usage(format!(
            "--timeout-ms must be a non-negative number, got: {}",
            raw
        )));
    }
    Ok(Some(value))
}

/// `agent.prompt` wait options shared by `send`/`command`: `--wait` flag
/// or `--wait-until`/`--timeout-ms` imply a wait object (possibly empty,
/// matching the TS `wait !== undefined` wire check).
fn prompt_wait(
    parsed: &ParsedArgs,
    until: Option<Vec<String>>,
    timeout_ms: Option<f64>,
) -> Option<agentapi::PromptWait> {
    let wants_wait = parsed.flags.contains("--wait") || until.is_some();
    if wants_wait || timeout_ms.is_some() {
        Some(agentapi::PromptWait { until, timeout_ms })
    } else {
        None
    }
}

fn blocked_guard(resolved: &ResolvedAgent) -> Result<(), CliFailure> {
    // herdr rejects agent.prompt on a blocked agent with `agent_blocked`
    // before any input is sent; surface the same semantics as a
    // structured error without ever reporting success (issue #99).
    if resolved.identity.agent_status.as_deref() == Some("blocked") {
        let mut extra = Map::new();
        extra.insert("identity".to_string(), resolved.identity.to_json());
        extra.insert("agent_status".to_string(), json!("blocked"));
        extra.insert(
            "hint".to_string(),
            json!("resolve the interactive prompt in the pane (see `interrupt` for PTY-level keys) or use a structured dialog surface when available"),
        );
        return Err(CliFailure::handled(
            "agent is blocked and requires interactive input; agent.prompt would be rejected",
            "requires_interactive_input",
        )
        .with_extra(extra));
    }
    Ok(())
}

// --- commands ---------------------------------------------------------------------

fn cmd_capability() -> Result<Value, CliFailure> {
    Ok(capability_payload(PLUGIN_VERSION, &now()))
}

fn cmd_send(options: &CliOptions, parsed_args: &[String]) -> Result<Value, CliFailure> {
    let mut value_flags = expectation_flags();
    value_flags.insert("--wait-until");
    value_flags.insert("--timeout-ms");
    let parsed = parse_command_args(parsed_args, &value_flags)?;
    let target = parsed.positionals.first().cloned();
    let text = parsed
        .positionals
        .get(1..)
        .map(|s| s.join(" "))
        .unwrap_or_default();
    let (Some(target), false) = (target, text.is_empty()) else {
        return Err(CliFailure::usage("send requires <target> and <text>"));
    };
    let until = parse_statuses(parsed.multi.get("--wait-until"), "--wait-until")?;
    let timeout_ms = parse_timeout_ms(&parsed)?;

    let resolved = resolve_guarded(&target, &options.call_options(), &parsed)?;
    blocked_guard(&resolved)?;

    let wait = prompt_wait(&parsed, until, timeout_ms);
    let waited = wait.is_some();

    let result = agentapi::agent_prompt(
        &target,
        &text,
        wait.as_ref(),
        &options.call_options(),
    )
    .map_err(agent_failure)?;

    Ok(json!({
        "contract": CONTRACT,
        "command": "send",
        "identity": resolved.identity.to_json(),
        "waited": waited,
        "result": result,
        "generated_at": now(),
    }))
}

fn cmd_command(options: &CliOptions, parsed_args: &[String]) -> Result<Value, CliFailure> {
    let mut value_flags = expectation_flags();
    value_flags.insert("--wait-until");
    value_flags.insert("--timeout-ms");
    let parsed = parse_command_args(parsed_args, &value_flags)?;
    let target = parsed.positionals.first().cloned();
    let slash_command = parsed.positionals.get(1).cloned();
    let command_args: Vec<String> = parsed
        .positionals
        .get(2..)
        .map(|s| s.to_vec())
        .unwrap_or_default();
    let (Some(target), Some(slash_command)) = (target, slash_command) else {
        return Err(CliFailure::usage(
            "command requires <target> and <slash-command> (e.g. /model)",
        ));
    };

    let built = build_command_text(&slash_command, &command_args).map_err(controls_failure)?;

    let until = parse_statuses(parsed.multi.get("--wait-until"), "--wait-until")?;
    let timeout_ms = parse_timeout_ms(&parsed)?;

    let resolved = resolve_guarded(&target, &options.call_options(), &parsed)?;
    blocked_guard(&resolved)?;

    let wait = prompt_wait(&parsed, until, timeout_ms);
    let waited = wait.is_some();

    let result = agentapi::agent_prompt(
        &target,
        &built.text,
        wait.as_ref(),
        &options.call_options(),
    )
    .map_err(agent_failure)?;

    Ok(json!({
        "contract": CONTRACT,
        "command": "command",
        "identity": resolved.identity.to_json(),
        "passthrough": "agent.prompt",
        "command_name": format!("/{}", built.name),
        "text": built.text,
        "provider": command_info_for(resolved.identity.agent.as_deref(), &built.name),
        "fragile": true,
        "waited": waited,
        "result": result,
        "generated_at": now(),
    }))
}

fn cmd_wait(options: &CliOptions, parsed_args: &[String]) -> Result<Value, CliFailure> {
    let mut value_flags = expectation_flags();
    value_flags.insert("--until");
    value_flags.insert("--timeout-ms");
    let parsed = parse_command_args(parsed_args, &value_flags)?;
    let target = parsed.positionals.first().cloned();
    if target.is_none() || parsed.positionals.len() > 1 {
        return Err(CliFailure::usage("wait requires exactly one <target>"));
    }
    let target = target.unwrap();
    let until = parse_statuses(parsed.multi.get("--until"), "--until")?;
    let timeout_ms = parse_timeout_ms(&parsed)?;

    let resolved = resolve_guarded(&target, &options.call_options(), &parsed)?;

    let result = agentapi::agent_wait(
        &target,
        until.as_deref(),
        timeout_ms,
        &options.call_options(),
    )
    .map_err(agent_failure)?;

    Ok(json!({
        "contract": CONTRACT,
        "command": "wait",
        "identity": resolved.identity.to_json(),
        "result": result,
        "generated_at": now(),
    }))
}

fn cmd_interrupt(options: &CliOptions, parsed_args: &[String]) -> Result<Value, CliFailure> {
    let mut value_flags = expectation_flags();
    value_flags.insert("--key");
    value_flags.insert("--keys");
    let parsed = parse_command_args(parsed_args, &value_flags)?;
    let target = parsed.positionals.first().cloned();
    if target.is_none() || parsed.positionals.len() > 1 {
        return Err(CliFailure::usage("interrupt requires exactly one <target>"));
    }
    let target = target.unwrap();
    // --key is repeatable; a comma-separated --keys value is also accepted.
    let mut keys: Vec<String> = Vec::new();
    if let Some(list) = parsed.multi.get("--key") {
        keys.extend(list.iter().cloned());
    }
    if let Some(keys_opt) = parsed.values.get("--keys") {
        for k in keys_opt.split(',') {
            let trimmed = k.trim();
            if !trimmed.is_empty() {
                keys.push(trimmed.to_string());
            }
        }
    }
    let final_keys = if keys.is_empty() {
        vec!["esc".to_string()]
    } else {
        keys
    };

    let resolved = resolve_guarded(&target, &options.call_options(), &parsed)?;

    let result = agentapi::agent_send_keys(&target, &final_keys, &options.call_options())
        .map_err(agent_failure)?;

    Ok(json!({
        "contract": CONTRACT,
        "command": "interrupt",
        "identity": resolved.identity.to_json(),
        "keys": final_keys,
        "pty_level": true,
        "result": result,
        "generated_at": now(),
    }))
}

fn cmd_read(options: &CliOptions, parsed_args: &[String]) -> Result<Value, CliFailure> {
    let mut value_flags = expectation_flags();
    for f in ["--source", "--lines", "--format"] {
        value_flags.insert(f);
    }
    let parsed = parse_command_args(parsed_args, &value_flags)?;
    let target = parsed.positionals.first().cloned();
    if target.is_none() || parsed.positionals.len() > 1 {
        return Err(CliFailure::usage("read requires exactly one <target>"));
    }
    let target = target.unwrap();
    let source_raw = parsed
        .values
        .get("--source")
        .cloned()
        .unwrap_or_else(|| "recent".to_string());
    if !agentapi::AGENT_READ_SOURCES.contains(&source_raw.as_str()) {
        return Err(CliFailure::usage(format!(
            "--source must be one of {}, got: {}",
            agentapi::AGENT_READ_SOURCES.join("|"),
            source_raw
        )));
    }
    let format_raw = parsed.values.get("--format").cloned();
    if let Some(f) = &format_raw {
        if !agentapi::AGENT_READ_FORMATS.contains(&f.as_str()) {
            return Err(CliFailure::usage(format!(
                "--format must be one of {}, got: {}",
                agentapi::AGENT_READ_FORMATS.join("|"),
                f
            )));
        }
    }
    let mut lines: Option<i64> = None;
    if let Some(lines_raw) = parsed.values.get("--lines") {
        // JS Number.isInteger + >= 0.
        let value = lines_raw.trim().parse::<f64>().unwrap_or(f64::NAN);
        if !value.is_finite() || value.fract() != 0.0 || value < 0.0 {
            return Err(CliFailure::usage(format!(
                "--lines must be a non-negative integer, got: {}",
                lines_raw
            )));
        }
        lines = Some(value as i64);
    }
    // ansi output is meaningless stripped; strip_ansi defaults to true for
    // text and false for ansi unless the caller says otherwise.
    let strip_ansi = if parsed.flags.contains("--no-strip-ansi") {
        false
    } else {
        format_raw.as_deref() != Some("ansi")
    };

    let resolved = resolve_guarded(&target, &options.call_options(), &parsed)?;

    let read = agentapi::agent_read(
        &target,
        &source_raw,
        lines,
        format_raw.as_deref(),
        strip_ansi,
        &options.call_options(),
    )
    .map_err(agent_failure)?;

    Ok(json!({
        "contract": CONTRACT,
        "command": "read",
        "identity": resolved.identity.to_json(),
        "scrollback": true,
        "read": read,
        "generated_at": now(),
    }))
}

fn cmd_rename(options: &CliOptions, parsed_args: &[String]) -> Result<Value, CliFailure> {
    let mut value_flags = expectation_flags();
    value_flags.insert("--name");
    let parsed = parse_command_args(parsed_args, &value_flags)?;
    let target = parsed.positionals.first().cloned();
    if target.is_none() || parsed.positionals.len() > 1 {
        return Err(CliFailure::usage("rename requires exactly one <target>"));
    }
    let target = target.unwrap();
    let name = parsed.values.get("--name").cloned();
    let clear = parsed.flags.contains("--clear");
    // TS: `(name === undefined) === !clear` → exactly one of --name/--clear.
    if (name.is_none()) == !clear {
        return Err(CliFailure::usage(
            "rename requires exactly one of --name NAME or --clear",
        ));
    }

    let resolved = resolve_guarded(&target, &options.call_options(), &parsed)?;

    let result = agentapi::agent_rename(
        &target,
        if clear { None } else { name.as_deref() },
        &options.call_options(),
    )
    .map_err(agent_failure)?;

    Ok(json!({
        "contract": CONTRACT,
        "command": "rename",
        "identity": resolved.identity.to_json(),
        "name": if clear { Value::Null } else { name.map(Value::from).unwrap_or(Value::Null) },
        "result": result,
        "generated_at": now(),
    }))
}

/// `/^[a-z][a-z0-9_-]{0,31}$/` — herdr agent name rules.
fn is_agent_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    let rest: Vec<char> = chars.collect();
    rest.len() <= 31
        && rest.iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-'
        })
}

fn cmd_start(options: &CliOptions, parsed_args: &[String]) -> Result<Value, CliFailure> {
    // TS parity: `--expect-*` flags are NOT value flags for `start`
    // (they land in `flags`, never `values`), so expectations are
    // silently ignored here — kept identical, not "fixed".
    let value_flags: HashSet<&str> = [
        "--agent",
        "--name",
        "--model",
        "--reasoning",
        "--permission-mode",
        "--resume",
        "--resume-from",
        "--arg",
        "--timeout-ms",
        "--wait-until",
        "--wait-timeout-ms",
    ]
    .into_iter()
    .collect();
    let parsed = parse_command_args(parsed_args, &value_flags)?;
    let pane = parsed.positionals.first().cloned();
    if pane.is_none() || parsed.positionals.len() > 1 {
        return Err(CliFailure::usage("start requires exactly one <pane_id>"));
    }
    let pane = pane.unwrap();
    let kind_raw = parsed.values.get("--agent").cloned();
    let Some(kind_raw) = kind_raw.filter(|k| !k.is_empty()) else {
        return Err(CliFailure::usage("start requires --agent <kind>"));
    };
    let kind = canonical_kind(&kind_raw);

    // Default name keeps launches distinct; herdr enforces uniqueness.
    let name = parsed.values.get("--name").cloned().unwrap_or_else(|| {
        format!("{}-{}", kind, rand_hex4())
    });
    if !is_agent_name(&name) {
        return Err(CliFailure::usage(format!(
            "--name must match [a-z][a-z0-9_-]{{0,31}} (herdr agent name rules), got: {}",
            name
        )));
    }

    let permission_mode = match parsed.values.get("--permission-mode") {
        Some(raw) => {
            if !PERMISSION_MODES.contains(&raw.as_str()) {
                return Err(CliFailure::usage(format!(
                    "--permission-mode must be one of {}, got: {}",
                    PERMISSION_MODES.join("|"),
                    raw
                )));
            }
            Some(raw.clone())
        }
        None => None,
    };

    // --- Resume value: --resume <value> or --resume-from <agent target> ---
    let resume_raw = parsed.values.get("--resume").cloned();
    let resume_from = parsed.values.get("--resume-from").cloned();
    if resume_raw.is_some() && resume_from.is_some() {
        return Err(CliFailure::usage(
            "start accepts at most one of --resume or --resume-from",
        ));
    }
    let mut resume_value: Option<String> = None;
    let mut resume_session_kind: Option<String> = None;
    let mut resume_source: Option<Value> = None;
    if let Some(raw) = resume_raw {
        resume_value = Some(raw);
    } else if let Some(from) = resume_from {
        // Resolve the source agent and reuse its reported session ref —
        // the same agent_session signal every other command echoes.
        let source = resolve_guarded(&from, &options.call_options(), &parsed)?;
        let session = source
            .identity
            .agent_session
            .as_ref()
            .and_then(|s| s.value.clone());
        let Some(session_value) = session else {
            let mut extra = Map::new();
            extra.insert("identity".to_string(), source.identity.to_json());
            return Err(CliFailure::handled(
                format!("target {} has no reported agent_session to resume", from),
                "no_agent_session",
            )
            .with_extra(extra));
        };
        let session_agent = source
            .identity
            .agent_session
            .as_ref()
            .and_then(|s| s.agent.clone());
        if let Some(sa) = &session_agent {
            if sa != &kind && sa != &kind_raw {
                let mut extra = Map::new();
                extra.insert("identity".to_string(), source.identity.to_json());
                extra.insert("expected_agent".to_string(), json!(kind_raw));
                return Err(CliFailure::handled(
                    format!(
                        "agent_session reports provider '{}', which does not match --agent '{}'",
                        sa, kind_raw
                    ),
                    "resume_session_mismatch",
                )
                .with_extra(extra));
            }
        }
        let sk = source
            .identity
            .agent_session
            .as_ref()
            .and_then(|s| s.kind.clone());
        resume_session_kind = match sk.as_deref() {
            Some("path") => Some("path".to_string()),
            Some("id") => Some("id".to_string()),
            _ => None,
        };
        // The reporting source is not part of the echoed AgentSessionRef
        // contract; read it from the raw agent record for the launch echo.
        // TS emits `resume_source` (string or null) whenever
        // --resume-from was used.
        resume_source = Some(
            source
                .agent
                .get("agent_session")
                .and_then(|s| s.get("source"))
                .and_then(|v| v.as_str())
                .map(|s| json!(s))
                .unwrap_or(Value::Null),
        );
        resume_value = Some(session_value);
    }

    let extra_args: Vec<String> = parsed.multi.get("--arg").cloned().unwrap_or_default();
    let unsafe_args = parsed.flags.contains("--unsafe-args");

    let built = build_launch_args(&LaunchRequest {
        kind: kind.clone(),
        model: parsed.values.get("--model").cloned(),
        reasoning: parsed.values.get("--reasoning").cloned(),
        permission_mode: permission_mode.clone(),
        resume_value: resume_value.clone(),
        resume_session_kind: resume_session_kind.clone(),
        extra_args: extra_args.clone(),
        unsafe_args,
    })
    .map_err(controls_failure)?;

    let timeout_ms = match parsed.values.get("--timeout-ms") {
        Some(raw) => {
            let value = raw.trim().parse::<f64>().unwrap_or(f64::NAN);
            if !value.is_finite()
                || value.fract() != 0.0
                || value <= START_TIMEOUT_MIN_MS as f64
                || value > START_TIMEOUT_MAX_MS as f64
            {
                return Err(CliFailure::usage(format!(
                    "--timeout-ms must be an integer in ({}, {}], got: {}",
                    START_TIMEOUT_MIN_MS, START_TIMEOUT_MAX_MS, raw
                )));
            }
            Some(value as i64)
        }
        None => None,
    };

    // Post-launch wait options are validated before agent.start so a
    // usage error never leaves a launched agent behind.
    let wait_until = parse_statuses(parsed.multi.get("--wait-until"), "--wait-until")?;
    let wait_timeout_ms = match parsed.values.get("--wait-timeout-ms") {
        Some(raw) => {
            let value = raw.trim().parse::<f64>().unwrap_or(f64::NAN);
            if !value.is_finite() || value < 0.0 {
                return Err(CliFailure::usage(format!(
                    "--wait-timeout-ms must be a non-negative number, got: {}",
                    raw
                )));
            }
            Some(value)
        }
        None => None,
    };

    let (started_agent, started_argv) = agentapi::agent_start(
        &name,
        &kind,
        &pane,
        &built.args,
        timeout_ms,
        &options.call_options(),
    )
    .map_err(agent_failure)?;

    let identity = identity_for_agent(&started_agent, &options.call_options());

    // Optional post-launch observation: agent.start already waits for
    // interactive readiness (timeout_ms above); --wait* adds an explicit
    // agent.wait until idle/working with a structured timeout.
    let wants_wait =
        parsed.flags.contains("--wait") || wait_until.is_some() || wait_timeout_ms.is_some();
    let mut wait_result: Option<Value> = None;
    if wants_wait {
        let until: Vec<String> = wait_until
            .clone()
            .unwrap_or_else(|| vec!["idle".to_string(), "working".to_string()]);
        match agentapi::agent_wait(
            identity.pane_id.as_deref().unwrap_or(&pane),
            Some(&until),
            wait_timeout_ms,
            &options.call_options(),
        ) {
            Ok(v) => wait_result = Some(v),
            Err(err) => {
                // TS: fail(..., {launched: true, identity}) — the agent
                // WAS launched; the error doc still reports failure.
                let mut f = agent_failure(err);
                let mut extra = Map::new();
                extra.insert("launched".to_string(), json!(true));
                extra.insert("identity".to_string(), identity.to_json());
                f.extra = Some(match f.extra {
                    Some(mut e) => {
                        e.extend(extra);
                        e
                    }
                    None => extra,
                });
                return Err(f);
            }
        }
    }

    let mut launch = Map::new();
    launch.insert("kind".to_string(), json!(kind));
    launch.insert("requested_kind".to_string(), json!(kind_raw));
    launch.insert("name".to_string(), json!(name));
    launch.insert("pane_id".to_string(), json!(pane));
    launch.insert(
        "args".to_string(),
        Value::Array(built.args.iter().map(|a| json!(a)).collect()),
    );
    launch.insert(
        "argv".to_string(),
        Value::Array(started_argv.iter().map(|a| json!(a)).collect()),
    );
    launch.insert("applied".to_string(), Value::Object(built.applied));
    if let Some(src) = resume_source {
        launch.insert("resume_source".to_string(), src);
    }

    let mut out = Map::new();
    out.insert("contract".to_string(), json!(CONTRACT));
    out.insert("command".to_string(), json!("start"));
    out.insert("identity".to_string(), identity.to_json());
    out.insert("launch".to_string(), Value::Object(launch));
    if wants_wait {
        out.insert("waited".to_string(), json!(true));
        out.insert(
            "wait".to_string(),
            wait_result.unwrap_or(Value::Null),
        );
    }
    out.insert("generated_at".to_string(), json!(now()));
    Ok(Value::Object(out))
}

/// `Math.random().toString(16).slice(2, 6)` equivalent: up to 4
/// lowercase hex digits from a cheap PRNG (uniqueness is enforced by
/// herdr anyway; this only keeps default launch names distinct).
fn rand_hex4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    // xorshift over time + pid — adequate for a display-name suffix.
    let mut x = nanos ^ ((std::process::id() as u64) << 32);
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    let v = (x & 0xffff) as u32;
    // JS slice(2,6) can yield fewer than 4 chars for tiny fractions;
    // emulate by trimming leading zeros like Number→hex does.
    let s = format!("{:x}", v);
    if s.len() >= 4 {
        s[s.len() - 4..].to_string()
    } else {
        format!("{:0>4}", s)
    }
}

const USAGE: &str = "rebuildup.controls — agent operation core (herdr-plugins.controls/v1)

Usage: controls <command> [args] [--session NAME] [--socket PATH] [--timeout MS]

Commands:
  capability                                  Contract/provider/operation discovery (offline)
  send <target> <text...> [--wait] [--wait-until STATUS]... [--timeout-ms MS]
  command <target> <slash-command> [args...] [--wait] [--wait-until STATUS]... [--timeout-ms MS]
       (provider slash-command passthrough via agent.prompt; fragile, provider-TUI dependent)
  wait <target> [--until STATUS]... [--timeout-ms MS]
  interrupt <target> [--key KEY]... [--keys k1,k2]   (PTY-level keys; default: esc)
  read <target> [--source visible|recent|recent-unwrapped|detection] [--lines N] [--format text|ansi] [--no-strip-ansi]
  rename <target> (--name NAME | --clear)
  start <pane_id> --agent <kind> [--name NAME] [--model M] [--reasoning L]
       [--permission-mode supervised|auto-accept-edits|auto|full-access]
       [--resume SESSION | --resume-from TARGET] [--arg ARG]... [--unsafe-args]
       [--timeout-ms MS] [--wait] [--wait-until STATUS]... [--wait-timeout-ms MS]

Identity guards (all agent-target commands): --expect-pane ID --expect-state-seq N --expect-agent-session VALUE
  Any mismatch aborts with stale_generation before the agent.* call.

Errors: {contract, ok:false, error:{code,message,kind?}} on stderr; exit 1 handled, 2 usage.";

/// Dispatch one CLI invocation to its JSON payload. This is the shared
/// core used by both the process entrypoint and the in-process TUI
/// bridge — identical argv → identical payload/failure.
pub fn dispatch(options: &CliOptions) -> Result<Value, CliFailure> {
    match options.command.as_str() {
        "capability" => cmd_capability(),
        "send" => cmd_send(options, &options.args),
        "command" => cmd_command(options, &options.args),
        "wait" => cmd_wait(options, &options.args),
        "interrupt" => cmd_interrupt(options, &options.args),
        "read" => cmd_read(options, &options.args),
        "rename" => cmd_rename(options, &options.args),
        "start" => cmd_start(options, &options.args),
        "help" | "--help" | "-h" => {
            // Handled by the caller (prints USAGE, no JSON).
            Err(CliFailure {
                message: "__help__".to_string(),
                exit_code: 0,
                kind: None,
                extra: None,
            })
        }
        other => Err(CliFailure::usage(format!(
            "unknown command: {}\n\n{}",
            other, USAGE
        ))),
    }
}

/// Process entrypoint: parse argv, dispatch, emit JSON / error doc.
/// Returns the process exit code (caller exits with it).
pub fn run(argv: &[String]) -> i32 {
    let options = parse_args(argv);
    match dispatch(&options) {
        Ok(payload) => {
            emit(&payload);
            0
        }
        Err(f) if f.exit_code == 0 => {
            // `help` sentinel — print usage text, not a JSON doc.
            println!("{}", USAGE);
            0
        }
        Err(f) => {
            eprintln!(
                "{}",
                serde_json::to_string(&f.error_doc()).unwrap_or_default()
            );
            f.exit_code
        }
    }
}

/// Convenience for tests/TUI: run with argv tail (no global flags
/// pre-parsed) and return the payload or failure.
pub fn run_args(args: &[String]) -> Result<Value, CliFailure> {
    let options = parse_args(args);
    if options.command == "help" || options.command == "--help" || options.command == "-h" {
        return Err(CliFailure {
            message: "__help__".to_string(),
            exit_code: 0,
            kind: None,
            extra: None,
        });
    }
    dispatch(&options)
}
