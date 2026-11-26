# ADR-0033: Optional shared TUI launcher, action/keybind conventions, and the TUI safety contract

## Status

Accepted (design foundation for #228 / #229)

## Context

#228 requires: per-plugin entrypoints so each plugin installs/updates/
disables independently; optionally a shared launcher that discovers
installed plugin capabilities — never a required dependency of individual
plugins; namespaced actions; non-colliding optional keybinds; a CLI
fallback path; help; and a safety contract covering read-only open,
explicit targets, stale generation, mutation gating, irreversible-op
confirmation, secret non-display, timeout/cancel, terminal-escape/path
safety, and unchanged non-interactive CLI.

## Decision

### 1. Launcher: optional shared surface, never a dependency

- A **shared launcher pane entrypoint** may be provided (e.g. a
  `rebuildup.tui` launcher plugin or a `packages/tui`-based entry shipped
  inside an existing plugin) that enumerates installed plugins via
  `herdr plugin list` / `plugin.action.list` and opens the selected
  plugin's UI pane through `plugin.pane.open`.
- The launcher is **optional and discovery-only**: every plugin MUST be
  fully usable through its own manifest actions/panes without the
  launcher installed, enabled, or present. The launcher never proxies
  plugin state and never becomes a required dependency — removing or
  disabling it removes only the discovery convenience.
- Discovery must degrade honestly: plugins whose `platforms` exclude the
  current OS, whose `min_herdr_version` exceeds the running herdr, or
  whose pane entrypoints are absent are listed as unavailable with the
  reason, never silently skipped or shown as working.

### 2. Naming and keybind conventions

- Actions keep herdr's qualified-id rule: `plugin.id.action`. New TUI
  actions use the local id `open` (open the plugin's primary UI) plus
  optional surface-specific ids (`open-<surface>`); pane entrypoint ids
  mirror them (`main`, `picker`, ...). Existing action ids are never
  renamed — TUI actions are additive.
- Every interactive plugin SHOULD declare at least one `pane`-context or
  `workspace`-context action that opens its UI, so `plugin.action.invoke`
  and `[[keys.command]] type = "plugin_action"` work uniformly.
- Keybinds are **user-owned**: plugins ship no `[[keys.command]]`
  entries and never write herdr config. Docs/README provide copy-paste
  `[[keys.command]]` snippets with `prefix+` chords in an unused range;
  collisions are the user's to resolve. No config key is force-overwritten
  (invariant).
- CLI fallback is preserved: every interactive surface has an equivalent
  non-interactive CLI invocation path (existing commands), and the TUI
  itself offers a "copy CLI command" affordance for the current view where
  cheap. Non-interactive CLI behavior, output formats, and exit codes are
  **unchanged** by TUI work.
- Help: each plugin UI has an in-TUI `?`/`h` help overlay generated from
  the same keybinding table the UI uses; `herdr plugin action list`
  remains the machine-readable discovery surface.

### 3. TUI safety contract (normative; detailed in `docs/contracts/tui-v1.md`)

1. **No mutation on read-only open.** Opening a list/detail/search view
   performs only reads. Lazy drains (inbox `reconcile`, checkpoints
   pending-capture drain, automations `tick` semantics) that *mutate* must
   not run implicitly on open; they run only via explicit user action or
   the existing CLI/startup/hook paths. Where a read surface needs fresh
   data it re-reads; it never "helpfully" settles state.
2. **Explicit target.** Every mutating operation names its target
   (pane/workspace/repo/agent/host/session) resolved from the pinned
   origin context or user selection; ambient "focused" state is captured
   once at open and revalidated before use.
3. **Stale generation.** Targets carry the same identity signals as the
   CLI contracts (agent_session fingerprint, state_change_seq, HEAD,
   checkpoint ids, etc.). A stale target aborts with an honest
   `stale_*`-class error and offers refresh — never silently retargets a
   different agent generation or reused pane id.
4. **Mutation capability gating.** Surfaces consult the plugin
   `capability`/`mutation_commands` document (and per-command support
   flags); unsupported operations render as disabled with the reason,
   not hidden and not faked.
5. **Irreversible-op confirmation.** Destructive/irreversible operations
   (delete, force-push, restore-over-dirty, machine lifecycle, secret
   injection) require an explicit confirm step inside the TUI showing
   the exact target and consequence; Escape cancels. No mutation fires
   from a single stray keystroke.
6. **Secret non-display.** Secret values, tokens, and credential material
   are never rendered, logged, placed in argv, or written to scrollback
   (ADR-0027 boundary). Secrets UI shows metadata/binding names only.
7. **Timeout/cancel.** Every long-running operation (probe, run-now,
   generate, fetch) has a visible progress state, honors cancel
   (Ctrl-C/Esc per keymap), and reports timeouts honestly; partial results
   are labeled partial.
8. **Terminal-escape/path safety.** All untrusted strings (filenames,
   agent output, remote data, error messages) are escaped before
   rendering — no raw CSI/OSC injection. Filesystem paths and external
   commands go through the same validation as the CLI (no shell
   interpolation, allowlisted openers); "open externally" is always an
   explicit user action.
9. **Honest unsupported/missing dependency.** Missing sibling plugin,
   missing `gh`/`infisical`/provider CLI, older herdr, unsupported
   platform, or absent remote capability renders as an explicit
   unsupported/unavailable state with the reason and the CLI fallback —
   never a fabricated success.
10. **Resource discipline.** No unconditional resident service or
    high-frequency polling added by TUI surfaces; refresh is
    user-triggered or event-driven within the pane's lifetime. Output and
    log surfaces are bounded.

### 4. What stays OUT

- No forking herdr; only documented manifest/socket/CLI surfaces.
- No TUI-owned persistent business state — durable state stays in each
  plugin's `HERDR_PLUGIN_STATE_DIR` via existing contracts; the TUI layer
  keeps only ephemeral view state.
- No private cross-plugin state reads — plugins consume each other's
  **public contracts** (`herdr-plugins.<name>/vN`) exactly as CLI/MCP/GUI
  do.
- No reimplementation of capabilities herdr TUI already provides
  (pane/workspace/agent operations stay in herdr; e.g. controls surfaces
  wrap `agent.*` semantics, they do not re-derive agent state from PTY
  text).
- The MCP server (`rebuildup.mcp`) is **not** "screen-ified": only
  human-needed diagnostics/config surfaces (capability report, access
  level, per-plugin availability) get TUI treatment.
- Image/PDF/HTML/MCP Apps/OS-capture surfaces use terminal-appropriate
  previews (text/structured info/path + explicit external open) and mark
  richer rendering as unsupported-in-terminal rather than requiring a
  browser for core flows.

## Consequences

- Plugins remain independently installable; the launcher is a convenience
  that can be adopted plugin-by-plugin.
- The safety contract becomes a checklist item in `tui-v1.md` and in each
  #230–#233 ticket's acceptance criteria.
- Upstream gaps stay upstream: structured approval dialogs, runtime
  action registration, and non-terminal UI primitives remain tracked as
  herdrdev/herdr issues, not worked around by PTY scraping.
