//! rebuildup.artifacts interactive TUI — `herdr-plugins.tui/v1`
//! (ADR-0031/0032/0033, contract docs/contracts/tui-v1.md, issue #247).
//! Rust port of `plugins/artifacts/src/tui.ts` + `tui-views.ts`.
//!
//! Two entry modes, both argv-only (no shell):
//!
//!   artifacts tui open   — `open` action helper: pins the origin
//!                          context and calls `plugin.pane.open`
//!                          (placement "tab"), then exits promptly.
//!   artifacts tui main   — pane entrypoint (`[[panes]] id="main"`):
//!                          the interactive artifact registry browser
//!                          (list/search/detail/verify +
//!                          register/deliver/delete/gc).
//!
//! Identity: the launch context is pinned once (resolve_pinned_target)
//! and forwarded as HERDR_TUI_* env pins; every read/mutation goes
//! through the plugin's own CLI command cores in-process — the same
//! contract CLI/MCP/GUI consumers use, so behavior cannot drift.
//! HERDR_PANE_ID is the UI pane's own surface identity and is NEVER
//! used as a target. Non-TTY stdin degrades to a plain-text artifact
//! list — never a fake UI.
//!
//! Safety-contract mapping (tui-v1 §5 / ADR-0033 §3):
//! - read-only open: loads run only `list`/`get` — reads.
//! - explicit target: mutations name the artifact id (+ pane for
//!   deliver) resolved from pinned context or in-UI selection.
//! - stale generation: `revalidate` re-reads `get <id>` before
//!   delete/deliver and compares sha256/created_at/resolved_path; a
//!   vanished or changed artifact aborts `stale`, never silently
//!   retargets.
//! - mutation gating: `mutation_allowed` against the `capability`
//!   document; denied ops render disabled-with-reason.
//! - irreversible confirmation: confirm screens show exact target +
//!   consequence for register/delete/deliver/gc; delete of a
//!   referenced artifact requires a second explicit force confirm;
//!   gc defaults to dry-run preview before any collection.
//! - terminal preview: metadata + resolved path only — the plugin
//!   never renders payload bytes (ADR-0024); html/image/pdf get an
//!   explicit "open externally" affordance, never an implied browser.
//! - honest unsupported: CLI/socket failures render their real
//!   `kind: message`, never a fabricated success.
//! - every untrusted string is `sanitize_display`ed before render
//!   (tui-v1 §5.10).

use std::io::{self, IsTerminal, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Terminal;
use serde_json::{json, Value};
use unicode_width::UnicodeWidthStr;

use hoxay_tui::safety::sanitize_display;

use crate::model::js_date_parse_ms;
use crate::tui_model::{
    self, artifact_header_lines, artifact_select_item, as_artifact, as_artifacts,
    build_pane_open_params, error_line, format_deliver_result, format_gc_payload,
    format_index_meta, format_target_label, format_verify_payload, mutation_allowed,
    open_artifacts_pane, resolve_pinned_target, run_artifacts_cli, ArtifactView, CliError,
    PinnedTarget, KIND_CHOICES, STORAGE_CHOICES,
};

const PLUGIN_VERSION: &str = "0.2.0";

// --- argv entry ----------------------------------------------------------------

pub fn run(args: &[String]) -> ! {
    let command = args.first().map(|s| s.as_str()).unwrap_or("main");
    let code = match command {
        "open" => run_open(),
        "main" => run_main(),
        "--help" | "-h" | "help" => {
            println!(
                "usage: artifacts tui <open|main>\n  open — `open` action helper: plugin.pane.open (tab) for the TUI\n  main — interactive pane entrypoint (default)"
            );
            0
        }
        other => {
            eprintln!("unknown tui command: {}", other);
            2
        }
    };
    std::process::exit(code);
}

fn run_open() -> i32 {
    let target = resolve_pinned_target();
    let params = build_pane_open_params(&target);
    match open_artifacts_pane(&params) {
        Ok(result) => {
            println!(
                "{}",
                serde_json::to_string(&json!({
                    "ok": true,
                    "plugin": "rebuildup.artifacts",
                    "pane": result,
                }))
                .unwrap_or_default()
            );
            0
        }
        Err((kind, message)) => {
            eprintln!(
                "{}",
                serde_json::to_string(&json!({
                    "ok": false,
                    "error": { "kind": kind, "message": message },
                }))
                .unwrap_or_default()
            );
            1
        }
    }
}

// --- plain-text fallback ---------------------------------------------------------

/// Plain-text fallback for non-TTY stdin (pipes/CI): honest, read-only.
fn render_plain_list() -> i32 {
    let result = run_artifacts_cli(&["list".to_string(), "--limit".to_string(), "0".to_string()]);
    match result {
        Ok(payload) => {
            let artifacts = as_artifacts(payload.get("artifacts").unwrap_or(&Value::Null));
            let stdout = io::stdout();
            let mut out = stdout.lock();
            if artifacts.is_empty() {
                let _ = writeln!(out, "artifacts: registry empty");
            }
            for artifact in &artifacts {
                let item = artifact_select_item(artifact);
                let _ = writeln!(out, "{}", sanitize_display(&item.label));
                for line in item.detail.lines() {
                    let _ = writeln!(out, "\t{}", sanitize_display(line));
                }
            }
            let _ = writeln!(
                out,
                "hint: run inside a herdr pane (or a TTY) for the interactive TUI; CLI: artifacts <cmd>"
            );
            0
        }
        Err(e) => {
            eprintln!("artifacts tui: {}", e.message);
            1
        }
    }
}

// --- screen model -----------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Loading,
    Ready,
    Error,
    Missing,
}

