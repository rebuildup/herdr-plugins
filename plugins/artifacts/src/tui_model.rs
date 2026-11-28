//! Pure helpers for the rebuildup.artifacts TUI — Rust port of
//! `plugins/artifacts/src/tui-support.ts` (payload parsing, view-model
//! formatting, pinned-context resolution, pane-open params, mutation
//! gating). No I/O beyond env reads and the in-process CLI bridge.

use std::collections::BTreeMap;

use hoxay_herdr_client::socket::request;
use hoxay_herdr_client::target::{resolve_target, ResolveTargetOptions};
use serde_json::{json, Map, Value};

use crate::cli;
use crate::model::{ARTIFACT_KINDS, PLUGIN_ID};

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
    /// Origin cwd — a display hint only, never auto-applied.
    pub origin_cwd: Option<String>,
    /// Resolved herdr socket the UI talks to (display/diagnostics).
    pub socket_path: Option<String>,
    /// Session name when the socket maps to a named session.
    pub session: Option<String>,
}

fn nonempty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.is_empty())
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

/// Resolve the pinned launch target. Precedence per field:
/// explicit `HERDR_TUI_*` env pins (set by the `open` action) →
/// `HERDR_PLUGIN_CONTEXT_JSON` origin fields → null.
///
/// `HERDR_PANE_ID` is deliberately ignored: it identifies the UI pane
/// itself (surface identity), which is never a mutation target.
pub fn resolve_pinned_target() -> PinnedTarget {
    let context = parse_plugin_context(env_nonempty("HERDR_PLUGIN_CONTEXT_JSON").as_deref());
    let focused_pane = context
        .get("focused_pane")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));

    let workspace_id = env_nonempty("HERDR_TUI_WORKSPACE_ID")
        .or_else(|| nonempty_str(context.get("workspace_id")));
    let tab_id = env_nonempty("HERDR_TUI_TAB_ID").or_else(|| nonempty_str(context.get("tab_id")));
    let origin_pane_id = env_nonempty("HERDR_TUI_PANE_ID")
        .or_else(|| nonempty_str(context.get("focused_pane_id")))
        .or_else(|| nonempty_str(focused_pane.get("pane_id")))
        .or_else(|| nonempty_str(focused_pane.get("id")));
    let origin_cwd = env_nonempty("HERDR_TUI_CWD")
        .or_else(|| nonempty_str(focused_pane.get("cwd")))
        .or_else(|| nonempty_str(context.get("cwd")))
        .or_else(|| nonempty_str(context.get("workspace_cwd")));

    let mut socket_path = None;
    let mut session = None;
    // Target-resolution conflicts surface honestly through the CLI
    // in-process calls anyway; the TUI only needs display values here.
    if let Ok(resolved) = resolve_target(&ResolveTargetOptions::default()) {
        socket_path = Some(resolved.socket_path);
        session = resolved.session;
    }

    PinnedTarget {
        workspace_id,
        tab_id,
        origin_pane_id,
        origin_cwd,
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
    if let Some(c) = &target.origin_cwd {
        parts.push(format!("cwd {}", c));
    }
    if parts.is_empty() {
        "no pinned target".to_string()
    } else {
        parts.join(" · ")
    }
}

// --- pane opening (open action → plugin.pane.open) ---------------------------

