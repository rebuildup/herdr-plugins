/**
 * Screen views for the rebuildup.automations TUI (`herdr-plugins.tui/v1`).
 *
 * Safety-contract mapping (ADR-0033 §3 / tui-v1 §5):
 * - read-only open: `TaskListView.load` / `TaskDetailView.load` /
 *   `RunsView.load` / `DriversView.load` run only `list`/`get`/`runs` —
 *   reads. Lazy mutations (`tick` drain, `reconcile` materialization,
 *   `schedule status` driver-record write) NEVER run implicitly on
 *   open; they are explicit keys gated through `mutation_commands`.
 * - explicit target: every mutation names the task_id (or the OS
 *   scheduler entry / watch driver) resolved from the pinned session
 *   (`--socket`) or in-UI selection; the origin pane is only a
 *   destination-form hint, never auto-applied.
 * - stale generation: `revalidateTask` re-reads `get <id>` before
 *   every task mutation; a vanished task aborts `stale_*`, a changed
 *   `updated_at` asks before applying.
 * - mutation gating: `mutationAllowed` against the `capability`
 *   document; denied ops render disabled-with-reason or refuse with
 *   the reason in the status line.
 * - irreversible confirmation: `ui.confirm` shows exact target +
 *   consequence for run-now, delete, enable/disable, tick, schedule
 *   install/uninstall, and watch start; Esc cancels.
 * - timeout/cancel: all CLI work runs inside `ui.tasks.run` (progress,
 *   Ctrl-C/Esc cancel, timeout, partial labeling).
 * - honest unsupported: CLI/socket/OS-scheduler failures render their
 *   real `kind: message`, never a fabricated success; `webhook`
 *   schedules render disabled (upstream gap, ADR-0026).
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
import type { Destination, RunView, Schedule, TaskView } from "./model";
import {
  asRunViews,
  asTaskView,
  asTaskViews,
  type CapabilityDoc,
  type CliRunOptions,
  destinationSummary,
  errorLine,
  formatTargetLabel,
  HOOK_EVENT_NAMES,
  mutationAllowed,
  type PinnedTarget,
  runDetailLines,
  runSelectItem,
  scheduleSummary,
  startWatchDetached,
  taskHeaderLines,
  taskSelectItem,
} from "./tui-support";

// --- shared deps ----------------------------------------------------------------

/** The subset of `TuiApp` the views need (TuiApp satisfies this). */
export interface AutomationsTuiUi {
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

export interface AutomationsTuiDeps {
  /**
   * Runs the plugin CLI with the pinned session args already applied
   * (`--socket <resolved>` appended by the caller in tui.ts).
   */
  cli(args: readonly string[], options?: CliRunOptions): Promise<Record<string, unknown>>;
  ui: AutomationsTuiUi;
  /** `capability` payload fetched at launch; null = unavailable (fail closed). */
  capability: CapabilityDoc | null;
  target: PinnedTarget;
  /** Called after a successful mutation so ancestor views can reload. */
  onChanged?: () => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

// --- schedule / destination forms (create + edit) -------------------------------

const SCHEDULE_TYPES = [
  { type: "interval", label: "interval — every N minutes" },
  { type: "fixed_time", label: "fixed_time — daily/weekly wall-clock" },
  { type: "once", label: "once — single occurrence at an instant" },
  { type: "event", label: "event — herdr lifecycle hook" },
] as const;

function parsePositiveIntInput(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseWeekdays(raw: string): number[] | null {
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) return null;
  const days: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 6) return null;
    days.push(n);
  }
  return days;
}

/**
 * Guided schedule form → Schedule JSON value, or null on cancel.
 * `current` (edit mode) is shown for reference; the form always builds
 * a fresh value — there is no partial-field patching, matching the
 * CLI's whole-`--schedule`-JSON semantics.
 */
