//! Interactive TUI surface for rebuildup.machines
//! (`herdr-plugins.tui/v1`, ADR-0031/0032/0033 + ADR-0028 read-only
//! inventory, issue #247; native port for #326).
//!
//! Entry modes (argv-only, no shell):
//!
//!   machines tui open   — `open` action helper: pins the origin context
//!                         and calls `plugin.pane.open` (placement
//!                         "tab"), then exits promptly.
//!   machines tui main   — pane entrypoint (`[[panes]] id="main"`): the
//!                         interactive machines inventory (list +
//!                         on-demand probe + capability info).
//!
//! Identity: the launch context is pinned once (resolve_pinned_target)
//! and forwarded as HERDR_TUI_* env pins on `plugin.pane.open`.
//! `HERDR_PANE_ID` is the UI pane's own surface identity and is NEVER
//! used as a target. Reads go through the plugin's own domain functions
//! in-process (the Rust binary IS the CLI — same code path, same
//! contract), so CLI/TUI behavior cannot drift. Non-TTY stdin degrades
//! to a plain-text machine list — never a fake UI. The plugin is
//! READ-ONLY: machine lifecycle stays with the herdr CLI; the TUI
//! exposes no mutating affordance.

use std::io::{self, IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Terminal;
use serde_json::{json, Map, Value};
use unicode_width::UnicodeWidthStr;

use hoxay_herdr_client::socket;
use hoxay_herdr_client::target::{resolve_target, ResolveTargetOptions};
use hoxay_tui::safety::sanitize_display;

use crate::cli;
use crate::model::PLUGIN_ID;
use crate::remote::{self, HerdrTarget, RemoteError};

const PLUGIN_VERSION: &str = "0.1.0";
const TASK_TIMEOUT_MS: u64 = 300_000;

// --- pinned target identity -------------------------------------------------

/// Origin context captured at launch. Fields are `None` when unknown —
/// the UI must render that honestly rather than guess "current" focus.
#[derive(Debug, Clone, Default)]
struct PinnedTarget {
    /// Workspace the UI was launched from (pane placement target).
    workspace_id: Option<String>,
    tab_id: Option<String>,
    /// Origin focused pane at launch — context identity, NOT the UI pane.
    origin_pane_id: Option<String>,
    /// Origin cwd — a display hint only, never auto-applied.
    origin_cwd: Option<String>,
    /// Resolved herdr socket the UI talks to (display/diagnostics).
    /// Retained for parity with the TS PinnedTarget; the label formatter
    /// does not render it.
    #[allow(dead_code)]
    socket_path: Option<String>,
    /// Session name when the socket maps to a named session.
    session: Option<String>,
}

fn env_str(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn jstr(v: Option<&Value>) -> Option<String> {
    v.and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Tolerant parse of `HERDR_PLUGIN_CONTEXT_JSON` (never fails).
fn parse_plugin_context() -> Map<String, Value> {
    std::env::var("HERDR_PLUGIN_CONTEXT_JSON")
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Resolve the pinned launch target. Precedence per field:
/// explicit `HERDR_TUI_*` env pins (set by the `open` action) →
/// `HERDR_PLUGIN_CONTEXT_JSON` origin fields → null.
///
/// `HERDR_PANE_ID` is deliberately ignored: it identifies the UI pane
/// itself (surface identity), which is never a mutation target.
fn resolve_pinned_target() -> PinnedTarget {
    let context = parse_plugin_context();
    let focused_pane = context
        .get("focused_pane")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let workspace_id = env_str("HERDR_TUI_WORKSPACE_ID")
        .or_else(|| jstr(context.get("workspace_id")));
    let tab_id = env_str("HERDR_TUI_TAB_ID").or_else(|| jstr(context.get("tab_id")));
    let origin_pane_id = env_str("HERDR_TUI_PANE_ID")
        .or_else(|| jstr(context.get("focused_pane_id")))
        .or_else(|| jstr(focused_pane.get("pane_id")))
        .or_else(|| jstr(focused_pane.get("id")));
    let origin_cwd = env_str("HERDR_TUI_CWD")
        .or_else(|| jstr(focused_pane.get("cwd")))
        .or_else(|| jstr(context.get("cwd")))
        .or_else(|| jstr(context.get("workspace_cwd")));

    let mut socket_path = None;
    let mut session = None;
    if let Ok(resolved) = resolve_target(&ResolveTargetOptions::default()) {
        socket_path = Some(resolved.socket_path.clone());
        session = resolved.session.clone();
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
fn format_target_label(target: &PinnedTarget) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(s) = &target.session {
        parts.push(format!("session {s}"));
    }
    if let Some(w) = &target.workspace_id {
        parts.push(format!("ws {w}"));
    }
    if let Some(p) = &target.origin_pane_id {
        parts.push(format!("pane {p}"));
    }
    if let Some(c) = &target.origin_cwd {
        parts.push(format!("cwd {c}"));
    }
    if parts.is_empty() {
        "no pinned target".to_string()
    } else {
        parts.join(" · ")
    }
}

// --- payload → view model (tolerant parse, port of tui-support helpers) -----

#[derive(Debug, Clone)]
struct MachineView {
    id: String,
    label: String,
    target: String,
    session: String,
    enabled: bool,
    selected: Option<bool>,
}

#[derive(Debug, Clone)]
struct ProbeView {
    state: String,
    probed_at: String,
    reachable: Option<bool>,
    server_version: Option<String>,
    protocol: Option<f64>,
    plugin_surface: String,
    plugin_surface_error: Option<String>,
    error_kind: Option<String>,
    error: Option<String>,
    plugins: Option<Vec<RemotePluginLite>>,
}

#[derive(Debug, Clone)]
struct RemotePluginLite {
    id: String,
    name: Option<String>,
    version: Option<String>,
}

#[derive(Debug, Clone)]
struct MachineItem {
    machine: MachineView,
    last_probe: Option<ProbeView>,
}

fn as_record(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

fn fmt_value(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "unknown".to_string(),
        Some(Value::Bool(b)) => {
            if *b {
                "yes".to_string()
            } else {
                "no".to_string()
            }
        }
        Some(other) => match other.as_str() {
            Some(s) => s.to_string(),
            None => other.to_string(),
        },
    }
}

/// Tolerant parse of one `list` item; `None` when malformed (never
/// fabricated). Port of `asMachineItem`.
fn as_machine_item(value: &Value) -> Option<MachineItem> {
    let v = as_record(value)?;
    let m = as_record(v.get("machine")?)?;
    let id = m.get("id")?.as_str()?;
    if id.is_empty() {
        return None;
    }
    let machine = MachineView {
        id: id.to_string(),
        label: m
            .get("label")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| id.to_string()),
        target: fmt_value(m.get("target")),
        session: fmt_value(m.get("session")),
        enabled: m.get("enabled").and_then(|v| v.as_bool()) != Some(false),
        selected: m.get("selected").and_then(|v| v.as_bool()),
    };
    let last_probe = as_record(v.get("last_probe")?).and_then(|p| {
        let state = p.get("state")?.as_str()?;
        Some(ProbeView {
            state: state.to_string(),
            probed_at: fmt_value(p.get("probed_at")),
            reachable: p.get("reachable").and_then(|v| v.as_bool()),
            server_version: p
                .get("server_version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            protocol: p.get("protocol").and_then(|v| v.as_f64()),
            plugin_surface: fmt_value(p.get("plugin_surface")),
            plugin_surface_error: p
                .get("plugin_surface_error")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            error_kind: p
                .get("error_kind")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            error: p
                .get("error")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            plugins: p.get("plugins").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|pl| {
                        let r = pl.as_object()?;
                        let id = r.get("id")?.as_str()?;
                        Some(RemotePluginLite {
                            id: id.to_string(),
                            name: r
                                .get("name")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            version: r
                                .get("version")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                        })
                    })
                    .collect()
            }),
        })
    });
    Some(MachineItem {
        machine,
        last_probe,
    })
}

fn as_machine_items(value: Option<&Value>) -> Vec<MachineItem> {
    value
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(as_machine_item).collect())
        .unwrap_or_default()
}

/// One-line probe summary for list rows (port of `probeSummary`).
fn probe_summary(probe: &Option<ProbeView>) -> String {
    let Some(p) = probe else {
        return "never probed".to_string();
    };
    let mut parts = vec![format!("probe: {}", p.state)];
    if let Some(v) = &p.server_version {
        parts.push(format!("v{v}"));
    }
    if let Some(pr) = p.protocol {
        parts.push(format!("proto {pr}"));
    }
    parts.push(format!("surface {}", p.plugin_surface));
    parts.push(format!("at {}", p.probed_at));
    parts.join(" · ")
}

fn bool_word(b: Option<bool>) -> String {
    match b {
        Some(true) => "true".to_string(),
        Some(false) => "false".to_string(),
        None => "unknown".to_string(),
    }
}

/// Select-list label + multi-line detail for one machine (port of
/// `machineSelectItem`).
fn machine_select_text(item: &MachineItem) -> (String, String) {
    let m = &item.machine;
    let mut flags: Vec<String> = Vec::new();
    if !m.enabled {
        flags.push("disabled".to_string());
    }
    if m.selected == Some(true) {
        flags.push("selected".to_string());
    }
    if let Some(p) = &item.last_probe {
        if p.state != "ok" {
            flags.push(format!("probe:{}", p.state));
        }
    }
    let suffix = if flags.is_empty() {
        String::new()
    } else {
        format!(" [{}]", flags.join(", "))
    };
    let label = format!("{} ({}){}", m.label, m.id, suffix);
    let detail = format!(
        "target: {} · session: {}\nenabled: {} · selected: {}\n{}\np probe this machine · a probe all · R refresh",
        m.target,
        m.session,
        m.enabled,
        bool_word(m.selected),
        probe_summary(&item.last_probe),
    );
    (label, detail)
}

/// Header + last-probe lines for the machine detail view (port of
/// `machineHeaderLines`).
fn machine_header_lines(item: &MachineItem) -> Vec<String> {
    let m = &item.machine;
    let mut lines = vec![
        format!("machine {} ({})", m.label, m.id),
        format!("target: {}", m.target),
        format!("session: {}", m.session),
        format!(
            "enabled: {} · selected: {}",
            m.enabled,
            bool_word(m.selected)
        ),
    ];
    match &item.last_probe {
        None => lines.push("last probe: never probed".to_string()),
        Some(p) => {
            lines.push(format!("last probe ({}):", p.probed_at));
            lines.push(format!(
                "  state: {} · reachable: {}",
                p.state,
                match p.reachable {
                    Some(true) => "true".to_string(),
                    Some(false) => "false".to_string(),
                    None => "unknown".to_string(),
                }
            ));
            lines.push(format!(
                "  server: {} · protocol: {}",
                p.server_version.clone().unwrap_or_else(|| "unknown".to_string()),
                p.protocol
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ));
            lines.push(format!("  plugin surface: {}", p.plugin_surface));
            if let Some(e) = &p.plugin_surface_error {
                lines.push(format!("  surface error: {e}"));
            }
            if p.error_kind.is_some() || p.error.is_some() {
                lines.push(format!(
                    "  error: {}{}",
                    p.error_kind.clone().unwrap_or_else(|| "?".to_string()),
                    p.error
                        .as_ref()
                        .map(|e| format!(" — {e}"))
                        .unwrap_or_default()
                ));
            }
            if let Some(plugins) = &p.plugins {
                lines.push(format!("  remote plugins ({}):", plugins.len()));
                for pl in plugins {
                    lines.push(format!(
                        "    {}{}{}",
                        pl.id,
                        pl.name
                            .as_ref()
                            .map(|n| format!(" ({n})"))
                            .unwrap_or_default(),
                        pl.version
                            .as_ref()
                            .map(|v| format!(" v{v}"))
                            .unwrap_or_default()
                    ));
                }
            }
        }
    }
    lines.push(String::new());
    lines.push("p probe this machine · R refresh list".to_string());
    lines
}

/// Format a `probe` result payload into detail lines (port of
/// `formatProbePayload`).
fn format_probe_payload(payload: &Value) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let results = payload
        .get("results")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if results.is_empty() {
        lines.push("(no probe results)".to_string());
        return lines;
    }
    for r in &results {
        let rec = as_record(r).cloned().unwrap_or_default();
        let get = |k: &str| -> String { fmt_value(rec.get(k)) };
        let id = get("machine_id");
        lines.push(format!(
            "probe {id} — {} (at {})",
            get("state"),
            get("probed_at")
        ));
        lines.push(format!(
            "  reachable: {} · server {} · protocol {}",
            fmt_opt_bool(rec.get("reachable")),
            get("server_version"),
            get("protocol")
        ));
        lines.push(format!("  plugin surface: {}", get("plugin_surface")));
        if let Some(e) = rec.get("plugin_surface_error").and_then(|v| v.as_str()) {
            lines.push(format!("  surface error: {e}"));
        }
        if let Some(ek) = rec.get("error_kind") {
            if !ek.is_null() {
                lines.push(format!(
                    "  error: {}{}",
                    get("error_kind"),
                    rec.get("error")
                        .and_then(|v| v.as_str())
                        .map(|e| format!(" — {e}"))
                        .unwrap_or_default()
                ));
            }
        }
        match rec.get("plugins") {
            Some(Value::Array(plugins)) if !plugins.is_empty() => {
                lines.push(format!("  remote plugins ({}):", plugins.len()));
                for pl in plugins {
                    let pr = pl.as_object().cloned().unwrap_or_default();
                    let pid = pr
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?");
                    let pname = pr.get("name").and_then(|v| v.as_str());
                    let pver = pr.get("version").and_then(|v| v.as_str());
                    lines.push(format!(
                        "    {pid}{}{}",
                        pname.map(|n| format!(" ({n})")).unwrap_or_default(),
                        pver.map(|v| format!(" v{v}")).unwrap_or_default()
                    ));
                }
            }
            Some(Value::Array(_)) => lines.push("  remote plugins: none reported".to_string()),
            _ => {}
        }
    }
    lines
}