/// Params for `plugin.pane.open` (ADR-0031 verified shape). Placement is
/// `tab` per the tui-v1 placement policy: the artifact registry is a
/// workspace-scale browser, multi-instance safe, and pane-backed so
/// `plugin.pane.focus/close` keep working.
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
    if let Some(c) = &target.origin_cwd {
        env.insert("HERDR_TUI_CWD".to_string(), json!(c));
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

/// Open the artifacts TUI pane through the documented socket API.
/// `plugin.pane.open` is a herdr-state mutation: target resolution runs
/// with `mutation: true` so an implicit default-session fallback fails
/// closed (`target_required`) instead of opening on the wrong session.
/// Returns the RPC result value, or (kind, message) on failure.
pub fn open_artifacts_pane(params: &Value) -> Result<Value, (String, String)> {
    let socket_path = resolve_target(&ResolveTargetOptions {
        session: None,
        socket_path: None,
        mutation: true,
    })
    .map_err(|e| (e.code.as_str().to_string(), e.to_string()))?
    .socket_path;
    request(&socket_path, "plugin.pane.open", params.clone(), 10_000).map_err(|e| {
        let kind = match &e {
            hoxay_herdr_client::socket::ClientError::Rpc(rpc) => rpc.code.clone(),
            _ => "pane_open_failed".to_string(),
        };
        (kind, e.to_string())
    })
}

// --- CLI bridge (in-process domain calls) ------------------------------------

/// Structured failure from the artifacts CLI surface. Mirrors
/// `ArtifactsCliError`: `kind` is the contract `error.kind` (falling back
/// to `error.code`), `extra` the remaining error fields.
#[derive(Debug, Clone)]
pub struct CliError {
    pub kind: String,
    pub message: String,
    pub extra: Option<Map<String, Value>>,
    pub exit_code: i32,
}

impl CliError {
    pub fn line(&self) -> String {
        format!("{}: {}", self.kind, self.message)
    }
}

fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// Parse the CLI envelope exactly like the TS `parseCliEnvelope`:
/// whole-stdout JSON (exit 0 only) → reversed per-line candidates →
/// stderr `{contract,ok:false,error}` → synthetic cli_error.
fn parse_cli_envelope(stdout: &str, stderr: &str, exit_code: i32) -> Result<Value, CliError> {
    let trimmed = stdout.trim();
    if !trimmed.is_empty() && exit_code == 0 {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            if parsed.is_object() {
                return Ok(parsed);
            }
        }
    }
    let mut lines: Vec<&str> = stdout
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    lines.reverse();
    for line in lines {
        if let Ok(parsed) = serde_json::from_str::<Value>(line) {
            if parsed.is_object() {
                return Ok(parsed);
            }
        }
    }
    // Failure path: stderr carries {contract, ok:false, error:{...}}.
    let mut kind = "cli_error".to_string();
    let mut message = format!("artifacts cli exited {} with no JSON output", exit_code);
    let mut extra: Option<Map<String, Value>> = None;
    if let Ok(parsed) = serde_json::from_str::<Value>(stderr) {
        if let Some(err) = parsed.get("error").and_then(as_object) {
            if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                message = m.to_string();
            }
            if let Some(k) = err.get("kind").and_then(|v| v.as_str()) {
                kind = k.to_string();
            } else if let Some(c) = err.get("code").and_then(|v| v.as_str()) {
                kind = c.to_string();
            }
            let rest: Map<String, Value> = err
                .iter()
                .filter(|(k, _)| k.as_str() != "code" && k.as_str() != "kind" && k.as_str() != "message")
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            if !rest.is_empty() {
                extra = Some(rest);
            }
        }
    } else {
        let tail: Vec<&str> = stderr.trim().lines().collect();
        let tail = tail
            .iter()
            .rev()
            .take(3)
            .rev()
            .copied()
            .collect::<Vec<_>>()
            .join(" | ");
        if !tail.is_empty() {
            let truncated: String = tail.chars().take(400).collect();
            message = format!("{}: {}", message, truncated);
        }
    }
    Err(CliError {
        kind,
        message,
        extra,
        exit_code,
    })
}

/// Run one artifacts CLI command in-process — the same `cmd_*` cores the
/// binary dispatches to (the Rust port of the TS `runArtifactsCli`
/// subprocess bridge; the public contract stays the single source of
/// truth). Args are internally generated and well-formed. Socket calls
/// carry their own timeouts; there is no subprocess to kill, so the
/// TS cancel/timeout plumbing degrades to the domain call's own bounds.
pub fn run_artifacts_cli(args: &[String]) -> Result<Value, CliError> {
    let (code, stdout, stderr) = cli::run_cli(args);
    parse_cli_envelope(&stdout, &stderr, code)
}

// --- mutation gating (capability / mutation_commands) ------------------------

/// Subset of the `capability` payload the TUI consults (tui-v1 §5.4).
pub type CapabilityDoc = Value;

pub struct MutationGate {
    pub allowed: bool,
    /// Human-readable reason when disabled — rendered, never hidden.
    pub reason: Option<String>,
}

/// Fail-closed gate: a missing capability document disables ALL
/// mutations (honest unsupported, contract item 9/4). `command` is the
/// CLI command path exactly as listed in `mutation_commands`
/// (e.g. "register", "delete", "deliver", "gc").
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

// --- payload → view formatting (pure) ------------------------------------------

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
        Some(v) => match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => v.to_string(),
        },
    }
}

