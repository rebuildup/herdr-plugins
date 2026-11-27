/**
 * Screen views for the rebuildup.controls TUI (`herdr-plugins.tui/v1`).
 *
 * Boundary (issue #245 / tui-v1 §scope): herdr's own TUI already covers
 * plain agent browsing/attach; this surface exposes ONLY the
 * plugin-contract capabilities of `herdr-plugins.controls/v1` —
 * `send`/`command` (provider slash-command passthrough),
 * `wait`/`interrupt` (PTY-level, honestly labeled), `read` (bounded
 * scrollback, not history), `rename`, and `start` with the
 * per-provider launch table (model/reasoning/permission-mode/resume).
 *
 * Safety-contract mapping (ADR-0033 §3 / tui-v1 §5):
 * - read-only open: the list/detail loads run `session.snapshot` /
 *   `agent.get` reads only — no lazy mutation ever fires on open.
 * - explicit target: every operation names the pane/agent resolved
 *   from the pinned context or in-UI selection.
 * - stale generation: the CLI enforces `--expect-pane /
 *   --expect-state-seq / --expect-agent-session` → `stale_generation`
 *   before any `agent.*` mutation; the detail view re-reads
 *   `agent.get` and aborts locally on generation drift.
 * - mutation gating: `mutationAllowed` against the `capability`
 *   document; denied ops render disabled-with-reason or refuse with
 *   the reason in the status line.
 * - irreversible confirmation: `ui.confirm` shows exact target +
 *   consequence for every mutation; Esc cancels.
 * - timeout/cancel: all CLI work runs inside `ui.tasks.run`.
 * - honest unsupported: socket/CLI failures render their real
 *   `kind: message`, never a fabricated success.
 */

import {
  type AgentGetResult,
  type PaneInfo,
  request,
  resolveTarget,
} from "../../../packages/herdr-client/src/index";
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
import { KNOWN_AGENT_KINDS } from "./capability";
import { PROVIDER_COMMANDS } from "./commands";
import {
  buildLaunchArgs,
  canonicalKind,
  launchCapability,
  PERMISSION_MODES,
  type PermissionMode,
} from "./launch";
import {
  agentSelectItem,
  type CapabilityDoc,
  type CliRunOptions,
  errorLine,
  formatTargetLabel,
  identityLines,
  mutationAllowed,
  type PinnedTarget,
  type SessionAgents,
  shellPaneSelectItem,
} from "./tui-support";

// --- shared deps ----------------------------------------------------------------

/** The subset of `TuiApp` the views need (TuiApp satisfies this). */
export interface ControlsTuiUi {
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

export interface ControlsTuiDeps {
  cli(args: readonly string[], options?: CliRunOptions): Promise<Record<string, unknown>>;
  ui: ControlsTuiUi;
  /** `capability` payload fetched at launch; null = unavailable (fail closed). */
  capability: CapabilityDoc | null;
  target: PinnedTarget;
  /** Read-only session enumeration (snapshot). */
  agents(): Promise<SessionAgents>;
  /** Read-only `agent.get` for generation revalidation. */
  agentGet(target: string): Promise<AgentGetResult>;
  /** Called after a successful mutation so ancestor views can reload. */
  onChanged?: () => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Generation signals pinned at selection time (tui-v1 §3.3). */
interface PinnedAgent {
  paneId: string;
  stateChangeSeq: number | null;
  agentSession: string | null;
}

function pinAgent(agent: AgentGetResult): PinnedAgent {
  const session = asRecord(agent.agent_session);
  return {
    paneId: str(agent.pane_id) ?? "",
    stateChangeSeq: typeof agent.state_change_seq === "number" ? agent.state_change_seq : null,
    agentSession: str(session?.value),
  };
}

/** `--expect-*` argv suffix enforcing the pinned generation in the CLI. */
function expectArgs(pin: PinnedAgent): string[] {
  const args = ["--expect-pane", pin.paneId];
  if (pin.stateChangeSeq !== null) args.push("--expect-state-seq", String(pin.stateChangeSeq));
  if (pin.agentSession !== null) args.push("--expect-agent-session", pin.agentSession);
  return args;
}

// --- agent list (root view) -------------------------------------------------------

export class AgentListView implements ScreenView {
  private readonly deps: ControlsTuiDeps;
  private readonly onOpen: (paneId: string) => void;
  private readonly list: SelectList<{ paneId: string; agent: unknown }>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";
  private session: SessionAgents | null = null;

