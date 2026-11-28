//! Launch-time controls for `rebuildup.controls` (Issue #100 / parent
//! #27 T2, ADR-0018). Rust port of `plugins/controls/src/launch.ts`.
//!
//! `agent.start` passes `args` verbatim to the provider CLI after the
//! kind's canonical executable; herdr shell-encodes the argv and rejects
//! control characters upstream. This module owns the plugin-side policy:
//!
//! - Structured options (`--model`, `--reasoning`, `--permission-mode`,
//!   `--resume`) map to provider CLI flags through an explicit per-kind
//!   table. Providers without a verified mapping report `unsupported` —
//!   the plugin never fabricates provider capabilities and never relies
//!   on implicit provider defaults.
//! - `--arg` passthrough is validated (no control characters, non-empty)
//!   and screened against a privilege-escalation denylist (bypass /
//!   never-ask / danger-full-access flags). `--unsafe-args` is the
//!   explicit opt-out, echoed in the result.
//! - Resume argv mirrors herdr's own `agent_resume.rs` launch-arg plan
//!   (the same mapping herdr uses for session restore), so `start
//!   --resume` produces exactly the argv herdr would reconstruct.

use serde_json::{json, Map, Value};

use crate::identity::ControlsError;

pub const PERMISSION_MODES: [&str; 4] = [
    "supervised",
    "auto-accept-edits",
    "auto",
    "full-access",
];

/// Session-ref kinds herdr reports (`AgentSessionRefKind`).
pub type ResumeSessionKind = &'static str; // "id" | "path"