fn as_strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Tolerant view model for one artifact record (contract
/// `herdr-plugins.artifacts/v1` record + `missing_ref`/`owner_stale`
/// annotations). The plugin never reads payload bytes — this view model
/// is metadata only, matching the CLI surface.
#[derive(Debug, Clone)]
pub struct ArtifactView {
    pub artifact_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub host: String,
    pub session: String,
    pub owner_pane_id: Option<String>,
    pub owner_agent_session: Option<String>,
    pub created_by: String,
    pub storage_mode: String,
    pub resolved_path: String,
    pub size: f64,
    pub mime: String,
    pub sha256: String,
    pub oversize: bool,
    pub missing_ref: bool,
    pub owner_stale: bool,
    pub created_at: String,
    pub refs: Vec<String>,
    pub warnings: Vec<String>,
}

/// Parse one artifact payload entry; None when malformed (never fabricated).
pub fn as_artifact(value: &Value) -> Option<ArtifactView> {
    let v = value.as_object()?;
    let artifact_id = v.get("artifact_id")?.as_str()?;
    if artifact_id.is_empty() {
        return None;
    }
    let storage = v.get("storage")?.as_object()?;
    let owner = v.get("owner")?.as_object()?;
    let kind = v
        .get("kind")
        .and_then(|k| k.as_str())
        .unwrap_or("other")
        .to_string();
    Some(ArtifactView {
        artifact_id: artifact_id.to_string(),
        kind: kind.clone(),
        title: v.get("title").and_then(|t| t.as_str()).map(|s| s.to_string()),
        host: fmt(v.get("host")),
        session: fmt(v.get("session")),
        owner_pane_id: owner
            .get("pane_id")
            .and_then(|p| p.as_str())
            .map(|s| s.to_string()),
        owner_agent_session: owner
            .get("agent_session")
            .and_then(|p| p.as_str())
            .map(|s| s.to_string()),
        created_by: fmt(owner.get("created_by")),
        storage_mode: fmt(storage.get("mode")),
        resolved_path: fmt(storage.get("resolved_path")),
        size: v.get("size").and_then(|s| s.as_f64()).unwrap_or(0.0),
        mime: fmt(v.get("mime")),
        sha256: fmt(v.get("sha256")),
        oversize: v.get("oversize").and_then(|o| o.as_bool()) == Some(true),
        missing_ref: v.get("missing_ref").and_then(|m| m.as_bool()) == Some(true),
        owner_stale: v.get("owner_stale").and_then(|o| o.as_bool()) == Some(true),
        created_at: fmt(v.get("created_at")),
        refs: as_strings(v.get("refs")),
        warnings: as_strings(v.get("warnings")),
    })
}

pub fn as_artifacts(value: &Value) -> Vec<ArtifactView> {
    value
        .as_array()
        .map(|arr| arr.iter().filter_map(as_artifact).collect())
        .unwrap_or_default()
}

fn human_bytes(size: f64) -> String {
    if size < 1024.0 {
        format!("{} B", crate::registry::fmt_num(size))
    } else if size < 1024.0 * 1024.0 {
        format!("{:.1} KiB", size / 1024.0)
    } else {
        format!("{:.1} MiB", size / (1024.0 * 1024.0))
    }
}

/// One select-list row for an artifact (label + detail block).
pub struct ArtifactItem {
    pub artifact: ArtifactView,
    pub label: String,
    pub detail: String,
}

/// Select-list row for one artifact.
pub fn artifact_select_item(artifact: &ArtifactView) -> ArtifactItem {
    let mut flags: Vec<String> = Vec::new();
    if artifact.missing_ref {
        flags.push("missing".to_string());
    }
    if artifact.owner_stale {
        flags.push("owner-stale".to_string());
    }
    if artifact.oversize {
        flags.push("oversize".to_string());
    }
    if !artifact.refs.is_empty() {
        flags.push(format!("refs:{}", artifact.refs.len()));
    }
    let suffix = if flags.is_empty() {
        String::new()
    } else {
        format!(" [{}]", flags.join(", "))
    };
    let title = artifact
        .title
        .as_ref()
        .map(|t| format!(" — {}", t))
        .unwrap_or_default();
    let mut detail_lines = vec![
        format!(
            "kind: {} · mime: {} · size: {}",
            artifact.kind,
            artifact.mime,
            human_bytes(artifact.size)
        ),
        format!("path: {}", artifact.resolved_path),
        format!(
            "storage: {} · created: {}",
            artifact.storage_mode, artifact.created_at
        ),
        format!(
            "owner: pane {} · by {}",
            artifact.owner_pane_id.as_deref().unwrap_or("?"),
            artifact.created_by
        ),
        format!("sha256: {}", artifact.sha256),
    ];
    if !artifact.warnings.is_empty() {
        detail_lines.push(format!("warnings: {}", artifact.warnings.join(", ")));
    }
    ArtifactItem {
        artifact: artifact.clone(),
        label: format!(
            "{} · {}{}{}",
            artifact.artifact_id, artifact.kind, title, suffix
        ),
        detail: detail_lines.join("\n"),
    }
}

/// Header + preview guidance lines for the artifact detail view.
pub fn artifact_header_lines(artifact: &ArtifactView) -> Vec<String> {
    let mut lines = vec![
        format!(
            "artifact {}{}",
            artifact.artifact_id,
            artifact
                .title
                .as_ref()
                .map(|t| format!(" — {}", t))
                .unwrap_or_default()
        ),
        format!(
            "kind: {} · mime: {} · size: {}",
            artifact.kind,
            artifact.mime,
            human_bytes(artifact.size)
        ),
        format!(
            "created: {} · host: {} · session: {}",
            artifact.created_at, artifact.host, artifact.session
        ),
        format!(
            "owner: pane {} · agent_session {} · created_by {}",
            artifact.owner_pane_id.as_deref().unwrap_or("unknown"),
            artifact.owner_agent_session.as_deref().unwrap_or("unknown"),
            artifact.created_by
        ),
        format!(
            "storage: {} · sha256 {}",
            artifact.storage_mode, artifact.sha256
        ),
        format!("path: {}", artifact.resolved_path),
    ];
    if !artifact.refs.is_empty() {
        lines.push(format!("refs ({}):", artifact.refs.len()));
        for r in &artifact.refs {
            lines.push(format!("  {}", r));
        }
    }
    if !artifact.warnings.is_empty() {
        lines.push(format!("warnings: {}", artifact.warnings.join(", ")));
    }
    if artifact.missing_ref {
        lines.push("PAYLOAD MISSING — the resolved path does not exist or is unsafe".to_string());
    }
    if artifact.owner_stale {
        lines.push(
            "owner-stale — the registering pane is not in the live session snapshot".to_string(),
        );
    }
    lines.push(String::new());
    lines.push("preview: metadata only — the plugin never renders payload bytes (ADR-0024).".to_string());
    if artifact.kind == "html" {
        lines.push("html renders in an isolated client context; open externally to view.".to_string());
    } else if artifact.kind == "image" || artifact.kind == "pdf" {
        lines.push(format!(
            "{} cannot be previewed in a terminal; open externally to view.",
            artifact.kind
        ));
    } else {
        lines.push("open externally (o) for the file content in the OS handler.".to_string());
    }
    lines.push(String::new());
    lines.push("d delete · l deliver · v verify · o open externally · R refresh".to_string());
    lines
}

/// Format a `verify` payload (whole index or single artifact).
pub fn format_verify_payload(payload: &Value) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    if let Some(summary) = payload.get("summary").filter(|v| v.is_object()) {
        lines.push(format!(
            "verify summary — total {} · ok {} · corrupt {} · missing {}",
            fmt(summary.get("total")),
            fmt(summary.get("ok")),
            fmt(summary.get("corrupt")),
            fmt(summary.get("missing"))
        ));
    }
    let results: Vec<&Value> = payload
        .get("results")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    if results.is_empty() {
        lines.push("(no verification results)".to_string());
    }
    for r in results {
        let id = fmt(r.get("artifact_id"));
        let status = fmt(r.get("status"));
        let issues = as_strings(r.get("issues"));
        lines.push(format!(
            "{} — {}{}",
            id,
            status,
            if issues.is_empty() {
                String::new()
            } else {
                format!(" ({})", issues.join(", "))
            }
        ));
        if let Some(checks) = r.get("checks").filter(|v| v.is_object()) {
            if let Some(obj) = checks.as_object() {
                for (name, value) in obj {
                    // TS renders each check as {ok, detail} records; the
                    // wire shape carries booleans, so ok resolves to
                    // "unknown" — reproduced faithfully (bug-for-bug).
                    let ok = value.get("ok");
                    let detail = value.get("detail").and_then(|d| d.as_str());
                    let ok_text = match ok {
                        Some(Value::Bool(true)) => "ok".to_string(),
                        Some(Value::Bool(false)) => "FAIL".to_string(),
                        _ => fmt(ok),
                    };
                    lines.push(format!(
                        "  {}: {}{}",
                        name,
                        ok_text,
                        detail.map(|d| format!(" — {}", d)).unwrap_or_default()
                    ));
                }
            }
        }
    }
    let orphans = as_strings(payload.get("orphans"));
    if !orphans.is_empty() {
        lines.push(format!("orphans ({}): {}", orphans.len(), orphans.join(", ")));
    }
    let corrupt = as_strings(payload.get("corrupt"));
    if !corrupt.is_empty() {
        lines.push(format!("corrupt index entries: {}", corrupt.join(", ")));
    }
    lines
}

