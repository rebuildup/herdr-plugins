# rebuildup.projects

Project registry for herdr panes (`herdr-plugins.projects/v1`).

## Install

```bash
herdr plugin install rebuildup/herdr-plugins/plugins/projects
```

Prerequisites: herdr ≥ 0.9.0, Bun on `PATH`, `git` on `PATH`.
`discover` additionally needs a reachable herdr session.

## Usage

```bash
# from the plugin root (see `herdr plugin list --json` → plugin_root)
bun run src/cli.ts capability
bun run src/cli.ts list [--all]
bun run src/cli.ts show <id>
bun run src/cli.ts discover [--session NAME]
bun run src/cli.ts register <repo-path> [--title T] [--id ID]
bun run src/cli.ts update <id> [--title T] [--pinned|--unpinned]
    [--archived|--unarchived] [--repo-add PATH]... [--repo-remove PATH]...
bun run src/cli.ts archive|unarchive|pin|unpin <id>
bun run src/cli.ts settings get|set|unset <id> [key] [value]
```

Registry mutations are explicit-argument CLI invocations (never pane
actions). t3.json/scripts resolution and script execution arrive in
#50–#53.

Full contract: `docs/contracts/projects-v1.md`. Spec: `docs/specs/projects.md`.
Design: ADR-0009.
