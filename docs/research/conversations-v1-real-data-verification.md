# Real-data verification — `rebuildup.conversations` v0.5.0 (#89 / parent #5 T4)

End-to-end verification of `herdr-plugins.conversations/v1` against
**real provider transcripts** on the maintainer's machine — not
fixtures. Covers `index`/`refresh`, `sessions`, `history`, `search`,
`usage`, `show`, incremental re-index, staleness, and honest
missing-transcript reporting.

- Plugin: `plugins/conversations` @ branch `89` (post-T3 `release-0-5-0`)
- herdr: `0.9.5` (protocol 22, isolated named session `verify89`)
- Bun: `1.4.4`; platform: macOS (arm64)
- Provider CLIs present: claude `2.1.330`, codex `0.171.0`,
  opencode `2.3.2`

## Environment

| Env | Isolation |
| --- | --- |
| herdr session | `verify89` under dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME` (`/var/tmp/herdr-plugin-89`) — the user's live `default` session was never targeted; all CLI calls used `--session verify89` or the session socket directly |
| plugin state | `HERDR_PLUGIN_STATE_DIR=/var/tmp/herdr-plugin-89/plugin-state`, `HERDR_PLUGIN_CONFIG_DIR=…/plugin-config` — nothing written outside these dirs or provider-owned transcript locations |
| provider data | **Real** `~/.claude/projects`, `~/.codex/sessions`, `~/.local/share/opencode/opencode.db` (read-only for the plugin; the resumed agents appended only what the providers themselves write on resume) |
| agents | Real `claude --resume`, `codex resume`, `opencode --session` processes in herdr panes `w1:p1/p2/p3`; `agent_session` bindings produced by the real integrations (opencode via `OPENCODE_CONFIG_DIR` pointing at a throwaway config with `herdr integration install opencode` output; claude/codex session ids reported through the same `herdr:<agent>` source the shipped hooks use) |

The user's live session, agents, and worktrees were not touched. The
isolated session was stopped and deleted afterwards; evidence retained
at `/var/tmp/herdr-plugin-89`.

## Transcripts under test

| provider | session id | transcript | size |
| --- | --- | --- | --- |
| claude | `5fc420d3-25ca-44ac-8a4a-a738cd1f63b6` | `~/.claude/projects/-Users-rebui-work-ahc074/….jsonl` | 9.4 MB |
| codex | `01a1f861-8d67-7042-9663-95ed0daf43e2` | `~/.codex/sessions/2026/11/20/rollout-…-01a1f861-….jsonl` | 7.6 MB |
| opencode | `ses_e32975909ffeWJLS0USEsL7DCM` | `~/.local/share/opencode/opencode.db` (`session_v2`, 1444 messages) | SQLite |

## Results

| # | Check | Result |
| --- | --- | --- |
| 1 | `capability` | `herdr-plugins.conversations/v1`, all 8 commands, 3 providers `supported`, `mutation_commands: [index, refresh]` — PASS |
| 2 | `index` (first run) | 3/3 indexed, 0 skipped, 5,864 events total: claude 1,489 (72 turns), opencode 4,369 (10 turns, `reindexed:true` per SQLite rescan contract), codex 6 (1 turn) — PASS |
| 3 | Transcript resolution | claude resolved via projects-dir fallback scan (pane cwd `/private/tmp` ≠ session cwd — the cwd-encoding heuristic alone would have missed; fallback found it); codex via `sessions/**` filename match; opencode via `session_v2` id lookup — PASS |
| 4 | Incremental re-`index` | claude/codex `events_appended: 0` (byte cursor + guard held); opencode full rescan rewrote 4,369 events (`reindexed: true`) — PASS, matches contract |
| 5 | `sessions` (live) | all 3 `status: ok`, `live` bindings resolved to `w1:p1/p2/p3`, `live_session: verify89`, `stale: false`, `transcript_present: true` — PASS |
| 6 | `history` | `--session-id` and `--pane` selectors both resolve; claude page `limit 3` → `next_cursor` byte offset, `has_more: true`, `events_size` 1.6 MB; codex `--pane w1:p2` returned all 6 events — PASS |
| 7 | `search` | `"release" --provider opencode` → 5 results with `matched_fields`, opaque base64url cursor; following `--cursor` returned the next page (`has_more: true`, `restarted_sessions: []`); `"Bash" --type tool_call` on claude → `matched_fields:["tool_name"]` — PASS |
| 8 | `usage` | claude → paginated `assistant_message` events carrying real provider usage (`input/output/cache_read/cache_creation/thinking` tokens); codex → 2 usage events — PASS (read surface for #28) |
| 9 | `show` | `turn:2` (claude) → 2 events; `turn:1` (codex) → all 6 events; `tool:call_b3452…` → exactly the `tool_call`/`tool_result` pair — PASS |
| 10 | Stale detection | re-reported `w1:p1`/`w1:p2` with different `agent_session_id` (+`session_start_source`) → `sessions` reported `stale: true`, `stale_reason: "agent_session_changed"` with the live value; restoring the real ids cleared staleness — PASS |
| 11 | `transcript_missing` honesty | bogus session ids → `index` `skipped[]` with `reason: "transcript_missing"` (never indexed, never fabricated); prior records stayed readable and flagged stale — PASS |
| 12 | Malformed/skip honesty | `malformed_lines: 0` on all three real transcripts; codex `response_item message/reasoning`, `ImageView` items, `world_state`, etc. correctly produced no events (6 events from a 7.6 MB rollout is the honest count — the bulk is embedded image/content payloads in skipped record types) — PASS |

## Upstream observations recorded

1. **`agent_session_path` gap — filed herdrdev/herdr#6191.** Herdr
   hooks already send `agent_session_path` for claude/codex, but
   `session_ref_from_report` (`src/agent_resume.rs`, v0.9.5) keeps
   only `agent_session_id` for non-pi/omp agents, so
   `AgentInfo.agent_session` is always `kind: "id"`. The plugin's
   id+cwd+known-directory resolution (ADR-0012) is the workaround;
   #6191 requests the additive path exposure. Benefits #4/#6 too.
2. **`session_start_source` required for session-id updates —
   herdrdev/herdr#5838 (already filed upstream).** Reproduced: a
   second `pane.report_agent_session` with a different
   `agent_session_id` returns `ok` but is ignored unless
   `session_start_source` is set. Real integrations always send it;
   only affects manual reporters.
3. **Attention granularity** — approval/user-input/tool-level events
   are not derivable from provider transcripts and
   `pane.agent_status_changed` stays coarse; same root as #8
   (`attention-granularity`, upstream-blocked). No workaround added,
   per #89.
4. **opencode integration install is global to `~/.config/opencode`**
   (ignores `XDG_CONFIG_HOME`); verification used a throwaway
   `OPENCODE_CONFIG_DIR` instead. Install+uninstall round-trip on the
   real config dir was exercised and fully reverted
   (`plugins/` empty, `tui.jsonc` back to `{}`).

## Verdict

`herdr-plugins.conversations/v1` verified end-to-end on real
claude/codex/opencode transcripts in an isolated herdr 0.9.5 session:
resolution, normalization, incremental scanning, all read APIs,
opaque-cursor paging, staleness, and honest missing-transcript
reporting all behave per contract. Contract marked stable (v0.5.0);
upstream gap filed as herdrdev/herdr#6191.

Residual: Linux/Windows official-install verification not exercised
(single-host macOS run); unit coverage is platform-neutral.