fn fmt_opt_bool(v: Option<&Value>) -> String {
    match v {
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::Bool(false)) => "false".to_string(),
        _ => "unknown".to_string(),
    }
}

/// Format the `capability` payload for an info detail view (port of
/// `formatCapabilityPayload`).
fn format_capability_payload(payload: &Value) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let rec = as_record(payload).cloned().unwrap_or_default();
    let get = |k: &str| -> String { fmt_value(rec.get(k)) };
    lines.push(format!(
        "contract: {} ({})",
        get("contract"),
        get("contract_status")
    ));
    lines.push(format!("plugin: {} v{}", get("plugin"), get("version")));
    lines.push(format!("read_only: {}", get("read_only")));
    if let Some(Value::Array(states)) = rec.get("probe_states") {
        let names: Vec<&str> = states.iter().filter_map(|v| v.as_str()).collect();
        lines.push(format!("probe states: {}", names.join(", ")));
    }
    if let Some(Value::Array(surfaces)) = rec.get("plugin_surfaces") {
        let names: Vec<&str> = surfaces.iter().filter_map(|v| v.as_str()).collect();
        lines.push(format!("plugin surfaces: {}", names.join(", ")));
    }
    if let Some(t) = rec.get("transport").and_then(|v| v.as_str()) {
        lines.push(format!("transport: {t}"));
    }
    if let Some(Value::Array(notes)) = rec.get("notes") {
        lines.push("notes:".to_string());
        for n in notes {
            if let Some(s) = n.as_str() {
                lines.push(format!("  - {s}"));
            }
        }
    }
    lines
}

