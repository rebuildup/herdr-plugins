/**
 * Screen views for the rebuildup.secrets TUI (`herdr-plugins.tui/v1`,
 * issue #247; secret boundary ADR-0027).
 *
 * Safety-contract mapping (ADR-0033 §3 / tui-v1 §5 + ADR-0027):
 * - read-only open: `SecretsListView.load` runs only `config` +
 *   `capability` — metadata reads. No resolution happens on open.
 * - explicit target: `inject` names its surface (+ pinned or prompted
 *   workspace/pane); `run` names its command line explicitly.
 * - mutation gating: `run`/`inject`/`config` consult
 *   `capability.mutation_commands`; `resolve`/`config` reads are ungated.
 * - irreversible confirmation: run/inject/config-init show exact
 *   binding names + env names + target + consequence; Esc cancels.
 * - SECRET NON-DISPLAY (ADR-0027, contract item 6): binding selection
 *   passes names only; `resolve` renders whitelisted metadata fields
 *   (name/env/ref/status/detail) — value-shaped payload keys can never
 *   reach the view model (unit-tested); `run` hands off to
 *   `cli.ts run` with inherited stdio after the TUI restores the
 *   terminal, so resolved values flow only into the child env.
 * - timeout/cancel: JSON CLI work runs inside `ui.tasks.run`;
 *   `runExternal` is an explicit hand-off, not a background task.
 * - honest unsupported: missing infisical CLI / unreachable provider /
 *   invalid bindings render their real statuses, never fabricated.
 */

import {
  type ConfirmOptions,
  clip,
  DetailView,
  type KeyBinding,
  type KeyEvent,
  type Line,
  type ScreenView,
  type SelectItem,
  SelectList,
  type SelectListOptions,
  type TaskRunner,
  type TextInputOptions,
} from "../../../packages/tui/src/index";
import {
  type BindingView,
  bindingSelectItem,
  type CapabilityDoc,
  type CliRunOptions,
  errorLine,
  formatCapabilityPayload,
  formatInjectResult,
  formatResolvePayload,
  formatTargetLabel,
  mutationAllowed,
  type PinnedTarget,
  parseBindings,
  splitCommandLine,
} from "./tui-support";

// --- shared deps ----------------------------------------------------------------

