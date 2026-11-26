/**
 * Screen views for the rebuildup.handoff TUI (`herdr-plugins.tui/v1`).
 *
 * Safety-contract mapping (ADR-0033 §3 / tui-v1 §5):
 * - read-only open: `RecordListView.load` runs `list` only;
 *   `RecordDetailView.load` runs `status <id> --no-reconcile
 *   --no-resolve-refs` — the lazy delivered→done reconcile and the
 *   sibling-plugin ref resolution NEVER run implicitly on open.
 * - explicit target: every mutation names the handoff id resolved from
 *   the list selection; execute target mode/pane/workspace/worktree/
 *   remote machine is chosen explicitly in-UI.
 * - stale generation: `revalidate` re-reads `status` before every
 *   mutation; a changed `updated_at` asks before applying. The CLI's
 *   own staleness gates (transfer/target check) remain the enforcement
 *   layer inside the subprocess.
 * - mutation gating: `mutationAllowed` against the `capability`
 *   document; denied ops refuse with the reason in the status line.
 * - irreversible confirmation: `ui.confirm` shows exact target
 *   identity (host/session/pane/agent_session + chosen execute target
 *   incl. remote machine label/target/session) + consequence; Esc
 *   cancels. Execute additionally previews the `--dry-run` plan first.
 * - timeout/cancel: all CLI work runs inside `ui.tasks.run`.
 * - honest unsupported: remote probe failures, missing sibling plugins,
 *   and CLI errors render their real `kind: message`, never a
 *   fabricated success. `f` (focus source pane) is refused unless the
 *   record's host+session match this session — pane ids repeat across
 *   sessions.
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
import type { HandoffRecord } from "./model";
import { HANDOFF_STRATEGIES } from "./model";
import {
  type CapabilityDoc,
  type CliRunOptions,
  canFocusSource,
  errorLine,
  formatDryRunLines,
  formatResumeInfoLines,
  formatStatusLines,
  formatTargetLabel,
  localHost,
  machineSelectItems,
  mutationAllowed,
  mutationTargetLines,
  type PinnedTarget,
  recordSelectItem,
  type SessionSurfaces,
  STATUS_FILTERS,
} from "./tui-support";

// --- shared deps ----------------------------------------------------------------

/** The subset of `TuiApp` the views need (TuiApp satisfies this). */
export interface HandoffTuiUi {
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

export interface HandoffTuiDeps {
  cli(args: readonly string[], options?: CliRunOptions): Promise<Record<string, unknown>>;
  ui: HandoffTuiUi;
  /** `capability` payload fetched at launch; null = unavailable (fail closed). */
  capability: CapabilityDoc | null;
  target: PinnedTarget;
  /** Read-only session surfaces for execute target pickers. */
  surfaces(): Promise<SessionSurfaces>;
  /** Focus the record's source pane (documented `pane.focus`). */
  focusPane(paneId: string): Promise<unknown>;
  /** Called after a successful mutation so ancestor views can reload. */
  onChanged?: () => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asRecordRecord(value: unknown): HandoffRecord | null {
  const r = asRecord(value);
  return r !== null && typeof r.id === "string" ? (r as unknown as HandoffRecord) : null;
}

// --- record list (root view) -------------------------------------------------------

export class RecordListView implements ScreenView {
  private readonly deps: HandoffTuiDeps;
  private readonly onOpen: (id: string) => void;
  private readonly list: SelectList<string>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";
  private statusFilter = "";

  constructor(deps: HandoffTuiDeps, onOpen: (id: string) => void) {
    this.deps = deps;
    this.onOpen = onOpen;
    this.list = new SelectList<string>({
      items: [],
      filterable: true,
      emptyText: "no handoff records — c create one from a pane",
    });
    this.list.onSelect = (item) => {
      if (item.value !== undefined && item.value !== null) this.onOpen(item.value);
    };
    this.list.onCancel = () => void this.deps.ui.close();
  }

