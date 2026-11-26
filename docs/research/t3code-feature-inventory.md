# Research: T3 Code feature inventory vs herdr

> **Note (Issue #40)**: 本書は初期調査の履歴として保持する。機能台帳・
> 依存グラフ・後続リリース計画の正本は [`docs/program/`](../program/README.md)
> (`feature-ledger.json` + `README.md`) に移行した。新規の分類・対応付けは
> 正本側を更新すること。

Pinned revisions: `t3code` @ `9cc4018c`, `herdr` @ `e430afb` (source) +
installed v0.9.5, `herdr-t3` @ `e430afb`… see repo notes; `project-init` @
`285b139b`.

Classification: **reuse** (existing herdr/plugin capability), **new-plugin**
(this repo), **provider-adapter**, **gui-only**, **upstream-api** (blocked on
herdr/T3Code upstream changes).

## Inventory

| T3 Code feature | herdr equivalent today | Classification | Notes |
| --- | --- | --- | --- |
| Thread inbox / settle / snooze | none (herdr-t3 #173 open) | **new-plugin → `rebuildup.inbox`** | UI-layer organize state; v0.1 contract in `docs/contracts/inbox-v1.md` |
| Git status / diff / staging / commit / push / PR | none in herdr core | **new-plugin (candidate)** | Needs per-worktree git ops; no daemon; CLI contract first |
| Project scripts (per-project commands, run/stop/results) | herdr can spawn panes; no registry | **new-plugin (candidate)** | Depends on pane lifecycle events; result capture needs output subscriptions |
| Checkpoints (save/restore work state, diffs) | none | **new-plugin (candidate)** | Must preserve uncommitted/untracked/shared-worktree state; provider conversation rewind is a separate capability |
| Conversations (provider history, structured events, search, usage) | partial via `agent.list`/tokens | **provider-adapter + new-plugin** | Provider session files differ per agent; structured event extraction is provider-specific |
| Handoff (cross-session context transfer) | Agent Router exists in user env | **provider-adapter** | Coordinate with Agent Router; do not reimplement routing |
| Approval / user-input prompts | `agent_status=blocked` signal only | **upstream-api gap** | T3 distinguishes approval vs input vs subagent-request; herdr exposes only `blocked`. Documented gap in `docs/specs/inbox.md` |
| Thread metadata / pins / custom sections | pane metadata tokens | **reuse + projection** | `pane.report_metadata` is the projection surface |
| Diff review UI, file tree, editor | n/a (TUI/GUI concern) | **gui-only (herdr-t3)** | Not a plugin concern |
| Cloud sync / mobile | n/a | **out of scope** | — |
| Provider runtime / orchestration | herdr owns PTY+agents | **do not duplicate** | Architecture invariant |

## Key upstream gaps found (record, don't work around silently)

1. **Attention granularity** — herdr `agent_status` collapses approval,
   user-input, and failure into `blocked` (and possibly `done`). Plugins
   cannot distinguish them without PTY scraping, which is forbidden by the
   no-fabrication rule. Candidate upstream request: richer agent status or
   structured attention events.
2. **Agent View slots** — single global `agent.view` slot; plugins cannot
   safely project views (ADR-0004).
3. **Plugin runtime registration** — v1 plugins are argv-only; no in-process
   hooks. Event hooks + socket subscriptions cover current needs.
4. **Managed plugin storage** — none; plugins self-manage under
   `HERDR_PLUGIN_STATE_DIR` (ADR-0001).
5. **`pane.output_changed` hooks** — excluded from `PLUGIN_HOOK_EVENT_KINDS`
   by design (high volume); output-driven features must use
   `events.subscribe` + `pane.output_matched` filters.

## Release-train seeds

- `release-0-1-0`: repo bootstrap + `rebuildup.inbox` (this train).
- Candidate next: Git plugin (status/diff read-only first), Project Scripts.
  Checkpoints and Conversations need upstream investigation before sizing.
