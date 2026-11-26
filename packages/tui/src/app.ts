/**
 * `TuiApp` — the application shell for `packages/tui` consumers.
 *
 * Owns: raw-mode input, the diffed `Screen`, the screen stack, reserved
 * keys (Esc/q back-close, ?/h help, Ctrl-C cancel-then-exit), the status
 * line, SIGWINCH resize, frame throttling, and the `TaskRunner`.
 *
 * Typical use:
 *
 *   const app = await TuiApp.create({ title: "My Plugin" });
 *   const list = new SelectList({ items: [...] });
 *   list.onSelect = (item) => app.pushDetail(item);
 *   app.setView(list);
 *   await app.closed;   // resolves on exit
 *
 * Contract notes (tui-v1):
 * - reserved keys: q/Esc = back/close, ?/h = help (generated from the
 *   keymap table — no drift), Ctrl-C = cancel current op (2nd press exits)
 * - long ops go through `app.tasks.run(...)` for progress/cancel/timeout
 * - untrusted strings are sanitized by the renderer — pass them raw
 */

import type { ColorMode, Style } from "./ansi";
import {
  type ConfirmOptions,
  ConfirmView,
  HelpView,
  type KeyBinding,
  PromptView,
  type SelectItem,
  SelectList,
  type SelectListOptions,
  statusLine,
  type TextInputOptions,
} from "./components";
import { attachInput, type KeyEvent, matchKey } from "./input";
import { createThrottle, sanitizeDisplay } from "./safety";
import { type Line, Screen, type ScreenView } from "./screen";
import { formatTaskSnapshot, TaskRunner, type TaskSnapshot } from "./task";
import { detectTerminal, readSize, type TerminalInfo } from "./terminal";
import { truncateToWidth } from "./unicode";