  /** (Re)load the record list. Read-only: `list` never mutates. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli([
        "list",
        "--limit",
        "200",
        ...(this.statusFilter !== "" ? ["--status", this.statusFilter] : []),
      ]);
      const items = asArray(payload.items).map(recordSelectItem);
      this.list.setItems(items);
      this.phase = "ready";
      this.errorText = "";
    } catch (err) {
      this.phase = "error";
      this.errorText = errorLine(err);
    }
    this.deps.ui.invalidate();
  }

  private gate(command: string): boolean {
    const gate = mutationAllowed(this.deps.capability, command);
    if (!gate.allowed) {
      this.deps.ui.setStatus(`mutations disabled: ${gate.reason ?? command}`);
      return false;
    }
    return true;
  }

  private async runOp(
    label: string,
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown> | null> {
    const result = await this.deps.ui.tasks.run(
      { label, timeoutMs: options.timeoutMs ?? 60_000 },
      (signal) => this.deps.cli(args, { signal, timeoutMs: options.timeoutMs ?? 60_000 }),
    );
    if (result.status === "ok" && result.value !== undefined) return result.value;
    this.deps.ui.setStatus(
      result.status === "cancelled"
        ? `${label} cancelled`
        : `${label} ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
    );
    return null;
  }

  private async filterFlow(): Promise<void> {
    const choice = await this.deps.ui.select<string>({
      items: STATUS_FILTERS.map((f) => ({ value: f.value, label: f.label })),
      filterable: false,
      emptyText: "",
    });
    if (choice === null) return;
    this.statusFilter = choice.value ?? "";
    this.deps.ui.setStatus(
      this.statusFilter === "" ? "status filter: all" : `status filter: ${this.statusFilter}`,
    );
    await this.load();
  }

  /**
   * Minimal `create` composer: source pane → strategy → note /
   * requirement / external ref → confirm → `create` CLI. The full
   * payload surface (conversation/checkpoint/handoff refs, parent
   * lineage links, target hints, --dry-run) stays on the CLI — the TUI
   * composer covers the common path honestly.
   */
  private async createFlow(): Promise<void> {
    if (!this.gate("create")) return;
    let surfaces: SessionSurfaces;
    try {
      surfaces = await this.deps.surfaces();
    } catch (err) {
      this.deps.ui.setStatus(`cannot enumerate panes: ${errorLine(err)}`);
      return;
    }
    if (surfaces.panes.length === 0) {
      this.deps.ui.setStatus("no panes in session snapshot");
      return;
    }
    const paneItems: SelectItem<SessionSurfaces["panes"][number]>[] = surfaces.panes.map((pane) => {
      const hasAgent = surfaces.agents[pane.pane_id] !== undefined;
      return {
        value: pane,
        label: `${pane.pane_id}${str(pane.title) !== null ? `  ${pane.title}` : ""}${str(pane.cwd) !== null ? `  ${pane.cwd}` : ""}`,
        detail: [
          `pane: ${pane.pane_id}`,
          `workspace: ${pane.workspace_id ?? "?"} · tab: ${pane.tab_id ?? "?"}`,
          hasAgent ? "runs an agent" : "no reported agent",
        ].join("\n"),
      };
    });
    const paneChoice = await this.deps.ui.select({
      items: paneItems,
      filterable: true,
      emptyText: "no panes",
    });
    const pane = paneChoice?.value;
    if (pane === undefined) return;

    const strategyChoice = await this.deps.ui.select<string>({
      items: HANDOFF_STRATEGIES.map((s) => ({
        value: s as string,
        label: s as string,
        detail:
          s === "native_resume"
            ? "resume the source agent session on the target provider"
            : s === "portable_context"
              ? "fresh target session + bounded payload"
              : s === "checkpoint_ref"
                ? "payload centers on a checkpoints ref/diff"
                : "user-driven transfer; plugin records intent only",
      })),
      filterable: false,
      emptyText: "",
    });
    if (strategyChoice === null) return;
    const strategy = strategyChoice.value ?? "portable_context";

    const note = await this.deps.ui.prompt("Note / excerpt (optional)");
    if (note === null) return;
    const noteValue = note.trim();
    const req = await this.deps.ui.prompt("Requirement (optional — single)");
    if (req === null) return;
    const reqValue = req.trim();
    const ext = await this.deps.ui.prompt("External ref value (optional — uri/path/issue)");
    if (ext === null) return;
    const extValue = ext.trim();

    const ok = await this.deps.ui.confirm({
      title: "Create handoff record?",
      target: [
        `source pane: ${pane.pane_id}`,
        `strategy: ${strategy}`,
        ...(noteValue !== ""
          ? [`note: ${noteValue.length > 100 ? `${noteValue.slice(0, 97)}…` : noteValue}`]
          : []),
        ...(reqValue !== "" ? [`requirement: ${reqValue}`] : []),
        ...(extValue !== "" ? [`external: ${extValue}`] : []),
        `target: ${formatTargetLabel(this.deps.target)}`,
      ],
      consequence: "writes a handoff record to plugin state (no agent is launched)",
      confirmLabel: "Create",
    });
    if (!ok) return;

    const payload = await this.runOp("create", [
      "create",
      pane.pane_id,
      "--strategy",
      strategy,
      ...(noteValue !== "" ? ["--note", noteValue] : []),
      ...(reqValue !== "" ? ["--requirement", reqValue] : []),
      ...(extValue !== "" ? ["--external", extValue] : []),
    ]);
    if (payload !== null) {
      const record = asRecordRecord(payload.handoff);
      this.deps.ui.setStatus(`created ${record?.id ?? "?"}`);
      this.deps.onChanged?.();
      await this.load();
    }
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: "loading handoff records…", style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load records", style: { bold: true, fg: "red" } }]);
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
      case "c":
        void this.createFlow();
        return true;
      case "f":
        void this.filterFlow();
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
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter text" },
      { keys: "enter", description: "open record" },
      { keys: "c", description: "create record from pane" },
      { keys: "f", description: "status filter" },
      { keys: ["r", "R"], description: "refresh" },
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

// --- record detail -----------------------------------------------------------------

/** Execute target mode chosen in-UI → CLI flag argv. */
interface ExecuteTargetChoice {
  flags: string[];
  /** Human description for the confirm dialog. */
  description: string;
}

export class RecordDetailView implements ScreenView {
  private readonly deps: HandoffTuiDeps;
  private readonly recordId: string;
  private statusPayload: Record<string, unknown> | null = null;
  private record: HandoffRecord | null = null;
  private phase: "loading" | "ready" | "error" | "missing" = "loading";
  private errorText = "";
  private scroll = 0;

  constructor(deps: HandoffTuiDeps, recordId: string) {
    this.deps = deps;
    this.recordId = recordId;
    void this.load();
  }

  /**
   * Read-only load: `status <id> --no-reconcile --no-resolve-refs`.
   * The lazy delivered→done reconcile (a state write) and sibling
   * ref resolution (potentially slow) are both deferred to explicit
   * keys — opening a record NEVER mutates (tui-v1 §5.1).
   */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli([
        "status",
        this.recordId,
        "--no-reconcile",
        "--no-resolve-refs",
      ]);
      this.statusPayload = payload;
      this.record = asRecordRecord(payload.handoff);
      this.phase = this.record === null ? "error" : "ready";
      if (this.record === null) this.errorText = "status returned no handoff record";
      else this.errorText = "";
    } catch (err) {
      const kind =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message) || kind === "handoff_not_found") {
        this.phase = "missing";
      } else {
        this.phase = "error";
        this.errorText = errorLine(err);
      }
    }
    this.deps.ui.invalidate();
  }

