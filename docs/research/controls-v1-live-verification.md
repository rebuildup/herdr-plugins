# Live verification — `rebuildup.controls` v0.6.0 (#102 / parent #27 T4)

End-to-end smoke of `herdr-plugins.controls/v1` against **real
providers** (claude 2.1.330, codex 0.171.0) on real herdr 0.9.5 —
complementing the fake-socket contract tests
(`tests/controls*.test.ts`). Scope per #102: send / wait / interrupt /
read / rename / start / command on ≥1 provider, plus the structured-
dialog boundary observed live.

- Plugin: `plugins/controls` @ branch `102` (post-T3 `release-0-6-0`)
- herdr: `0.9.5` (protocol 22, isolated named session `verify102`,
  headless `herdr server`)
- Bun: `1.4.4`; platform: macOS (arm64)
- Provider CLIs: claude `2.1.330` (`--permission-mode manual`),
  codex `0.171.0`

## Environment

| Env | Isolation |
| --- | --- |
| herdr session | `verify102` under dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`HERDR_CONFIG_PATH` (`/var/tmp/herdr-plugin-102`) — the user's live sessions were never targeted; every CLI call ran under `env -i` with only the isolated vars, `HERDR_SESSION=verify102`, and ambient `HERDR_*` socket/workspace vars unset |
| plugin state | `HERDR_PLUGIN_STATE_DIR`/`HERDR_PLUGIN_CONFIG_DIR` under `/var/tmp/herdr-plugin-102` (plugin is stateless; nothing written) |
| providers | Real `claude`/`codex` binaries via direct mise-install symlinks on a clean `PATH` (no shims); real `~/.claude`/`~/.codex` credentials via real `HOME` (read/use only what the providers themselves write) |
| panes | `w1:p1` (claude), `w1:p2` (codex, cwd `/var/tmp/herdr-plugin-102`) in the isolated session's default workspace |

The isolated session was stopped and deleted afterwards
(`herdr session delete verify102`); evidence retained at
`/var/tmp/herdr-plugin-102` (server log, env recipe in `env.sh`).

## Results

| # | Check | Provider | Result |
| --- | --- | --- | --- |
| 1 | `capability` | — | `herdr-plugins.controls/v1` v0.6.0; `dialogs` table present — approval/question/attachments/goals/subagent_approvals all `unsupported`, `interactive_fallback.status: pty_level` — PASS |
| 2 | `start` | claude | `start w1:p1 --agent claude --permission-mode supervised` → argv `[claude, --permission-mode, manual]`, `agent.start` readiness wait passed, post-launch `agent.wait` → `idle`, `interactive_ready: true` — PASS |
| 3 | blocked `send` | claude | Claude Code's folder-trust dialog put the agent `blocked`; `send` failed `requires_interactive_input` **without** calling `agent.prompt` (identity echoed, `state_change_seq: 2`) — PASS, live proof of the #102 dialog boundary |
| 4 | interactive fallback | claude | `read` showed the trust dialog in scrollback; `interrupt --keys down,enter` (PTY-level) selected "Yes, I trust this folder" and unblocked the agent — PASS; also `ctrl+u` cleared composer text |
| 5 | `send` + `wait` | claude | Prompt submitted (`agent_prompted`), status transitions observed to `idle`, `completion_seq` advanced, `agent_session` id `62fa7d83-…` reported — PASS mechanically; **provider turn failed honestly**: Claude subscription billing error ("can't use your Claude subscription"), surfaced only in scrollback — controls reported transport truth, not fabricated success |
| 6 | `start` | codex | `start w1:p2 --agent codex` → argv `[codex]`, readiness wait passed, `idle` — PASS |
| 7 | `send` + `wait` | codex | "Reply with exactly the word: ok" → `agent_prompted`, `agent_status` working→idle, `completion_seq: 10`; `read` shows codex answered `ok` — PASS end-to-end |
| 8 | `rename` + `wait` | codex | `rename --name codex-verify` echoed new name; `wait --until idle` resolved immediately — PASS |
| 9 | `command` passthrough | codex | `command /status` submitted literal `/status` via `agent.prompt`; codex TUI opened its status dialog (`known_command: true`, `fragile: true`); `interrupt --keys esc` closed it — PASS, fragility label accurate |
| 10 | `interrupt` mid-turn | codex | `send` with `--wait-until working` observed `working`; `interrupt --keys esc` during the turn → scrollback "Conversation interrupted", status returned `idle`, `completion_seq: 12` — PASS (PTY-level, as documented) |
| 11 | generation guard | codex | `send --expect-state-seq 999` → `stale_generation` with expected/actual mismatch, no `agent.prompt` sent — PASS live |

## Upstream observations recorded

1. **Structured dialog boundary confirmed live.** The claude
   folder-trust dialog is exactly the #102 gap: `agent_status:
   blocked`, `send` refused, no structured options/answers — only
   scrollback text + PTY keys. Tracked upstream as
   herdrdev/herdr#6196.
2. **Socket request timeout ≠ wait timeout.** `agent.prompt` with a
   long `wait.timeout_ms` still needs the CLI `--timeout` (default
   10 s) raised above the expected wait, or the client gives up while
   the server keeps waiting — the first `send` attempt timed out
   client-side yet the text had already been typed into the pane
   (partial composer residue observed). Callers must size `--timeout`
   for the wait they request; noted for consumers, contract already
   documents both knobs.
3. **`agent_session` reporting is provider/integration dependent.**
   claude reported `kind: "id"` via `herdr:claude`; codex reported
   `agent_session: null` in this setup (no integration installed in
   the isolated env). Identity echo stays honest — null, never
   fabricated.
4. **claude subscription unusable** on this machine at verification
   time (billing error) — provider-side, unrelated to the plugin;
   codex carried the full send→reply evidence instead.

## Verdict

`herdr-plugins.controls/v1` verified end-to-end on real herdr 0.9.5
with real claude + codex agents in an isolated named session: `start`,
`send`/`wait`, `interrupt` (incl. mid-turn and dialog fallback),
`read`, `rename`, `command` passthrough, blocked-send rejection, and
stale-generation guards all behave per contract. Contract marked
stable at plugin v0.6.0; structured dialogs remain `unsupported` with
upstream requests filed (herdrdev/herdr#6196 dialogs, #6197
queue/steer).

Residual: Linux/Windows official-install verification not exercised
(single-host macOS run); unit coverage is platform-neutral.