/// Format a `gc` payload (dry-run or applied).
pub fn format_gc_payload(payload: &Value) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let policy = payload.get("policy").filter(|v| v.is_object());
    let dry_run = payload.get("dry_run").and_then(|v| v.as_bool()) == Some(true);
    lines.push(format!(
        "gc {} — older_than {} · evaluated {} · expired {}",
        if dry_run { "dry-run" } else { "applied" },
        fmt(policy.and_then(|p| p.get("older_than"))),
        fmt(payload.get("evaluated")),
        fmt(payload.get("expired"))
    ));
    if let Some(totals) = payload.get("totals").filter(|v| v.is_object()) {
        lines.push(format!(
            "totals: deleted {} · would_delete {} · skipped_referenced {} · skipped_other {} · kept {} · errors {}",
            fmt(totals.get("deleted")),
            fmt(totals.get("would_delete")),
            fmt(totals.get("skipped_referenced")),
            fmt(totals.get("skipped_other")),
            fmt(totals.get("kept")),
            fmt(totals.get("errors"))
        ));
    }
    let entries: Vec<&Value> = payload
        .get("entries")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    if entries.is_empty() {
        lines.push("(no entries)".to_string());
    }
    for e in entries {
        let reason = e
            .get("reason")
            .and_then(|r| r.as_str())
            .map(|r| format!(" — {}", r))
            .unwrap_or_default();
        let error = e
            .get("error")
            .and_then(|r| r.as_str())
            .map(|r| format!(" — {}", r))
            .unwrap_or_default();
        lines.push(format!(
            "{}: {}{}{} ({})",
            fmt(e.get("artifact_id")),
            fmt(e.get("action")),
            reason,
            error,
            fmt(e.get("storage_mode"))
        ));
    }
    lines
}

