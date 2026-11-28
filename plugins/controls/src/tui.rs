//! rebuildup.controls interactive TUI — `herdr-plugins.tui/v1`
//! (ADR-0031/0032/0033, contract docs/contracts/tui-v1.md). Rust port of
//! `plugins/controls/src/tui.ts` + `tui-support.ts` + `tui-views.ts`
//! (Issue #324).
//!
//! Modes:
//!   `controls tui open`  `open` action helper: pins the origin context
//!                        and calls `plugin.pane.open` (placement "tab"),
//!                        then exits promptly.
//!   `controls tui main`  pane entrypoint (`[[panes]] id="main"`): the
//!                        interactive agent browser (default).
//!
//! Safety-contract mapping (ADR-0033 §3 / tui-v1 §5):
//! - read-only open: the list/detail loads run `session.snapshot` /
//!   `agent.get` reads only — no lazy mutation ever fires on open.
//! - explicit target: every operation names the pane/agent resolved
//!   from the pinned context or in-UI selection.
//! - stale generation: the detail view re-reads `agent.get` and aborts
//!   locally on generation drift; the CLI core enforces
//!   `--expect-pane / --expect-state-seq / --expect-agent-session` →
//!   `stale_generation` before any `agent.*` mutation — the same
//!   `herdr-plugins.controls/v1` surface CLI/MCP/GUI consumers use.
//! - mutation gating: `mutationAllowed` against the `capability`
//!   document; denied ops render disabled-with-reason or refuse with
//!   the reason in the status line.
//! - irreversible confirmation: every mutation shows exact target +
//!   consequence; Esc cancels.
//! - honest unsupported: socket/CLI failures render their real
//!   `kind: message`, never a fabricated success.
//!
//! Unlike the TS implementation (which spawned `src/cli.ts` per op),
//! mutations run the CLI domain cores IN-PROCESS via `cli::run_args` —
//! same argv → same payload/failure, no self-respawn (ADR-0036 pattern,
//! same as the inbox port). The per-op timeout the TS subprocess killer
//! enforced is forwarded as the CLI `--timeout` request timeout.

use std::io::{self, IsTerminal, Write};
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Terminal;
use serde_json::{json, Value};

use hoxay_tui::safety::{bound_text, sanitize_display};

use crate::capability::KNOWN_AGENT_KINDS;
use crate::cli::{self, CliFailure, PLUGIN_VERSION};
use crate::commands::provider_commands_pub;
use crate::launch::{build_launch_args, canonical_kind, launch_capability, LaunchRequest, PERMISSION_MODES};
use crate::tui_model::{self, PinnedAgent, PinnedTarget, SessionAgents};

// --- in-process CLI bridge -------------------------------------------------------

/// Run one controls CLI invocation in-process — the same argv the TS
/// TUI passed to its `src/cli.ts` subprocess. `timeout_ms` becomes the
/// CLI `--timeout` request timeout (the TS subprocess kill timer's
/// honest in-process equivalent).
fn run_cli(args: &[String], timeout_ms: u64) -> Result<Value, CliFailure> {
    let mut argv: Vec<String> = args.to_vec();
    argv.push("--timeout".to_string());
    argv.push(timeout_ms.to_string());
    cli::run_args(&argv)
}

fn payload_str<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(|v| v.as_str())
}

// --- app state ------------------------------------------------------------------------

#[derive(Clone, PartialEq)]
enum Phase {
    Loading,
    Ready,
    Error(String),
    Missing,
}

enum Screen {
    /// Agent list (root view).
    Main,
    /// Agent detail for `pane_id`.
    Detail { pane_id: String },
    /// Bounded scrollback read result.
    Scrollback {
        title: String,
        lines: Vec<String>,
        scroll: usize,
    },
    /// Free-text prompt.
    Prompt {
        kind: PromptKind,
        draft: String,
        placeholder: String,
        label: String,
    },
    /// Option picker.
    Select {
        purpose: SelectPurpose,
        items: Vec<tui_model::Choice>,
        /// Index into the VISIBLE (filtered) list — TS SelectList
        /// cursor semantics.
        cursor: usize,
        /// `/` filter draft is being edited (swallows printable keys).
        filter_mode: bool,
        /// Committed filter text (persists after Enter, TS
        /// `committedFilter`).
        filter_draft: String,
        /// Active edit buffer while `filter_mode` (TS `filterDraft`).
        filter_edit: String,
        title: String,
    },
    /// Confirm-gated mutation.
    Confirm { mutation: PendingMutation },
    Help,
}

#[derive(Clone)]
enum PromptKind {
    /// `send` message text for a pinned agent.
    SendText { pin: PinnedAgent },
    /// `command` slash-command input for a pinned agent.
    CommandText { pin: PinnedAgent },
    /// `rename` name input (empty = clear).
    RenameName { pin: PinnedAgent, current: String },
    /// start flow: optional agent name.
    StartName,
    /// start flow: optional model.
    StartModel,
    /// start flow: optional reasoning.
    StartReasoning,
    /// start flow: --resume value.
    StartResumeValue,
}

#[derive(Clone)]
enum SelectPurpose {
    /// Post-submit wait target for `send`.
    SendWaitUntil { pin: PinnedAgent, text: String },
    /// `wait` command until-status picker.
    WaitUntil { pane_id: String },
    /// `interrupt` key picker.
    InterruptKey { pin: PinnedAgent },
    /// start flow: agent kind.
    StartKind,
    /// start flow: permission mode.
    StartPermMode,
    /// start flow: resume mode (none/value/from).
    StartResumeMode,
    /// start flow: --resume-from agent picker.
    StartResumeFrom,
    /// start flow step 1: shell pane picker.
    StartPane,
}

struct PendingMutation {
    title: String,
    target_lines: Vec<String>,
    consequence: String,
    danger: bool,
    /// Confirm-button label (TS `confirmLabel`: "Send", "Clear", ...).
    confirm_label: String,
    /// Focused button (TS ConfirmView `focusConfirm`, toggled by
    /// tab/arrows/h/l; Enter/Space activates the focused one).
    focus_confirm: bool,
    args: Vec<String>,
    ok_message: String,
    timeout_ms: u64,
}

/// In-progress `start` flow state (multi-step wizard).
#[derive(Default, Clone)]
struct StartFlow {
    pane_id: String,
    pane_cwd: Option<String>,
    kind_raw: String,
    name: String,
    model: String,
    reasoning: String,
    permission_mode: Option<String>,
    /// "none" | "value" | "from"
    resume_mode: String,
    resume_value: Option<String>,
    resume_from_pane: Option<String>,
}

struct DetailState {
    agent: Option<Value>,
    pin: Option<PinnedAgent>,
    phase: Phase,
    error: String,
    scroll: usize,
}

struct App {
    target: PinnedTarget,
    capability: Option<Value>,
    screen: Screen,
    status: String,
    // list state
    session: Option<SessionAgents>,
    list_phase: Phase,
    list_error: String,
    cursor: usize,
    scroll_top: usize,
    filter_mode: bool,
    filter_draft: String,
    // detail state (active while Screen::Detail)
    detail: Option<DetailState>,
    // start flow wizard state
    start: Option<StartFlow>,
}

impl App {
    fn new(target: PinnedTarget, capability: Option<Value>) -> Self {
        App {
            target,
            capability,
            screen: Screen::Main,
            status: String::new(),
            session: None,
            list_phase: Phase::Loading,
            list_error: String::new(),
            cursor: 0,
            scroll_top: 0,
            filter_mode: false,
            filter_draft: String::new(),
            detail: None,
            start: None,
        }
    }

    // --- list -------------------------------------------------------------------

    fn list_items(&self) -> Vec<tui_model::SelectItem> {
        let Some(session) = &self.session else {
            return Vec::new();
        };
        session
            .panes
            .iter()
            .filter_map(|pane| {
                session
                    .agents
                    .get(&pane.pane_id)
                    .map(|agent| tui_model::agent_select_item(pane, agent))
            })
            .filter(|item| {
                // The filter draft persists after Enter (TS SelectList
                // query semantics); empty draft shows everything.
                item.label
                    .to_lowercase()
                    .contains(&self.filter_draft.to_lowercase())
            })
            .collect()
    }

    fn load_list(&mut self) {
        self.list_phase = Phase::Loading;
        match tui_model::read_session_agents() {
            Err(e) => {
                self.list_phase = Phase::Error(e);
                self.status = "list failed — R to retry".to_string();
            }
            Ok(session) => {
                self.session = Some(session);
                self.list_phase = Phase::Ready;
                self.list_error.clear();
                self.clamp_list_cursor();
            }
        }
    }

    fn clamp_list_cursor(&mut self) {
        let n = self.list_items().len();
        if self.cursor >= n {
            self.cursor = n.saturating_sub(1);
        }
        if self.scroll_top > n.saturating_sub(1) {
            self.scroll_top = n.saturating_sub(1);
        }
    }

    fn current_agent_item(&self) -> Option<tui_model::SelectItem> {
        self.list_items().get(self.cursor).cloned()
    }

    // --- detail -------------------------------------------------------------------

    fn open_detail(&mut self, pane_id: &str) {
        self.detail = Some(DetailState {
            agent: None,
            pin: None,
            phase: Phase::Loading,
            error: String::new(),
            scroll: 0,
        });
        self.screen = Screen::Detail {
            pane_id: pane_id.to_string(),
        };
        self.load_detail();
    }

