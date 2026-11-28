//! Typed wrappers for herdr's `agent.*` socket surface — Rust port of
//! `packages/herdr-client/src/agents.ts` scoped to what
//! `rebuildup.controls` consumes (Issue #324).
//!
//! Semantics mirror the TS implementation exactly:
//! - `target` is herdr's agent target (pane id or agent name); herdr
//!   resolves it. Nothing is fabricated.
//! - `agent.prompt` submits text via bracketed paste + Enter upstream.
//! - `agent.send_keys` is PTY-level key injection, not a structured
//!   interrupt.
//! - `agent.read` returns bounded terminal scrollback.
//! - `agent.start` launches a detected kind in an existing shell pane.
//!
//! Error surface: RPC rejections keep herdr's error `code` (mapped by the
//! CLI to the structured `kind`, e.g. `agent_not_found`, `timeout`);
//! transport/target-resolution failures are `Other` and surface as
//! `session_unreachable` — identical to the TS `resolveGuarded` mapping.

use hoxay_herdr_client::socket::{request, ClientError};
use hoxay_herdr_client::target::{resolve_target, ResolveTargetOptions};
use serde_json::{json, Value};

/// Agent statuses herdr reports (protocol 22 enumeration).
pub const AGENT_STATUSES: [&str; 5] = ["idle", "working", "blocked", "done", "unknown"];

/// `agent.read` sources.
pub const AGENT_READ_SOURCES: [&str; 4] =
    ["visible", "recent", "recent_unwrapped", "detection"];

/// `agent.read` formats.
pub const AGENT_READ_FORMATS: [&str; 2] = ["text", "ansi"];

/// Failure from an agent.* call. `Rpc` carries herdr's structured error
/// code; `Other` covers transport and target-resolution failures.
#[derive(Debug)]
pub enum AgentApiError {
    Rpc { code: String, message: String },
    Other(String),
}

impl AgentApiError {
    pub fn rpc_code(&self) -> Option<&str> {
        match self {
            AgentApiError::Rpc { code, .. } => Some(code),
            AgentApiError::Other(_) => None,
        }
    }
    pub fn message(&self) -> String {
        match self {
            AgentApiError::Rpc { message, .. } => message.clone(),
            AgentApiError::Other(m) => m.clone(),
        }
    }
}

impl std::fmt::Display for AgentApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentApiError::Rpc { code, message } => write!(f, "{}: {}", code, message),
            AgentApiError::Other(m) => write!(f, "{}", m),
        }
    }
}
impl std::error::Error for AgentApiError {}

fn from_client(err: ClientError) -> AgentApiError {
    match err {
        ClientError::Rpc(e) => AgentApiError::Rpc {
            code: e.code,
            message: e.message,
        },
        other => AgentApiError::Other(other.to_string()),
    }
}

/// Per-call options shared by all agent.* operations (TS `CallOptions`
/// minus the fields the controls CLI does not expose).
#[derive(Debug, Clone, Default)]
pub struct AgentCallOptions {
    /// Request timeout in ms (default 10_000).
    pub timeout_ms: Option<u64>,
    /// Named herdr session (`--session`).
    pub session: Option<String>,
    /// Explicit socket path (`--socket`).
    pub socket_path: Option<String>,
}

impl AgentCallOptions {
    fn timeout_or_default(&self) -> u64 {
        self.timeout_ms.unwrap_or(10_000)
    }
}

/// Mirrors TS `socketFor` in agents.ts: an explicit `--socket` wins
/// verbatim (no conflict validation — identical to the TS short-circuit);
/// otherwise the target resolves by `--session`/ambient env with the
/// implicit default-session fallback allowed.
fn socket_for(options: &AgentCallOptions) -> Result<String, AgentApiError> {
    if let Some(socket) = &options.socket_path {
        return Ok(socket.clone());
    }
    resolve_target(&ResolveTargetOptions {
        session: options.session.clone(),
        socket_path: None,
        mutation: false,
    })
    .map(|t| t.socket_path)
    .map_err(|e| AgentApiError::Other(e.message))
}

fn call(
    options: &AgentCallOptions,
    method: &str,
    params: Value,
) -> Result<Value, AgentApiError> {
    let socket = socket_for(options)?;
    request(&socket, method, params, options.timeout_or_default()).map_err(from_client)
}

/// Tolerant unwrap helper: callers index into the returned object;
/// a non-object result behaves like `{}` (TS `asRecord`).
fn as_record(value: &Value) -> Value {
    if value.is_object() {
        value.clone()
    } else {
        json!({})
    }
}

/// `agent.get` — resolve a target to its live AgentInfo; rejects when
/// unknown. Tolerant unwrap: `{agent: {...}}` envelope or bare object.
/// `asRecord` semantics: non-object results become `{}`.
pub fn agent_get(target: &str, options: &AgentCallOptions) -> Result<Value, AgentApiError> {
    let result = call(options, "agent.get", json!({ "target": target }))?;
    let agent = result.get("agent").filter(|v| !v.is_null());
    Ok(as_record(agent.unwrap_or(&result)))
}

