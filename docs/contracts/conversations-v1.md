# Contract `herdr-plugins.conversations/v1`

Structured JSON CLI contract for the `rebuildup.conversations` herdr
plugin — a provider transcript indexer that normalizes session
transcripts (claude JSONL, codex rollout JSONL, opencode SQLite) into
structured conversation events.
Follows the same conventions as `herdr-plugins.projects/v1` /
`herdr-plugins.checkpoints/v1`.

PTY text is never read. Every indexed event comes from a
provider-owned transcript file resolved via `agent_session` + `cwd` +
provider-known directories (the mechanism T3 `usageTranscriptReader`
proved; see ADR-0012).

## Discovery

1. `herdr plugin list --json` → find `plugin_id == "rebuildup.conversations"` →
   `plugin_root`.
2. `cd <plugin_root> && bun run src/cli.ts capability` → verify
   `contract == "herdr-plugins.conversations/v1"` and the commands you
   need exist.

## Invocation

```bash
cd <plugin_root>
bun run src/cli.ts capability
bun run src/cli.ts index [--session NAME] [--socket PATH] [--timeout MS]
bun run src/cli.ts refresh   # alias of index
bun run src/cli.ts sessions [--offline]
bun run src/cli.ts history (--pane PANE | --session-id ID) [--limit N] [--cursor OFF] [--offline]
bun run src/cli.ts search <query> [--pane PANE] [--session-id ID] [--provider ID] [--type TYPE] [--limit N] [--cursor CUR] [--offline]
bun run src/cli.ts usage [--pane PANE] [--session-id ID] [--provider ID] [--limit N] [--cursor CUR] [--offline]
bun run src/cli.ts show <ref> [--pane PANE] [--session-id ID] [--provider ID] [--offline]
```

- All commands print exactly one JSON document on stdout. Handled
  errors print `{contract, ok:false, error:{code,message,kind?}}` on
  **stderr** and exit 1; usage errors exit 2.
- `index`/`refresh` require a reachable herdr session; unreachable →
  `{kind:"session_unreachable"}` exit 1. `capability` and
  `sessions --offline` work without herdr.
- Indexing mutates only plugin state (`HERDR_PLUGIN_STATE_DIR`); it
  never writes herdr state or provider files. `capability` reports
  `read_only: false`,
  `mutation_commands: ["index","refresh"]`.

## `capability`

```json
{
  "contract": "herdr-plugins.conversations/v1",
  "command": "capability",
  "plugin": "rebuildup.conversations",
  "version": "0.5.0",
  "read_only": false,
  "mutation_commands": ["index", "refresh"],
  "commands": ["capability", "index", "refresh", "sessions", "history", "search", "show", "usage"],
  "providers": [
    { "id": "claude", "status": "supported", "formats": ["claude-jsonl"], "usage": { "cache_tokens": "reported" } },
    { "id": "codex", "status": "supported", "formats": ["codex-rollout-jsonl"], "usage": { "cache_tokens": "reported" } },
    { "id": "opencode", "status": "supported", "formats": ["opencode-sqlite"], "usage": { "cache_tokens": "reported" } }
  ],
  "event_types": ["turn", "user_message", "assistant_message", "tool_call", "tool_result", "system"],
  "notes": ["…"],
  "generated_at": "…"
}
```

`providers` is the authoritative support matrix: `supported` providers
have working adapters; `unsupported` providers are declared with a
`reason` (and `planned_in` ticket) so consumers can distinguish "not
implemented yet" from "unknown provider". The list extends additively.

