/**
 * Screen views for the rebuildup.machines TUI (`herdr-plugins.tui/v1`,
 * issue #247; read-only inventory per ADR-0028).
 *
 * Safety-contract mapping (ADR-0033 §3 / tui-v1 §5):
 * - read-only open: `MachinesListView.load` runs only `list` — a read
 *   (last-known probe metadata, never a live probe). No probe runs
 *   implicitly on open.
 * - explicit target: `probe` names the machine id (or `--all`)
 *   explicitly; machine lifecycle is never touched (herdr CLI owns it).
 * - timeout/cancel: `probe` runs inside `ui.tasks.run` — SSH probes are
 *   slow, so progress shows and Ctrl-C/Esc cancels (kills the CLI
 *   subprocess). Partial results are labeled by the task runner.
 * - honest unsupported: unreachable/disabled/unsupported-remote probe
 *   states render verbatim; a missing `herdr` CLI or socket failure
 *   renders the real error, never a fabricated inventory.
 * - no mutations: this plugin is read-only (`mutation_commands: []`);
 *   the TUI exposes no mutating affordance at all.
 */

import {
  type ConfirmOptions,
  clip,
  DetailView,
  type KeyBinding,
  type KeyEvent,
  type Line,
  matchKey,
  type ScreenView,
  type SelectItem,
  SelectList,
  type SelectListOptions,
  type TaskRunner,
  type TextInputOptions,
} from "../../../packages/tui/src/index";
import {
  asMachineItems,
  type CliRunOptions,
  errorLine,
  formatCapabilityPayload,
  formatProbePayload,
  type MachineItem,
  machineHeaderLines,
  machineSelectItem,
  type PinnedTarget,
} from "./tui-support";

// --- shared deps ----------------------------------------------------------------

/** The subset of `TuiApp` the views need (TuiApp satisfies this). */
export interface MachinesTuiUi {
  confirm(opts: ConfirmOptions): Promise<boolean>;
  prompt(text: string, opts?: TextInputOptions): Promise<string | null>;
  select<T>(opts: SelectListOptions<T>): Promise<SelectItem<T> | null>;
  setStatus(left: string, right?: string): void;
  push(view: ScreenView): void;
  pop(): ScreenView | undefined;
  tasks: TaskRunner;
  /** Repaint on the next frame after async view state changes. */
  invalidate(): void;
  close(): Promise<void>;
}

export interface MachinesTuiDeps {
  cli(args: readonly string[], options?: CliRunOptions): Promise<Record<string, unknown>>;
  ui: MachinesTuiUi;
  /** `capability` payload fetched at launch; null = unavailable. */
  capability: Record<string, unknown> | null;
  target: PinnedTarget;
  /** Called after a successful probe so ancestor views can reload. */
  onChanged?: () => void;
}

