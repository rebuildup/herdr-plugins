# ADR-0032: Shared terminal UI library — custom minimal ANSI/TTY renderer in `packages/tui`

## Status

Accepted (design foundation for #228 / #229)

## Context

#229 requires a shared terminal UI capability — input, selection, search,
forms, lists/details, async progress, errors, cancel, resize, safe
rendering — evaluated against Bun/TypeScript options on: dependency
weight, render performance, Windows/SSH/resize/IME behavior, and
distributability as a herdr plugin pane entrypoint. Repo constraints:

- All 14 plugins are currently **dependency-free TypeScript executed by
  Bun** (`ADR-0003`); manifests have no build step.
- `packages/` may only contain libraries actually shared by two or more
  plugins (AGENTS.md §3) — a TUI core used by every interactive plugin
  qualifies.
- Plugin panes are real PTYs managed by herdr: the UI process gets a
  TTY, `SIGWINCH` on resize, and herdr's own scrollback/persistence.
  There is no terminal multiplexer inside the pane to fight.

### Candidates evaluated

| option | dependency weight | render model | Windows/SSH/resize/IME | distributability as pane entrypoint |
| --- | --- | --- | --- | --- |
| **Custom ANSI/TTY renderer** (`packages/tui`) | zero runtime deps; Bun stdlib only (`node:readline`-style raw stdin via `process.stdin.setRawMode`, `process.stdout`, `fs.watch`/`SIGWINCH`) | own diff renderer: alternate-screen optional, absolute cursor addressing, synchronized output where supported, graceful no-color/ASCII fallback | full control: we implement exactly the behaviors we test (resize reflow, wide-char/emoji width via `Intl.Segmenter`+wcwidth table, paste/bracketed-paste handling, no IME dependency — IME is the terminal's job, herdr panes pass bytes through) | trivial: `bun run` a TS file in the plugin checkout; no bundler, no native modules, no `node_modules` in the plugin dir |
| **blessed / neo-blessed** | large dep tree (neo-blessed still pulls `@xterm`-adjacent helpers, `tput`-style terminfo lookups, optional native bits); Node-first, Bun compat is best-effort | widget/screen buffer model; renders through its own terminal abstraction | terminfo-dependent: relies on `terminfo`/`tput` data that is frequently wrong or absent over SSH/WSL minimal images and inside herdr panes; known resize/flicker issues; Windows support historically weakest of the set | needs `node_modules` resolvable from plugin root; breaks the dependency-free convention; version drift across plugins |
| **ink (React)** | `react` + `ink` + `yoga-layout` + cli-boxes etc. — heaviest option; React reconciler in a TTY | component/reconciler model, good ergonomics | Yoga layout handles resize well; but output goes through its own renderer with its own quirks; Bun support is community-level; IME/ paste handling inherited but opaque | React deps must be installed per plugin or vendored; conflicts with no-build-step convention unless we pre-bundle, adding a build pipeline |
| **inquirer-style prompt libs** | small–medium | prompt widgets only (select/input/checkbox) | fine for forms, but no list/detail/browser surface, no async dashboard, no custom layouts | insufficient alone; would still need a renderer for anything beyond prompts |
| **raw ANSI by hand per plugin** | zero | duplicated, inconsistent, unsafe (escape injection, resize bugs) | per-plugin quality varies | rejected: violates DRY and the safety contract |

### Key technical findings

- A herdr plugin pane is an ordinary PTY. What the UI needs from the
  platform is small: raw-mode stdin, stdout writes, `SIGWINCH`, and a
  bounded render loop. Bun provides all of this with zero dependencies.
- The hard parts are *not* library features but contract features:
  honest unsupported states, cancellation, generation checks, safe
  rendering of untrusted data (filenames, agent output, terminal escape
  sequences in payloads). A custom renderer lets us enforce the safety
  contract (strip/escape CSI/OSC in data, bound frames, throttle writes)
  in exactly one place.
- blessed/ink solve problems we do not have (mouse-driven desktop-style
  TUIs, complex widget trees) and introduce problems we must then audit
  (terminfo detection, dep tree in `plugin_root`, Windows console
  quirks). ink's React model also pushes state management into a
  paradigm the rest of the codebase (plain TS, explicit state) does not
  use.
- Distributability: `herdr plugin install` checks out source and runs
  `bun run`; a `packages/tui` workspace dependency resolves via the
  repo's Bun workspaces only inside this monorepo — for installed
  plugins herdr copies/links the plugin directory. **Design
  consequence:** `packages/tui` must be consumable as *source* — either
  the plugin vendors/copies the needed modules at release time, or the
  TUI entrypoints live in a shared package that plugins reference by
  relative path within the same checkout (`plugins/<name>` and
  `packages/tui` ship in the same repo, and `herdr plugin install
  rebuildup/herdr-plugins/plugins/<name>` installs the whole repo
  checkout — `plugin_root` is the plugin subdir, and `..` paths reach
  `packages/`). This must be verified per install mode during #230+
  implementation; the contract (`tui-v1.md`) records the resolution
  rule. If relative-path reachability fails for managed checkouts, the
  fallback is a release-time copy step, not a runtime dependency.

## Decision

1. Create `packages/tui` — a **zero-dependency Bun/TypeScript terminal UI
   core** providing: raw-mode input with key parsing, a diffed renderer
   (alternate screen optional per surface, cursor addressing,
   synchronized-update where available, no-color/ASCII degradation),
   list/detail/form/prompt components, async task runner with
   cancel/timeout, status/notice line, resize reflow, and the safety
   helpers (untrusted-text escaping, output bounds, frame throttling).
2. blessed/neo-blessed, ink, and inquirer-style libraries are **rejected**
   for the core surface; the comparison above is the record. Individual
   feature tickets may revisit a narrow library only if `packages/tui`
   proves insufficient for a specific surface, with its own ADR note.
3. `packages/tui` contains only genuinely shared parts (renderer, input,
   generic components, safety helpers). Plugin-specific views stay in the
   plugin. No plugin may depend on `packages/tui` internals beyond the
   documented `tui-v1` contract surface.
4. Rendering targets "good enough for daily use on macOS Terminal/
   iTerm2, Windows Terminal, and SSH/WSL sessions": 256-color with
   `NO_COLOR`/`TERM=dumb` degradation, Unicode width-correct truncation,
   no reliance on images/OSC-clipboard features for core flows.

## Consequences

- We own the renderer: more upfront work, but safety, resize, and
  degradation behavior are auditable and identical across all plugins.
- Zero new runtime dependencies preserve the dependency-free plugin
  convention and eliminate `node_modules`/install risk on Windows/SSH.
- The source-level sharing question (how an installed plugin checkout
  reaches `packages/tui`) becomes an explicit contract item verified in
  #230+; worst case is a vendored copy at release time.
- IME composition is delegated to the host terminal + herdr PTY (bytes
  pass through); the UI must not break multi-byte input — covered by
  UTF-8-safe input parsing in `packages/tui` and tested with CJK/emoji
  fixtures.
