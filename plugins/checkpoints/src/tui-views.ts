/**
 * Screen views for the rebuildup.checkpoints TUI (`herdr-plugins.tui/v1`).
 *
 * Safety-contract mapping (ADR-0033 §3 / tui-v1 §5):
 * - read-only open: every load runs CLI reads with `--no-drain`
 *   (`readArgs`), so the lazy pending-capture drain — which mutates
 *   state by capturing work-unit checkpoints — never fires implicitly.
 *   The drain runs only via the explicit `a` key (a plain `list`
 *   invocation, same as the CLI) or inside mutation commands.
 * - explicit target: `create`/`save` name the pinned origin pane id or
 *   an explicitly entered repo path; `HERDR_PANE_ID` (the UI pane) is
 *   never consulted because every pane-resolving command gets its
 *   target as an explicit argv element.
 * - stale generation: `revalidate` re-reads `show <id>` before
 *   restore/delete; a vanished checkpoint aborts `stale_*`-class.
 *   Restore additionally relies on the CLI's own ref/isolation checks
 *   (`checkpoint_ref_missing`, `shared_worktree`, `session_unreachable`)
 *   which surface verbatim — never retargeted.
 * - mutation gating: `mutationAllowed` against the `capability`
 *   document; denied ops render disabled-with-reason or refuse with
 *   the reason in the status line.
 * - irreversible confirmation: `ui.confirm` shows exact target +
 *   consequence for every mutation; Esc cancels; restore is `danger`.
 * - timeout/cancel: all CLI work runs inside `ui.tasks.run`.
 * - honest unsupported: CLI/git/socket failures render their real
 *   `kind: message`, never a fabricated success.
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
  text,
} from "../../../packages/tui/src/index";
import { wrapText } from "../../../packages/tui/src/unicode";
import type { CheckpointEntry } from "./state";
import {
  asCheckpoint,
  asCheckpoints,
  type CapabilityDoc,
  type CliRunOptions,
  checkpointHeaderLines,
  checkpointKind,
  checkpointSelectItem,
  errorLine,
  formatAutoCaptures,
  formatDiffPayload,
  formatGcPayload,
  formatMutationPayload,
  formatPlanPayload,
  formatShowPayload,
  formatTargetLabel,
  mutationAllowed,
  type PinnedTarget,
  pendingAutoCaptureCount,
  readArgs,
  shortId,
} from "./tui-support";

// --- shared deps ----------------------------------------------------------------

/** The subset of `TuiApp` the views need (TuiApp satisfies this). */
export interface CheckpointsTuiUi {
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

export interface CheckpointsTuiDeps {
  cli(args: readonly string[], options?: CliRunOptions): Promise<Record<string, unknown>>;
  ui: CheckpointsTuiUi;
  /** `capability` payload fetched at launch; null = unavailable (fail closed). */
  capability: CapabilityDoc | null;
  target: PinnedTarget;
  /** Called after a successful mutation so ancestor views can reload. */
  onChanged?: () => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  return String(value);
}

/** Scrollable read-only text surface with an extra key hook. */
abstract class ScrollableTextView implements ScreenView {
  protected scroll = 0;
  protected titleText: string;
  protected sourceLines: readonly string[];

  constructor(title: string, source: readonly string[]) {
    this.titleText = title;
    this.sourceLines = source;
  }

  protected abstract extraKey(ev: KeyEvent): boolean;