/// `agent.prompt` wait options (TS `AgentPromptWaitOptions`). Presence of
/// the struct — even with both fields `None` — emits `wait: {}` on the
/// wire, matching the TS `wait !== undefined` check.
#[derive(Debug, Clone, Default)]
pub struct PromptWait {
    pub until: Option<Vec<String>>,
    pub timeout_ms: Option<f64>,
}

/// `agent.prompt` — submit `text` to the agent. `wait` maps to herdr's
/// `wait{until[],timeout_ms}`.
pub fn agent_prompt(
    target: &str,
    text: &str,
    wait: Option<&PromptWait>,
    options: &AgentCallOptions,
) -> Result<Value, AgentApiError> {
    let mut params = json!({ "target": target, "text": text });
    if let Some(wait) = wait {
        let mut wire = serde_json::Map::new();
        if let Some(until) = &wait.until {
            wire.insert(
                "until".to_string(),
                Value::Array(until.iter().map(|s| json!(s)).collect()),
            );
        }
        if let Some(ms) = wait.timeout_ms {
            wire.insert("timeout_ms".to_string(), json_num(ms));
        }
        params["wait"] = Value::Object(wire);
    }
    call(options, "agent.prompt", params)
}

/// `agent.wait` — block until the agent reaches one of `until` or the
/// timeout elapses (structured `timeout` error upstream).
pub fn agent_wait(
    target: &str,
    until: Option<&[String]>,
    timeout_ms: Option<f64>,
    options: &AgentCallOptions,
) -> Result<Value, AgentApiError> {
    let mut wire = serde_json::Map::new();
    wire.insert("target".to_string(), json!(target));
    if let Some(until) = until {
        wire.insert(
            "until".to_string(),
            Value::Array(until.iter().map(|s| json!(s)).collect()),
        );
    }
    if let Some(ms) = timeout_ms {
        wire.insert("timeout_ms".to_string(), json_num(ms));
    }
    call(options, "agent.wait", Value::Object(wire))
}

/// `agent.send_keys` — PTY-level key injection (e.g. ["esc"]).
pub fn agent_send_keys(
    target: &str,
    keys: &[String],
    options: &AgentCallOptions,
) -> Result<Value, AgentApiError> {
    call(
        options,
        "agent.send_keys",
        json!({ "target": target, "keys": keys }),
    )
}

/// `agent.read` — bounded terminal scrollback read (not structured
/// history). Tolerant unwrap: `{read: {...}}` envelope or bare object.
pub fn agent_read(
    target: &str,
    source: &str,
    lines: Option<i64>,
    format: Option<&str>,
    strip_ansi: bool,
    options: &AgentCallOptions,
) -> Result<Value, AgentApiError> {
    let mut wire = serde_json::Map::new();
    wire.insert("target".to_string(), json!(target));
    wire.insert("source".to_string(), json!(source));
    if let Some(lines) = lines {
        wire.insert("lines".to_string(), json!(lines));
    }
    if let Some(format) = format {
        wire.insert("format".to_string(), json!(format));
    }
    wire.insert("strip_ansi".to_string(), json!(strip_ansi));
    let result = call(options, "agent.read", Value::Object(wire))?;
    let read = result.get("read").filter(|v| !v.is_null());
    Ok(as_record(read.unwrap_or(&result)))
}

/// `agent.rename` — set the agent's display name; `name: null` clears.
pub fn agent_rename(
    target: &str,
    name: Option<&str>,
    options: &AgentCallOptions,
) -> Result<Value, AgentApiError> {
    call(
        options,
        "agent.rename",
        json!({ "target": target, "name": name.map(Value::from).unwrap_or(Value::Null) }),
    )
}

/// `agent.start` — launch a detected agent kind in an existing pane.
/// Tolerant unwrap: `{type:"agent_started", agent, argv}` verbatim.
pub fn agent_start(
    name: &str,
    kind: &str,
    pane_id: &str,
    args: &[String],
    timeout_ms: Option<i64>,
    options: &AgentCallOptions,
) -> Result<(Value, Vec<String>), AgentApiError> {
    let mut wire = serde_json::Map::new();
    wire.insert("name".to_string(), json!(name));
    wire.insert("kind".to_string(), json!(kind));
    wire.insert("pane_id".to_string(), json!(pane_id));
    wire.insert(
        "args".to_string(),
        Value::Array(args.iter().map(|a| json!(a)).collect()),
    );
    if let Some(ms) = timeout_ms {
        wire.insert("timeout_ms".to_string(), json!(ms));
    }
    let result = call(options, "agent.start", Value::Object(wire))?;
    let inner = as_record(
        result
            .get("agent_started")
            .filter(|v| !v.is_null())
            .unwrap_or(&result),
    );
    let agent = as_record(
        inner
            .get("agent")
            .filter(|v| !v.is_null())
            .or_else(|| result.get("agent").filter(|v| !v.is_null()))
            .unwrap_or(&Value::Null),
    );
    let argv = inner
        .get("argv")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok((agent, argv))
}

/// JS `Number` → JSON number preserving integer-vs-float rendering
/// (`5000` stays `5000`, `1.5` stays `1.5`).
pub fn json_num(v: f64) -> Value {
    if v.fract() == 0.0 && v >= i64::MIN as f64 && v <= i64::MAX as f64 {
        json!(v as i64)
    } else {
        json!(v)
    }
}