    fn load_detail(&mut self) {
        let Screen::Detail { pane_id } = &self.screen else {
            return;
        };
        let pane_id = pane_id.clone();
        let Some(detail) = &mut self.detail else {
            return;
        };
        detail.phase = Phase::Loading;
        match tui_model::read_agent(&pane_id) {
            Ok(agent) => {
                let pin = tui_model::pin_agent(&agent);
                detail.agent = Some(agent);
                detail.pin = Some(pin);
                detail.phase = Phase::Ready;
                detail.error.clear();
            }
            Err(err) => {
                let kind = err.rpc_code().unwrap_or("");
                if kind == "agent_not_found" || kind == "pane_not_found" {
                    detail.phase = Phase::Missing;
                } else {
                    detail.phase = Phase::Error(tui_model::agent_error_message(&err));
                }
            }
        }
    }

    /// Stale-generation gate (tui-v1 §3.3): re-read `agent.get` before a
    /// mutation and compare the pinned signals. Drift aborts with an
    /// honest stale status (TS `revalidate` returns null); the CLI's
    /// `--expect-*` flags are the second enforcement layer inside the
    /// domain call. Works while a Confirm screen is up — the pin lives
    /// on `detail`, not the screen.
    fn revalidate(&mut self) -> Option<PinnedAgent> {
        let pin = self.detail.as_ref().and_then(|d| d.pin.clone())?;
        match tui_model::read_agent(&pin.pane_id) {
            Err(err) => {
                self.status = format!("revalidate failed: {}", tui_model::agent_error_message(&err));
                None
            }
            Ok(fresh) => match tui_model::revalidate(&pin, &fresh) {
                tui_model::Revalidate::Ok => Some(pin),
                tui_model::Revalidate::Drift { message, pin: next } => {
                    self.status = message;
                    if let Some(detail) = &mut self.detail {
                        detail.agent = Some(fresh);
                        detail.pin = Some(next);
                    }
                    None
                }
                tui_model::Revalidate::Failed(_) => None,
            },
        }
    }

    // --- mutation gate ---------------------------------------------------------------

    fn gate(&mut self, command: &str) -> bool {
        let gate = tui_model::mutation_allowed(self.capability.as_ref(), command);
        if !gate.allowed {
            self.status = format!(
                "mutations disabled: {}",
                gate.reason.unwrap_or_else(|| command.to_string())
            );
            return false;
        }
        true
    }

    /// Run a CLI op; returns the payload or reports the failure status.
    fn run_op(&mut self, label: &str, args: &[String], timeout_ms: u64) -> Option<Value> {
        self.status = format!("running: {}…", label);
        match run_cli(args, timeout_ms) {
            Ok(payload) => Some(payload),
            Err(f) => {
                self.status = format!("{} failed: {}", label, tui_model::cli_error_message(&f));
                None
            }
        }
    }

    /// Shared tail for agent mutations (TS `mutate`): revalidate the
    /// pinned generation, then show the confirm screen. Drift/failure
    /// aborts back to the detail view with the honest status.
    fn confirm_or_stale(&mut self, mutation: PendingMutation, pane_id: &str) {
        if self.revalidate().is_none() {
            self.screen = Screen::Detail {
                pane_id: pane_id.to_string(),
            };
            return;
        }
        self.screen = Screen::Confirm { mutation };
    }

    fn detail_target_lines(&self) -> Vec<String> {
        // pane id comes from the pinned agent (the screen may already
        // have moved on to Main/Select while the mutation is staged).
        let pane_id = self
            .detail
            .as_ref()
            .and_then(|d| d.pin.as_ref())
            .map(|p| p.pane_id.clone())
            .or_else(|| match &self.screen {
                Screen::Detail { pane_id } => Some(pane_id.clone()),
                _ => None,
            })
            .unwrap_or_default();
        let agent_kind = self
            .detail
            .as_ref()
            .and_then(|d| d.agent.as_ref())
            .and_then(|a| a.get("agent"))
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        let status = self
            .detail
            .as_ref()
            .and_then(|d| d.agent.as_ref())
            .and_then(|a| a.get("agent_status"))
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        vec![
            format!("pane: {}", pane_id),
            format!("agent: {} · status: {}", agent_kind, status),
            format!("session: {}", tui_model::format_target_label(&self.target)),
        ]
    }

    fn run_confirmed(&mut self, mutation: PendingMutation) {
        // Second revalidation after the user dwelt on the confirm
        // dialog (TS `mutate` tail). Agent-targeted commands only —
        // `start`/`__focus__` have no pinned generation.
        let agent_scoped = matches!(
            mutation.args.first().map(|s| s.as_str()),
            Some("send") | Some("command") | Some("interrupt") | Some("rename")
        );
        if agent_scoped && self.revalidate().is_none() {
            return;
        }
        let label = mutation
            .ok_message
            .split(' ')
            .next()
            .unwrap_or("op")
            .to_string();
        let Some(payload) = self.run_op(&label, &mutation.args, mutation.timeout_ms) else {
            return;
        };
        self.finish_mutation(mutation, Some(&payload));
    }

    fn finish_mutation(&mut self, mutation: PendingMutation, payload: Option<&Value>) {
        // TS start flow reports `started <agent> on <pane>` from the
        // echoed identity; other ops report their ok_message.
        if mutation.args.first().map(|s| s.as_str()) == Some("start") {
            if let Some(payload) = payload {
                let identity = payload.get("identity").cloned().unwrap_or(Value::Null);
                let agent = identity
                    .get("agent")
                    .and_then(|v| v.as_str())
                    .unwrap_or("agent");
                let pane = identity
                    .get("pane_id")
                    .and_then(|v| v.as_str())
                    .or_else(|| mutation.args.get(1).map(|s| s.as_str()))
                    .unwrap_or("?");
                self.status = format!("started {} on {}", agent, pane);
            } else {
                self.status = mutation.ok_message.clone();
            }
        } else {
            self.status = mutation.ok_message.clone();
        }
        self.load_list();
        self.clamp_list_cursor();
    }

    // --- detail operations ---------------------------------------------------------

    fn detail_pin(&self) -> Option<PinnedAgent> {
        self.detail.as_ref().and_then(|d| d.pin.clone())
    }

    fn send_flow(&mut self) {
        // TS gates BEFORE prompting — a disabled mutation never opens
        // the text prompt.
        if !self.gate("send") {
            return;
        }
        let Some(pin) = self.detail_pin() else { return };
        self.screen = Screen::Prompt {
            kind: PromptKind::SendText { pin },
            draft: String::new(),
            placeholder: String::new(),
            label: "Message text to send (agent.prompt)".to_string(),
        };
    }

