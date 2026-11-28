//! rebuildup.machines — read-only saved-machine inventory and probe
//! (contract `herdr-plugins.machines/v1`, issue #161, parent #34,
//! boundary ADR-0028; native Rust port for #326).
//!
//! - CLI (`machines capability|help|list|probe`)
//! - interactive TUI (`machines tui main|open`, contract
//!   herdr-plugins.tui/v1)
//!
//! Machine lifecycle stays with the herdr CLI; probing goes through the
//! ADR-0020 SavedSshApiBridge path (`herdr --machine <id> <cli>`).

pub mod cli;
pub mod model;
pub mod remote;
pub mod state;
pub mod tui;