// --- error text -----------------------------------------------------------------

fn error_line(err: &RemoteError) -> String {
    format!("{}: {}", err.kind, err.message)
}

// --- `open` action helper -------------------------------------------------------

fn run_open() -> i32 {
    let target = resolve_pinned_target();
    let mut env = Map::new();
    if let Some(w) = &target.workspace_id {
        env.insert("HERDR_TUI_WORKSPACE_ID".into(), json!(w));
    }
    if let Some(t) = &target.tab_id {
        env.insert("HERDR_TUI_TAB_ID".into(), json!(t));
    }
    if let Some(p) = &target.origin_pane_id {
        env.insert("HERDR_TUI_PANE_ID".into(), json!(p));
    }
    if let Some(c) = &target.origin_cwd {
        env.insert("HERDR_TUI_CWD".into(), json!(c));
    }
    let mut params = json!({
        "plugin_id": PLUGIN_ID,
        "entrypoint": "main",
        "placement": "tab",
        "env": env,
    });
    if let Some(w) = &target.workspace_id {
        params["workspace_id"] = json!(w);
    }
    // plugin.pane.open is a herdr-state mutation: fail closed on implicit
    // default-session fallback.
    let resolved = match resolve_target(&ResolveTargetOptions {
        mutation: true,
        ..Default::default()
    }) {
        Ok(r) => r,
        Err(e) => {
            eprintln!(
                "{}",
                serde_json::to_string(&json!({
                    "ok": false,
                    "error": {"kind": e.code.as_str(), "message": e.message}
                }))
                .unwrap_or_default()
            );
            return 1;
        }
    };
    match socket::request(&resolved.socket_path, "plugin.pane.open", params, 10_000) {
        Ok(result) => {
            println!(
                "{}",
                serde_json::to_string(&json!({
                    "ok": true,
                    "plugin": PLUGIN_ID,
                    "pane": result
                }))
                .unwrap_or_default()
            );
            0
        }
        Err(e) => {
            eprintln!(
                "{}",
                serde_json::to_string(&json!({
                    "ok": false,
                    "error": {"kind": "pane_open_failed", "message": e.to_string()}
                }))
                .unwrap_or_default()
            );
            1
        }
    }
}

// --- plain-text fallback (non-TTY stdin) ---------------------------------------