    fn command_flow(&mut self) {
        if !self.gate("command") {
            return;
        }
        let Some(pin) = self.detail_pin() else { return };
        let kind = self
            .detail
            .as_ref()
            .and_then(|d| d.agent.as_ref())
            .and_then(|a| a.get("agent"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let known = kind
            .as_deref()
            .map(provider_commands_pub)
            .unwrap_or_default();
        let hint = if !known.is_empty() {
            let first6: Vec<&str> = known.iter().take(6).copied().collect();
            format!("e.g. /{} (known: {})", known[0], first6.join(", "))
        } else {
            "e.g. /model".to_string()
        };
        self.screen = Screen::Prompt {
            kind: PromptKind::CommandText { pin },
            draft: String::new(),
            placeholder: "/command args".to_string(),
            label: format!("Slash command {}", hint),
        };
    }

    fn wait_flow(&mut self) {
        let Some(pane_id) = (match &self.screen {
            Screen::Detail { pane_id } => Some(pane_id.clone()),
            _ => None,
        }) else {
            return;
        };
        let items = [
            ("", "default (idle|done|blocked)"),
            ("idle", "idle"),
            ("working", "working"),
            ("blocked", "blocked"),
            ("done", "done"),
        ]
        .iter()
        .map(|(v, l)| tui_model::Choice::new(v, l))
        .collect();
        self.screen = Screen::Select {
            purpose: SelectPurpose::WaitUntil { pane_id },
            items,
            cursor: 0,
            filter_mode: false,
            filter_draft: String::new(),
            filter_edit: String::new(),
            title: "wait — until status".to_string(),
        };
    }

    fn interrupt_flow(&mut self) {
        if !self.gate("interrupt") {
            return;
        }
        let Some(pin) = self.detail_pin() else { return };
        let items = ["esc", "ctrl+c", "ctrl+d", "enter"]
            .iter()
            .enumerate()
            .map(|(i, k)| {
                let label = match i {
                    0 => "esc (default interrupt)",
                    _ => *k,
                };
                tui_model::Choice::new(k, label)
            })
            .collect();
        self.screen = Screen::Select {
            purpose: SelectPurpose::InterruptKey { pin },
            items,
            cursor: 0,
            filter_mode: false,
            filter_draft: String::new(),
            filter_edit: String::new(),
            title: "interrupt — PTY-level keys".to_string(),
        };
    }

    fn read_flow(&mut self) {
        let Some(pane_id) = (match &self.screen {
            Screen::Detail { pane_id } => Some(pane_id.clone()),
            _ => None,
        }) else {
            return;
        };
        let args = vec![
            "read".to_string(),
            pane_id,
            "--source".to_string(),
            "recent".to_string(),
            "--lines".to_string(),
            "200".to_string(),
        ];
        let Some(payload) = self.run_op("read", &args, 60_000) else {
            return;
        };
        let read = payload.get("read").cloned().unwrap_or(Value::Null);
        let text = read
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let truncated = read.get("truncated").and_then(|v| v.as_bool()) == Some(true);
        let lines: Vec<String> = if text.is_empty() {
            vec!["(empty scrollback)".to_string()]
        } else {
            text.lines().map(|l| l.to_string()).collect()
        };
        let title = format!(
            "scrollback {} — recent{}",
            match &self.screen {
                Screen::Detail { pane_id } => pane_id.clone(),
                _ => String::new(),
            },
            if truncated { " (truncated)" } else { "" }
        );
        self.screen = Screen::Scrollback {
            title,
            lines,
            scroll: 0,
        };
    }

    fn rename_flow(&mut self) {
        if !self.gate("rename") {
            return;
        }
        let Some(pin) = self.detail_pin() else { return };
        let current = self
            .detail
            .as_ref()
            .and_then(|d| d.agent.as_ref())
            .and_then(|a| a.get("terminal_title_stripped"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        self.screen = Screen::Prompt {
            kind: PromptKind::RenameName { pin, current: current.clone() },
            draft: current,
            placeholder: String::new(),
            label: "New agent name (empty = clear)".to_string(),
        };
    }

    fn focus_flow(&mut self) {
        let pane_id = match &self.screen {
            Screen::Detail { pane_id } => pane_id.clone(),
            _ => return,
        };
        let target_lines = self.detail_target_lines();
        self.screen = Screen::Confirm {
            mutation: PendingMutation {
                title: "Focus this agent's pane?".to_string(),
                target_lines,
                consequence: "moves herdr UI focus to the pane (pane.focus); reversible, no agent state change".to_string(),
                danger: false,
                confirm_label: "Focus".to_string(),
                focus_confirm: true,
                args: vec!["__focus__".to_string(), pane_id],
                ok_message: "focused".to_string(),
                timeout_ms: 10_000,
            },
        };
    }

    // --- start flow -----------------------------------------------------------------

    fn start_flow(&mut self) {
        if !self.gate("start") {
            return;
        }
        if self.session.is_none() {
            match tui_model::read_session_agents() {
                Ok(s) => self.session = Some(s),
                Err(_) => {
                    self.status = "cannot enumerate panes — session snapshot unavailable".to_string();
                    return;
                }
            }
        }
        let Some(session) = &self.session else { return };
        let items: Vec<tui_model::Choice> = session
            .panes
            .iter()
            .map(|pane| {
                let has_agent = session.agents.contains_key(&pane.pane_id);
                let item = tui_model::shell_pane_select_item(pane, has_agent);
                let mut c = tui_model::Choice::new(&item.value_pane_id, &item.label);
                c.detail = Some(item.detail);
                if item.disabled {
                    c = c.disabled();
                }
                c
            })
            .collect();
        if items.is_empty() {
            self.status = "no panes in session snapshot".to_string();
            return;
        }
        self.start = Some(StartFlow::default());
        self.screen = Screen::Select {
            purpose: SelectPurpose::StartPane,
            items,
            cursor: 0,
            filter_mode: false,
            filter_draft: String::new(),
            filter_edit: String::new(),
            title: "start — pick a shell pane".to_string(),
        };
    }

    fn start_kind_select(&mut self) {
        let items: Vec<tui_model::Choice> = KNOWN_AGENT_KINDS
            .iter()
            .map(|kind| {
                let launch = launch_capability(kind);
                let mut supported: Vec<&str> = Vec::new();
                if launch.get("model").and_then(|v| v.as_bool()) == Some(true) {
                    supported.push("model");
                }
                if launch.get("reasoning").and_then(|v| v.as_bool()) == Some(true) {
                    supported.push("reasoning");
                }
                let has_modes = launch
                    .get("permission_modes")
                    .and_then(|v| v.as_object())
                    .map(|m| !m.is_empty())
                    .unwrap_or(false);
                if has_modes {
                    supported.push("permission-mode");
                }
                // TS parity: `launch.resume` is always a non-empty string
                // ("unsupported" or the template), so "resume" is always
                // listed in the supported summary.
                supported.push("resume");
                let detail = format!(
                    "launch options: {}",
                    if supported.is_empty() {
                        "none mapped".to_string()
                    } else {
                        supported.join(", ")
                    }
                );
                tui_model::Choice::new(kind, kind).detail(&detail)
            })
            .collect();
        self.screen = Screen::Select {
            purpose: SelectPurpose::StartKind,
            items,
            cursor: 0,
            filter_mode: false,
            filter_draft: String::new(),
            filter_edit: String::new(),
            title: "start — pick agent kind".to_string(),
        };
    }

    fn start_perm_mode_select(&mut self) {
        let mut items = vec![tui_model::Choice::new("", "(default — no permission-mode flag)")];
        for m in PERMISSION_MODES {
            items.push(
                tui_model::Choice::new(m, m).detail("provider permission mode mapped by the launch table"),
            );
        }
        self.screen = Screen::Select {
            purpose: SelectPurpose::StartPermMode,
            items,
            cursor: 0,
            filter_mode: false,
            filter_draft: String::new(),
            filter_edit: String::new(),
            title: "start — permission mode".to_string(),
        };
    }

    fn start_resume_mode_select(&mut self) {
        let items = [
            ("none", "no resume"),
            ("value", "--resume <session value>"),
            ("from", "--resume-from <agent target>"),
        ]
        .iter()
        .map(|(v, l)| tui_model::Choice::new(v, l))
        .collect();
        self.screen = Screen::Select {
            purpose: SelectPurpose::StartResumeMode,
            items,
            cursor: 0,
            filter_mode: false,
            filter_draft: String::new(),
            filter_edit: String::new(),
            title: "start — resume".to_string(),
        };
    }

    fn start_resume_from_select(&mut self) {
        let Some(session) = &self.session else { return };
        let items: Vec<tui_model::Choice> = session
            .agents
            .keys()
            .map(|pane_id| {
                let agent = &session.agents[pane_id];
                let label = format!(
                    "{} — {} ({})",
                    pane_id,
                    agent.agent.clone().unwrap_or_else(|| "agent".to_string()),
                    agent
                        .agent_status
                        .clone()
                        .unwrap_or_else(|| "?".to_string())
                );
                tui_model::Choice::new(pane_id, &label)
            })
            .collect();
        if items.is_empty() {
            self.status = "no agents to resume from".to_string();
            self.screen = Screen::Main;
            return;
        }
        self.screen = Screen::Select {
            purpose: SelectPurpose::StartResumeFrom,
            items,
            cursor: 0,
            filter_mode: true,
            filter_draft: String::new(),
            filter_edit: String::new(),
            title: "start — resume from agent".to_string(),
        };
    }

    /// Preview argv through the same builder the CLI uses — the confirm
    /// shows the EXACT args, and builder errors surface before launch.
    /// (TS parity: the preview omits resume argv; it is shown separately
    /// in the argv line.)
    fn start_preview(&self, flow: &StartFlow) -> Result<Vec<String>, CliFailure> {
        let kind = canonical_kind(&flow.kind_raw);
        build_launch_args(&LaunchRequest {
            kind,
            model: if flow.model.is_empty() { None } else { Some(flow.model.clone()) },
            reasoning: if flow.reasoning.is_empty() {
                None
            } else {
                Some(flow.reasoning.clone())
            },
            permission_mode: flow.permission_mode.clone(),
            resume_value: None,
            resume_session_kind: None,
            extra_args: Vec::new(),
            unsafe_args: false,
        })
        .map(|b| b.args)
        .map_err(|e| {
            // ControlsError → CliFailure equivalent for status display.
            CliFailure {
                message: e.message,
                exit_code: if e.kind == "usage" { 2 } else { 1 },
                kind: if e.kind == "usage" { None } else { Some(e.kind) },
                extra: e.extra,
            }
        })
    }

    fn start_confirm(&mut self) {
        let Some(flow) = self.start.clone() else { return };
        let kind = canonical_kind(&flow.kind_raw);
        let preview = match self.start_preview(&flow) {
            Ok(args) => args,
            Err(e) => {
                self.status = format!("launch args rejected: {}", tui_model::cli_error_message(&e));
                self.screen = Screen::Main;
                self.start = None;
                return;
            }
        };
        let mut resume_arg: Vec<String> = Vec::new();
        if flow.resume_mode == "value" {
            if let Some(v) = &flow.resume_value {
                if !v.is_empty() {
                    resume_arg = vec!["--resume".to_string(), v.clone()];
                }
            }
        } else if flow.resume_mode == "from" {
            if let Some(p) = &flow.resume_from_pane {
                resume_arg = vec!["--resume-from".to_string(), p.clone()];
            }
        }
        let mut argv_line = format!(
            "agent.start kind={} pane={}",
            kind, flow.pane_id
        );
        if !flow.name.is_empty() {
            argv_line.push_str(&format!(" name={}", flow.name));
        }
        if !resume_arg.is_empty() {
            argv_line.push_str(&format!(" {}", resume_arg.join(" ")));
        }
        if !preview.is_empty() {
            argv_line.push_str(&format!(" {}", preview.join(" ")));
        }
        let mut target_lines = vec![format!(
            "pane: {}{}",
            flow.pane_id,
            flow.pane_cwd
                .as_ref()
                .map(|c| format!(" (cwd {})", c))
                .unwrap_or_default()
        )];
        target_lines.push(format!("kind: {} → {}", flow.kind_raw, kind));
        if !flow.name.is_empty() {
            target_lines.push(format!("name: {}", flow.name));
        }
        target_lines.push(format!("argv: {}", argv_line));
        target_lines.push(format!(
            "target: {}",
            tui_model::format_target_label(&self.target)
        ));

        let mut args: Vec<String> = vec![
            "start".to_string(),
            flow.pane_id.clone(),
            "--agent".to_string(),
            flow.kind_raw.clone(),
        ];
        if !flow.name.is_empty() {
            args.push("--name".to_string());
            args.push(flow.name.clone());
        }
        if !flow.model.is_empty() {
            args.push("--model".to_string());
            args.push(flow.model.clone());
        }
        if !flow.reasoning.is_empty() {
            args.push("--reasoning".to_string());
            args.push(flow.reasoning.clone());
        }
        if let Some(m) = &flow.permission_mode {
            if !m.is_empty() {
                args.push("--permission-mode".to_string());
                args.push(m.clone());
            }
        }
        args.extend(resume_arg);

        self.screen = Screen::Confirm {
            mutation: PendingMutation {
                title: "Start agent on pane?".to_string(),
                target_lines,
                consequence: "launches a provider agent process in the pane via agent.start; herdr waits for interactive readiness".to_string(),
                danger: false,
                confirm_label: "Start".to_string(),
                focus_confirm: true,
                args,
                ok_message: "start".to_string(),
                timeout_ms: 300_000,
            },
        };
        self.start = None;
    }

    // --- select / prompt resolution ----------------------------------------------------

    /// Indices of items matching the filter — TS `filterItems`:
    /// whitespace-separated terms must ALL appear in
    /// `"label detail"` (lowercased, AND semantics).
    fn filtered_choices(items: &[tui_model::Choice], filter: &str) -> Vec<usize> {
        let q = filter.trim().to_lowercase();
        if q.is_empty() {
            return (0..items.len()).collect();
        }
        let terms: Vec<&str> = q.split_whitespace().collect();
        items
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                let hay = format!(
                    "{} {}",
                    c.label.to_lowercase(),
                    c.detail.as_deref().unwrap_or("").to_lowercase()
                );
                terms.iter().all(|t| hay.contains(t))
            })
            .map(|(i, _)| i)
            .collect()
    }

    /// The query currently in effect: the edit buffer while `/`-filter
    /// mode is active, else the committed draft (TS `filterQuery`).
    fn select_query(screen: &Screen) -> &str {
        match screen {
            Screen::Select {
                filter_mode,
                filter_edit,
                filter_draft,
                ..
            } => {
                if *filter_mode {
                    filter_edit
                } else {
                    filter_draft
                }
            }
            _ => "",
        }
    }

    /// Purposes whose TS select was `filterable: true`.
    fn purpose_filterable(purpose: &SelectPurpose) -> bool {
        matches!(
            purpose,
            SelectPurpose::StartPane | SelectPurpose::StartKind | SelectPurpose::StartResumeFrom
        )
    }

    fn select_visible(&self) -> Vec<usize> {
        match &self.screen {
            Screen::Select { items, .. } => {
                Self::filtered_choices(items, Self::select_query(&self.screen))
            }
            _ => Vec::new(),
        }
    }

    fn select_move(&mut self, delta: isize) {
        // TS SelectList.move: wrap around the FILTERED list and skip
        // disabled rows.
        let next = {
            let Screen::Select {
                items, cursor, ..
            } = &self.screen
            else {
                return;
            };
            let visible = Self::filtered_choices(items, Self::select_query(&self.screen));
            if visible.is_empty() {
                return;
            }
            let n = visible.len() as isize;
            let mut pos = (*cursor as isize).rem_euclid(n);
            pos = (pos + delta).rem_euclid(n);
            for _ in 0..visible.len() {
                let idx = visible[pos as usize];
                if !items[idx].disabled {
                    break;
                }
                pos = (pos + delta.signum()).rem_euclid(n);
            }
            pos as usize
        };
        if let Screen::Select { cursor, .. } = &mut self.screen {
            *cursor = next;
        }
    }

    fn select_submit(&mut self) {
        // Check disabled BEFORE leaving the select screen — a disabled
        // row must not dismiss the picker (TS SelectList.enter).
        let (purpose, value) = {
            let Screen::Select {
                purpose,
                items,
                cursor,
                ..
            } = &self.screen
            else {
                return;
            };
            let visible = Self::filtered_choices(items, Self::select_query(&self.screen));
            let Some(&idx) = visible.get(*cursor) else {
                return;
            };
            let choice = &items[idx];
            if choice.disabled {
                return;
            }
            (purpose.clone(), choice.value.clone())
        };
        self.screen = Screen::Main;
        self.resolve_select(purpose, &value);
    }

    fn resolve_select(&mut self, purpose: SelectPurpose, value: &str) {
        match purpose {
            SelectPurpose::SendWaitUntil { pin, text } => {
                let mut args = vec![
                    "send".to_string(),
                    pin.pane_id.clone(),
                    text.clone(),
                ];
                args.extend(tui_model::expect_args(&pin));
                // TS builds --wait-until only when a status was picked.
                if !value.is_empty() {
                    args.push("--wait-until".to_string());
                    args.push(value.to_string());
                    args.push("--timeout-ms".to_string());
                    args.push("60000".to_string());
                }
                // Note: `--wait` alone is never sent by the TUI; the
                // until/timeout pair implies the wait upstream.
                // TS truncates the echoed text at 120 chars.
                let text_preview = if text.chars().count() > 120 {
                    format!("{}…", text.chars().take(117).collect::<String>())
                } else {
                    text.clone()
                };
                let target_lines =
                    self.detail_target_lines_with(&pin, &format!("text: {}", text_preview));
                let pane_id = pin.pane_id.clone();
                self.confirm_or_stale(
                    PendingMutation {
                        title: "Send message to agent?".to_string(),
                        target_lines,
                        consequence: "submits text to the agent PTY via agent.prompt (bracketed paste + Enter)".to_string(),
                        danger: false,
                        confirm_label: "Send".to_string(),
                        focus_confirm: true,
                        args,
                        ok_message: "send ok".to_string(),
                        timeout_ms: 120_000,
                    },
                    &pane_id,
                );
            }
            SelectPurpose::WaitUntil { pane_id } => {
                // `wait` is a read-class op (not in mutation_commands) —
                // no confirm gate; run it directly like the TS view and
                // stay on the detail screen.
                self.screen = Screen::Detail {
                    pane_id: pane_id.clone(),
                };
                let mut args = vec!["wait".to_string(), pane_id.clone()];
                if !value.is_empty() {
                    args.push("--until".to_string());
                    args.push(value.to_string());
                }
                args.push("--timeout-ms".to_string());
                args.push("120000".to_string());
                let Some(payload) = self.run_op("wait", &args, 150_000) else {
                    return;
                };
                let result = payload.get("result").cloned().unwrap_or(Value::Null);
                let resolved = result
                    .get("agent_status")
                    .or_else(|| result.get("status"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("ok");
                self.status = format!("wait resolved: {}", resolved);
                self.load_detail();
                self.load_list();
                self.clamp_list_cursor();
            }
            SelectPurpose::InterruptKey { pin } => {
                let mut args = vec![
                    "interrupt".to_string(),
                    pin.pane_id.clone(),
                    "--key".to_string(),
                    value.to_string(),
                ];
                args.extend(tui_model::expect_args(&pin));
                let target_lines = self.detail_target_lines_with(&pin, &format!("keys: {}", value));
                let pane_id = pin.pane_id.clone();
                self.confirm_or_stale(
                    PendingMutation {
                        title: "Send PTY-level keys to agent?".to_string(),
                        target_lines,
                        consequence: "injects keys into the terminal (agent.send_keys) — PTY-level only, effect depends on provider keybindings; use for blocked dialogs".to_string(),
                        danger: true,
                        confirm_label: "Send keys".to_string(),
                        focus_confirm: true,
                        args,
                        ok_message: "interrupt ok".to_string(),
                        timeout_ms: 60_000,
                    },
                    &pane_id,
                );
            }
            SelectPurpose::StartPane => {
                let Some(flow) = self.start.as_mut() else {
                    return;
                };
                flow.pane_id = value.to_string();
                // cwd for the confirm line.
                if let Some(session) = &self.session {
                    flow.pane_cwd = session
                        .panes
                        .iter()
                        .find(|p| p.pane_id == value)
                        .and_then(|p| p.cwd.clone());
                }
                self.start_kind_select();
            }
            SelectPurpose::StartKind => {
                let Some(flow) = self.start.as_mut() else {
                    return;
                };
                flow.kind_raw = value.to_string();
                self.screen = Screen::Prompt {
                    kind: PromptKind::StartName,
                    draft: String::new(),
                    placeholder: format!("{}-xxxx", canonical_kind(value)),
                    label: "Agent name (optional — Enter for generated)".to_string(),
                };
            }
            SelectPurpose::StartPermMode => {
                let Some(flow) = self.start.as_mut() else {
                    return;
                };
                flow.permission_mode = if value.is_empty() {
                    None
                } else {
                    Some(value.to_string())
                };
                self.start_resume_mode_select();
            }
            SelectPurpose::StartResumeMode => {
                let Some(flow) = self.start.as_mut() else {
                    return;
                };
                flow.resume_mode = value.to_string();
                match value {
                    "value" => {
                        self.screen = Screen::Prompt {
                            kind: PromptKind::StartResumeValue,
                            draft: String::new(),
                            placeholder: String::new(),
                            label: "Resume session value (agent_session.value / id)".to_string(),
                        };
                    }
                    "from" => self.start_resume_from_select(),
                    _ => self.start_confirm(),
                }
            }
            SelectPurpose::StartResumeFrom => {
                let Some(flow) = self.start.as_mut() else {
                    return;
                };
                flow.resume_from_pane = Some(value.to_string());
                flow.resume_mode = "from".to_string();
                self.start_confirm();
            }
        }
    }

    fn detail_target_lines_with(&self, _pin: &PinnedAgent, extra: &str) -> Vec<String> {
        let mut lines = self.detail_target_lines();
        lines.push(extra.to_string());
        lines
    }

    fn prompt_submit(&mut self) {
        let screen = std::mem::replace(&mut self.screen, Screen::Main);
        let Screen::Prompt {
            kind,
            draft,
            ..
        } = screen
        else {
            return;
        };
        let draft = draft.trim().to_string();
        match kind {
            PromptKind::SendText { pin } => {
                if draft.is_empty() {
                    self.status = "empty message — cancelled".to_string();
                    return;
                }
                // Optional post-submit observation (read; not a wait guarantee).
                let items = [
                    ("", "send only"),
                    ("idle", "wait until idle"),
                    ("working", "wait until working"),
                    ("blocked", "wait until blocked"),
                    ("done", "wait until done"),
                ]
                .iter()
                .map(|(v, l)| tui_model::Choice::new(v, l))
                .collect();
                self.screen = Screen::Select {
                    purpose: SelectPurpose::SendWaitUntil { pin, text: draft },
                    items,
                    cursor: 0,
                    filter_mode: false,
                    filter_draft: String::new(),
                    filter_edit: String::new(),
                    title: "send — post-submit wait".to_string(),
                };
            }
            PromptKind::CommandText { pin } => {
                if draft.is_empty() {
                    self.status = "empty command — cancelled".to_string();
                    return;
                }
                let slash = if draft.starts_with('/') {
                    draft.clone()
                } else {
                    format!("/{}", draft)
                };
                let mut args = vec![
                    "command".to_string(),
                    pin.pane_id.clone(),
                    slash.clone(),
                ];
                args.extend(tui_model::expect_args(&pin));
                let mut target_lines = self.detail_target_lines();
                target_lines.push(format!("command: {}", slash));
                let pane_id = pin.pane_id.clone();
                self.confirm_or_stale(
                    PendingMutation {
                        title: "Run provider slash command?".to_string(),
                        target_lines,
                        consequence: "types the literal command text via agent.prompt; the provider TUI interprets it — fragile, unverified per provider".to_string(),
                        danger: false,
                        confirm_label: "Send".to_string(),
                        focus_confirm: true,
                        args,
                        ok_message: "command ok".to_string(),
                        timeout_ms: 120_000,
                    },
                    &pane_id,
                );
            }
            PromptKind::RenameName { pin, current } => {
                let clear = draft.is_empty();
                if !clear && draft == current {
                    return;
                }
                // TS argv order: rename <pane> <--clear|--name N> ...expect
                let mut args = vec![
                    "rename".to_string(),
                    pin.pane_id.clone(),
                ];
                if clear {
                    args.push("--clear".to_string());
                } else {
                    args.push("--name".to_string());
                    args.push(draft.clone());
                }
                args.extend(tui_model::expect_args(&pin));
                let mut target_lines = self.detail_target_lines();
                target_lines.push(format!(
                    "name: {}",
                    if clear { "(cleared)".to_string() } else { draft.clone() }
                ));
                let pane_id = pin.pane_id.clone();
                self.confirm_or_stale(
                    PendingMutation {
                        title: if clear {
                            "Clear agent name?".to_string()
                        } else {
                            "Rename agent?".to_string()
                        },
                        target_lines,
                        consequence: "sets the agent display name via agent.rename".to_string(),
                        danger: false,
                        confirm_label: if clear { "Clear".to_string() } else { "Rename".to_string() },
                        focus_confirm: true,
                        args,
                        ok_message: "rename ok".to_string(),
                        timeout_ms: 60_000,
                    },
                    &pane_id,
                );
            }
            PromptKind::StartName => {
                let Some(flow) = self.start.as_mut() else { return };
                flow.name = draft;
                self.screen = Screen::Prompt {
                    kind: PromptKind::StartModel,
                    draft: String::new(),
                    placeholder: String::new(),
                    label: "Model (optional — provider flag)".to_string(),
                };
            }
            PromptKind::StartModel => {
                let Some(flow) = self.start.as_mut() else { return };
                flow.model = draft;
                self.screen = Screen::Prompt {
                    kind: PromptKind::StartReasoning,
                    draft: String::new(),
                    placeholder: String::new(),
                    label: "Reasoning level (optional)".to_string(),
                };
            }
            PromptKind::StartReasoning => {
                let Some(flow) = self.start.as_mut() else { return };
                flow.reasoning = draft;
                self.start_perm_mode_select();
            }
            PromptKind::StartResumeValue => {
                let Some(flow) = self.start.as_mut() else { return };
                let value = draft;
                flow.resume_value = if value.is_empty() { None } else { Some(value) };
                self.start_confirm();
            }
        }
    }

    // --- key handling -----------------------------------------------------------------

    fn handle_key(&mut self, key: KeyEvent) -> bool {
        match &mut self.screen {
            Screen::Main => self.handle_main_key(key),
            Screen::Detail { .. } => self.handle_detail_key(key),
            Screen::Scrollback { .. } => self.handle_scrollback_key(key),
            Screen::Prompt { .. } => self.handle_prompt_key(key),
            Screen::Select { .. } => self.handle_select_key(key),
            Screen::Confirm { .. } => self.handle_confirm_key(key),
            Screen::Help => self.handle_overlay_key(key),
        }
    }

    fn handle_overlay_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => {
                self.screen = Screen::Main;
                true
            }
            _ => false,
        }
    }

    fn handle_confirm_key(&mut self, key: KeyEvent) -> bool {
        // Special-case the pane.focus pseudo-mutation (not a CLI command).
        if let Screen::Confirm { mutation } = &self.screen {
            if mutation.args.first().map(|s| s.as_str()) == Some("__focus__") {
                match key.code {
                    KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('q') => {
                        self.screen = Screen::Main;
                        self.status = "cancelled".to_string();
                        return true;
                    }
                    KeyCode::Char('y') => {
                        let pane_id = mutation.args.get(1).cloned().unwrap_or_default();
                        self.screen = Screen::Detail {
                            pane_id: pane_id.clone(),
                        };
                        match tui_model::focus_pane(&pane_id) {
                            Ok(_) => self.status = format!("focused {}", pane_id),
                            Err(e) => self.status = format!("focus failed: {}: {}", e.kind, e.message),
                        }
                        self.load_detail();
                        return true;
                    }
                    KeyCode::Enter | KeyCode::Char(' ') => {
                        // Focus defaults to confirm; Enter activates it.
                        let pane_id = mutation.args.get(1).cloned().unwrap_or_default();
                        self.screen = Screen::Detail {
                            pane_id: pane_id.clone(),
                        };
                        match tui_model::focus_pane(&pane_id) {
                            Ok(_) => self.status = format!("focused {}", pane_id),
                            Err(e) => self.status = format!("focus failed: {}: {}", e.kind, e.message),
                        }
                        self.load_detail();
                        return true;
                    }
                    _ => return true,
                }
            }
        }
        // TS ConfirmView: esc/n/q cancel · y confirm · tab/arrows/h/l
        // toggle focus · enter/space activates the focused button.
        match key.code {
            KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('q') => {
                self.screen = Screen::Main;
                self.status = "cancelled".to_string();
                true
            }
            KeyCode::Char('y') => {
                self.confirm_accepted();
                true
            }
            KeyCode::Tab
            | KeyCode::Left
            | KeyCode::Right
            | KeyCode::Char('h')
            | KeyCode::Char('l') => {
                if let Screen::Confirm { mutation } = &mut self.screen {
                    mutation.focus_confirm = !mutation.focus_confirm;
                }
                true
            }
            KeyCode::Enter | KeyCode::Char(' ') => {
                let focus_confirm = match &self.screen {
                    Screen::Confirm { mutation } => mutation.focus_confirm,
                    _ => true,
                };
                if focus_confirm {
                    self.confirm_accepted();
                } else {
                    self.screen = Screen::Main;
                    self.status = "cancelled".to_string();
                }
                true
            }
            _ => true, // swallow other keys while confirming
        }
    }

    /// Enter/`y` on the confirm dialog: run the staged mutation and
    /// return to the view it came from (TS `mutate` tail).
    fn confirm_accepted(&mut self) {
        let screen = std::mem::replace(&mut self.screen, Screen::Main);
        if let Screen::Confirm { mutation } = screen {
            // Restore the detail screen when the mutation came
            // from it; start-flow mutations return to Main.
            let was_detail = self.detail.is_some()
                && !matches!(mutation.args.first().map(|s| s.as_str()), Some("start"));
            self.run_confirmed(mutation);
            if was_detail {
                if let Some(pane_id) = self.detail_pane_id() {
                    self.screen = Screen::Detail { pane_id };
                    self.load_detail();
                }
            } else {
                self.load_list();
            }
        }
    }

    fn detail_pane_id(&self) -> Option<String> {
        self.detail.as_ref().and_then(|d| {
            d.pin.as_ref().map(|p| p.pane_id.clone()).filter(|s| !s.is_empty())
        })
    }

    fn handle_prompt_key(&mut self, key: KeyEvent) -> bool {
        let Screen::Prompt { draft, .. } = &mut self.screen else {
            return true;
        };
        match key.code {
            KeyCode::Esc => {
                self.screen = Screen::Main;
                self.start = None;
                true
            }
            KeyCode::Enter => {
                self.prompt_submit();
                true
            }
            KeyCode::Backspace => {
                draft.pop();
                true
            }
            KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                draft.push(c);
                true
            }
            _ => true,
        }
    }

    fn handle_select_key(&mut self, key: KeyEvent) -> bool {
        // `/` filter draft editing swallows every printable key (TS
        // SelectList.filterActive branch).
        if matches!(&self.screen, Screen::Select { filter_mode: true, .. }) {
            match key.code {
                KeyCode::Enter => {
                    if let Screen::Select {
                        filter_mode,
                        filter_edit,
                        filter_draft,
                        cursor,
                        ..
                    } = &mut self.screen
                    {
                        *filter_draft = std::mem::take(filter_edit);
                        *filter_mode = false;
                        *cursor = 0;
                    }
                }
                KeyCode::Esc => {
                    if let Screen::Select {
                        filter_mode,
                        filter_edit,
                        ..
                    } = &mut self.screen
                    {
                        *filter_mode = false;
                        filter_edit.clear();
                    }
                }
                KeyCode::Backspace => {
                    if let Screen::Select {
                        filter_edit, cursor, ..
                    } = &mut self.screen
                    {
                        filter_edit.pop();
                        *cursor = 0;
                    }
                }
                KeyCode::Char(c)
                    if !key.modifiers.contains(KeyModifiers::CONTROL)
                        && !key.modifiers.contains(KeyModifiers::ALT) =>
                {
                    if let Screen::Select {
                        filter_edit, cursor, ..
                    } = &mut self.screen
                    {
                        filter_edit.push(c);
                        *cursor = 0;
                    }
                }
                _ => {} // swallow everything else while filtering
            }
            return true;
        }

        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => {
                self.screen = Screen::Main;
                self.start = None;
            }
            KeyCode::Up | KeyCode::Char('k') => self.select_move(-1),
            KeyCode::Down | KeyCode::Char('j') => self.select_move(1),
            KeyCode::PageUp => {
                for _ in 0..10 {
                    self.select_move(-1);
                }
            }
            KeyCode::PageDown => {
                for _ in 0..10 {
                    self.select_move(1);
                }
            }
            KeyCode::Home => {
                if let Screen::Select { cursor, .. } = &mut self.screen {
                    *cursor = 0;
                }
            }
            KeyCode::End => {
                let n = self.select_visible().len();
                if let Screen::Select { cursor, .. } = &mut self.screen {
                    *cursor = n.saturating_sub(1);
                }
            }
            KeyCode::Char('/') => {
                let filterable = matches!(&self.screen, Screen::Select { purpose, .. } if Self::purpose_filterable(purpose));
                if filterable {
                    if let Screen::Select {
                        filter_mode,
                        filter_edit,
                        filter_draft,
                        ..
                    } = &mut self.screen
                    {
                        *filter_mode = true;
                        *filter_edit = filter_draft.clone();
                    }
                }
            }
            KeyCode::Enter => self.select_submit(),
            _ => {}
        }
        true
    }