/// One option row in a select screen.
#[derive(Clone)]
struct SelectOption {
    value: String,
    label: String,
    detail: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FlowKind {
    Search,
    Register,
    GcIso,
    DeliverKind,
    DeliverPane,
    DeliverNote,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DetailFormat {
    Verify,
    Gc,
    Deliver,
}

/// What a confirm screen executes on accept.
#[derive(Clone)]
enum ConfirmAction {
    /// Run a CLI argv, then optional follow-ups.
    Cli {
        args: Vec<String>,
        label: String,
        ok_status: Option<String>,
        detail: Option<(String, DetailFormat)>,
        reload: bool,
        changed: bool,
        /// Status line is derived from `payload.artifact` (register).
        register_result: bool,
    },
    /// Delete-flow step machine (needs structured error inspection).
    Delete(DeleteFlow),
    /// Deliver-flow send step.
    DeliverSend(DeliverFlow),
    /// Deliver: pinned origin pane accepted as target.
    DeliverPanePinned,
    /// Gc apply step.
    GcApply { older_than: String },
    /// Stale-generation drift accepted: store fresh record and resume.
    RevalidateAccept {
        artifact_id: String,
        fresh: ArtifactView,
        resume: Box<ConfirmAction>,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RegStep {
    Path,
    Kind,
    Storage,
    Title,
    Refs,
}

#[derive(Clone)]
struct RegisterFlow {
    step: RegStep,
    source_path: String,
    kind: String,
    storage: String,
    title: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DelStep {
    /// First confirm accepted; revalidate then attempt delete.
    Initial,
    /// Force confirm accepted; run delete --force.
    Force,
}

#[derive(Clone)]
struct DeleteFlow {
    step: DelStep,
    artifact_id: String,
    /// Record shown when the flow started (revalidate baseline) or the
    /// freshly revalidated record once `validated` is set.
    fresh: Option<ArtifactView>,
    referenced: bool,
    /// True once revalidation completed (or was bypassed by
    /// RevalidateAccept) — skips a second re-read.
    validated: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DlStep {
    KindSelect,
    Pane,
    Note,
    Confirm,
    Send,
}

#[derive(Clone)]
struct DeliverFlow {
    step: DlStep,
    artifact_id: String,
    /// "agent" | "pane"
    kind: String,
    pane_id: String,
    note: String,
    /// Revalidated artifact snapshot for display + baseline compare.
    fresh: Option<ArtifactView>,
    validated: bool,
}

enum Screen {
    Main,
    Detail {
        artifact_id: String,
        artifact: Option<ArtifactView>,
        phase: Phase,
        error: String,
        scroll: usize,
    },
    /// Single-line text prompt.
    Prompt {
        flow: FlowKind,
        draft: String,
        cursor: usize,
        label: String,
        placeholder: String,
    },
    /// Option picker.
    Select {
        flow: FlowKind,
        options: Vec<SelectOption>,
        cursor: usize,
    },
    Confirm {
        title: String,
        target_lines: Vec<String>,
        consequence: String,
        confirm_label: String,
        cancel_label: String,
        danger: bool,
        focus_confirm: bool,
        /// On cancel, re-read the underlying detail view (stale-refresh).
        cancel_refresh: bool,
        /// On cancel, push this prompt screen instead of just popping.
        cancel_prompt: Option<FlowKind>,
        action: ConfirmAction,
    },
    /// Read-only scrollable detail (verify/gc/deliver results).
    ScrollDetail {
        title: String,
        lines: Vec<String>,
        scroll: usize,
    },
    Help,
}

struct App {
    ctx: PinnedTarget,
    capability: Option<Value>,
    screens: Vec<Screen>,
    // main-list state (mirrors packages/tui SelectList)
    items: Vec<tui_model::ArtifactItem>,
    meta_lines: Vec<String>,
    search_query: Option<String>,
    phase: Phase,
    error_text: String,
    cursor: usize,
    scroll_top: usize,
    filter_mode: bool,
    filter_draft: String,
    committed_filter: String,
    status: String,
    // pending multi-step flows
    pending_register: Option<RegisterFlow>,
    pending_deliver: Option<DeliverFlow>,
    last_ctrl_c: Option<Instant>,
}

impl App {
    fn new(ctx: PinnedTarget, capability: Option<Value>) -> Self {
        App {
            ctx,
            capability,
            screens: vec![Screen::Main],
            items: Vec::new(),
            meta_lines: Vec::new(),
            search_query: None,
            phase: Phase::Loading,
            error_text: String::new(),
            cursor: 0,
            scroll_top: 0,
            filter_mode: false,
            filter_draft: String::new(),
            committed_filter: String::new(),
            status: "loading…".to_string(),
            pending_register: None,
            pending_deliver: None,
            last_ctrl_c: None,
        }
    }

    fn push(&mut self, s: Screen) {
        self.screens.push(s);
    }

    fn pop(&mut self) {
        if self.screens.len() > 1 {
            self.screens.pop();
        }
    }

    fn top_is_main(&self) -> bool {
        self.screens.len() == 1
    }

    // --- domain bridge ---------------------------------------------------------

    /// Run a CLI argv; Ok(payload) or status line set + None.
    fn run_op(&mut self, label: &str, args: &[&str]) -> Option<Value> {
        self.status = format!("running: {}…", label);
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        match run_artifacts_cli(&owned) {
            Ok(payload) => {
                self.status.clear();
                Some(payload)
            }
            Err(e) => {
                self.status = format!("{} failed: {}", label, error_line(&e));
                None
            }
        }
    }

    /// Run a CLI argv preserving the structured error for kind branching.
    fn run_op_detailed(&mut self, label: &str, args: &[&str], silent: bool) -> Result<Value, CliError> {
        self.status = format!("running: {}…", label);
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        match run_artifacts_cli(&owned) {
            Ok(payload) => {
                self.status.clear();
                Ok(payload)
            }
            Err(e) => {
                if !silent {
                    self.status = format!("{} failed: {}", label, error_line(&e));
                }
                Err(e)
            }
        }
    }

    fn gate(&mut self, command: &str) -> bool {
        let gate = mutation_allowed(self.capability.as_ref(), command);
        if !gate.allowed {
            self.status = format!(
                "mutations disabled: {}",
                gate.reason.unwrap_or_else(|| command.to_string())
            );
            return false;
        }
        true
    }

    // --- list load ---------------------------------------------------------------

    fn load_list(&mut self) {
        self.phase = Phase::Loading;
        match self.run_op_quiet(&["list", "--limit", "0"]) {
            Ok(payload) => {
                self.items = as_artifacts(payload.get("artifacts").unwrap_or(&Value::Null))
                    .iter()
                    .map(artifact_select_item)
                    .collect();
                self.meta_lines = format_index_meta(&payload);
                self.search_query = None;
                self.phase = Phase::Ready;
                self.error_text.clear();
                self.clamp_cursor();
            }
            Err(e) => {
                self.phase = Phase::Error;
                self.error_text = error_line(&e);
                self.status = "list failed — R to retry".to_string();
            }
        }
    }

    /// run_op without the "running:" status flicker for loads.
    fn run_op_quiet(&mut self, args: &[&str]) -> Result<Value, CliError> {
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        run_artifacts_cli(&owned)
    }

    fn filtered_indices(&self) -> Vec<usize> {
        let q = if self.filter_mode {
            self.filter_draft.trim().to_lowercase()
        } else {
            self.committed_filter.trim().to_lowercase()
        };
        let mut out = Vec::new();
        for (i, item) in self.items.iter().enumerate() {
            if q.is_empty() {
                out.push(i);
            } else {
                let hay = format!("{} {}", item.label, item.detail).to_lowercase();
                if hay.contains(&q) {
                    out.push(i);
                }
            }
        }
        out
    }

    fn move_cursor(&mut self, delta: isize) {
        let n = self.filtered_indices().len();
        if n == 0 {
            return;
        }
        // cursor is an index into the *filtered* list; no disabled items.
        self.cursor = (self.cursor as isize + delta).rem_euclid(n as isize) as usize;
    }

    fn clamp_cursor(&mut self) {
        let n = self.filtered_indices().len();
        if self.cursor >= n {
            self.cursor = n.saturating_sub(1);
        }
        if self.scroll_top > n.saturating_sub(1) {
            self.scroll_top = n.saturating_sub(1);
        }
    }

    fn current_artifact(&self) -> Option<ArtifactView> {
        self.filtered_indices()
            .get(self.cursor)
            .and_then(|i| self.items.get(*i))
            .map(|it| it.artifact.clone())
    }

    // --- detail view ----------------------------------------------------------------

    fn open_detail(&mut self, artifact: &ArtifactView) {
        self.push(Screen::Detail {
            artifact_id: artifact.artifact_id.clone(),
            artifact: Some(artifact.clone()),
            phase: Phase::Ready,
            error: String::new(),
            scroll: 0,
        });
        self.detail_load();
    }

    fn detail_load(&mut self) {
        let Some(Screen::Detail {
            artifact_id,
            artifact,
            phase,
            error,
            ..
        }) = self.screens.last_mut()
        else {
            return;
        };
        if !(*phase == Phase::Ready && artifact.is_some()) {
            *phase = Phase::Loading;
        }
        let id = artifact_id.clone();
        match run_artifacts_cli(&["get".to_string(), id]) {
            Ok(payload) => match payload.get("artifact").and_then(as_artifact) {
                Some(a) => {
                    *artifact = Some(a);
                    *phase = Phase::Ready;
                    error.clear();
                }
                None => {
                    *phase = Phase::Error;
                    *error = "get returned no artifact payload".to_string();
                }
            },
            Err(e) => {
                if e.kind == "artifact_not_found" {
                    *phase = Phase::Missing;
                } else {
                    *phase = Phase::Error;
                    *error = error_line(&e);
                }
            }
        }
    }

    /// Stale-generation gate (tui-v1 §3.3 / safety item 3): re-read the
    /// artifact through the public CLI immediately before a mutation.
    /// A vanished artifact aborts; a changed sha256/created_at/path
    /// asks the user before applying to the newer state. `resume` is
    /// the mutation continuation executed after acceptance.
    /// Returns the fresh view on the clean path, None when aborted or
    /// when a drift-confirm was pushed (the flow resumes via the
    /// confirm screen).
    fn revalidate_prompt(
        &mut self,
        artifact_id: &str,
        opened: Option<&ArtifactView>,
        resume: ConfirmAction,
    ) -> Option<ArtifactView> {
        let fresh = match run_artifacts_cli(&["get".to_string(), artifact_id.to_string()]) {
            Ok(payload) => payload.get("artifact").and_then(as_artifact),
            Err(e) => {
                if e.kind == "artifact_not_found" {
                    None
                } else {
                    self.status = format!("revalidate failed: {}", error_line(&e));
                    return None;
                }
            }
        };
        let Some(fresh) = fresh else {
            if let Some(Screen::Detail { phase, .. }) = self.screens.last_mut() {
                *phase = Phase::Missing;
            }
            self.status = format!("stale: artifact {} no longer exists", artifact_id);
            return None;
        };
        if let Some(opened) = opened {
            if fresh.sha256 != opened.sha256
                || fresh.created_at != opened.created_at
                || fresh.resolved_path != opened.resolved_path
            {
                self.push(Screen::Confirm {
                    title: "Artifact changed since this view opened".to_string(),
                    target_lines: vec![
                        format!("artifact: {}", artifact_id),
                        format!("sha256 was: {}", opened.sha256),
                        format!("sha256 now: {}", fresh.sha256),
                        format!("path was: {}", opened.resolved_path),
                        format!("path now: {}", fresh.resolved_path),
                    ],
                    consequence: "the registry record changed underneath this view; applying now writes to the latest state".to_string(),
                    confirm_label: "Apply anyway".to_string(),
                    cancel_label: "Refresh instead".to_string(),
                    danger: false,
                    focus_confirm: true,
                    cancel_refresh: true,
                    cancel_prompt: None,
                    action: ConfirmAction::RevalidateAccept {
                        artifact_id: artifact_id.to_string(),
                        fresh: fresh.clone(),
                        resume: Box::new(resume),
                    },
                });
                return None;
            }
        }
        // Clean path: adopt the fresh record into the detail view.
        if let Some(Screen::Detail { artifact, .. }) = self.screens.last_mut() {
            *artifact = Some(fresh.clone());
        }
        Some(fresh)
    }

    // --- list verbs -----------------------------------------------------------------

    fn search_flow(&mut self) {
        self.push(Screen::Prompt {
            flow: FlowKind::Search,
            draft: String::new(),
            cursor: 0,
            label: "Search artifacts (title/kind/path/id; empty = list)".to_string(),
            placeholder: String::new(),
        });
    }

    fn run_search(&mut self, query: &str) {
        let q = query.trim();
        if q.is_empty() {
            self.load_list();
            return;
        }
        match self.run_op_quiet(&["search", q, "--limit", "0"]) {
            Ok(payload) => {
                self.items = as_artifacts(payload.get("artifacts").unwrap_or(&Value::Null))
                    .iter()
                    .map(artifact_select_item)
                    .collect();
                let total = payload.get("total").and_then(|v| v.as_f64());
                let total_text = total
                    .map(crate::registry::fmt_num)
                    .unwrap_or_else(|| "?".to_string());
                let mut meta = vec![format!("search \"{}\" — {} match(es)", q, total_text)];
                meta.extend(format_index_meta(&payload));
                self.meta_lines = meta;
                self.search_query = Some(q.to_string());
                self.phase = Phase::Ready;
                self.clamp_cursor();
            }
            Err(e) => {
                self.phase = Phase::Ready;
                self.status = format!("search failed: {}", error_line(&e));
            }
        }
    }

    fn register_flow(&mut self) {
        if !self.gate("register") {
            return;
        }
        self.pending_register = Some(RegisterFlow {
            step: RegStep::Path,
            source_path: String::new(),
            kind: "auto".to_string(),
            storage: "state_copy".to_string(),
            title: String::new(),
        });
        self.push(Screen::Prompt {
            flow: FlowKind::Register,
            draft: String::new(),
            cursor: 0,
            label: "File path to register".to_string(),
            placeholder: String::new(),
        });
    }

    fn register_advance_select(&mut self, value: &str) {
        let Some(flow) = self.pending_register.clone() else { return };
        match flow.step {
            RegStep::Kind => {
                if let Some(f) = self.pending_register.as_mut() {
                    f.kind = value.to_string();
                    f.step = RegStep::Storage;
                }
                self.push(Screen::Select {
                    flow: FlowKind::Register,
                    options: STORAGE_CHOICES
                        .iter()
                        .map(|s| SelectOption {
                            value: s.to_string(),
                            label: s.to_string(),
                            detail: Some(
                                if *s == "state_copy" {
                                    "copy payload into plugin state (default, size-capped)"
                                } else {
                                    "reference the file in place; index entry only, external file never managed"
                                }
                                .to_string(),
                            ),
                        })
                        .collect(),
                    cursor: 0,
                });
            }
            RegStep::Storage => {
                if let Some(f) = self.pending_register.as_mut() {
                    f.storage = value.to_string();
                    f.step = RegStep::Title;
                }
                self.push(Screen::Prompt {
                    flow: FlowKind::Register,
                    draft: String::new(),
                    cursor: 0,
                    label: "Title (optional — Enter for none)".to_string(),
                    placeholder: String::new(),
                });
            }
            _ => {}
        }
    }

    fn register_advance_prompt(&mut self, text: &str) {
        let Some(flow) = self.pending_register.clone() else { return };
        match flow.step {
            RegStep::Path => {
                let source_path = text.trim().to_string();
                if source_path.is_empty() {
                    self.status = "empty path — cancelled".to_string();
                    self.pending_register = None;
                    return;
                }
                if let Some(f) = self.pending_register.as_mut() {
                    f.source_path = source_path;
                    f.step = RegStep::Kind;
                }
                self.push(Screen::Select {
                    flow: FlowKind::Register,
                    options: KIND_CHOICES
                        .iter()
                        .map(|k| SelectOption {
                            value: k.to_string(),
                            label: k.to_string(),
                            detail: Some(
                                if *k == "auto" {
                                    "detect kind from extension + mime sniff"
                                } else {
                                    &format!("register as kind={}", k)
                                }
                                .to_string(),
                            ),
                        })
                        .collect(),
                    cursor: 0,
                });
            }
            RegStep::Title => {
                if let Some(f) = self.pending_register.as_mut() {
                    f.title = text.trim().to_string();
                    f.step = RegStep::Refs;
                }
                self.push(Screen::Prompt {
                    flow: FlowKind::Register,
                    draft: String::new(),
                    cursor: 0,
                    label: "Refs (optional, comma-separated back-references)".to_string(),
                    placeholder: String::new(),
                });
            }
            RegStep::Refs => {
                let Some(f) = self.pending_register.take() else { return };
                let refs: Vec<String> = text
                    .split(',')
                    .map(|r| r.trim().to_string())
                    .filter(|r| !r.is_empty())
                    .collect();
                let mut args: Vec<String> = vec![
                    "register".to_string(),
                    "--path".to_string(),
                    f.source_path.clone(),
                ];
                if f.kind != "auto" {
                    args.push("--kind".to_string());
                    args.push(f.kind.clone());
                }
                args.push("--storage".to_string());
                args.push(f.storage.clone());
                if !f.title.is_empty() {
                    args.push("--title".to_string());
                    args.push(f.title.clone());
                }
                args.push("--created-by".to_string());
                args.push("cli".to_string());
                for r in &refs {
                    args.push("--ref".to_string());
                    args.push(r.clone());
                }
                let mut target_lines = vec![
                    format!("path: {}", f.source_path),
                    format!("kind: {} · storage: {}", f.kind, f.storage),
                ];
                if !f.title.is_empty() {
                    target_lines.push(format!("title: {}", f.title));
                }
                if !refs.is_empty() {
                    target_lines.push(format!("refs: {}", refs.join(", ")));
                }
                target_lines.push(format!("target: {}", format_target_label(&self.ctx)));
                self.push(Screen::Confirm {
                    title: "Register artifact?".to_string(),
                    target_lines,
                    consequence: "copies or references the file into the artifact registry (plugin state); content is never rendered".to_string(),
                    confirm_label: "Register".to_string(),
                    cancel_label: "Cancel".to_string(),
                    danger: false,
                    focus_confirm: true,
                    cancel_refresh: false,
                    cancel_prompt: None,
                    action: ConfirmAction::Cli {
                        args,
                        label: "register".to_string(),
                        ok_status: None,
                        detail: None,
                        reload: true,
                        changed: true,
                        register_result: true,
                    },
                });
            }
            _ => {}
        }
    }

    fn gc_iso_submit(&mut self, input: &str) {
        let older_than = input.trim().to_string();
        if js_date_parse_ms(&older_than).is_none() {
            self.status = "invalid ISO-8601 timestamp — gc cancelled".to_string();
            return;
        }
        // Step 1 (mandatory): dry-run preview. gc is pure plugin-state work.
        let preview = self.run_op(
            "gc dry-run",
            &["gc", "--older-than", &older_than, "--dry-run"],
        );
        let Some(preview) = preview else { return };
        self.push(Screen::ScrollDetail {
            title: format!("gc dry-run — older than {}", older_than),
            lines: format_gc_payload(&preview),
            scroll: 0,
        });
        let totals = preview.get("totals").and_then(|t| t.as_object());
        let would_delete = totals
            .and_then(|t| t.get("would_delete"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as usize;
        let skipped_ref = totals
            .and_then(|t| t.get("skipped_referenced"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as usize;
        if would_delete == 0 {
            self.status = "gc: nothing to collect".to_string();
            return;
        }
        // Step 2: explicit confirm, then the real run (no --dry-run).
        self.push(Screen::Confirm {
            title: "Collect expired artifacts?".to_string(),
            target_lines: vec![
                format!("policy: created_at < {}", older_than),
                format!("would delete: {} record(s)", would_delete),
                format!("skipped (referenced): {}", skipped_ref),
            ],
            consequence: "deletes index records and state_copy payloads; path_ref external files are never touched; referenced artifacts are skipped".to_string(),
            confirm_label: "Collect".to_string(),
            cancel_label: "Cancel".to_string(),
            danger: true,
            focus_confirm: true,
            cancel_refresh: false,
            cancel_prompt: None,
            action: ConfirmAction::GcApply { older_than },
        });
    }

    fn gc_flow(&mut self) {
        if !self.gate("gc") {
            return;
        }
        self.push(Screen::Prompt {
            flow: FlowKind::GcIso,
            draft: String::new(),
            cursor: 0,
            label: "GC artifacts older than (ISO-8601, e.g. 2026-01-01T00:00:00Z)".to_string(),
            placeholder: String::new(),
        });
    }

    fn verify_all_flow(&mut self) {
        if let Some(p) = self.run_op("verify", &["verify"]) {
            self.push(Screen::ScrollDetail {
                title: "verify — integrity check".to_string(),
                lines: format_verify_payload(&p),
                scroll: 0,
            });
        }
    }

    // --- detail verbs -----------------------------------------------------------------

    fn detail_delete(&mut self, artifact: &ArtifactView) {
        let referenced = !artifact.refs.is_empty();
        let mut target_lines = vec![
            format!("artifact: {}", artifact.artifact_id),
            format!(
                "kind: {} · {} · {}",
                artifact.kind, artifact.mime, artifact.resolved_path
            ),
            format!(
                "storage: {}{}",
                artifact.storage_mode,
                if referenced {
                    format!(" · refs: {}", artifact.refs.len())
                } else {
                    String::new()
                }
            ),
        ];
        target_lines.shrink_to_fit();
        self.push(Screen::Confirm {
            title: "Delete artifact?".to_string(),
            target_lines,
            consequence: if referenced {
                "attempts removal; a referenced artifact is refused unless a second explicit force confirmation is given; state_copy payload is deleted, path_ref external file is untouched".to_string()
            } else {
                "removes the index record and the state_copy payload; path_ref external file is never touched".to_string()
            },
            confirm_label: "Delete".to_string(),
            cancel_label: "Cancel".to_string(),
            danger: true,
            focus_confirm: true,
            cancel_refresh: false,
            cancel_prompt: None,
            action: ConfirmAction::Delete(DeleteFlow {
                step: DelStep::Initial,
                artifact_id: artifact.artifact_id.clone(),
                fresh: Some(artifact.clone()),
                referenced,
                validated: false,
            }),
        });
    }

    fn detail_deliver(&mut self, artifact: &ArtifactView) {
        if !self.gate("deliver") {
            return;
        }
        if artifact.missing_ref {
            self.status = "deliver refused locally: payload missing (missing_ref)".to_string();
            return;
        }
        self.pending_deliver = Some(DeliverFlow {
            step: DlStep::KindSelect,
            artifact_id: artifact.artifact_id.clone(),
            kind: String::new(),
            pane_id: String::new(),
            note: String::new(),
            fresh: Some(artifact.clone()),
            validated: false,
        });
        self.push(Screen::Select {
            flow: FlowKind::DeliverKind,
            options: vec![
                SelectOption {
                    value: "agent".to_string(),
                    label: "agent".to_string(),
                    detail: Some("agent.prompt — pane hosting a live agent".to_string()),
                },
                SelectOption {
                    value: "pane".to_string(),
                    label: "pane".to_string(),
                    detail: Some("pane.send_text — literal text to any pane".to_string()),
                },
            ],
            cursor: 0,
        });
    }

    fn detail_verify(&mut self, artifact_id: &str) {
        if let Some(p) = self.run_op("verify", &["verify", artifact_id]) {
            self.push(Screen::ScrollDetail {
                title: format!("verify — {}", artifact_id),
                lines: format_verify_payload(&p),
                scroll: 0,
            });
        }
    }

    /// Explicit external-open action (tui-v1 §5.8): only ever invoked
    /// from a dedicated keypress, never implicitly.
    fn open_external(&mut self, artifact: &ArtifactView) {
        if artifact.missing_ref {
            self.status = "open externally refused: payload missing (missing_ref)".to_string();
            return;
        }
        match open_external_path(&artifact.resolved_path) {
            Ok(()) => {
                self.status = format!("opened externally: {}", artifact.resolved_path);
            }
            Err(reason) => {
                self.status = format!(
                    "open externally failed ({}): {}",
                    reason, artifact.resolved_path
                );
            }
        }
    }

    // --- confirm execution -----------------------------------------------------------

    fn confirm_accept(&mut self, action: ConfirmAction) {
        match action {
            ConfirmAction::Cli {
                args,
                label,
                ok_status,
                detail,
                reload,
                changed,
                register_result,
            } => {
                let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
                match self.run_op_detailed(&label, &arg_refs, false) {
                    Ok(payload) => {
                        if register_result {
                            let artifact = payload.get("artifact").and_then(as_artifact);
                            self.status = format!(
                                "registered {} — {}",
                                artifact
                                    .as_ref()
                                    .map(|a| a.artifact_id.as_str())
                                    .unwrap_or("?"),
                                artifact
                                    .as_ref()
                                    .map(|a| a.kind.as_str())
                                    .unwrap_or("?")
                            );
                        } else if let Some(s) = ok_status {
                            self.status = s;
                        }
                        if let Some((title, format)) = detail {
                            let lines = match format {
                                DetailFormat::Verify => format_verify_payload(&payload),
                                DetailFormat::Gc => format_gc_payload(&payload),
                                DetailFormat::Deliver => format_deliver_result(&payload),
                            };
                            self.push(Screen::ScrollDetail { title, lines, scroll: 0 });
                        }
                        if changed || reload {
                            self.load_list();
                        }
                    }
                    Err(_) => {
                        // status already set by run_op_detailed
                    }
                }
            }
            ConfirmAction::Delete(flow) => self.delete_step(flow),
            ConfirmAction::DeliverSend(flow) => self.deliver_send(flow),
            ConfirmAction::DeliverPanePinned => {
                if let Some(mut flow) = self.pending_deliver.take() {
                    flow.pane_id = self.ctx.origin_pane_id.clone().unwrap_or_default();
                    flow.step = DlStep::Note;
                    self.pending_deliver = Some(flow.clone());
                    self.push(Screen::Prompt {
                        flow: FlowKind::DeliverNote,
                        draft: String::new(),
                        cursor: 0,
                        label: "Note (optional — Enter for none)".to_string(),
                        placeholder: String::new(),
                    });
                }
            }
            ConfirmAction::GcApply { older_than } => {
                match self.run_op(&format!("gc {}", older_than), &["gc", "--older-than", &older_than]) {
                    Some(payload) => {
                        self.push(Screen::ScrollDetail {
                            title: format!("gc applied — older than {}", older_than),
                            lines: format_gc_payload(&payload),
                            scroll: 0,
                        });
                        self.load_list();
                    }
                    None => {}
                }
            }
            ConfirmAction::RevalidateAccept {
                artifact_id: _,
                fresh,
                mut resume,
            } => {
                // Adopt the fresh record, then continue the mutation.
                if let Some(Screen::Detail { artifact, .. }) = self.screens.last_mut() {
                    *artifact = Some(fresh.clone());
                }
                inject_fresh(&mut resume, &fresh);
                self.confirm_accept(*resume);
            }
        }
    }

    /// Delete step machine: Initial = revalidate + honest delete attempt;
    /// Force = run delete --force after the second confirmation.
    fn delete_step(&mut self, mut flow: DeleteFlow) {
        match flow.step {
            DelStep::Initial => {
                if !flow.validated {
                    let opened = flow.fresh.clone();
                    let resume = ConfirmAction::Delete(flow.clone());
                    let Some(fresh) = self.revalidate_prompt(
                        &flow.artifact_id,
                        opened.as_ref(),
                        resume,
                    ) else {
                        return;
                    };
                    flow.fresh = Some(fresh);
                    flow.validated = true;
                }
                let fresh = flow.fresh.clone().unwrap_or_else(|| ArtifactView {
                    artifact_id: flow.artifact_id.clone(),
                    kind: String::new(),
                    title: None,
                    host: String::new(),
                    session: String::new(),
                    owner_pane_id: None,
                    owner_agent_session: None,
                    created_by: String::new(),
                    storage_mode: String::new(),
                    resolved_path: String::new(),
                    size: 0.0,
                    mime: String::new(),
                    sha256: String::new(),
                    oversize: false,
                    missing_ref: false,
                    owner_stale: false,
                    created_at: String::new(),
                    refs: Vec::new(),
                    warnings: Vec::new(),
                });
                match self.run_op_detailed("delete", &["delete", &flow.artifact_id], true) {
                    Ok(_) => {
                        self.status = format!("deleted {}", flow.artifact_id);
                        self.detail_load();
                        self.load_list();
                    }
                    Err(e) => {
                        if e.kind == "referenced" {
                            // Second, explicit force confirmation — never
                            // a silent escalation.
                            let ref_count = fresh.refs.len();
                            self.push(Screen::Confirm {
                                title: "Artifact is referenced — force delete?".to_string(),
                                target_lines: vec![
                                    format!("artifact: {}", fresh.artifact_id),
                                    format!("refs: {}", ref_count),
                                    format!("path: {}", fresh.resolved_path),
                                ],
                                consequence: "permanently removes the index record and state_copy payload even though back-references exist; this cannot be undone".to_string(),
                                confirm_label: "Force delete".to_string(),
                                cancel_label: "Cancel".to_string(),
                                danger: true,
                                focus_confirm: true,
                                cancel_refresh: false,
                                cancel_prompt: None,
                                action: ConfirmAction::Delete(DeleteFlow {
                                    step: DelStep::Force,
                                    artifact_id: flow.artifact_id.clone(),
                                    fresh: Some(fresh),
                                    referenced: true,
                                    validated: true,
                                }),
                            });
                        } else {
                            self.status = format!("delete failed: {}", error_line(&e));
                        }
                    }
                }
            }
            DelStep::Force => {
                match self.run_op_detailed(
                    "delete --force",
                    &["delete", &flow.artifact_id, "--force"],
                    true,
                ) {
                    Ok(_) => {
                        self.status = format!("deleted {} (forced)", flow.artifact_id);
                        self.detail_load();
                        self.load_list();
                    }
                    Err(e) => {
                        self.status = format!("delete --force failed: {}", error_line(&e));
                    }
                }
            }
        }
    }

    /// Deliver send step: revalidate (stale gate), then `deliver` CLI.
    fn deliver_send(&mut self, mut flow: DeliverFlow) {
        if !flow.validated {
            let opened = flow.fresh.clone();
            let resume = ConfirmAction::DeliverSend(flow.clone());
            let Some(fresh) = self.revalidate_prompt(
                &flow.artifact_id,
                opened.as_ref(),
                resume,
            ) else {
                return;
            };
            flow.fresh = Some(fresh);
            flow.validated = true;
        }
        let flag = if flow.kind == "agent" { "--agent" } else { "--pane" };
        let mut args: Vec<String> = vec![
            "deliver".to_string(),
            flow.artifact_id.clone(),
            flag.to_string(),
            flow.pane_id.clone(),
        ];
        if !flow.note.is_empty() {
            args.push("--note".to_string());
            args.push(flow.note.clone());
        }
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        match self.run_op_detailed("deliver", &arg_refs, false) {
            Ok(payload) => {
                self.push(Screen::ScrollDetail {
                    title: format!("deliver — {}", flow.artifact_id),
                    lines: format_deliver_result(&payload),
                    scroll: 0,
                });
            }
            Err(_) => {}
        }
    }

    /// Deliver pane selection step machine.
    fn deliver_select_kind(&mut self, value: &str) {
        let Some(mut flow) = self.pending_deliver.take() else { return };
        flow.kind = value.to_string();
        flow.step = DlStep::Pane;
        // Pinned origin pane → confirm first; otherwise prompt.
        if let Some(pane) = self.ctx.origin_pane_id.clone() {
            flow.pane_id = pane.clone();
            let artifact_id = flow.artifact_id.clone();
            self.pending_deliver = Some(flow);
            self.push(Screen::Confirm {
                title: "Use pinned origin pane as delivery target?".to_string(),
                target_lines: vec![
                    format!("pane: {}", pane),
                    format!("artifact: {}", artifact_id),
                ],
                consequence: "the artifact path text is sent to this pane".to_string(),
                confirm_label: "Use pane".to_string(),
                cancel_label: "Pick another".to_string(),
                danger: false,
                focus_confirm: true,
                cancel_refresh: false,
                cancel_prompt: Some(FlowKind::DeliverPane),
                action: ConfirmAction::DeliverPanePinned,
            });
        } else {
            self.pending_deliver = Some(flow);
            self.push(Screen::Prompt {
                flow: FlowKind::DeliverPane,
                draft: String::new(),
                cursor: 0,
                label: "Target pane id".to_string(),
                placeholder: String::new(),
            });
        }
    }

    fn deliver_pane_submit(&mut self, text: &str) {
        let pane_id = text.trim().to_string();
        if pane_id.is_empty() {
            self.status = "empty pane id — cancelled".to_string();
            return;
        }
        let Some(mut flow) = self.pending_deliver.take() else { return };
        flow.pane_id = pane_id;
        flow.step = DlStep::Note;
        self.pending_deliver = Some(flow);
        self.push(Screen::Prompt {
            flow: FlowKind::DeliverNote,
            draft: String::new(),
            cursor: 0,
            label: "Note (optional — Enter for none)".to_string(),
            placeholder: String::new(),
        });
    }

    fn deliver_note_submit(&mut self, text: &str) {
        let Some(mut flow) = self.pending_deliver.take() else { return };
        flow.note = text.trim().to_string();
        flow.step = DlStep::Confirm;
        // Confirm screen uses the (possibly stale) opened artifact for
        // display; revalidate runs after acceptance.
        let artifact = flow.fresh.clone();
        let mut target_lines = vec![
            format!(
                "artifact: {} ({})",
                flow.artifact_id,
                artifact.as_ref().map(|a| a.kind.as_str()).unwrap_or("?")
            ),
            format!(
                "target: {} pane {}",
                flow.kind, flow.pane_id
            ),
        ];
        if let Some(a) = &artifact {
            target_lines.push(format!("path sent: {}", a.resolved_path));
        }
        if !flow.note.is_empty() {
            target_lines.push(format!("note: {}", flow.note));
        }
        self.pending_deliver = Some(flow.clone());
        self.push(Screen::Confirm {
            title: "Deliver artifact reference?".to_string(),
            target_lines,
            consequence: "sends the artifact's stable path inside agent.prompt/pane.send_text text to the target pane — the pane's agent/user sees a path reference, not payload bytes".to_string(),
            confirm_label: "Deliver".to_string(),
            cancel_label: "Cancel".to_string(),
            danger: false,
            focus_confirm: true,
            cancel_refresh: false,
            cancel_prompt: None,
            action: ConfirmAction::DeliverSend(flow),
        });
    }

    // --- key dispatch -----------------------------------------------------------------

    fn handle_main_key(&mut self, ev: &KeyEvent) -> bool {
        // Filter draft mode swallows everything except its own keys.
        if self.filter_mode {
            match ev_key(ev) {
                Some(Key::Char(c)) => {
                    self.filter_draft.push(c);
                    self.cursor = 0;
                    self.scroll_top = 0;
                    self.clamp_cursor();
                    return true;
                }
                Some(Key::Backspace) => {
                    self.filter_draft.pop();
                    self.cursor = 0;
                    self.scroll_top = 0;
                    self.clamp_cursor();
                    return true;
                }
                Some(Key::Enter) => {
                    self.committed_filter = self.filter_draft.clone();
                    self.filter_mode = false;
                    self.clamp_cursor();
                    return true;
                }
                Some(Key::Esc) => {
                    self.filter_mode = false;
                    self.filter_draft.clear();
                    return true;
                }
                _ => return true, // swallow everything else while filtering
            }
        }
        match ev_key(ev) {
            Some(Key::Up) | Some(Key::Char('k')) => {
                self.move_cursor(-1);
                return true;
            }
            Some(Key::Down) | Some(Key::Char('j')) => {
                self.move_cursor(1);
                return true;
            }
            Some(Key::PageUp) => {
                for _ in 0..10 {
                    self.move_cursor(-1);
                }
                return true;
            }
            Some(Key::PageDown) => {
                for _ in 0..10 {
                    self.move_cursor(1);
                }
                return true;
            }
            Some(Key::Home) => {
                self.cursor = 0;
                return true;
            }
            Some(Key::End) => {
                let n = self.filtered_indices().len();
                self.cursor = n.saturating_sub(1);
                return true;
            }
            Some(Key::Char('/')) => {
                self.filter_mode = true;
                self.filter_draft = self.committed_filter.clone();
                return true;
            }
            Some(Key::Enter) => {
                if let Some(a) = self.current_artifact() {
                    self.open_detail(&a);
                }
                return true;
            }
            Some(Key::Esc) | Some(Key::Char('q')) => {
                // SelectList.onCancel → close the whole UI.
                return false; // handled by caller as app exit
            }
            Some(Key::Char('s')) => {
                self.search_flow();
                return true;
            }
            Some(Key::Char('n')) => {
                self.register_flow();
                return true;
            }
            Some(Key::Char('g')) => {
                self.gc_flow();
                return true;
            }
            Some(Key::Char('v')) => {
                self.verify_all_flow();
                return true;
            }
            Some(Key::Char('r')) | Some(Key::Char('R')) => {
                self.load_list();
                return true;
            }
            _ => return false,
        }
    }

    fn handle_detail_key(&mut self, ev: &KeyEvent) -> bool {
        enum DetailAction {
            None,
            Reload,
            Command(char),
        }
        let action = {
            let Some(Screen::Detail {
                phase,
                artifact,
                artifact_id: _,
                scroll,
                ..
            }) = self.screens.last_mut()
            else {
                return false;
            };
            if *phase != Phase::Ready {
                // Only r/R reload; everything else falls through to
                // the app-level back handler.
                match ev_key(ev) {
                    Some(Key::Char('r')) | Some(Key::Char('R')) => DetailAction::Reload,
                    _ => DetailAction::None,
                }
            } else {
                match ev_key(ev) {
                    Some(Key::Up) | Some(Key::Char('k')) => {
                        *scroll = scroll.saturating_sub(1);
                        DetailAction::None
                    }
                    Some(Key::Down) | Some(Key::Char('j')) => {
                        *scroll += 1;
                        DetailAction::None
                    }
                    Some(Key::PageUp) => {
                        *scroll = scroll.saturating_sub(10);
                        DetailAction::None
                    }
                    Some(Key::PageDown) | Some(Key::Space) => {
                        *scroll += 10;
                        DetailAction::None
                    }
                    Some(Key::Home) => {
                        *scroll = 0;
                        DetailAction::None
                    }
                    Some(Key::End) => {
                        *scroll = usize::MAX;
                        DetailAction::None
                    }
                    _ => {
                        if ev.modifiers.contains(KeyModifiers::CONTROL)
                            || ev.modifiers.contains(KeyModifiers::ALT)
                        {
                            DetailAction::None
                        } else if let Some(Key::Char(c)) = ev_key(ev) {
                            DetailAction::Command(c)
                        } else {
                            DetailAction::None
                        }
                    }
                }
            }
        };
        match action {
            DetailAction::None => {
                // Scroll consumed it; commands with no artifact → no-op.
                matches!(ev_key(ev), Some(Key::Up) | Some(Key::Down)
                    | Some(Key::PageUp) | Some(Key::PageDown) | Some(Key::Home)
                    | Some(Key::End) | Some(Key::Char('k')) | Some(Key::Char('j'))
                    | Some(Key::Space))
            }
            DetailAction::Reload => {
                self.detail_load();
                true
            }
            DetailAction::Command(c) => {
                let artifact = match self.screens.last() {
                    Some(Screen::Detail { artifact, .. }) => artifact.clone(),
                    _ => None,
                };
                let Some(a) = artifact else { return false };
                match c {
                    'd' => self.detail_delete(&a),
                    'l' => self.detail_deliver(&a),
                    'v' => {
                        if let Some(Screen::Detail { artifact_id, .. }) = self.screens.last() {
                            let id = artifact_id.clone();
                            self.detail_verify(&id);
                        }
                    }
                    'o' => self.open_external(&a),
                    'R' => self.detail_load(),
                    _ => return false,
                }
                true
            }
        }
    }

    fn handle_key(&mut self, ev: &KeyEvent) -> AppKeyResult {
        if ev.kind != KeyEventKind::Press {
            return AppKeyResult::Continue;
        }
        // Ctrl-C: cancel current op; a second press within 1.5s exits.
        if ev.modifiers.contains(KeyModifiers::CONTROL) && ev.code == KeyCode::Char('c') {
            let now = Instant::now();
            if self.last_ctrl_c.map(|t| now.duration_since(t).as_millis() < 1500).unwrap_or(false) {
                return AppKeyResult::Exit;
            }
            self.last_ctrl_c = Some(now);
            // Treat as Esc: cancel top screen / go back.
            return self.handle_escape();
        }
        // Reserved global keys on non-top-level screens.
        match self.screens.last() {
            Some(Screen::Main) => {
                if self.handle_main_key(ev) {
                    AppKeyResult::Continue
                } else {
                    // esc/q on the root list closes the UI (SelectList.onCancel).
                    match ev_key(ev) {
                        Some(Key::Esc) | Some(Key::Char('q')) => AppKeyResult::Exit,
                        Some(Key::Char('?')) | Some(Key::Char('h')) => {
                            self.push(Screen::Help);
                            AppKeyResult::Continue
                        }
                        _ => AppKeyResult::Continue,
                    }
                }
            }
            Some(Screen::Detail { .. }) => {
                if self.handle_detail_key(ev) {
                    AppKeyResult::Continue
                } else {
                    match ev_key(ev) {
                        Some(Key::Esc) | Some(Key::Char('q')) => {
                            self.pop();
                            AppKeyResult::Continue
                        }
                        Some(Key::Char('?')) | Some(Key::Char('h')) => {
                            self.push(Screen::Help);
                            AppKeyResult::Continue
                        }
                        _ => AppKeyResult::Continue,
                    }
                }
            }
            Some(Screen::ScrollDetail { .. }) => self.handle_scroll_detail_key(ev),
            Some(Screen::Prompt { .. }) => self.handle_prompt_key(ev),
            Some(Screen::Select { .. }) => self.handle_select_key(ev),
            Some(Screen::Confirm { .. }) => self.handle_confirm_key(ev),
            Some(Screen::Help) => {
                match ev_key(ev) {
                    Some(Key::Esc) | Some(Key::Char('q')) | Some(Key::Char('?'))
                    | Some(Key::Char('h')) => {
                        self.pop();
                    }
                    _ => {}
                }
                AppKeyResult::Continue
            }
            None => AppKeyResult::Continue,
        }
    }

    /// Cancel a confirm screen: honor `cancel_refresh` (stale-revalidate
    /// "Refresh instead") and `cancel_prompt` (deliver "Pick another").
    fn confirm_cancel(&mut self) {
        let (refresh, prompt) = match self.screens.pop() {
            Some(Screen::Confirm {
                cancel_refresh,
                cancel_prompt,
                ..
            }) => (cancel_refresh, cancel_prompt),
            _ => (false, None),
        };
        if refresh {
            self.detail_load();
        }
        if let Some(flow) = prompt {
            let draft = if flow == FlowKind::DeliverPane {
                self.ctx.origin_pane_id.clone().unwrap_or_default()
            } else {
                String::new()
            };
            let label = match flow {
                FlowKind::DeliverPane => "Target pane id".to_string(),
                _ => String::new(),
            };
            self.push(Screen::Prompt {
                flow,
                draft,
                cursor: 0,
                label,
                placeholder: String::new(),
            });
        }
    }

    fn handle_escape(&mut self) -> AppKeyResult {
        match self.screens.last() {
            Some(Screen::Main) => AppKeyResult::Exit,
            Some(Screen::Confirm { .. }) => {
                self.confirm_cancel();
                AppKeyResult::Continue
            }
            Some(Screen::Prompt { .. }) | Some(Screen::Select { .. }) => {
                self.pop();
                AppKeyResult::Continue
            }
            Some(Screen::ScrollDetail { .. }) | Some(Screen::Detail { .. }) => {
                self.pop();
                AppKeyResult::Continue
            }
            Some(Screen::Help) => {
                self.pop();
                AppKeyResult::Continue
            }
            None => AppKeyResult::Continue,
        }
    }

    fn handle_scroll_detail_key(&mut self, ev: &KeyEvent) -> AppKeyResult {
        let Some(Screen::ScrollDetail { scroll, .. }) = self.screens.last_mut() else {
            return AppKeyResult::Continue;
        };
        match ev_key(ev) {
            Some(Key::Up) | Some(Key::Char('k')) => *scroll = scroll.saturating_sub(1),
            Some(Key::Down) | Some(Key::Char('j')) => *scroll += 1,
            Some(Key::PageUp) => *scroll = scroll.saturating_sub(10),
            Some(Key::PageDown) | Some(Key::Char(' ')) => *scroll += 10,
            Some(Key::Home) => *scroll = 0,
            Some(Key::End) => *scroll = usize::MAX,
            Some(Key::Esc) | Some(Key::Char('q')) => {
                self.pop();
            }
            _ => {}
        }
        AppKeyResult::Continue
    }

    fn handle_prompt_key(&mut self, ev: &KeyEvent) -> AppKeyResult {
        // Take the screen out to satisfy the borrow checker, then put it back.
        let Some(Screen::Prompt {
            flow,
            draft,
            cursor,
            label: _,
            placeholder: _,
        }) = self.screens.last().cloned_prompt()
        else {
            return AppKeyResult::Continue;
        };
        match ev_key(ev) {
            Some(Key::Enter) => {
                let text = draft.clone();
                let flow = flow;
                self.pop();
                self.prompt_submit(flow, &text);
                return AppKeyResult::Continue;
            }
            Some(Key::Esc) => {
                self.pop();
                return AppKeyResult::Continue;
            }
            _ => {}
        }
        // Editing keys.
        if ev.modifiers.contains(KeyModifiers::CONTROL) {
            match ev.code {
                KeyCode::Char('u') => {
                    self.prompt_edit(|d, c| {
                        d.clear();
                        *c = 0;
                    });
                    return AppKeyResult::Continue;
                }
                KeyCode::Char('w') => {
                    self.prompt_edit(|d, cpos| {
                        let chars: Vec<char> = d.chars().collect();
                        let mut i = (*cpos).min(chars.len());
                        while i > 0 && chars[i - 1].is_whitespace() {
                            i -= 1;
                        }
                        while i > 0 && !chars[i - 1].is_whitespace() {
                            i -= 1;
                        }
                        let mut nd = String::new();
                        nd.extend(chars[..i].iter());
                        nd.extend(chars[(*cpos).min(chars.len())..].iter());
                        *d = nd;
                        *cpos = i;
                    });
                    return AppKeyResult::Continue;
                }
                KeyCode::Char('a') => {
                    self.prompt_edit(|_, c| *c = 0);
                    return AppKeyResult::Continue;
                }
                KeyCode::Char('e') => {
                    self.prompt_edit(|d, c| *c = d.chars().count());
                    return AppKeyResult::Continue;
                }
                KeyCode::Char('k') => {
                    self.prompt_edit(|d, c| {
                        let chars: Vec<char> = d.chars().collect();
                        if *c < chars.len() {
                            *d = chars[..*c].iter().collect();
                        }
                    });
                    return AppKeyResult::Continue;
                }
                _ => return AppKeyResult::Continue,
            }
        }
        match ev.code {
            KeyCode::Char(c) if !ev.modifiers.contains(KeyModifiers::ALT) => {
                self.prompt_edit(|d, cpos| {
                    let mut chars: Vec<char> = d.chars().collect();
                    chars.insert((*cpos).min(chars.len()), c);
                    *d = chars.into_iter().collect();
                    *cpos += 1;
                });
            }
            KeyCode::Backspace => {
                self.prompt_edit(|d, cpos| {
                    let mut chars: Vec<char> = d.chars().collect();
                    if *cpos > 0 {
                        chars.remove(*cpos - 1);
                        *cpos -= 1;
                        *d = chars.into_iter().collect();
                    }
                });
            }
            KeyCode::Delete => {
                self.prompt_edit(|d, cpos| {
                    let mut chars: Vec<char> = d.chars().collect();
                    if *cpos < chars.len() {
                        chars.remove(*cpos);
                        *d = chars.into_iter().collect();
                    }
                });
            }
            KeyCode::Left => {
                self.prompt_edit(|_, cpos| *cpos = cpos.saturating_sub(1));
            }
            KeyCode::Right => {
                self.prompt_edit(|d, cpos| {
                    *cpos = (*cpos + 1).min(d.chars().count());
                });
            }
            KeyCode::Home => {
                self.prompt_edit(|_, cpos| *cpos = 0);
            }
            KeyCode::End => {
                self.prompt_edit(|d, cpos| *cpos = d.chars().count());
            }
            _ => {}
        }
        AppKeyResult::Continue
    }

    fn prompt_edit<F: FnOnce(&mut String, &mut usize)>(&mut self, f: F) {
        if let Some(Screen::Prompt { draft, cursor, .. }) = self.screens.last_mut() {
            f(draft, cursor);
        }
    }

    fn prompt_submit(&mut self, flow: FlowKind, text: &str) {
        match flow {
            FlowKind::Search => self.run_search(text),
            FlowKind::Register => self.register_advance_prompt(text),
            FlowKind::GcIso => self.gc_iso_submit(text),
            FlowKind::DeliverPane => self.deliver_pane_submit(text),
            FlowKind::DeliverNote => self.deliver_note_submit(text),
            FlowKind::DeliverKind => {}
        }
    }

    fn handle_select_key(&mut self, ev: &KeyEvent) -> AppKeyResult {
        let Some(Screen::Select {
            flow,
            options,
            cursor,
        }) = self.screens.last_mut()
        else {
            return AppKeyResult::Continue;
        };
        let n = options.len();
        match ev_key(ev) {
            Some(Key::Up) | Some(Key::Char('k')) => {
                if n > 0 {
                    *cursor = (*cursor + n - 1) % n;
                }
            }
            Some(Key::Down) | Some(Key::Char('j')) => {
                if n > 0 {
                    *cursor = (*cursor + 1) % n;
                }
            }
            Some(Key::PageUp) => {
                if n > 0 {
                    *cursor = cursor.saturating_sub(10);
                }
            }
            Some(Key::PageDown) => {
                if n > 0 {
                    *cursor = (*cursor + 10).min(n - 1);
                }
            }
            Some(Key::Home) => *cursor = 0,
            Some(Key::End) => *cursor = n.saturating_sub(1),
            Some(Key::Enter) => {
                let value = options.get(*cursor).map(|o| o.value.clone());
                let flow = *flow;
                self.pop();
                if let Some(v) = value {
                    match flow {
                        FlowKind::Register => self.register_advance_select(&v),
                        FlowKind::DeliverKind => self.deliver_select_kind(&v),
                        _ => {}
                    }
                }
            }
            Some(Key::Esc) | Some(Key::Char('q')) => {
                self.pop();
            }
            _ => {}
        }
        AppKeyResult::Continue
    }

    fn handle_confirm_key(&mut self, ev: &KeyEvent) -> AppKeyResult {
        // Extract fields without moving the action out until resolved.
        enum ConfirmKey {
            Cancel,
            Confirm,
            Toggle,
            Ignore,
        }
        let Some(Screen::Confirm {
            focus_confirm,
            danger: _,
            ..
        }) = self.screens.last_mut()
        else {
            return AppKeyResult::Continue;
        };
        let key = match ev_key(ev) {
            Some(Key::Esc) => ConfirmKey::Cancel,
            Some(Key::Char('n')) | Some(Key::Char('q')) => ConfirmKey::Cancel,
            Some(Key::Char('y')) => ConfirmKey::Confirm,
            Some(Key::Tab)
            | Some(Key::Left)
            | Some(Key::Right)
            | Some(Key::Char('h'))
            | Some(Key::Char('l')) => ConfirmKey::Toggle,
            Some(Key::Enter) | Some(Key::Char(' ')) => {
                if *focus_confirm {
                    ConfirmKey::Confirm
                } else {
                    ConfirmKey::Cancel
                }
            }
            _ => ConfirmKey::Ignore,
        };
        match key {
            ConfirmKey::Ignore => AppKeyResult::Continue,
            ConfirmKey::Toggle => {
                if let Some(Screen::Confirm { focus_confirm, .. }) = self.screens.last_mut() {
                    *focus_confirm = !*focus_confirm;
                }
                AppKeyResult::Continue
            }
            ConfirmKey::Cancel => {
                self.confirm_cancel();
                AppKeyResult::Continue
            }
            ConfirmKey::Confirm => {
                // Pop and take the action.
                let action = match self.screens.pop() {
                    Some(Screen::Confirm { action, .. }) => action,
                    _ => return AppKeyResult::Continue,
                };
                self.confirm_accept(action);
                AppKeyResult::Continue
            }
        }
    }
}

/// Inject the freshly revalidated record into a resumed mutation flow.
fn inject_fresh(action: &mut ConfirmAction, fresh: &ArtifactView) {
    match action {
        ConfirmAction::Delete(f) => {
            f.fresh = Some(fresh.clone());
            f.validated = true;
        }
        ConfirmAction::DeliverSend(f) => {
            f.fresh = Some(fresh.clone());
            f.validated = true;
        }
        _ => {}
    }
}

enum AppKeyResult {
    Continue,
    Exit,
}

/// Unified key representation.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Key {
    Char(char),
    Up,
    Down,
    Left,
    Right,
    PageUp,
    PageDown,
    Home,
    End,
    Enter,
    Esc,
    Backspace,
    Delete,
    Tab,
    Space,
}

fn ev_key(ev: &KeyEvent) -> Option<Key> {
    if ev.kind != KeyEventKind::Press {
        return None;
    }
    Some(match ev.code {
        KeyCode::Char(' ') => Key::Space,
        KeyCode::Char(c) => Key::Char(c),
        KeyCode::Up => Key::Up,
        KeyCode::Down => Key::Down,
        KeyCode::Left => Key::Left,
        KeyCode::Right => Key::Right,
        KeyCode::PageUp => Key::PageUp,
        KeyCode::PageDown => Key::PageDown,
        KeyCode::Home => Key::Home,
        KeyCode::End => Key::End,
        KeyCode::Enter => Key::Enter,
        KeyCode::Esc => Key::Esc,
        KeyCode::Backspace => Key::Backspace,
        KeyCode::Delete => Key::Delete,
        KeyCode::Tab => Key::Tab,
        _ => return None,
    })
}

// Helper to read prompt fields without cloning the whole screen.
trait PromptClone {
    fn cloned_prompt(&self) -> Option<(FlowKind, String, usize, String, String)>;
}
impl PromptClone for Screen {
    fn cloned_prompt(&self) -> Option<(FlowKind, String, usize, String, String)> {
        if let Screen::Prompt {
            flow,
            draft,
            cursor,
            label,
            placeholder,
        } = self
        {
            Some((*flow, draft.clone(), *cursor, label.clone(), placeholder.clone()))
        } else {
            None
        }
    }
}

// --- openExternal port (packages/tui safety.ts §openExternal) ---------------------

/// Open `target` with the OS handler — ALWAYS an explicit user action.
/// `target` must be an http(s)/mailto URL or an absolute filesystem
/// path. argv-array spawn, scrubbed minimal env, 10s timeout.
fn open_external_path(target: &str) -> Result<(), &'static str> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("invalid-target");
    }
    let is_url = trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("mailto:");
    let is_path = !is_url && std::path::Path::new(trimmed).is_absolute();
    if !is_url && !is_path {
        return Err("invalid-target");
    }
    let platform = std::env::consts::OS;
    let argv: Vec<String> = if platform == "macos" {
        vec!["open".to_string(), trimmed.to_string()]
    } else if platform == "windows" {
        vec![
            "cmd.exe".to_string(),
            "/c".to_string(),
            "start".to_string(),
            "".to_string(),
            trimmed.to_string(),
        ]
    } else {
        vec!["xdg-open".to_string(), trimmed.to_string()]
    };

    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("USER", std::env::var("USER").unwrap_or_default())
        .env("LOGNAME", std::env::var("LOGNAME").unwrap_or_default())
        .env(
            "LANG",
            std::env::var("LANG").unwrap_or_else(|_| "C.UTF-8".to_string()),
        )
        .env("TMPDIR", std::env::var("TMPDIR").unwrap_or_default());
    if platform == "windows" {
        cmd.env("SystemRoot", std::env::var("SystemRoot").unwrap_or_default());
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|_| "spawn-failed")?;
    let deadline = Instant::now() + Duration::from_millis(10_000);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("timeout");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return Err("spawn-failed"),
        }
    }
}

// --- rendering ---------------------------------------------------------------------

/// Clip `s` to at most `width` display cells.
fn clip(s: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut w = 0usize;
    for c in s.chars() {
        let cw = unicode_width::UnicodeWidthChar::width(c).unwrap_or(0);
        if w + cw > width {
            break;
        }
        out.push(c);
        w += cw;
    }
    out
}

/// Pad `s` with spaces to `width` display cells (truncate first).
fn pad(s: &str, width: usize) -> String {
    let c = clip(s, width);
    let used = UnicodeWidthStr::width(c.as_str());
    if used >= width {
        c
    } else {
        format!("{}{}", c, " ".repeat(width - used))
    }
}

/// Split text into chunks of at most `width` chars (TS wraps by string
/// slice — char-granular, matching the source view).
fn wrap_chars(s: &str, width: usize) -> Vec<String> {
    let w = width.max(1);
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    for chunk in chars.chunks(w) {
        out.push(chunk.iter().collect());
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

fn dim_line(s: &str) -> Line<'static> {
    Line::from(Span::styled(
        sanitize_display(s),
        Style::default().fg(Color::DarkGray),
    ))
}

fn render_main(app: &mut App, area: Rect) -> Vec<Line<'static>> {
    let width = area.width as usize;
    let height = area.height as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();

    // Header: search banner or index meta (max 3 dim lines) + status.
    let mut header: Vec<String> = Vec::new();
    if let Some(q) = &app.search_query {
        header.push(format!("search \"{}\"", q));
    }
    for m in app.meta_lines.iter().take(3) {
        header.push(m.clone());
    }
    if !app.status.is_empty() {
        header.push(app.status.clone());
    }
    for h in header.iter().take(4) {
        lines.push(dim_line(h));
    }

    let body_h = height.saturating_sub(lines.len() + 1).max(1);

    // Filter row.
    if app.filter_mode {
        lines.push(Line::from(vec![
            Span::raw("/"),
            Span::raw(sanitize_display(&app.filter_draft)),
            Span::styled("█", Style::default().fg(Color::Yellow)),
        ]));
    } else if !app.committed_filter.is_empty() {
        lines.push(dim_line(&format!("filter: {}", app.committed_filter)));
    }

    let list_h = body_h.saturating_sub(if app.filter_mode || !app.committed_filter.is_empty() { 1 } else { 0 });
    let filtered = app.filtered_indices();
    let n = filtered.len();
    app.clamp_cursor();
    // Keep cursor visible.
    if app.cursor < app.scroll_top {
        app.scroll_top = app.cursor;
    } else if app.cursor >= app.scroll_top + list_h {
        app.scroll_top = app.cursor + 1 - list_h;
    }
    app.scroll_top = app.scroll_top.min(n.saturating_sub(1));

    let detail_pane = width >= 60;
    let list_w = if detail_pane { width * 3 / 5 } else { width };
    let selected_idx = filtered.get(app.cursor).copied();

    // Left column texts: (text, is_cursor).
    let mut left: Vec<(String, bool)> = Vec::new();
    if n == 0 {
        left.push((
            match app.phase {
                Phase::Loading => "loading…".to_string(),
                Phase::Error => "failed to load — R to retry".to_string(),
                _ => "registry empty — n register an artifact".to_string(),
            },
            false,
        ));
    } else {
        for (row, &item_idx) in filtered.iter().enumerate().skip(app.scroll_top).take(list_h) {
            let item = &app.items[item_idx];
            let cursor = row == app.cursor;
            let label = clip(&sanitize_display(&item.label), list_w.saturating_sub(2));
            left.push((
                if cursor {
                    format!("❯ {}", label)
                } else {
                    format!("  {}", label)
                },
                cursor,
            ));
        }
    }
    // Truncation footer row.
    let visible = left.len();
    if n > visible {
        left.push((format!("{} / {}", visible, n), false));
    }

    // Right column: selected item's detail block (detail pane only).
    let pane_texts: Vec<String> = if detail_pane {
        selected_idx
            .and_then(|idx| app.items.get(idx))
            .map(|item| {
                item.detail
                    .lines()
                    .map(|l| clip(l, width - list_w - 1))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let rows_n = left.len().max(pane_texts.len());
    for i in 0..rows_n {
        let (ltext, is_cur) = left.get(i).cloned().unwrap_or_default();
        let mut spans: Vec<Span<'static>> = vec![Span::styled(
            sanitize_display(&ltext),
            if is_cur {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default()
            },
        )];
        if detail_pane {
            let pad_cells = list_w.saturating_sub(UnicodeWidthStr::width(ltext.as_str()));
            spans.push(Span::raw(" ".repeat(pad_cells)));
            if let Some(p) = pane_texts.get(i) {
                spans.push(Span::styled(
                    sanitize_display(p),
                    Style::default().fg(Color::DarkGray),
                ));
            }
        }
        lines.push(Line::from(spans));
    }

    // Fill to height and append status footer.
    while lines.len() < height.saturating_sub(1) {
        lines.push(Line::from(""));
    }
    lines.push(dim_line(&format!(" {}", pad(&app.status, width.saturating_sub(1)))));
    lines.truncate(height.max(1));
    lines
}

fn render_detail(app: &App, area: Rect) -> Vec<Line<'static>> {
    let width = area.width as usize;
    let height = area.height as usize;
    let Some(Screen::Detail {
        artifact,
        phase,
        error,
        scroll,
        ..
    }) = app.screens.last()
    else {
        return Vec::new();
    };
    let mut out: Vec<Line<'static>> = Vec::new();
    match phase {
        Phase::Loading => out.push(dim_line("loading…")),
        Phase::Missing => out.push(dim_line(
            "artifact not found — it may have been deleted; go back and refresh",
        )),
        Phase::Error => out.push(Line::from(Span::styled(
            sanitize_display(error),
            Style::default().fg(Color::Red),
        ))),
        Phase::Ready => {
            let Some(a) = artifact else {
                out.push(dim_line("loading…"));
                return out;
            };
            let header = artifact_header_lines(a);
            let mut flat: Vec<String> = Vec::new();
            for h in &header {
                for chunk in wrap_chars(h, width.saturating_sub(1).max(1)) {
                    flat.push(chunk);
                }
            }
            let max_scroll = flat.len().saturating_sub(height.saturating_sub(1));
            let sc = (*scroll).min(max_scroll);
            for (i, l) in flat.iter().enumerate().skip(sc).take(height.saturating_sub(1)) {
                let style = if i == 0 {
                    Style::default().add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                };
                out.push(Line::from(Span::styled(sanitize_display(l), style)));
            }
            // position footer
            let pos = format!("{}/{}", sc + 1, flat.len().max(1));
            out.push(Line::from(Span::styled(
                format!("{}{}", " ".repeat(width.saturating_sub(pos.len())), pos),
                Style::default().fg(Color::DarkGray),
            )));
        }
    }
    out.truncate(height.max(1));
    out
}

fn render_prompt(app: &App, area: Rect) -> Vec<Line<'static>> {
    let width = area.width as usize;
    let height = area.height as usize;
    let Some(Screen::Prompt {
        label,
        draft,
        cursor,
        placeholder,
        ..
    }) = app.screens.last()
    else {
        return Vec::new();
    };
    let mut out: Vec<Line<'static>> = Vec::new();
    out.push(Line::from(Span::styled(
        sanitize_display(label),
        Style::default().add_modifier(Modifier::BOLD),
    )));
    // Input line: "> draft█" with block cursor.
    let chars: Vec<char> = draft.chars().collect();
    let cpos = (*cursor).min(chars.len());
    let before: String = chars[..cpos].iter().collect();
    let cur = chars.get(cpos).copied().unwrap_or(' ');
    let after: String = chars[cpos + 1..].iter().collect();
    let avail = width.saturating_sub(4).max(1);
    let mut head = clip(&before, avail);
    let mut tail_budget = avail.saturating_sub(UnicodeWidthStr::width(head.as_str()) + 1);
    let mut tail = clip(&after, tail_budget);
    if UnicodeWidthStr::width(head.as_str()) + 1 + UnicodeWidthStr::width(tail.as_str()) > avail {
        head = String::new();
        tail_budget = avail.saturating_sub(1);
        tail = clip(&after, tail_budget);
    }
    let mut spans = vec![Span::raw("> "), Span::raw(sanitize_display(&head))];
    if draft.is_empty() && !placeholder.is_empty() {
        spans.push(Span::styled(
            sanitize_display(placeholder),
            Style::default().fg(Color::DarkGray),
        ));
        spans.push(Span::styled(" ", Style::default().add_modifier(Modifier::REVERSED)));
    } else {
        spans.push(Span::styled(
            cur.to_string(),
            Style::default().add_modifier(Modifier::REVERSED),
        ));
        if !tail.is_empty() {
            spans.push(Span::raw(sanitize_display(&tail)));
        }
    }
    out.push(Line::from(spans));
    out.push(dim_line("Enter — submit · Esc — cancel"));
    while out.len() < height {
        out.push(Line::from(""));
    }
    out.truncate(height.max(1));
    out
}

fn render_select(app: &App, area: Rect) -> Vec<Line<'static>> {
    let width = area.width as usize;
    let height = area.height as usize;
    let Some(Screen::Select {
        options, cursor, ..
    }) = app.screens.last()
    else {
        return Vec::new();
    };
    let mut out: Vec<Line<'static>> = Vec::new();
    for (i, opt) in options.iter().enumerate() {
        let sel = i == *cursor;
        let label = clip(&sanitize_display(&opt.label), width.saturating_sub(2));
        let text = if sel {
            format!("❯ {}", label)
        } else {
            format!("  {}", label)
        };
        out.push(Line::from(Span::styled(
            text,
            if sel {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default()
            },
        )));
        if sel {
            if let Some(d) = &opt.detail {
                for dl in d.lines() {
                    out.push(dim_line(&format!("    {}", clip(dl, width.saturating_sub(4)))));
                }
            }
        }
    }
    out.push(dim_line("↑/↓ move · Enter select · Esc cancel"));
    while out.len() < height {
        out.push(Line::from(""));
    }
    out.truncate(height.max(1));
    out
}

fn render_confirm(app: &App, area: Rect) -> Vec<Line<'static>> {
    let width = area.width as usize;
    let height = area.height as usize;
    let Some(Screen::Confirm {
        title,
        target_lines,
        consequence,
        confirm_label,
        cancel_label,
        danger,
        focus_confirm,
        ..
    }) = app.screens.last()
    else {
        return Vec::new();
    };
    let mut out: Vec<Line<'static>> = Vec::new();
    // Centered box.
    let box_w = width.saturating_sub(4).min(72).max(20);
    let box_h = (target_lines.len() + 8).min(height.saturating_sub(2)).max(6);
    let top = height.saturating_sub(box_h) / 2;
    let left = width.saturating_sub(box_w) / 2;
    let mut canvas = vec![vec![' '; width]; height];
    let mut put = |r: usize, c: usize, s: &str| {
        if r < height && c < width {
            for (i, ch) in s.chars().enumerate() {
                if c + i < width {
                    canvas[r][c + i] = ch;
                }
            }
        }
    };
    // border
    for r in top..top + box_h {
        for c in left..left + box_w {
            canvas[r][c] = ' ';
        }
    }
    put(top, left + 1, &format!("─ {} {}", if *danger { "⚠" } else { "" }, sanitize_display(title)));
    put(top + 1, left + 2, "");
    let mut row = top + 2;
    for l in target_lines.iter().take(box_h.saturating_sub(7)) {
        put(row, left + 2, &sanitize_display(l));
        row += 1;
    }
    row += 1;
    for cl in wrap_chars(consequence, box_w.saturating_sub(4)) {
        if row >= top + box_h - 3 {
            break;
        }
        put(row, left + 2, &sanitize_display(&cl));
        row += 1;
    }
    // buttons
    let btn_row = top + box_h - 2;
    let confirm_text = format!("[ {} ]", confirm_label);
    let cancel_text = format!("[ {} ]", cancel_label);
    let gap = 2usize;
    let total = confirm_text.chars().count() + gap + cancel_text.chars().count();
    let start = left + box_w.saturating_sub(total) / 2;
    let (cf, cc) = if *focus_confirm { (confirm_text, cancel_text) } else { (cancel_text.clone(), confirm_text.clone()) };
    // Render focused button inverted via spans later; plain text here.
    put(btn_row, start, &cf);
    put(btn_row, start + confirm_text.chars().count() + gap, &cc);
    // hints
    put(top + box_h - 1, left + 2, "Tab/←/→ switch · Enter activate · y/n · Esc cancel");

    // Convert canvas rows to Lines; apply inverse on focused button.
    for r in 0..height {
        let text: String = canvas[r].iter().collect();
        let trimmed = text.trim_end();
        if r == btn_row {
            // Rebuild spans for inverse focus.
            let mut spans: Vec<Span<'static>> = Vec::new();
            let chars: Vec<char> = trimmed.chars().collect();
            let mut i = 0usize;
            while i < chars.len() {
                // find button regions
                let rest: String = chars[i..].iter().collect();
                if rest.starts_with(&format!("[ {} ]", confirm_label)) {
                    let s = format!("[ {} ]", confirm_label);
                    spans.push(Span::styled(
                        s.clone(),
                        if *focus_confirm {
                            Style::default().add_modifier(Modifier::REVERSED)
                        } else {
                            Style::default()
                        },
                    ));
                    i += s.chars().count();
                } else if rest.starts_with(&format!("[ {} ]", cancel_label)) {
                    let s = format!("[ {} ]", cancel_label);
                    spans.push(Span::styled(
                        s.clone(),
                        if !*focus_confirm {
                            Style::default().add_modifier(Modifier::REVERSED)
                        } else {
                            Style::default()
                        },
                    ));
                    i += s.chars().count();
                } else {
                    let ch = chars[i];
                    spans.push(Span::raw(ch.to_string()));
                    i += 1;
                }
            }
            out.push(Line::from(spans));
        } else {
            out.push(Line::from(sanitize_display(trimmed)));
        }
    }
    out.truncate(height.max(1));
    out
}

fn render_scroll_detail(app: &App, area: Rect) -> Vec<Line<'static>> {
    let width = area.width as usize;
    let height = area.height as usize;
    let Some(Screen::ScrollDetail {
        title,
        lines: content,
        scroll,
    }) = app.screens.last()
    else {
        return Vec::new();
    };
    let mut out: Vec<Line<'static>> = Vec::new();
    out.push(Line::from(Span::styled(
        sanitize_display(title),
        Style::default().add_modifier(Modifier::BOLD),
    )));
    out.push(dim_line(&"─".repeat(width)));
    let avail = height.saturating_sub(3).max(1);
    let max_scroll = content.len().saturating_sub(avail);
    let sc = (*scroll).min(max_scroll);
    for l in content.iter().skip(sc).take(avail) {
        for chunk in wrap_chars(l, width.saturating_sub(1).max(1)) {
            out.push(dim_line(&chunk));
        }
    }
    // Fill
    while out.len() < height.saturating_sub(1) {
        out.push(Line::from(""));
    }
    let pos = format!("{}/{}", sc + 1, content.len().max(1));
    out.push(Line::from(Span::styled(
        format!("{}{}", " ".repeat(width.saturating_sub(pos.len())), pos),
        Style::default().fg(Color::DarkGray),
    )));
    out.truncate(height.max(1));
    out
}

fn render_help(app: &App, area: Rect) -> Vec<Line<'static>> {
    let width = area.width as usize;
    let height = area.height as usize;
    let mut out: Vec<Line<'static>> = Vec::new();
    out.push(Line::from(Span::styled(
        "keys".to_string(),
        Style::default().add_modifier(Modifier::BOLD),
    )));
    let bindings: &[(&str, &str)] = &[
        ("↑/↓ j/k", "move"),
        ("PgUp/PgDn", "page"),
        ("/", "filter list"),
        ("Enter", "open detail / select"),
        ("s", "search"),
        ("n", "register artifact"),
        ("v", "verify all"),
        ("g", "gc (dry-run first)"),
        ("R/r", "refresh"),
        ("d", "delete (detail)"),
        ("l", "deliver (detail)"),
        ("o", "open externally (detail)"),
        ("Esc/q", "back / close"),
        ("Ctrl-C ×2", "exit"),
    ];
    for (keys, desc) in bindings {
        let text = format!("  {:<14} {}", keys, desc);
        out.push(dim_line(&clip(&text, width)));
    }
    let _ = app;
    while out.len() < height {
        out.push(Line::from(""));
    }
    out.truncate(height.max(1));
    out
}

