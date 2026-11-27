/**
 * Screen views for the rebuildup.projects TUI (`herdr-plugins.tui/v1`).
 *
 * Safety-contract mapping (ADR-0033 §3 / tui-v1 §5):
 * - read-only open: `ProjectListView.load` / `ProjectDetailView.load` run
 *   only `list`/`show`/`repos list`/`settings get`/`scripts list` —
 *   reads. No lazy trigger drain (`scripts tick` semantics) ever runs
 *   implicitly; drains stay on the explicit CLI path.
 * - explicit target: every mutation names the project id (+ repo path /
 *   script name) resolved from the pinned context or in-UI selection.
 * - stale generation: `revalidateProject` re-reads `show <id>` before
 *   every mutation; a vanished project aborts `stale`, a changed
 *   `updated_at` asks before applying.
 * - mutation gating: `mutationAllowed` against the `capability`
 *   document; denied ops render disabled-with-reason or refuse with
 *   the reason in the status line.
 * - irreversible confirmation: `ui.confirm` shows exact target +
 *   consequence for every mutation; Esc cancels.
 * - timeout/cancel: all CLI work runs inside `ui.tasks.run` (progress,
 *   Ctrl-C/Esc cancel, timeout, partial labeling).
 * - honest unsupported: CLI/socket/git failures render their real
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
} from "../../../packages/tui/src/index";
import { type Project, SETTINGS_ALLOW_LIST } from "./state";
import {
  type CapabilityDoc,
  type CliRunOptions,
  errorLine,
  formatDiscoverPayload,
  formatReposPayload,
  formatRunsPayload,
  formatTargetLabel,
  mutationAllowed,
  type PinnedTarget,
  ProjectsCliError,
  projectHeaderLines,
  projectSelectItem,
} from "./tui-support";

// --- shared deps ----------------------------------------------------------------

/** The subset of `TuiApp` the views need (TuiApp satisfies this). */
export interface ProjectsTuiUi {
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

export interface ProjectsTuiDeps {
  cli(args: readonly string[], options?: CliRunOptions): Promise<Record<string, unknown>>;
  ui: ProjectsTuiUi;
  /** `capability` payload fetched at launch; null = unavailable (fail closed). */
  capability: CapabilityDoc | null;
  target: PinnedTarget;
  /** Called after a successful mutation so ancestor views can reload. */
  onChanged?: () => void;
}

function asProject(value: unknown): Project | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== "string" || typeof p.title !== "string" || !Array.isArray(p.repos)) {
    return null;
  }
  return value as Project;
}

function asProjects(value: unknown): Project[] {
  return Array.isArray(value) ? value.map(asProject).filter((p): p is Project => p !== null) : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
}

// --- project list (root view) -----------------------------------------------------

export class ProjectListView implements ScreenView {
  private readonly deps: ProjectsTuiDeps;
  private readonly onOpen: (project: Project) => void;
  private readonly list: SelectList<Project>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";
  private includeArchived = false;
  private projects: Project[] = [];

  constructor(deps: ProjectsTuiDeps, onOpen: (project: Project) => void) {
    this.deps = deps;
    this.onOpen = onOpen;
    this.list = new SelectList<Project>({
      items: [],
      filterable: true,
      emptyText: "registry empty — n register · d discover from session",
    });
    this.list.onSelect = (item) => {
      if (item.value) this.onOpen(item.value);
    };
    this.list.onCancel = () => void this.deps.ui.close();
  }

