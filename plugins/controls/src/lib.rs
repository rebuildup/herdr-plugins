//! rebuildup.controls — native Rust port (Issue #324, Program #286,
//! Wave-2 plan docs/research/wave2-native-migration-plan.md §3.1).
//!
//! Single binary serving two herdr surfaces:
//! - CLI contract `herdr-plugins.controls/v1` (`controls <command>`)
//! - interactive TUI (`controls tui [open|main]`, contract
//!   herdr-plugins.tui/v1)
//!
//! Domain modules mirror the frozen TypeScript implementation
//! (`plugins/controls/src/*.ts` @ the pinned pre-removal commit) one-to-one
//! so the `controls-v1` wire contract stays compatible: every operation is
//! a thin `agent.*`/`session.snapshot`/`pane.focus`/`plugin.pane.open`
//! socket wrapper with `--expect-*` stale-generation guards.

pub mod agentapi;
pub mod capability;
pub mod cli;
pub mod commands;
pub mod identity;
pub mod launch;
pub mod tui;
pub mod tui_model;
