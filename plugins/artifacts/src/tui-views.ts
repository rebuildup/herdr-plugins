/**
 * Screen views for the rebuildup.artifacts TUI (`herdr-plugins.tui/v1`,
 * issue #247).
 *
 * Safety-contract mapping (ADR-0033 §3 / tui-v1 §5):
 * - read-only open: `ArtifactListView.load` / `ArtifactDetailView.load`
 *   run only `list`/`get` — reads. No lazy drain ever runs on open.
 * - explicit target: mutations name the artifact id (+ pane for
 *   deliver) resolved from pinned context or in-UI selection.
 * - stale generation: `revalidate` re-reads `get <id>` before delete/
 *   deliver and compares sha256/created_at/resolved_path; a vanished or
 *   changed artifact aborts `stale`, never silently retargets.
 * - mutation gating: `mutationAllowed` against the `capability`
 *   document; denied ops render disabled-with-reason or refuse with
 *   the reason in the status line.
 * - irreversible confirmation: `ui.confirm` shows exact target +
 *   consequence for register/delete/deliver/gc; delete of a referenced
 *   artifact requires a second explicit force confirm; gc defaults to
 *   dry-run preview before any collection. Esc cancels.
 * - terminal preview: metadata + resolved path only — the plugin never
 *   renders payload bytes (ADR-0024); html/image/pdf get an explicit
 *   "open externally" affordance, never an implied browser.
 * - timeout/cancel: all CLI work runs inside `ui.tasks.run`.
 * - honest unsupported: CLI/socket failures render their real
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
  type OpenExternalResult,
  type ScreenView,
  type SelectItem,
  SelectList,
  type SelectListOptions,
  type TaskRunner,
  type TextInputOptions,
} from "../../../packages/tui/src/index";
import {
  ArtifactsCliError,
  type ArtifactView,
  artifactHeaderLines,
  artifactSelectItem,
  asArtifact,
  type CapabilityDoc,
  type CliRunOptions,
  errorLine,
  formatDeliverResult,
  formatGcPayload,
  formatIndexMeta,
  formatTargetLabel,
  formatVerifyPayload,
  mutationAllowed,
  type PinnedTarget,
} from "./tui-support";

// --- shared deps ----------------------------------------------------------------

/** The subset of `TuiApp` the views need (TuiApp satisfies this). */
export interface ArtifactsTuiUi {
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

export interface ArtifactsTuiDeps {
  cli(args: readonly string[], options?: CliRunOptions): Promise<Record<string, unknown>>;
  ui: ArtifactsTuiUi;
  /** `capability` payload fetched at launch; null = unavailable (fail closed). */
  capability: CapabilityDoc | null;
  target: PinnedTarget;
  /** Called after a successful mutation so ancestor views can reload. */
  onChanged?: () => void;
  /**
   * Explicit external-open action (tui-v1 §5.8): only ever invoked from
   * a dedicated keypress, never implicitly. Defaults to the safety
   * helper's `openExternal`; injectable for tests.
   */
  openPath?: (target: string) => Promise<OpenExternalResult>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
}

const KIND_CHOICES = ["auto", "html", "image", "pdf", "file", "other"] as const;
const STORAGE_CHOICES = ["state_copy", "path_ref"] as const;

// --- artifact list (root view) ---------------------------------------------------

export class ArtifactListView implements ScreenView {
  private readonly deps: ArtifactsTuiDeps;
  private readonly onOpen: (artifact: ArtifactView) => void;
  private readonly list: SelectList<ArtifactView>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";
  private artifacts: ArtifactView[] = [];
  private metaLines: string[] = [];
  private searchQuery: string | null = null;

  constructor(deps: ArtifactsTuiDeps, onOpen: (artifact: ArtifactView) => void) {
    this.deps = deps;
    this.onOpen = onOpen;
    this.list = new SelectList<ArtifactView>({
      items: [],
      filterable: true,
      emptyText: "registry empty — n register an artifact",
    });
    this.list.onSelect = (item) => {
      if (item.value) this.onOpen(item.value);
    };
    this.list.onCancel = () => void this.deps.ui.close();
  }