  /** (Re)load the registry. Read-only: `list` never mutates. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(["list", ...(this.includeArchived ? ["--all"] : [])]);
      this.projects = asProjects(payload.projects);
      this.list.setItems(this.projects.map(projectSelectItem));
      this.phase = "ready";
      this.errorText = "";
    } catch (err) {
      this.phase = "error";
      this.errorText = errorLine(err);
    }
    this.deps.ui.invalidate();
  }

  private toggleArchived(): void {
    this.includeArchived = !this.includeArchived;
    this.deps.ui.setStatus(
      this.includeArchived ? "showing archived projects" : "hiding archived projects",
    );
    void this.load();
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
    if (result.status === "cancelled") {
      this.deps.ui.setStatus(`${label} cancelled`);
    } else {
      this.deps.ui.setStatus(
        `${label} ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
      );
    }
    return null;
  }

  private async registerFlow(): Promise<void> {
    if (!this.gate("register")) return;
    const hint = this.deps.target.originCwd;
    const input = await this.deps.ui.prompt(
      hint !== null ? `Repo path to register (origin cwd: ${hint})` : "Repo path to register",
      hint !== null ? { value: hint } : {},
    );
    if (input === null) return;
    const repoPath = input.trim();
    if (repoPath === "") {
      this.deps.ui.setStatus("empty repo path — cancelled");
      return;
    }
    const titleInput = await this.deps.ui.prompt("Project title (optional — Enter for default)");
    if (titleInput === null) return;
    const title = titleInput.trim();
    const ok = await this.deps.ui.confirm({
      title: "Register repo as project?",
      target: [
        `repo path: ${repoPath}`,
        ...(title !== "" ? [`title: ${title}`] : []),
        `target: ${formatTargetLabel(this.deps.target)}`,
      ],
      consequence: "adds the repo to the projects registry (plugin state)",
      confirmLabel: "Register",
    });
    if (!ok) return;
    const payload = await this.runOp("register", [
      "register",
      repoPath,
      ...(title !== "" ? ["--title", title] : []),
    ]);
    if (payload !== null) {
      const project = asProject(payload.project);
      this.deps.ui.setStatus(`registered ${project?.id ?? "?"} — ${project?.title ?? repoPath}`);
      this.deps.onChanged?.();
      await this.load();
    }
  }

  private async discoverFlow(): Promise<void> {
    // `discover` is read-only; the register step re-gates separately.
    const payload = await this.runOp("discover", ["discover"]);
    if (payload === null) return;
    const repos = asArray(payload.repos);
    if (repos.length === 0) {
      this.deps.ui.setStatus("discover: no repos found in session pane cwds");
      const detail = new DetailView({
        title: "discover",
        lines: formatDiscoverPayload(payload),
        onClose: () => this.deps.ui.pop(),
      });
      this.deps.ui.push(detail);
      return;
    }
    const items: SelectItem<Record<string, unknown>>[] = repos.map((repo) => {
      const root = typeof repo.root === "string" ? repo.root : "?";
      const owner = repo.registered_project_id;
      const registered = typeof owner === "string" && owner !== "";
      return {
        value: repo,
        label: root,
        detail: [
          `remote: ${owner === null || owner === undefined ? "none" : String(repo.remote ?? "none")}`,
          `discovered from: ${String(repo.cwd ?? "?")}`,
          registered ? `already registered → ${owner}` : "unregistered",
        ].join("\n"),
        ...(registered ? { disabled: true, disabledReason: `registered → ${owner}` } : {}),
      };
    });
    const chosen = await this.deps.ui.select({
      items,
      filterable: true,
      emptyText: "no discovered repos",
    });
    if (chosen === null || chosen.value === undefined) return;
    const repo = chosen.value;
    const root = typeof repo.root === "string" ? repo.root : null;
    if (root === null) return;
    if (!this.gate("register")) return;
    const titleInput = await this.deps.ui.prompt("Project title (optional — Enter for default)");
    if (titleInput === null) return;
    const title = titleInput.trim();
    const ok = await this.deps.ui.confirm({
      title: "Register discovered repo?",
      target: [
        `repo path: ${root}`,
        ...(title !== "" ? [`title: ${title}`] : []),
        `target: ${formatTargetLabel(this.deps.target)}`,
      ],
      consequence: "adds the repo to the projects registry (plugin state)",
      confirmLabel: "Register",
    });
    if (!ok) return;
    const payload2 = await this.runOp("register", [
      "register",
      root,
      ...(title !== "" ? ["--title", title] : []),
    ]);
    if (payload2 !== null) {
      const project = asProject(payload2.project);
      this.deps.ui.setStatus(`registered ${project?.id ?? "?"} — ${project?.title ?? root}`);
      this.deps.onChanged?.();
      await this.load();
    }
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: "loading projects…", style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load projects", style: { bold: true, fg: "red" } }]);
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
        void this.registerFlow();
        return true;
      case "d":
        void this.discoverFlow();
        return true;
      case "a":
        this.toggleArchived();
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
      { keys: "enter", description: "open project" },
      { keys: "n", description: "register repo as project" },
      { keys: "d", description: "discover repos from session" },
      { keys: "a", description: "toggle archived" },
      { keys: ["r", "R"], description: "refresh" },
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

// --- project detail ----------------------------------------------------------------

export class ProjectDetailView implements ScreenView {
  private readonly deps: ProjectsTuiDeps;
  private readonly projectId: string;
  private project: Project | null = null;
  private reposPayload: Record<string, unknown> | null = null;
  private reposError: string | null = null;
  private phase: "loading" | "ready" | "error" | "missing" = "loading";
  private errorText = "";
  private scroll = 0;

  constructor(deps: ProjectsTuiDeps, projectId: string) {
    this.deps = deps;
    this.projectId = projectId;
    void this.load();
  }

  /** Read-only load: `show` + `repos list` (live git + worktree info). */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const [showPayload, reposPayload] = await Promise.all([
        this.deps.cli(["show", this.projectId]),
        this.deps.cli(["repos", "list", this.projectId]).catch((err: unknown) => {
          this.reposError = errorLine(err);
          return null;
        }),
      ]);
      const project = asProject(showPayload.project);
      if (project === null) {
        this.phase = "error";
        this.errorText = "show returned no project payload";
      } else {
        this.project = project;
        this.reposPayload = reposPayload;
        this.phase = "ready";
        this.errorText = "";
      }
    } catch (err) {
      if (err instanceof ProjectsCliError && err.kind === "project_not_found") {
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
   * project through the public CLI immediately before a mutation. A
   * vanished project aborts; a changed `updated_at` asks the user
   * before applying to the newer state. Returns the fresh project or
   * null when the mutation must not proceed.
   */
  private async revalidate(): Promise<Project | null> {
    let fresh: Project | null;
    try {
      const payload = await this.deps.cli(["show", this.projectId]);
      fresh = asProject(payload.project);
    } catch (err) {
      if (err instanceof ProjectsCliError && err.kind === "project_not_found") {
        fresh = null;
      } else {
        this.deps.ui.setStatus(`revalidate failed: ${errorLine(err)}`);
        return null;
      }
    }
    if (fresh === null) {
      this.phase = "missing";
      this.deps.ui.setStatus(`stale: project ${this.projectId} no longer exists`);
      this.deps.ui.invalidate();
      return null;
    }
    const opened = this.project?.updated_at;
    if (opened !== undefined && fresh.updated_at !== opened) {
      const proceed = await this.deps.ui.confirm({
        title: "Project changed since this view opened",
        target: [
          `project: ${this.projectId}`,
          `updated_at was: ${opened}`,
          `updated_at now: ${fresh.updated_at}`,
        ],
        consequence:
          "the registry changed underneath this view; applying now writes to the latest state",
        confirmLabel: "Apply anyway",
        cancelLabel: "Refresh instead",
      });
      if (!proceed) {
        void this.load();
        return null;
      }
    }
    this.project = fresh;
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

  /** Shared tail for single-project mutations: gate → revalidate → op → reload. */
  private async mutate(
    command: string,
    label: string,
    buildArgs: (project: Project) => readonly string[],
    confirm?: ConfirmOptions,
  ): Promise<void> {
    if (!this.gate(command)) return;
    if (confirm !== undefined) {
      const ok = await this.deps.ui.confirm(confirm);
      if (!ok) return;
    }
    const fresh = await this.revalidate();
    if (fresh === null) return;
    const payload = await this.runOp(label, buildArgs(fresh));
    if (payload !== null) {
      this.deps.ui.setStatus(`${label} ok`);
      this.deps.onChanged?.();
      await this.load();
    }
  }

  private editTitle(): void {
    const current = this.project?.title ?? "";
    void (async () => {
      if (!this.gate("update")) return;
      const input = await this.deps.ui.prompt("New project title", { value: current });
      if (input === null) return;
      const title = input.trim();
      if (title === "" || title === current) return;
      const fresh = await this.revalidate();
      if (fresh === null) return;
      const payload = await this.runOp("update title", [
        "update",
        this.projectId,
        "--title",
        title,
      ]);
      if (payload !== null) {
        this.deps.ui.setStatus(`title updated → ${title}`);
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  private togglePin(): void {
    const pinned = this.project?.pinned === true;
    void this.mutate(
      pinned ? "unpin" : "pin",
      pinned ? "unpin" : "pin",
      (p) => [pinned ? "unpin" : "pin", p.id],
      {
        title: pinned ? "Unpin project?" : "Pin project?",
        target: [`project: ${this.projectId}`, `title: ${this.project?.title ?? "?"}`],
        consequence: pinned
          ? "removes the pin; sort order returns to title order"
          : "pins the project to the top of the list",
        confirmLabel: pinned ? "Unpin" : "Pin",
      },
    );
  }

  private toggleArchive(): void {
    const archived = this.project?.archived === true;
    void this.mutate(
      archived ? "unarchive" : "archive",
      archived ? "unarchive" : "archive",
      (p) => [archived ? "unarchive" : "archive", p.id],
      {
        title: archived ? "Unarchive project?" : "Archive project?",
        target: [`project: ${this.projectId}`, `title: ${this.project?.title ?? "?"}`],
        consequence: archived
          ? "restores the project to the active list"
          : "hides the project from the default list (repos/settings kept)",
        confirmLabel: archived ? "Unarchive" : "Archive",
      },
    );
  }

  private addRepo(): void {
    void (async () => {
      if (!this.gate("repos add")) return;
      const hint = this.deps.target.originCwd;
      const input = await this.deps.ui.prompt(
        hint !== null ? `Repo path to add (origin cwd: ${hint})` : "Repo path to add",
        hint !== null ? { value: hint } : {},
      );
      if (input === null) return;
      const repoPath = input.trim();
      if (repoPath === "") {
        this.deps.ui.setStatus("empty repo path — cancelled");
        return;
      }
      const ok = await this.deps.ui.confirm({
        title: "Add repo to project?",
        target: [`project: ${this.projectId}`, `repo path: ${repoPath}`],
        consequence: "registers the repo under this project; fails if another project owns it",
        confirmLabel: "Add",
      });
      if (!ok) return;
      const fresh = await this.revalidate();
      if (fresh === null) return;
      const payload = await this.runOp("repos add", [
        "repos",
        "add",
        this.projectId,
        "--path",
        repoPath,
      ]);
      if (payload !== null) {
        this.deps.ui.setStatus(`repo added: ${repoPath}`);
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  private removeRepo(): void {
    void (async () => {
      const project = this.project;
      if (project === null || project.repos.length === 0) {
        this.deps.ui.setStatus("project has no repos to remove");
        return;
      }
      if (!this.gate("repos remove")) return;
      const items: SelectItem<{ root: string; remote: string | null }>[] = project.repos.map(
        (r) => ({
          value: { root: r.root, remote: r.remote },
          label: r.root,
          detail: `remote: ${r.remote ?? "none"} · added ${r.added_at}`,
        }),
      );
      const chosen = await this.deps.ui.select({ items, filterable: true });
      if (chosen === null || chosen.value === undefined) return;
      const root = chosen.value.root;
      const ok = await this.deps.ui.confirm({
        title: "Remove repo from project?",
        target: [`project: ${this.projectId}`, `repo: ${root}`],
        consequence:
          "drops the repo membership; the checkout itself is untouched and the repo can be re-added",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
      const fresh = await this.revalidate();
      if (fresh === null) return;
      const payload = await this.runOp("repos remove", [
        "repos",
        "remove",
        this.projectId,
        "--path",
        root,
      ]);
      if (payload !== null) {
        this.deps.ui.setStatus(`repo removed: ${root}`);
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  private showReposDetail(): void {
    if (this.reposPayload === null) {
      this.deps.ui.setStatus(
        this.reposError !== null
          ? `repos list unavailable: ${this.reposError}`
          : "repos list still loading",
      );
      return;
    }
    this.deps.ui.push(
      new DetailView({
        title: `repos — ${this.projectId}`,
        lines: formatReposPayload(this.reposPayload),
        onClose: () => this.deps.ui.pop(),
      }),
    );
  }

  private bodyLines(): string[] {
    const lines: string[] = [];
    if (this.project !== null) {
      const p = this.project;
      lines.push(
        `project ${p.title}${p.pinned ? " · pinned" : ""}${p.archived ? " · archived" : ""}`,
      );
      for (const l of projectHeaderLines(p)) lines.push(`  ${l}`);
      lines.push("repos:");
      if (p.repos.length === 0) {
        lines.push("  (none registered)");
      }
      for (const r of p.repos) {
        lines.push(`  ${r.root}${r.remote !== null ? `  ← ${r.remote}` : ""}`);
      }
    }
    if (this.reposPayload !== null) {
      const repos = asArray(this.reposPayload.repos);
      lines.push("live repo state:");
      if (repos.length === 0) {
        lines.push("  (none)");
      }
      for (const repo of repos) {
        const wt = Array.isArray(repo.worktrees) ? repo.worktrees.length : 0;
        lines.push(
          `  ${String(repo.root)} — branch ${String(repo.branch ?? "unknown")} · dirty ${String(repo.dirty ?? "unknown")} · worktrees ${wt}`,
        );
        if (repo.worktrees_error !== null && repo.worktrees_error !== undefined) {
          const err = asRecord(repo.worktrees_error);
          lines.push(`    worktrees unavailable: ${String(err?.reason ?? "unknown")}`);
        }
      }
      const skipped = asArray(this.reposPayload.skipped);
      for (const s of skipped) {
        lines.push(`  skipped ${String(s.root)} — ${String(s.reason)}`);
      }
    } else if (this.reposError !== null) {
      lines.push(`live repo state: unavailable — ${this.reposError}`);
    }
    lines.push("");
    lines.push(
      "e edit title · p pin/unpin · c archive · a add repo · r remove repo · w repos+worktrees · s settings · j scripts · R refresh",
    );
    return lines;
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: `loading project ${this.projectId}…`, style: { dim: true } }]);
      } else if (this.phase === "missing") {
        lines.push([
          { text: `project not found: ${this.projectId}`, style: { bold: true, fg: "red" } },
        ]);
        lines.push([
          { text: "it may have been removed — go back and refresh", style: { dim: true } },
        ]);
      } else {
        lines.push([{ text: "failed to load project", style: { bold: true, fg: "red" } }]);
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
      if (i === 0 && this.project !== null) {
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
        this.editTitle();
        return true;
      case "p":
        this.togglePin();
        return true;
      case "c":
        this.toggleArchive();
        return true;
      case "a":
        this.addRepo();
        return true;
      case "r":
        this.removeRepo();
        return true;
      case "w":
        this.showReposDetail();
        return true;
      case "s":
        this.deps.ui.push(new SettingsView(this.deps, this.projectId));
        return true;
      case "j":
        this.deps.ui.push(new ScriptsView(this.deps, this.projectId));
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
      { keys: "e", description: "edit title" },
      { keys: "p", description: "pin / unpin" },
      { keys: "c", description: "archive / unarchive" },
      { keys: "a", description: "add repo (confirm)" },
      { keys: "r", description: "remove repo (confirm)" },
      { keys: "w", description: "repos + worktrees detail" },
      { keys: "s", description: "settings" },
      { keys: "j", description: "scripts" },
      { keys: "R", description: "refresh" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- settings ---------------------------------------------------------------------

interface SettingsItem {
  key: string;
  value: string | null;
}

export class SettingsView implements ScreenView {
  private readonly deps: ProjectsTuiDeps;
  private readonly projectId: string;
  private readonly list: SelectList<SettingsItem>;
  private values: Record<string, string> = {};
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";

  constructor(deps: ProjectsTuiDeps, projectId: string) {
    this.deps = deps;
    this.projectId = projectId;
    this.list = new SelectList<SettingsItem>({
      items: this.settingItems({}),
      filterable: true,
      emptyText: "no settings keys",
    });
    this.list.onSelect = (item) => {
      if (item.value) void this.edit(item.value);
    };
    this.list.onCancel = () => this.deps.ui.pop();
    void this.load();
  }

  private canWriteSettings(): boolean {
    return (
      mutationAllowed(this.deps.capability, "settings set").allowed &&
      mutationAllowed(this.deps.capability, "settings unset").allowed
    );
  }

  private settingItems(values: Record<string, string>): SelectItem<SettingsItem>[] {
    const canWrite = this.canWriteSettings();
    const reason = mutationAllowed(this.deps.capability, "settings set").reason;
    return [...SETTINGS_ALLOW_LIST].sort().map((key) => ({
      value: { key, value: values[key] ?? null },
      label: key,
      detail: `value: ${values[key] ?? "(unset)"}`,
      ...(canWrite ? {} : { disabled: true, disabledReason: reason ?? "disabled" }),
    }));
  }

  private async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(["settings", "get", this.projectId]);
      const settings = asRecord(payload.settings) ?? {};
      this.values = {};
      for (const [k, v] of Object.entries(settings)) {
        if (typeof v === "string") this.values[k] = v;
      }
      this.list.setItems(this.settingItems(this.values));
      this.phase = "ready";
      this.errorText = "";
    } catch (err) {
      this.phase = "error";
      this.errorText = errorLine(err);
    }
    this.deps.ui.invalidate();
  }

  private async edit(item: SettingsItem): Promise<void> {
    const current = this.values[item.key];
    const input = await this.deps.ui.prompt(
      `Value for ${item.key} (empty = unset)`,
      current !== undefined ? { value: current } : {},
    );
    if (input === null) return;
    const value = input.trim();
    const unsetting = value === "" && current !== undefined;
    const unchanged = value === (current ?? "");
    if (unchanged) return;
    const command = unsetting ? "settings unset" : "settings set";
    const gate2 = mutationAllowed(this.deps.capability, command);
    if (!gate2.allowed) {
      this.deps.ui.setStatus(`mutations disabled: ${gate2.reason ?? command}`);
      return;
    }
    const ok = await this.deps.ui.confirm({
      title: unsetting ? `Unset ${item.key}?` : `Set ${item.key}?`,
      target: [
        `project: ${this.projectId}`,
        `key: ${item.key}`,
        ...(unsetting ? [] : [`value: ${value}`]),
      ],
      consequence: "writes the project settings override (plugin state)",
      confirmLabel: unsetting ? "Unset" : "Set",
    });
    if (!ok) return;
    const args = unsetting
      ? (["settings", "unset", this.projectId, item.key] as const)
      : (["settings", "set", this.projectId, item.key, value] as const);
    const result = await this.deps.ui.tasks.run(
      { label: `${command} ${item.key}`, timeoutMs: 30_000 },
      (signal) => this.deps.cli(args, { signal, timeoutMs: 30_000 }),
    );
    if (result.status === "ok") {
      this.deps.ui.setStatus(`${command} ${item.key} ok`);
      this.deps.onChanged?.();
      await this.load();
    } else {
      this.deps.ui.setStatus(`${command} ${result.status}: ${result.error ?? "unknown error"}`);
    }
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      lines.push([
        {
          text:
            this.phase === "loading"
              ? `loading settings for ${this.projectId}…`
              : "failed to load settings",
          style: this.phase === "error" ? { bold: true, fg: "red" } : { dim: true },
        },
      ]);
      if (this.phase === "error") {
        for (const l of this.errorText.split("\n")) {
          lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
        }
      }
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    return this.list.render(width, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.phase !== "ready") return false;
    return this.list.handleKey(ev) === true;
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "edit value (empty = unset)" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- scripts ------------------------------------------------------------------------

interface ScriptItem {
  name: string;
  id: string;
  command: string;
  source: string;
}

export class ScriptsView implements ScreenView {
  private readonly deps: ProjectsTuiDeps;
  private readonly projectId: string;
  private readonly list: SelectList<ScriptItem>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";
  private repoRoot: string | null = null;

  constructor(deps: ProjectsTuiDeps, projectId: string) {
    this.deps = deps;
    this.projectId = projectId;
    this.list = new SelectList<ScriptItem>({
      items: [],
      filterable: true,
      emptyText: "no scripts resolved for this project",
    });
    this.list.onSelect = (item) => {
      if (item.value === null || item.value === undefined) return;
      this.deps.ui.push(
        new DetailView({
          title: `script ${item.value.name}`,
          lines: [
            `id: ${item.value.id}`,
            `command: ${item.value.command}`,
            `source: ${item.value.source}`,
            "",
            "x — run (in the scripts view)",
          ],
          onClose: () => this.deps.ui.pop(),
        }),
      );
    };
    this.list.onCancel = () => this.deps.ui.pop();
    void this.load();
  }

  private async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(["scripts", "list", this.projectId]);
      this.repoRoot = typeof payload.repo_root === "string" ? payload.repo_root : null;
      const scripts = asArray(payload.scripts);
      this.list.setItems(
        scripts.map((s) => {
          const name = String(s.name ?? "?");
          const id = String(s.id ?? "?");
          const command = String(s.command ?? "");
          const source = String(s.source ?? "?");
          const flags = [
            s.runOnWorktreeCreate === true ? "runOnWorktreeCreate" : null,
            s.runOnSettle === true ? "runOnSettle" : null,
            s.stopOnSettle === true ? "stopOnSettle" : null,
          ].filter((f): f is string => f !== null);
          return {
            value: { name, id, command, source },
            label: name,
            detail: [
              `command: ${command}`,
              `source: ${source}${flags.length > 0 ? ` · ${flags.join(", ")}` : ""}`,
            ].join("\n"),
          };
        }),
      );
      this.phase = "ready";
      this.errorText = "";
    } catch (err) {
      this.phase = "error";
      this.errorText = errorLine(err);
    }
    this.deps.ui.invalidate();
  }

  private currentScript(): ScriptItem | null {
    return this.list.current?.value ?? null;
  }

  /** `scripts run` — gated, confirmed, repo-ambiguity honest. */
  private runScript(): void {
    const script = this.currentScript();
    if (script === null) return;
    void (async () => {
      if (!mutationAllowed(this.deps.capability, "scripts run").allowed) {
        const gate = mutationAllowed(this.deps.capability, "scripts run");
        this.deps.ui.setStatus(`mutations disabled: ${gate.reason ?? "scripts run"}`);
        return;
      }
      // Multi-repo projects require an explicit --repo; never guess.
      let repoArgs: string[] = [];
      const project = await this.currentProject();
      if (project === null) return;
      if (project.repos.length > 1) {
        const chosen = await this.deps.ui.select({
          items: project.repos.map((r) => ({
            value: r.root,
            label: r.root,
            detail: `remote: ${r.remote ?? "none"}`,
          })),
          filterable: true,
        });
        if (chosen === null || chosen.value === undefined) return;
        repoArgs = ["--repo", chosen.value];
      }
      const ok = await this.deps.ui.confirm({
        title: `Run script "${script.name}"?`,
        target: [
          `project: ${this.projectId}`,
          `script: ${script.name} (${script.id})`,
          `command: ${script.command}`,
          `repo: ${this.repoRoot ?? "?"}`,
          `target: ${formatTargetLabel(this.deps.target)}`,
        ],
        consequence:
          "executes the repo-defined command in a dedicated herdr pane (trusted repo content)",
        confirmLabel: "Run",
      });
      if (!ok) return;
      const result = await this.deps.ui.tasks.run(
        { label: `scripts run ${script.name}`, timeoutMs: 660_000 },
        (signal) =>
          this.deps.cli(["scripts", "run", this.projectId, script.name, ...repoArgs], {
            signal,
            timeoutMs: 660_000,
          }),
      );
      if (result.status === "ok" && result.value !== undefined) {
        const run = asRecord(result.value.run);
        this.deps.ui.setStatus(
          `run ${String(run?.run_id ?? "?")} started — result: ${String(run?.result ?? "running")}`,
        );
      } else {
        this.deps.ui.setStatus(
          `scripts run ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
        );
      }
    })();
  }

  private async currentProject(): Promise<Project | null> {
    try {
      const payload = await this.deps.cli(["show", this.projectId]);
      return asProject(payload.project);
    } catch {
      this.deps.ui.setStatus(`stale: project ${this.projectId} no longer exists`);
      return null;
    }
  }

  /** `scripts results` + `scripts stop` surface. */
  private runsView(): void {
    void (async () => {
      const payload = await this.deps.ui.tasks.run(
        { label: "scripts results", timeoutMs: 60_000 },
        (signal) =>
          this.deps.cli(["scripts", "results", this.projectId], { signal, timeoutMs: 60_000 }),
      );
      if (payload.status !== "ok" || payload.value === undefined) {
        this.deps.ui.setStatus(
          `scripts results ${payload.status}: ${payload.error ?? "unknown error"}`,
        );
        return;
      }
      const runs = asArray(payload.value.runs);
      if (runs.length === 0) {
        this.deps.ui.push(
          new DetailView({
            title: `runs — ${this.projectId}`,
            lines: formatRunsPayload(payload.value),
            onClose: () => this.deps.ui.pop(),
          }),
        );
        return;
      }
      const items: SelectItem<Record<string, unknown>>[] = runs.map((run) => {
        const script = asRecord(run.script) ?? {};
        const active = ["running", "stopping", "stop_unconfirmed"].includes(
          String(run.result ?? ""),
        );
        return {
          value: run,
          label: `${String(run.run_id)} — ${String(script.name ?? "?")} (${String(run.result)})`,
          detail: [
            `repo: ${String(asRecord(run.repo)?.root ?? "?")}`,
            `pane: ${String(run.pane_id ?? "?")} · started ${String(run.started_at ?? "?")}`,
            `exit: ${String(run.exit_code ?? "—")} · trigger: ${String(asRecord(run.trigger)?.kind ?? "manual")}`,
          ].join("\n"),
          ...(active ? {} : { disabled: true, disabledReason: "not running" }),
        };
      });
      const chosen = await this.deps.ui.select({ items, filterable: true });
      if (chosen === null || chosen.value === undefined) return;
      const run = chosen.value;
      const runId = String(run.run_id ?? "");
      if (runId === "") return;
      if (!mutationAllowed(this.deps.capability, "scripts stop").allowed) {
        const gate = mutationAllowed(this.deps.capability, "scripts stop");
        this.deps.ui.setStatus(`mutations disabled: ${gate.reason ?? "scripts stop"}`);
        return;
      }
      const ok = await this.deps.ui.confirm({
        title: "Stop script run?",
        target: [
          `run: ${runId}`,
          `script: ${String(asRecord(run.script)?.name ?? "?")}`,
          `pane: ${String(run.pane_id ?? "?")}`,
        ],
        consequence:
          "sends ctrl+c to the run's dedicated pane and confirms exit; unconfirmed stops are reported honestly",
        confirmLabel: "Stop",
        danger: true,
      });
      if (!ok) return;
      const result = await this.deps.ui.tasks.run(
        { label: `scripts stop ${runId}`, timeoutMs: 60_000 },
        (signal) => this.deps.cli(["scripts", "stop", runId], { signal, timeoutMs: 60_000 }),
      );
      if (result.status === "ok" && result.value !== undefined) {
        const outcomes = asArray(result.value.outcomes);
        const summary = outcomes
          .map((o) => `${String(asRecord(o.run)?.run_id ?? "?")}: ${String(o.action)}`)
          .join(", ");
        this.deps.ui.setStatus(`scripts stop: ${summary || "no handled outcome"}`);
      } else {
        this.deps.ui.setStatus(`scripts stop ${result.status}: ${result.error ?? "unknown error"}`);
      }
    })();
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      lines.push([
        {
          text:
            this.phase === "loading"
              ? `loading scripts for ${this.projectId}…`
              : "failed to load scripts",
          style: this.phase === "error" ? { bold: true, fg: "red" } : { dim: true },
        },
      ]);
      if (this.phase === "error") {
        for (const l of this.errorText.split("\n")) {
          lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
        }
      }
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    return this.list.render(width, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.phase !== "ready") return false;
    // Delegate first so the `/` filter keeps swallowing x/R while typing.
    if (this.list.handleKey(ev) === true) return true;
    if (matchKey(ev, "x")) {
      this.runScript();
      return true;
    }
    if (matchKey(ev, "R")) {
      this.runsView();
      return true;
    }
    return false;
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "script detail" },
      { keys: "x", description: "run selected script (confirm)" },
      { keys: "R", description: "runs + stop" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}
