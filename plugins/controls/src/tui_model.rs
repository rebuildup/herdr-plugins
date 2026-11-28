//! Pure helpers for the rebuildup.controls TUI (`herdr-plugins.tui/v1`).
//! Rust port of the non-UI halves of `plugins/controls/src/tui-support.ts`
//! and `plugins/controls/src/tui-views.ts` (Issue #324).
//!
//! Everything here is side-effect free except `resolve_pinned_target`'s
//! read-only socket resolution and `read_session_agents`/`read_agent`'s
//! documented read-only `session.snapshot` / `agent.get` calls — the
//! same surfaces the TS TUI used. Mutations never live here; they go
//! through `cli::run_args` (the `herdr-plugins.controls/v1` core) so the
//! `--expect-*` stale-generation guards stay the single enforcement
//! point.

use std::collections::BTreeMap;

use hoxay_herdr_client::commands::{self, CallOptions};
use hoxay_herdr_client::snapshot::{AgentInfo, PaneInfo, SessionSnapshot};
use hoxay_herdr_client::target::{resolve_target, ResolveTargetOptions};
use serde_json::{json, Map, Value};

use crate::agentapi::{self, AgentApiError};
use crate::cli::CliFailure;

pub const PLUGIN_ID: &str = "rebuildup.controls";
pub const PLUGIN_VERSION: &str = "0.6.0";

// --- pinned target identity -------------------------------------------------

/// Origin context captured at launch. Fields are `None` when unknown —
/// the UI must render that honestly rather than guess "current" focus.
#[derive(Debug, Clone, Default)]
pub struct PinnedTarget {
    /// Workspace the UI was launched from (pane placement target).
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    /// Origin focused pane at launch — context identity, NOT the UI pane.
    pub origin_pane_id: Option<String>,
    /// Resolved herdr socket the UI talks to (display/diagnostics).
    pub socket_path: Option<String>,
    /// Session name when the socket maps to a named session.
    pub session: Option<String>,
}

/// Tolerant parse of `HERDR_PLUGIN_CONTEXT_JSON` (never fails).
pub fn parse_plugin_context(raw: Option<&str>) -> Value {
    let Some(raw) = raw else { return json!({}) };
    if raw.is_empty() {
        return json!({});
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(v) if v.is_object() => v,
        _ => json!({}),
    }
}

fn str_field(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Resolve the pinned launch target. Precedence per field:
/// explicit `HERDR_TUI_*` env pins (set by the `open` action) →
/// `HERDR_PLUGIN_CONTEXT_JSON` origin fields → none.
///
/// `HERDR_PANE_ID` is deliberately ignored: it identifies the UI pane
/// itself (surface identity), which is never a mutation target.
pub fn resolve_pinned_target() -> PinnedTarget {
    let context = parse_plugin_context(std::env::var("HERDR_PLUGIN_CONTEXT_JSON").ok().as_deref());
    let focused_pane = context.get("focused_pane").cloned().unwrap_or(json!({}));

    let workspace_id = std::env::var("HERDR_TUI_WORKSPACE_ID")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| str_field(context.get("workspace_id")));
    let tab_id = std::env::var("HERDR_TUI_TAB_ID")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| str_field(context.get("tab_id")));
    let origin_pane_id = std::env::var("HERDR_TUI_PANE_ID")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| str_field(context.get("focused_pane_id")))
        .or_else(|| str_field(focused_pane.get("pane_id")))
        .or_else(|| str_field(focused_pane.get("id")));

    let mut socket_path = None;
    let mut session = None;
    if let Ok(resolved) = resolve_target(&ResolveTargetOptions::default()) {
        socket_path = Some(resolved.socket_path);
        session = resolved.session;
    }
    // Target-resolution conflicts surface honestly through the CLI
    // core anyway; the TUI only needs display values here.

    PinnedTarget {
        workspace_id,
        tab_id,
        origin_pane_id,
        socket_path,
        session,
    }
}