  /** (Re)load the index. Read-only: `list` never mutates. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(["list", "--limit", "0"]);
      this.artifacts = asArray(payload.artifacts)
        .map((a) => asArtifact(a))
        .filter((a): a is ArtifactView => a !== null);
      this.metaLines = formatIndexMeta(payload);
      this.searchQuery = null;
      this.list.setItems(this.artifacts.map(artifactSelectItem));
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

  /**
   * Like `runOp` but preserves the structured CLI error so callers can
   * branch on `kind` (e.g. `referenced` → force-delete confirmation).
   */
  private async runOpDetailed(
    label: string,
    args: readonly string[],
    options: { timeoutMs?: number; silentError?: boolean } = {},
  ): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: unknown }> {
    const result = await this.deps.ui.tasks.run(
      { label, timeoutMs: options.timeoutMs ?? 120_000 },
      async (signal) => {
        try {
          return {
            ok: true as const,
            value: await this.deps.cli(args, {
              signal,
              timeoutMs: options.timeoutMs ?? 120_000,
            }),
          };
        } catch (err) {
          return { ok: false as const, error: err };
        }
      },
    );
    if (result.status === "ok" && result.value !== undefined) {
      const wrapper = result.value;
      if (wrapper.ok) return wrapper;
      if (options.silentError !== true) {
        this.deps.ui.setStatus(`${label} failed: ${errorLine(wrapper.error)}`);
      }
      return wrapper;
    }
    const error =
      result.status === "cancelled"
        ? new ArtifactsCliError("cancelled", "cancelled", undefined, 130)
        : new ArtifactsCliError(
            `${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
            result.status,
          );
    this.deps.ui.setStatus(
      result.status === "cancelled"
        ? `${label} cancelled`
        : `${label} ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
    );
    return { ok: false, error };
  }

  /** Run a CLI op inside the task runner; returns payload or null. */
  private async runOp(
    label: string,
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown> | null> {
    const result = await this.runOpDetailed(label, args, options);
    return result.ok ? result.value : null;
  }

  private async searchFlow(): Promise<void> {
    const query = await this.deps.ui.prompt("Search artifacts (title/kind/path/id; empty = list)");
    if (query === null) return;
    const q = query.trim();
    if (q === "") {
      await this.load();
      return;
    }
    const result = await this.runOp("search", ["search", q, "--limit", "0"]);
    if (result === null) {
      this.phase = "ready";
      this.deps.ui.invalidate();
      return;
    }
    this.artifacts = asArray(result.artifacts)
      .map((a) => asArtifact(a))
      .filter((a): a is ArtifactView => a !== null);
    this.metaLines = [
      `search "${q}" — ${fmtCount(result.total)} match(es)`,
      ...formatIndexMeta(result),
    ];
    this.searchQuery = q;
    this.list.setItems(this.artifacts.map(artifactSelectItem));
    this.phase = "ready";
    this.deps.ui.invalidate();
  }

  private async registerFlow(): Promise<void> {
    if (!this.gate("register")) return;
    const pathInput = await this.deps.ui.prompt("File path to register");
    if (pathInput === null) return;
    const sourcePath = pathInput.trim();
    if (sourcePath === "") {
      this.deps.ui.setStatus("empty path — cancelled");
      return;
    }
    const kindChoice = await this.deps.ui.select<string>({
      items: KIND_CHOICES.map((k) => ({
        value: k,
        label: k,
        detail: k === "auto" ? "detect kind from extension + mime sniff" : `register as kind=${k}`,
      })),
    });
    if (kindChoice === null || kindChoice.value === undefined) return;
    const storageChoice = await this.deps.ui.select<string>({
      items: STORAGE_CHOICES.map((s) => ({
        value: s,
        label: s,
        detail:
          s === "state_copy"
            ? "copy payload into plugin state (default, size-capped)"
            : "reference the file in place; index entry only, external file never managed",
      })),
    });
    if (storageChoice === null || storageChoice.value === undefined) return;
    const titleInput = await this.deps.ui.prompt("Title (optional — Enter for none)");
    if (titleInput === null) return;
    const title = titleInput.trim();
    const refsInput = await this.deps.ui.prompt("Refs (optional, comma-separated back-references)");
    if (refsInput === null) return;
    const refs = refsInput
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r !== "");

    const args: string[] = ["register", "--path", sourcePath];
    if (kindChoice.value !== "auto") args.push("--kind", kindChoice.value);
    args.push("--storage", storageChoice.value);
    if (title !== "") args.push("--title", title);
    args.push("--created-by", "cli");
    for (const ref of refs) args.push("--ref", ref);

    const ok = await this.deps.ui.confirm({
      title: "Register artifact?",
      target: [
        `path: ${sourcePath}`,
        `kind: ${kindChoice.value} · storage: ${storageChoice.value}`,
        ...(title !== "" ? [`title: ${title}`] : []),
        ...(refs.length > 0 ? [`refs: ${refs.join(", ")}`] : []),
        `target: ${formatTargetLabel(this.deps.target)}`,
      ],
      consequence:
        "copies or references the file into the artifact registry (plugin state); content is never rendered",
      confirmLabel: "Register",
    });
    if (!ok) return;
    const payload = await this.runOp("register", args);
    if (payload !== null) {
      const artifact = asArtifact(payload.artifact);
      this.deps.ui.setStatus(
        `registered ${artifact?.artifact_id ?? "?"} — ${artifact?.kind ?? "?"}`,
      );
      this.deps.onChanged?.();
      await this.load();
    }
  }

