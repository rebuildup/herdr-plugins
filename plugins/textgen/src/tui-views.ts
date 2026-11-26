/**
 * Screen views for the rebuildup.textgen TUI (`herdr-plugins.tui/v1`).
 *
 * Safety-contract mapping (ADR-0033 §3 / tui-v1 §5):
 * - read-only open: launch fetches `capability` only; the task list
 *   performs no mutation. `generate` is the ONLY mutating command the
 *   surface can invoke and it always goes through gate → confirm →
 *   explicit run.
 * - explicit target: the pinned origin context is shown in the title
 *   and confirm dialogs; `--git-pane` names a pane explicitly (never
 *   ambient focus); `HERDR_PANE_ID` is never a target.
 * - stale generation: generation is stateless — there is no persisted
 *   target to go stale. The pre-run revalidation analog is the
 *   `git-context` preview for `--git-pane` tasks (read-only) plus the
 *   CLI's own guards; a moved/dead pane fails honestly via git-v1.
 * - mutation gating: `mutationAllowed(capability, "generate")` —
 *   fail closed when the capability document is unavailable.
 * - confirmation: every `generate` shows task/provider/model/fields +
 *   consequence; Esc cancels. `review_guide` additionally requires an
 *   explicit per-run `--allow-expensive` opt-in confirm.
 * - secret non-display: input VALUES are never rendered — the confirm
 *   lists field names and sizes only; the CLI secret guard still applies.
 * - timeout/cancel: `generate` runs inside `ui.tasks.run` with the
 *   contract timeout + grace; cancel DETACHES (never kills) so the
 *   agent-path workspace cleanup `finally` still runs — the result is
 *   discarded and reported honestly.
 * - honest unsupported: provider_unavailable / no_credential /
 *   provider_misconfigured / task_not_opted_in / quota_exceeded /
 *   input_secret_detected render their real `kind: message`.
 * - generation ≠ application: results are display+copy only. The
 *   contract persists nothing (#249) — the result view says so.
 */

import {
  type ConfirmOptions,
  clip,
  dim,
  hr,
  type KeyBinding,
  type KeyEvent,
  type Line,
  matchKey,
  padEndWidth,
  type ScreenView,
  type SelectItem,
  SelectList,
  type SelectListOptions,
  sanitizeDisplay,
  type TaskRunner,
  type TextInputOptions,
  text,
  wrapText,
} from "../../../packages/tui/src/index";
import { TASKS, type TaskKind } from "./model";
import {
  buildGenerateArgs,
  type CapabilityDoc,
  type CliRunOptions,
  capabilityTasks,
  configDefaults,
  copyToClipboard,
  errorLine,
  expensiveTaskOptIn,
  formatGenerateResult,
  formatTargetLabel,
  generateTimeoutMs,
  mutationAllowed,
  type PinnedTarget,
  providerOptions,
  resolveFieldValue,
  resultClipboardText,
  type TextgenTaskInfo,
} from "./tui-support";

// --- shared deps ----------------------------------------------------------------