/// Resume argv mapping variants (the TS table used closures; these are
/// the four shapes it contained).
#[derive(Debug, Clone, Copy)]
enum ResumeMap {
    /// `[flag, value]` — `--resume <v>`, `--session <v>`, …
    Flag(&'static str),
    /// `[flag=value]` — `--resume=<v>`.
    Inline(&'static str),
    /// Codex subcommand style: `["resume", value]`.
    CodexResume,
    /// Letta conversation select: `default:<agent>` form supported.
    Letta,
}

impl ResumeMap {
    fn build(&self, value: &str) -> Option<Vec<String>> {
        match self {
            ResumeMap::Flag(flag) => Some(vec![flag.to_string(), value.to_string()]),
            ResumeMap::Inline(flag) => Some(vec![format!("{}={}", flag, value)]),
            ResumeMap::CodexResume => Some(vec!["resume".to_string(), value.to_string()]),
            ResumeMap::Letta => {
                if let Some(agent_id) = value.strip_prefix("default:") {
                    if agent_id.is_empty() {
                        return None;
                    }
                    return Some(vec![
                        "--conversation".to_string(),
                        "default".to_string(),
                        "--agent".to_string(),
                        agent_id.to_string(),
                    ]);
                }
                Some(vec!["--conversation".to_string(), value.to_string()])
            }
        }
    }
}

/// Flag-style argv mapping for model/reasoning options.
#[derive(Debug, Clone, Copy)]
enum OptMap {
    /// `[flag, value]`.
    Flag(&'static str),
    /// Codex reasoning: `["-c", "model_reasoning_effort=<v>"]`.
    CodexReasoning,
}

impl OptMap {
    fn build(&self, value: &str) -> Vec<String> {
        match self {
            OptMap::Flag(flag) => vec![flag.to_string(), value.to_string()],
            OptMap::CodexReasoning => vec![
                "-c".to_string(),
                format!("model_reasoning_effort={}", value),
            ],
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ProviderLaunchSpec {
    model: Option<OptMap>,
    reasoning: Option<OptMap>,
    /// Supported permission modes → argv (executable excluded), in the
    /// fixed order supervised, auto-accept-edits, auto, full-access —
    /// matching `Object.keys` insertion order of the TS table.
    permission_modes: &'static [(&'static str, &'static [&'static str])],
    resume: Option<ResumeMap>,
    /// Session kinds `resume` accepts; default `["id"]`.
    resume_session_kinds: &'static [&'static str],
    notes: Option<&'static str>,
}

const NO_MODES: &[(&str, &[&str])] = &[];
const ID_ONLY: &[&str] = &["id"];
const ID_PATH: &[&str] = &["id", "path"];

const LAUNCH_SPECS: &[(&str, ProviderLaunchSpec)] = &[
    (
        "claude",
        ProviderLaunchSpec {
            model: Some(OptMap::Flag("--model")),
            reasoning: Some(OptMap::Flag("--effort")),
            permission_modes: &[
                ("supervised", &["--permission-mode", "manual"]),
                ("auto-accept-edits", &["--permission-mode", "acceptEdits"]),
                ("auto", &["--permission-mode", "auto"]),
                ("full-access", &["--permission-mode", "bypassPermissions"]),
            ],
            resume: Some(ResumeMap::Flag("--resume")),
            resume_session_kinds: ID_ONLY,
            notes: Some(
                "bypassPermissions may still require the provider's own enablement; --resume also accepts a session name upstream.",
            ),
        },
    ),
    (
        "codex",
        ProviderLaunchSpec {
            model: Some(OptMap::Flag("--model")),
            reasoning: Some(OptMap::CodexReasoning),
            permission_modes: &[
                (
                    "supervised",
                    &["--ask-for-approval", "on-request", "--sandbox", "read-only"],
                ),
                (
                    "auto-accept-edits",
                    &[
                        "--ask-for-approval",
                        "on-request",
                        "--sandbox",
                        "workspace-write",
                    ],
                ),
                ("auto", &["--approve-for-me"]),
                ("full-access", &["--dangerously-bypass-approvals-and-sandbox"]),
            ],
            resume: Some(ResumeMap::CodexResume),
            resume_session_kinds: ID_ONLY,
            notes: Some(
                "full-access emits the provider's bypass flag by design; raw --arg passthrough of it is denylisted (ADR-0018).",
            ),
        },
    ),
    (
        "gemini",
        ProviderLaunchSpec {
            model: Some(OptMap::Flag("--model")),
            reasoning: None,
            permission_modes: &[
                ("supervised", &["--approval-mode", "default"]),
                ("auto-accept-edits", &["--approval-mode", "auto_edit"]),
                ("full-access", &["--approval-mode", "yolo"]),
            ],
            resume: None,
            resume_session_kinds: ID_ONLY,
            notes: Some(
                "auto mode unsupported: gemini has no automatic-review approval mode.",
            ),
        },
    ),
    (
        "cursor",
        ProviderLaunchSpec {
            model: Some(OptMap::Flag("--model")),
            reasoning: None,
            permission_modes: &[("full-access", &["--force"])],
            resume: Some(ResumeMap::Flag("--resume")),
            resume_session_kinds: ID_ONLY,
            notes: Some("only full-access is mapped (--force); other modes unsupported."),
        },
    ),
    (
        "pi",
        ProviderLaunchSpec {
            model: Some(OptMap::Flag("--model")),
            reasoning: Some(OptMap::Flag("--thinking")),
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Flag("--session")),
            resume_session_kinds: ID_PATH,
            notes: Some(
                "no permission-mode launch flag upstream (project trust is --approve/--no-approve, a different concept).",
            ),
        },
    ),
    (
        "opencode",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: &[("full-access", &["--auto"])],
            resume: Some(ResumeMap::Flag("--session")),
            resume_session_kinds: ID_ONLY,
            notes: Some(
                "interactive opencode has no --model flag (model is config/agent-scoped); only full-access maps (--auto still honors deny rules).",
            ),
        },
    ),
    (
        "omp",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Inline("--resume")),
            resume_session_kinds: ID_PATH,
            notes: None,
        },
    ),
    (
        "mastracode",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Flag("--thread")),
            resume_session_kinds: ID_ONLY,
            notes: None,
        },
    ),
    (
        "copilot",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Inline("--resume")),
            resume_session_kinds: ID_ONLY,
            notes: None,
        },
    ),
    (
        "devin",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Flag("--resume")),
            resume_session_kinds: ID_ONLY,
            notes: None,
        },
    ),
    (
        "droid",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Flag("--resume")),
            resume_session_kinds: ID_ONLY,
            notes: None,
        },
    ),
    (
        "kimi",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Flag("--session")),
            resume_session_kinds: ID_ONLY,
            notes: None,
        },
    ),
    (
        "hermes",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Flag("--resume")),
            resume_session_kinds: ID_ONLY,
            notes: None,
        },
    ),
    (
        "qodercli",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Flag("--resume")),
            resume_session_kinds: ID_ONLY,
            notes: None,
        },
    ),
    (
        "qwen",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Flag("--resume")),
            resume_session_kinds: ID_ONLY,
            notes: None,
        },
    ),
    (
        "kilo",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Flag("--session")),
            resume_session_kinds: ID_ONLY,
            notes: None,
        },
    ),
    (
        "agy",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Flag("--conversation")),
            resume_session_kinds: ID_ONLY,
            notes: None,
        },
    ),
    (
        "grok",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Flag("--resume")),
            resume_session_kinds: ID_ONLY,
            notes: None,
        },
    ),
    (
        "letta",
        ProviderLaunchSpec {
            model: None,
            reasoning: None,
            permission_modes: NO_MODES,
            resume: Some(ResumeMap::Letta),
            resume_session_kinds: ID_ONLY,
            notes: None,
        },
    ),
];

