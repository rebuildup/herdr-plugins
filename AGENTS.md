# AGENTS.md — hoxay-plugins root agent contract

This is the always-on contract for AI agents working on `hoxay-plugins` (`rebuildup/hoxay-plugins`).

The repository follows the `rebuildup/project-init` release-driven operating
model. Keep this root contract project-specific; do not copy the complete
upstream initialization prompt here.

## 1. Project identity

- `hoxay-plugins` provides independent, installable
  [herdr](https://github.com/herdrdev/herdr) plugins for capabilities that
  herdr core and existing plugins do not cover. The first plugin is
  `rebuildup.inbox` (agent work-inbox: settle / snooze / restore).
- herdr remains the sole authority for PTYs, workspaces, tabs, panes, agents,
  and worktrees. Plugins own only feature-specific state and operations; they
  must not reimplement execution, provider runtimes, Agent Router, or
  orchestration.
- Targets: macOS, Linux, Windows (plugin manifest `platforms`).
- Public repository. License: MIT. Canonical remote:
  `https://github.com/rebuildup/hoxay-plugins.git`.
- Source code, commit messages: **English**.
- Internal development docs, Issues, PRs, reviews: **Japanese** is preferred.

## 2. Canonical documentation hierarchy

1. accepted repository ADRs (`docs/adr/`) and this root contract
2. executable implementation and tests
3. `docs/` specifications (`docs/specs/`), research notes (`docs/research/`),
   and the public contract (`docs/contracts/`)
4. current official herdr documentation and the pinned upstream revisions
   recorded in `docs/research/`
5. current machine state as evidence, not authority

## 3. Repository layout

- `plugins/<name>/` — one installable plugin per directory, each with an
  official `herdr-plugin.toml`. Install path:
  `herdr plugin install rebuildup/hoxay-plugins/plugins/<name>`.
- `packages/` — libraries actually shared by two or more plugins. Do not
  create empty or speculative packages.
- `docs/` — specifications, ADRs, research, contracts.
- `.agents/skills/` — project-local Agent Skills vendored from
  `rebuildup/project-init` (and evaluated externals); `skills-lock.json` is
  the freshness record. `.claude/skills/` symlinks into `.agents/skills/`.

## 4. Invariants (do not regress)

- herdr is the only source of truth for execution state. Plugin organize
  state (settle/snooze) is user-side UI-layer state and must never rewrite
  agent execution state, fabricate statuses, or parse PTY text into
  invented states.
- Identity always carries Host/Session/Workspace/Pane plus available
  `agent_session` and generation signals; stale organize state must not be
  applied to a different agent generation or reused pane id.
- Attention signals (e.g. `blocked`) are never hidden by organize state.
- Concurrent CLI/hook invocations must not corrupt state: single-writer
  file lock + atomic rename; reads resolve expirations deterministically.
- Unsupported, disconnected, uninstalled, or stale data is never reported as
  success.
- No unverified string interpolation into commands; no ambient secret
  inheritance or logging.
- Each plugin installs, updates, and disables independently; a plugin
  failure must not affect herdr itself.
- Config and durable state live only under herdr-provided plugin
  directories (`HERDR_PLUGIN_CONFIG_DIR` / `HERDR_PLUGIN_STATE_DIR`,
  resolved equivalently for external clients). Never inside the installed
  source tree.
- The herdr TUI is a first-class plugin surface (program #228): every new
  human-facing feature MUST consider its TUI/GUI coverage, record gaps in
  `docs/program/tui-coverage.json`, and implement interactive surfaces
  against `docs/contracts/tui-v1.md` (ADRs 0031–0033). CLI or GUI
  completion alone never counts as TUI coverage.
- Real-herdr verification uses an isolated named session only; never touch
  the user's live session, agents, or worktrees.

## 5. Bootstrap and validation

```bash
mise install
bun install
bun run validate:fast        # typecheck + lint + unit tests (worker gate)
bun run validate:integration # ticket integration gate (same entry today)
```

`quality/profile.yaml` is the canonical quality profile. `mise run` tasks
mirror the same commands.

## 6. Delivery workflow

Follow `organization`-equivalent profile `release-driven-solo` via the
`github-delivery` skill:

- one top-level GitHub Issue -> branch named only by the Issue number -> one
  ticket PR
- independent ticket PRs target the current `release-x-y-z` branch
- `release-* -> main` merges wait for explicit maintainer authorization
- merge commits only; no squash/rebase merges
- a ticket PR that passes the quality gates lands on its target release
  branch without waiting for further authorization; ticket-merge authority
  never extends to `release-* -> main`
- Issues/PRs may be Japanese; commits and code are English

First release train: `release-0-1-0`.

## 7. Project-local skills

Skills live in `.agents/skills/` (`.claude/skills/` symlinks them).
`skills-lock.json` records upstream revisions. Update via
`bunx skills update -p -y`; do not hand-edit vendored Skill bodies.

| Capability | Skill |
| --- | --- |
| delivery / Issues / PRs / release | `github-delivery` |
| recovery from interruption | `agent-recovery` |
| decomposition / delegation | `parallel-orchestration` |
| quality gates / CI | `quality-gate` |
| design before non-trivial build | `design-refinement` |
| implementation decision precedence | `engineering-decisions` |
| invariants and assurance | `correctness-assurance` |
| naming / responsibility | `code-naming` |
| whole-system quality on change | `system-quality` |
| security advisories | `security-maintenance` |
| secrets (if a plugin ever needs them) | `secrets-management` |
| estimation / release planning | `agent-delivery-estimation` |
| onboarding docs | `onboarding` |
| prose artifacts (docs/ADR/Issue/PR) | `writing-discipline`, `natural-japanese` |
| user interaction discipline | `interaction-discipline` |
| policy/skill changes | `policy-evaluation` |
| skill authoring | `skill-authoring` (manual: `.agents/skills/skill-authoring/SKILL.md`) |
| ideation | `idea-discovery` |
| herdr Supervisor runtime use | `herdr-runtime` |
| worker sandbox isolation | `sandbox-runtime` |
| worktree lifecycle | `worktree-workflow` |
| Linear release control (if adopted) | `linear-release-control` |
| supervisor authority separation (if adopted) | `supervisor-boundary` |
| skill selection | `skill-selection` |
| debugging | `diagnosing-bugs` |
| diff review vs standards+spec | `code-review` |
| test-first (manual invocation) | `tdd` (manual: `.agents/skills/tdd/SKILL.md`) |

## 8. Coordination with sibling repositories

- `herdr-t3` consumes this repo's public plugin contract
  (`docs/contracts/`); coordinate via Issues, do not edit that repo here.
- `dotfiles` / `pc-setup` own machine-level agent routing and environment
  setup; plugin runtime prerequisites (Bun) are documented, not duplicated.
- Upstream `herdrdev/herdr` gaps found during development are recorded as
  ADR notes and upstream Issue candidates, not worked around silently.