  /**
   * Refresh WITH ref resolution (still no reconcile write) — the `R`
   * key. For remote records the recorded machine id is passed so
   * `remote_check`/`target_check` evaluate against the remote session;
   * a failed probe surfaces honestly.
   */
  private async loadResolved(): Promise<void> {
    const remoteId = this.record?.execution?.remote?.machine_id;
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli([
        "status",
        this.recordId,
        "--no-reconcile",
        ...(remoteId !== undefined ? ["--remote", remoteId] : []),
      ]);
      this.statusPayload = payload;
      this.record = asRecordRecord(payload.handoff) ?? this.record;
      this.phase = "ready";
      this.errorText = "";
      this.deps.ui.setStatus("status refreshed (refs resolved, no reconcile)");
    } catch (err) {
      this.phase = "ready";
      this.deps.ui.setStatus(`refresh failed: ${errorLine(err)}`);
    }
    this.deps.ui.invalidate();
  }

  /**
   * Explicit reconcile: plain `status` MAY write delivered→done —
   * gated by mutation_commands and run inside the task runner.
   */
  private async reconcile(): Promise<void> {
    if (!this.gate("status")) return;
    const remoteId = this.record?.execution?.remote?.machine_id;
    const payload = await this.runOp(
      "status reconcile",
      ["status", this.recordId, ...(remoteId !== undefined ? ["--remote", remoteId] : [])],
      { timeoutMs: 180_000 },
    );
    if (payload !== null) {
      this.statusPayload = payload;
      this.record = asRecordRecord(payload.handoff) ?? this.record;
      this.deps.ui.setStatus(`status reconciled → ${this.record?.status ?? "?"}`);
      this.deps.onChanged?.();
      this.deps.ui.invalidate();
    }
  }

  /**
   * Stale-record gate: re-read `status` before a mutation; a changed
   * `updated_at` asks before applying (same convention as projects).
   */
  private async revalidate(): Promise<HandoffRecord | null> {
    let fresh: HandoffRecord | null;
    try {
      const payload = await this.deps.cli([
        "status",
        this.recordId,
        "--no-reconcile",
        "--no-resolve-refs",
      ]);
      fresh = asRecordRecord(payload.handoff);
    } catch (err) {
      this.deps.ui.setStatus(`revalidate failed: ${errorLine(err)}`);
      return null;
    }
    if (fresh === null) {
      this.phase = "missing";
      this.deps.ui.setStatus(`stale: handoff ${this.recordId} no longer exists`);
      this.deps.ui.invalidate();
      return null;
    }
    const opened = this.record?.updated_at;
    if (opened !== undefined && fresh.updated_at !== opened) {
      const proceed = await this.deps.ui.confirm({
        title: "Handoff record changed since this view opened",
        target: [
          `handoff: ${this.recordId}`,
          `updated_at was: ${opened}`,
          `updated_at now: ${fresh.updated_at}`,
          `status was: ${this.record?.status ?? "?"} → now: ${fresh.status}`,
        ],
        consequence:
          "the record changed underneath this view; applying now acts on the latest state",
        confirmLabel: "Apply anyway",
        cancelLabel: "Refresh instead",
      });
      if (!proceed) {
        void this.load();
        return null;
      }
    }
    this.record = fresh;
    return fresh;
  }

  private gate(command: string): boolean {
    const gate = mutationAllowed(this.deps.capability, command);
    if (!gate.allowed) {
      this.deps.ui.setStatus(`mutations disabled: ${gate.reason ?? command}`);
      return false;
    }
    return true;
  }

  private async runOp(
    label: string,
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown> | null> {
    const result = await this.deps.ui.tasks.run(
      { label, timeoutMs: options.timeoutMs ?? 120_000 },
      (signal) => this.deps.cli(args, { signal, timeoutMs: options.timeoutMs ?? 120_000 }),
    );
    if (result.status === "ok" && result.value !== undefined) return result.value;
    this.deps.ui.setStatus(
      result.status === "cancelled"
        ? `${label} cancelled`
        : `${label} ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
    );
    return null;
  }

  // --- execute ------------------------------------------------------------------

  private async chooseExecuteTarget(): Promise<ExecuteTargetChoice | null> {
    const mode = await this.deps.ui.select<string>({
      items: [
        {
          value: "auto",
          label: "recorded target / plugin default",
          detail: "no target flags — execute resolves record.target hints then a new workspace",
        },
        { value: "pane", label: "existing pane (--target-pane)" },
        { value: "workspace", label: "workspace (--target-workspace)" },
        { value: "new-workspace", label: "new workspace (--new-workspace)" },
        { value: "worktree", label: "git worktree (--worktree)" },
        { value: "remote", label: "remote machine (--remote)" },
      ],
      filterable: false,
      emptyText: "",
    });
    if (mode === null) return null;
    switch (mode.value) {
      case "auto":
        return { flags: [], description: "recorded target hint / default surface" };
      case "new-workspace":
        return { flags: ["--new-workspace"], description: "new workspace (cwd from source)" };
      case "pane": {
        const surfaces = await this.deps.surfaces().catch(() => null);
        if (surfaces === null || surfaces.panes.length === 0) {
          this.deps.ui.setStatus("cannot enumerate panes — session snapshot unavailable");
          return null;
        }
        const items: SelectItem<SessionSurfaces["panes"][number]>[] = surfaces.panes.map((pane) => {
          const busy = surfaces.agents[pane.pane_id] !== undefined;
          return {
            value: pane,
            label: `${pane.pane_id}${str(pane.title) !== null ? `  ${pane.title}` : ""}${str(pane.cwd) !== null ? `  ${pane.cwd}` : ""}`,
            detail: [
              `pane: ${pane.pane_id} · ws ${pane.workspace_id ?? "?"}`,
              busy ? "already runs an agent" : "no reported agent",
            ].join("\n"),
            ...(busy ? { disabled: true, disabledReason: "already has an agent" } : {}),
          };
        });
        const choice = await this.deps.ui.select({
          items,
          filterable: true,
          emptyText: "no panes",
        });
        const pane = choice?.value;
        if (pane === undefined) return null;
        return {
          flags: ["--target-pane", pane.pane_id],
          description: `existing pane ${pane.pane_id} (ws ${pane.workspace_id ?? "?"})`,
        };
      }
      case "workspace": {
        const surfaces = await this.deps.surfaces().catch(() => null);
        if (surfaces === null || surfaces.workspaces.length === 0) {
          this.deps.ui.setStatus("cannot enumerate workspaces — session snapshot unavailable");
          return null;
        }
        const items: SelectItem<SessionSurfaces["workspaces"][number]>[] = surfaces.workspaces.map(
          (ws) => ({
            value: ws,
            label: `${ws.workspace_id}${str(ws.title) !== null ? `  ${ws.title}` : ""}`,
            detail: `workspace: ${ws.workspace_id} · cwd ${ws.cwd ?? "?"}`,
          }),
        );
        const choice = await this.deps.ui.select({
          items,
          filterable: true,
          emptyText: "no workspaces",
        });
        const ws = choice?.value;
        if (ws === undefined) return null;
        return {
          flags: ["--target-workspace", ws.workspace_id],
          description: `workspace ${ws.workspace_id}`,
        };
      }
      case "worktree": {
        const branch = await this.deps.ui.prompt("Worktree branch (optional — herdr default)");
        if (branch === null) return null;
        const branchValue = branch.trim();
        const base = await this.deps.ui.prompt("Worktree base ref (optional)");
        if (base === null) return null;
        const baseValue = base.trim();
        return {
          flags: [
            "--worktree",
            ...(branchValue !== "" ? ["--worktree-branch", branchValue] : []),
            ...(baseValue !== "" ? ["--worktree-base", baseValue] : []),
          ],
          description: `git worktree${branchValue !== "" ? ` branch ${branchValue}` : ""}${baseValue !== "" ? ` base ${baseValue}` : ""}`,
        };
      }
      case "remote": {
        // remote-probe with no selector lists saved machines (read-only).
        const probe = await this.runOp("remote-probe", ["remote-probe"], { timeoutMs: 60_000 });
        if (probe === null) return null;
        const items = machineSelectItems(probe);
        if (items.length === 0) {
          this.deps.ui.setStatus("no saved machines — configure via `herdr machine`");
          return null;
        }
        const choice = await this.deps.ui.select({
          items,
          filterable: true,
          emptyText: "no machines",
        });
        const machineId = choice?.value;
        if (machineId === undefined) return null;
        const machine = asArray(probe.machines).find((m) => str(m.id) === machineId);
        const label = str(machine?.label) ?? machineId;
        const targetHost = str(machine?.target) ?? "?";
        const session = str(machine?.session) ?? "default";
        return {
          flags: ["--remote", machineId],
          description: `REMOTE machine ${label} (${machineId}) → ${targetHost} session ${session}`,
        };
      }
      default:
        return null;
    }
  }

  private async executeFlow(): Promise<void> {
    void (async () => {
      if (!this.gate("execute")) return;
      const fresh = await this.revalidate();
      if (fresh === null) return;

      const target = await this.chooseExecuteTarget();
      if (target === null) return;

      const provider = await this.deps.ui.prompt(
        "Provider hint (optional — default: record/transfer)",
        { value: fresh.target?.provider_hint ?? fresh.transfer.provider_kind ?? "" },
      );
      if (provider === null) return;
      const providerValue = provider.trim();
      const model = await this.deps.ui.prompt("Model (optional)");
      if (model === null) return;
      const modelValue = model.trim();

      const flags = [
        ...target.flags,
        ...(providerValue !== "" ? ["--provider", providerValue] : []),
        ...(modelValue !== "" ? ["--model", modelValue] : []),
      ];

      // Dry-run preview: resolves the plan + prompt without mutating.
      const dry = await this.runOp(
        "execute dry-run",
        ["execute", this.recordId, "--dry-run", ...flags],
        { timeoutMs: 180_000 },
      );
      if (dry === null) return;
      const planLines = formatDryRunLines(dry);
      const isRemote = flags.includes("--remote");

      const ok = await this.deps.ui.confirm({
        title: `Execute handoff ${this.recordId}?`,
        target: [
          ...mutationTargetLines(fresh, [
            `execute target: ${target.description}`,
            ...(providerValue !== "" ? [`provider hint: ${providerValue}`] : []),
            ...(modelValue !== "" ? [`model: ${modelValue}`] : []),
          ]),
          ...planLines.slice(0, 6),
        ],
        consequence: isRemote
          ? "REMOTE execution: writes a portable bundle, creates a target surface + agent.start + prompt injection on the remote herdr session over SSH"
          : "creates a target surface if needed, runs agent.start, and injects the payload prompt — agent processes are launched",
        confirmLabel: "Execute",
        danger: isRemote,
      });
      if (!ok) return;

      const again = await this.revalidate();
      if (again === null) return;
      const payload = await this.runOp("execute", ["execute", this.recordId, ...flags], {
        timeoutMs: 300_000,
      });
      if (payload !== null) {
        this.statusPayload = payload;
        this.record = asRecordRecord(payload.handoff) ?? this.record;
        this.deps.ui.setStatus(
          `execute ${payload.outcome ?? "ok"} → ${this.record?.status ?? "?"}`,
        );
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  // --- delegate / merge-back ------------------------------------------------------

  private async delegateFlow(): Promise<void> {
    void (async () => {
      if (!this.gate("delegate")) return;
      const fresh = await this.revalidate();
      if (fresh === null) return;

      const task = await this.deps.ui.prompt("Delegated task (optional — becomes payload excerpt)");
      if (task === null) return;
      const taskValue = task.trim();

      const mode = await this.deps.ui.select<string>({
        items: [
          { value: "exec", label: "delegate + execute (child agent launched)" },
          { value: "record", label: "record intent only (--no-execute)" },
          { value: "worktree", label: "delegate + execute in a git worktree" },
        ],
        filterable: false,
        emptyText: "",
      });
      if (mode === null) return;
      const execFlags =
        mode.value === "record"
          ? ["--no-execute"]
          : mode.value === "worktree"
            ? ["--worktree"]
            : [];

      const flags = [...execFlags, ...(taskValue !== "" ? ["--task", taskValue] : [])];

      // Dry-run previews the child record without persisting.
      const dry = await this.runOp(
        "delegate dry-run",
        ["delegate", this.recordId, "--dry-run", ...flags],
        { timeoutMs: 60_000 },
      );
      if (dry === null) return;
      const child = asRecordRecord(dry.handoff);
      const dryLines = [
        `child record (preview): ${child?.id ?? "?"} strategy ${child?.strategy ?? "?"}`,
        `parent: ${this.recordId} — delegating pane resolved by CLI from lineage`,
        ...(mode.value === "worktree" ? ["worktree: isolated git worktree target"] : []),
        ...(mode.value === "record" ? ["--no-execute: intent recorded only"] : []),
      ];

      const ok = await this.deps.ui.confirm({
        title: `Delegate from handoff ${this.recordId}?`,
        target: [...mutationTargetLines(fresh, dryLines)],
        consequence:
          mode.value === "record"
            ? "writes a linked child record to plugin state; no agent launched"
            : "creates + executes a child handoff (subagent_spawn): target surface, agent.start, payload prompt",
        confirmLabel: mode.value === "record" ? "Record" : "Delegate",
        danger: mode.value !== "record",
      });
      if (!ok) return;

      const again = await this.revalidate();
      if (again === null) return;
      const payload = await this.runOp("delegate", ["delegate", this.recordId, ...flags], {
        timeoutMs: 300_000,
      });
      if (payload !== null) {
        this.statusPayload = payload;
        this.record = asRecordRecord(payload.handoff) ?? this.record;
        this.deps.ui.setStatus(`delegate ${payload.outcome ?? "ok"}`);
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  private async mergeBackFlow(): Promise<void> {
    void (async () => {
      if (!this.gate("merge-back")) return;
      const fresh = await this.revalidate();
      if (fresh === null) return;
      const parentId = fresh.relationship?.parent_id;
      if (parentId === undefined) {
        this.deps.ui.setStatus("merge-back needs a child record (relationship.parent_id)");
        return;
      }

      const task = await this.deps.ui.prompt("Result note for the parent agent (optional)");
      if (task === null) return;
      const taskValue = task.trim();
      const flags = taskValue !== "" ? ["--task", taskValue] : [];

      const dry = await this.runOp(
        "merge-back dry-run",
        ["merge-back", this.recordId, "--dry-run", ...flags],
        { timeoutMs: 60_000 },
      );
      if (dry === null) return;
      const resultRecord = asRecordRecord(dry.handoff);

      const ok = await this.deps.ui.confirm({
        title: `Merge back handoff ${this.recordId}?`,
        target: [
          ...mutationTargetLines(fresh, [
            `child: ${this.recordId} (${fresh.relationship?.kind ?? "?"})`,
            `parent record: ${parentId} — delivery pane resolved by CLI from lineage`,
            `result record (preview): ${resultRecord?.id ?? "?"}`,
          ]),
        ],
        consequence:
          "delivers the child's outcome to the delegating agent's EXISTING pane via agent.prompt (never a second agent.start)",
        confirmLabel: "Merge back",
      });
      if (!ok) return;

      const again = await this.revalidate();
      if (again === null) return;
      const payload = await this.runOp("merge-back", ["merge-back", this.recordId, ...flags], {
        timeoutMs: 180_000,
      });
      if (payload !== null) {
        this.statusPayload = payload;
        this.record = asRecordRecord(payload.handoff) ?? this.record;
        this.deps.ui.setStatus(`merge-back ${payload.outcome ?? "ok"}`);
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  // --- resume-info / focus ---------------------------------------------------------

  private resumeInfoFlow(): void {
    void (async () => {
      const provider =
        this.record?.transfer.provider_kind ?? this.record?.execution?.provider_kind ?? null;
      const payload = await this.runOp(
        "resume-info",
        ["resume-info", ...(provider !== null ? ["--provider", provider] : [])],
        { timeoutMs: 60_000 },
      );
      if (payload === null) return;
      this.deps.ui.push(
        new DetailView({
          title: `resume-info${provider !== null ? ` — ${provider}` : " — all providers"}`,
          lines: formatResumeInfoLines(payload),
          onClose: () => this.deps.ui.pop(),
        }),
      );
    })();
  }

  private async focusSourceFlow(): Promise<void> {
    const record = this.record;
    if (record === null) return;
    // Resolve the CURRENT session name for the same-session guard.
    let sessionName: string | null = this.deps.target.session;
    try {
      const surfaces = await this.deps.surfaces();
      sessionName = sessionName ?? surfaces.sessionName;
    } catch {
      // surfaces failure only weakens the guard — keep pinned session.
    }
    if (!canFocusSource(record, { host: localHost(), session: sessionName })) {
      this.deps.ui.setStatus(
        `cannot focus source pane ${record.transfer.pane_id}: record is from ${record.transfer.host}/${record.transfer.herdr_session ?? "default"}, this session is ${localHost()}/${sessionName ?? "default"}`,
      );
      return;
    }
    const ok = await this.deps.ui.confirm({
      title: "Return to origin agent pane?",
      target: [
        `source pane: ${record.transfer.pane_id}`,
        `host: ${record.transfer.host} · session: ${record.transfer.herdr_session ?? "default"}`,
        `workspace: ${record.transfer.workspace_id ?? "?"} · tab: ${record.transfer.tab_id ?? "?"}`,
        `agent_session: ${record.transfer.agent_session?.value ?? "none"}`,
      ],
      consequence:
        "moves herdr UI focus to the origin pane (pane.focus); reversible, no state change",
      confirmLabel: "Focus",
    });
    if (!ok) return;
    try {
      await this.deps.focusPane(record.transfer.pane_id);
      this.deps.ui.setStatus(`focused source pane ${record.transfer.pane_id}`);
    } catch (err) {
      this.deps.ui.setStatus(`focus failed: ${errorLine(err)}`);
    }
  }

  // --- render ---------------------------------------------------------------------

  private contentLines(): string[] {
    if (this.statusPayload === null) return [];
    return formatStatusLines(this.statusPayload);
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: `loading handoff ${this.recordId}…`, style: { dim: true } }]);
      } else {
        const title =
          this.phase === "missing"
            ? `handoff not found: ${this.recordId}`
            : "failed to load handoff";
        lines.push([{ text: title, style: { bold: true, fg: "red" } }]);
        if (this.errorText !== "") {
          for (const l of this.errorText.split("\n")) {
            lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
          }
        }
        lines.push([{ text: "R — retry · Esc — back", style: { dim: true } }]);
      }
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    const source = this.contentLines();
    const wrapped: string[] = [];
    for (const l of source) {
      const words = l.split(" ");
      let cur = "";
      for (const w of words) {
        if (cur !== "" && cur.length + w.length + 1 > width - 2) {
          wrapped.push(cur);
          cur = w;
        } else {
          cur = cur === "" ? w : `${cur} ${w}`;
        }
      }
      wrapped.push(cur);
    }
    const bodyH = Math.max(1, height - 2);
    const maxScroll = Math.max(0, wrapped.length - bodyH);
    this.scroll = Math.min(this.scroll, maxScroll);
    const view = wrapped.slice(this.scroll, this.scroll + bodyH);
    const out: Line[] = [];
    out.push([{ text: clip(`handoff ${this.recordId}`, width), style: { bold: true } }]);
    for (const v of view) out.push([{ text: clip(v, width) }]);
    while (out.length < height - 1) out.push([]);
    out.push([
      {
        text: clip(`${Math.min(this.scroll + 1, wrapped.length)}/${wrapped.length}`, width),
        style: { dim: true },
      },
    ]);
    return out.slice(0, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.phase !== "ready") {
      if (matchKey(ev, "r") || matchKey(ev, "R")) {
        void this.load();
        return true;
      }
      return false;
    }
    if (matchKey(ev, "up") || matchKey(ev, "k")) {
      this.scroll = Math.max(0, this.scroll - 1);
      return true;
    }
    if (matchKey(ev, "down") || matchKey(ev, "j") || matchKey(ev, "space")) {
      this.scroll += 1;
      return true;
    }
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    switch (ev.key) {
      case "x":
        this.executeFlow();
        return true;
      case "d":
        this.delegateFlow();
        return true;
      case "m":
        this.mergeBackFlow();
        return true;
      case "i":
        this.resumeInfoFlow();
        return true;
      case "f":
        void this.focusSourceFlow();
        return true;
      case "R":
        void this.loadResolved();
        return true;
      case "s":
        void this.reconcile();
        return true;
      case "r":
        void this.load();
        return true;
      default:
        return false;
    }
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j", "space"], description: "scroll" },
      { keys: "x", description: "execute handoff (target select + dry-run + confirm)" },
      { keys: "d", description: "delegate (subagent_spawn child)" },
      { keys: "m", description: "merge-back result to parent agent" },
      { keys: "i", description: "resume-info (on demand)" },
      { keys: "f", description: "focus origin agent pane" },
      { keys: "R", description: "refresh + resolve refs (+remote probe)" },
      { keys: "s", description: "reconcile status (may write)" },
      { keys: "r", description: "reload (read-only)" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}