  handleKey(ev: KeyEvent): boolean {
    if (this.extraKey(ev)) return true;
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
      return true; // subclasses handle close via onClose
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    const bodyH = Math.max(1, height - (this.titleText !== "" ? 3 : 1));
    const wrapped: string[] = [];
    for (const l of this.sourceLines) wrapped.push(...wrapText(l, Math.max(1, width - 2)));
    const maxScroll = Math.max(0, wrapped.length - bodyH);
    this.scroll = Math.min(this.scroll, maxScroll);
    const view = wrapped.slice(this.scroll, this.scroll + bodyH);
    const lines: Line[] = [];
    if (this.titleText !== "") {
      lines.push([{ text: clip(this.titleText, width), style: { bold: true } }]);
      lines.push(Array.from({ length: width }, () => ({ text: "─", style: { dim: true } })));
    }
    for (const v of view) lines.push(text(clip(v, width)));
    while (lines.length < height - 1) lines.push([]);
    const pos =
      wrapped.length > 0 ? `${Math.min(this.scroll + 1, wrapped.length)}/${wrapped.length}` : "0/0";
    lines.push([{ text: clip(`${pos} · esc back`, width), style: { dim: true } }]);
    return lines.slice(0, height);
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      { keys: ["home", "end"], description: "top/bottom" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- checkpoint list (root view) -----------------------------------------------------

const LIST_LIMIT = 500;

export class CheckpointListView implements ScreenView {
  private readonly deps: CheckpointsTuiDeps;
  private readonly list: SelectList<CheckpointEntry>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";
  private repoFilter: string | null = null;
  private entries: CheckpointEntry[] = [];
  private pendingCount: number | null = null;

  constructor(deps: CheckpointsTuiDeps) {
    this.deps = deps;
    this.list = new SelectList<CheckpointEntry>({
      items: [],
      filterable: true,
      emptyText: "no checkpoints — c capture · w capture by repo · s save group",
    });
    this.list.onSelect = (item) => {
      if (item.value) this.deps.ui.push(new CheckpointDetailView(this.deps, item.value.id));
    };
    this.list.onCancel = () => void this.deps.ui.close();
  }

  /** (Re)load the checkpoint index. Read-only: `list --no-drain`. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const args = ["list", "--limit", String(LIST_LIMIT)];
      if (this.repoFilter !== null) args.push("--repo", this.repoFilter);
      const payload = await this.deps.cli(readArgs(args));
      this.entries = asCheckpoints(payload);
      this.list.setItems(this.entries.map(checkpointSelectItem));
      this.phase = "ready";
      this.errorText = "";
    } catch (err) {
      this.phase = "error";
      this.errorText = errorLine(err);
    }
    // Pending auto-capture marks: read-only state peek, never a drain.
    this.pendingCount = await pendingAutoCaptureCount();
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
    const timeoutMs = options.timeoutMs ?? 120_000;
    const result = await this.deps.ui.tasks.run({ label, timeoutMs }, (signal) =>
      this.deps.cli(args, { signal, timeoutMs }),
    );
    if (result.status === "ok" && result.value !== undefined) {
      return result.value;
    }
    if (result.status === "cancelled") {
      this.deps.ui.setStatus(`${label} cancelled`);
    } else {
      this.deps.ui.setStatus(
        `${label} ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
      );
    }
    return null;
  }

  /** Optional label prompt shared by create/save flows. */
  private async promptLabel(): Promise<string | null | undefined> {
    const input = await this.deps.ui.prompt("Label (optional — Enter for none)");
    if (input === null) return null; // cancelled
    const label = input.trim();
    return label === "" ? undefined : label;
  }

  /** Show a mutation result payload, then reload the list. */
  private async showResult(label: string, payload: Record<string, unknown>): Promise<void> {
    const lines = formatMutationPayload(payload);
    const autoLines = formatAutoCaptures(payload);
    if (autoLines !== null) lines.push(...autoLines);
    this.deps.ui.push(
      new DetailView({
        title: label,
        lines,
        onClose: () => this.deps.ui.pop(),
      }),
    );
    this.deps.onChanged?.();
    await this.load();
  }

  /** `c` — capture the pinned origin pane's repo (explicit pane id argv). */
  private createForPinnedPane(): void {
    const paneId = this.deps.target.originPaneId;
    if (paneId === null) {
      this.deps.ui.setStatus(
        "no pinned pane — use w to capture by repo path, or open from a pane context",
      );
      return;
    }
    void (async () => {
      if (!this.gate("create")) return;
      const cwd = this.deps.target.originCwd;
      const ok = await this.deps.ui.confirm({
        title: "Capture checkpoint?",
        target: [
          `pane: ${paneId} (pinned at launch — NOT the TUI pane)`,
          ...(cwd !== null ? [`pane cwd: ${cwd}`] : []),
          `target: ${formatTargetLabel(this.deps.target)}`,
        ],
        consequence:
          "snapshots the pane repo's worktree into a hidden-ref checkpoint (tracked + staged + untracked, .gitignore respected); never touches the real index",
        confirmLabel: "Capture",
      });
      if (!ok) return;
      const label = await this.promptLabel();
      if (label === null) return;
      const args = ["create", paneId];
      if (label !== undefined) args.push("--label", label);
      const payload = await this.runOp("create", args);
      if (payload !== null) {
        this.deps.ui.setStatus(
          `captured ${fmt(asCheckpoint(payload.checkpoint)?.id ?? "?")} — ${fmt(payload.repo_root)}`,
        );
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  /** `w` — capture by explicit repo path (`create --repo`). */
  private createByRepoPath(): void {
    void (async () => {
      if (!this.gate("create")) return;
      const hint = this.deps.target.originCwd;
      const input = await this.deps.ui.prompt(
        hint !== null ? `Repo path to capture (origin cwd: ${hint})` : "Repo path to capture",
        hint !== null ? { value: hint } : {},
      );
      if (input === null) return;
      const repoPath = input.trim();
      if (repoPath === "") {
        this.deps.ui.setStatus("empty repo path — cancelled");
        return;
      }
      const ok = await this.deps.ui.confirm({
        title: "Capture checkpoint?",
        target: [`repo: ${repoPath}`, `target: ${formatTargetLabel(this.deps.target)}`],
        consequence:
          "snapshots the repo worktree into a hidden-ref checkpoint; never touches the real index",
        confirmLabel: "Capture",
      });
      if (!ok) return;
      const label = await this.promptLabel();
      if (label === null) return;
      const args = ["create", "--repo", repoPath];
      if (label !== undefined) args.push("--label", label);
      const payload = await this.runOp("create", args);
      if (payload !== null) {
        this.deps.ui.setStatus(`captured — ${fmt(payload.repo_root)}`);
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  /** `s` — multi-repo `save` group (pinned pane repo or live discovery). */
  private saveGroup(): void {
    const paneId = this.deps.target.originPaneId;
    void (async () => {
      if (!this.gate("save")) return;
      const discovered = paneId === null;
      const ok = await this.deps.ui.confirm({
        title: "Save checkpoint group?",
        target: [
          discovered
            ? "repos: live discovery — EVERY distinct repo reachable from session pane cwds"
            : `pane: ${paneId} (pinned at launch — its repo only)`,
          `target: ${formatTargetLabel(this.deps.target)}`,
        ],
        consequence: discovered
          ? "captures one checkpoint per discovered repo under a shared group id; non-repo cwds are skipped and reported"
          : "captures one checkpoint for the pane's repo under a new group id",
        confirmLabel: "Save",
      });
      if (!ok) return;
      const label = await this.promptLabel();
      if (label === null) return;
      const args = ["save"];
      if (!discovered && paneId !== null) args.push("--pane", paneId);
      if (label !== undefined) args.push("--label", label);
      const payload = await this.runOp("save", args, { timeoutMs: 300_000 });
      if (payload !== null) {
        await this.showResult("save", payload);
      }
    })();
  }

  /** `a` — explicit pending-capture drain (the ONLY TUI path that drains). */
  private drainPending(): void {
    void (async () => {
      // A plain `list` invocation drains pending marks exactly like the
      // CLI; --no-drain is deliberately omitted. Explicit user action.
      const payload = await this.runOp("drain pending captures", ["list", "--limit", "1"]);
      if (payload === null) return;
      const autoLines = formatAutoCaptures(payload);
      this.deps.ui.push(
        new DetailView({
          title: "auto-capture drain",
          lines: autoLines ?? ["no auto_captures report in payload"],
          onClose: () => this.deps.ui.pop(),
        }),
      );
      await this.load();
    })();
  }

  /** `f` — repo filter for the list (`list --repo`). */
  private filterByRepo(): void {
    void (async () => {
      const current = this.repoFilter ?? "";
      const input = await this.deps.ui.prompt(
        "Repo path filter (absolute path inside the repo; empty = all repos)",
        { value: current },
      );
      if (input === null) return;
      const value = input.trim();
      this.repoFilter = value === "" ? null : value;
      this.deps.ui.setStatus(
        this.repoFilter === null ? "repo filter cleared" : `repo filter: ${this.repoFilter}`,
      );
      await this.load();
    })();
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: "loading checkpoints…", style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load checkpoints", style: { bold: true, fg: "red" } }]);
        for (const l of this.errorText.split("\n")) {
          lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
        }
        lines.push([{ text: "R — retry · Esc — close", style: { dim: true } }]);
      }
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    // Header line above the select list: filter + pending marks + target.
    const pending =
      this.pendingCount === null
        ? "pending auto-captures: unknown"
        : this.pendingCount > 0
          ? `${this.pendingCount} pending auto-capture(s) — a drains explicitly`
          : "no pending auto-captures";
    const header = [
      this.repoFilter !== null ? `repo: ${this.repoFilter}` : "all repos",
      pending,
      formatTargetLabel(this.deps.target),
    ].join(" · ");
    const body = this.list.render(width, Math.max(1, height - 1));
    return [[{ text: clip(header, width), style: { dim: true } }], ...body].slice(0, height);
  }

  handleKey(ev: KeyEvent): boolean {
    // The inner list consumes navigation/enter/filter/q/esc first; while
    // its `/` filter is active it swallows every key, so extra bindings
    // below can never hijack filter typing.
    if (this.list.handleKey(ev) === true) return true;
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    switch (ev.key) {
      case "c":
        this.createForPinnedPane();
        return true;
      case "w":
        this.createByRepoPath();
        return true;
      case "s":
        this.saveGroup();
        return true;
      case "g":
        this.deps.ui.push(new CheckpointGroupListView(this.deps));
        return true;
      case "G":
        this.deps.ui.push(new CheckpointRetentionView(this.deps, "gc"));
        return true;
      case "p":
        this.deps.ui.push(new CheckpointRetentionView(this.deps, "prune"));
        return true;
      case "a":
        this.drainPending();
        return true;
      case "f":
        this.filterByRepo();
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
      { keys: "enter", description: "checkpoint detail" },
      { keys: "c", description: "capture pinned pane repo" },
      { keys: "w", description: "capture by repo path" },
      { keys: "s", description: "save checkpoint group" },
      { keys: "g", description: "groups" },
      { keys: "G", description: "gc (dry-run first)" },
      { keys: "p", description: "prune (dry-run first)" },
      { keys: "a", description: "drain pending auto-captures" },
      { keys: "f", description: "repo filter" },
      { keys: ["r", "R"], description: "refresh" },
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

// --- checkpoint detail ----------------------------------------------------------------

export class CheckpointDetailView implements ScreenView {
  private readonly deps: CheckpointsTuiDeps;
  private readonly checkpointId: string;
  private entry: CheckpointEntry | null = null;
  private content: string[] = [];
  private phase: "loading" | "ready" | "error" | "missing" = "loading";
  private errorText = "";
  private scroll = 0;

  constructor(deps: CheckpointsTuiDeps, checkpointId: string) {
    this.deps = deps;
    this.checkpointId = checkpointId;
    void this.load();
  }

  /** Read-only load: `show <id> --no-drain`. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(readArgs(["show", this.checkpointId]));
      const entry = asCheckpoint(payload.checkpoint);
      if (entry === null) {
        this.phase = "error";
        this.errorText = "show returned no checkpoint payload";
      } else {
        this.entry = entry;
        this.content = formatShowPayload(payload);
        this.phase = "ready";
        this.errorText = "";
      }
    } catch (err) {
      const kind =
        err instanceof Error && "kind" in err ? String((err as { kind: unknown }).kind) : "";
      if (kind === "unknown_checkpoint") {
        this.phase = "missing";
      } else {
        this.phase = "error";
        this.errorText = errorLine(err);
      }
    }
    this.deps.ui.invalidate();
  }

  /**
   * Stale-generation gate (tui-v1 §3.3 / safety item 3): re-read the
   * checkpoint through the public CLI immediately before a mutation.
   * A vanished checkpoint aborts `stale`; the CLI's own ref check
   * (`checkpoint_ref_missing`) remains the final authority at apply
   * time. Returns the fresh entry or null when the mutation must not
   * proceed.
   */
  private async revalidate(): Promise<CheckpointEntry | null> {
    let fresh: CheckpointEntry | null;
    try {
      const payload = await this.deps.cli(readArgs(["show", this.checkpointId]));
      fresh = asCheckpoint(payload.checkpoint);
    } catch (err) {
      const kind =
        err instanceof Error && "kind" in err ? String((err as { kind: unknown }).kind) : "";
      if (kind === "unknown_checkpoint") {
        fresh = null;
      } else {
        this.deps.ui.setStatus(`revalidate failed: ${errorLine(err)}`);
        return null;
      }
    }
    if (fresh === null) {
      this.phase = "missing";
      this.deps.ui.setStatus(`stale: checkpoint ${this.checkpointId} no longer exists`);
      this.deps.ui.invalidate();
      return null;
    }
    this.entry = fresh;
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
    const timeoutMs = options.timeoutMs ?? 120_000;
    const result = await this.deps.ui.tasks.run({ label, timeoutMs }, (signal) =>
      this.deps.cli(args, { signal, timeoutMs }),
    );
    if (result.status === "ok" && result.value !== undefined) return result.value;
    this.deps.ui.setStatus(
      result.status === "cancelled"
        ? `${label} cancelled`
        : `${label} ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
    );
    return null;
  }

  /** `p` — read-only restore plan preview. */
  private planPreview(): void {
    void (async () => {
      const payload = await this.runOp("plan", readArgs(["plan", this.checkpointId]));
      if (payload === null) return;
      this.deps.ui.push(
        new DetailView({
          title: `restore plan — ${shortId(this.checkpointId)}`,
          lines: formatPlanPayload(payload),
          onClose: () => this.deps.ui.pop(),
        }),
      );
    })();
  }

  /** `d`/`o` — diff viewer; `o` re-picks the other side first. */
  private diffView(other: string): void {
    const a = this.checkpointId;
    const b = other;
    void (async () => {
      const payload = await this.runOp("diff", readArgs(["diff", a, b]));
      if (payload === null) return;
      this.deps.ui.push(
        new CheckpointDiffView(this.deps, a, b, payload, this.entry?.repo_root ?? null),
      );
    })();
  }

  private pickOtherSide(): void {
    void (async () => {
      const repoRoot = this.entry?.repo_root ?? null;
      let candidates: CheckpointEntry[] = [];
      try {
        const payload = await this.deps.cli(readArgs(["list", "--limit", String(LIST_LIMIT)]));
        candidates = asCheckpoints(payload).filter(
          (e) => e.id !== this.checkpointId && (repoRoot === null || e.repo_root === repoRoot),
        );
      } catch {
        candidates = [];
      }
      const items: SelectItem<string>[] = [
        {
          value: "HEAD",
          label: "HEAD (current worktree HEAD)",
          detail: "diff checkpoint → HEAD",
        },
        ...candidates.map((e) => ({
          value: e.id,
          label: `${shortId(e.id)} [${checkpointKind(e)}] ${e.created_at}`,
          detail: `${e.repo_root}\ncommit ${e.commit}`,
        })),
      ];
      const chosen = await this.deps.ui.select({
        items,
        filterable: true,
        emptyText: "no other checkpoints in this repo",
      });
      if (chosen === null || chosen.value === undefined) return;
      this.diffView(chosen.value);
    })();
  }

  /** `r` — destructive restore with evacuation confirmation. */
  private restoreFlow(): void {
    const entry = this.entry;
    if (entry === null) return;
    void (async () => {
      if (!this.gate("restore")) return;
      const fresh = await this.revalidate();
      if (fresh === null) return;
      const ok = await this.deps.ui.confirm({
        title: "Restore checkpoint? (destructive)",
        target: [
          `checkpoint: ${fresh.id} [${checkpointKind(fresh)}]`,
          `repo: ${fresh.repo_root}`,
          `commit: ${fresh.commit} · branch at capture: ${fresh.branch ?? "detached"}`,
          `created: ${fresh.created_at}`,
          `target: ${formatTargetLabel(this.deps.target)}`,
        ],
        consequence:
          "rewrites the worktree+index to the checkpoint and DELETES untracked files created after it; a mandatory pre-restore checkpoint is captured first for recovery; refuses shared worktrees (>=2 live panes) and unreachable sessions",
        confirmLabel: "Restore",
        danger: true,
      });
      if (!ok) return;
      const payload = await this.runOp("restore", ["restore", fresh.id], { timeoutMs: 300_000 });
      if (payload !== null) {
        const lines = formatMutationPayload(payload);
        const autoLines = formatAutoCaptures(payload);
        if (autoLines !== null) lines.push(...autoLines);
        this.deps.ui.push(
          new DetailView({
            title: `restore ${shortId(fresh.id)}`,
            lines,
            onClose: () => this.deps.ui.pop(),
          }),
        );
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  /** `x` — delete the hidden ref + state entry. */
  private deleteFlow(): void {
    const entry = this.entry;
    if (entry === null) return;
    void (async () => {
      if (!this.gate("delete")) return;
      const fresh = await this.revalidate();
      if (fresh === null) return;
      const ok = await this.deps.ui.confirm({
        title: "Delete checkpoint?",
        target: [
          `checkpoint: ${fresh.id} [${checkpointKind(fresh)}]`,
          `repo: ${fresh.repo_root}`,
          `ref: ${fresh.ref}`,
        ],
        consequence:
          "deletes the hidden git ref and the state entry; the checkpoint objects become unrecoverable once git gc runs",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      const payload = await this.runOp("delete", ["delete", fresh.id]);
      if (payload !== null) {
        this.deps.ui.setStatus(`deleted ${shortId(fresh.id)}`);
        this.deps.onChanged?.();
        this.deps.ui.pop();
      }
    })();
  }

  /** `g` — jump to the group this checkpoint belongs to (when grouped). */
  private openGroup(): void {
    const groupId = this.entry?.group_id;
    if (groupId === undefined) {
      this.deps.ui.setStatus("checkpoint has no group_id");
      return;
    }
    this.deps.ui.push(new CheckpointGroupDetailView(this.deps, groupId));
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: "loading checkpoint…", style: { dim: true } }]);
      } else {
        const title =
          this.phase === "missing"
            ? `checkpoint not found: ${this.checkpointId}`
            : "failed to load checkpoint";
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
    const header = checkpointHeaderLines(this.entry as CheckpointEntry);
    const bodyH = Math.max(1, height - header.length - 2);
    const wrapped: string[] = [];
    for (const l of this.content) wrapped.push(...wrapText(l, Math.max(1, width - 2)));
    const maxScroll = Math.max(0, wrapped.length - bodyH);
    this.scroll = Math.min(this.scroll, maxScroll);
    const view = wrapped.slice(this.scroll, this.scroll + bodyH);
    const lines: Line[] = [];
    for (const h of header) lines.push(text(clip(h, width)));
    lines.push([{ text: "─".repeat(Math.max(0, width)), style: { dim: true } }]);
    for (const v of view) lines.push(text(clip(v, width)));
    while (lines.length < height - 1) lines.push([]);
    const pos = wrapped.length > 0 ? `${this.scroll + 1}/${wrapped.length}` : "0/0";
    lines.push([
      {
        text: clip(
          `${pos} · p plan · d diff HEAD · o diff side · r restore · x delete · g group`,
          width,
        ),
        style: { dim: true },
      },
    ]);
    return lines.slice(0, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.phase !== "ready" && this.phase !== "error" && this.phase !== "missing") {
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
    if (ev.kind !== "key" || ev.ctrl || ev.alt) {
      if (matchKey(ev, "escape") || matchKey(ev, "q")) {
        this.deps.ui.pop();
        return true;
      }
      return false;
    }
    if (this.phase !== "ready") {
      if (ev.key === "r" || ev.key === "R") {
        void this.load();
        return true;
      }
      if (matchKey(ev, "escape") || matchKey(ev, "q")) {
        this.deps.ui.pop();
        return true;
      }
      return false;
    }
    switch (ev.key) {
      case "p":
        this.planPreview();
        return true;
      case "d":
        this.diffView("HEAD");
        return true;
      case "o":
        this.pickOtherSide();
        return true;
      case "r":
        this.restoreFlow();
        return true;
      case "x":
        this.deleteFlow();
        return true;
      case "g":
        this.openGroup();
        return true;
      case "R":
        void this.load();
        return true;
      default:
        if (matchKey(ev, "escape") || matchKey(ev, "q")) {
          this.deps.ui.pop();
          return true;
        }
        return false;
    }
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      { keys: ["home", "end"], description: "top/bottom" },
      { keys: "p", description: "restore plan preview" },
      { keys: "d", description: "diff vs HEAD" },
      { keys: "o", description: "pick diff side" },
      { keys: "r", description: "restore (confirm)" },
      { keys: "x", description: "delete (confirm)" },
      { keys: "g", description: "open group" },
      { keys: "R", description: "refresh" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- diff viewer ---------------------------------------------------------------------

/**
 * Scrollable diff/patch viewer. The patch is produced by the CLI's
 * bounded `diff` (default 256 KiB cap, `truncated` reported honestly).
 * `o` re-picks the OTHER side against the same repo's checkpoints.
 */
class CheckpointDiffView extends ScrollableTextView {
  private readonly deps: CheckpointsTuiDeps;
  private readonly sideA: string;
  private sideB: string;
  private readonly repoRoot: string | null;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";

  constructor(
    deps: CheckpointsTuiDeps,
    sideA: string,
    sideB: string,
    initialPayload: Record<string, unknown> | null,
    repoRoot: string | null,
  ) {
    super(`diff ${sideA} → ${sideB}`, []);
    this.deps = deps;
    this.sideA = sideA;
    this.sideB = sideB;
    this.repoRoot = repoRoot;
    if (initialPayload !== null) {
      this.sourceLines = formatDiffPayload(initialPayload);
      this.phase = "ready";
    } else {
      void this.load();
    }
  }

  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(readArgs(["diff", this.sideA, this.sideB]));
      this.sourceLines = formatDiffPayload(payload);
      this.phase = "ready";
      this.errorText = "";
      this.titleText = `diff ${this.sideA} → ${this.sideB}`;
    } catch (err) {
      this.phase = "error";
      this.errorText = errorLine(err);
    }
    this.deps.ui.invalidate();
  }

  private pickOtherSide(): void {
    void (async () => {
      let candidates: CheckpointEntry[] = [];
      try {
        const payload = await this.deps.cli(readArgs(["list", "--limit", String(LIST_LIMIT)]));
        candidates = asCheckpoints(payload).filter(
          (e) =>
            e.id !== this.sideA &&
            e.id !== this.sideB &&
            (this.repoRoot === null || e.repo_root === this.repoRoot),
        );
      } catch {
        candidates = [];
      }
      const items: SelectItem<string>[] = [
        { value: "HEAD", label: "HEAD (current worktree HEAD)" },
        ...candidates.map((e) => ({
          value: e.id,
          label: `${shortId(e.id)} [${checkpointKind(e)}] ${e.created_at}`,
          detail: `${e.repo_root}\ncommit ${e.commit}`,
        })),
      ];
      const chosen = await this.deps.ui.select({
        items,
        filterable: true,
        emptyText: "no other checkpoints in this repo",
      });
      if (chosen === null || chosen.value === undefined) return;
      this.sideB = chosen.value;
      this.scroll = 0;
      void this.load();
    })();
  }

  protected extraKey(ev: KeyEvent): boolean {
    if (ev.kind !== "key" || ev.ctrl || ev.alt) {
      if (matchKey(ev, "escape") || matchKey(ev, "q")) {
        this.deps.ui.pop();
        return true;
      }
      return false;
    }
    if (ev.key === "o") {
      this.pickOtherSide();
      return true;
    }
    if ((ev.key === "r" || ev.key === "R") && this.phase === "error") {
      void this.load();
      return true;
    }
    if (matchKey(ev, "escape") || matchKey(ev, "q")) {
      this.deps.ui.pop();
      return true;
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    if (this.phase === "loading") {
      const lines: Line[] = [[{ text: "loading diff…", style: { dim: true } }]];
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    if (this.phase === "error") {
      const lines: Line[] = [
        [{ text: "failed to load diff", style: { bold: true, fg: "red" } }],
        ...this.errorText.split("\n").map((l) => [{ text: clip(l, width), style: { fg: "red" } }]),
        [{ text: "R — retry · esc — back", style: { dim: true } }],
      ];
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    return super.render(width, height);
  }

  override keymap(): KeyBinding[] {
    return [
      ...super.keymap(),
      { keys: "o", description: "pick other diff side" },
      { keys: ["r", "R"], description: "retry (on error)" },
    ];
  }
}

// --- groups -------------------------------------------------------------------------

interface GroupSummary {
  groupId: string;
  members: CheckpointEntry[];
  repos: string[];
  latest: string;
}

function summarizeGroups(entries: CheckpointEntry[]): GroupSummary[] {
  const byGroup = new Map<string, CheckpointEntry[]>();
  for (const e of entries) {
    if (e.group_id === undefined) continue;
    const list = byGroup.get(e.group_id) ?? [];
    list.push(e);
    byGroup.set(e.group_id, list);
  }
  return [...byGroup.entries()]
    .map(([groupId, members]) => ({
      groupId,
      members: [...members].sort((a, b) => b.created_at.localeCompare(a.created_at)),
      repos: [...new Set(members.map((m) => m.repo_root))].sort(),
      latest:
        members
          .map((m) => m.created_at)
          .sort()
          .at(-1) ?? "",
    }))
    .sort((a, b) => b.latest.localeCompare(a.latest));
}

/** Group browser: distinct `group_id`s across the whole index. */
export class CheckpointGroupListView implements ScreenView {
  private readonly deps: CheckpointsTuiDeps;
  private readonly list: SelectList<GroupSummary>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";

  constructor(deps: CheckpointsTuiDeps) {
    this.deps = deps;
    this.list = new SelectList<GroupSummary>({
      items: [],
      filterable: true,
      emptyText: "no checkpoint groups — groups come from `save`",
    });
    this.list.onSelect = (item) => {
      if (item.value)
        this.deps.ui.push(new CheckpointGroupDetailView(this.deps, item.value.groupId));
    };
    this.list.onCancel = () => this.deps.ui.pop();
    void this.load();
  }

  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(readArgs(["list", "--limit", "1000"]));
      const groups = summarizeGroups(asCheckpoints(payload));
      this.list.setItems(
        groups.map((g) => ({
          value: g,
          label: `group ${shortId(g.groupId)} — ${g.members.length} checkpoint(s) · ${g.repos.length} repo(s)`,
          detail: [
            `group: ${g.groupId}`,
            `latest: ${g.latest}`,
            ...g.repos.map((r) => `repo: ${r}`),
            ...g.members
              .slice(0, 10)
              .map((m) => `  ${m.id} [${checkpointKind(m)}] ${m.created_at}`),
            ...(g.members.length > 10 ? [`  … and ${g.members.length - 10} more`] : []),
          ].join("\n"),
        })),
      );
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
        lines.push([{ text: "loading groups…", style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load groups", style: { bold: true, fg: "red" } }]);
        for (const l of this.errorText.split("\n")) {
          lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
        }
        lines.push([{ text: "R — retry · esc — back", style: { dim: true } }]);
      }
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    return this.list.render(width, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.list.handleKey(ev) === true) return true;
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    if (ev.key === "r" || ev.key === "R") {
      void this.load();
      return true;
    }
    return false;
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "open group" },
      { keys: ["r", "R"], description: "refresh" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

/** One group's member checkpoints + `restore-group` (confirm-gated). */
export class CheckpointGroupDetailView implements ScreenView {
  private readonly deps: CheckpointsTuiDeps;
  private readonly groupId: string;
  private readonly list: SelectList<CheckpointEntry>;
  private members: CheckpointEntry[] = [];
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";

  constructor(deps: CheckpointsTuiDeps, groupId: string) {
    this.deps = deps;
    this.groupId = groupId;
    this.list = new SelectList<CheckpointEntry>({
      items: [],
      filterable: true,
      emptyText: "group has no checkpoints (deleted since save?)",
    });
    this.list.onSelect = (item) => {
      if (item.value) this.deps.ui.push(new CheckpointDetailView(this.deps, item.value.id));
    };
    this.list.onCancel = () => this.deps.ui.pop();
    void this.load();
  }

  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(
        readArgs(["list", "--group", this.groupId, "--limit", "500"]),
      );
      this.members = asCheckpoints(payload);
      this.list.setItems(this.members.map(checkpointSelectItem));
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

  /** `r` — restore every member repo (per-repo pre-restore + isolation). */
  private restoreGroup(): void {
    void (async () => {
      if (!this.gate("restore-group")) return;
      const repos = [...new Set(this.members.map((m) => m.repo_root))];
      const ok = await this.deps.ui.confirm({
        title: "Restore checkpoint group? (destructive)",
        target: [
          `group: ${this.groupId}`,
          `members: ${this.members.length} checkpoint(s) across ${repos.length} repo(s)`,
          ...repos.slice(0, 10).map((r) => `repo: ${r}`),
          ...(repos.length > 10 ? [`… and ${repos.length - 10} more repos`] : []),
        ],
        consequence:
          "restores EVERY member repo's worktree+index to its checkpoint and deletes post-checkpoint untracked files; each repo gets a mandatory pre-restore checkpoint first; per-repo failures are reported honestly (partial restore is ok:false)",
        confirmLabel: "Restore group",
        danger: true,
      });
      if (!ok) return;
      const result = await this.deps.ui.tasks.run(
        { label: `restore-group ${shortId(this.groupId)}`, timeoutMs: 600_000 },
        (signal) => this.deps.cli(["restore-group", this.groupId], { signal, timeoutMs: 600_000 }),
      );
      if (result.status === "ok" && result.value !== undefined) {
        const payload = result.value;
        const lines = formatMutationPayload(payload);
        const autoLines = formatAutoCaptures(payload);
        if (autoLines !== null) lines.push(...autoLines);
        this.deps.ui.push(
          new DetailView({
            title: `restore-group ${shortId(this.groupId)}`,
            lines,
            onClose: () => this.deps.ui.pop(),
          }),
        );
        this.deps.onChanged?.();
      } else {
        this.deps.ui.setStatus(
          result.status === "cancelled"
            ? "restore-group cancelled"
            : `restore-group ${result.status}: ${result.error ?? "unknown error"}`,
        );
      }
      await this.load();
    })();
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: `loading group ${shortId(this.groupId)}…`, style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load group", style: { bold: true, fg: "red" } }]);
        for (const l of this.errorText.split("\n")) {
          lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
        }
        lines.push([{ text: "R — retry · esc — back", style: { dim: true } }]);
      }
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    const body = this.list.render(width, Math.max(1, height - 1));
    const repos = [...new Set(this.members.map((m) => m.repo_root))];
    const header = `group ${this.groupId} — ${this.members.length} member(s) · ${repos.length} repo(s) · r restore-group`;
    return [[{ text: clip(header, width), style: { bold: true } }], ...body].slice(0, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.list.handleKey(ev) === true) return true;
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    switch (ev.key) {
      case "r":
        if (this.phase === "ready") this.restoreGroup();
        else void this.load();
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
      { keys: "enter", description: "checkpoint detail" },
      { keys: "r", description: "restore group (confirm)" },
      { keys: "R", description: "refresh" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- retention (gc / prune) -----------------------------------------------------------

type RetentionMode = "gc" | "prune";

/**
 * Retention surface. ALWAYS dry-run first (`gc --dry-run` /
 * `prune --dry-run`, read-only + `--no-drain`); `a` applies for real
 * after a confirm that shows the would-delete counts. `r` re-runs the
 * dry-run. Honest per-repo errors/unreachable render verbatim.
 */
export class CheckpointRetentionView extends ScrollableTextView {
  private readonly deps: CheckpointsTuiDeps;
  private readonly mode: RetentionMode;
  private phase: "loading" | "ready" | "error" | "applied" = "loading";
  private errorText = "";
  private payload: Record<string, unknown> | null = null;

  constructor(deps: CheckpointsTuiDeps, mode: RetentionMode) {
    super(`${mode} — dry-run`, []);
    this.deps = deps;
    this.mode = mode;
    void this.dryRun();
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
    const timeoutMs = options.timeoutMs ?? 300_000;
    const result = await this.deps.ui.tasks.run({ label, timeoutMs }, (signal) =>
      this.deps.cli(args, { signal, timeoutMs }),
    );
    if (result.status === "ok" && result.value !== undefined) return result.value;
    this.deps.ui.setStatus(
      result.status === "cancelled"
        ? `${label} cancelled`
        : `${label} ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
    );
    return null;
  }

  async dryRun(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    const payload = await this.runOp(`${this.mode} dry-run`, readArgs([this.mode, "--dry-run"]));
    if (payload !== null) {
      this.payload = payload;
      this.sourceLines = formatGcPayload(payload, this.mode);
      this.phase = "ready";
      this.errorText = "";
      this.titleText = `${this.mode} — dry-run`;
    } else {
      this.phase = "error";
      this.errorText = `${this.mode} dry-run failed — see status line`;
    }
    this.deps.ui.invalidate();
  }

  private apply(): void {
    const payload = this.payload;
    if (payload === null) return;
    const totals = asRecord(payload.totals);
    const wouldDelete =
      totals !== null && typeof totals.would_delete === "number" ? totals.would_delete : null;
    const repos = Array.isArray(payload.repos) ? payload.repos.length : null;
    void (async () => {
      if (!this.gate(this.mode)) return;
      const ok = await this.deps.ui.confirm({
        title: `${this.mode} for real?`,
        target: [
          `mode: ${this.mode} (all checkpoint repos known to state)`,
          `would delete: ${wouldDelete ?? "unknown"} entr${this.mode === "gc" ? "ies" : "ies/refs"}`,
          `repos evaluated: ${repos ?? "unknown"}`,
          `target: ${formatTargetLabel(this.deps.target)}`,
        ],
        consequence:
          this.mode === "gc"
            ? "deletes the selected checkpoint hidden refs AND their state entries; recent pre_restore checkpoints stay protected"
            : "deletes hidden refs the state index no longer references; state entries are untouched",
        confirmLabel: `Apply ${this.mode}`,
        danger: true,
      });
      if (!ok) return;
      const result = await this.runOp(this.mode, [this.mode]);
      if (result !== null) {
        this.payload = result;
        this.sourceLines = formatGcPayload(result, this.mode);
        this.phase = "applied";
        this.errorText = "";
        this.titleText = `${this.mode} — applied`;
        this.deps.onChanged?.();
      } else {
        this.phase = "error";
        this.errorText = `${this.mode} apply failed — see status line`;
      }
      this.deps.ui.invalidate();
    })();
  }

  protected extraKey(ev: KeyEvent): boolean {
    if (ev.kind !== "key" || ev.ctrl || ev.alt) {
      if (matchKey(ev, "escape") || matchKey(ev, "q")) {
        this.deps.ui.pop();
        return true;
      }
      return false;
    }
    if (ev.key === "a" && (this.phase === "ready" || this.phase === "applied")) {
      this.apply();
      return true;
    }
    if ((ev.key === "r" || ev.key === "R") && this.phase !== "loading") {
      void this.dryRun();
      return true;
    }
    if (matchKey(ev, "escape") || matchKey(ev, "q")) {
      this.deps.ui.pop();
      return true;
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    if (this.phase === "loading") {
      const lines: Line[] = [[{ text: `${this.mode} dry-run…`, style: { dim: true } }]];
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    if (this.phase === "error") {
      const lines: Line[] = [
        [{ text: `${this.mode} failed`, style: { bold: true, fg: "red" } }],
        [{ text: clip(this.errorText, width), style: { fg: "red" } }],
        [{ text: "r — retry dry-run · esc — back", style: { dim: true } }],
      ];
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    return super.render(width, height);
  }

  override keymap(): KeyBinding[] {
    return [
      ...super.keymap(),
      { keys: "a", description: "apply for real (confirm)" },
      { keys: ["r", "R"], description: "re-run dry-run" },
    ];
  }
}