/// Canonical kind labels → launch spec keys. `canonical_kind` maps
/// herdr's accepted aliases (mirroring `parse_agent_label`/
/// `lookup_agent` in herdr `src/detect/mod.rs`) onto the canonical
/// label so `claude-code` gets the same launch table as `claude`.
const KIND_ALIASES: &[(&str, &str)] = &[
    ("claude-code", "claude"),
    ("cursor-agent", "cursor"),
    ("antigravity", "agy"),
    ("antigravity-cli", "agy"),
    (".cline", "cline"),
    ("devin-cli", "devin"),
    ("devin cli", "devin"),
    ("github-copilot", "copilot"),
    ("ghcs", "copilot"),
    ("kimi-code", "kimi"),
    ("kimi code", "kimi"),
    ("kiro-cli", "kiro"),
    ("amp-local", "amp"),
    ("grok-build", "grok"),
    ("hermes-agent", "hermes"),
    ("kilo-code", "kilo"),
    ("kilo code", "kilo"),
    ("qoder", "qodercli"),
    ("qodercn", "qodercli"),
    ("qoderclicn", "qodercli"),
    ("qwen-code", "qwen"),
    ("qwen code", "qwen"),
    ("letta-code", "letta"),
    ("letta code", "letta"),
    ("muse-code", "muse"),
    ("muse-cli", "muse"),
    ("mastra-code", "mastracode"),
    ("mastra code", "mastracode"),
    ("opencode2", "opencode"),
    ("open-code", "opencode"),
];

fn launch_spec(kind: &str) -> Option<&'static ProviderLaunchSpec> {
    LAUNCH_SPECS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, spec)| spec)
}

/// `canonicalKind`: lowercase → alias → spec key → else the ORIGINAL
/// kind string (case preserved, per TS).
pub fn canonical_kind(kind: &str) -> String {
    let lower = kind.to_lowercase();
    if let Some((_, target)) = KIND_ALIASES.iter().find(|(k, _)| *k == lower) {
        return target.to_string();
    }
    if launch_spec(&lower).is_some() {
        return lower;
    }
    kind.to_string()
}

// --- Validation ---------------------------------------------------------------

const MAX_VALUE_LENGTH: usize = 1024;

/// JS `String.length` semantics: UTF-16 code units.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `/\p{Cc}/u` — Unicode category Cc (control characters).
fn has_control_chars(value: &str) -> bool {
    value.chars().any(|c| c.is_control())
}

fn assert_clean_value(value: &str, flag: &str) -> Result<(), ControlsError> {
    if value.is_empty() {
        return Err(ControlsError::usage(format!(
            "{} requires a non-empty value",
            flag
        )));
    }
    if js_len(value) > MAX_VALUE_LENGTH {
        return Err(ControlsError::usage(format!(
            "{} value exceeds {} characters",
            flag, MAX_VALUE_LENGTH
        )));
    }
    if has_control_chars(value) {
        return Err(ControlsError::usage(format!(
            "{} value contains control characters",
            flag
        )));
    }
    if value.starts_with('-') {
        // A leading dash would be parsed as a flag by the provider CLI —
        // values must never smuggle in extra options.
        return Err(ControlsError::usage(format!(
            "{} value must not start with '-'",
            flag
        )));
    }
    Ok(())
}