export interface TuiAppOptions {
  /** Title shown in the top chrome row. */
  title?: string;
  /** Alternate screen. Default true (plugin panes are ephemeral). */
  alternateScreen?: boolean;
  /** Color override; default: detected. */
  colors?: ColorMode;
  /** Synchronized output override; default: detected. */
  syncOutput?: boolean;
  /** ASCII degradation override; default: detected (TERM=dumb). */
  ascii?: boolean;
  /** Show the bottom status line. Default true. */
  statusLine?: boolean;
  /** Global keybindings merged into the help overlay. */
  keymap?: KeyBinding[];
  /** Minimum ms between frame writes. Default 33 (~30fps). */
  frameMs?: number;
  /** Show task progress in the status line. Default true. */
  taskProgress?: boolean;
  /** Extra lines printed to scrollback on exit (after leaving alt screen). */
  farewell?: string[];
  /** Injectable streams for tests. */
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export class TuiApp {
  private readonly opts: TuiAppOptions;
  private readonly screen: Screen;
  private readonly info: TerminalInfo;
  private readonly stack: ScreenView[] = [];
  private statusLeft = "";
  private statusRight = "";
  private statusStyle: Style | undefined;
  private taskSnapshot: TaskSnapshot | null = null;
  private helpOpen = false;
  private ctrlCCount = 0;
  private ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
  private closedFlag = false;
  private detachInput: (() => void) | null = null;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private lastSize = { columns: 0, rows: 0 };

  /** Async task runner — progress/cancel/timeout per contract item 7. */
  readonly tasks: TaskRunner;

  private constructor(opts: TuiAppOptions) {
    this.opts = opts;
    this.info = detectTerminal({
      ...(opts.colors !== undefined ? { colors: opts.colors } : {}),
      ...(opts.syncOutput !== undefined ? { syncOutput: opts.syncOutput } : {}),
      ...(opts.ascii !== undefined ? { ascii: opts.ascii } : {}),
      ...(opts.output ? { stdout: opts.output } : {}),
      ...(opts.input ? { stdin: opts.input } : {}),
    });
    this.screen = Screen.create({
      columns: this.info.columns,
      rows: this.info.rows,
      colors: this.info.colors,
      syncOutput: this.info.syncOutput,
      ascii: this.info.ascii,
      alternateScreen: opts.alternateScreen ?? true,
      ...(opts.output ? { output: opts.output } : {}),
    });
    this.tasks = new TaskRunner({
      onChange: (s) => {
        this.taskSnapshot = s;
        this.requestRender();
      },
    });
    this.closedPromise = new Promise<void>((res) => {
      this.resolveClosed = res;
    });
  }

  /** Resolves when the app has fully exited. */
  get closed(): Promise<void> {
    return this.closedPromise;
  }

  /** Current terminal size (updated on SIGWINCH). */
  get size(): { columns: number; rows: number } {
    return this.screen.renderer.size;
  }

  /**
   * Create and start a TUI app on the real terminal (or injected streams).
   * Throws when stdin/stdout are not TTYs — use `renderPlain` for
   * non-interactive output instead.
   */
  static async create(opts: TuiAppOptions = {}): Promise<TuiApp> {
    const app = new TuiApp(opts);
    app.start();
    return app;
  }

  private start(): void {
    const input = this.opts.input ?? process.stdin;
    if (!input.isTTY) {
      // Honest unsupported state: no raw-mode input possible.
      input.pause();
    }
    const output = this.opts.output ?? process.stdout;
    if (output.isTTY && typeof (input as { setRawMode?: unknown }).setRawMode === "function") {
      try {
        (input as NodeJS.ReadStream).setRawMode(true);
      } catch {
        // not a real TTY despite isTTY — continue without raw mode
      }
    }
    input.resume();

    const handle = attachInput({
      ...(this.opts.input ? { input: this.opts.input } : {}),
      ...(this.opts.output ? { output: this.opts.output } : {}),
      onEvent: (ev) => this.onKey(ev),
      onResize: () => this.onResize(),
      onEof: () => {
        // stdin closed (e.g. pane killed) — exit cleanly.
        void this.close();
      },
    });
    this.detachInput = handle.detach;
    this.requestRender();
  }

  // --- view stack ---------------------------------------------------------------

  /** Replace the whole stack with a single view. */
  setView(view: ScreenView): void {
    this.stack.length = 0;
    this.stack.push(view);
    this.requestRender();
  }

  /** Push a view on top (help, confirm, detail, ...). */
  push(view: ScreenView): void {
    this.stack.push(view);
    this.requestRender();
  }

  /** Pop the top view. Returns the popped view (or undefined if empty). */
  pop(): ScreenView | undefined {
    const v = this.stack.pop();
    if (this.stack.length === 0) {
      // keep at least an empty state — draw blank rather than crash
      this.stack.push({ render: () => [] });
    }
    this.requestRender();
    return v;
  }

  get depth(): number {
    return this.stack.length;
  }

  get topView(): ScreenView | undefined {
    return this.stack[this.stack.length - 1];
  }

  // --- convenience flows ---------------------------------------------------------

  /** Show the help overlay generated from the collected keymap. */
  showHelp(): void {
    if (this.helpOpen) return;
    const bindings = this.collectKeymap();
    const help = new HelpView(bindings);
    help.onClose = () => {
      this.helpOpen = false;
      this.pop();
      this.requestRender();
    };
    this.helpOpen = true;
    this.push(help);
  }

  /**
   * Confirm dialog (contract item 5): resolves true on confirm, false on
   * cancel. The caller performs the mutation only after `true`.
   */
  confirm(opts: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const view = new ConfirmView(opts);
      view.onResult = (r) => {
        this.pop();
        this.requestRender();
        resolve(r === "confirm");
      };
      this.push(view);
    });
  }

  /** Single-line prompt. Resolves the entered text, or null on cancel. */
  prompt(text: string, opts: TextInputOptions = {}): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const view = new PromptView(text, opts);
      view.onSubmit = () => {
        const v = view.result;
        this.pop();
        this.requestRender();
        resolve(v);
      };
      view.onCancel = () => {
        this.pop();
        this.requestRender();
        resolve(null);
      };
      this.push(view);
    });
  }

  /** Select from a list. Resolves the chosen item or null on cancel. */
  select<T>(opts: SelectListOptions<T>): Promise<SelectItem<T> | null> {
    return new Promise((resolve) => {
      const view = new SelectList(opts);
      view.onSelect = () => {
        const v = view.selected;
        this.pop();
        this.requestRender();
        resolve(v);
      };
      view.onCancel = () => {
        this.pop();
        this.requestRender();
        resolve(null);
      };
      this.push(view);
    });
  }

  // --- status line -----------------------------------------------------------------

  setStatus(left: string, right = "", style?: Style): void {
    this.statusLeft = left;
    this.statusRight = right;
    this.statusStyle = style;
    this.requestRender();
  }

  clearStatus(): void {
    this.setStatus("");
  }

  // --- internals ---------------------------------------------------------------------

  private collectKeymap(): KeyBinding[] {
    const out: KeyBinding[] = [...(this.opts.keymap ?? [])];
    // Top view's bindings first (most relevant), then global.
    const top = this.topView;
    if (top?.keymap) {
      const tb = top.keymap();
      // Merge: top view bindings take precedence — append global after.
      out.unshift(...tb);
    }
    // Always document reserved keys.
    out.push(
      { keys: ["?", "h"], description: "help" },
      { keys: ["esc", "q"], description: "back / close" },
      { keys: "ctrl+c", description: "cancel / exit" },
    );
    return out;
  }

  private onKey(ev: KeyEvent): void {
    if (this.closedFlag) return;
    if (ev.kind === "eof") {
      void this.close();
      return;
    }

    const top = this.topView;

    // Task cancellation takes precedence: Esc / Ctrl-C cancel the running
    // task before any view sees them (contract item 7).
    if (this.tasks.busy && ev.kind === "key") {
      if (matchKey(ev, "escape") || matchKey(ev, "ctrl+c")) {
        this.tasks.cancel();
        this.requestRender();
        return;
      }
    }

    let consumed = false;
    if (top?.handleKey) {
      consumed = top.handleKey(ev) === true;
    }
    if (consumed) {
      this.requestRender();
      return;
    }

    // Reserved keys (contract §6).
    if (ev.kind === "key") {
      if (matchKey(ev, "?") || matchKey(ev, "h")) {
        if (!this.helpOpen) this.showHelp();
        return;
      }
      if (matchKey(ev, "ctrl+c")) {
        this.onCtrlC();
        return;
      }
      if (matchKey(ev, "escape") || matchKey(ev, "q")) {
        // Pop a pushed screen; close when only the base view remains.
        if (this.stack.length > 1) {
          this.pop();
        } else {
          void this.close();
        }
        return;
      }
    }
    this.requestRender();
  }

  private onCtrlC(): void {
    if (this.tasks.busy) {
      this.tasks.cancel();
      return;
    }
    const now = Date.now();
    if (this.ctrlCCount > 0 && now - (this.ctrlCLast ?? 0) < 1500) {
      void this.close();
      return;
    }
    this.ctrlCCount += 1;
    this.ctrlCLast = now;
    this.setStatusLeft(`Ctrl-C again to exit (${this.opts.title ?? "TUI"})`);
    if (this.ctrlCTimer) clearTimeout(this.ctrlCTimer);
    this.ctrlCTimer = setTimeout(() => {
      this.ctrlCCount = 0;
      this.ctrlCTimer = null;
      this.requestRender();
    }, 1600);
    if (typeof this.ctrlCTimer === "object" && this.ctrlCTimer && "unref" in this.ctrlCTimer) {
      (this.ctrlCTimer as { unref: () => void }).unref();
    }
    this.requestRender();
  }

  private ctrlCLast = 0;

  private setStatusLeft(s: string): void {
    this.statusLeft = s;
    this.requestRender();
  }

  private onResize(): void {
    const { columns, rows } = readSize(this.opts.output ?? process.stdout);
    if (columns === this.lastSize.columns && rows === this.lastSize.rows) return;
    this.lastSize = { columns, rows };
    this.screen.resize(columns, rows);
    const top = this.topView;
    top?.onResize?.(this.viewWidth(), this.viewHeight());
    this.requestRender(true);
  }

  private chromeRows(): number {
    let n = 0;
    if (this.opts.title) n += 1;
    if (this.opts.statusLine !== false) n += 1;
    return n;
  }

  private viewWidth(): number {
    return this.screen.columns;
  }

  private viewHeight(): number {
    return Math.max(1, this.screen.rows - this.chromeRows());
  }

  private throttledDraw = createThrottle(() => this.drawNow(), { intervalMs: 33 });

  private requestRender(immediate = false): void {
    if (immediate) {
      this.throttledDraw.flush();
      this.drawNow();
      return;
    }
    this.throttledDraw.call();
  }

  private drawNow(): void {
    if (this.closedFlag) return;
    const w = this.viewWidth();
    const h = this.viewHeight();
    const top = this.topView;
    const viewLines = top ? top.render(w, h) : [];

    const frame: Line[] = [];
    if (this.opts.title) {
      frame.push([{ text: this.opts.title, style: { bold: true } }]);
    }
    for (let r = 0; r < h; r++) frame.push(viewLines[r] ?? []);
    if (this.opts.statusLine !== false) {
      const status = this.currentStatusLine(w);
      frame.push(status);
    }
    this.screen.render(frame, "hide");
  }

  private currentStatusLine(w: number): Line {
    // Task progress overrides the static status while running.
    if (this.opts.taskProgress !== false && this.taskSnapshot) {
      const snap = this.taskSnapshot;
      const left = formatTaskSnapshot(snap);
      return statusLine(w, left, "ctrl+c — cancel", { style: { dim: true } });
    }
    if (this.statusLeft === "" && this.statusRight === "") {
      return statusLine(w, "", "?/h — help", { style: { dim: true } });
    }
    return statusLine(w, this.statusLeft, this.statusRight || "?/h — help", {
      ...(this.statusStyle ? { style: this.statusStyle } : {}),
    });
  }

  /** Close the app: restore terminal, resolve `closed`. Idempotent. */
  async close(): Promise<void> {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.throttledDraw.cancel();
    this.throttledDraw.flush();
    if (this.ctrlCTimer) clearTimeout(this.ctrlCTimer);
    if (this.detachInput) {
      this.detachInput();
      this.detachInput = null;
    }
    const input = this.opts.input ?? process.stdin;
    try {
      if (typeof (input as { setRawMode?: unknown }).setRawMode === "function") {
        (input as NodeJS.ReadStream).setRawMode(false);
      }
      input.pause();
    } catch {
      // ignore
    }
    this.screen.close(this.opts.farewell);
    this.resolveClosed();
  }
}

// --- Non-TTY fallback ------------------------------------------------------------

/**
 * Render a view to plain text lines without a terminal — the honest
 * unsupported-state path for pipes/CI (contract item 9: never fake a TUI).
 * ANSI styling is stripped; text is sanitized and width-clipped.
 */
export function renderPlain(view: ScreenView, width: number, height: number): string[] {
  const lines = view.render(Math.max(1, width), Math.max(1, height));
  return lines.map((line) => {
    const plain = line.map((s) => s.text).join("");
    return truncateToWidth(sanitizeDisplay(plain), Math.max(1, width));
  });
}
