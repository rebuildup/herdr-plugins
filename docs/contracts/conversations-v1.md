# Contract `herdr-plugins.conversations/v1`

Structured JSON CLI contract for the `rebuildup.conversations` herdr
plugin — a provider transcript indexer that normalizes session
transcripts (claude JSONL in v1) into structured conversation events.
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
  "version": "0.1.0",
  "read_only": false,
  "mutation_commands": ["index", "refresh"],
  "commands": ["capability", "index", "refresh", "sessions"],
  "providers": [
    { "id": "claude", "status": "supported", "formats": ["claude-jsonl"] },
    { "id": "codex", "status": "unsupported", "formats": [], "reason": "…", "planned_in": "#87" },
    { "id": "opencode", "status": "unsupported", "formats": [], "reason": "…", "planned_in": "#87" }
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
    { "pane_id": "w1:p2", "provider": "codex", "reason": "unsupported_provider" },
    { "pane_id": "w1:p3", "provider": "claude", "session_id": "…", "reason": "transcript_missing", "cwd": "/repo" }
  ],
  "sessions_indexed": 1,
  "events_appended": 6,
  "generated_at": "…"
}
```

`skipped[].reason` values: `unknown_provider` (agent reports no known
provider), `unsupported_provider` (declared but no adapter — codex,
opencode in v1), `no_agent_session` (agent exposes no session
identity), `transcript_missing` (resolution found no file),
`transcript_missing`/`open_failed`/`read_failed` from the scanner.
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
      "last_indexed_at": "…"
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

## Errors

`kind` values: `session_unreachable` (herdr socket unreachable for
`index`/`sessions` live check is *not* an error — it degrades to
`live: null`), plus scanner-reported `transcript_missing`,
`open_failed`, `read_failed` surfaced per-session in `skipped` /
`sessions[].error`. Usage errors exit 2.

## Out of scope (v1)

- History read/search/pagination API — T2 (#87) / T3 (#88).
- codex rollout and opencode SQLite adapters — T2 (#87), declared
  `unsupported` here.
- Hook-driven or scheduled indexing — trigger semantics land with the
  consumers.
