# Live verification — `rebuildup.artifacts` v0.2.0 (#143 / parent #31 T4)

End-to-end smoke of `herdr-plugins.artifacts/v1` T4 scope — `deliver`
(path-in-prompt attachment), `gc` retention, `export` client surface,
referenced-delete refusal, and contract stabilization — against
**real herdr 0.9.5** in an isolated named session, complementing the
fake-transport contract tests (`tests/artifacts-t4.test.ts`, 12 tests;
full artifacts suite 51 tests).

- Plugin: `plugins/artifacts` @ branch `143` (release-0-7-0 train)
- herdr: `0.9.5` (protocol 22, isolated named session `verify143`,
  headless `herdr server`)
- Bun: `1.4.4`; platform: macOS (arm64)
- Provider: real `codex 0.171.0` (direct mise-install symlink on a
  clean `PATH`; real `~/.codex` credentials via real `HOME`)

## Environment

| Env | Isolation |
| --- | --- |
| herdr session | `verify143` under dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`HERDR_CONFIG_PATH` (`/var/tmp/herdr-plugin-143`) — the user's live sessions were never targeted; every CLI call ran with ambient `HERDR_*` socket/workspace vars unset and `HERDR_SESSION=verify143` |
| plugin state | `HERDR_PLUGIN_STATE_DIR`/`HERDR_PLUGIN_CONFIG_DIR` under `/var/tmp/herdr-plugin-143` |
| providers | Real `codex` binary via direct symlink (no shims — the `~/.local/bin` mise shim fails on untrusted config in a clean env) |
| panes | `w2:p1` (plain shell, workspace `verify143-a`), `w3:p1` (codex agent `verify143-agent`, workspace `verify143-b`) |

The isolated session was stopped and deleted afterwards
(`herdr session stop/delete verify143`). Evidence retained at
`/var/tmp/herdr-plugin-143` (server log, `env.sh` recipe, plugin
state, source files).

## Results

| # | Check | Result |
| --- | --- | --- |
| 1 | `capability` | `contract_status:"stable"`, version `0.2.0`, all 11 commands implemented, `planned_commands:[]` — PASS |
| 2 | `register` state_copy html | `art-7c040666d3ce10708b6e2ad6`, kind html, sha256/size/mime recorded, `meta.render` isolation notice — PASS |
| 3 | `register` path_ref + `--ref` | `art-27fc0d118af57b1486cea684`, external realpath stored, `refs:["conversations:session/verify143-smoke"]` — PASS |
| 4 | `deliver --pane` stale target | `w9:p9` → `target_not_found` (kind `not_found`), exit 1, nothing sent — PASS |
| 5 | `deliver --agent` agentless pane | `w2:p1` (shell) → `agent_not_found`, exit 1 — PASS |
| 6 | `deliver --pane` live shell | `pane.send_text` delivered the `[artifacts]` message with `path:`/`mime:`/`size:`/`sha256:`/`note:` lines; visible in `pane.read` scrollback — PASS (see upstream observation 1) |
| 7 | `deliver --agent` live codex | `agent.prompt` to `w3:p1`; codex read `report.html` at the delivered path and replied with the embedded marker `live-check-marker-7f3a` — the register→deliver→agent-reads-file loop works end to end — PASS |
| 8 | `delete` referenced artifact | `art-27fc…` (non-empty `refs`) → `referenced` (kind `warning`), exit 1, record kept — PASS |
| 9 | `export` | complete annotated index (`total:2`, `complete:true`) before gc — PASS |
| 10 | `gc --dry-run` | both records expired vs future bound: `would_delete` for unreferenced state_copy, `skipped`/`referenced` for the path_ref record; zero mutation — PASS |
| 11 | `gc` apply | deleted the state_copy record + payload dir; referenced path_ref record kept; **external file `/var/tmp/…/sources/external.txt` untouched**; ran with a dead `HERDR_SOCKET_PATH` (offline) — PASS |

## Upstream observations recorded

1. **`pane.send_text` newlines act as Enter on shell panes.** The
   multi-line delivery message typed into shell pane `w2:p1` was
   executed line-by-line by zsh (`zsh: no matches found: [artifacts]`,
   `command not found: path:` …). `pane.send_text` is literal text with
   no submit, but embedded `\n` still reaches the PTY as Enter. For
   `--pane` targets that are interactive shells this means delivery
   text *executes*; consumers should prefer `--agent` for agent panes
   and treat `--pane` as literal-text-only. Contract note added; not a
   plugin defect — the plugin sent exactly the documented text.
   Candidate upstream issue: a `pane.send_text` variant that bracketed-
   pastes or escapes newlines for shell targets (low priority; v1
   works around by documenting).
2. **`agent.prompt` → file read loop confirmed.** A real codex agent
   consumed the delivered absolute path unprompted-by-plugin and read
   the artifact — the ADR-0024 §3 v1 attachment definition is
   sufficient for path-capable providers; no structured attachment API
   is required for v1.

## Upstream issue filing decision

- **Structured pane/agent attachment API** (protocol 22 gap,
  ADR-0024 §3): filed as
  [herdrdev/herdr#6200](https://github.com/herdrdev/herdr/issues/6200).
  #6196 (closed by the rate-limit bot) covered attachments only inside
  a broader dialog-events request, so a focused issue was warranted.
- `pane.send_text` newline/Enter behavior (observation 1): folded
  into the same upstream issue as a secondary note rather than a
  separate filing.

## Contract stability statement

`herdr-plugins.artifacts/v1` is **stable** as of this ticket: T4 added
`deliver`/`gc`/`export`, the cross-plugin `refs` convention, specific
`error.code` values, and the live-verification evidence above. All
changes since the draft skeleton are additive; no field was removed,
renamed, or re-typed.