    fn handle_scrollback_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => {
                // Return to the detail view if we came from one.
                if let Some(pane_id) = self.detail_pane_id() {
                    self.screen = Screen::Detail { pane_id };
                } else {
                    self.screen = Screen::Main;
                }
                true
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.scroll_detail(-1);
                true
            }
            KeyCode::Down | KeyCode::Char('j') | KeyCode::Char(' ') => {
                self.scroll_detail(1);
                true
            }
            _ => false,
        }
    }

    fn scroll_detail(&mut self, delta: isize) {
        match &mut self.screen {
            Screen::Detail { .. } => {
                if let Some(d) = &mut self.detail {
                    d.scroll = (d.scroll as isize + delta).max(0) as usize;
                }
            }
            Screen::Scrollback { scroll, lines, .. } => {
                let max = lines.len().saturating_sub(1) as isize;
                *scroll = (*scroll as isize + delta).clamp(0, max.max(0)) as usize;
            }
            _ => {}
        }
    }

    fn handle_detail_key(&mut self, key: KeyEvent) -> bool {
        // Scroll keys first (detail body scroll).
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                self.scroll_detail(-1);
                return true;
            }
            KeyCode::Down | KeyCode::Char('j') | KeyCode::Char(' ') => {
                self.scroll_detail(1);
                return true;
            }
            KeyCode::PageUp => {
                for _ in 0..10 {
                    self.scroll_detail(-1);
                }
                return true;
            }
            KeyCode::PageDown => {
                for _ in 0..10 {
                    self.scroll_detail(1);
                }
                return true;
            }
            _ => {}
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) || key.modifiers.contains(KeyModifiers::ALT) {
            return false;
        }
        match key.code {
            KeyCode::Char('r') | KeyCode::Char('R') => {
                self.load_detail();
                true
            }
            KeyCode::Esc | KeyCode::Char('q') => {
                self.screen = Screen::Main;
                self.detail = None;
                true
            }
            KeyCode::Char('s') => {
                self.send_flow();
                true
            }
            KeyCode::Char('c') => {
                self.command_flow();
                true
            }
            KeyCode::Char('w') => {
                self.wait_flow();
                true
            }
            KeyCode::Char('i') => {
                self.interrupt_flow();
                true
            }
            KeyCode::Char('v') => {
                self.read_flow();
                true
            }
            KeyCode::Char('n') => {
                self.rename_flow();
                true
            }
            KeyCode::Char('f') => {
                self.focus_flow();
                true
            }
            _ => false,
        }
    }

    fn handle_main_key(&mut self, key: KeyEvent) -> bool {
        // Filter draft mode.
        if self.filter_mode {
            match key.code {
                KeyCode::Esc => {
                    self.filter_mode = false;
                    self.filter_draft.clear();
                }
                KeyCode::Enter => {
                    self.filter_mode = false;
                    self.cursor = 0;
                    self.scroll_top = 0;
                    self.clamp_list_cursor();
                }
                KeyCode::Backspace => {
                    self.filter_draft.pop();
                    self.clamp_list_cursor();
                }
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.filter_draft.push(c);
                    self.clamp_list_cursor();
                }
                _ => {}
            }
            return true;
        }

        if key.modifiers.contains(KeyModifiers::CONTROL) {
            return false;
        }
        let list_len = self.list_items().len();
        let move_by = |app: &mut App, delta: isize| {
            if list_len == 0 {
                return;
            }
            let n = list_len as isize;
            app.cursor = ((app.cursor as isize + delta).rem_euclid(n)) as usize;
        };
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => move_by(self, -1),
            KeyCode::Down | KeyCode::Char('j') => move_by(self, 1),
            KeyCode::PageUp => {
                for _ in 0..10 {
                    move_by(self, -1);
                }
            }
            KeyCode::PageDown => {
                for _ in 0..10 {
                    move_by(self, 1);
                }
            }
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = list_len.saturating_sub(1),
            KeyCode::Char('/') => {
                self.filter_mode = true;
                self.filter_draft.clear();
            }
            KeyCode::Char('R') => self.load_list(),
            KeyCode::Char('r') => self.load_list(),
            KeyCode::Char('?') => self.screen = Screen::Help,
            KeyCode::Enter => {
                if let Some(item) = self.current_agent_item() {
                    self.open_detail(&item.value_pane_id);
                }
            }
            KeyCode::Char('q') | KeyCode::Esc => return false,
            KeyCode::Char('s') => {
                if self.list_phase == Phase::Ready {
                    self.start_flow();
                }
            }
            _ => {}
        }
        true
    }
}