/** The subset of `TuiApp` the views need (TuiApp satisfies this). */
export interface TextgenTuiUi {
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

export interface TextgenTuiDeps {
  cli(args: readonly string[], options?: CliRunOptions): Promise<Record<string, unknown>>;
  ui: TextgenTuiUi;
  /** `capability` payload fetched at launch; null = unavailable (fail closed). */
  capability: CapabilityDoc | null;
  target: PinnedTarget;
}

const GIT_TASKS = new Set(["branch_name", "commit_message", "pr_content"]);

function isGitTask(kind: string): boolean {
  return GIT_TASKS.has(kind);
}

/**
 * Task list source: `capability.tasks` when available, else the plugin's
 * own task registry (model.ts — the same table the CLI validates
 * against). Either way every row carries the contract input fields.
 */
export function effectiveTasks(capability: CapabilityDoc | null): TextgenTaskInfo[] {
  const fromCap = capabilityTasks(capability);
  if (fromCap.length > 0) return fromCap;
  return TASKS.map((t) => ({
    kind: t.kind,
    description: t.description,
    paths: [...t.paths],
    inputFields: [...t.inputFields],
    requiredInput: [...t.requiredInput],
    output: t.output,
    requiresOptIn: t.requiresOptIn === true,
  }));
}

function taskSelectItem(task: TextgenTaskInfo): SelectItem<TextgenTaskInfo> {
  const required =
    task.requiredInput.length > 0 ? ` · requires ${task.requiredInput.join(", ")}` : "";
  const optIn = task.requiresOptIn ? " · OPT-IN (expensive)" : "";
  return {
    value: task,
    label: `${task.kind}${optIn}`,
    detail: [
      task.description,
      `paths: ${task.paths.join("/") || "?"} · output: ${task.output}${required}`,
      `fields: ${task.inputFields.join(", ") || "(none)"}`,
    ].join("\n"),
  };
}

// --- task list (root view) ---------------------------------------------------------

export class TaskListView implements ScreenView {
  private readonly deps: TextgenTuiDeps;
  private readonly list: SelectList<TextgenTaskInfo>;
  private phase: "ready" | "error" = "ready";
  private errorText = "";
  private tasks: TextgenTaskInfo[] = [];

  constructor(deps: TextgenTuiDeps) {
    this.deps = deps;
    this.tasks = effectiveTasks(deps.capability);
    this.list = new SelectList<TextgenTaskInfo>({
      items: this.tasks.map(taskSelectItem),
      filterable: true,
      emptyText: "no generation tasks in capability document",
    });
    this.list.onSelect = (item) => {
      if (item.value) void this.generateFlow(item.value);
    };
    this.list.onCancel = () => void this.deps.ui.close();
    if (deps.capability === null) {
      this.phase = "error";
      this.errorText =
        "capability document unavailable — generate is disabled (fail closed); " +
        "task list falls back to the built-in registry";
    }
  }

  private gate(command: string): boolean {
    const gate = mutationAllowed(this.deps.capability, command);
    if (!gate.allowed) {
      this.deps.ui.setStatus(`mutations disabled: ${gate.reason ?? command}`);
      return false;
    }
    return true;
  }

