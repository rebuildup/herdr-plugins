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