/// One-line human description of the pinned target for the status line.
pub fn format_target_label(target: &PinnedTarget) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(s) = &target.session {
        parts.push(format!("session {}", s));
    }
    if let Some(w) = &target.workspace_id {
        parts.push(format!("ws {}", w));
    }
    if let Some(p) = &target.origin_pane_id {
        parts.push(format!("pane {}", p));
    }
    if parts.is_empty() {
        "no pinned target".to_string()
    } else {
        parts.join(" · ")
    }
}

// --- pane opening (open action → plugin.pane.open) ---------------------------

/// Params for `plugin.pane.open` (ADR-0031 verified shape). Placement is
/// `tab` per the tui-v1 placement policy: the controls surface is a
/// workspace-scale agent browser, multi-instance safe, and pane-backed
/// so `plugin.pane.focus/close` keep working.
pub fn build_pane_open_params(target: &PinnedTarget) -> Value {
    let mut env = Map::new();
    if let Some(w) = &target.workspace_id {
        env.insert("HERDR_TUI_WORKSPACE_ID".to_string(), json!(w));
    }
    if let Some(t) = &target.tab_id {
        env.insert("HERDR_TUI_TAB_ID".to_string(), json!(t));
    }
    if let Some(p) = &target.origin_pane_id {
        env.insert("HERDR_TUI_PANE_ID".to_string(), json!(p));
    }

    let mut params = Map::new();
    params.insert("plugin_id".to_string(), json!(PLUGIN_ID));
    params.insert("entrypoint".to_string(), json!("main"));
    params.insert("placement".to_string(), json!("tab"));
    params.insert("env".to_string(), Value::Object(env));
    if let Some(w) = &target.workspace_id {
        params.insert("workspace_id".to_string(), json!(w));
    }
    Value::Object(params)
}

/// Structured failure for `plugin.pane.open` / `pane.focus` — carries
/// herdr's RPC `code` when present so the `open` action can echo the
/// same `kind` the TS implementation surfaced.
#[derive(Debug)]
pub struct SocketCallError {
    pub kind: String,
    pub message: String,
}

impl std::fmt::Display for SocketCallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

fn socket_err(err: hoxay_herdr_client::socket::ClientError) -> SocketCallError {
    match err {
        hoxay_herdr_client::socket::ClientError::Rpc(e) => SocketCallError {
            kind: e.code,
            message: e.message,
        },
        other => SocketCallError {
            kind: "pane_open_failed".to_string(),
            message: other.to_string(),
        },
    }
}

fn target_err(err: hoxay_herdr_client::target::TargetResolutionError) -> SocketCallError {
    SocketCallError {
        kind: err.code.as_str().to_string(),
        message: err.message,
    }
}

/// Open the controls TUI pane through the documented socket API.
/// `plugin.pane.open` is a herdr-state mutation: target resolution runs
/// with `mutation: true` so an implicit default-session fallback fails
/// closed (`target_required`) instead of opening on the wrong session.
pub fn open_controls_pane(params: &Value) -> Result<Value, SocketCallError> {
    let resolved = resolve_target(&ResolveTargetOptions {
        mutation: true,
        ..Default::default()
    })
    .map_err(target_err)?;
    hoxay_herdr_client::socket::request(
        &resolved.socket_path,
        "plugin.pane.open",
        params.clone(),
        10_000,
    )
    .map_err(socket_err)
}

// --- mutation gating (capability / mutation_commands) ------------------------

/// Fail-closed gate: a missing capability document disables ALL
/// mutations (honest unsupported, contract item 9/4). `command` is the
/// CLI command path exactly as listed in `mutation_commands`
/// (controls: "send", "command", "interrupt", "rename", "start").
pub struct MutationGate {
    pub allowed: bool,
    /// Human-readable reason when disabled — rendered, never hidden.
    pub reason: Option<String>,
}