  private async verifyAllFlow(): Promise<void> {
    const payload = await this.runOp("verify", ["verify"], { timeoutMs: 300_000 });
    if (payload === null) return;
    this.deps.ui.push(
      new DetailView({
        title: "verify — integrity check",
        lines: formatVerifyPayload(payload),
        onClose: () => this.deps.ui.pop(),
      }),
    );
  }

  private async gcFlow(): Promise<void> {
    if (!this.gate("gc")) return;
    const input = await this.deps.ui.prompt(
      "GC artifacts older than (ISO-8601, e.g. 2026-01-01T00:00:00Z)",
    );
    if (input === null) return;
    const olderThan = input.trim();
    if (Number.isNaN(Date.parse(olderThan))) {
      this.deps.ui.setStatus("invalid ISO-8601 timestamp — gc cancelled");
      return;
    }
    // Step 1 (mandatory): dry-run preview. gc is pure plugin-state work.
    const preview = await this.runOp("gc dry-run", ["gc", "--older-than", olderThan, "--dry-run"]);
    if (preview === null) return;
    const totals = asRecord(preview.totals);
    const wouldDelete = typeof totals?.would_delete === "number" ? totals.would_delete : 0;
    const skippedRef =
      typeof totals?.skipped_referenced === "number" ? totals.skipped_referenced : 0;
    this.deps.ui.push(
      new DetailView({
        title: `gc dry-run — older than ${olderThan}`,
        lines: formatGcPayload(preview),
        onClose: () => this.deps.ui.pop(),
      }),
    );
    if (wouldDelete === 0) {
      this.deps.ui.setStatus("gc: nothing to collect");
      return;
    }
    // Step 2: explicit confirm, then the real run (no --dry-run).
    const ok = await this.deps.ui.confirm({
      title: "Collect expired artifacts?",
      target: [
        `policy: created_at < ${olderThan}`,
        `would delete: ${wouldDelete} record(s)`,
        `skipped (referenced): ${skippedRef}`,
      ],
      consequence:
        "deletes index records and state_copy payloads; path_ref external files are never touched; referenced artifacts are skipped",
      confirmLabel: "Collect",
      danger: true,
    });
    if (!ok) return;
    const result = await this.runOp("gc", ["gc", "--older-than", olderThan]);
    if (result !== null) {
      this.deps.ui.push(
        new DetailView({
          title: `gc applied — older than ${olderThan}`,
          lines: formatGcPayload(result),
          onClose: () => this.deps.ui.pop(),
        }),
      );
      this.deps.onChanged?.();
      await this.load();
    }
  }