fn assert_clean_arg(arg: &str) -> Result<(), ControlsError> {
    if arg.is_empty() {
        return Err(ControlsError::usage("--arg requires a non-empty value"));
    }
    if js_len(arg) > MAX_VALUE_LENGTH {
        return Err(ControlsError::usage(format!(
            "--arg value exceeds {} characters",
            MAX_VALUE_LENGTH
        )));
    }
    if has_control_chars(arg) {
        return Err(ControlsError::usage("--arg value contains control characters"));
    }
    Ok(())
}

/// Privilege-escalation denylist for `--arg` passthrough (ADR-0018).
/// `values` rules inspect the flag's value — inline (`--flag=value`)
/// or the following argv element. Provider scoping keeps generic flags
/// like `-a`/`-s`/`-f` from being denied for providers where they mean
/// something else.
struct DenyRule {
    flag: &'static str,
    values: Option<&'static [&'static str]>,
    providers: Option<&'static [&'static str]>,
    reason: &'static str,
}

const DENY_RULES: &[DenyRule] = &[
    DenyRule {
        flag: "--dangerously-skip-permissions",
        values: None,
        providers: None,
        reason: "bypasses all claude permission checks",
    },
    DenyRule {
        flag: "--allow-dangerously-skip-permissions",
        values: None,
        providers: None,
        reason: "enables claude bypass-permissions as an option",
    },
    DenyRule {
        flag: "--dangerously-bypass-approvals-and-sandbox",
        values: None,
        providers: None,
        reason: "codex: skips all confirmations and sandboxing",
    },
    DenyRule {
        flag: "--dangerously-bypass-hook-trust",
        values: None,
        providers: None,
        reason: "codex: runs untrusted hooks",
    },
    DenyRule {
        flag: "--yolo",
        values: None,
        providers: None,
        reason: "auto-approve-all alias (gemini/cursor)",
    },
    DenyRule {
        flag: "--force",
        values: None,
        providers: Some(&["cursor"]),
        reason: "cursor-agent: force-allow commands",
    },
    DenyRule {
        flag: "-f",
        values: None,
        providers: Some(&["cursor"]),
        reason: "cursor-agent: force-allow commands",
    },
    DenyRule {
        flag: "-y",
        values: None,
        providers: Some(&["gemini"]),
        reason: "gemini: deprecated --yolo alias",
    },
    DenyRule {
        flag: "--auto",
        values: None,
        providers: Some(&["opencode"]),
        reason: "opencode: auto-approve permissions",
    },
    DenyRule {
        flag: "--permission-mode",
        values: Some(&["bypassPermissions"]),
        providers: None,
        reason: "claude bypassPermissions mode",
    },
    DenyRule {
        flag: "--approval-mode",
        values: Some(&["yolo"]),
        providers: None,
        reason: "gemini yolo approval mode",
    },
    DenyRule {
        flag: "--ask-for-approval",
        values: Some(&["never"]),
        providers: None,
        reason: "codex: never ask for approval",
    },
    DenyRule {
        flag: "-a",
        values: Some(&["never"]),
        providers: Some(&["codex"]),
        reason: "codex: never ask",
    },
    DenyRule {
        flag: "--sandbox",
        values: Some(&["danger-full-access"]),
        providers: None,
        reason: "codex: danger-full-access sandbox",
    },
    DenyRule {
        flag: "-s",
        values: Some(&["danger-full-access"]),
        providers: Some(&["codex"]),
        reason: "codex: danger-full-access sandbox",
    },
];

