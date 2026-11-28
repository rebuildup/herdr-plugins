//! Agent identity resolution and generation guarding for
//! `rebuildup.controls` (Issue #99 / parent #27 T1). Rust port of
//! `plugins/controls/src/identity.ts`.
//!
//! Every operation resolves `<target>` through `agent.get` first, so a
//! non-agent pane or unknown target fails before any mutation is sent.
//! The resolved identity (host / herdr session / workspace / tab / pane /
//! agent_session / state_change_seq) is echoed in every result — the
//! AGENTS.md §4 invariant that organize/control state never applies to a
//! different agent generation.
//!
//! Optional caller expectations (`--expect-pane`,
//! `--expect-state-seq`, `--expect-agent-session`) pin the generation the
//! caller observed; any mismatch aborts with `stale_generation` before
//! the mutating `agent.*` call. There is no persistent state in this
//! plugin — guards are per-invocation.

use hoxay_herdr_client::commands::{self, CallOptions};
use hoxay_herdr_client::target::hostname;
use serde_json::{json, Map, Value};

use crate::agentapi::{self, json_num, AgentApiError, AgentCallOptions};

/// Structured plugin error: `kind` is the contract error kind
/// (`stale_generation`, `unsupported_launch_option`, `usage`, …) and
/// `extra` carries the additional error-document fields (identity,
/// mismatches, supported_modes, …) exactly as the TS `ControlsError`.
#[derive(Debug)]
pub struct ControlsError {
    pub message: String,
    pub kind: String,
    pub extra: Option<Map<String, Value>>,
}

impl ControlsError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        ControlsError {
            message: message.into(),
            kind: kind.to_string(),
            extra: None,
        }
    }

    pub fn usage(message: impl Into<String>) -> Self {
        ControlsError::new("usage", message)
    }

    pub fn with_extra(mut self, extra: Map<String, Value>) -> Self {
        self.extra = Some(extra);
        self
    }
}

impl std::fmt::Display for ControlsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for ControlsError {}

/// `agent_session` ref as reported by herdr — only the string fields
/// herdr reports are echoed (TS `agentSessionRef`).
#[derive(Debug, Clone, Default)]
pub struct AgentSessionRef {
    pub agent: Option<String>,
    pub kind: Option<String>,
    pub value: Option<String>,
}

impl AgentSessionRef {
    /// JSON form: `{agent?, kind?, value?}` — present string fields
    /// only; `null` upstream becomes `None` here.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        if let Some(v) = &self.agent {
            map.insert("agent".to_string(), json!(v));
        }
        if let Some(v) = &self.kind {
            map.insert("kind".to_string(), json!(v));
        }
        if let Some(v) = &self.value {
            map.insert("value".to_string(), json!(v));
        }
        Value::Object(map)
    }

    pub fn is_empty(&self) -> bool {
        self.agent.is_none() && self.kind.is_none() && self.value.is_none()
    }
}

/// Resolved agent identity echoed in every result.
#[derive(Debug, Clone)]
pub struct AgentIdentity {
    pub host: String,
    pub herdr_session: String,
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    pub agent: Option<String>,
    pub agent_session: Option<AgentSessionRef>,
    /// `state_change_seq` at resolve time; `None` when herdr reports
    /// none. Kept as raw JSON so integer rendering is preserved.
    pub state_change_seq: Option<Value>,
    pub agent_status: Option<String>,
    pub interactive_ready: Option<Value>,
    pub launch_pending: Option<Value>,
}