  render(width: number, height: number): Line[] {
    const header =
      this.searchQuery !== null
        ? [`search "${this.searchQuery}"`, ...this.metaLines]
        : this.metaLines;
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: "loading artifacts…", style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load artifacts", style: { bold: true, fg: "red" } }]);
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
    // The inner list consumes navigation/enter/filter/q/esc first; while
    // its `/` filter is active it swallows every key, so extra bindings
    // below can never hijack filter typing.
    if (this.list.handleKey(ev) === true) return true;
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    switch (ev.key) {
      case "s":
        void this.searchFlow();
        return true;
      case "n":
        void this.registerFlow();
        return true;
      case "g":
        void this.gcFlow();
        return true;
      case "v":
        void this.verifyAllFlow();
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
      { keys: "enter", description: "open artifact" },
      { keys: "s", description: "search (server-side)" },
      { keys: "n", description: "register artifact (confirm)" },
      { keys: "v", description: "verify all (integrity)" },
      { keys: "g", description: "gc expired (dry-run first)" },
      { keys: ["r", "R"], description: "refresh" },
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

function fmtCount(value: unknown): string {
  return typeof value === "number" ? String(value) : "?";
}

// --- artifact detail ----------------------------------------------------------------

export class ArtifactDetailView implements ScreenView {
  private readonly deps: ArtifactsTuiDeps;
  private readonly artifactId: string;
  private artifact: ArtifactView | null = null;
  private phase: "loading" | "ready" | "error" | "missing" = "loading";
  private errorText = "";
  private scroll = 0;

  constructor(deps: ArtifactsTuiDeps, artifactId: string, initial?: ArtifactView) {
    this.deps = deps;
    this.artifactId = artifactId;
    if (initial !== undefined) {
      this.artifact = initial;
      this.phase = "ready";
    }
    void this.load();
  }

  /** Read-only load: `get <id>` — metadata only, never payload bytes. */
  async load(): Promise<void> {
    if (this.phase === "ready" && this.artifact !== null) {
      // Keep showing the last good record while re-reading.
    } else {
      this.phase = "loading";
    }
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(["get", this.artifactId]);
      const artifact = asArtifact(payload.artifact);
      if (artifact === null) {
        this.phase = "error";
        this.errorText = "get returned no artifact payload";
      } else {
        this.artifact = artifact;
        this.phase = "ready";
        this.errorText = "";
      }
    } catch (err) {
      if (err instanceof ArtifactsCliError && err.kind === "artifact_not_found") {
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
   * artifact through the public CLI immediately before a mutation. A
   * vanished artifact aborts; a changed sha256/created_at/path asks
   * the user before applying to the newer state.
   */
  private async revalidate(): Promise<ArtifactView | null> {
    let fresh: ArtifactView | null;
    try {
      const payload = await this.deps.cli(["get", this.artifactId]);
      fresh = asArtifact(payload.artifact);
    } catch (err) {
      if (err instanceof ArtifactsCliError && err.kind === "artifact_not_found") {
        fresh = null;
      } else {
        this.deps.ui.setStatus(`revalidate failed: ${errorLine(err)}`);
        return null;
      }
    }
    if (fresh === null) {
      this.phase = "missing";
      this.deps.ui.setStatus(`stale: artifact ${this.artifactId} no longer exists`);
      this.deps.ui.invalidate();
      return null;
    }
    const opened = this.artifact;
    if (
      opened !== null &&
      (fresh.sha256 !== opened.sha256 ||
        fresh.created_at !== opened.created_at ||
        fresh.resolved_path !== opened.resolved_path)
    ) {
      const proceed = await this.deps.ui.confirm({
        title: "Artifact changed since this view opened",
        target: [
          `artifact: ${this.artifactId}`,
          `sha256 was: ${opened.sha256}`,
          `sha256 now: ${fresh.sha256}`,
          `path was: ${opened.resolved_path}`,
          `path now: ${fresh.resolved_path}`,
        ],
        consequence:
          "the registry record changed underneath this view; applying now writes to the latest state",
        confirmLabel: "Apply anyway",
        cancelLabel: "Refresh instead",
      });
      if (!proceed) {
        void this.load();
        return null;
      }
    }
    this.artifact = fresh;
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

  /**
   * Like `runOp` but preserves the structured CLI error so callers can
   * branch on `kind` (e.g. `referenced` → force-delete confirmation).
   */
  private async runOpDetailed(
    label: string,
    args: readonly string[],
    options: { timeoutMs?: number; silentError?: boolean } = {},
  ): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: unknown }> {
    const result = await this.deps.ui.tasks.run(
      { label, timeoutMs: options.timeoutMs ?? 120_000 },
      async (signal) => {
        try {
          return {
            ok: true as const,
            value: await this.deps.cli(args, {
              signal,
              timeoutMs: options.timeoutMs ?? 120_000,
            }),
          };
        } catch (err) {
          return { ok: false as const, error: err };
        }
      },
    );
    if (result.status === "ok" && result.value !== undefined) {
      const wrapper = result.value;
      if (wrapper.ok) return wrapper;
      if (options.silentError !== true) {
        this.deps.ui.setStatus(`${label} failed: ${errorLine(wrapper.error)}`);
      }
      return wrapper;
    }
    const error =
      result.status === "cancelled"
        ? new ArtifactsCliError("cancelled", "cancelled", undefined, 130)
        : new ArtifactsCliError(
            `${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
            result.status,
          );
    this.deps.ui.setStatus(
      result.status === "cancelled"
        ? `${label} cancelled`
        : `${label} ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
    );
    return { ok: false, error };
  }

  private async runOp(
    label: string,
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown> | null> {
    const result = await this.runOpDetailed(label, args, options);
    return result.ok ? result.value : null;
  }

  private deleteArtifact(): void {
    const artifact = this.artifact;
    if (artifact === null) return;
    void (async () => {
      if (!this.gate("delete")) return;
      const referenced = artifact.refs.length > 0;
      const ok = await this.deps.ui.confirm({
        title: "Delete artifact?",
        target: [
          `artifact: ${artifact.artifact_id}`,
          `kind: ${artifact.kind} · ${artifact.mime} · ${artifact.resolved_path}`,
          `storage: ${artifact.storage_mode}${referenced ? ` · refs: ${artifact.refs.length}` : ""}`,
        ],
        consequence: referenced
          ? "attempts removal; a referenced artifact is refused unless a second explicit force confirmation is given; state_copy payload is deleted, path_ref external file is untouched"
          : "removes the index record and the state_copy payload; path_ref external file is never touched",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      const fresh = await this.revalidate();
      if (fresh === null) return;
      // Try the honest path first: the CLI refuses referenced records
      // unless --force. A `referenced` refusal earns a second, explicit
      // force confirmation — never a silent escalation.
      const first = await this.runOpDetailed("delete", ["delete", fresh.artifact_id], {
        silentError: true,
      });
      if (first.ok) {
        this.deps.ui.setStatus(`deleted ${fresh.artifact_id}`);
        this.deps.onChanged?.();
        await this.load();
        return;
      }
      const err = first.error;
      const kind = err instanceof ArtifactsCliError ? err.kind : "";
      if (kind === "referenced") {
        const refCount = fresh.refs.length;
        const force = await this.deps.ui.confirm({
          title: "Artifact is referenced — force delete?",
          target: [
            `artifact: ${fresh.artifact_id}`,
            `refs: ${refCount}`,
            `path: ${fresh.resolved_path}`,
          ],
          consequence:
            "permanently removes the index record and state_copy payload even though back-references exist; this cannot be undone",
          confirmLabel: "Force delete",
          danger: true,
        });
        if (!force) {
          this.deps.ui.setStatus("delete cancelled — artifact kept");
          return;
        }
        const second = await this.runOpDetailed(
          "delete --force",
          ["delete", fresh.artifact_id, "--force"],
          { silentError: true },
        );
        if (second.ok) {
          this.deps.ui.setStatus(`deleted ${fresh.artifact_id} (forced)`);
          this.deps.onChanged?.();
          await this.load();
        } else {
          this.deps.ui.setStatus(`delete --force failed: ${errorLine(second.error)}`);
        }
        return;
      }
      this.deps.ui.setStatus(`delete failed: ${errorLine(err)}`);
    })();
  }

  private async deliverArtifact(): Promise<void> {
    const artifact = this.artifact;
    if (artifact === null) return;
    if (!this.gate("deliver")) return;
    if (artifact.missing_ref) {
      this.deps.ui.setStatus("deliver refused locally: payload missing (missing_ref)");
      return;
    }
    const kindChoice = await this.deps.ui.select<string>({
      items: [
        {
          value: "agent",
          label: "agent",
          detail: "agent.prompt — pane hosting a live agent",
        },
        {
          value: "pane",
          label: "pane",
          detail: "pane.send_text — literal text to any pane",
        },
      ],
    });
    if (kindChoice === null || kindChoice.value === undefined) return;
    const pinned = this.deps.target.originPaneId;
    let paneId = pinned;
    if (paneId === null) {
      const input = await this.deps.ui.prompt("Target pane id");
      if (input === null) return;
      paneId = input.trim();
      if (paneId === "") {
        this.deps.ui.setStatus("empty pane id — cancelled");
        return;
      }
    } else {
      const use = await this.deps.ui.confirm({
        title: "Use pinned origin pane as delivery target?",
        target: [`pane: ${paneId}`, `artifact: ${artifact.artifact_id}`],
        consequence: "the artifact path text is sent to this pane",
        confirmLabel: "Use pane",
        cancelLabel: "Pick another",
      });
      if (!use) {
        const input = await this.deps.ui.prompt("Target pane id", { value: paneId });
        if (input === null) return;
        paneId = input.trim();
        if (paneId === "") {
          this.deps.ui.setStatus("empty pane id — cancelled");
          return;
        }
      }
    }
    const noteInput = await this.deps.ui.prompt("Note (optional — Enter for none)");
    if (noteInput === null) return;
    const note = noteInput.trim();

    const ok = await this.deps.ui.confirm({
      title: "Deliver artifact reference?",
      target: [
        `artifact: ${artifact.artifact_id} (${artifact.kind})`,
        `target: ${kindChoice.value} pane ${paneId}`,
        `path sent: ${artifact.resolved_path}`,
        ...(note !== "" ? [`note: ${note}`] : []),
      ],
      consequence:
        "sends the artifact's stable path inside agent.prompt/pane.send_text text to the target pane — the pane's agent/user sees a path reference, not payload bytes",
      confirmLabel: "Deliver",
    });
    if (!ok) return;
    const fresh = await this.revalidate();
    if (fresh === null) return;
    const args: string[] = [
      "deliver",
      fresh.artifact_id,
      kindChoice.value === "agent" ? "--agent" : "--pane",
      paneId,
    ];
    if (note !== "") args.push("--note", note);
    const payload = await this.runOp("deliver", args);
    if (payload !== null) {
      this.deps.ui.push(
        new DetailView({
          title: `deliver — ${fresh.artifact_id}`,
          lines: formatDeliverResult(payload),
          onClose: () => this.deps.ui.pop(),
        }),
      );
    }
  }

  private verifyArtifact(): void {
    void (async () => {
      // `verify` is a read (integrity re-check) — not in mutation_commands,
      // so no mutation gate applies.
      const payload = await this.runOp("verify", ["verify", this.artifactId], {
        timeoutMs: 120_000,
      });
      if (payload !== null) {
        this.deps.ui.push(
          new DetailView({
            title: `verify — ${this.artifactId}`,
            lines: formatVerifyPayload(payload),
            onClose: () => this.deps.ui.pop(),
          }),
        );
      }
    })();
  }

  private async openExternal(): Promise<void> {
    const artifact = this.artifact;
    if (artifact === null) return;
    if (artifact.missing_ref) {
      this.deps.ui.setStatus("open externally refused: payload missing (missing_ref)");
      return;
    }
    const opener =
      this.deps.openPath ??
      (async (target: string) => {
        const { openExternal } = await import("../../../packages/tui/src/index");
        return openExternal(target);
      });
    const result = await opener(artifact.resolved_path);
    this.deps.ui.setStatus(
      result.ok
        ? `opened externally: ${artifact.resolved_path}`
        : `open externally failed (${result.reason}): ${artifact.resolved_path}`,
    );
  }

  private bodyLines(): string[] {
    if (this.artifact === null) return [];
    return artifactHeaderLines(this.artifact);
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: `loading artifact ${this.artifactId}…`, style: { dim: true } }]);
      } else if (this.phase === "missing") {
        lines.push([
          { text: `artifact not found: ${this.artifactId}`, style: { bold: true, fg: "red" } },
        ]);
        lines.push([
          { text: "it may have been deleted — go back and refresh", style: { dim: true } },
        ]);
      } else {
        lines.push([{ text: "failed to load artifact", style: { bold: true, fg: "red" } }]);
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
      // crude wrap: split long lines so nothing is silently dropped
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
      if (i === 0 && this.artifact !== null) {
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
      case "d":
        this.deleteArtifact();
        return true;
      case "l":
        void this.deliverArtifact();
        return true;
      case "v":
        this.verifyArtifact();
        return true;
      case "o":
        void this.openExternal();
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
      { keys: "d", description: "delete (confirm; force needs 2nd confirm)" },
      { keys: "l", description: "deliver path reference (confirm)" },
      { keys: "v", description: "verify integrity" },
      { keys: "o", description: "open externally (OS handler)" },
      { keys: "R", description: "refresh" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}
