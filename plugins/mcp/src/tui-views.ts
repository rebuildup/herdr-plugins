/**
 * Screen views for the rebuildup.mcp diagnostics TUI
 * (`herdr-plugins.tui/v1`, ADR-0031/0032/0033).
 *
 * Scope (issue #248, ADR-0033 out-of-scope): DIAGNOSTICS ONLY. The MCP
 * server is never screen-ified — no `serve`, no tool invocation, no
 * mutations. Every view renders the `capability` document fetched
 * through the plugin's own CLI subprocess; absent/unreachable fields
 * render their real error or `unknown`, never a fabricated state
 * (contract item 9).
 *
 * Safety-contract mapping:
 * - read-only open: `McpOverviewView.load` runs only `capability` —
 *   a pure read. No lazy work exists (the plugin holds no durable
 *   state and no daemon).
 * - explicit target: the session/socket under diagnosis is the one
 *   `capability` resolves from the inherited env (HERDR_SOCKET_PATH /
 *   HERDR_SESSION / flags); the pinned launch context is display-only.
 * - timeout/cancel: the capability fetch runs inside `ui.tasks.run`
 *   (progress, Ctrl-C/Esc cancel, timeout, partial labeling).
 * - escape safety: all strings come from the capability document and
 *   are clipped/sanitized by the shared renderer.
 */

import {
  clip,
  DetailView,
  type KeyBinding,
  type KeyEvent,
  type Line,
  type ScreenView,
  SelectList,
  type TaskRunner,
} from "../../../packages/tui/src/index";
import {
  asPlugins,
  asTools,
  type CliRunOptions,
  errorLine,
  formatOverviewLines,
  formatPluginLines,
  formatReferenceLines,
  formatToolLines,
  type PinnedTarget,
  type PluginRow,
  pluginSelectItem,
  type ToolRow,
  toolSelectItem,
} from "./tui-support";

// --- shared deps ----------------------------------------------------------------

/** The subset of `TuiApp` the views need (TuiApp satisfies this). */
export interface McpTuiUi {
  setStatus(left: string, right?: string): void;
  push(view: ScreenView): void;
  pop(): ScreenView | undefined;
  tasks: TaskRunner;
  /** Repaint on the next frame after async view state changes. */
  invalidate(): void;
  close(): Promise<void>;
}

export interface McpTuiDeps {
  cli(args: readonly string[], options?: CliRunOptions): Promise<Record<string, unknown>>;
  ui: McpTuiUi;
  /** Pinned launch context (display only — mcp has no pane mutations). */
  target: PinnedTarget;
}

// --- overview (root view) ---------------------------------------------------------

export class McpOverviewView implements ScreenView {
  private readonly deps: McpTuiDeps;
  private payload: Record<string, unknown> | null = null;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";

  constructor(deps: McpTuiDeps) {
    this.deps = deps;
    void this.load();
  }