// --- rendering -------------------------------------------------------------------------

fn render(app: &mut App, frame: &mut ratatui::Frame) {
    let area = frame.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(area);

    // Header — pinned target label is env/session derived.
    let label = tui_model::format_target_label(&app.target);
    let header = format!(
        " Controls v{} — {}",
        PLUGIN_VERSION,
        sanitize_display(&label)
    );
    frame.render_widget(
        Paragraph::new(header).style(Style::default().add_modifier(Modifier::BOLD)),
        chunks[0],
    );

    // Main/Detail renderers need `&mut App` (scroll clamping), so they
    // are dispatched before the immutable `&app.screen` match below.
    enum Dispatch {
        Main,
        Detail(String),
        Other,
    }
    let dispatch = match &app.screen {
        Screen::Main => Dispatch::Main,
        Screen::Detail { pane_id } => Dispatch::Detail(pane_id.clone()),
        _ => Dispatch::Other,
    };
    match dispatch {
        Dispatch::Main => {
            render_main(app, frame, chunks[1]);
            render_footer(app, frame, chunks[2]);
            return;
        }
        Dispatch::Detail(pane_id) => {
            render_detail(app, frame, chunks[1], &pane_id);
            render_footer(app, frame, chunks[2]);
            return;
        }
        Dispatch::Other => {}
    }

    // Clamp scrollback scroll before the immutable borrow.
    let body_h = chunks[1].height as usize;
    if let Screen::Scrollback { lines, scroll, .. } = &mut app.screen {
        let max_scroll = lines.len().saturating_sub(body_h.max(1));
        if *scroll > max_scroll {
            *scroll = max_scroll;
        }
    }

    match &app.screen {
        Screen::Main | Screen::Detail { .. } => unreachable!(),
        Screen::Scrollback {
            title,
            lines,
            scroll,
        } => {
            // Windowed line view with scroll (bounded output per
            // tui-v1 §5 item 10).
            let inner_h = chunks[1].height as usize;
            let view: Vec<String> = lines[*scroll..(*scroll + inner_h).min(lines.len())]
                .iter()
                .map(|l| bound_text(&sanitize_display(l), chunks[1].width as usize))
                .collect();
            let mut text = view.join("\n");
            if !lines.is_empty() {
                text.push_str(&format!(
                    "\n{}/{}",
                    (*scroll + 1).min(lines.len()),
                    lines.len()
                ));
            }
            frame.render_widget(
                Paragraph::new(text)
                    .block(
                        Block::default()
                            .borders(Borders::ALL)
                            .title(sanitize_display(title)),
                    )
                    .wrap(Wrap { trim: false }),
                chunks[1],
            );
        }
        Screen::Prompt {
            kind: _,
            draft,
            placeholder,
            label,
        } => {
            let mut lines = vec![
                Line::from(sanitize_display(label))
                    .style(Style::default().add_modifier(Modifier::BOLD)),
                Line::from(format!("> {}█", sanitize_display(draft))),
            ];
            if !placeholder.is_empty() {
                lines.push(Line::from(Span::styled(
                    format!("(enter submit · esc cancel · placeholder: {})", sanitize_display(placeholder)),
                    Style::default().add_modifier(Modifier::DIM),
                )));
            } else {
                lines.push(Line::from(Span::styled(
                    "(enter submit · esc cancel)",
                    Style::default().add_modifier(Modifier::DIM),
                )));
            }
            frame.render_widget(
                Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title("controls")),
                chunks[1],
            );
        }
        Screen::Select {
            purpose: _,
            items,
            cursor,
            filter_mode,
            filter_draft,
            filter_edit,
            title,
        } => {
            let query = if *filter_mode { filter_edit } else { filter_draft };
            let visible = App::filtered_choices(items, query);
            let body_h = (chunks[1].height as usize).saturating_sub(4).max(1);
            // Scroll window keeping `cursor` (a visible-list index)
            // on screen.
            let n = visible.len();
            let mut start = if *cursor >= body_h {
                *cursor + 1 - body_h
            } else {
                0
            };
            start = start.min(n.saturating_sub(body_h));
            let mut lines: Vec<Line> = Vec::new();
            lines.push(
                Line::from(sanitize_display(title))
                    .style(Style::default().add_modifier(Modifier::BOLD)),
            );
            if *filter_mode || !filter_draft.is_empty() {
                let shown = if *filter_mode { filter_edit } else { filter_draft };
                let mut spans = vec![
                    Span::styled("/", Style::default().add_modifier(Modifier::BOLD)),
                    Span::styled(sanitize_display(shown), Style::default()),
                ];
                if *filter_mode {
                    spans.push(Span::styled("▌", Style::default().add_modifier(Modifier::REVERSED)));
                }
                lines.push(Line::from(spans));
            }
            lines.push(Line::from(""));
            if n == 0 {
                lines.push(Line::from(Span::styled(
                    "  (empty)",
                    Style::default().add_modifier(Modifier::DIM),
                )));
            }
            for vi in start..(start + body_h).min(n) {
                let idx = visible[vi];
                let item = &items[idx];
                let is_sel = vi == *cursor;
                let prefix = if is_sel { "❯" } else { " " };
                let row_style = if item.disabled {
                    Style::default().add_modifier(Modifier::DIM)
                } else if is_sel {
                    Style::default()
                        .add_modifier(Modifier::BOLD)
                        .fg(ratatui::style::Color::Cyan)
                } else {
                    Style::default()
                };
                let mut spans = vec![
                    Span::styled(format!("{} ", prefix), row_style),
                    Span::styled(sanitize_display(&item.label), row_style),
                ];
                if item.disabled {
                    if let Some(reason) = &item.disabled_reason {
                        spans.push(Span::styled(
                            format!(" {}", sanitize_display(reason)),
                            Style::default().add_modifier(Modifier::DIM),
                        ));
                    }
                }
                lines.push(Line::from(spans));
                // Selected item's detail below its row (bounded).
                if is_sel {
                    if let Some(detail) = &item.detail {
                        for dl in detail.lines().take(6) {
                            lines.push(Line::from(Span::styled(
                                format!("    {}", sanitize_display(dl)),
                                Style::default().add_modifier(Modifier::DIM),
                            )));
                        }
                    }
                }
            }
            if n > body_h {
                lines.push(Line::from(Span::styled(
                    format!("  {}/{}", (*cursor + 1).min(n), n),
                    Style::default().add_modifier(Modifier::DIM),
                )));
            }
            lines.push(Line::from(Span::styled(
                "↑/k ↓/j move · enter select · esc/q cancel",
                Style::default().add_modifier(Modifier::DIM),
            )));
            frame.render_widget(
                Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title("controls")),
                chunks[1],
            );
        }
        Screen::Confirm { mutation } => {
            // TS ConfirmView: title, target lines, consequence
            // (red when danger), [ Confirm ]/[ Cancel ] buttons with
            // focus styling, danger tints the confirm side red.
            let mut text = vec![
                Line::from(sanitize_display(&mutation.title))
                    .style(Style::default().add_modifier(Modifier::BOLD)),
                Line::from(""),
            ];
            for l in &mutation.target_lines {
                text.push(Line::from(sanitize_display(l)));
            }
            text.push(Line::from(""));
            let cons_style = if mutation.danger {
                Style::default()
                    .add_modifier(Modifier::BOLD)
                    .fg(ratatui::style::Color::Red)
            } else {
                Style::default().add_modifier(Modifier::BOLD)
            };
            text.push(Line::from(Span::styled(
                sanitize_display(&mutation.consequence),
                cons_style,
            )));
            text.push(Line::from(""));
            let c_label = format!("[ {} ]", mutation.confirm_label);
            let x_label = "[ Cancel ]".to_string();
            let c_style = if mutation.focus_confirm {
                let mut s = Style::default()
                    .add_modifier(Modifier::BOLD | Modifier::REVERSED);
                if mutation.danger {
                    s = s.fg(ratatui::style::Color::Red);
                }
                s
            } else if mutation.danger {
                Style::default().fg(ratatui::style::Color::Red)
            } else {
                Style::default()
            };
            let x_style = if mutation.focus_confirm {
                Style::default().add_modifier(Modifier::DIM)
            } else {
                Style::default()
                    .add_modifier(Modifier::BOLD | Modifier::REVERSED)
            };
            text.push(Line::from(vec![
                Span::raw("    "),
                Span::styled(c_label, c_style),
                Span::raw("  "),
                Span::styled(x_label, x_style),
            ]));
            text.push(Line::from(Span::styled(
                "tab/arrows switch · enter activate · y/n · esc/q cancel",
                Style::default().add_modifier(Modifier::DIM),
            )));
            let rect = Rect {
                x: chunks[1].x + chunks[1].width / 4,
                y: chunks[1].y + chunks[1].height / 4,
                width: chunks[1].width / 2,
                height: chunks[1].height / 2,
            };
            frame.render_widget(Clear, rect);
            let border_style = if mutation.danger {
                Style::default().fg(ratatui::style::Color::Red)
            } else {
                Style::default()
            };
            frame.render_widget(
                Paragraph::new(text).block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(border_style)
                        .title("confirm"),
                ),
                rect,
            );
        }
        Screen::Help => {
            let mut text: Vec<Line> = Vec::new();
            text.push(
                Line::from("Controls TUI keymap").style(Style::default().add_modifier(Modifier::BOLD)),
            );
            text.push(Line::from(""));
            for (keys, desc) in [
                ("↑/k ↓/j", "move"),
                ("/", "filter"),
                ("enter", "open agent"),
                ("s", "start agent on shell pane"),
                ("r/R", "refresh"),
                ("esc/q", "close/back"),
                ("detail: s", "send message (agent.prompt)"),
                ("detail: c", "provider slash command (fragile)"),
                ("detail: w", "wait for status"),
                ("detail: i", "PTY-level interrupt keys"),
                ("detail: v", "scrollback read"),
                ("detail: n", "rename agent"),
                ("detail: f", "focus pane"),
            ] {
                text.push(Line::from(format!("  {:<22} {}", keys, desc)));
            }
            text.push(Line::from(""));
            text.push(Line::from(
                "Mutations go through the controls CLI contract (agent.* socket API) — the TUI never writes agent state directly.",
            ));
            frame.render_widget(
                Paragraph::new(text).block(Block::default().borders(Borders::ALL).title("help")),
                chunks[1],
            );
        }
    }

    render_footer(app, frame, chunks[2]);
}

