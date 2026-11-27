# Plugin contracts (`herdr-plugins.<name>/vN`)

One Markdown document per plugin contract. Contracts are versioned;
breaking changes require a new contract id (`/v2`), additive fields
and commands extend v1 in place.

Cross-plugin surface contracts that are not tied to a single plugin's
data live here too: `tui-v1.md` (`herdr-plugins.tui/v1`) is the shared
interactive-terminal-surface contract for program #228 (ADRs
0031–0033).

## Capability advertisement policy

Every CLI plugin's `capability` document advertises its command
surface in `commands` and, since #224, the subset that mutates state
in `mutation_commands` — commands that write herdr state, plugin
state, or external systems (read-only queries are excluded; daemon
commands like `watch`/`tick` are included because they mutate on
every pass). Subcommand-scoped mutations use the `"<cmd> <sub>"`
form (e.g. `"repos add"`, `"config set-default-model"`). Clients
must treat `mutation_commands` as a conservative superset: a listed
command may still be read-mostly (`handoff status` reconciles only
when a `delivered` record exists), and an unlisted command never
mutates. Plugins whose surface is not a per-feature CLI (currently
`mcp`, a stdio MCP server) document their equivalent gating fields
instead — see `mcp-v1.md`.
