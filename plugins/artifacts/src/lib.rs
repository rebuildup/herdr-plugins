//! rebuildup.artifacts — native Rust port (Issue #325, Program #286).
//!
//! Single binary serving two herdr surfaces:
//! - CLI contract `herdr-plugins.artifacts/v1` (`artifacts <command>`)
//! - interactive TUI (`artifacts tui`, contract herdr-plugins.tui/v1)
//!
//! Domain modules mirror the frozen TypeScript implementation
//! (`plugins/artifacts/src/*.ts`) one-to-one so the `artifacts-v1` wire
//! contract and the on-disk state schema (v1) stay compatible.

pub mod cli;
pub mod model;
pub mod registry;
pub mod state;
pub mod tui;
pub mod tui_model;