fn denied_arg_reason(args: &[String], kind: &str) -> Option<String> {
    for (i, arg) in args.iter().enumerate() {
        let eq = arg.find('=');
        let flag_part = match eq {
            Some(e) if e > 0 => &arg[..e],
            _ => arg.as_str(),
        };
        let inline_value = eq.and_then(|e| {
            if e > 0 {
                Some(arg[e + 1..].to_string())
            } else {
                None
            }
        });
        for rule in DENY_RULES {
            if rule.flag != flag_part {
                continue;
            }
            if let Some(providers) = rule.providers {
                if !providers.contains(&kind) {
                    continue;
                }
            }
            match rule.values {
                None => {
                    return Some(format!(
                        "--arg {} is denied: {} (use the structured option or --unsafe-args)",
                        arg, rule.reason
                    ));
                }
                Some(values) => {
                    let value = inline_value
                        .clone()
                        .or_else(|| args.get(i + 1).cloned());
                    if let Some(value) = value {
                        if values.contains(&value.as_str()) {
                            let suffix = if inline_value.is_none() {
                                format!(" {}", value)
                            } else {
                                String::new()
                            };
                            return Some(format!(
                                "--arg {}{} is denied: {} (use the structured option or --unsafe-args)",
                                arg, suffix, rule.reason
                            ));
                        }
                    }
                }
            }
        }
    }
    None
}

// --- Public API ---------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct LaunchRequest {
    /// Canonical kind (already through `canonical_kind`).
    pub kind: String,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub permission_mode: Option<String>,
    /// Raw resume value (`--resume`) — already validated.
    pub resume_value: Option<String>,
    /// Reported session kind when the value came from `--resume-from`
    /// (`null`/absent for a raw `--resume` value).
    pub resume_session_kind: Option<String>,
    /// Validated `--arg` passthrough values.
    pub extra_args: Vec<String>,
    /// Explicit opt-out of the privilege-escalation denylist.
    pub unsafe_args: bool,
}

pub struct BuiltLaunch {
    /// argv appended after the executable, in launch order.
    pub args: Vec<String>,
    /// Which structured options produced args (for the result echo).
    pub applied: Map<String, Value>,
}

fn unsupported(
    option: &str,
    kind: &str,
    spec: Option<&ProviderLaunchSpec>,
) -> ControlsError {
    let supported: Vec<&str> = spec
        .map(|s| {
            s.permission_modes
                .iter()
                .map(|(m, _)| *m)
                .collect()
        })
        .unwrap_or_default();
    let mut message = format!(
        "{} is not supported for agent kind '{}'",
        option, kind
    );
    if option == "permission-mode" && !supported.is_empty() {
        message.push_str(&format!("; supported modes: {}", supported.join(", ")));
    }
    let mut extra = Map::new();
    extra.insert("option".to_string(), json!(option));
    extra.insert("provider".to_string(), json!(kind));
    if option == "permission-mode" {
        extra.insert(
            "supported_modes".to_string(),
            Value::Array(supported.iter().map(|m| json!(m)).collect()),
        );
    }
    if let Some(notes) = spec.and_then(|s| s.notes) {
        extra.insert("provider_notes".to_string(), json!(notes));
    }
    ControlsError::new("unsupported_launch_option", message).with_extra(extra)
}

