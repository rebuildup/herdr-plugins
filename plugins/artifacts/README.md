# rebuildup.artifacts

Artifact registry for herdr: registers, validates, indexes, and
delivers references to generated files (HTML pages, images, PDFs,
generic files). Contract: `herdr-plugins.artifacts/v1` — **stable**;
see [`docs/contracts/artifacts-v1.md`](../../docs/contracts/artifacts-v1.md),
the specification
[`docs/specs/artifacts.md`](../../docs/specs/artifacts.md), and the
design boundary
[`docs/adr/0024-artifacts-boundary.md`](../../docs/adr/0024-artifacts-boundary.md).

## What it does

`register` snapshots a file into plugin state (`state_copy`, default)
or records an external `path_ref` (opt-in); `list`/`get`/`search`/`verify`
read and re-check the index with honest
`missing_ref`/`owner_stale`/`oversize` reporting; `delete` removes
artifacts (`--force` required when `refs` exist). `deliver` sends the
artifact's stable absolute path to an agent (`agent.prompt`) or pane
(`pane.send_text`) — the v1 attachment definition; no structured
attachment API exists in herdr protocol 22. `gc` collects unreferenced
records older than `--older-than` (`--dry-run` previews; `path_ref`
external files are never deleted). `export` emits the complete
annotated index for client sync (herdr-t3 read surface).

## What it does NOT do

- It never executes, renders, or proxies artifact content. Isolated
  HTML rendering, screenshots, and network/CSP policy are herdr-t3
  responsibilities (ADR-0024 §4).
- SnapShots (OS window capture) and browser import are out of scope
  (desktop/GUI). MCP Apps UI is upstream-blocked on #30.

## Status

T1–T4 complete (#136/#141/#142/#143): all eleven commands implemented;
contract `herdr-plugins.artifacts/v1` is **stable** (additive changes
only). TUI surface added in #247 (`herdr-plugins.tui/v1`): a `main`
pane entrypoint plus an `open` action — see below. Session-bound
commands need a reachable herdr session (`session.snapshot`) for
identity and staleness reporting; `gc` runs offline.

## Interactive TUI (#247)

```toml
# herdr-plugin.toml (already declared)
[[panes]] id = "main"  placement = "tab"  command = ["bun","run","src/tui.ts","main"]
[[actions]] id = "open" contexts = ["pane","workspace"]  command = ["bun","run","src/tui.ts","open"]
```

- `open` pins the origin context once and calls `plugin.pane.open`
  with `placement = "tab"`, forwarding the pins as `HERDR_TUI_*` env
  vars. `HERDR_PANE_ID` inside the UI is the UI pane's own surface
  identity — never a mutation target.
- The UI consumes this plugin's own CLI (`src/cli.ts`) for every read
  and mutation, so the public contract stays the single source of
  truth. Opening performs reads only (`list`/`get`).
- Surfaces: artifact list with `/` filter and server-side `s`earch,
  per-artifact detail (metadata + resolved path; the plugin never
  renders payload bytes — html/image/pdf get an explicit `o`pen
  externally via the OS handler), `v`erify integrity, `n` register
  (path/kind/storage/title/refs + confirm), `l` deliver path
  reference to a pane/agent (confirm), `d` delete (confirm; a
  referenced artifact earns a second explicit force confirm), and
  `g` gc — always dry-run preview first, collection only after an
  explicit confirm.
- Every mutation is confirm-gated (exact target + consequence, Esc
  cancels), checked against `capability`/`mutation_commands` (fail
  closed when unavailable), and re-validates the artifact via `get`
  immediately before writing — a vanished artifact aborts `stale`, a
  changed sha256/path asks before applying.
- Non-TTY stdin degrades to a plain-text artifact list; the
  non-interactive CLI is unchanged.

Opt-in keybind (user-owned; plugins never write herdr config):

```toml
[[keys.command]]
key = "prefix+A"
type = "plugin_action"
command = "rebuildup.artifacts.open"
description = "open artifacts TUI"
```

## Usage

```bash
cd <plugin_root>
bun run src/cli.ts capability
bun run src/cli.ts register --path report.html --title "Weekly report"
bun run src/cli.ts list --kind html
bun run src/cli.ts get art-<id>
bun run src/cli.ts search "weekly" --kind html
bun run src/cli.ts verify [art-<id>]
bun run src/cli.ts deliver --agent <pane_id> art-<id> [--note TEXT]
bun run src/cli.ts deliver --pane <pane_id> art-<id>
bun run src/cli.ts gc --older-than 2026-01-01T00:00:00Z [--dry-run]
bun run src/cli.ts export [--kind html] [--limit N]
bun run src/cli.ts delete art-<id> [--force]
```

Prerequisite: Bun on PATH (same as every plugin here).
