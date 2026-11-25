# ADR-0003: Bun runtime for plugin commands (no compiled binary in v0.1)

## Status

Accepted (2026-01).

## Context

Plugin manifest commands are static argv executed with cwd = plugin root.
Options: require `bun` on PATH, or `bun build --compile` a standalone binary
in `[[build]]` at install time.

## Decision

Run `bun run src/cli.ts` / `src/hook.ts` directly. Bun is a documented
runtime prerequisite (the maintainer's environments provide it via
pc-setup/dotfiles; Windows/macOS/Linux all supported by Bun).

## Consequences

- No build step → faster install, easier debugging (`plugin command logs`
  show real TS errors), no 90MB binary per plugin.
- End users without Bun cannot run the plugin; install still succeeds but
  commands fail visibly in the plugin command log.
- Monorepo sharing works via relative TS imports
  (`../../../packages/herdr-client/src/...`); the managed checkout contains
  the whole repo, so `plugins/inbox` resolves `packages/` correctly.

## Alternatives considered

- `bun build --compile` per plugin: robust distribution but large artifacts,
  slower installs, and per-platform rebuilds on update. Revisit if the
  plugin audience expands beyond Bun-equipped environments.
- Node/tsx: Bun is the project's standard toolchain (mise pins it).
