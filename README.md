# herdr-plugins

Independent, installable plugins for [herdr](https://github.com/herdrdev/herdr)
— the terminal workspace manager for AI coding agents.

Each plugin in `plugins/` is distributed on its own through the official
herdr plugin installer:

```bash
herdr plugin install rebuildup/herdr-plugins/plugins/<name>
```

Plugins share capabilities that herdr core and existing plugins do not
provide, and stay usable from the herdr TUI, the CLI, AI agents, and external
clients through one versioned contract.

## Plugins

| Plugin | ID | Description |
| --- | --- | --- |
| [inbox](plugins/inbox/) | `rebuildup.inbox` | Work inbox for agent panes: settle / snooze / restore with persistent user-side organize state, structured CLI, and TUI/CLI parity. |
| [conversations](plugins/conversations/) | `rebuildup.conversations` | Provider transcript indexer: normalizes claude/codex/opencode session transcripts into structured conversation events (turn/user/assistant/tool/usage) — never PTY scraping. |
| [usage](plugins/usage/) | `rebuildup.usage` | Token usage aggregation over the conversations index: per provider/model/host/project/session/pane totals with honest missing-data reporting. |
| [controls](plugins/controls/) | `rebuildup.controls` | Agent operation core over the herdr `agent.*` API: send / command / wait / interrupt / read / rename / start with identity echo, stale-generation guards, and per-provider launch tables (`herdr-plugins.controls/v1`). |
| [handoff](plugins/handoff/) | `rebuildup.handoff` | Handoff/delegation records + execution: source pane/agent identity + reference payload + `native_resume`/`portable_context` strategies, cross-machine `--remote`, delegation lineage (`delegate`/`merge-back`, worktree targets) with honest status lifecycle (`herdr-plugins.handoff/v1` stable, #6 T1–T4). |
| [textgen](plugins/textgen/) | `rebuildup.textgen` | Text generation (`herdr-plugins.textgen/v1`): six tasks over dedicated agent panes or opt-in API generators, with strict input/output boundaries. Generation only — execution stays with the caller. |

## Development

```bash
mise install
bun install
bun run validate:fast
```

See [AGENTS.md](AGENTS.md) for the agent contract, delivery workflow, and
project-local skills. Design and research notes live under `docs/`.

## License

MIT — see [LICENSE](LICENSE).