/// Format a `list`/`search` payload header (counts + honest gaps).
pub fn format_index_meta(payload: &Value) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let total = payload.get("total").and_then(|v| v.as_f64());
    let returned = payload
        .get("artifacts")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    if let Some(total) = total {
        if (returned as f64) < total {
            lines.push(format!(
                "showing {} of {} artifacts (CLI page limit)",
                returned,
                crate::registry::fmt_num(total)
            ));
        }
    }
    let orphans = as_strings(payload.get("orphans"));
    if !orphans.is_empty() {
        lines.push(format!(
            "orphans: {} payload dir(s) without index records",
            orphans.len()
        ));
    }
    let corrupt = as_strings(payload.get("corrupt"));
    if !corrupt.is_empty() {
        lines.push(format!("corrupt index entries: {}", corrupt.len()));
    }
    lines
}

/// Format a `deliver` result for the status/detail line.
pub fn format_deliver_result(payload: &Value) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("delivered {}", fmt(payload.get("artifact_id"))));
    if let Some(target) = payload.get("target").filter(|v| v.is_object()) {
        lines.push(format!(
            "target: {} pane {}",
            fmt(target.get("kind")),
            fmt(target.get("pane_id"))
        ));
    }
    if let Some(method) = payload.get("method").and_then(|m| m.as_str()) {
        lines.push(format!("method: {}", method));
    }
    if let Some(message) = payload.get("message").and_then(|m| m.as_str()) {
        lines.push("message sent:".to_string());
        for l in message.lines() {
            lines.push(format!("  {}", l));
        }
    }
    lines
}

/// Error text for status lines: kind + message, never a stack.
pub fn error_line(err: &CliError) -> String {
    err.line()
}

/// Kind constants used by register/deliver flows.
pub const KIND_CHOICES: [&str; 6] = ["auto", "html", "image", "pdf", "file", "other"];
pub const STORAGE_CHOICES: [&str; 2] = ["state_copy", "path_ref"];

/// Keep ARTIFACT_KINDS referenced for parity checks in tests.
#[allow(dead_code)]
fn _kinds() -> &'static [&'static str] {
    &ARTIFACT_KINDS
}

/// Ordered map helper for building small JSON objects in tests.
#[allow(dead_code)]
pub fn obj(pairs: &[(&str, Value)]) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.to_string(), v.clone());
    }
    Value::Object(m)
}

/// BTreeMap re-export used by tui.rs for stable option maps.
pub type StableMap = BTreeMap<String, Value>;