pub fn mutation_allowed(capability: Option<&Value>, command: &str) -> MutationGate {
    let Some(cap) = capability else {
        return MutationGate {
            allowed: false,
            reason: Some(
                "capability document unavailable — mutations disabled (fail closed)".to_string(),
            ),
        };
    };
    if cap.get("read_only").and_then(|v| v.as_bool()) == Some(true) {
        return MutationGate {
            allowed: false,
            reason: Some("plugin reports read_only".to_string()),
        };
    }
    let commands: Vec<&str> = cap
        .get("mutation_commands")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.as_str())
                .collect()
        })
        .unwrap_or_default();
    if !commands.contains(&command) {
        return MutationGate {
            allowed: false,
            reason: Some(format!("\"{}\" is not in mutation_commands", command)),
        };
    }
    MutationGate {
        allowed: true,
        reason: None,
    }
}

// --- session reads (documented socket API; never mutations) -------------------

/// Read-only enumeration for target selection. `session.snapshot` is the
/// documented public socket surface — the same data `agent.list`/GUI
/// consumers read. Never used for mutation decisions; every mutation
/// revalidates through the CLI's `agent.get` + `--expect-*` guards.
pub struct SessionAgents {
    pub panes: Vec<PaneInfo>,
    /// pane_id → AgentInfo, only panes herdr reports an agent for.
    pub agents: BTreeMap<String, AgentInfo>,
    pub session_name: Option<String>,
}

pub fn read_session_agents() -> Result<SessionAgents, String> {
    let snapshot: SessionSnapshot =
        commands::session_snapshot(&CallOptions::default()).map_err(|e| e.to_string())?;
    let session_name = snapshot
        .session
        .as_ref()
        .and_then(|s| s.get("name"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Ok(SessionAgents {
        panes: snapshot.panes,
        agents: snapshot.agents,
        session_name,
    })
}

/// Read-only `agent.get` for detail refresh (generation signals).
pub fn read_agent(target: &str) -> Result<Value, AgentApiError> {
    agentapi::agent_get(target, &agentapi::AgentCallOptions::default())
}

/// `pane.focus` — herdr UI mutation, not a controls contract op.
pub fn focus_pane(pane_id: &str) -> Result<Value, SocketCallError> {
    let resolved = resolve_target(&ResolveTargetOptions::default()).map_err(target_err)?;
    hoxay_herdr_client::socket::request(
        &resolved.socket_path,
        "pane.focus",
        json!({ "pane_id": pane_id }),
        10_000,
    )
    .map_err(socket_err)
}

// --- payload → view formatting (pure) ------------------------------------------

/// Error text for status lines: kind + message, never a stack.
pub fn cli_error_message(failure: &CliFailure) -> String {
    match &failure.kind {
        Some(kind) => format!("{}: {}", kind, failure.message),
        None => failure.message.clone(),
    }
}

/// Error text for raw socket/agent failures.
pub fn agent_error_message(err: &AgentApiError) -> String {
    match err {
        AgentApiError::Rpc { code, message } => format!("{}: {}", code, message),
        AgentApiError::Other(m) => m.clone(),
    }
}

fn fmt(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "unknown".to_string(),
        Some(Value::Bool(b)) => {
            if *b {
                "yes".to_string()
            } else {
                "no".to_string()
            }
        }
        Some(v) => match v.as_str() {
            Some(s) => s.to_string(),
            None => v.to_string(),
        },
    }
}

fn as_record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(|v| v.as_object())
}

/// One select-list row per agent-bearing pane in the session snapshot.
#[derive(Clone)]
pub struct SelectItem {
    pub label: String,
    pub detail: String,
    pub disabled: bool,
    pub disabled_reason: Option<String>,
    /// Opaque payload carried through selection (pane id / agent record).
    pub value_pane_id: String,
    pub value_agent: Option<AgentInfo>,
}