  /** Run a CLI op inside the task runner; returns payload or null. */
  private async runOp(
    label: string,
    args: readonly string[],
    options: { timeoutMs?: number; input?: string; detach?: boolean } = {},
  ): Promise<Record<string, unknown> | null> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const result = await this.deps.ui.tasks.run({ label, timeoutMs }, (signal) =>
      this.deps
        .cli(args, {
          signal,
          timeoutMs,
          ...(options.input !== undefined ? { input: options.input } : {}),
          ...(options.detach === true ? { cancelPolicy: "detach" as const } : {}),
        })
        // Surface the structured `kind:` in the status line — the
        // runner only keeps err.message otherwise.
        .catch((err: unknown) => {
          throw new Error(errorLine(err));
        }),
    );
    if (result.status === "ok" && result.value !== undefined) {
      return result.value;
    }
    if (result.status === "cancelled") {
      this.deps.ui.setStatus(
        options.detach === true
          ? `${label} cancelled — generation continues in background; result discarded`
          : `${label} cancelled`,
      );
    } else {
      this.deps.ui.setStatus(
        `${label} ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
      );
    }
    return null;
  }

  /** Optional `git-context` preview for --git-pane (read-only). */
  private async previewGitContext(task: TaskKind | string, pane: string): Promise<void> {
    const payload = await this.runOp(
      "git-context",
      ["git-context", "--task", String(task), "--git-pane", pane],
      { timeoutMs: 120_000 },
    );
    if (payload === null) return; // error already on the status line
    const input =
      typeof payload.input === "object" && payload.input !== null
        ? (payload.input as Record<string, unknown>)
        : {};
    const lines: string[] = [
      `git-context — task ${String(task)} · pane ${pane}`,
      `repo: ${fmt(payload.repo_root)} · branch: ${fmt(payload.branch)}`,
      "",
      "collected input fields (explicit --input values override these):",
    ];
    for (const [key, value] of Object.entries(input)) {
      lines.push(
        `  ${key}: ${typeof value === "string" ? `${value.length} chars` : JSON.stringify(value)}`,
      );
    }
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    if (sources.length > 0) {
      lines.push("", "sources:");
      for (const s of sources) lines.push(`  ${fmt((s as Record<string, unknown>)?.command ?? s)}`);
    }
    const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    for (const w of warnings) lines.push(`warning: ${fmt(w)}`);
    this.deps.ui.push(
      new ResultView(this.deps, {
        title: "git context preview",
        lines,
        footer: "read-only preview — collect via rebuildup.git git-v1; nothing was generated",
      }),
    );
  }

  /**
   * The generate flow: opt-in → provider → model → git-pane → input
   * fields → confirm → run → result view. Every step is explicit; any
   * cancel/escape aborts before the mutation.
   */
  private async generateFlow(task: TextgenTaskInfo): Promise<void> {
    if (!this.gate("generate")) return;
    const kind = String(task.kind) as TaskKind;
    const known = TASKS.some((t) => t.kind === kind);
    if (!known) {
      this.deps.ui.setStatus(`unknown task kind: ${task.kind}`);
      return;
    }

    // Expensive-task opt-in: review_guide bills like a multi-step agent
    // investigation. --allow-expensive is per-run and always explicit.
    let allowExpensive = false;
    if (task.requiresOptIn && !expensiveTaskOptIn(this.deps.capability)) {
      const ok = await this.deps.ui.confirm({
        title: `${task.kind} requires opt-in`,
        target: [
          `task: ${task.kind}`,
          "runs a multi-step read-only agent investigation",
          "largest subscription cost of any textgen task",
        ],
        consequence:
          "pass --allow-expensive for THIS run only? (config guards.expensiveTaskOptIn stays unchanged)",
        confirmLabel: "Allow this run",
        cancelLabel: "Skip task",
      });
      if (!ok) return;
      allowExpensive = true;
    }

    // Provider: explicit pick or contract default resolution.
    const providers = providerOptions(this.deps.capability);
    const defaults = configDefaults(this.deps.capability);
    const providerItems: SelectItem<string | null>[] = [
      {
        value: null,
        label: "(default provider resolution)",
        detail: [
          defaults.provider !== null ? `config default: ${defaults.provider}` : "no config default",
          "agent path preferred over api when both usable",
        ].join("\n"),
      },
      ...providers.map((p) => ({
        value: p.id as string | null,
        label: p.id,
        detail: p.detail,
        ...(p.disabledReason !== null ? { disabled: true, disabledReason: p.disabledReason } : {}),
      })),
    ];
    const chosenProvider = await this.deps.ui.select({
      items: providerItems,
      filterable: true,
      emptyText: "no providers",
    });
    if (chosenProvider === null) return;
    const provider = chosenProvider.value ?? null;

    const modelInput = await this.deps.ui.prompt(
      "Model override (optional — Enter for provider/config default; ignored on agent path)",
      defaults.model !== null ? { placeholder: `config default: ${defaults.model}` } : {},
    );
    if (modelInput === null) return;
    const model = modelInput.trim() === "" ? null : modelInput.trim();

    // Git tasks: optional --git-pane collects diff/commits/conventions
    // through rebuildup.git's read-only git-v1 CLI (#108).
    let gitPane: string | null = null;
    if (isGitTask(kind)) {
      const paneInput = await this.deps.ui.prompt(
        "Pane id for repo context via rebuildup.git (blank = manual input only)",
        this.deps.target.originPaneId !== null
          ? { placeholder: `origin pane: ${this.deps.target.originPaneId}` }
          : {},
      );
      if (paneInput === null) return;
      gitPane = paneInput.trim() === "" ? null : paneInput.trim();
      if (gitPane !== null) {
        await this.previewGitContext(kind, gitPane);
      }
    }

    // Input fields per the contract allowlist. Values are never
    // rendered back; `@path` reads a file for long/multiline content.
    const input: Record<string, string | number> = {};
    for (const field of task.inputFields) {
      const required = task.requiredInput.includes(field);
      const fieldInput = await this.deps.ui.prompt(
        `${field}${required ? " (required)" : ""} — value or @/path/to/file`,
        {},
      );
      if (fieldInput === null) return; // Esc cancels the whole flow
      const trimmed = fieldInput.trim();
      if (trimmed === "") {
        if (required) {
          this.deps.ui.setStatus(`${field} is required — generate aborted`);
          return;
        }
        continue;
      }
      const resolved = await resolveFieldValue(trimmed, this.deps.target.originCwd);
      if (!resolved.ok) {
        this.deps.ui.setStatus(`input ${field}: ${resolved.reason}`);
        return;
      }
      if (field === "candidates") {
        const n = Number(resolved.value.trim());
        if (!Number.isFinite(n) || n < 1 || n > 5) {
          this.deps.ui.setStatus("candidates must be a number 1–5 — generate aborted");
          return;
        }
        input[field] = Math.floor(n);
      } else {
        input[field] = resolved.value;
      }
    }

    // Confirm: exact run parameters + consequence. Field VALUES stay
    // out of the dialog — names and sizes only.
    const fieldLines = Object.entries(input).map(
      ([k, v]) => `${k}: ${typeof v === "number" ? v : `${String(v).length} chars`}`,
    );
    const ok = await this.deps.ui.confirm({
      title: `Generate ${task.kind}?`,
      target: [
        `task: ${task.kind} (${task.output})`,
        `provider: ${provider ?? "default resolution"}`,
        ...(model !== null ? [`model: ${model}`] : []),
        ...(gitPane !== null ? [`git pane: ${gitPane}`] : []),
        ...(fieldLines.length > 0
          ? ["input:", ...fieldLines.map((l) => `  ${l}`)]
          : ["input: (none — git pane may supply fields)"]),
        `target: ${formatTargetLabel(this.deps.target)}`,
      ],
      consequence:
        "spawns a provider agent pane (visible in herdr, interruptible) or calls a configured API generator; " +
        "the result is shown here ONLY — textgen persists nothing and applies nothing" +
        (allowExpensive ? "; --allow-expensive passed for this run" : ""),
      confirmLabel: "Generate",
    });
    if (!ok) return;

    const args = buildGenerateArgs({
      task: kind,
      provider,
      model,
      gitPane,
      allowExpensive,
      timeoutMs: generateTimeoutMs(kind),
    });
    const payload = await this.runOp("generate", args, {
      timeoutMs: generateTimeoutMs(kind),
      input: JSON.stringify(input),
      detach: true,
    });
    if (payload !== null) {
      this.deps.ui.push(new ResultView(this.deps, { payload }));
    }
  }

  /** Re-fetch `capability` (read-only) and rebuild the task list. */
  private async refresh(): Promise<void> {
    const payload = await this.runOp("capability", ["capability"], { timeoutMs: 30_000 });
    if (payload === null) return;
    this.deps.capability = payload;
    this.tasks = effectiveTasks(payload);
    this.list.setItems(this.tasks.map(taskSelectItem));
    if (payload !== null) {
      this.phase = "ready";
      this.errorText = "";
    }
    this.deps.ui.setStatus("capability refreshed");
  }

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    if (this.phase === "error") {
      lines.push([{ text: "textgen", style: { bold: true } }]);
      for (const l of this.errorText.split("\n")) {
        lines.push([{ text: clip(l, width), style: { fg: "yellow" } }]);
      }
    }
    const inner = this.list.render(width, height - lines.length);
    return [...lines, ...inner].slice(0, height);
  }

  handleKey(ev: KeyEvent): boolean {
    // The inner list consumes navigation/enter/filter first; while its
    // `/` filter is active it swallows every key.
    if (this.list.handleKey(ev) === true) return true;
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    if (ev.key === "r" || ev.key === "R") {
      void this.refresh();
      return true;
    }
    return false;
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "generate with task" },
      { keys: ["r", "R"], description: "refresh capability" },
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

// --- git-context preview + result view ---------------------------------------------

export interface ResultViewOptions {
  title?: string;
  lines?: readonly string[];
  /** Successful generate payload — enables copy + result formatting. */
  payload?: Record<string, unknown>;
  /** Footer override (preview views); generate results get the
   *  "not retained" footer from formatGenerateResult. */
  footer?: string;
}

/**
 * Scrollable read+review surface: git-context preview or a generate
 * result. `c` copies the raw result to the clipboard (explicit action,
 * text via stdin only). There is deliberately NO apply/adopt key —
 * generation and application stay separated.
 */
export class ResultView implements ScreenView {
  private readonly deps: TextgenTuiDeps;
  private readonly titleText: string;
  private readonly source: string[];
  private readonly payload: Record<string, unknown> | null;
  private readonly footerText: string | null;
  private scroll = 0;

  constructor(deps: TextgenTuiDeps, opts: ResultViewOptions) {
    this.deps = deps;
    this.payload = opts.payload ?? null;
    if (opts.payload !== undefined) {
      this.titleText = `result — ${fmt(opts.payload.task)}`;
      this.source = formatGenerateResult(opts.payload);
      this.footerText = null;
    } else {
      this.titleText = opts.title ?? "detail";
      this.source = [...(opts.lines ?? [])];
      this.footerText = opts.footer ?? null;
    }
  }

  private async copy(): Promise<void> {
    if (this.payload === null) return;
    const text = resultClipboardText(this.payload);
    const result = await copyToClipboard(text);
    this.deps.ui.setStatus(
      result.ok
        ? "result copied to clipboard"
        : `clipboard unavailable (${result.reason}) — select/copy manually`,
    );
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.payload !== null && matchKey(ev, "c")) {
      void this.copy();
      return true;
    }
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
    if (matchKey(ev, "escape") || matchKey(ev, "q")) {
      this.deps.ui.pop();
      return true;
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    const hasTitle = this.titleText !== "";
    const footerLines =
      this.footerText !== null ? wrapText(this.footerText, Math.max(10, width - 2)) : [];
    const bodyH = Math.max(1, height - (hasTitle ? 3 : 1) - footerLines.length - 1);
    const wrapped: string[] = [];
    for (const l of this.source)
      wrapped.push(...wrapText(sanitizeDisplay(l), Math.max(1, width - 2)));
    const maxScroll = Math.max(0, wrapped.length - bodyH);
    this.scroll = Math.min(this.scroll, maxScroll);
    const view = wrapped.slice(this.scroll, this.scroll + bodyH);
    const lines: Line[] = [];
    if (hasTitle) {
      lines.push([{ text: clip(this.titleText, width), style: { bold: true } }]);
      lines.push(hr(width));
    }
    for (const v of view) lines.push(text(clip(v, width)));
    while (lines.length < height - footerLines.length - 1) lines.push([]);
    if (footerLines.length > 0) {
      for (const f of footerLines) lines.push(dim(clip(f, width)));
    }
    const pos =
      wrapped.length > 0 ? `${Math.min(this.scroll + 1, wrapped.length)}/${wrapped.length}` : "0/0";
    lines.push([{ text: padEndWidth(pos, width), style: { dim: true } }]);
    return lines.slice(0, height);
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      ...(this.payload !== null ? [{ keys: "c", description: "copy result" } as KeyBinding] : []),
      { keys: ["home", "end"], description: "top/bottom" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- small local helpers ------------------------------------------------------------

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}