/// Plain-text fallback for non-TTY stdin (pipes/CI): honest, read-only.
fn render_plain_list() -> i32 {
    match cli::list_payload_for_tui(&HerdrTarget::default()) {
        Ok(payload) => {
            let machines = payload
                .get("machines")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            if machines.is_empty() {
                println!("machines: no saved machines");
            }
            for raw in &machines {
                let rec = raw.as_object().cloned().unwrap_or_default();
                let m = rec
                    .get("machine")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                let probe = rec.get("last_probe").and_then(|v| v.as_object());
                let id = m
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                let label = m
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or(id);
                let target = m
                    .get("target")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                let enabled = m.get("enabled").and_then(|v| v.as_bool()) != Some(false);
                let probe_state = probe
                    .and_then(|p| p.get("state"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("never");
                println!(
                    "{label} ({id})\ttarget={target}\tenabled={enabled}\tprobe={probe_state}"
                );
            }
            println!(
                "hint: run inside a herdr pane (or a TTY) for the interactive TUI; CLI: ./bin/machines <cmd>"
            );
            0
        }
        Err(err) => {
            eprintln!("machines tui: {}", err.message);
            1
        }
    }
}

// --- select-list model (port of packages/tui SelectList semantics) ------------

struct SelectList {
    /// (label, detail, item index into `items`)
    rows: Vec<(String, String, usize)>,
    cursor: usize,
    scroll_top: usize,
    /// `/` filter draft; `filter_active` while editing.
    filter_active: bool,
    filter_draft: String,
    committed_filter: String,
    empty_text: String,
}

impl SelectList {
    fn new(empty_text: &str) -> Self {
        SelectList {
            rows: Vec::new(),
            cursor: 0,
            scroll_top: 0,
            filter_active: false,
            filter_draft: String::new(),
            committed_filter: String::new(),
            empty_text: empty_text.to_string(),
        }
    }

    fn set_items(&mut self, items: &[MachineItem]) {
        self.rows = items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let (label, detail) = machine_select_text(item);
                (label, detail, i)
            })
            .collect();
        self.clamp_cursor();
    }

    fn filter_query(&self) -> String {
        if self.filter_active {
            self.filter_draft.clone()
        } else {
            self.committed_filter.clone()
        }
    }

    /// Case-insensitive AND-of-terms substring filter over
    /// "label detail" (port of `filterItems`).
    fn filtered_indices(&self) -> Vec<usize> {
        let q = self.filter_query().trim().to_lowercase();
        if q.is_empty() {
            return (0..self.rows.len()).collect();
        }
        let terms: Vec<&str> = q.split_whitespace().collect();
        self.rows
            .iter()
            .enumerate()
            .filter(|(_, (label, detail, _))| {
                let hay = format!("{label} {detail}").to_lowercase();
                terms.iter().all(|t| hay.contains(t))
            })
            .map(|(i, _)| i)
            .collect()
    }

    /// Cursor is an index into `rows`; movement operates on the
    /// filtered view, wrapping (port of `move`).
    fn filtered_position(&self) -> usize {
        let f = self.filtered_indices();
        f.iter()
            .position(|&r| r == self.cursor)
            .unwrap_or(0)
    }

    fn move_cursor(&mut self, delta: isize) {
        let f = self.filtered_indices();
        if f.is_empty() {
            return;
        }
        let pos = self.filtered_position();
        let n = f.len() as isize;
        let next = (pos as isize + delta).rem_euclid(n) as usize;
        self.cursor = f[next];
    }

    fn clamp_cursor(&mut self) {
        let f = self.filtered_indices();
        if f.is_empty() {
            self.cursor = 0;
            self.scroll_top = 0;
            return;
        }
        if !f.contains(&self.cursor) {
            self.cursor = f[0];
        }
        let pos = self.filtered_position();
        if pos >= f.len() {
            self.cursor = f[f.len() - 1];
        }
    }

    fn selected_item_index(&self) -> Option<usize> {
        let f = self.filtered_indices();
        f.iter()
            .position(|&r| r == self.cursor)
            .and_then(|pos| self.rows.get(f[pos]).map(|(_, _, i)| *i))
    }

    /// Handle a key inside the list; returns true when consumed.
    /// Returns an enum action for the host screen.
    fn handle_key(&mut self, ev: &KeyEvent) -> ListKeyResult {
        if ev.kind != KeyEventKind::Press {
            return ListKeyResult::Ignored;
        }
        if self.filter_active {
            match ev.code {
                KeyCode::Char(c) if !ev.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.filter_draft.push(c);
                    self.cursor = self.rows.first().map(|_| 0).unwrap_or(0);
                    // cursor reset semantics: TS sets cursor=0 which is
                    // the first ROW index; our cursor indexes rows too.
                    self.clamp_after_filter_edit();
                    return ListKeyResult::Consumed;
                }
                KeyCode::Backspace => {
                    self.filter_draft.pop();
                    self.clamp_after_filter_edit();
                    return ListKeyResult::Consumed;
                }
                KeyCode::Enter => {
                    self.committed_filter = self.filter_draft.clone();
                    self.filter_active = false;
                    self.clamp_cursor();
                    return ListKeyResult::Consumed;
                }
                KeyCode::Esc => {
                    self.filter_active = false;
                    self.filter_draft.clear();
                    self.clamp_cursor();
                    return ListKeyResult::Consumed;
                }
                _ => return ListKeyResult::Consumed,
            }
        }
        match ev.code {
            KeyCode::Up | KeyCode::Char('k') => {
                if ev.code == KeyCode::Char('k')
                    && (ev.modifiers.contains(KeyModifiers::CONTROL)
                        || ev.modifiers.contains(KeyModifiers::ALT))
                {
                    return ListKeyResult::Ignored;
                }
                self.move_cursor(-1);
                ListKeyResult::Consumed
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if ev.code == KeyCode::Char('j')
                    && (ev.modifiers.contains(KeyModifiers::CONTROL)
                        || ev.modifiers.contains(KeyModifiers::ALT))
                {
                    return ListKeyResult::Ignored;
                }
                self.move_cursor(1);
                ListKeyResult::Consumed
            }
            KeyCode::PageUp => {
                for _ in 0..10 {
                    self.move_cursor(-1);
                }
                ListKeyResult::Consumed
            }
            KeyCode::PageDown | KeyCode::Char(' ') => {
                for _ in 0..10 {
                    self.move_cursor(1);
                }
                ListKeyResult::Consumed
            }
            KeyCode::Home => {
                let f = self.filtered_indices();
                if let Some(&first) = f.first() {
                    self.cursor = first;
                }
                ListKeyResult::Consumed
            }
            KeyCode::End => {
                let f = self.filtered_indices();
                if let Some(&last) = f.last() {
                    self.cursor = last;
                }
                ListKeyResult::Consumed
            }
            KeyCode::Char('/') => {
                self.filter_active = true;
                self.filter_draft = self.committed_filter.clone();
                ListKeyResult::Consumed
            }
            KeyCode::Enter => ListKeyResult::OpenDetail,
            KeyCode::Esc | KeyCode::Char('q') => ListKeyResult::Cancel,
            _ => ListKeyResult::Ignored,
        }
    }

    fn clamp_after_filter_edit(&mut self) {
        // TS resets cursor=0 on every draft edit (first row), then
        // clamps into the filtered view.
        self.cursor = self.rows.first().map(|_| 0).unwrap_or(0);
        self.clamp_cursor();
    }

    /// Render the list into styled lines for `width`×`height`.
    fn render(&mut self, width: usize, height: usize) -> Vec<Line<'static>> {
        let f = self.filtered_indices();
        let list_len = f.len();
        let use_detail = width >= 60
            && self
                .rows
                .get(self.cursor)
                .map(|(_, d, _)| !d.is_empty())
                .unwrap_or(false);
        let list_w = if use_detail { width * 55 / 100 } else { width };
        let detail_w = width.saturating_sub(list_w + 1);
        let chrome = usize::from(
            self.filter_active || !self.committed_filter.is_empty(),
        ) + usize::from(list_len > 0);
        let visible = height.saturating_sub(chrome + 1).max(1);

        // Scroll window follows cursor (port of SelectList.render clamps).
        let pos = self.filtered_position();
        if pos < self.scroll_top {
            self.scroll_top = pos;
        }
        if pos >= self.scroll_top + visible {
            self.scroll_top = pos + 1 - visible;
        }
        self.scroll_top = self
            .scroll_top
            .min(list_len.saturating_sub(visible));

        let mut rows: Vec<Line<'static>> = Vec::new();
        if self.filter_active || !self.committed_filter.is_empty() {
            let q = self.filter_query();
            let mut spans = vec![
                Span::styled("/", Style::default().add_modifier(Modifier::BOLD)),
                Span::styled(
                    clip(&sanitize_display(&q), list_w.saturating_sub(2)),
                    if self.filter_active {
                        Style::default()
                    } else {
                        Style::default().add_modifier(Modifier::DIM)
                    },
                ),
            ];
            if self.filter_active {
                spans.push(Span::styled("▌", Style::default().add_modifier(Modifier::REVERSED)));
            }
            rows.push(Line::from(spans));
        }
        if list_len == 0 {
            rows.push(Line::from(Span::styled(
                format!("  {}", self.empty_text),
                Style::default().add_modifier(Modifier::DIM),
            )));
        } else {
            for i in 0..visible.min(list_len.saturating_sub(self.scroll_top)) {
                let row_idx = f[self.scroll_top + i];
                let (label, _, _) = &self.rows[row_idx];
                let is_sel = row_idx == self.cursor;
                let style = if is_sel {
                    Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                };
                let label_w = list_w.saturating_sub(4);
                let shown = ellipsize(&sanitize_display(label), label_w);
                rows.push(Line::from(vec![
                    Span::styled(
                        if is_sel { "❯ " } else { "  " },
                        style,
                    ),
                    Span::styled(pad_end(&shown, label_w), style),
                ]));
            }
            if list_len > visible {
                // TS shows `cursor + 1` where cursor indexes the
                // filtered view.
                let pos_text = format!("{}/{}", self.filtered_position() + 1, list_len);
                rows.push(Line::from(Span::styled(
                    pad_start(&pos_text, list_w),
                    Style::default().add_modifier(Modifier::DIM),
                )));
            }
        }

        // Compose with optional detail pane (port of SelectList.render).
        let detail_lines: Vec<String> = if use_detail {
            self.rows
                .get(self.cursor)
                .map(|(_, d, _)| wrap_text(d, detail_w.saturating_sub(2).max(8)))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let detail_title = if use_detail {
            self.rows
                .get(self.cursor)
                .map(|(l, _, _)| clip(&sanitize_display(l), detail_w))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let filter_offset = usize::from(self.filter_active || !self.committed_filter.is_empty());
        let mut out: Vec<Line<'static>> = Vec::new();
        for (r, base) in rows.iter().enumerate().take(height) {
            let base_w: usize = base
                .spans
                .iter()
                .map(|s| UnicodeWidthStr::width(s.content.as_ref()))
                .sum();
            let mut spans = base.spans.clone();
            spans.push(Span::raw(" ".repeat(list_w.saturating_sub(base_w))));
            if !use_detail {
                out.push(Line::from(spans));
                continue;
            }
            spans.push(Span::styled("│", Style::default().add_modifier(Modifier::DIM)));
            spans.push(Span::raw(" "));
            let detail_row_idx = r as isize - filter_offset as isize;
            let (d_text, d_style) = if detail_row_idx == 0 {
                (detail_title.clone(), Style::default().add_modifier(Modifier::BOLD))
            } else if detail_row_idx > 0 {
                let idx = (detail_row_idx - 1) as usize;
                detail_lines
                    .get(idx)
                    .map(|l| (clip(&sanitize_display(l), detail_w.saturating_sub(1)), Style::default().add_modifier(Modifier::DIM)))
                    .unwrap_or_else(|| (String::new(), Style::default()))
            } else {
                (String::new(), Style::default())
            };
            spans.push(Span::styled(d_text, d_style));
            out.push(Line::from(spans));
        }
        while out.len() < height {
            out.push(Line::from(""));
        }
        out.truncate(height);
        out
    }
}