  constructor(deps: ControlsTuiDeps, onOpen: (paneId: string) => void) {
    this.deps = deps;
    this.onOpen = onOpen;
    this.list = new SelectList<{ paneId: string; agent: unknown }>({
      items: [],
      filterable: true,
      emptyText: "no agents reported — s start an agent on a shell pane",
    });
    this.list.onSelect = (item) => {
      if (item.value) this.onOpen(item.value.paneId);
    };
    this.list.onCancel = () => void this.deps.ui.close();
  }

  /** (Re)load the agent list. Read-only: `session.snapshot` never mutates. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      this.session = await this.deps.agents();
      const items = this.session.panes
        .filter((pane) => this.session?.agents[pane.pane_id] !== undefined)
        .map((pane) => {
          const agent = this.session?.agents[pane.pane_id];
          return agent === undefined ? null : agentSelectItem(pane, agent);
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
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

  /** Run a CLI op inside the task runner; returns payload or null. */
  private async runOp(
    label: string,
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown> | null> {
    const result = await this.deps.ui.tasks.run(
      { label, timeoutMs: options.timeoutMs ?? 60_000 },
      (signal) => this.deps.cli(args, { signal, timeoutMs: options.timeoutMs ?? 60_000 }),
    );
    if (result.status === "ok" && result.value !== undefined) {
      return result.value;
    }
    this.deps.ui.setStatus(
      result.status === "cancelled"
        ? `${label} cancelled`
        : `${label} ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
    );
    return null;
  }

  /**
   * `start` flow: pick a shell pane → agent kind → optional launch
   * options → confirm with the exact argv → `start` CLI. Every step is
   * explicit; nothing is guessed (contract item 2/5).
   */
  private async startFlow(): Promise<void> {
    if (!this.gate("start")) return;
    const session = this.session ?? (await this.deps.agents().catch(() => null));
    if (session === null) {
      this.deps.ui.setStatus("cannot enumerate panes — session snapshot unavailable");
      return;
    }
    const paneItems: SelectItem<PaneInfo>[] = session.panes.map((pane) =>
      shellPaneSelectItem(pane, session.agents[pane.pane_id] !== undefined),
    );
    if (paneItems.length === 0) {
      this.deps.ui.setStatus("no panes in session snapshot");
      return;
    }
    const paneChoice = await this.deps.ui.select({
      items: paneItems,
      filterable: true,
      emptyText: "no panes",
    });
    const pane = paneChoice?.value;
    if (pane === undefined) return;

    const kindItems: SelectItem<string>[] = KNOWN_AGENT_KINDS.map((kind) => {
      const launch = launchCapability(kind);
      const supported = [
        launch.model === true ? "model" : null,
        launch.reasoning === true ? "reasoning" : null,
        Object.keys(launch.permission_modes as Record<string, unknown>).length > 0
          ? "permission-mode"
          : null,
        launch.resume !== undefined && launch.resume !== null ? "resume" : null,
      ].filter((s): s is string => s !== null);
      return {
        value: kind,
        label: kind,
        detail: `launch options: ${supported.length > 0 ? supported.join(", ") : "none mapped"}`,
      };
    });
    const kindChoice = await this.deps.ui.select({
      items: kindItems,
      filterable: true,
      emptyText: "no agent kinds",
    });
    const kindRaw = kindChoice?.value;
    if (kindRaw === undefined) return;
    const kind = canonicalKind(kindRaw);

    const nameInput = await this.deps.ui.prompt("Agent name (optional — Enter for generated)", {
      placeholder: `${kind}-xxxx`,
    });
    if (nameInput === null) return;
    const name = nameInput.trim();

    const model = await this.deps.ui.prompt("Model (optional — provider flag)");
    if (model === null) return;
    const modelValue = model.trim();

    const reasoning = await this.deps.ui.prompt("Reasoning level (optional)");
    if (reasoning === null) return;
    const reasoningValue = reasoning.trim();

    const modeChoice = await this.deps.ui.select<string>({
      items: [
        { value: "", label: "(default — no permission-mode flag)" },
        ...PERMISSION_MODES.map((m) => ({
          value: m,
          label: m,
          detail: "provider permission mode mapped by the launch table",
        })),
      ],
      filterable: false,
      emptyText: "no modes",
    });
    if (modeChoice === null) return;
    const permissionMode = (modeChoice.value === "" ? undefined : modeChoice.value) as
      | PermissionMode
      | undefined;

    // Resume: none | explicit session value | another agent's reported session.
    const resumeMode = await this.deps.ui.select<string>({
      items: [
        { value: "none", label: "no resume" },
        { value: "value", label: "--resume <session value>" },
        { value: "from", label: "--resume-from <agent target>" },
      ],
      filterable: false,
      emptyText: "",
    });
    if (resumeMode === null) return;
    let resumeArg: string[] = [];
    if (resumeMode.value === "value") {
      const v = await this.deps.ui.prompt("Resume session value (agent_session.value / id)");
      if (v === null) return;
      const value = v.trim();
      if (value !== "") resumeArg = ["--resume", value];
    } else if (resumeMode.value === "from") {
      const agentItems: SelectItem<{ paneId: string }>[] = Object.keys(session.agents).map(
        (paneId) => ({
          value: { paneId },
          label: `${paneId} — ${str(session.agents[paneId]?.agent) ?? "agent"} (${str(session.agents[paneId]?.agent_status) ?? "?"})`,
        }),
      );
      if (agentItems.length === 0) {
        this.deps.ui.setStatus("no agents to resume from");
        return;
      }
      const src = await this.deps.ui.select({ items: agentItems, filterable: true });
      const srcPane = src?.value?.paneId;
      if (srcPane === undefined) return;
      resumeArg = ["--resume-from", srcPane];
    }

    // Preview argv through the same builder the CLI uses — the confirm
    // shows the EXACT args, and builder errors surface before launch.
    let previewArgs: string[] = [];
    try {
      const built = buildLaunchArgs({
        kind,
        ...(modelValue !== "" ? { model: modelValue } : {}),
        ...(reasoningValue !== "" ? { reasoning: reasoningValue } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
        extraArgs: [],
        unsafeArgs: false,
      });
      previewArgs = built.args;
    } catch (err) {
      this.deps.ui.setStatus(`launch args rejected: ${errorLine(err)}`);
      return;
    }

    const argvLine = ["agent.start", `kind=${kind}`, `pane=${pane.pane_id}`]
      .concat(name !== "" ? [`name=${name}`] : [])
      .concat(resumeArg)
      .join(" ");
    const ok = await this.deps.ui.confirm({
      title: "Start agent on pane?",
      target: [
        `pane: ${pane.pane_id}${str(pane.cwd) !== null ? ` (cwd ${pane.cwd})` : ""}`,
        `kind: ${kindRaw} → ${kind}`,
        ...(name !== "" ? [`name: ${name}`] : []),
        `argv: ${argvLine}${previewArgs.length > 0 ? ` ${previewArgs.join(" ")}` : ""}`,
        `target: ${formatTargetLabel(this.deps.target)}`,
      ],
      consequence:
        "launches a provider agent process in the pane via agent.start; herdr waits for interactive readiness",
      confirmLabel: "Start",
    });
    if (!ok) return;

    const args: string[] = [
      "start",
      pane.pane_id,
      "--agent",
      kindRaw,
      ...(name !== "" ? ["--name", name] : []),
      ...(modelValue !== "" ? ["--model", modelValue] : []),
      ...(reasoningValue !== "" ? ["--reasoning", reasoningValue] : []),
      ...(permissionMode !== undefined ? ["--permission-mode", permissionMode] : []),
      ...resumeArg,
    ];
    const payload = await this.runOp("start", args, { timeoutMs: 300_000 });
    if (payload !== null) {
      const identity = asRecord(payload.identity);
      this.deps.ui.setStatus(
        `started ${str(identity?.agent) ?? kind} on ${str(identity?.pane_id) ?? pane.pane_id}`,
      );
      this.deps.onChanged?.();
      await this.load();
    }
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: "loading agents…", style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load agents", style: { bold: true, fg: "red" } }]);
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
      case "s":
        void this.startFlow();
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
      { keys: "/", description: "filter" },
      { keys: "enter", description: "open agent" },
      { keys: "s", description: "start agent on shell pane" },
      { keys: ["r", "R"], description: "refresh" },
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

// --- agent detail -----------------------------------------------------------------

export class AgentDetailView implements ScreenView {
  private readonly deps: ControlsTuiDeps;
  private readonly paneId: string;
  private agent: AgentGetResult | null = null;
  private pin: PinnedAgent | null = null;
  private phase: "loading" | "ready" | "error" | "missing" = "loading";
  private errorText = "";
  private scroll = 0;

  constructor(deps: ControlsTuiDeps, paneId: string) {
    this.deps = deps;
    this.paneId = paneId;
    void this.load();
  }

  /** Read-only refresh: `agent.get` through the documented socket API. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const agent = await this.deps.agentGet(this.paneId);
      this.agent = agent;
      this.pin = pinAgent(agent);
      this.phase = "ready";
      this.errorText = "";
    } catch (err) {
      const kind =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
      if (kind === "agent_not_found" || kind === "pane_not_found") {
        this.phase = "missing";
      } else {
        this.phase = "error";
        this.errorText = errorLine(err);
      }
    }
    this.deps.ui.invalidate();
  }

  /**
   * Stale-generation gate (tui-v1 §3.3): re-read `agent.get` before a
   * mutation and compare the pinned signals. Drift aborts with an
   * honest stale status; the CLI's `--expect-*` flags are the second
   * enforcement layer inside the subprocess.
   */
  private async revalidate(): Promise<PinnedAgent | null> {
    if (this.pin === null) return null;
    let fresh: AgentGetResult;
    try {
      fresh = await this.deps.agentGet(this.pin.paneId);
    } catch (err) {
      this.deps.ui.setStatus(`revalidate failed: ${errorLine(err)}`);
      return null;
    }
    const next = pinAgent(fresh);
    const drift: string[] = [];
    if (next.stateChangeSeq !== this.pin.stateChangeSeq) {
      drift.push(`state_change_seq ${this.pin.stateChangeSeq} → ${next.stateChangeSeq}`);
    }
    if (next.agentSession !== this.pin.agentSession) {
      drift.push("agent_session changed");
    }
    if (drift.length > 0) {
      this.deps.ui.setStatus(`stale agent generation: ${drift.join(", ")} — press R to refresh`);
      this.agent = fresh;
      this.pin = next;
      this.deps.ui.invalidate();
      return null;
    }
    return this.pin;
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

  /** Shared tail: gate → revalidate → confirm → op → refresh. */
  private async mutate(
    command: string,
    label: string,
    buildArgs: (pin: PinnedAgent) => readonly string[],
    confirm: ConfirmOptions,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    if (!this.gate(command)) return;
    const pin = await this.revalidate();
    if (pin === null) return;
    const ok = await this.deps.ui.confirm(confirm);
    if (!ok) return;
    // Re-check after the confirm dialog: the user may have dwelt on it.
    const fresh = await this.revalidate();
    if (fresh === null) return;
    const payload = await this.runOp(label, buildArgs(fresh), options);
    if (payload !== null) {
      this.deps.ui.setStatus(`${label} ok`);
      this.deps.onChanged?.();
      await this.load();
    }
  }

  private targetLines(): string[] {
    const a = this.agent;
    return [
      `pane: ${this.paneId}`,
      `agent: ${str(a?.agent) ?? "?"} · status: ${str(a?.agent_status) ?? "?"}`,
      `session: ${formatTargetLabel(this.deps.target)}`,
    ];
  }

  // --- operations ---------------------------------------------------------------

  private sendFlow(): void {
    void (async () => {
      if (!this.gate("send")) return;
      const text = await this.deps.ui.prompt("Message text to send (agent.prompt)");
      if (text === null) return;
      const body = text.trim();
      if (body === "") {
        this.deps.ui.setStatus("empty message — cancelled");
        return;
      }
      // Optional post-submit observation (read; not a wait guarantee).
      const waitChoice = await this.deps.ui.select<string>({
        items: [
          { value: "", label: "send only" },
          { value: "idle", label: "wait until idle" },
          { value: "working", label: "wait until working" },
          { value: "blocked", label: "wait until blocked" },
          { value: "done", label: "wait until done" },
        ],
        filterable: false,
        emptyText: "",
      });
      if (waitChoice === null) return;
      const until = waitChoice.value;
      await this.mutate(
        "send",
        "send",
        (pin) => [
          "send",
          pin.paneId,
          body,
          ...expectArgs(pin),
          ...(until !== "" ? ["--wait-until", until, "--timeout-ms", "60000"] : []),
        ],
        {
          title: "Send message to agent?",
          target: [
            ...this.targetLines(),
            `text: ${body.length > 120 ? `${body.slice(0, 117)}…` : body}`,
          ],
          consequence: "submits text to the agent PTY via agent.prompt (bracketed paste + Enter)",
          confirmLabel: "Send",
        },
        { timeoutMs: 120_000 },
      );
    })();
  }

  private commandFlow(): void {
    void (async () => {
      if (!this.gate("command")) return;
      const kind = str(this.agent?.agent);
      const known = kind !== null ? (PROVIDER_COMMANDS[kind] ?? []) : [];
      const hint =
        known.length > 0
          ? `e.g. /${known[0]} (known: ${known.slice(0, 6).join(", ")})`
          : "e.g. /model";
      const input = await this.deps.ui.prompt(`Slash command ${hint}`, {
        placeholder: "/command args",
      });
      if (input === null) return;
      const raw = input.trim();
      if (raw === "") {
        this.deps.ui.setStatus("empty command — cancelled");
        return;
      }
      const slash = raw.startsWith("/") ? raw : `/${raw}`;
      await this.mutate(
        "command",
        "command",
        (pin) => ["command", pin.paneId, slash, ...expectArgs(pin)],
        {
          title: "Run provider slash command?",
          target: [...this.targetLines(), `command: ${slash}`],
          consequence:
            "types the literal command text via agent.prompt; the provider TUI interprets it — fragile, unverified per provider",
          confirmLabel: "Send",
        },
      );
    })();
  }

  private waitFlow(): void {
    void (async () => {
      // `wait` is a read-class op (not in mutation_commands) — no gate.
      const untilChoice = await this.deps.ui.select<string>({
        items: [
          { value: "", label: "default (idle|done|blocked)" },
          { value: "idle", label: "idle" },
          { value: "working", label: "working" },
          { value: "blocked", label: "blocked" },
          { value: "done", label: "done" },
        ],
        filterable: false,
        emptyText: "",
      });
      if (untilChoice === null) return;
      const until = untilChoice.value;
      const payload = await this.runOp(
        "wait",
        [
          "wait",
          this.paneId,
          ...(until !== "" ? ["--until", until] : []),
          "--timeout-ms",
          "120000",
        ],
        { timeoutMs: 150_000 },
      );
      if (payload !== null) {
        const result = asRecord(payload.result);
        this.deps.ui.setStatus(
          `wait resolved: ${str(result?.agent_status) ?? str(result?.status) ?? "ok"}`,
        );
        await this.load();
      }
    })();
  }

  private interruptFlow(): void {
    void (async () => {
      if (!this.gate("interrupt")) return;
      const keyChoice = await this.deps.ui.select<string>({
        items: [
          { value: "esc", label: "esc (default interrupt)" },
          { value: "ctrl+c", label: "ctrl+c" },
          { value: "ctrl+d", label: "ctrl+d" },
          { value: "enter", label: "enter" },
        ],
        filterable: false,
        emptyText: "",
      });
      if (keyChoice === null) return;
      const key = keyChoice.value;
      await this.mutate(
        "interrupt",
        "interrupt",
        (pin) => ["interrupt", pin.paneId, "--key", key, ...expectArgs(pin)],
        {
          title: "Send PTY-level keys to agent?",
          target: [...this.targetLines(), `keys: ${key}`],
          consequence:
            "injects keys into the terminal (agent.send_keys) — PTY-level only, effect depends on provider keybindings; use for blocked dialogs",
          confirmLabel: "Send keys",
          danger: true,
        },
      );
    })();
  }

  private readFlow(): void {
    void (async () => {
      // `read` is a read-class op — bounded scrollback, not history.
      const payload = await this.runOp(
        "read",
        ["read", this.paneId, "--source", "recent", "--lines", "200"],
        { timeoutMs: 60_000 },
      );
      if (payload === null) return;
      const read = asRecord(payload.read);
      const text = str(read?.text) ?? "";
      const lines = text === "" ? ["(empty scrollback)"] : text.split("\n");
      const truncated = read?.truncated === true ? " (truncated)" : "";
      this.deps.ui.push(
        new DetailView({
          title: `scrollback ${this.paneId} — recent${truncated}`,
          lines,
          onClose: () => this.deps.ui.pop(),
        }),
      );
    })();
  }

  private renameFlow(): void {
    void (async () => {
      if (!this.gate("rename")) return;
      const current = str(this.agent?.terminal_title_stripped) ?? "";
      const input = await this.deps.ui.prompt("New agent name (empty = clear)", {
        value: current,
      });
      if (input === null) return;
      const name = input.trim();
      const clear = name === "";
      if (!clear && name === current) return;
      await this.mutate(
        "rename",
        "rename",
        (pin) => [
          "rename",
          pin.paneId,
          ...(clear ? ["--clear"] : ["--name", name]),
          ...expectArgs(pin),
        ],
        {
          title: clear ? "Clear agent name?" : "Rename agent?",
          target: [...this.targetLines(), `name: ${clear ? "(cleared)" : name}`],
          consequence: "sets the agent display name via agent.rename",
          confirmLabel: clear ? "Clear" : "Rename",
        },
      );
    })();
  }

  private focusFlow(): void {
    void (async () => {
      // pane.focus is a herdr UI mutation, not a controls contract op —
      // honest attempt, no gate (it cannot alter agent state).
      const ok = await this.deps.ui.confirm({
        title: "Focus this agent's pane?",
        target: this.targetLines(),
        consequence:
          "moves herdr UI focus to the pane (pane.focus); reversible, no agent state change",
        confirmLabel: "Focus",
      });
      if (!ok) return;
      try {
        await request(resolveTarget({}).socketPath, "pane.focus", { pane_id: this.paneId });
        this.deps.ui.setStatus(`focused ${this.paneId}`);
      } catch (err) {
        this.deps.ui.setStatus(`focus failed: ${errorLine(err)}`);
      }
    })();
  }

  // --- render ---------------------------------------------------------------------

  private contentLines(): string[] {
    const lines: string[] = [];
    if (this.agent !== null) {
      lines.push(...identityLines(this.agent));
    }
    lines.push("");
    lines.push(
      "ops: s send · c command · w wait · i interrupt · v scrollback · n rename · f focus · R refresh",
    );
    return lines;
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: `loading agent ${this.paneId}…`, style: { dim: true } }]);
      } else {
        const title =
          this.phase === "missing"
            ? `agent/pane not found: ${this.paneId}`
            : "failed to load agent";
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
    // Scrollable detail: header + ops hint, body scrolls.
    const source = this.contentLines();
    const wrapped: string[] = [];
    for (const l of source) {
      // word-wrap long lines
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
    out.push([{ text: clip(`agent ${this.paneId}`, width), style: { bold: true } }]);
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
      return false; // let app handle esc/q back
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
      case "s":
        this.sendFlow();
        return true;
      case "c":
        this.commandFlow();
        return true;
      case "w":
        this.waitFlow();
        return true;
      case "i":
        this.interruptFlow();
        return true;
      case "v":
        this.readFlow();
        return true;
      case "n":
        this.renameFlow();
        return true;
      case "f":
        this.focusFlow();
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
      { keys: ["↑", "k", "↓", "j", "space"], description: "scroll" },
      { keys: "s", description: "send message (agent.prompt)" },
      { keys: "c", description: "provider slash command (fragile)" },
      { keys: "w", description: "wait for status" },
      { keys: "i", description: "PTY-level interrupt keys" },
      { keys: "v", description: "scrollback read" },
      { keys: "n", description: "rename agent" },
      { keys: "f", description: "focus pane" },
      { keys: ["r", "R"], description: "refresh" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}
