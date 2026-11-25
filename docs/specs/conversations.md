# Conversations plugin (`rebuildup.conversations`) — specification

Scope: T1 foundation (#86) + T2 adapters/history (#87, parent #5) —
provider transcript discovery, normalization into structured events
(claude JSONL, codex rollout JSONL, opencode SQLite), identity
binding, staleness detection, and the `history` read API. Contract:
`herdr-plugins.conversations/v1`
(`docs/contracts/conversations-v1.md`). Design: ADR-0012. Upstream
mechanism reference: T3 Code `apps/server/src/usage/usageTranscriptReader.ts`
(pinned revision in `docs/program/feature-ledger.json`).

## Purpose

Give later tickets (#28 usage, #6 handoff, #88 search/pagination) a
shared, honest
transcript index: what the provider actually recorded, attributed to
the herdr identity that was live when it was indexed — without PTY
scraping, without fabricated structure, and without pretending
unsupported providers or missing files succeeded.

## Provider model

`capability.providers` is the support matrix:

- **claude** — supported. Transcript:
  `$CLAUDE_CONFIG_DIR/projects/<encode(cwd)>/<session-id>.jsonl`
  (default `~/.claude`). `encode(cwd)` replaces every non
  `[A-Za-z0-9]` byte with `-` (verified against claude 2.1.x layouts,
  e.g. `/Users/x/.dotfiles` → `-Users-x--dotfiles`).
- **codex** — supported (T2). Transcript: rollout JSONL under
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session-id>.jsonl`
  (default `~/.codex`), found by a depth-bounded walk of `sessions/`
  and `archived_sessions/` matching the session id in the file name.
  `.jsonl.zst` archives are compressed and resolve as
  `transcript_missing`.
- **opencode** — supported (T2). Transcript: SQLite
  `opencode.db`/`opencode-*.db` under `$OPENCODE_DATA_DIR` (comma
  list) else `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`,
  opened read-only; session resolved by id in `session_v2` (fallback
  `session`). Pre-SQLite `storage/**.json` layouts report
  `unsupported_layout`; a database without the session reports
  `session_not_found`.

Any other provider hint → `unknown_provider` skip.

## Transcript resolution

herdr's `AgentInfo.agent_session.value` is a session **id** (e.g. the
claude session UUID), not a path — `agent_session_path` is not exposed
(ADR-0012 upstream gap). Resolution order (claude):

1. `agent_session.value` that is itself a readable file path
   (defensive; some integrations may report paths).
2. `<projects>/<encode(cwd)>/<id>.jsonl` for the pane's cwd
   (`pane.cwd ?? agent.cwd ?? agent.foreground_cwd`).
3. `<id>.jsonl` in ANY immediate subdirectory of `projects/` —
   covers cwd-encoding drift and moved worktrees; the actual path is
   recorded in `transcript_path`.

No match → `transcript_missing` skip. The plugin never guesses at
alternate locations beyond the provider's known directory.

## Normalization (claude adapter)

One JSON object per transcript line → zero or more `ConversationEvent`s
(full schema: contract). Mapping:

| transcript `type` | events |
| --- | --- |
| `user`, string/block content, no `tool_result` | `turn` + `user_message` |
| `user`, content blocks incl. `tool_result` | `tool_result` per block (no turn boundary) |
| `assistant` | `assistant_message` (text/model/usage/cost) + `tool_call` per `tool_use` block |
| `system` | `system` (`subtype` carried, e.g. `compact_boundary`) |
| everything else (`attachment`, `file-history-*`, `api-request*`, `queue-operation`, `cost-state`, `mode`, …) | ignored — provider bookkeeping, not conversation |

Rules:

- `turn_index` increments on each genuine user prompt; events before
  the first prompt get `turn_index: null`. The counter persists in
  state (`turn_count`) so resumes stay monotonic.
- `thinking`/`redacted_thinking` blocks are provider internals —
  skipped, never surfaced as text.
- `usage` rides on `assistant_message` (v1 requirement for #28):
  `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, optional `thinking_tokens`. Missing
  usage is omitted, never zero-filled.
- Text/tool input bounded at 16 KiB/8 KiB with `*_truncated` flags.
- Malformed JSON lines increment `malformed_lines`; they never fail
  the scan and never produce events.

### codex adapter

Rollout lines are `{timestamp, ordinal, type, payload}` (verified
against codex CLI 0.169.x). Mapping:

| record | events |
| --- | --- |
| `event_msg` `item_completed` item `UserMessage` | `turn` + `user_message` |
| `event_msg` `item_completed` item `AgentMessage` | `assistant_message` |
| `event_msg` `user_message` / `agent_message` (legacy) | same as above |
| `response_item` `function_call`/`custom_tool_call`/`local_shell_call` (+`*_output`) | `tool_call` / `tool_result` (`call_id` ↔ `tool_use_id`) |
| `event_msg` `token_count`, top-level `token_usage_record` | usage attached to the current turn's last `assistant_message` |
| `turn_context` | carries `model` onto subsequent assistant events |
| everything else (`session_meta`, `response_item` `message`/`reasoning`, `world_state`, lifecycle `event_msg`s, …) | ignored — provider bookkeeping or duplicated streams, never fabricated |

`response_item` `message` records are deliberately skipped: they
duplicate the `event_msg` item stream and include developer/
instruction content (AGENTS.md, skills) that is not conversation.

### opencode adapter

SQLite is mutable and `seq`-ordered, so the byte-cursor machinery
does not apply: every `index` run fully rescans the session and
rewrites `events/<key>.jsonl` (`reindexed: true` always). Dedup is
structural — event ids derive from provider row/part ids, and the
rewrite is atomic. v2 (`session_message`, `data` JSON with embedded
`content[]`) and v1 (`message` + `part` tables) rows normalize to the
same events:

| row/part | events |
| --- | --- |
| `user` message | `turn` + `user_message` (`data.text` / text parts) |
| `assistant` message | `assistant_message` (text parts joined; `model` = `providerID/id`; `usage` from `tokens`; `cost`) + `tool_call`/`tool_result` per `content[]`/`part` `tool` entry (`callID` ↔ `tool_use_id`, `state.status`/`input`/`output`) |
| `compaction`, `system` message types | `system` (`subtype` carried) |
| lifecycle types (`idle`, `location-switched`, `model-switched`, `synthetic`, …) and `reasoning`/`step-*` parts | ignored — bookkeeping/provider internals |

Malformed `data` JSON increments `malformed_lines` per row. Epoch-ms
timestamps convert to ISO-8601; absent timestamps stay `null`.

## Incremental scanning

Per transcript, `state.json` keeps `cursor {offset, size, mtime_ms,
line_count}`, `guard_hash` (FNV-1a over ≤4 KiB preceding the offset —
the T3 `usageTranscriptReader` guard mechanism), and `turn_count`.

- Resume iff file not shrunk AND guard hash matches; otherwise full
  re-index from byte 0 with the event log rewritten.
- Only `\n`-terminated lines commit; a partial tail waits.
- Events append to `<stateDir>/events/<provider>:<session>.jsonl`
  (sanitized key); rewrites replace the file atomically (tmp+rename).
- Exception: opencode transcripts have no byte cursor — each index
  run rewrites the whole event log from a fresh SQLite scan.
- All state mutation happens under the single-writer lock
  (`state.json.lock`, stale 30 s, timeout 60 s) — concurrent CLI
  invocations cannot interleave cursor/event writes.

## History read API

`history (--pane PANE | --session-id REF) [--limit N] [--cursor OFF]
[--offline]` pages `events/<key>.jsonl` in transcript order. The
cursor is an opaque byte offset; only newline-terminated lines are
consumed, malformed lines are skipped and counted, and duplicate
`event_id`s within a page are dropped and counted. Selector
ambiguity is surfaced via `selector_note`, never resolved silently.
A missing events file returns `events: []` + `events_present: false`
with the record's `status`/`error` — never fabricated events. Live
staleness is computed exactly like `sessions` (best-effort, degrades
to `live: null`). Full shape: contract `history` section.

## Identity and staleness

Every event carries `identity` = the herdr binding at index time:
`host` (hostname), `herdr_session` (snapshot session name, else
`--session`/`HERDR_SESSION`/`"default"`), `workspace_id`, `tab_id`,
`pane_id`, `agent`, `agent_session {agent,kind,value}`,
`state_change_seq`.

`SessionRecord.key = <provider>:<session-id>` is stable across pane
rebinds — the same transcript keeps one record; `identity` records
the latest binding.

`sessions` computes staleness at read time against a live snapshot:
if the recorded `identity.pane_id` now reports a different
`agent_session.value`, the entry is `stale: true` with
`stale_reason: "agent_session_changed"` — pane-id reuse / agent
generation change. Stale entries are flagged, never deleted and never
silently re-attributed; consumers (#28/#88) must not apply a stale
index to the new generation. Offline/unreachable socket → `live:
null`, no stale verdict (never fabricated).

## State layout

```
<HERDR_PLUGIN_STATE_DIR>/
  state.json            # version, sessions{} registry (lock + rename)
  state.json.lock
  events/<provider>:<session>.jsonl   # sanitized → provider_session.jsonl
```

Nothing is written outside `HERDR_PLUGIN_STATE_DIR` /
`HERDR_PLUGIN_CONFIG_DIR` (config: optional `timeoutMs`).

## Explicit non-goals / upstream gaps

- **`agent_session_path` is not exposed** by herdr `AgentInfo` for
  claude/codex (hooks receive `transcript_path`/`agent_session_path`
  but `agent_resume.rs` discards them for non-pi agents). The plugin
  works around it with id+cwd+known-directory resolution; an additive
  upstream `agent_session_path` field is recorded as an Issue
  candidate for T4 (#89), benefiting #4/#6 too (ADR-0012).
- **Attention granularity** (approval/user-input/tool events) is not
  in transcripts' scope here; `pane.agent_status_changed` remains
  coarse — same root as #8.
- No daemon, no hooks, no PTY reads. Indexing is explicit CLI
  invocation; trigger automation lands with consumers.