enum ListKeyResult {
    Consumed,
    Ignored,
    OpenDetail,
    Cancel,
}

// --- small text helpers ---------------------------------------------------------

fn clip(s: &str, width: usize) -> String {
    if UnicodeWidthStr::width(s) <= width {
        return s.to_string();
    }
    let mut out = String::new();
    let mut w = 0usize;
    for ch in s.chars() {
        let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if w + cw > width {
            break;
        }
        w += cw;
        out.push(ch);
    }
    out
}

fn ellipsize(s: &str, width: usize) -> String {
    let clean = sanitize_display(s);
    if UnicodeWidthStr::width(clean.as_str()) <= width {
        return clean;
    }
    if width <= 1 {
        return "…".to_string();
    }
    let mut out = String::new();
    let mut w = 0usize;
    for ch in clean.chars() {
        let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if w + cw > width.saturating_sub(1) {
            break;
        }
        w += cw;
        out.push(ch);
    }
    out.push('…');
    out
}

fn pad_end(s: &str, width: usize) -> String {
    let w = UnicodeWidthStr::width(s);
    if w >= width {
        return s.to_string();
    }
    format!("{s}{}", " ".repeat(width - w))
}

fn pad_start(s: &str, width: usize) -> String {
    let w = UnicodeWidthStr::width(s);
    if w >= width {
        return s.to_string();
    }
    format!("{}{s}", " ".repeat(width - w))
}