impl AgentIdentity {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("host".to_string(), json!(self.host));
        map.insert("herdr_session".to_string(), json!(self.herdr_session));
        map.insert(
            "workspace_id".to_string(),
            self.workspace_id
                .as_ref()
                .map(|s| json!(s))
                .unwrap_or(Value::Null),
        );
        map.insert(
            "tab_id".to_string(),
            self.tab_id
                .as_ref()
                .map(|s| json!(s))
                .unwrap_or(Value::Null),
        );
        map.insert(
            "pane_id".to_string(),
            self.pane_id
                .as_ref()
                .map(|s| json!(s))
                .unwrap_or(Value::Null),
        );
        map.insert(
            "agent".to_string(),
            self.agent
                .as_ref()
                .map(|s| json!(s))
                .unwrap_or(Value::Null),
        );
        map.insert(
            "agent_session".to_string(),
            self.agent_session
                .as_ref()
                .map(|r| r.to_json())
                .unwrap_or(Value::Null),
        );
        map.insert(
            "state_change_seq".to_string(),
            self.state_change_seq.clone().unwrap_or(Value::Null),
        );
        map.insert(
            "agent_status".to_string(),
            self.agent_status
                .as_ref()
                .map(|s| json!(s))
                .unwrap_or(Value::Null),
        );
        if let Some(v) = &self.interactive_ready {
            map.insert("interactive_ready".to_string(), v.clone());
        }
        if let Some(v) = &self.launch_pending {
            map.insert("launch_pending".to_string(), v.clone());
        }
        Value::Object(map)
    }
}

// --- tolerant field accessors (TS `str`, `typeof === "number"`) -------------

/// TS `str()`: non-empty string or null.
pub fn str_field(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn agent_field<'a>(agent: &'a Value, key: &str) -> Option<&'a Value> {
    agent.get(key)
}

/// `agent_session` ref from an agent record — object with string
/// `agent`/`kind`/`value` fields only; `null` when absent or empty.
pub fn agent_session_ref(agent: &Value) -> Option<AgentSessionRef> {
    let session = agent_field(agent, "agent_session")?;
    if !session.is_object() {
        return None;
    }
    let ref_ = AgentSessionRef {
        agent: session
            .get("agent")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        kind: session
            .get("kind")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        value: session
            .get("value")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    };
    if ref_.is_empty() {
        None
    } else {
        Some(ref_)
    }
}