export async function promptScheduleForm(
  ui: AutomationsTuiUi,
  current: Schedule | null,
): Promise<Schedule | null> {
  if (current !== null) {
    ui.setStatus(`current schedule: ${scheduleSummary(current)}`);
  }
  const typeItem = await ui.select({
    items: [
      ...SCHEDULE_TYPES.map((t) => ({ value: t.type, label: t.label })),
      {
        value: "webhook",
        label: "webhook — unsupported",
        disabled: true,
        disabledReason: "unsupported_schedule — upstream gap (ADR-0026)",
      },
    ],
    filterable: false,
    emptyText: "no schedule types",
  });
  if (typeItem === null || typeItem.value === undefined) return null;
  const type = typeItem.value;

  switch (type) {
    case "interval": {
      const raw = await ui.prompt("Interval — every N minutes (min 1, >= 60000ms)", {
        value:
          current !== null && current.type === "interval" ? String(current.every_ms / 60000) : "",
      });
      if (raw === null) return null;
      const minutes = parsePositiveIntInput(raw);
      if (minutes === null || minutes * 60_000 < 60_000) {
        ui.setStatus("invalid interval — must be a positive integer of minutes (>= 1)");
        return null;
      }
      return { type: "interval", every_ms: minutes * 60_000 };
    }
    case "fixed_time": {
      const cur = current !== null && current.type === "fixed_time" ? current : null;
      const timeRaw = await ui.prompt("Wall-clock time HH:MM (24h)", {
        value: cur?.time_of_day ?? "",
      });
      if (timeRaw === null) return null;
      const time = timeRaw.trim();
      if (!/^\d{1,2}:\d{2}$/.test(time)) {
        ui.setStatus("invalid time_of_day — expected HH:MM");
        return null;
      }
      const weekdaysRaw = await ui.prompt(
        "Weekdays, comma-separated 0=Sun..6=Sat (empty = daily)",
        { value: cur?.weekdays?.join(",") ?? "" },
      );
      if (weekdaysRaw === null) return null;
      const weekdays = weekdaysRaw.trim() === "" ? undefined : parseWeekdays(weekdaysRaw);
      if (weekdaysRaw.trim() !== "" && weekdays === null) {
        ui.setStatus("invalid weekdays — integers 0..6 comma-separated");
        return null;
      }
      const tzRaw = await ui.prompt("Time zone IANA name (empty = host local)", {
        value: cur?.time_zone ?? "",
      });
      if (tzRaw === null) return null;
      const tz = tzRaw.trim();
      const schedule: Schedule = {
        type: "fixed_time",
        time_of_day: time,
        ...(weekdays !== undefined && weekdays !== null ? { weekdays } : {}),
        ...(tz !== "" ? { time_zone: tz } : {}),
      };
      return schedule;
    }
    case "once": {
      const cur = current !== null && current.type === "once" ? current : null;
      const raw = await ui.prompt("Run at — ISO 8601 instant with offset", {
        value: cur?.run_at ?? "",
      });
      if (raw === null) return null;
      const runAt = raw.trim();
      if (Number.isNaN(Date.parse(runAt))) {
        ui.setStatus("invalid run_at — expected an ISO 8601 instant");
        return null;
      }
      return { type: "once", run_at: runAt };
    }
    case "event": {
      const cur = current !== null && current.type === "event" ? current : null;
      const onItem = await ui.select({
        items: HOOK_EVENT_NAMES.map((name) =>
          cur?.on === name
            ? { value: name, label: name, detail: "current" }
            : { value: name, label: name },
        ),
        filterable: true,
        emptyText: "no hook events",
      });
      if (onItem === null || onItem.value === undefined) return null;
      const on = String(onItem.value);
      const filterRaw = await ui.prompt(
        'Event filter JSON (optional, e.g. {"agent_status":"blocked"}) — empty = none',
        { value: cur?.filter !== undefined ? JSON.stringify(cur.filter) : "" },
      );
      if (filterRaw === null) return null;
      let filter: Record<string, unknown> | undefined;
      const filterText = filterRaw.trim();
      if (filterText !== "") {
        try {
          const parsed = JSON.parse(filterText) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            ui.setStatus("invalid filter — expected a JSON object");
            return null;
          }
          filter = parsed as Record<string, unknown>;
        } catch {
          ui.setStatus("invalid filter — not valid JSON");
          return null;
        }
      }
      const numField = async (
        label: string,
        currentValue: number | undefined,
      ): Promise<number | undefined | null> => {
        const rawNum = await ui.prompt(`${label} ms/count (empty = unset)`, {
          value: currentValue !== undefined ? String(currentValue) : "",
        });
        if (rawNum === null) return null;
        const text = rawNum.trim();
        if (text === "") return undefined;
        const n = parsePositiveIntInput(text);
        if (n === null) {
          ui.setStatus(`${label}: expected a positive integer`);
          return null;
        }
        return n;
      };
      const debounce = await numField("debounce_ms", cur?.debounce_ms);
      if (debounce === null) return null;
      const cooldown = await numField("cooldown_ms", cur?.cooldown_ms);
      if (cooldown === null) return null;
      const maxFires = await numField("max_fires", cur?.max_fires);
      if (maxFires === null) return null;
      return {
        type: "event",
        on,
        ...(filter !== undefined ? { filter } : {}),
        ...(debounce !== undefined ? { debounce_ms: debounce } : {}),
        ...(cooldown !== undefined ? { cooldown_ms: cooldown } : {}),
        ...(maxFires !== undefined ? { max_fires: maxFires } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * Guided destination form → Destination JSON value, or null on cancel.
 * The origin pane id is offered as the pane-destination default hint
 * ONLY — it is never applied without the user confirming it.
 */
export async function promptDestinationForm(
  ui: AutomationsTuiUi,
  target: PinnedTarget,
  current: Destination | null,
): Promise<Destination | null> {
  if (current !== null) {
    ui.setStatus(`current destination: ${destinationSummary(current)}`);
  }
  const kindItem = await ui.select({
    items: [
      { value: "pane", label: "pane — deliver prompt into an existing pane" },
      {
        value: "launch",
        label: "launch — start a new agent on a surface",
      },
    ],
    filterable: false,
    emptyText: "no destination kinds",
  });
  if (kindItem === null || kindItem.value === undefined) return null;

  if (kindItem.value === "pane") {
    const cur = current !== null && current.kind === "pane" ? current.pane_id : "";
    const hint = cur !== "" ? cur : (target.originPaneId ?? "");
    const raw = await ui.prompt("Target pane_id", { value: hint });
    if (raw === null) return null;
    const paneId = raw.trim();
    if (paneId === "") {
      ui.setStatus("pane destination requires a pane_id");
      return null;
    }
    return { kind: "pane", pane_id: paneId };
  }

  // launch
  const curLaunch = current !== null && current.kind === "launch" ? current : null;
  const surfaceItem = await ui.select({
    items: [
      {
        value: "workspace",
        label: "existing workspace",
        detail: target.workspaceId !== null ? `ws ${target.workspaceId}` : "no pinned workspace",
      },
      { value: "new_workspace", label: "new workspace" },
      { value: "tab", label: "tab in a workspace" },
    ],
    filterable: false,
    emptyText: "no surface kinds",
  });
  if (surfaceItem === null || surfaceItem.value === undefined) return null;
  let surface: { workspace_id: string } | { new_workspace: true } | { tab_id: string };
  if (surfaceItem.value === "workspace") {
    const curSurface = curLaunch?.surface;
    const curWorkspaceId =
      curSurface !== undefined && "workspace_id" in curSurface
        ? String(curSurface.workspace_id)
        : "";
    const wsId = target.workspaceId ?? (curWorkspaceId !== "" ? curWorkspaceId : "");
    if (wsId === "") {
      ui.setStatus("no pinned workspace — enter a workspace_id explicitly");
      const raw = await ui.prompt("workspace_id");
      if (raw === null) return null;
      const id = raw.trim();
      if (id === "") {
        ui.setStatus("workspace destination requires a workspace_id");
        return null;
      }
      surface = { workspace_id: id };
    } else {
      surface = { workspace_id: wsId };
    }
  } else if (surfaceItem.value === "new_workspace") {
    surface = { new_workspace: true };
  } else {
    const raw = await ui.prompt("tab_id");
    if (raw === null) return null;
    const id = raw.trim();
    if (id === "") {
      ui.setStatus("tab destination requires a tab_id");
      return null;
    }
    surface = { tab_id: id };
  }

  const agentRaw = await ui.prompt("Agent name (provider/agent id, e.g. claude, codex)", {
    value: curLaunch?.agent ?? "",
  });
  if (agentRaw === null) return null;
  const agent = agentRaw.trim();
  if (agent === "") {
    ui.setStatus("launch destination requires an agent name");
    return null;
  }
  const argsRaw = await ui.prompt("Launch args, comma-separated (empty = none)", {
    value: curLaunch?.launch_args?.join(",") ?? "",
  });
  if (argsRaw === null) return null;
  const argsText = argsRaw.trim();
  const launchArgs =
    argsText === ""
      ? undefined
      : argsText
          .split(",")
          .map((a) => a.trim())
          .filter((a) => a !== "");
  const viaItem = await ui.select({
    items: [
      { value: "direct", label: "direct — agent.start/prompt on the surface" },
      { value: "handoff-execute", label: "handoff-execute — via rebuildup.handoff" },
    ],
    filterable: false,
    emptyText: "no via modes",
  });
  if (viaItem === null || viaItem.value === undefined) return null;
  const via = String(viaItem.value) as "direct" | "handoff-execute";

  return {
    kind: "launch",
    surface,
    agent,
    ...(launchArgs !== undefined && launchArgs.length > 0 ? { launch_args: launchArgs } : {}),
    via,
  };
}

/** Create-task form → create CLI args, or null on cancel. */
export async function promptCreateTask(
  ui: AutomationsTuiUi,
  target: PinnedTarget,
): Promise<{ args: string[]; summary: string[] } | null> {
  const name = await ui.prompt("Task name");
  if (name === null) return null;
  const nameText = name.trim();
  if (nameText === "") {
    ui.setStatus("task name required — cancelled");
    return null;
  }
  const promptText = await ui.prompt("Prompt delivered to the destination agent");
  if (promptText === null) return null;
  if (promptText.trim() === "") {
    ui.setStatus("prompt required — cancelled");
    return null;
  }
  const schedule = await promptScheduleForm(ui, null);
  if (schedule === null) return null;
  const destination = await promptDestinationForm(ui, target, null);
  if (destination === null) return null;
  const misfireItem = await ui.select({
    items: [
      { value: "skip", label: "skip — past occurrences become missed" },
      { value: "run_once", label: "run_once — collapse owed occurrences into one fire" },
    ],
    filterable: false,
    emptyText: "no misfire policies",
  });
  if (misfireItem === null || misfireItem.value === undefined) return null;
  const misfire = String(misfireItem.value);

  const args = [
    "create",
    "--name",
    nameText,
    "--prompt",
    promptText,
    "--schedule",
    JSON.stringify(schedule),
    "--destination",
    JSON.stringify(destination),
    "--misfire",
    misfire,
    "--enabled",
    "true",
    "--created-by",
    "tui",
  ];
  return {
    args,
    summary: [
      `name: ${nameText}`,
      `prompt: ${promptText}`,
      `schedule: ${scheduleSummary(schedule)}`,
      `destination: ${destinationSummary(destination)}`,
      `misfire: ${misfire} · enabled: true`,
    ],
  };
}

// --- shared view helpers ---------------------------------------------------------

function gateOf(deps: AutomationsTuiDeps, command: string) {
  const gate = mutationAllowed(deps.capability, command);
  if (!gate.allowed) {
    deps.ui.setStatus(`mutations disabled: ${gate.reason ?? command}`);
  }
  return gate;
}

/** Run a CLI op inside the task runner; returns payload or null. */
async function runOp(
  deps: AutomationsTuiDeps,
  label: string,
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<Record<string, unknown> | null> {
  const result = await deps.ui.tasks.run({ label, timeoutMs }, (signal) =>
    deps.cli(args, { signal, timeoutMs }),
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
 * Stale-generation gate (tui-v1 §3.3 / safety item 3): re-read the
 * task through the public CLI immediately before a mutation. A
 * vanished task aborts `stale`; a changed `updated_at` asks the user
 * before applying to the newer state. Returns the fresh task or null
 * when the mutation must not proceed.
 */
async function revalidateTask(
  deps: AutomationsTuiDeps,
  taskId: string,
  openedUpdatedAt: string | undefined,
): Promise<TaskView | null> {
  let fresh: TaskView | null;
  try {
    const payload = await deps.cli(["get", taskId]);
    fresh = asTaskView(payload.task);
  } catch (err) {
    if (
      err instanceof Error &&
      "kind" in err &&
      (err as { kind?: unknown }).kind === "task_not_found"
    ) {
      fresh = null;
    } else {
      deps.ui.setStatus(`revalidate failed: ${errorLine(err)}`);
      return null;
    }
  }
  if (fresh === null) {
    deps.ui.setStatus(`stale: task ${taskId} no longer exists`);
    return null;
  }
  if (openedUpdatedAt !== undefined && fresh.updated_at !== openedUpdatedAt) {
    const proceed = await deps.ui.confirm({
      title: "Task changed since this view opened",
      target: [
        `task: ${taskId} (${fresh.name})`,
        `updated_at was: ${openedUpdatedAt}`,
        `updated_at now: ${fresh.updated_at}`,
      ],
      consequence: "the task changed underneath this view; applying now writes to the latest state",
      confirmLabel: "Apply anyway",
      cancelLabel: "Refresh instead",
    });
    if (!proceed) return null;
  }
  return fresh;
}

// --- task list (root view) ---------------------------------------------------------

export class TaskListView implements ScreenView {
  private readonly deps: AutomationsTuiDeps;
  private readonly onOpen: (task: TaskView) => void;
  private readonly list: SelectList<TaskView>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";
  private tasks: TaskView[] = [];

  constructor(deps: AutomationsTuiDeps, onOpen: (task: TaskView) => void) {
    this.deps = deps;
    this.onOpen = onOpen;
    this.list = new SelectList<TaskView>({
      items: [],
      filterable: true,
      emptyText: "no automation tasks — n create · d drivers",
    });
    this.list.onSelect = (item) => {
      if (item.value) this.onOpen(item.value);
    };
    this.list.onCancel = () => void this.deps.ui.close();
  }

  /** (Re)load the task list. Read-only: `list` never mutates. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(["list"]);
      this.tasks = asTaskViews(payload.tasks);
      this.list.setItems(this.tasks.map(taskSelectItem));
      this.phase = "ready";
      this.errorText = "";
    } catch (err) {
      this.phase = "error";
      this.errorText = errorLine(err);
    }
    this.deps.ui.invalidate();
  }

  private createFlow(): void {
    void (async () => {
      if (!gateOf(this.deps, "create").allowed) return;
      const form = await promptCreateTask(this.deps.ui, this.deps.target);
      if (form === null) return;
      const ok = await this.deps.ui.confirm({
        title: "Create automation task?",
        target: [...form.summary, `target: ${formatTargetLabel(this.deps.target)}`],
        consequence:
          "registers a durable scheduled/event task; the OS scheduler or watch driver will fire it",
        confirmLabel: "Create",
      });
      if (!ok) return;
      const payload = await runOp(this.deps, "create", form.args);
      if (payload !== null) {
        const task = asTaskView(payload.task);
        this.deps.ui.setStatus(`created ${task?.task_id ?? "?"} — ${task?.name ?? "?"}`);
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: "loading automation tasks…", style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load tasks", style: { bold: true, fg: "red" } }]);
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
    // The inner list consumes navigation/enter/filter/q/esc first; while
    // its `/` filter is active it swallows every key, so extra bindings
    // below can never hijack filter typing.
    if (this.list.handleKey(ev) === true) return true;
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    switch (ev.key) {
      case "n":
        this.createFlow();
        return true;
      case "r":
      case "R":
        void this.load();
        return true;
      case "H":
        this.deps.ui.push(new RunsView(this.deps));
        return true;
      case "d":
        this.deps.ui.push(new DriversView(this.deps));
        return true;
      default:
        return false;
    }
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "open task" },
      { keys: "n", description: "new task (confirm)" },
      { keys: "H", description: "run history" },
      { keys: "d", description: "driver diagnostics" },
      { keys: ["r", "R"], description: "refresh" },
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

// --- task detail ------------------------------------------------------------------

export class TaskDetailView implements ScreenView {
  private readonly deps: AutomationsTuiDeps;
  private readonly taskId: string;
  private task: TaskView | null = null;
  private recentRuns: RunView[] = [];
  private phase: "loading" | "ready" | "error" | "missing" = "loading";
  private errorText = "";
  private scroll = 0;

  constructor(deps: AutomationsTuiDeps, taskId: string) {
    this.deps = deps;
    this.taskId = taskId;
    void this.load();
  }

  /** Read-only load: `get` + `runs --task` (derived missed shown honestly). */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const [getPayload, runsPayload] = await Promise.all([
        this.deps.cli(["get", this.taskId]),
        this.deps.cli(["runs", "--task", this.taskId, "--limit", "20"]).catch(() => null),
      ]);
      const task = asTaskView(getPayload.task);
      if (task === null) {
        this.phase = "error";
        this.errorText = "get returned no task payload";
      } else {
        this.task = task;
        this.recentRuns = runsPayload !== null ? asRunViews(runsPayload.runs) : [];
        this.phase = "ready";
        this.errorText = "";
      }
    } catch (err) {
      if (
        err instanceof Error &&
        "kind" in err &&
        (err as { kind?: unknown }).kind === "task_not_found"
      ) {
        this.phase = "missing";
      } else {
        this.phase = "error";
        this.errorText = errorLine(err);
      }
    }
    this.deps.ui.invalidate();
  }

  private gate(command: string): boolean {
    return gateOf(this.deps, command).allowed;
  }

  /** Shared tail for task mutations: gate → confirm? → revalidate → op → reload. */
  private async mutate(
    command: string,
    label: string,
    buildArgs: (task: TaskView) => readonly string[],
    confirm?: ConfirmOptions,
    timeoutMs = 120_000,
  ): Promise<void> {
    if (!this.gate(command)) return;
    if (confirm !== undefined) {
      const ok = await this.deps.ui.confirm(confirm);
      if (!ok) return;
    }
    const fresh = await revalidateTask(this.deps, this.taskId, this.task?.updated_at);
    if (fresh === null) return;
    const payload = await runOp(this.deps, label, buildArgs(fresh), timeoutMs);
    if (payload !== null) {
      this.deps.ui.setStatus(`${label} ok`);
      this.deps.onChanged?.();
      await this.load();
    }
  }

  private editMenu(): void {
    void (async () => {
      if (!this.gate("update")) return;
      const task = this.task;
      if (task === null) return;
      const field = await this.deps.ui.select({
        items: [
          { value: "name", label: "name", detail: task.name },
          { value: "prompt", label: "prompt", detail: task.prompt.slice(0, 80) },
          { value: "schedule", label: "schedule", detail: scheduleSummary(task.schedule) },
          {
            value: "destination",
            label: "destination",
            detail: destinationSummary(task.destination),
          },
          { value: "misfire", label: "misfire policy", detail: task.misfire },
        ],
        filterable: false,
        emptyText: "no editable fields",
      });
      if (field === null || field.value === undefined) return;
      const which = String(field.value);
      if (which === "name" || which === "prompt") {
        const current = which === "name" ? task.name : task.prompt;
        const input = await this.deps.ui.prompt(which === "name" ? "New task name" : "New prompt", {
          value: current,
        });
        if (input === null) return;
        const value = input.trim();
        if (value === "" || value === current) return;
        await this.mutate("update", `update ${which}`, (t) => [
          "update",
          t.task_id,
          which === "name" ? "--name" : "--prompt",
          value,
        ]);
        return;
      }
      if (which === "schedule") {
        const schedule = await promptScheduleForm(this.deps.ui, task.schedule);
        if (schedule === null) return;
        await this.mutate(
          "update",
          "update schedule",
          (t) => ["update", t.task_id, "--schedule", JSON.stringify(schedule)],
          {
            title: "Change task schedule?",
            target: [
              `task: ${this.taskId} (${task.name})`,
              `new schedule: ${scheduleSummary(schedule)}`,
            ],
            consequence:
              "resets the interval grid anchor; owed occurrences before now are not fired retroactively",
            confirmLabel: "Apply",
          },
        );
        return;
      }
      if (which === "destination") {
        const destination = await promptDestinationForm(
          this.deps.ui,
          this.deps.target,
          task.destination,
        );
        if (destination === null) return;
        await this.mutate(
          "update",
          "update destination",
          (t) => ["update", t.task_id, "--destination", JSON.stringify(destination)],
          {
            title: "Change task destination?",
            target: [
              `task: ${this.taskId} (${task.name})`,
              `new destination: ${destinationSummary(destination)}`,
            ],
            consequence: "future fires deliver to the new destination",
            confirmLabel: "Apply",
          },
        );
        return;
      }
      // misfire
      const misfireItem = await this.deps.ui.select({
        items: [
          { value: "skip", label: "skip", detail: "past occurrences become missed" },
          { value: "run_once", label: "run_once", detail: "collapse owed into one fire" },
        ],
        filterable: false,
      });
      if (misfireItem === null || misfireItem.value === undefined) return;
      const misfire = String(misfireItem.value);
      if (misfire === task.misfire) return;
      await this.mutate(
        "update",
        "update misfire",
        (t) => ["update", t.task_id, "--misfire", misfire],
        {
          title: "Change misfire policy?",
          target: [`task: ${this.taskId} (${task.name})`, `misfire: ${misfire}`],
          consequence: "changes how owed occurrences are handled after downtime",
          confirmLabel: "Apply",
        },
      );
    })();
  }

  private toggleEnabled(): void {
    const task = this.task;
    if (task === null) return;
    const enabling = !task.enabled;
    void this.mutate(
      "set-enabled",
      enabling ? "enable" : "disable",
      (t) => ["set-enabled", t.task_id, enabling ? "true" : "false"],
      {
        title: enabling ? "Enable task?" : "Disable task?",
        target: [
          `task: ${this.taskId} (${task.name})`,
          `schedule: ${scheduleSummary(task.schedule)}`,
        ],
        consequence: enabling
          ? "opens a new owed-occurrence window from now"
          : "stops future fires and materializes owed occurrences as missed runs",
        confirmLabel: enabling ? "Enable" : "Disable",
      },
    );
  }

  private runNow(): void {
    const task = this.task;
    if (task === null) return;
    void this.mutate(
      "run-now",
      "run-now",
      (t) => ["run-now", t.task_id],
      {
        title: "Run task now?",
        target: [
          `task: ${this.taskId} (${task.name})`,
          `prompt: ${task.prompt.slice(0, 120)}`,
          `destination: ${destinationSummary(task.destination)}`,
          `target: ${formatTargetLabel(this.deps.target)}`,
        ],
        consequence:
          "delivers the prompt to the destination agent immediately (agent.prompt/agent.start); a manual run record is created",
        confirmLabel: "Run now",
      },
      300_000,
    );
  }

  private reconcile(): void {
    void (async () => {
      if (!this.gate("reconcile")) return;
      const payload = await runOp(this.deps, "reconcile", ["reconcile", "--task", this.taskId]);
      if (payload !== null) {
        this.deps.ui.setStatus(
          `reconcile ok — materialized ${String(payload.materialized ?? "?")}`,
        );
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  private deleteTask(): void {
    const task = this.task;
    if (task === null) return;
    void this.mutate("delete", "delete", (t) => ["delete", t.task_id], {
      title: "Delete automation task?",
      target: [
        `task: ${this.taskId} (${task.name})`,
        `schedule: ${scheduleSummary(task.schedule)}`,
        `runs recorded: ${task.run_count}`,
      ],
      consequence: "removes the task and stops all future fires; existing run records are kept",
      confirmLabel: "Delete",
      danger: true,
    }).then(() => {
      // After a successful delete the task is gone — leave the detail
      // view if the reload reported missing.
      if (this.phase === "missing") this.deps.ui.pop();
    });
  }

  private showRuns(): void {
    this.deps.ui.push(new RunsView(this.deps, this.taskId));
  }

  private bodyLines(): string[] {
    const lines: string[] = [];
    const task = this.task;
    if (task !== null) {
      lines.push(`task ${task.name}${task.enabled ? "" : " (disabled)"}`);
      for (const l of taskHeaderLines(task)) lines.push(`  ${l}`);
      lines.push(`  prompt: ${task.prompt}`);
    }
    if (this.recentRuns.length > 0) {
      lines.push("recent runs (newest first; (derived) = owed occurrence, not stored):");
      for (const run of this.recentRuns.slice(0, 10)) {
        const derived = "derived" in run && run.derived === true;
        lines.push(
          `  ${run.status}${derived ? " (derived)" : ""} — ${run.scheduled_for ?? "manual"} · ${run.trigger}`,
        );
      }
    } else {
      lines.push("recent runs: (none)");
    }
    lines.push("");
    lines.push(
      "e edit · t enable/disable · x run now (confirm) · v runs · c reconcile · D delete (confirm) · R refresh",
    );
    return lines;
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: `loading task ${this.taskId}…`, style: { dim: true } }]);
      } else if (this.phase === "missing") {
        lines.push([{ text: `task not found: ${this.taskId}`, style: { bold: true, fg: "red" } }]);
        lines.push([
          { text: "it may have been deleted — go back and refresh", style: { dim: true } },
        ]);
      } else {
        lines.push([{ text: "failed to load task", style: { bold: true, fg: "red" } }]);
        for (const l of this.errorText.split("\n")) {
          lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
        }
      }
      lines.push([]);
      lines.push([{ text: "R — retry · Esc — back", style: { dim: true } }]);
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }

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
    if (this.phase !== "ready") {
      if (matchKey(ev, "r") || matchKey(ev, "R")) {
        void this.load();
        return true;
      }
      return false; // esc/q fall through to the app (back/close)
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
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    switch (ev.key) {
      case "e":
        this.editMenu();
        return true;
      case "t":
        this.toggleEnabled();
        return true;
      case "x":
        this.runNow();
        return true;
      case "v":
        this.showRuns();
        return true;
      case "c":
        this.reconcile();
        return true;
      case "D":
        this.deleteTask();
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
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      { keys: ["home", "end"], description: "top/bottom" },
      { keys: "e", description: "edit name/prompt/schedule/destination/misfire" },
      { keys: "t", description: "enable / disable (confirm)" },
      { keys: "x", description: "run now (confirm)" },
      { keys: "v", description: "run history for this task" },
      { keys: "c", description: "reconcile missed occurrences (explicit)" },
      { keys: "D", description: "delete task (confirm)" },
      { keys: "R", description: "refresh" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- runs history -----------------------------------------------------------------

export class RunsView implements ScreenView {
  private readonly deps: AutomationsTuiDeps;
  private readonly taskFilter: string | null;
  private readonly list: SelectList<RunView>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";

  constructor(deps: AutomationsTuiDeps, taskFilter: string | null = null) {
    this.deps = deps;
    this.taskFilter = taskFilter;
    this.list = new SelectList<RunView>({
      items: [],
      filterable: true,
      emptyText: "no runs recorded",
    });
    this.list.onSelect = (item) => {
      if (item.value) {
        this.deps.ui.push(
          new DetailView({
            title: `run ${item.value.run_id ?? "(derived)"}`,
            lines: runDetailLines(item.value),
            onClose: () => this.deps.ui.pop(),
          }),
        );
      }
    };
    this.list.onCancel = () => this.deps.ui.pop();
    void this.load();
  }

  /** Read-only load: `runs` merges stored runs with derived missed. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const args = ["runs", "--limit", "200"];
      if (this.taskFilter !== null) args.push("--task", this.taskFilter);
      const payload = await this.deps.cli(args);
      const runs = asRunViews(payload.runs);
      this.list.setItems(runs.map(runSelectItem));
      this.phase = "ready";
      this.errorText = "";
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
        lines.push([{ text: "loading runs…", style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load runs", style: { bold: true, fg: "red" } }]);
        for (const l of this.errorText.split("\n")) {
          lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
        }
        lines.push([{ text: "R — retry · Esc — back", style: { dim: true } }]);
      }
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    return this.list.render(width, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.phase !== "ready") {
      if (matchKey(ev, "r") || matchKey(ev, "R")) {
        void this.load();
        return true;
      }
      return false;
    }
    if (this.list.handleKey(ev) === true) return true;
    if (ev.kind === "key" && !ev.ctrl && !ev.alt && (ev.key === "r" || ev.key === "R")) {
      void this.load();
      return true;
    }
    return false;
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "run detail" },
      { keys: ["r", "R"], description: "refresh" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- driver diagnostics --------------------------------------------------------------

interface DriverLine {
  kind: "watch" | "os-scheduler" | "note";
  text: string;
}

/**
 * Driver diagnostics view. Read-only open shows the STORED driver
 * state derived from task views (`driver.state`/`detail`) — the same
 * honest coverage signal the CLI reports — plus the pinned session.
 * `schedule status` (which itself writes a driver record) and every
 * driver mutation (`tick`, `schedule install|uninstall`, `watch`)
 * are explicit, gated, confirmed keys — never implicit on open.
 */
export class DriversView implements ScreenView {
  private readonly deps: AutomationsTuiDeps;
  private drivers: DriverLine[] = [];
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";
  private scroll = 0;
  private lastScheduleStatus: Record<string, unknown> | null = null;

  constructor(deps: AutomationsTuiDeps) {
    this.deps = deps;
    void this.load();
  }

  /** Read-only load: `list` derives per-registry driver state. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(["list"]);
      const tasks = asTaskViews(payload.tasks);
      const lines: DriverLine[] = [];
      const seen = new Set<string>();
      for (const task of tasks) {
        const key = `${task.driver.state}|${task.driver.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push({
          kind: "note",
          text: `driver coverage: ${task.driver.state} — ${task.driver.detail}`,
        });
      }
      if (lines.length === 0) {
        lines.push({
          kind: "note",
          text: "no tasks — driver state is per-session; run `schedule status` (s) to probe the OS scheduler explicitly",
        });
      }
      lines.push({
        kind: "note",
        text: `pinned target: ${formatTargetLabel(this.deps.target)}`,
      });
      lines.push({
        kind: "note",
        text:
          "drivers: OS scheduler entry (schedule install) · opt-in watch process · manual tick. " +
          "tick/reconcile/watch/schedule-status are mutations — explicit keys only.",
      });
      this.drivers = lines;
      this.phase = "ready";
      this.errorText = "";
    } catch (err) {
      this.phase = "error";
      this.errorText = errorLine(err);
    }
    this.deps.ui.invalidate();
  }

  private bodyLines(): string[] {
    const lines: string[] = this.drivers.map((d) => `  ${d.text}`);
    if (this.lastScheduleStatus !== null) {
      const sched = asRecord(this.lastScheduleStatus.schedule);
      lines.push("", "last `schedule status` (explicit probe — writes a driver record):");
      if (sched !== null) {
        lines.push(
          `  platform: ${String(sched.platform ?? "?")} · state: ${String(sched.state ?? "?")}`,
        );
        lines.push(`  detail: ${String(sched.detail ?? "")}`);
      } else {
        lines.push(`  ${JSON.stringify(this.lastScheduleStatus)}`);
      }
    }
    lines.push("");
    lines.push(
      "s schedule status (mutation) · i install OS scheduler (confirm) · u uninstall (confirm) · t tick now (confirm) · w start watch (confirm) · R refresh",
    );
    return lines;
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: "loading driver state…", style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load driver state", style: { bold: true, fg: "red" } }]);
        for (const l of this.errorText.split("\n")) {
          lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
        }
      }
      lines.push([]);
      lines.push([{ text: "R — retry · Esc — back", style: { dim: true } }]);
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
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
      lines.push(
        i === 0 ? [{ text: clip(l, width), style: { bold: true } }] : [{ text: clip(l, width) }],
      );
    }
    while (lines.length < height - 1) lines.push([]);
    const pos = `${Math.min(this.scroll + 1, body.length)}/${body.length}`;
    lines.push([{ text: pos.padStart(width), style: { dim: true } }]);
    return lines.slice(0, height);
  }

  private scheduleStatus(): void {
    void (async () => {
      if (!gateOf(this.deps, "schedule status").allowed) return;
      const payload = await runOp(this.deps, "schedule status", ["schedule", "status"]);
      if (payload !== null) {
        this.lastScheduleStatus = payload;
        this.deps.ui.setStatus("schedule status refreshed");
        this.deps.onChanged?.();
        this.deps.ui.invalidate();
      }
    })();
  }

  private scheduleInstall(): void {
    void (async () => {
      if (!gateOf(this.deps, "schedule install").allowed) return;
      const ok = await this.deps.ui.confirm({
        title: "Install OS scheduler entry?",
        target: [
          `platform: ${process.platform}`,
          "entry: rebuildup.automations.tick — one scheduler entry invoking `automations tick` every 60s",
          `socket: ${this.deps.target.socketPath ?? "ambient"}`,
        ],
        consequence:
          "writes a launchd agent / systemd --user timer / schtasks entry on THIS host; fires scheduled tasks without any watch process",
        confirmLabel: "Install",
      });
      if (!ok) return;
      const payload = await runOp(this.deps, "schedule install", ["schedule", "install"], 60_000);
      if (payload !== null) {
        this.deps.ui.setStatus(`schedule install ok — ${String(asRecord(payload.driver) ?? "")}`);
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  private scheduleUninstall(): void {
    void (async () => {
      if (!gateOf(this.deps, "schedule uninstall").allowed) return;
      const ok = await this.deps.ui.confirm({
        title: "Uninstall OS scheduler entry?",
        target: [`entry: rebuildup.automations.tick on ${process.platform}`],
        consequence:
          "removes the OS scheduler entry; scheduled tasks stop firing until another driver (watch/manual) runs",
        confirmLabel: "Uninstall",
        danger: true,
      });
      if (!ok) return;
      const payload = await runOp(
        this.deps,
        "schedule uninstall",
        ["schedule", "uninstall"],
        60_000,
      );
      if (payload !== null) {
        this.deps.ui.setStatus("schedule uninstall ok");
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  private tickNow(): void {
    void (async () => {
      if (!gateOf(this.deps, "tick").allowed) return;
      const ok = await this.deps.ui.confirm({
        title: "Run tick now?",
        target: [
          `session socket: ${this.deps.target.socketPath ?? "ambient"}`,
          "all enabled tasks with due occurrences",
        ],
        consequence:
          "fires every due scheduled/event occurrence NOW — delivers prompts to destination agents; owed missed occurrences are materialized per misfire policy",
        confirmLabel: "Tick",
      });
      if (!ok) return;
      const payload = await runOp(this.deps, "tick", ["tick"], 300_000);
      if (payload !== null) {
        const fired = Array.isArray(payload.fired) ? payload.fired.length : 0;
        this.deps.ui.setStatus(
          `tick ok — fired ${fired}, missed materialized ${String(payload.missed_materialized ?? 0)}`,
        );
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  private watchStart(): void {
    void (async () => {
      if (!gateOf(this.deps, "watch").allowed) return;
      const ok = await this.deps.ui.confirm({
        title: "Start watch driver?",
        target: [
          `detached process: bun src/cli.ts watch --socket ${this.deps.target.socketPath ?? "ambient"}`,
          "this host, this session",
        ],
        consequence:
          "spawns a detached foreground-equivalent tick loop (default 60s cap) that keeps firing tasks until stopped; it survives this pane closing — stop it via its pid/SIGTERM",
        confirmLabel: "Start watch",
      });
      if (!ok) return;
      try {
        const pid = startWatchDetached(this.deps.target);
        this.deps.ui.setStatus(`watch started — pid ${pid} (driver record on next refresh)`);
        this.deps.onChanged?.();
      } catch (err) {
        this.deps.ui.setStatus(`watch start failed: ${errorLine(err)}`);
      }
    })();
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
    switch (ev.key) {
      case "s":
        this.scheduleStatus();
        return true;
      case "i":
        this.scheduleInstall();
        return true;
      case "u":
        this.scheduleUninstall();
        return true;
      case "t":
        this.tickNow();
        return true;
      case "w":
        this.watchStart();
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
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      { keys: ["home", "end"], description: "top/bottom" },
      { keys: "s", description: "schedule status (mutation)" },
      { keys: "i", description: "install OS scheduler (confirm)" },
      { keys: "u", description: "uninstall OS scheduler (confirm)" },
      { keys: "t", description: "tick now — fire due runs (confirm)" },
      { keys: "w", description: "start watch driver detached (confirm)" },
      { keys: "R", description: "refresh" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}