fn render_footer(app: &App, frame: &mut ratatui::Frame, area: Rect) {
    // Footer — status embeds pane ids/kinds; sanitize before display.
    let hint = if app.filter_mode {
        format!(
            " filter: /{}█ — enter apply · esc cancel",
            sanitize_display(&app.filter_draft)
        )
    } else {
        format!(" {} · ? help · q quit", sanitize_display(&app.status))
    };
    frame.render_widget(
        Paragraph::new(hint).style(Style::default().add_modifier(Modifier::DIM)),
        area,
    );
}

fn render_main(app: &mut App, frame: &mut ratatui::Frame, area: Rect) {
    match &app.list_phase {
        Phase::Loading => {
            frame.render_widget(Paragraph::new("  loading agents…"), area);
        }
        Phase::Error(e) => {
            let text = vec![
                Line::from(Span::styled(
                    "  failed to load agents",
                    Style::default()
                        .add_modifier(Modifier::BOLD)
                        .fg(ratatui::style::Color::Red),
                )),
                Line::from(format!("  {}", sanitize_display(e))),
                Line::from("  R — retry · Esc — close"),
            ];
            frame.render_widget(Paragraph::new(text), area);
        }
        Phase::Missing | Phase::Ready => {
            let list = app.list_items();
            if list.is_empty() {
                frame.render_widget(
                    Paragraph::new(vec![
                        Line::from(Span::styled(
                            "  (empty)",
                            Style::default().add_modifier(Modifier::DIM),
                        )),
                        Line::from("  no agents reported — s start an agent on a shell pane"),
                    ]),
                    area,
                );
                return;
            }
            let visible = (area.height as usize).saturating_sub(1).max(1);
            let n = list.len();
            if app.cursor < app.scroll_top {
                app.scroll_top = app.cursor;
            }
            if app.cursor >= app.scroll_top + visible {
                app.scroll_top = app.cursor + 1 - visible;
            }
            app.scroll_top = app.scroll_top.min(n.saturating_sub(visible));
            let mut lines: Vec<Line> = Vec::new();
            for i in 0..visible.min(n.saturating_sub(app.scroll_top)) {
                let item = &list[app.scroll_top + i];
                let is_sel = app.scroll_top + i == app.cursor;
                let prefix = if is_sel { "❯ " } else { "  " };
                let sel_style = if is_sel {
                    Style::default().add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                };
                lines.push(Line::from(vec![
                    Span::styled(prefix, sel_style),
                    Span::styled(sanitize_display(&item.label), sel_style),
                ]));
            }
            // Selected item's detail block below the list.
            if let Some(item) = list.get(app.cursor) {
                lines.push(Line::from(""));
                lines.push(Line::from(Span::styled(
                    "─".repeat(area.width as usize),
                    Style::default().add_modifier(Modifier::DIM),
                )));
                for dl in item.detail.lines().take(8) {
                    lines.push(Line::from(Span::styled(
                        sanitize_display(dl),
                        Style::default().add_modifier(Modifier::DIM),
                    )));
                }
            }
            if n > visible {
                lines.push(Line::from(Span::styled(
                    format!("  {}/{}", app.cursor + 1, n),
                    Style::default().add_modifier(Modifier::DIM),
                )));
            }
            frame.render_widget(Paragraph::new(lines), area);
        }
    }
}