fn herdr_session_name(
    snapshot_session: Option<&Value>,
    options_session: Option<&str>,
) -> String {
    if let Some(name) = snapshot_session
        .and_then(|s| s.get("name"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        return name.to_string();
    }
    if let Some(s) = options_session {
        return s.to_string();
    }
    // TS: `process.env.HERDR_SESSION ?? "default"` — used verbatim.
    if let Ok(env) = std::env::var("HERDR_SESSION") {
        return env;
    }
    "default".to_string()
}

/// A resolved agent: the raw `agent.get` record plus its identity.
#[derive(Debug, Clone)]
pub struct ResolvedAgent {
    pub agent: Value,
    pub identity: AgentIdentity,
}

/// Resolve `target` via `agent.get` and build the full identity. RPC
/// failures propagate as `AgentApiError::Rpc` (the CLI maps `.code` to
/// the structured error kind); transport failures surface as `Other`
/// mapped to `session_unreachable`.
pub fn resolve_agent(
    target: &str,
    options: &AgentCallOptions,
) -> Result<ResolvedAgent, AgentApiError> {
    let agent = agentapi::agent_get(target, options)?;
    let identity = identity_for_agent(&agent, options);
    Ok(ResolvedAgent { agent, identity })
}

/// Build the full identity for an already-resolved agent record (e.g.
/// the `agent` field of an `agent.start` result). Session name is
/// display metadata; a snapshot failure must not fail the operation.
pub fn identity_for_agent(agent: &Value, options: &AgentCallOptions) -> AgentIdentity {
    // session.snapshot uses the FULL target resolution (socket+session
    // conflict checks) — identical to the TS commands.ts socketFor.
    let snapshot_session = commands::session_snapshot(&CallOptions {
        timeout_ms: options.timeout_ms,
        session: options.session.clone(),
        socket_path: options.socket_path.clone(),
        mutation: false,
    })
    .ok()
    .and_then(|snap| snap.session);

    let session_ref = agent_session_ref(agent);
    let agent_name = str_field(agent_field(agent, "agent"))
        .or_else(|| session_ref.as_ref().and_then(|r| r.agent.clone()));

    let state_change_seq = agent
        .get("state_change_seq")
        .filter(|v| v.is_number())
        .cloned();

    AgentIdentity {
        host: hostname(),
        herdr_session: herdr_session_name(
            snapshot_session.as_ref(),
            options.session.as_deref(),
        ),
        workspace_id: str_field(agent_field(agent, "workspace_id")),
        tab_id: str_field(agent_field(agent, "tab_id")),
        pane_id: str_field(agent_field(agent, "pane_id")),
        agent: agent_name,
        agent_session: session_ref,
        state_change_seq,
        agent_status: str_field(agent_field(agent, "agent_status")),
        interactive_ready: agent
            .get("interactive_ready")
            .filter(|v| v.is_boolean())
            .cloned(),
        launch_pending: agent
            .get("launch_pending")
            .filter(|v| v.is_boolean())
            .cloned(),
    }
}

/// Caller-pinned generation signals (`--expect-*`).
#[derive(Debug, Clone, Default)]
pub struct GenerationExpectation {
    pub pane: Option<String>,
    pub state_seq: Option<f64>,
    pub agent_session: Option<String>,
}

/// Compare caller-pinned generation signals against the live agent.
/// Any provided expectation that does not match aborts with
/// `stale_generation` — the mutation is never sent.
pub fn check_generation(
    resolved: &ResolvedAgent,
    expected: &GenerationExpectation,
) -> Result<(), ControlsError> {
    let mut mismatches = Map::new();
    if let Some(expected_pane) = &expected.pane {
        if Some(expected_pane) != resolved.identity.pane_id.as_ref() {
            mismatches.insert(
                "pane_id".to_string(),
                json!({
                    "expected": expected_pane,
                    "actual": resolved.identity.pane_id,
                }),
            );
        }
    }
    if let Some(expected_seq) = expected.state_seq {
        let actual_val = resolved
            .identity
            .state_change_seq
            .clone()
            .unwrap_or(Value::Null);
        let actual = actual_val.as_f64();
        if actual.is_none() || actual != Some(expected_seq) {
            mismatches.insert(
                "state_change_seq".to_string(),
                json!({
                    "expected": json_num(expected_seq),
                    "actual": actual_val,
                }),
            );
        }
    }
    if let Some(expected_session) = &expected.agent_session {
        let actual = resolved
            .identity
            .agent_session
            .as_ref()
            .and_then(|r| r.value.clone());
        if actual.as_deref() != Some(expected_session.as_str()) {
            mismatches.insert(
                "agent_session".to_string(),
                json!({
                    "expected": expected_session,
                    "actual": actual,
                }),
            );
        }
    }
    if !mismatches.is_empty() {
        let pane = resolved
            .identity
            .pane_id
            .clone()
            .unwrap_or_else(|| "?".to_string());
        // serde_json::Map sorts keys; TS `Object.keys` reports insertion
        // order (pane_id, state_change_seq, agent_session). Rebuild the
        // message in that fixed order for parity.
        let order = ["pane_id", "state_change_seq", "agent_session"];
        let ordered_keys: Vec<&str> = order
            .iter()
            .copied()
            .filter(|k| mismatches.contains_key(*k))
            .collect();
        let mut extra = Map::new();
        extra.insert("identity".to_string(), resolved.identity.to_json());
        extra.insert("mismatches".to_string(), Value::Object(mismatches));
        return Err(ControlsError::new(
            "stale_generation",
            format!(
                "stale agent generation for target {}: {} mismatch",
                pane,
                ordered_keys.join(", ")
            ),
        )
        .with_extra(extra));
    }
    Ok(())
}
