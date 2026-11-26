# ADR-0009: Project registry lives in plugin state, host-global

## Status

Accepted (v0.1.0, `rebuildup.projects`, Issue #26 / ticket #48)

## Context

Issue #26 requires a project registry (register/search/pin/archive,
multi-repo grouping, settings overrides) that upstream T3 Code keeps in
its server event store (`apps/server/src/project/ProjectService.ts`).
herdr plugins may only own feature-specific state under
`HERDR_PLUGIN_STATE_DIR`; herdr remains the execution/pane authority.

## Decision

1. **New plugin `rebuildup.projects`, new contract
   `herdr-plugins.projects/v1`.** Projects are session/host-scoped
   entities, not pane-scoped repos — extending `herdr-plugins.git/v1`
   would mix target models (project id vs pane id).
2. **Registry = plugin state, host-global.** A single `state.json`
   under the plugin state dir holds `{id, title, repos[], pinned,
   archived, timestamps}`. Unlike inbox organize state it is NOT
   namespaced per herdr session: projects are user-level and span
   sessions/hosts-checkouts. Writes use the same single-writer lock +
   tmp+rename discipline as inbox (AGENTS §4).
3. **Repo identity via `packages/git-core`.** Spawn primitives
   (`runGit`/`gitOk`/`GitError`/`resolveRepo`) were extracted from the
   git plugin into `packages/git-core` — the first genuinely shared
   library — plus `repoRemoteIdentity`/`normalizeRemoteUrl` for
   cross-checkout grouping (scp/https/case/`.git` unified). The git
   plugin re-exports the primitives so its contract is unchanged.
4. **Mutations are explicit-argument CLI commands.** `register`/
   `update`/`pin`/`archive` and `settings set|unset` write through the
   same single-writer lock + atomic rename; `read_only: false` with
   `mutation_commands` enumerated. No manifest actions — pane surfaces
   never trigger registry writes implicitly.
5. **`discover` enumerates, never registers.** Pane cwds →
   `resolveRepo` → dedupe by canonical root → normalized remote
   identity; non-git/bare/unreachable cwds are reported in `skipped`,
   never fabricated. `registered_project_id` links existing entries.
6. **No manifest actions.** Registry commands are session-scoped and
   mutations need explicit args; CLI/agent invocation only (same rule
   as git mutations, ADR-0007).

## Consequences

- Multi-host: state is per-host (plugin state dir is local); remote
  identity keys make the same repository comparable across hosts without
  merging state.
- `packages/git-core` is now the shared git spawn path; future git
  plugins must use it rather than re-implementing spawn/env hygiene.
- Script execution (#3) will build on this registry; the execution
  surface itself is gated by ticket #52's herdr API spike.