fn wrap_text(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut out = Vec::new();
    for raw in text.split('\n') {
        let mut line = String::new();
        let mut w = 0usize;
        for word in raw.split(' ') {
            let ww = UnicodeWidthStr::width(word);
            if w > 0 && w + 1 + ww > width {
                out.push(std::mem::take(&mut line));
                w = 0;
            }
            if w > 0 {
                line.push(' ');
                w += 1;
            }
            // Hard-split words longer than the width.
            let mut rest = word;
            while UnicodeWidthStr::width(rest) > width.saturating_sub(w) && w > 0 {
                let mut cut = 0usize;
                let mut cw = 0usize;
                for ch in rest.chars() {
                    let c = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
                    if cw + c > width - w {
                        break;
                    }
                    cw += c;
                    cut += ch.len_utf8();
                }
                if cut == 0 {
                    break;
                }
                line.push_str(&rest[..cut]);
                out.push(std::mem::take(&mut line));
                rest = &rest[cut..];
                w = 0;
            }
            line.push_str(rest);
            w += UnicodeWidthStr::width(rest);
        }
        out.push(line);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

// --- app -------------------------------------------------------------------------

enum View {
    /// Machine detail (read-only scroll). `machine_id` backs the `p`
    /// probe-this-machine affordance.
    Detail {
        title: String,
        machine_id: String,
        lines: Vec<String>,
        scroll: usize,
    },
    /// Capability info detail.
    Info { lines: Vec<String>, scroll: usize },
    /// Probe result detail.
    ProbeResult {
        title: String,
        lines: Vec<String>,
        scroll: usize,
    },
}

struct MachinesApp {
    target: PinnedTarget,
    capability: Option<Value>,
    items: Vec<MachineItem>,
    list: SelectList,
    phase: Phase,
    error_text: String,
    views: Vec<View>,
    status_left: String,
    status_right: String,
    /// Background task channel: list reload or probe.
    task_rx: Option<mpsc::Receiver<TaskMsg>>,
    task_cancel: Option<Arc<AtomicBool>>,
    task_started: Option<Instant>,
    task_label: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Loading,
    Ready,
    Error,
}

enum TaskMsg {
    List(Result<Vec<MachineItem>, String>),
    Probe(Result<Value, String>),
}

impl MachinesApp {
    fn new(target: PinnedTarget, capability: Option<Value>) -> Self {
        let mut app = MachinesApp {
            target,
            capability,
            items: Vec::new(),
            list: SelectList::new("no saved machines — add via `herdr machine add` (CLI)"),
            phase: Phase::Loading,
            error_text: String::new(),
            views: Vec::new(),
            status_left: String::new(),
            status_right: String::new(),
            task_rx: None,
            task_cancel: None,
            task_started: None,
            task_label: String::new(),
        };
        app.start_list_load();
        app
    }

    fn herdr_target(&self) -> HerdrTarget {
        // The TUI pins identity via HERDR_TUI_* env for pane.open; the
        // domain functions take explicit --socket/--session-equivalent
        // targets only. Ambient HERDR_SOCKET_PATH/HERDR_SESSION are
        // stripped for herdr CLI children by design (remote.rs), so the
        // pinned display values are NOT forwarded — matching the TS
        // `runMachinesCli(["list"])` path which passes no target flags.
        HerdrTarget::default()
    }

    fn start_list_load(&mut self) {
        let (tx, rx) = mpsc::channel();
        let target = self.herdr_target();
        std::thread::spawn(move || {
            let result = cli::list_payload_for_tui(&target).map(|payload| {
                as_machine_items(payload.get("machines"))
            });
            let _ = tx.send(TaskMsg::List(result.map_err(|e| error_line(&e))));
        });
        self.task_rx = Some(rx);
        self.task_cancel = None;
        self.task_started = Some(Instant::now());
        self.task_label = "loading machines".to_string();
        self.phase = Phase::Loading;
    }

    fn start_probe(&mut self, selector: &str) {
        if self.task_rx.is_some() {
            self.set_status(&format!("{selector}: a task is already running"), "");
            return;
        }
        let (tx, rx) = mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let target = self.herdr_target();
        let sel = selector.to_string();
        let sel2 = sel.clone();
        let cancel2 = cancel.clone();
        std::thread::spawn(move || {
            let result = run_probe_domain(&sel2, &target, Some(cancel2));
            let _ = tx.send(TaskMsg::Probe(result));
        });
        self.task_rx = Some(rx);
        self.task_cancel = Some(cancel);
        self.task_started = Some(Instant::now());
        self.task_label = if sel == "--all" {
            "probe all machines".to_string()
        } else {
            format!("probe {sel}")
        };
    }

    fn poll_tasks(&mut self) {
        // Task timeout → cooperative cancel (tui-v1 TaskRunner semantics).
        if let (Some(started), Some(cancel)) = (self.task_started, self.task_cancel.clone()) {
            if started.elapsed() > Duration::from_millis(TASK_TIMEOUT_MS) {
                cancel.store(true, Ordering::SeqCst);
            }
        }
        let Some(rx) = &self.task_rx else { return };
        match rx.try_recv() {
            Ok(msg) => {
                self.task_rx = None;
                self.task_cancel = None;
                self.task_started = None;
                match msg {
                    TaskMsg::List(Ok(items)) => {
                        self.items = items;
                        self.list.set_items(&self.items);
                        self.phase = Phase::Ready;
                        self.error_text.clear();
                        let total = self.items.len();
                        let left = if total == 0 {
                            "no saved machines".to_string()
                        } else {
                            format!(
                                "{total} machine(s) — p probe selected · a probe all · i capability"
                            )
                        };
                        self.set_status(&left, "");
                    }
                    TaskMsg::List(Err(e)) => {
                        self.phase = Phase::Error;
                        self.error_text = e;
                    }
                    TaskMsg::Probe(Ok(payload)) => {
                        let title = self.task_label.clone();
                        self.views.push(View::ProbeResult {
                            title,
                            lines: format_probe_payload(&payload),
                            scroll: 0,
                        });
                        // Probe recorded last-known metadata → refresh list.
                        self.start_list_load();
                    }
                    TaskMsg::Probe(Err(e)) => {
                        let label = self.task_label.clone();
                        let status = format!(
                            "{label} {}: {e}",
                            if e.starts_with("cancelled") { "cancelled" } else { "failed" },
                        );
                        self.set_status(&status, "");
                    }
                }
            }
            Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => {
                self.task_rx = None;
                self.task_cancel = None;
                self.task_started = None;
            }
        }
    }

    fn set_status(&mut self, left: &str, right: &str) {
        self.status_left = left.to_string();
        self.status_right = right.to_string();
    }

    fn cancel_task(&mut self) {
        if let Some(cancel) = &self.task_cancel {
            cancel.store(true, Ordering::SeqCst);
            self.set_status(&format!("{} cancelled", self.task_label), "");
        }
    }

    /// Top-level key dispatch. Returns true to keep running, false to
    /// exit the TUI.
    fn handle_key(&mut self, ev: KeyEvent) -> bool {
        if let Some(_view) = self.views.last() {
            return self.handle_view_key(ev);
        }
        // Root list view. While a background task runs, Esc/Ctrl-C
        // cancels it cooperatively; every other key still reaches the
        // list (navigation is harmless mid-probe).
        if self.task_rx.is_some() {
            match ev.code {
                KeyCode::Esc => {
                    self.cancel_task();
                    return true;
                }
                KeyCode::Char('c')
                    if ev.modifiers.contains(KeyModifiers::CONTROL) =>
                {
                    self.cancel_task();
                    return true;
                }
                _ => {}
            }
        }
        match self.list.handle_key(&ev) {
            ListKeyResult::Consumed => true,
            ListKeyResult::Ignored => self.handle_root_extra_key(&ev),
            ListKeyResult::Cancel => false,
            ListKeyResult::OpenDetail => {
                if let Some(idx) = self.list.selected_item_index() {
                    if let Some(item) = self.items.get(idx) {
                        self.views.push(View::Detail {
                            title: format!("{} ({})", item.machine.label, item.machine.id),
                            machine_id: item.machine.id.clone(),
                            lines: machine_header_lines(item),
                            scroll: 0,
                        });
                    }
                }
                true
            }
        }
    }

    /// Host-level keys the SelectList does not own (port of
    /// MachinesListView.handleKey): p probe selected, a probe all,
    /// i capability, r/R refresh.
    fn handle_root_extra_key(&mut self, ev: &KeyEvent) -> bool {
        if ev.kind != KeyEventKind::Press
            || ev.modifiers.contains(KeyModifiers::CONTROL)
            || ev.modifiers.contains(KeyModifiers::ALT)
            || self.list.filter_active
        {
            return true;
        }
        match ev.code {
            KeyCode::Char('p') => {
                let selected = self.list.selected_item_index();
                match selected.and_then(|i| self.items.get(i)) {
                    Some(item) => self.start_probe(&item.machine.id.clone()),
                    None => self.set_status("select a machine first (or use a for all)", ""),
                }
                true
            }
            KeyCode::Char('a') => {
                self.start_probe("--all");
                true
            }
            KeyCode::Char('i') => {
                self.capability_info();
                true
            }
            KeyCode::Char('r') | KeyCode::Char('R') => {
                self.start_list_load();
                true
            }
            _ => true,
        }
    }

    /// Capability/contract info detail (read-only diagnostics).
    fn capability_info(&mut self) {
        let payload = self
            .capability
            .clone()
            .unwrap_or_else(|| cli::capability_payload());
        self.views.push(View::Info {
            lines: format_capability_payload(&payload),
            scroll: 0,
        });
    }

    fn handle_view_key(&mut self, ev: KeyEvent) -> bool {
        if ev.kind != KeyEventKind::Press {
            return true;
        }
        let top = self.views.len() - 1;
        // During a probe task launched from a detail view, Esc/Ctrl-C
        // cancels the task instead of popping the view.
        if self.task_rx.is_some() {
            match ev.code {
                KeyCode::Esc => {
                    self.cancel_task();
                    return true;
                }
                KeyCode::Char('c') if ev.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.cancel_task();
                    return true;
                }
                _ => {}
            }
        }
        match ev.code {
            KeyCode::Up | KeyCode::Char('k') => {
                if let Some(v) = self.views.get_mut(top) {
                    scroll_by(v, -1);
                }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if let Some(v) = self.views.get_mut(top) {
                    scroll_by(v, 1);
                }
            }
            KeyCode::PageUp => {
                if let Some(v) = self.views.get_mut(top) {
                    scroll_by(v, -10);
                }
            }
            KeyCode::PageDown | KeyCode::Char(' ') => {
                if let Some(v) = self.views.get_mut(top) {
                    scroll_by(v, 10);
                }
            }
            KeyCode::Home => {
                if let Some(v) = self.views.get_mut(top) {
                    set_scroll(v, 0);
                }
            }
            KeyCode::End => {
                if let Some(v) = self.views.get_mut(top) {
                    set_scroll(v, usize::MAX);
                }
            }
            KeyCode::Char('p') => {
                // Probe this machine — only meaningful from a machine
                // Detail view; ProbeResult/Info are read-only.
                if let Some(View::Detail { machine_id, .. }) = self.views.get(top) {
                    let id = machine_id.clone();
                    self.start_probe(&id);
                }
            }
            KeyCode::Esc | KeyCode::Char('q') => {
                self.views.pop();
            }
            _ => {}
        }
        true
    }

    fn render(&mut self, frame: &mut ratatui::Frame, area: Rect) {
        if let Some(view) = self.views.last() {
            self.render_view(frame, area, view);
            return;
        }
        // Root: header + list + status.
        let header = Line::from(vec![
            Span::styled(
                format!("Machines v{PLUGIN_VERSION}"),
                Style::default().add_modifier(Modifier::BOLD),
            ),
            Span::raw(" — "),
            Span::styled(
                sanitize_display(&format_target_label(&self.target)),
                Style::default().add_modifier(Modifier::DIM),
            ),
        ]);
        let list_area = Rect {
            x: area.x,
            y: area.y + 1,
            width: area.width,
            height: area.height.saturating_sub(2),
        };
        let lines = match self.phase {
            Phase::Loading => vec![Line::from(Span::styled(
                "loading machines…",
                Style::default().add_modifier(Modifier::DIM),
            ))],
            Phase::Error => {
                let mut v = vec![Line::from(Span::styled(
                    "failed to load machines",
                    Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
                ))];
                for l in self.error_text.lines() {
                    v.push(Line::from(Span::styled(
                        clip(&sanitize_display(l), area.width as usize),
                        Style::default().fg(Color::Red),
                    )));
                }
                v.push(Line::from(Span::styled(
                    "R — retry · Esc — close",
                    Style::default().add_modifier(Modifier::DIM),
                )));
                v
            }
            Phase::Ready => self.list.render(area.width as usize, list_area.height as usize),
        };
        frame.render_widget(Paragraph::new(header), Rect { height: 1, ..area });
        frame.render_widget(Paragraph::new(lines), list_area);
        // Status line.
        let status = if self.task_rx.is_some() {
            format!("{}… (esc cancel)", self.task_label)
        } else {
            self.status_left.clone()
        };
        let right = if self.task_rx.is_some() {
            String::new()
        } else {
            self.status_right.clone()
        };
        let status_line = Line::from(vec![
            Span::styled(pad_end(&status, area.width as usize), Style::default().add_modifier(Modifier::DIM)),
        ]);
        let _ = right;
        frame.render_widget(
            Paragraph::new(status_line),
            Rect {
                x: area.x,
                y: area.y + area.height.saturating_sub(1),
                width: area.width,
                height: 1,
            },
        );
    }

    fn render_view(&self, frame: &mut ratatui::Frame, area: Rect, view: &View) {
        let (title, lines, scroll) = match view {
            View::Detail {
                title, lines, scroll, ..
            } => (title.clone(), lines.clone(), *scroll),
            View::Info { lines, scroll } => (
                "capability — contract & probe taxonomy".to_string(),
                lines.clone(),
                *scroll,
            ),
            View::ProbeResult {
                title, lines, scroll, ..
            } => (title.clone(), lines.clone(), *scroll),
        };
        // Title header row (dim), matching the TS DetailView chrome.
        let header = Line::from(Span::styled(
            clip(&sanitize_display(&title), area.width as usize),
            Style::default().add_modifier(Modifier::BOLD),
        ));
        let body_area = Rect {
            y: area.y + 1,
            height: area.height.saturating_sub(2),
            ..area
        };
        let wrapped = wrap_view_lines(&lines, area.width as usize);
        let body_h = body_area.height as usize;
        let max_scroll = wrapped.len().saturating_sub(body_h);
        let scroll = scroll.min(max_scroll);
        let window: Vec<Line> = wrapped
            .iter()
            .skip(scroll)
            .take(body_h)
            .map(|l| Line::from(clip(&sanitize_display(l), area.width as usize)))
            .collect();
        frame.render_widget(Paragraph::new(header), Rect { height: 1, ..area });
        frame.render_widget(Paragraph::new(window), body_area);
        let pos = format!("{}/{}", (scroll + 1).min(wrapped.len()), wrapped.len());
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                pad_start(&pos, area.width as usize),
                Style::default().add_modifier(Modifier::DIM),
            ))),
            Rect {
                y: area.y + area.height.saturating_sub(1),
                height: 1,
                ..area
            },
        );
    }
}