/** The subset of `TuiApp` the views need (TuiApp satisfies this). */
export interface SecretsTuiUi {
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

export interface SecretsTuiDeps {
  cli(args: readonly string[], options?: CliRunOptions): Promise<Record<string, unknown>>;
  ui: SecretsTuiUi;
  /** `capability` payload fetched at launch; null = unavailable (fail closed). */
  capability: CapabilityDoc | null;
  target: PinnedTarget;
  /**
   * Declared bindings from the last `config` load — mutated by
   * SecretsListView on reload; flows read the current value.
   */
  bindings: BindingView[];
  /** `config --init` writes the starter config; gated + confirmed. */
  onChanged?: () => void;
  /**
   * Explicit `run` hand-off (ADR-0027): the implementation closes the
   * TUI (restoring the terminal), spawns `cli.ts run --binding … --
   * <cmd>` with inherited stdio, then respawns the TUI. Binding NAMES
   * only cross this boundary — never values.
   */
  runExternal(args: readonly string[]): Promise<number>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
}

// --- shared flows -----------------------------------------------------------------

/**
 * Pick one or more declared bindings via repeated selects. Returns the
 * chosen names (≥1) or null when the user cancels with nothing picked.
 * Invalid bindings are rendered disabled-with-reason and cannot be
 * picked (tui-v1 §5.4 honest gating).
 */
async function pickBindings(
  deps: SecretsTuiDeps,
  preselected: readonly string[] = [],
): Promise<string[] | null> {
  const picked: string[] = [...preselected];
  const valid = deps.bindings.filter((b) => b.invalidReason === null);
  if (valid.length === 0) {
    deps.ui.setStatus("no valid bindings declared — edit config.json (CLI: config --init)");
    return null;
  }
  for (;;) {
    const remaining = valid.filter((b) => !picked.includes(b.name));
    const items: SelectItem<string>[] = remaining.map((b) => ({
      value: b.name,
      label: `${b.name} → ${b.env}`,
      detail: `ref: ${b.ref}`,
    }));
    items.push({
      value: "__done__",
      label: picked.length > 0 ? `done — ${picked.length} binding(s) selected` : "cancel",
      detail: "finish selection",
    });
    const chosen = await deps.ui.select<string>({
      items,
      filterable: true,
      emptyText: "no bindings declared",
    });
    if (chosen === null || chosen.value === undefined) {
      // Esc/cancel ends the picker; keep what was picked so far.
      break;
    }
    if (chosen.value === "__done__") break;
    if (!picked.includes(chosen.value)) picked.push(chosen.value);
  }
  if (picked.length === 0) {
    deps.ui.setStatus("no bindings selected — cancelled");
    return null;
  }
  return picked;
}

function bindingArgs(names: readonly string[]): string[] {
  return names.flatMap((n) => ["--binding", n]);
}

function bindingEnvNames(deps: SecretsTuiDeps, names: readonly string[]): string[] {
  return names
    .map((n) => deps.bindings.find((b) => b.name === n)?.env ?? "?")
    .filter((e) => e !== "?");
}

async function runOp(
  deps: SecretsTuiDeps,
  label: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown> | null> {
  const result = await deps.ui.tasks.run(
    { label, timeoutMs: options.timeoutMs ?? 120_000 },
    (signal) => deps.cli(args, { signal, timeoutMs: options.timeoutMs ?? 120_000 }),
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
 * Metadata-only resolve preview (read; no mutation gate). Values are
 * never part of the payload — the formatter whitelists fields.
 */
export async function resolveFlow(deps: SecretsTuiDeps, names?: readonly string[]): Promise<void> {
  const picked = names ?? (await pickBindings(deps));
  if (picked === null) return;
  const payload = await runOp(deps, "resolve", ["resolve", ...bindingArgs(picked)]);
  if (payload === null) return;
  deps.ui.push(
    new DetailView({
      title: `resolve — ${picked.join(", ")}`,
      lines: formatResolvePayload(payload),
      onClose: () => deps.ui.pop(),
    }),
  );
}

/**
 * Explicit `run` mutation: select bindings → command line → confirm →
 * hand off to `cli.ts run` with inherited stdio (values → child env
 * only, ADR-0027). The TUI does not capture the child's output.
 */
export async function runFlow(deps: SecretsTuiDeps, names?: readonly string[]): Promise<void> {
  if (!gate(deps, "run")) return;
  const picked = names ?? (await pickBindings(deps));
  if (picked === null) return;
  const input = await deps.ui.prompt("Command to run with injected env (quotes allowed; no shell)");
  if (input === null) return;
  const split = splitCommandLine(input);
  if (!split.ok) {
    deps.ui.setStatus(`command parse failed: ${split.error}`);
    return;
  }
  if (split.argv.length === 0) {
    deps.ui.setStatus("empty command — cancelled");
    return;
  }
  const envNames = bindingEnvNames(deps, picked);
  const ok = await deps.ui.confirm({
    title: "Run command with injected secrets?",
    target: [
      `bindings: ${picked.join(", ")}`,
      `env names: ${envNames.join(", ") || "?"}`,
      `command: ${split.argv.join(" ")}`,
      `target: ${formatTargetLabel(deps.target)}`,
    ],
    consequence:
      "resolves the selected bindings and runs the command with values in its environment only — values are never displayed; the TUI exits while the command runs in this pane, then reopens",
    confirmLabel: "Run",
    danger: true,
  });
  if (!ok) return;
  const code = await deps.runExternal(["run", ...bindingArgs(picked), "--", ...split.argv]);
  deps.ui.setStatus(`run finished (exit ${code})`);
}

/**
 * Explicit `inject` mutation: select bindings → surface → confirm →
 * `cli.ts inject` (creates a herdr surface whose env carries the
 * resolved values; names only cross the wire visibly).
 */
export async function injectFlow(deps: SecretsTuiDeps, names?: readonly string[]): Promise<void> {
  if (!gate(deps, "inject")) return;
  const picked = names ?? (await pickBindings(deps));
  if (picked === null) return;
  const surfaceChoice = await deps.ui.select<string>({
    items: [
      { value: "workspace", label: "workspace", detail: "workspace.create with env" },
      { value: "tab", label: "tab", detail: "tab.create with env" },
      {
        value: "pane",
        label: "pane",
        detail: "pane.split with env (right/down)",
      },
    ],
  });
  if (surfaceChoice === null || surfaceChoice.value === undefined) return;
  const surface = surfaceChoice.value;

  const args: string[] = ["inject", ...bindingArgs(picked), "--surface", surface];

  if (surface === "pane") {
    const dirChoice = await deps.ui.select<string>({
      items: [
        { value: "right", label: "right", detail: "split right" },
        { value: "down", label: "down", detail: "split down" },
      ],
    });
    if (dirChoice === null || dirChoice.value === undefined) return;
    args.push("--direction", dirChoice.value);
    const pinned = deps.target.originPaneId;
    let targetPane: string | null = pinned;
    if (pinned !== null) {
      const use = await deps.ui.confirm({
        title: "Split the pinned origin pane?",
        target: [`pane: ${pinned}`, `surface: pane (${dirChoice.value})`],
        consequence: "creates a split pane next to the origin pane",
        confirmLabel: "Use pane",
        cancelLabel: "Pick another / omit",
      });
      if (!use) targetPane = null;
    }
    if (targetPane === null) {
      const input = await deps.ui.prompt("Target pane id (empty = active pane)");
      if (input === null) return;
      const trimmed = input.trim();
      if (trimmed !== "") args.push("--target-pane", trimmed);
    } else {
      args.push("--target-pane", targetPane);
    }
  } else if (surface === "tab" && deps.target.workspaceId !== null) {
    args.push("--workspace", deps.target.workspaceId);
  }

  const cwdInput = await deps.ui.prompt("cwd for the new surface (optional — Enter for none)");
  if (cwdInput === null) return;
  const cwd = cwdInput.trim();
  if (cwd !== "") args.push("--cwd", cwd);

  const envNames = bindingEnvNames(deps, picked);
  const ok = await deps.ui.confirm({
    title: `Inject secrets into a new ${surface}?`,
    target: [
      `bindings: ${picked.join(", ")}`,
      `env names: ${envNames.join(", ") || "?"}`,
      `surface: ${surface}${cwd !== "" ? ` · cwd: ${cwd}` : ""}`,
      `target: ${formatTargetLabel(deps.target)}`,
    ],
    consequence:
      "creates the herdr surface with resolved values in its creation env — values are never displayed or persisted by the plugin",
    confirmLabel: "Inject",
    danger: true,
  });
  if (!ok) return;
  const payload = await runOp(deps, "inject", args, { timeoutMs: 300_000 });
  if (payload !== null) {
    deps.ui.push(
      new DetailView({
        title: `inject — ${surface}`,
        lines: formatInjectResult(payload),
        onClose: () => deps.ui.pop(),
      }),
    );
    deps.onChanged?.();
  }
}

/** `config --init` — writes the starter config file (mutation, gated). */
export async function configInitFlow(deps: SecretsTuiDeps): Promise<void> {
  if (!gate(deps, "config")) return;
  const ok = await deps.ui.confirm({
    title: "Write starter secrets config?",
    target: ["config.json under the plugin config dir"],
    consequence:
      "creates a template config with an empty bindings array — edit it to declare bindings; no secret values are involved",
    confirmLabel: "Write config",
  });
  if (!ok) return;
  const payload = await runOp(deps, "config --init", ["config", "--init"]);
  if (payload !== null) {
    deps.ui.setStatus(`config written: ${typeof payload.file === "string" ? payload.file : "?"}`);
    deps.onChanged?.();
  }
}

/** Capability/contract info detail (read-only diagnostics). */
export async function capabilityFlow(deps: SecretsTuiDeps): Promise<void> {
  const payload = await runOp(deps, "capability", ["capability"], { timeoutMs: 60_000 });
  if (payload !== null) {
    deps.ui.push(
      new DetailView({
        title: "capability — provider & contract",
        lines: formatCapabilityPayload(payload),
        onClose: () => deps.ui.pop(),
      }),
    );
  }
}

function gate(deps: SecretsTuiDeps, command: string): boolean {
  const result = mutationAllowed(deps.capability, command);
  if (!result.allowed) {
    deps.ui.setStatus(`mutations disabled: ${result.reason ?? command}`);
    return false;
  }
  return true;
}

// --- binding list (root view) ------------------------------------------------------

export class SecretsListView implements ScreenView {
  private readonly deps: SecretsTuiDeps;
  private readonly onOpen: (binding: BindingView) => void;
  private readonly list: SelectList<BindingView>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";
  private configFile: string | null = null;
  private warnings: string[] = [];

  constructor(deps: SecretsTuiDeps, onOpen: (binding: BindingView) => void) {
    this.deps = deps;
    this.onOpen = onOpen;
    this.list = new SelectList<BindingView>({
      items: [],
      filterable: true,
      emptyText: "no bindings declared — w init starter config, then edit config.json",
    });
    this.list.onSelect = (item) => {
      if (item.value) this.onOpen(item.value);
    };
    this.list.onCancel = () => void this.deps.ui.close();
  }

  /** (Re)load config + capability. Read-only: `config`/`capability`. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const [configPayload, capabilityPayload] = await Promise.all([
        this.deps.cli(["config"]),
        this.deps.cli(["capability"]).catch(() => null),
      ]);
      const config = asRecord(configPayload.config);
      this.configFile = typeof configPayload.file === "string" ? configPayload.file : null;
      this.warnings = Array.isArray(configPayload.warnings)
        ? configPayload.warnings.filter((w): w is string => typeof w === "string")
        : [];
      this.warnings.push(
        ...asArray(configPayload.invalid_bindings)
          .map((b) => `invalid binding ${String(b.name ?? "?")}: ${String(b.error ?? "?")}`)
          .filter((w) => typeof w === "string"),
      );
      this.deps.bindings = parseBindings(config?.bindings, configPayload.invalid_bindings);
      if (capabilityPayload !== null) {
        // Refresh the shared capability doc (mutation gating source).
        this.deps.capability = capabilityPayload;
      }
      this.list.setItems(this.deps.bindings.map(bindingSelectItem));
      this.phase = "ready";
      this.errorText = "";
    } catch (err) {
      this.phase = "error";
      this.errorText = errorLine(err);
    }
    this.deps.ui.invalidate();
  }

  private metaLines(): string[] {
    const lines: string[] = [];
    if (this.configFile !== null) lines.push(`config: ${this.configFile}`);
    lines.push(`bindings: ${this.deps.bindings.length} declared`);
    for (const w of this.warnings.slice(0, 4)) lines.push(`warning: ${w}`);
    if (this.warnings.length > 4) lines.push(`… ${this.warnings.length - 4} more warnings`);
    return lines;
  }

  render(width: number, height: number): Line[] {
    const header = this.metaLines();
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: "loading bindings…", style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load secrets config", style: { bold: true, fg: "red" } }]);
        for (const l of this.errorText.split("\n")) {
          lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
        }
        lines.push([{ text: "R — retry · Esc — close", style: { dim: true } }]);
      }
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    const rendered = this.list.render(width, height - Math.min(header.length, 3));
    const out: Line[] = [];
    for (const l of header.slice(0, 3)) {
      out.push([{ text: clip(l, width), style: { dim: true } }]);
    }
    out.push(...rendered.slice(0, height - out.length));
    while (out.length < height) out.push([]);
    return out.slice(0, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.list.handleKey(ev) === true) return true;
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    switch (ev.key) {
      case "r":
        void resolveFlow(this.deps);
        return true;
      case "n":
        void runFlow(this.deps);
        return true;
      case "i":
        void injectFlow(this.deps);
        return true;
      case "c":
        void capabilityFlow(this.deps);
        return true;
      case "w":
        void configInitFlow(this.deps);
        return true;
      case "R":
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
      { keys: "enter", description: "binding detail" },
      { keys: "r", description: "resolve preview (metadata only)" },
      { keys: "n", description: "run command w/ env (confirm)" },
      { keys: "i", description: "inject into new surface (confirm)" },
      { keys: "c", description: "capability / provider info" },
      { keys: "w", description: "init starter config (confirm)" },
      { keys: ["R"], description: "refresh" },
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

// --- binding detail -----------------------------------------------------------------

export class BindingDetailView implements ScreenView {
  private readonly deps: SecretsTuiDeps;
  private readonly bindingName: string;

  constructor(deps: SecretsTuiDeps, bindingName: string) {
    this.deps = deps;
    this.bindingName = bindingName;
  }

  private binding(): BindingView | null {
    return this.deps.bindings.find((b) => b.name === this.bindingName) ?? null;
  }

  private bodyLines(): string[] {
    const b = this.binding();
    const lines: string[] = [];
    if (b === null) {
      lines.push(`binding not found: ${this.bindingName}`);
      lines.push("it may have been removed from config.json — go back and refresh");
      return lines;
    }
    lines.push(`binding ${b.name}${b.invalidReason !== null ? " — INVALID" : ""}`);
    lines.push(`env name: ${b.env}`);
    lines.push(`ref: ${b.ref}`);
    if (b.projectId !== null) lines.push(`project: ${b.projectId}`);
    if (b.invalidReason !== null) lines.push(`invalid: ${b.invalidReason}`);
    lines.push("");
    lines.push("secret values are NEVER displayed, logged, or placed in argv");
    lines.push("(ADR-0027). Only the name/env/ref metadata above is rendered.");
    lines.push("");
    lines.push("r resolve preview · n run w/ env · i inject into surface");
    return lines;
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
    const view = body.slice(0, Math.max(0, height - 1));
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
    lines.push([{ text: "? — help · esc — back".padStart(width), style: { dim: true } }]);
    return lines.slice(0, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    switch (ev.key) {
      case "r":
        void resolveFlow(this.deps, [this.bindingName]);
        return true;
      case "n":
        void runFlow(this.deps, [this.bindingName]);
        return true;
      case "i":
        void injectFlow(this.deps, [this.bindingName]);
        return true;
      default:
        return false;
    }
  }

  keymap(): KeyBinding[] {
    return [
      { keys: "r", description: "resolve preview (metadata only)" },
      { keys: "n", description: "run command w/ env (confirm)" },
      { keys: "i", description: "inject into new surface (confirm)" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}