  /** Read-only load: `capability` only. Never spawns `serve`. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    const result = await this.deps.ui.tasks.run(
      { label: "mcp capability", timeoutMs: 120_000 },
      (signal) =>
        Promise.resolve()
          .then(() => this.deps.cli(["capability"], { signal, timeoutMs: 120_000 }))
          // Surface the structured kind (session_unreachable, usage, …)
          // in the task error line — TaskRunner keeps message only.
          .catch((err: unknown) => {
            throw new Error(errorLine(err));
          }),
    );
    if (result.status === "ok" && result.value !== undefined) {
      this.payload = result.value;
      this.phase = "ready";
      this.errorText = "";
    } else {
      this.phase = "error";
      this.errorText =
        result.status === "cancelled"
          ? "cancelled"
          : `${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`;
    }
    this.deps.ui.invalidate();
  }

  private pushDetail(title: string, lines: string[]): void {
    this.deps.ui.push(new DetailView({ title, lines, onClose: () => this.deps.ui.pop() }));
  }

  private openTools(): void {
    if (this.payload === null) return;
    this.deps.ui.push(new ToolTableView(this.deps, this.payload));
  }

  private openPlugins(): void {
    if (this.payload === null) return;
    this.deps.ui.push(new PluginAvailabilityView(this.deps, this.payload));
  }

  private openReference(): void {
    if (this.payload === null) return;
    this.pushDetail("contract reference", formatReferenceLines(this.payload));
  }

  private openRaw(): void {
    if (this.payload === null) return;
    this.pushDetail("capability (raw JSON)", [JSON.stringify(this.payload, null, 2)]);
  }

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    if (this.phase === "loading") {
      lines.push([{ text: "loading mcp capability…", style: { dim: true } }]);
    } else if (this.phase === "error") {
      lines.push([
        { text: "failed to load capability document", style: { bold: true, fg: "red" } },
      ]);
      for (const l of this.errorText.split("\n")) {
        lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
      }
      lines.push([{ text: "r — retry · q — close", style: { dim: true } }]);
    } else if (this.payload !== null) {
      for (const l of formatOverviewLines(this.payload)) {
        lines.push([{ text: clip(l, width) }]);
      }
      lines.push([]);
      lines.push([
        {
          text: "t — tools · p — plugins · i — reference · j — raw · r — refresh · ? — help",
          style: { dim: true },
        },
      ]);
    }
    while (lines.length < height) lines.push([]);
    return lines.slice(0, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    switch (ev.key) {
      case "t":
        this.openTools();
        return true;
      case "p":
        this.openPlugins();
        return true;
      case "i":
        this.openReference();
        return true;
      case "j":
        this.openRaw();
        return true;
      case "r":
      case "R":
        void this.load();
        return true;
      default:
        return false;
    }
  }

  keymap(): KeyBinding[] {
    return [
      { keys: "t", description: "tool table" },
      { keys: "p", description: "plugin availability" },
      { keys: "i", description: "contract reference" },
      { keys: "j", description: "raw capability JSON" },
      { keys: ["r", "R"], description: "refresh" },
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

// --- tool table -------------------------------------------------------------------

export class ToolTableView implements ScreenView {
  private readonly deps: McpTuiDeps;
  private readonly payload: Record<string, unknown>;
  private readonly list: SelectList<ToolRow>;
  private tools: ToolRow[] = [];

  constructor(deps: McpTuiDeps, payload: Record<string, unknown>) {
    this.deps = deps;
    this.payload = payload;
    this.tools = asTools(payload.tools);
    this.list = new SelectList<ToolRow>({
      items: this.tools.map(toolSelectItem),
      filterable: true,
      emptyText: "no tools reported by capability",
    });
    this.list.onSelect = (item) => {
      if (item.value) this.openDetail(item.value);
    };
    this.list.onCancel = () => this.deps.ui.pop();
  }

  private openDetail(tool: ToolRow): void {
    this.deps.ui.push(
      new DetailView({
        title: `tool ${tool.name}`,
        lines: formatToolLines(tool, this.payload.negotiated_access_level),
        onClose: () => this.deps.ui.pop(),
      }),
    );
  }

  render(width: number, height: number): Line[] {
    return this.list.render(width, height);
  }

  handleKey(ev: KeyEvent): boolean {
    return this.list.handleKey(ev);
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "tool detail" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- plugin availability ------------------------------------------------------------

export class PluginAvailabilityView implements ScreenView {
  private readonly deps: McpTuiDeps;
  private readonly list: SelectList<PluginRow>;

  constructor(deps: McpTuiDeps, payload: Record<string, unknown>) {
    this.deps = deps;
    const plugins = asPlugins(payload.plugins);
    this.list = new SelectList<PluginRow>({
      items: plugins.map(pluginSelectItem),
      filterable: true,
      emptyText: "no plugin availability reported",
    });
    this.list.onSelect = (item) => {
      if (item.value) this.openDetail(item.value);
    };
    this.list.onCancel = () => this.deps.ui.pop();
  }

  private openDetail(plugin: PluginRow): void {
    this.deps.ui.push(
      new DetailView({
        title: `plugin ${plugin.plugin}`,
        lines: formatPluginLines(plugin),
        onClose: () => this.deps.ui.pop(),
      }),
    );
  }

  render(width: number, height: number): Line[] {
    return this.list.render(width, height);
  }

  handleKey(ev: KeyEvent): boolean {
    return this.list.handleKey(ev);
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "plugin detail" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}