fn wrap_view_lines(lines: &[String], width: usize) -> Vec<String> {
    let mut out = Vec::new();
    for l in lines {
        if UnicodeWidthStr::width(l.as_str()) <= width.max(1) {
            out.push(l.clone());
        } else {
            out.extend(wrap_text(l, width.max(1)));
        }
    }
    out
}

fn scroll_by(view: &mut View, delta: isize) {
    let scroll = match view {
        View::Detail { scroll, .. }
        | View::Info { scroll, .. }
        | View::ProbeResult { scroll, .. } => scroll,
    };
    *scroll = scroll.saturating_add_signed(delta);
}

fn set_scroll(view: &mut View, v: usize) {
    let scroll = match view {
        View::Detail { scroll, .. }
        | View::Info { scroll, .. }
        | View::ProbeResult { scroll, .. } => scroll,
    };
    *scroll = if v == usize::MAX { usize::MAX / 2 } else { v };
}

/// Run the probe domain path in-process (same functions the CLI uses),
/// recording last-known metadata. Returns the `probe` command payload.
fn run_probe_domain(
    selector: &str,
    target: &HerdrTarget,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<Value, String> {
    let probes = if selector == "--all" {
        remote::probe_all_machines(Some(target), cancel).map_err(|e| error_line(&e))?
    } else {
        vec![remote::probe_machine(selector, Some(target), cancel).map_err(|e| error_line(&e))?]
    };
    let mut results = Vec::new();
    for probe in &probes {
        crate::state::record_probe(probe).map_err(|e| format!("state_error: {e}"))?;
        results.push(serde_json::to_value(probe).unwrap_or(Value::Null));
    }
    Ok(json!({
        "contract": crate::model::CONTRACT,
        "command": "probe",
        "total": results.len(),
        "results": results,
        "state_file": crate::state::state_file_path().to_string_lossy(),
        "generated_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }))
}

// --- entrypoint --------------------------------------------------------------------

const USAGE: &str = "usage: machines tui <open|main>\n  open — `open` action helper: plugin.pane.open (tab) for the TUI\n  main — interactive pane entrypoint (default)\n";

fn tui_main(args: &[String]) -> i32 {
    let command = args.first().map(|s| s.as_str()).unwrap_or("main");
    match command {
        "open" => run_open(),
        "main" => run_main(),
        "help" | "--help" | "-h" => {
            print!("{USAGE}");
            0
        }
        other => {
            eprintln!("unknown tui command: {other}");
            2
        }
    }
}

fn run_main() -> i32 {
    let target = resolve_pinned_target();

    if !io::stdin().is_terminal() {
        return render_plain_list();
    }

    // Capability document for the info view (offline; fail soft — the
    // list itself reports reachability honestly).
    let capability = Some(cli::capability_payload());

    let mut app = MachinesApp::new(target.clone(), capability);

    if crossterm::terminal::enable_raw_mode().is_err() {
        eprintln!("machines-tui: could not enable raw mode");
        return 1;
    }
    let _ = crossterm::execute!(io::stdout(), crossterm::terminal::EnterAlternateScreen);
    let backend = ratatui::backend::CrosstermBackend::new(io::stdout());
    let mut terminal = match Terminal::new(backend) {
        Ok(t) => t,
        Err(err) => {
            eprintln!("machines-tui: {err}");
            return 1;
        }
    };

    let result = (|| -> io::Result<()> {
        loop {
            app.poll_tasks();
            terminal.draw(|frame| {
                let area = frame.area();
                app.render(frame, area);
            })?;
            if event::poll(Duration::from_millis(50))? {
                if let Event::Key(key) = event::read()? {
                    if key.kind == KeyEventKind::Press && !app.handle_key(key) {
                        break;
                    }
                }
            }
        }
        Ok(())
    })();

    let _ = terminal.show_cursor();
    crossterm::execute!(io::stdout(), crossterm::terminal::LeaveAlternateScreen).ok();
    crossterm::terminal::disable_raw_mode().ok();

    match result {
        Ok(()) => {
            let _ = writeln!(io::stderr(), "machines tui exited");
            0
        }
        Err(err) => {
            eprintln!("machines-tui: {err}");
            1
        }
    }
}

/// `machines tui ...` entrypoint; returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    tui_main(args)
}