/// Build the provider argv for `agent.start`. Throws `ControlsError`
/// (`usage` / `unsupported_launch_option` / `unsafe_agent_argument`)
/// before any RPC is made.
pub fn build_launch_args(request: &LaunchRequest) -> Result<BuiltLaunch, ControlsError> {
    let spec = launch_spec(&request.kind);
    let mut args: Vec<String> = Vec::new();
    let mut applied = Map::new();
    applied.insert(
        "extra_args".to_string(),
        Value::Array(request.extra_args.iter().map(|a| json!(a)).collect()),
    );
    applied.insert("unsafe_args".to_string(), json!(request.unsafe_args));

    // 1. Passthrough args are validated first so a denied flag fails
    //    before any structured mapping is even considered.
    for arg in &request.extra_args {
        assert_clean_arg(arg)?;
    }
    if !request.unsafe_args {
        if let Some(reason) = denied_arg_reason(&request.extra_args, &request.kind) {
            return Err(ControlsError::new("unsafe_agent_argument", reason));
        }
    }

    // 2. Resume first: subcommand-style argv (codex `resume <id>`) must
    //    lead the argument list.
    if let Some(resume_value) = &request.resume_value {
        assert_clean_value(resume_value, "--resume")?;
        let spec_ref = spec.ok_or_else(|| unsupported("resume", &request.kind, spec))?;
        let resume_map = spec_ref
            .resume
            .ok_or_else(|| unsupported("resume", &request.kind, spec))?;
        let session_kind: Option<String> = request.resume_session_kind.clone();
        let kinds: &[&str] = if spec_ref.resume_session_kinds.is_empty() {
            ID_ONLY
        } else {
            spec_ref.resume_session_kinds
        };
        if let Some(sk) = &session_kind {
            if !kinds.contains(&sk.as_str()) {
                let mut extra = Map::new();
                extra.insert("option".to_string(), json!("resume"));
                extra.insert("provider".to_string(), json!(request.kind));
                extra.insert("session_kind".to_string(), json!(sk));
                return Err(ControlsError::new(
                    "unsupported_launch_option",
                    format!(
                        "resume session kind '{}' is not supported for agent kind '{}' (accepts: {})",
                        sk,
                        request.kind,
                        kinds.join(", ")
                    ),
                )
                .with_extra(extra));
            }
        }
        let resume_args = resume_map
            .build(resume_value)
            .ok_or_else(|| unsupported("resume", &request.kind, spec))?;
        applied.insert(
            "resume".to_string(),
            Value::Array(resume_args.iter().map(|a| json!(a)).collect()),
        );
        args.extend(resume_args);
    }

    // 3. Structured options in fixed order: model, reasoning,
    //    permission-mode.
    if let Some(model) = &request.model {
        assert_clean_value(model, "--model")?;
        let opt = spec
            .and_then(|s| s.model)
            .ok_or_else(|| unsupported("model", &request.kind, spec))?;
        let model_args = opt.build(model);
        applied.insert(
            "model".to_string(),
            Value::Array(model_args.iter().map(|a| json!(a)).collect()),
        );
        args.extend(model_args);
    }
    if let Some(reasoning) = &request.reasoning {
        assert_clean_value(reasoning, "--reasoning")?;
        let opt = spec
            .and_then(|s| s.reasoning)
            .ok_or_else(|| unsupported("reasoning", &request.kind, spec))?;
        let reasoning_args = opt.build(reasoning);
        applied.insert(
            "reasoning".to_string(),
            Value::Array(reasoning_args.iter().map(|a| json!(a)).collect()),
        );
        args.extend(reasoning_args);
    }
    if let Some(mode) = &request.permission_mode {
        let mode_args = spec
            .and_then(|s| {
                s.permission_modes
                    .iter()
                    .find(|(m, _)| m == mode)
                    .map(|(_, argv)| *argv)
            })
            .ok_or_else(|| unsupported("permission-mode", &request.kind, spec))?;
        applied.insert(
            "permission_mode".to_string(),
            Value::Array(mode_args.iter().map(|a| json!(a)).collect()),
        );
        args.extend(mode_args.iter().map(|a| a.to_string()));
    }

    // 4. Caller passthrough last so explicit --arg wins on conflicts
    //    (provider CLIs typically take the last occurrence).
    args.extend(request.extra_args.iter().cloned());

    Ok(BuiltLaunch { args, applied })
}

/// Launch-option summary for the capability payload.
pub fn launch_capability(kind: &str) -> Value {
    let spec = launch_spec(kind);
    let permission_modes = spec
        .map(|s| {
            let mut map = Map::new();
            for (mode, argv) in s.permission_modes {
                map.insert(
                    mode.to_string(),
                    Value::Array(argv.iter().map(|a| json!(a)).collect()),
                );
            }
            Value::Object(map)
        })
        .unwrap_or_else(|| Value::Object(Map::new()));
    let resume = match spec.and_then(|s| s.resume) {
        None => json!("unsupported"),
        Some(_) => {
            let kinds = spec
                .map(|s| s.resume_session_kinds)
                .filter(|k| !k.is_empty())
                .unwrap_or(ID_ONLY);
            json!(format!(
                "argv template; session kinds: {}",
                kinds.join("|")
            ))
        }
    };
    let mut out = Map::new();
    out.insert(
        "model".to_string(),
        json!(spec.and_then(|s| s.model).is_some()),
    );
    out.insert(
        "reasoning".to_string(),
        json!(spec.and_then(|s| s.reasoning).is_some()),
    );
    out.insert("permission_modes".to_string(), permission_modes);
    out.insert("resume".to_string(), resume);
    if let Some(notes) = spec.and_then(|s| s.notes) {
        out.insert("notes".to_string(), json!(notes));
    }
    Value::Object(out)
}
