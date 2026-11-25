# rebuildup.conversations

Provider transcript indexer for herdr panes
(`herdr-plugins.conversations/v1`).

## Install

```bash
herdr plugin install rebuildup/herdr-plugins/plugins/conversations
```

Prerequisites: herdr ≥ 0.9.0, Bun on `PATH`. `index`/`refresh`/`sessions`
additionally need a reachable herdr session (`--session`/`--socket` or
the default socket); `capability` works offline.

## What it does

Reads provider-owned session transcripts — never PTY text — and
normalizes them into structured events:

- **claude** (v1): `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
  (honors `CLAUDE_CONFIG_DIR`). Emits `turn`, `user_message`,
  `assistant_message` (with `model` + `usage` token fields),
  `tool_call`, `tool_result`, and `system` events. Every event carries
  the herdr identity observed at index time (host, session,
  workspace/tab/pane, `agent_session`, `state_change_seq`).
- **codex / opencode**: declared in `capability` as `unsupported`
  (adapters land in #87); panes running them are reported in
  `skipped`, never fabricated.

Transcript resolution follows the T3 `usageTranscriptReader`
mechanism: `agent_session.value` (a session **id**, not a path) +
pane `cwd` + provider-known directories. `agent_session_path` is not
exposed by herdr's `AgentInfo` — recorded as an upstream gap in
ADR-0012.

Indexing is incremental: a byte-offset cursor plus an FNV-1a guard
detects in-place rewrites; only newline-terminated lines commit;
unterminated tails wait for the next scan. State and the append-only
event log live only under `HERDR_PLUGIN_STATE_DIR`
(single-writer lock + atomic rename).

## Usage

```bash
# from the plugin root (see `herdr plugin list --json` → plugin_root)
bun run src/cli.ts capability
bun run src/cli.ts index [--session NAME] [--socket PATH] [--timeout MS]
bun run src/cli.ts refresh   # alias of index
bun run src/cli.ts sessions [--offline]
```

- `index`/`refresh` → `{indexed: [...], skipped: [...]}` — skipped
  entries carry explicit reasons (`unsupported_provider`,
  `unknown_provider`, `no_agent_session`, `transcript_missing`).
- `sessions` → indexed transcripts with identity binding, live
  binding, and `stale`/`stale_reason` (`agent_session_changed` when a
  pane id was reused by a different agent generation).

Full contract: `docs/contracts/conversations-v1.md`.
Spec: `docs/specs/conversations.md`. Design: ADR-0012.