fn render(app: &mut App, frame: &mut ratatui::Frame) {
    let area = frame.area();
    let lines = match app.screens.last() {
        Some(Screen::Main) => render_main(app, area),
        Some(Screen::Detail { .. }) => render_detail(app, area),
        Some(Screen::Prompt { .. }) => render_prompt(app, area),
        Some(Screen::Select { .. }) => render_select(app, area),
        Some(Screen::Confirm { .. }) => render_confirm(app, area),
        Some(Screen::ScrollDetail { .. }) => render_scroll_detail(app, area),
        Some(Screen::Help) => render_help(app, area),
        None => Vec::new(),
    };
    frame.render_widget(Paragraph::new(lines), area);
}

// --- main entry -----------------------------------------------------------------------

fn run_main() -> i32 {
    let ctx = resolve_pinned_target();

    // Capability document for mutation gating (fail-closed when absent).
    let capability = run_artifacts_cli(&["capability".to_string()]).ok();

    // Non-TTY stdin → honest plain-text list.
    if !io::stdin().is_terminal() {
        return render_plain_list();
    }

    let mut app = App::new(ctx, capability);
    app.load_list();

    if crossterm::terminal::enable_raw_mode().is_err() {
        eprintln!("artifacts tui failed: could not enable raw mode");
        return 1;
    }
    let _ = crossterm::execute!(io::stdout(), crossterm::terminal::EnterAlternateScreen);

    let backend = ratatui::backend::CrosstermBackend::new(io::stdout());
    let mut terminal = match Terminal::new(backend) {
        Ok(t) => t,
        Err(err) => {
            let _ = crossterm::execute!(io::stdout(), crossterm::terminal::LeaveAlternateScreen);
            crossterm::terminal::disable_raw_mode().ok();
            eprintln!("artifacts tui failed: {}", err);
            return 1;
        }
    };

    let result = (|| -> io::Result<()> {
        loop {
            terminal.draw(|frame| render(&mut app, frame))?;
            if event::poll(Duration::from_millis(100))? {
                if let Event::Key(key) = event::read()? {
                    if key.kind == KeyEventKind::Press {
                        match app.handle_key(&key) {
                            AppKeyResult::Exit => break,
                            AppKeyResult::Continue => {}
                        }
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
            let _ = writeln!(io::stderr(), "artifacts TUI closed");
            0
        }
        Err(err) => {
            eprintln!("artifacts tui failed: {}", err);
            1
        }
    }
}