/** Run a CLI op inside the task runner; returns payload or null. */
async function runOp(
  deps: MachinesTuiDeps,
  label: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown> | null> {
  const result = await deps.ui.tasks.run(
    { label, timeoutMs: options.timeoutMs ?? 300_000 },
    (signal) => deps.cli(args, { signal, timeoutMs: options.timeoutMs ?? 300_000 }),
  );
  if (result.status === "ok" && result.value !== undefined) {
    return result.value;
  }
  deps.ui.setStatus(
    result.status === "cancelled"
      ? `${label} cancelled`
      : `${label} ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
  );
  return null;
}

/**
 * On-demand probe (read-class; records last-known metadata). Slow —
 * runs inside the task runner so Ctrl-C/Esc cancels the CLI child.
 * `selector` is a machine id or "--all".
 */
async function probeFlow(deps: MachinesTuiDeps, selector: string): Promise<void> {
  const label = selector === "--all" ? "probe all machines" : `probe ${selector}`;
  const payload = await runOp(deps, label, ["probe", selector]);
  if (payload === null) return;
  deps.ui.push(
    new DetailView({
      title: label,
      lines: formatProbePayload(payload),
      onClose: () => deps.ui.pop(),
    }),
  );
  deps.onChanged?.();
}

// --- machine list (root view) -------------------------------------------------------

export class MachinesListView implements ScreenView {
  private readonly deps: MachinesTuiDeps;
  private readonly onOpen: (item: MachineItem) => void;
  private readonly list: SelectList<MachineItem>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";
  private items: MachineItem[] = [];

  constructor(deps: MachinesTuiDeps, onOpen: (item: MachineItem) => void) {
    this.deps = deps;
    this.onOpen = onOpen;
    this.list = new SelectList<MachineItem>({
      items: [],
      filterable: true,
      emptyText: "no saved machines — add via `herdr machine add` (CLI)",
    });
    this.list.onSelect = (item) => {
      if (item.value) this.onOpen(item.value);
    };
    this.list.onCancel = () => void this.deps.ui.close();
  }

  /** (Re)load the inventory. Read-only: `list` never probes live. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(["list"]);
      this.items = asMachineItems(payload.machines);
      this.list.setItems(this.items.map(machineSelectItem));
      this.phase = "ready";
      this.errorText = "";
      const total = typeof payload.total === "number" ? payload.total : this.items.length;
      this.deps.ui.setStatus(
        this.items.length === 0
          ? "no saved machines"
          : `${this.items.length} machine(s) — p probe selected · a probe all · i capability`,
        total > this.items.length ? `total ${total}` : "",
      );
    } catch (err) {
      this.phase = "error";
      this.errorText = errorLine(err);
    }
    this.deps.ui.invalidate();
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: "loading machines…", style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load machines", style: { bold: true, fg: "red" } }]);
        for (const l of this.errorText.split("\n")) {
          lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
        }
        lines.push([{ text: "R — retry · Esc — close", style: { dim: true } }]);
      }
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    return this.list.render(width, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.list.handleKey(ev) === true) return true;
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    switch (ev.key) {
      case "p": {
        const selected = this.list.selected?.value;
        if (selected === undefined) {
          this.deps.ui.setStatus("select a machine first (or use a for all)");
          return true;
        }
        void probeFlow(this.deps, selected.machine.id);
        return true;
      }
      case "a":
        void probeFlow(this.deps, "--all");
        return true;
      case "i":
        void capabilityInfo(this.deps);
        return true;
      case "R":
      case "r":
        void this.load();
        return true;
      default:
        return false;
    }
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "machine detail" },
      { keys: "p", description: "probe selected machine" },
      { keys: "a", description: "probe all machines" },
      { keys: "i", description: "capability / contract info" },
      { keys: ["r", "R"], description: "refresh" },
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

/** Capability/contract info detail (read-only diagnostics). */
async function capabilityInfo(deps: MachinesTuiDeps): Promise<void> {
  const payload = deps.capability ?? (await runOp(deps, "capability", ["capability"]));
  if (payload === null) return;
  deps.ui.push(
    new DetailView({
      title: "capability — contract & probe taxonomy",
      lines: formatCapabilityPayload(payload),
      onClose: () => deps.ui.pop(),
    }),
  );
}

// --- machine detail ------------------------------------------------------------------

export class MachineDetailView implements ScreenView {
  private readonly deps: MachinesTuiDeps;
  private readonly item: MachineItem;
  private scroll = 0;

  constructor(deps: MachinesTuiDeps, item: MachineItem) {
    this.deps = deps;
    this.item = item;
  }

  private async probeThis(): Promise<void> {
    await probeFlow(this.deps, this.item.machine.id);
  }

  private bodyLines(): string[] {
    return machineHeaderLines(this.item);
  }

  render(width: number, height: number): Line[] {
    const body = this.bodyLines().flatMap((l) => {
      const out: string[] = [];
      let rest = l;
      while (rest.length > 0) {
        out.push(rest.slice(0, Math.max(1, width - 1)));
        rest = rest.slice(Math.max(1, width - 1));
      }
      return out.length > 0 ? out : [""];
    });
    const maxScroll = Math.max(0, body.length - (height - 1));
    this.scroll = Math.min(this.scroll, maxScroll);
    const view = body.slice(this.scroll, this.scroll + height - 1);
    const lines: Line[] = [];
    for (let i = 0; i < view.length; i++) {
      const l = view[i] ?? "";
      if (i === 0) {
        lines.push([{ text: clip(l, width), style: { bold: true } }]);
      } else {
        lines.push([{ text: clip(l, width) }]);
      }
    }
    while (lines.length < height - 1) lines.push([]);
    const pos = `${Math.min(this.scroll + 1, body.length)}/${body.length}`;
    lines.push([{ text: pos.padStart(width), style: { dim: true } }]);
    return lines.slice(0, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (matchKey(ev, "up") || matchKey(ev, "k")) {
      this.scroll = Math.max(0, this.scroll - 1);
      return true;
    }
    if (matchKey(ev, "down") || matchKey(ev, "j")) {
      this.scroll += 1;
      return true;
    }
    if (matchKey(ev, "pageup")) {
      this.scroll = Math.max(0, this.scroll - 10);
      return true;
    }
    if (matchKey(ev, "pagedown") || matchKey(ev, "space")) {
      this.scroll += 10;
      return true;
    }
    if (matchKey(ev, "home")) {
      this.scroll = 0;
      return true;
    }
    if (matchKey(ev, "end")) {
      this.scroll = Number.MAX_SAFE_INTEGER;
      return true;
    }
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    if (ev.key === "p") {
      void this.probeThis();
      return true;
    }
    return false;
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      { keys: "p", description: "probe this machine" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}