pub fn agent_select_item(pane: &PaneInfo, agent: &AgentInfo) -> SelectItem {
    let pane_id = pane.pane_id.clone();
    let kind = agent.agent.clone().unwrap_or_else(|| "agent".to_string());
    let status = agent
        .agent_status
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let mut label_parts = vec![pane_id.clone(), kind.clone(), status.clone()];
    if let Some(t) = &pane.title {
        if !t.is_empty() {
            label_parts.push(t.clone());
        }
    }
    let seq_text = agent
        .state_change_seq
        .map(|s| format_num(s))
        .unwrap_or_else(|| "unreported".to_string());
    let cwd = agent.cwd.clone().or_else(|| pane.cwd.clone());
    let session_value = agent
        .agent_session
        .as_ref()
        .and_then(|s| s.value.clone());
    let detail = [
        format!("pane: {}", pane_id),
        format!("agent: {} · status: {}", kind, status),
        format!("state_change_seq: {}", seq_text),
        format!(
            "workspace: {} · tab: {}",
            opt_str(pane.workspace_id.as_deref()),
            opt_str(pane.tab_id.as_deref())
        ),
        format!("cwd: {}", cwd.as_deref().unwrap_or("unknown")),
        format!("session: {}", session_value.as_deref().unwrap_or("unknown")),
    ]
    .join("\n");
    SelectItem {
        label: label_parts.join("  "),
        detail,
        disabled: false,
        disabled_reason: None,
        value_pane_id: pane_id,
        value_agent: Some(agent.clone()),
    }
}

/// Select-list row for a shell pane eligible for `start` (no live agent).
pub fn shell_pane_select_item(pane: &PaneInfo, has_agent: bool) -> SelectItem {
    let cwd = pane.cwd.clone();
    let title = pane.title.clone().filter(|t| !t.is_empty());
    let mut label = pane.pane_id.clone();
    if let Some(t) = &title {
        label.push_str(&format!("  {}", t));
    }
    if let Some(c) = &cwd {
        if !c.is_empty() {
            label.push_str(&format!("  {}", c));
        }
    }
    let detail = [
        format!("pane: {}", pane.pane_id),
        format!(
            "workspace: {} · tab: {}",
            opt_str(pane.workspace_id.as_deref()),
            opt_str(pane.tab_id.as_deref())
        ),
        format!("cwd: {}", cwd.as_deref().unwrap_or("unknown")),
        if has_agent {
            "already runs an agent — agent.start would conflict".to_string()
        } else {
            "shell pane (no reported agent)".to_string()
        },
    ]
    .join("\n");
    SelectItem {
        label,
        detail,
        disabled: has_agent,
        disabled_reason: has_agent.then(|| "already has an agent".to_string()),
        value_pane_id: pane.pane_id.clone(),
        value_agent: None,
    }
}

fn opt_str(v: Option<&str>) -> String {
    v.filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

/// JS `String(number)` for seq values: integers render without `.0`.
fn format_num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{}", v)
    }
}

/// Header lines describing a resolved agent identity (detail view top).
/// `agent` is the raw `agent.get` record.
pub fn identity_lines(agent: &Value) -> Vec<String> {
    let session = agent.get("agent_session").and_then(|v| v.as_object());
    vec![
        format!("pane: {}", fmt(agent.get("pane_id"))),
        format!("agent: {}", fmt(agent.get("agent"))),
        format!("status: {}", fmt(agent.get("agent_status"))),
        format!("state_change_seq: {}", fmt(agent.get("state_change_seq"))),
        format!(
            "workspace: {} · tab: {}",
            fmt(agent.get("workspace_id")),
            fmt(agent.get("tab_id"))
        ),
        format!(
            "cwd: {}",
            fmt(agent.get("cwd").or_else(|| agent.get("foreground_cwd")))
        ),
        format!(
            "agent_session: {} ({}/{})",
            fmt(session.and_then(|s| s.get("value"))),
            fmt(session.and_then(|s| s.get("kind"))),
            fmt(session.and_then(|s| s.get("agent")))
        ),
        format!(
            "interactive_ready: {} · launch_pending: {}",
            fmt(agent.get("interactive_ready")),
            fmt(agent.get("launch_pending"))
        ),
    ]
}

