# ADR-0012: Conversations as a provider-transcript indexer

Status: Accepted (release-0-5-0 candidate, Issue #86 / parent #5 T1)

## Context

Issue #5 (Conversations) needs provider session history — user /
assistant / tool call / tool result / turn events plus token usage —
as a shared substrate for #28 (usage), #6 (handoff), and the
search/pagination tickets #87/#88. herdr itself owns PTYs, workspaces,
tabs, panes, and agents; it does not expose conversation content.

Two candidate sources exist:

1. **PTY text scraping** — rejected by invariant: structured history
   must never be fabricated from terminal output.
2. **Provider-owned transcripts** — claude JSONL under
   `~/.claude/projects/`, codex rollout files, opencode SQLite. T3
   Code already proves this works at scale
   (`apps/server/src/usage/usageTranscriptReader.ts`): resolve files
   by session id + cwd + provider-known directories, scan
   incrementally with an offset cursor + content guard.

The binding problem: which transcript belongs to which herdr pane?
herdr's `AgentInfo.agent_session.value` carries the provider session
**id** (e.g. the claude UUID) — verified in the herdr-client typed
subset — but **not** the transcript path. Upstream research (#5
comment) found hooks receive `transcript_path`/`agent_session_path`
while `agent_resume.rs` discards them for non-pi agents, so
`AgentInfo` never exposes the path.

## Decision

**New plugin `rebuildup.conversations`** implementing
`herdr-plugins.conversations/v1`:

- **Resolution by id + cwd + known directories**, the
  `usageTranscriptReader` mechanism: `agent_session.value` (session
  id, not path) → `<config>/projects/<encode(cwd)>/<id>.jsonl`, with
  a fallback scan of the provider's projects directory for
  `<id>.jsonl`. A defensive path-valued `agent_session.value` is also
  honored. No match is `transcript_missing`, never a guess.
- **Normalized event schema v1** carries identity
  (host/herdr_session/workspace/tab/pane + `agent_session` +
  `state_change_seq`) on every event, plus `usage` token fields
  (`input/output/cache_read/cache_creation[/thinking]`) so #28 can
  aggregate without re-parsing.
- **Incremental index**: byte-offset cursor + FNV-1a guard hash over
  pre-offset bytes (same rewrite-detection mechanism as T3); only
  newline-terminated lines commit; state under
  `HERDR_PLUGIN_STATE_DIR` with single-writer lock + atomic rename;
  normalized events append to per-session `events/*.jsonl`.
- **Staleness is computed, not stored**: `sessions` compares each
  record's recorded identity against a live snapshot; a reused pane
  id reporting a different `agent_session.value` yields
  `stale: "agent_session_changed"`. Events keep the identity observed
  at index time — historical fact, never re-attributed.
- **Unsupported is explicit**: `capability.providers` declares
  claude `supported`, codex/opencode `unsupported` (adapters in #87).
  Unknown providers, missing `agent_session`, and missing transcripts
  are structured skips — never reported as indexed.

## Consequences

- T2 (#87) adds codex/opencode adapters behind the same
  resolve + normalize seam; the contract and state layout do not
  change. Landed shapes: codex rollout JSONL shares the
  byte-cursor incremental scanner; opencode SQLite cannot use a byte
  cursor (mutable, `seq`-ordered rows), so it fully rescans and
  rewrites the event log per index run — dedup stays structural via
  provider row ids. `history` pages `events/*.jsonl` with an opaque
  byte-offset cursor.
- T3 (#88) adds search/filtering over `events/*.jsonl` on top of the
  `history` pager — the index already carries everything it needs.
- **Upstream gap recorded** (Issue candidate for #89, benefits #4/#6):
  herdr should expose `agent_session_path` (or equivalent) on
  `AgentInfo` for claude/codex — additive, small, and would let the
  plugin skip the cwd-encoding heuristic entirely.
- Transcript formats can drift (claude 2.1.x observed); unknown line
  types are ignored rather than fatal, and `malformed_lines` surfaces
  decode failures honestly.