Additive per-provider `usage` object (v1, consumed by
`rebuildup.usage` T3 / #92): `cache_tokens` is `"reported"` when the
adapter maps provider cache read/write token fields into
`usage.cache_*_input_tokens`, `"unsupported"` when the provider's
accounting is not mapped — explicit, so consumers never read a silent
zero as "no cache tokens".

## Transcript resolution

For each pane agent in `session.snapshot`:

1. Provider id comes from `agent.agent` / `agent_session.agent|kind`
   (`claude`, `codex`, `opencode`; anything else →
   `unknown_provider`).
2. Session id comes from `agent_session.value` — a provider session
   **id**, never assumed to be a path (upstream does not expose
   `agent_session_path`; ADR-0012).
3. Provider-known directories + cwd locate the transcript:
   - claude: `$CLAUDE_CONFIG_DIR/projects/<encode(cwd)>/<id>.jsonl`
     (default `~/.claude`), falling back to `<id>.jsonl` in any
     immediate subdirectory of `projects/`.
   - codex: `$CODEX_HOME/sessions/**` and `archived_sessions/**`
     (default `~/.codex`), depth-bounded walk for a `.jsonl` rollout
     whose file name carries the session id. `archived_sessions`
     entries are `.jsonl.zst` compressed and resolve as missing —
     they are never silently skipped or decompressed.
   - opencode: `$OPENCODE_DATA_DIR` (comma-separated) else
     `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`; the
     `opencode.db` / `opencode-*.db` SQLite database is opened
     read-only and the session is looked up by id (`session_v2`,
     falling back to `session`). Pre-SQLite file storage
     (`storage/**.json`) is reported as `unsupported_layout`.

No match → `transcript_missing` (or `session_not_found` /
`unsupported_layout` for opencode); the plugin never guesses at
alternate locations beyond the provider's known directory.

## Normalized event schema

Every event is one JSON object:

```json
{
  "event_id": "u-1" ,
  "type": "assistant_message",
  "timestamp": "2026-01-01T00:00:02.000Z",
  "identity": {
    "host": "macbook",
    "herdr_session": "default",
    "workspace_id": "w1",
    "tab_id": "w1:t1",
    "pane_id": "w1:p1",
    "agent": "claude",
    "agent_session": { "agent": "claude", "kind": "session", "value": "<uuid>" },
    "state_change_seq": 7
  },
  "turn_index": 1,
  "model": "claude-test-1",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 5,
    "cache_read_input_tokens": 3,
    "cache_creation_input_tokens": 2,
    "thinking_tokens": 1
  },
  "text": "on it",
  "tool_use_id": "tool-1",
  "tool_name": "Bash",
  "tool_input": { "command": "ls" },
  "is_error": false,
  "subtype": "compact_boundary",
  "sidechain": true
}
```

- `event_id` — provider `uuid` when present, else `<file>:<line>`;
  tool events append `:tool:<id>` / `:result:<id>` / `:message`
  suffixes so ids are unique within a transcript.
- `timestamp` — provider timestamp (ISO-8601 string as recorded);
  `null` when absent. Never synthesized.
- `identity` — herdr binding observed **at index time**. It is a
  historical fact, not a live lookup: pane ids are reused and agent
  generations change, so consumers must treat it as "what herdr
  reported when this was indexed" (see `sessions` staleness).
- `turn_index` — 1-based turn counter; `null` before the first user
  prompt. `turn` events mark user-prompt boundaries.
- `sidechain` — present (`true`) only on provider sidechain/subagent
  lines.

### Per-type payload matrix

| type | extra fields |
| --- | --- |
| `turn` | — (boundary marker; `turn_index` set) |
| `user_message` | `text`, `text_truncated?` |
| `assistant_message` | `text?`, `text_truncated?`, `model?`, `usage?`, `cost_usd?` |
| `tool_call` | `tool_use_id?`, `tool_name?`, `tool_input?`, `input_truncated?` |
| `tool_result` | `tool_use_id?`, `text?`, `text_truncated?`, `is_error?` |
| `system` | `subtype?` |

`usage` (v1, consumed by #28): `input_tokens`, `output_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, optional
`thinking_tokens`. All counts are provider-reported; absent usage is
`null`/omitted, never zero-fabricated.

Text and tool input are bounded (`MAX_TEXT_CHARS` = 16384,
`MAX_INPUT_CHARS` = 8192); `*_truncated` flags mark elision. The index
is navigational — T2/T3 own full-fidelity history reads.

## `index` / `refresh`

Scans the session snapshot, resolves transcripts, and incrementally
normalizes new bytes. Response:

```json
{
  "contract": "herdr-plugins.conversations/v1",
  "command": "index",
  "indexed": [
    {
      "key": "claude:<session-id>",
      "provider": "claude",
      "session_id": "<session-id>",
      "transcript_path": "/abs/…/<session-id>.jsonl",
      "events_appended": 6,
      "total_events": 6,
      "reindexed": false,
      "malformed_lines": 0
    }
  ],
  "skipped": [
    { "pane_id": "w1:p2", "provider": "opencode", "session_id": "ses_…", "reason": "session_not_found", "cwd": "/repo", "transcript_path": "/…/opencode.db" },
    { "pane_id": "w1:p3", "provider": "claude", "session_id": "…", "reason": "transcript_missing", "cwd": "/repo" }
  ],
  "sessions_indexed": 1,
  "events_appended": 6,
  "generated_at": "…"
}
```

`skipped[].reason` values: `unknown_provider` (agent reports no known
provider), `unsupported_provider` (declared but no adapter),
`no_agent_session` (agent exposes no session identity),
`transcript_missing` (resolution found no transcript),
`session_not_found` (opencode database exists but the session id is
absent), `unsupported_layout` (opencode pre-SQLite `storage/` JSON
layout), `open_failed`/`read_failed`/`sqlite_*` from the scanners.
Nothing unsupported or missing is ever reported as indexed.

### Incremental scanning

State per transcript (`state.json`): byte `cursor` (offset + size +
mtime + committed line count), `guard_hash` (FNV-1a over up to 4 KiB
preceding the offset), `turn_count`. A resume requires the file not
shrunk and the guard to match; otherwise the transcript is
re-indexed from byte 0 and its event log rewritten. Only
newline-terminated lines commit; an unterminated tail waits for the
next scan. Malformed JSON lines are counted in `malformed_lines`,
never fatal, never fabricated.

Normalized events append to `<stateDir>/events/<key>.jsonl`
(key = `<provider>:<session-id>`, filesystem-sanitized). State writes
use the single-writer lock + tmp+rename discipline; event appends
occur inside the same locked section.

Provider notes:

- **codex** — rollout lines `{timestamp,type,payload}`:
  `event_msg` `item_completed` `UserMessage`/`AgentMessage` (and the
  legacy `user_message`/`agent_message` payloads) produce turn
  boundaries and message events; `response_item`
  `function_call`/`custom_tool_call` (+`*_output`) produce
  `tool_call`/`tool_result`; `token_count`/`token_usage_record`
  attach per-request usage to the turn's last `assistant_message`.
  `response_item` `message` records and `reasoning` items are skipped
  (they duplicate the event stream / are provider internals).
- **opencode** — SQLite rows are mutable and `seq`-ordered, so each
  `index` run fully rescans the session and rewrites its event log
  (`reindexed: true` always): duplicates and missing rows cannot
  persist. `session_message.type` `user`/`assistant` produce
  turn/message/tool events from the embedded `content[]`; `compaction`
  and `system` produce `system` events; lifecycle types (`idle`,
  `location-switched`, …) are skipped. Sessions found only in the v1
  `message`+`part` tables are normalized the same way. Malformed
  `data` JSON increments `malformed_lines` per row.

## `sessions`

Lists indexed transcripts, newest activity first:

```json
{
  "contract": "herdr-plugins.conversations/v1",
  "command": "sessions",
  "sessions": [
    {
      "key": "claude:<session-id>",
      "provider": "claude",
      "provider_status": "supported",
      "session_id": "<session-id>",
      "cwd": "/repo/proj",
      "transcript_path": "/abs/…/<session-id>.jsonl",
      "status": "ok",
      "error": null,
      "identity": { "…": "ConversationIdentity" },
      "live": { "pane_id": "w1:p1", "agent_session_value": "<session-id>", "state_change_seq": 9 },
      "live_session": "default",
      "stale": false,
      "stale_reason": null,
      "event_count": 6,
      "turn_count": 1,
      "first_event_at": "…",
      "last_event_at": "…",
      "last_indexed_at": "…",
      "transcript_present": true
    }
  ],
  "count": 1,
  "generated_at": "…"
}
```

- `live` — the pane's current agent binding when the recorded
  `identity.pane_id` still exists in a reachable snapshot; `null`
  when offline, pane gone, or never bound.
- `stale`/`stale_reason` — computed at read time, never persisted:
  `agent_session_changed` when the live pane's `agent_session.value`
  differs from the recorded identity (pane-id reuse / new agent
  generation). Stale entries are flagged, not deleted — history stays
  valid; consumers must not apply a stale index to the new generation.
- `status` ∈ `ok | missing | error`; `error` carries the scanner's
  failure kind when not `ok`.
- `transcript_present` — read-time `stat` of `transcript_path`:
  `false` means the provider-side transcript was deleted or rotated
  out from under the index (session removal / provider retention).
  The indexed events remain readable history; the record's `status`
  only changes on the next `index` run — never silently rewritten.

## `history`

Pages normalized events for one indexed session, in transcript order:

```bash
bun run src/cli.ts history --session-id claude:<uuid> [--limit 200] [--cursor OFF]
bun run src/cli.ts history --pane w1:p1 [--offline]
```

- Selector: exactly one of `--pane PANE` (the pane's most recently
  indexed session; `selector_note: "multiple_sessions_for_pane"` when
  ambiguous) or `--session-id REF` where REF is a full record key
  `<provider>:<id>` or a bare session id (`selector_note:
  "ambiguous_session_id"` when several providers/records match).
  No match → `session_not_found` exit 1; missing selector → usage
  exit 2. (`--session-id`, not `--session`, because `--session`
  already selects the herdr session.)
- `--limit` defaults to 200, capped at 1000. `--cursor` is the opaque
  `next_cursor` byte offset from the previous page; a cursor beyond
  the current file size fails with `cursor_invalid` (the event log
  was rewritten — restart without `--cursor`).
- `--offline` skips the live-binding check; otherwise unreachable
  herdr degrades to `live: null`, never a fabricated verdict.

Response:

```json
{
  "contract": "herdr-plugins.conversations/v1",
  "command": "history",
  "session": { "…": "same shape as a sessions[] entry, plus events_present" },
  "selector_note": null,
  "events": [ { "…": "ConversationEvent" } ],
  "page": {
    "limit": 200,
    "offset": 0,
    "returned": 6,
    "next_cursor": "18342",
    "has_more": false,
    "malformed_lines": 0,
    "duplicates_skipped": 0,
    "events_present": true,
    "events_size": 18342
  },
  "generated_at": "…"
}
```

Paging consumes only newline-terminated lines; a partial tail is left
for the next page. Malformed event lines are skipped and counted in
`page.malformed_lines`; repeated `event_id`s inside a page are
dropped and counted in `page.duplicates_skipped`. A missing events
file yields `events: []` with `events_present: false` and the
record's `status`/`error` surfaced — never fabricated events.
Selector misses carry `error.hint` suggesting `index`; an entirely
empty index returns the hint on successful empty reads.

## `search`

Searches normalized event payloads across indexed sessions:

```bash
bun run src/cli.ts search "fix the bug" [--session-id claude:<uuid>] [--provider codex] [--type assistant_message] [--limit 50] [--cursor CUR] [--offline]
```

- Query is the positional argument (may contain spaces). Matching is
  a **case-insensitive substring** match over the searchable payload
  fields `text`, `tool_name`, `subtype`, `model`; v1 does no token
 ization or stemming (spec: `docs/specs/conversations.md`). Each
  result reports `matched_fields`.
- `--type` restricts to one event type (`turn`, `user_message`,
  `assistant_message`, `tool_call`, `tool_result`, `system`); other
  values are a usage error (exit 2).
- Session coverage: `--pane`, `--session-id` (record key or bare
  session id), and `--provider` combine as AND filters; none → all
  indexed sessions. Sessions are scanned in record-key order so
  cursor paging is deterministic.
- `--limit` defaults to 50, capped at 500.

Response:

```json
{
  "contract": "herdr-plugins.conversations/v1",
  "command": "search",
  "query": "fix the bug",
  "filters": { "pane_id": null, "session_id": null, "provider": null, "type": null },
  "selector_note": null,
  "results": [
    {
      "session_key": "claude:<uuid>",
      "event_id": "u-1",
      "type": "user_message",
      "timestamp": "…",
      "turn_index": 1,
      "matched_fields": ["text"],
      "event": { "…": "full ConversationEvent" }
    }
  ],
  "page": {
    "limit": 50,
    "returned": 1,
    "next_cursor": "eyJ2IjoxLCJvIjp7…",
    "has_more": false,
    "malformed_lines": 0,
    "duplicates_skipped": 0,
    "restarted_sessions": []
  },
  "sessions": [ { "…": "same shape as a sessions[] entry, plus events_present" } ],
  "generated_at": "…"
}
```

### Paging contract (search / usage)

`page.next_cursor` is an **opaque** token (base64url JSON) encoding
the per-session byte offsets of event logs not yet fully consumed.
Pass it back verbatim as `--cursor`; a malformed token is a usage
error (exit 2). Because file-backed event logs are append-only,
index updates between pages only append new events — paging neither
duplicates nor skips matches. When a log was rewritten smaller
(opencode rescan), the affected session restarts at offset 0 and its
key appears in `page.restarted_sessions` (duplicates possible,
explicitly flagged). Sessions whose events file is missing
contribute no matches; their `sessions[]` entry shows
`events_present: false` with the record's `status`/`error`.

## `usage`

Pages only events carrying provider-reported `usage` (the read
surface #28 consumes; aggregation stays consumer-side). Same
selectors, cursor, and envelope as `search`, minus `query`/`filters.type`;
`matched_fields` is always `["usage"]`.

## `show`

Resolves a stable structured reference to the underlying event(s):

```bash
bun run src/cli.ts show <ref> [--session-id claude:<uuid>] [--provider codex] [--offline]
```

`<ref>` forms:

- bare value — union of exact `event_id` and exact `tool_use_id`
  matches across the selected sessions; `resolved.kind` reports
  which kind matched (`event_id` wins when both appear).
- `tool:<tool_use_id>` — the `tool_call`/`tool_result` pair(s) for
  that call id.
- `turn:<n>` — every event with `turn_index == n` (the `turn`
  boundary marker included).

```json
{
  "contract": "herdr-plugins.conversations/v1",
  "command": "show",
  "ref": "tool-1",
  "resolved": { "kind": "tool_use_id" },
  "selector_note": null,
  "results": [ { "session_key": "…", "matched_fields": ["tool_use_id"], "event": { "…": "ConversationEvent" } } ],
  "matched": 2,
  "truncated": false,
  "sessions": [ { "…": "same shape as a sessions[] entry, plus events_present" } ],
  "generated_at": "…"
}
```

Results are capped at 200 across all selected sessions; `truncated:
true` means more matches exist — narrow with `--session-id`/`--pane`.
Approval/user-input style references are **not** derivable: provider
transcripts do not record them and `pane.agent_status_changed` is too
coarse (same upstream gap as #8) — nothing is fabricated.

## Errors

`kind` values: `session_unreachable` (herdr socket unreachable for
`index`; live checks in `sessions`/`history`/`search`/`show`/`usage`
are *not* errors — they degrade to `live: null`),
`session_not_found` (a `--pane`/`--session-id`/`--provider` selector
matched no indexed record; `error.hint` suggests `index`),
`cursor_invalid` (`history --cursor` beyond the events file —
rewritten log), `read_failed` (event-log read error during
`search`/`show`/`usage`), plus scanner-reported
`transcript_missing`, `open_failed`, `read_failed`, `sqlite_*`
surfaced per-session in `skipped` / `sessions[].error`. Usage errors
exit 2 (including a malformed `search`/`usage` cursor token and an
invalid `--type`).

## Versioning

`herdr-plugins.conversations/v1` is **stable** as of plugin v0.5.0
(T4/#89): the command surface, event schema, error `kind` taxonomy,
and paging-cursor semantics below are the finalized v1 contract.
Additive fields may appear in any response or event; clients must
ignore unknown fields. `capability.providers` and
`capability.event_types` extend additively (new providers, new event
types) without a contract bump.

A breaking change — removing/renaming a command or field, changing an
error `kind`'s meaning, altering cursor or event-id semantics — bumps
the contract suffix to `herdr-plugins.conversations/v2`. During the
v0.x train a `v2` contract would ship **alongside** v1 (both commands
sets exposed, `capability.contract` identifying each) for at least one
release so consumers can migrate; v1 is then frozen, not deleted.
State on disk (`state.json` schema version, `events/*.jsonl`) is
internal to the plugin and may change without a contract bump as long
as reads stay honest (missing/corrupt state is reported, never
fabricated).

## Out of scope (v1)

- Ranked/full-text search — v1 is bounded case-insensitive substring
  matching over `text`, `tool_name`, `subtype`, `model`; tokenization
  and relevance ranking are deferred.
- Approval/user-input event references — not derivable from provider
  transcripts; `pane.agent_status_changed` granularity is an upstream
  gap shared with #8.
- opencode pre-SQLite `storage/**.json` file layout and codex
  `.jsonl.zst` archived rollouts — explicit `unsupported_layout` /
  `transcript_missing`, never decompressed or guessed.
- Hook-driven or scheduled indexing — trigger semantics land with the
  consumers.