// --- generation pinning ---------------------------------------------------------

/// Generation signals pinned at selection time (tui-v1 §3.3).
#[derive(Debug, Clone)]
pub struct PinnedAgent {
    pub pane_id: String,
    pub state_change_seq: Option<f64>,
    pub agent_session: Option<String>,
}

/// `pinAgent` — pin the generation signals of a raw `agent.get` record.
pub fn pin_agent(agent: &Value) -> PinnedAgent {
    let session = agent.get("agent_session").and_then(|v| v.as_object());
    PinnedAgent {
        pane_id: str_field(agent.get("pane_id")).unwrap_or_default(),
        state_change_seq: agent.get("state_change_seq").and_then(|v| v.as_f64()),
        agent_session: session
            .and_then(|s| s.get("value"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
    }
}

/// `--expect-*` argv suffix enforcing the pinned generation in the CLI.
pub fn expect_args(pin: &PinnedAgent) -> Vec<String> {
    let mut args = vec![
        "--expect-pane".to_string(),
        pin.pane_id.clone(),
    ];
    if let Some(seq) = pin.state_change_seq {
        args.push("--expect-state-seq".to_string());
        args.push(format_num(seq));
    }
    if let Some(s) = &pin.agent_session {
        args.push("--expect-agent-session".to_string());
        args.push(s.clone());
    }
    args
}

/// Revalidation verdict for the detail view's local stale check
/// (mirrors the TS `revalidate` drift comparison).
pub enum Revalidate {
    /// Pin still matches the fresh agent.get.
    Ok,
    /// Generation drifted — status text + updated pin.
    Drift { message: String, pin: PinnedAgent },
    /// agent.get failed.
    Failed(String),
}

/// Compare the pinned signals against a fresh `agent.get` record.
pub fn revalidate(pin: &PinnedAgent, fresh: &Value) -> Revalidate {
    let next = pin_agent(fresh);
    let mut drift: Vec<String> = Vec::new();
    if next.state_change_seq != pin.state_change_seq {
        drift.push(format!(
            "state_change_seq {} → {}",
            pin.state_change_seq
                .map(format_num)
                .unwrap_or_else(|| "null".to_string()),
            next.state_change_seq
                .map(format_num)
                .unwrap_or_else(|| "null".to_string())
        ));
    }
    if next.agent_session != pin.agent_session {
        drift.push("agent_session changed".to_string());
    }
    if drift.is_empty() {
        Revalidate::Ok
    } else {
        Revalidate::Drift {
            message: format!(
                "stale agent generation: {} — press R to refresh",
                drift.join(", ")
            ),
            pin: next,
        }
    }
}

/// Generic select item used by the Rust TUI's picker screens.
#[derive(Clone)]
pub struct Choice {
    pub value: String,
    pub label: String,
    pub detail: Option<String>,
    pub disabled: bool,
    /// Reason rendered dim next to a disabled row (TS `disabledReason`).
    pub disabled_reason: Option<String>,
}

impl Choice {
    pub fn new(value: &str, label: &str) -> Self {
        Choice {
            value: value.to_string(),
            label: label.to_string(),
            detail: None,
            disabled: false,
            disabled_reason: None,
        }
    }
    pub fn detail(mut self, detail: &str) -> Self {
        self.detail = Some(detail.to_string());
        self
    }
    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }
    pub fn disabled_reason(mut self, reason: &str) -> Self {
        self.disabled = true;
        self.disabled_reason = Some(reason.to_string());
        self
    }
}

/// Sanitize a possibly-untrusted display string (ANSI/control safe).
pub fn clean(s: &str) -> String {
    hoxay_tui::safety::sanitize_display(s)
}