fn render_detail(app: &mut App, frame: &mut ratatui::Frame, area: Rect, pane_id: &str) {
    let Some(detail) = &mut app.detail else {
        frame.render_widget(Paragraph::new("  (no detail state)"), area);
        return;
    };
    match &detail.phase {
        Phase::Loading => {
            frame.render_widget(
                Paragraph::new(format!("  loading agent {}…", sanitize_display(pane_id))),
                area,
            );
        }
        Phase::Missing => {
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(Span::styled(
                        format!("  agent/pane not found: {}", sanitize_display(pane_id)),
                        Style::default()
                            .add_modifier(Modifier::BOLD)
                            .fg(ratatui::style::Color::Red),
                    )),
                    Line::from("  R — retry · Esc — back"),
                ]),
                area,
            );
        }
        Phase::Error(e) => {
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(Span::styled(
                        "  failed to load agent",
                        Style::default()
                            .add_modifier(Modifier::BOLD)
                            .fg(ratatui::style::Color::Red),
                    )),
                    Line::from(format!("  {}", sanitize_display(e))),
                    Line::from("  R — retry · Esc — back"),
                ]),
                area,
            );
        }
        Phase::Ready => {
            let mut source: Vec<String> = Vec::new();
            if let Some(agent) = &detail.agent {
                source.extend(tui_model::identity_lines(agent));
            }
            source.push(String::new());
            source.push(
                "ops: s send · c command · w wait · i interrupt · v scrollback · n rename · f focus · R refresh"
                    .to_string(),
            );
            // Word-wrap long lines like the TS view.
            let width = (area.width as usize).saturating_sub(2).max(1);
            let mut wrapped: Vec<String> = Vec::new();
            for l in &source {
                let mut cur = String::new();
                for w in l.split(' ') {
                    if !cur.is_empty() && cur.chars().count() + w.chars().count() + 1 > width {
                        wrapped.push(std::mem::take(&mut cur));
                        cur = w.to_string();
                    } else if cur.is_empty() {
                        cur = w.to_string();
                    } else {
                        cur.push(' ');
                        cur.push_str(w);
                    }
                }
                wrapped.push(cur);
            }
            let body_h = (area.height as usize).saturating_sub(2).max(1);
            let max_scroll = wrapped.len().saturating_sub(body_h);
            if detail.scroll > max_scroll {
                detail.scroll = max_scroll;
            }
            let view: Vec<Line> = wrapped[detail.scroll..(detail.scroll + body_h).min(wrapped.len())]
                .iter()
                .map(|v| Line::from(sanitize_display(v)))
                .collect();
            let mut lines = vec![Line::from(Span::styled(
                format!("agent {}", sanitize_display(pane_id)),
                Style::default().add_modifier(Modifier::BOLD),
            ))];
            lines.extend(view);
            while lines.len() < area.height as usize {
                lines.push(Line::from(""));
            }
            lines.truncate(area.height as usize);
            // Position indicator on the last line.
            if let Some(last) = lines.last_mut() {
                *last = Line::from(Span::styled(
                    format!(
                        "{}/{}",
                        (detail.scroll + 1).min(wrapped.len().max(1)),
                        wrapped.len()
                    ),
                    Style::default().add_modifier(Modifier::DIM),
                ));
            }
            frame.render_widget(Paragraph::new(lines), area);
        }
    }
}

