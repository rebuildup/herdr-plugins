/**
 * `@herdr-plugins/tui` — shared terminal UI core for herdr plugins.
 *
 * Public surface (contract `docs/contracts/tui-v1.md`, ADR-0031/0032/0033):
 *
 * - `TuiApp` — application shell: screen stack, reserved keys
 *   (Esc/q back-close, ?/h help, Ctrl-C cancel-then-exit), status line,
 *   SIGWINCH resize, frame throttle, task runner integration.
 * - `Screen` / `Renderer` — diffed ANSI renderer: cursor addressing,
 *   synchronized output (mode 2026, auto-detected), alternate screen,
 *   NO_COLOR/TERM=dumb degradation, Unicode-width-correct truncation.
 * - `KeyParser` / `attachInput` — raw-mode stdin, UTF-8/CJK/emoji-safe,
 *   bracketed paste, escape-timeout handling.
 * - Components: `SelectList`, `DetailView`, `TextInput`/`PromptView`,
 *   `ConfirmView`, `HelpView`, `statusLine`, `filterItems`, `KeyBinding`.
 * - `TaskRunner` — progress, cancel, timeout, partial-result labeling.
 * - Safety (contract §5 items 6–10, enforced in one place):
 *   `sanitizeDisplay`, `BoundedBuffer`, `createThrottle`, `openExternal`.
 *
 * Plugin-specific views stay in `plugins/<name>`; this package exposes
 * only the shared surface above.
 */

export * from "./ansi";
export * from "./app";
export * from "./components";
export * from "./input";
export * from "./safety";
export * from "./screen";
export * from "./task";
export * from "./terminal";
export * from "./unicode";
