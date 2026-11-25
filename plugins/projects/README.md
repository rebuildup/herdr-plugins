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
```

v0.1.0 is read-only: it lists registered projects and discovers git
repositories from pane cwds. Registry writes, t3.json/scripts, and
script execution arrive in later tickets (#49–#53).

Full contract: `docs/contracts/projects-v1.md`. Spec: `docs/specs/projects.md`.
Design: ADR-0009.