// --- non-TTY fallback -------------------------------------------------------------------

/// Honest plain-text rendering when there is no TTY (pipes, CI).
fn render_plain_list() -> i32 {
    match tui_model::read_session_agents() {
        Err(e) => {
            let _ = writeln!(
                io::stderr(),
                "{}",
                serde_json::to_string(&json!({"ok": false, "error": e})).unwrap_or_default()
            );
            1
        }
        Ok(session) => {
            let agents = &session.agents;
            if agents.is_empty() {
                println!("controls: no agents reported in session");
            }
            for (pane_id, agent) in agents {
                let kind = agent.agent.clone().unwrap_or_else(|| "agent".to_string());
                let status = agent
                    .agent_status
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string());
                let seq = agent
                    .state_change_seq
                    .map(|s| {
                        if s.fract() == 0.0 {
                            format!("{}", s as i64)
                        } else {
                            format!("{}", s)
                        }
                    })
                    .unwrap_or_else(|| "?".to_string());
                println!("{}\t{}\t{}\tseq={}", pane_id, kind, status, seq);
            }
            println!(
                "hint: run inside a herdr pane (or a TTY) for the interactive TUI; CLI: controls <cmd>"
            );
            0
        }
    }
}

// --- `open` action helper -----------------------------------------------------------------

/// `open` action: pin the origin context once, then ask herdr to open
/// the `main` pane entrypoint as a tab and return promptly.
fn run_open() -> i32 {
    let target = tui_model::resolve_pinned_target();
    let params = tui_model::build_pane_open_params(&target);
    match tui_model::open_controls_pane(&params) {
        Ok(result) => {
            println!(
                "{}",
                serde_json::to_string(&json!({
                    "ok": true,
                    "plugin": tui_model::PLUGIN_ID,
                    "pane": result,
                }))
                .unwrap_or_default()
            );
            0
        }
        Err(err) => {
            eprintln!(
                "{}",
                serde_json::to_string(&json!({
                    "ok": false,
                    "error": { "kind": err.kind, "message": err.message },
                }))
                .unwrap_or_default()
            );
            1
        }
    }
}

// --- entry ---------------------------------------------------------------------------------

const USAGE: &str = "usage: controls tui <open|main>\n  open — `open` action helper: plugin.pane.open (tab) for the TUI\n  main — interactive pane entrypoint (default)\n";

/// `controls tui [open|main|help]` entrypoint; returns the exit code.
pub fn run(args: &[String]) -> i32 {
    let command = args.first().map(|s| s.as_str()).unwrap_or("main");
    match command {
        "open" => run_open(),
        "main" => run_main(),
        "--help" | "-h" | "help" => {
            print!("{}", USAGE);
            0
        }
        other => {
            eprintln!("unknown tui command: {}", other);
            2
        }
    }
}

fn run_main() -> i32 {
    let target = tui_model::resolve_pinned_target();

    // Non-TTY stdin → honest plain-text list.
    if !io::stdin().is_terminal() {
        return render_plain_list();
    }

    // Capability document for mutation gating (fail closed on error).
    let capability = cli::run_args(&["capability".to_string()]).ok();

    let mut app = App::new(target, capability);
    app.load_list();

    if crossterm::terminal::enable_raw_mode().is_err() {
        eprintln!("controls tui failed: could not enable raw mode");
        return 1;
    }
    let _ = crossterm::execute!(io::stdout(), crossterm::terminal::EnterAlternateScreen);

    let backend = ratatui::backend::CrosstermBackend::new(io::stdout());
    let mut terminal = match Terminal::new(backend) {
        Ok(t) => t,
        Err(err) => {
            let _ = crossterm::execute!(io::stdout(), crossterm::terminal::LeaveAlternateScreen);
            crossterm::terminal::disable_raw_mode().ok();
            eprintln!("controls tui failed: {}", err);
            return 1;
        }
    };
    // NOTE: no terminal.clear() — see the inbox TUI for the DSR rationale.

    let result = (|| -> io::Result<()> {
        loop {
            terminal.draw(|frame| render(&mut app, frame))?;
            if event::poll(Duration::from_millis(100))? {
                if let Event::Key(key) = event::read()? {
                    if key.kind == event::KeyEventKind::Press && !app.handle_key(key) {
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
            let _ = writeln!(io::stderr(), "controls tui exited");
            0
        }
        Err(err) => {
            eprintln!("controls tui failed: {}", err);
            1
        }
    }
}
