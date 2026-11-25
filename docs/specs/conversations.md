# Conversations plugin (`rebuildup.conversations`) — specification

Scope: T1 foundation (#86, parent #5) — provider transcript discovery,
incremental normalization into structured events, identity binding,
and staleness detection. Contract: `herdr-plugins.conversations/v1`
(`docs/contracts/conversations-v1.md`). Design: ADR-0012. Upstream
mechanism reference: T3 Code `apps/server/src/usage/usageTranscriptReader.ts`
(pinned revision in `docs/program/feature-ledger.json`).

## Purpose

Give later tickets (#28 usage, #6 handoff, #87 codex/opencode
adapters + history reads, #88 search/pagination) a shared, honest
transcript index: what the provider actually recorded, attributed to
the herdr identity that was live when it was indexed — without PTY
scraping, without fabricated structure, and without pretending
unsupported providers or missing files succeeded.

## Provider model

`capability.providers` is the support matrix. v1:

- **claude** — supported. Transcript:
  `$CLAUDE_CONFIG_DIR/projects/<encode(cwd)>/<session-id>.jsonl`
  (default `~/.claude`). `encode(cwd)` replaces every non
  `[A-Za-z0-9]` byte with `-` (verified against claude 2.1.x layouts,
  e.g. `/Users/x/.dotfiles` → `-Users-x--dotfiles`).
- **codex**, **opencode** — `unsupported` with `reason` +
  `planned_in: "#87"`. Panes running them appear in `index`'s
  `skipped` as `unsupported_provider`; they are never indexed and
  never reported as success.

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

## Incremental scanning

Per transcript, `state.json` keeps `cursor {offset, size, mtime_ms,
line_count}`, `guard_hash` (FNV-1a over ≤4 KiB preceding the offset —
the T3 `usageTranscriptReader` guard mechanism), and `turn_count`.

- Resume iff file not shrunk AND guard hash matches; otherwise full
  re-index from byte 0 with the event log rewritten.
- Only `\n`-terminated lines commit; a partial tail waits.
- Events append to `<stateDir>/events/<provider>_<session>.jsonl`
  (sanitized key); rewrites replace the file atomically (tmp+rename).
- All state mutation happens under the single-writer lock
  (`state.json.lock`, stale 30 s, timeout 60 s) — concurrent CLI
  invocations cannot interleave cursor/event writes.

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
