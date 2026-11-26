/**
 * Screen views for the dedicated rebuildup.projects SCRIPTS TUI
 * (`herdr-plugins.tui/v1`, ADR-0031/0032/0033, issue #241).
 *
 * This surface complements the registry browser (`tui-views.ts`):
 * it is script-first and accepts BOTH registered project ids and bare
 * repo paths, so a dev-server repo (e.g. on WSL) is drivable without
 * registering a project first. `scripts run` still requires a project
 * (contract `scripts run <project> <name>`); repo-path targets that
 * resolve to a registered project enable run, unregistered repos get
 * an honest disabled reason — never a fabricated target.
 *
 * Safety-contract mapping (same rules as tui-views.ts):
 * - read-only open: target list (`list --all`) and `scripts list` are
 *   pure reads; `scripts results`/`logs` run only on explicit user
 *   keys (r/R/l/s flows) because they lazily reconcile run records —
 *   never implicitly on open.
 * - explicit target: every mutation names project id + script + repo
 *   (+ run id for stop) resolved from the pinned context or in-UI
 *   selection; the UI pane id is never a target.
 * - stale generation: run stop re-validates pane ownership inside the
 *   CLI (`scripts stop` → `stale_pane` outcomes); a vanished project
 *   surfaces the CLI's `project_not_found`, never a silent retarget.
 * - mutation gating: `mutationAllowed` against `capability`;
 *   `scripts run`/`scripts stop` only.
 * - irreversible confirmation: run and stop show exact target +
 *   consequence; Esc cancels.
 * - honest states: `running`/`stopping`/`stop_unconfirmed`/`unknown`
 *   render verbatim with a note that the durable scrollback marker
 *   may finalize the result on the next read — nothing is invented.
 */

import path from "node:path";
import {
  clip,
  type KeyBinding,
  type KeyEvent,
  type Line,
  matchKey,
  padStartWidth,
  type ScreenView,
  type SelectItem,
  SelectList,
  text,
  wrapText,
} from "../../../packages/tui/src/index";
import type { Project } from "./state";
import { errorLine, formatTargetLabel, mutationAllowed } from "./tui-support";
import type { ProjectsTuiDeps, ProjectsTuiUi } from "./tui-views";

export type { ProjectsTuiDeps, ProjectsTuiUi };

// --- small local helpers ---------------------------------------------------------

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

function cell(value: unknown): string {
  return value === null || value === undefined ? "—" : String(value);
}

const ACTIVE_RESULTS = new Set(["running", "stopping", "stop_unconfirmed"]);

// --- paged text view ---------------------------------------------------------------

/**
 * Scrollable read-only text view (DetailView-equivalent) whose content
 * can be refreshed in place — used for run detail (re-render after
 * stop/refresh) and bounded log tails.
 */
export class PagedTextView implements ScreenView {
  private title: string;
  private source: string[];
  private scroll = 0;
  onClose: (() => void) | undefined;

  constructor(title: string, lines: readonly string[], onClose?: () => void) {
    this.title = title;
    this.source = [...lines];
    this.onClose = onClose;
  }

  setContent(title: string, lines: readonly string[]): void {
    this.title = title;
    this.source = [...lines];
    this.scroll = 0;
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
    if (matchKey(ev, "escape") || matchKey(ev, "q")) {
      this.onClose?.();
      return true;
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    const hasTitle = this.title !== "";
    const bodyH = Math.max(1, height - (hasTitle ? 3 : 1));
    const wrapped: string[] = [];
    for (const l of this.source) wrapped.push(...wrapText(l, Math.max(1, width - 2)));
    const maxScroll = Math.max(0, wrapped.length - bodyH);
    this.scroll = Math.min(this.scroll, maxScroll);
    const view = wrapped.slice(this.scroll, this.scroll + bodyH);
    const lines: Line[] = [];
    if (hasTitle) {
      lines.push([{ text: clip(this.title, width), style: { bold: true } }]);
      lines.push([{ text: "─".repeat(Math.max(0, width)), style: { dim: true } }]);
    }
    for (const v of view) lines.push(text(clip(v, width)));
    while (lines.length < height - 1) lines.push([]);
    const pos =
      wrapped.length > 0 ? `${Math.min(this.scroll + 1, wrapped.length)}/${wrapped.length}` : "0/0";
    lines.push([{ text: padStartWidth(pos, width), style: { dim: true } }]);
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

// --- target model ------------------------------------------------------------------

/**
 * What the scripts surface operates on. `listArg` is the positional for
 * `scripts list` (project id OR repo path). `repoRoot`/`projectId` are
 * the pinned execution context: `repoRoot` feeds `--repo`, `projectId`
 * is required by `scripts run` (repo-path targets resolve it lazily
 * from the `scripts list` payload's `project_id`).
 */
export interface ScriptTarget {
  listArg: string;
  /** Pinned member repo for `--repo` (project targets). */
  repoRoot: string | null;
  /** Registered project id when known up-front (project targets). */
  projectId: string | null;
  projectTitle: string | null;
  /** Member repos for display/confirm (project targets). */
  repos: { root: string; remote: string | null }[];
  /** Human label for status lines and confirm dialogs. */
  label: string;
}

/** Run-record filter for the results view (client-side repo narrowing). */
export interface RunFilter {
  projectId?: string;
  repoRoot?: string;
  label: string;
}

// --- root: target picker ------------------------------------------------------------

type TargetChoice =
  | { kind: "project"; project: Project }
  | { kind: "repo-path" }
  | { kind: "all-runs" };

function asProjects(value: unknown): Project[] {
  return Array.isArray(value)
    ? (value.filter(
        (p): p is Project =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as Project).id === "string" &&
          typeof (p as Project).title === "string",
      ) as Project[])
    : [];
}

function targetChoiceItem(choice: TargetChoice): SelectItem<TargetChoice> {
  switch (choice.kind) {
    case "project": {
      const p = choice.project;
      const badges = [p.pinned ? "pinned" : null, p.archived ? "archived" : null].filter(
        (b): b is string => b !== null,
      );
      const suffix = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
      return {
        value: choice,
        label: `${p.title} (${p.id})${suffix}`,
        detail: [
          `id: ${p.id}`,
          `repos: ${p.repos.length}`,
          ...p.repos.map((r) => `  ${r.root}${r.remote !== null ? ` ← ${r.remote}` : ""}`),
        ].join("\n"),
      };
    }
    case "repo-path":
      return {
        value: choice,
        label: "repo path…",
        detail:
          "explicit repo path — scripts list/results/logs work for any git repo; " +
          "run requires the repo to belong to a registered project",
      };
    case "all-runs":
      return {
        value: choice,
        label: "all runs",
        detail: "every recorded script run across projects (scripts results, no filter)",
      };
  }
}

/** Root view: pick a project, a bare repo path, or the unfiltered runs list. */
export class ScriptTargetView implements ScreenView {
  private readonly deps: ProjectsTuiDeps;
  private readonly list: SelectList<TargetChoice>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";

  constructor(deps: ProjectsTuiDeps) {
    this.deps = deps;
    this.list = new SelectList<TargetChoice>({
      items: [],
      filterable: true,
      emptyText: "no projects registered — use 'repo path…' for an unregistered repo",
    });
    this.list.onSelect = (item) => {
      if (item.value !== null && item.value !== undefined) void this.openTarget(item.value);
    };
    this.list.onCancel = () => void this.deps.ui.close();
    void this.load();
  }

  private async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(["list", "--all"]);
      const choices: TargetChoice[] = asProjects(payload.projects).map((project) => ({
        kind: "project",
        project,
      }));
      choices.push({ kind: "repo-path" }, { kind: "all-runs" });
      this.list.setItems(choices.map(targetChoiceItem));
      this.phase = "ready";
      this.errorText = "";
    } catch (err) {
      this.phase = "error";
      this.errorText = errorLine(err);
    }
    this.deps.ui.invalidate();
  }

  private projectTarget(project: Project, repoRoot: string | null): ScriptTarget {
    return {
      listArg: project.id,
      repoRoot,
      projectId: project.id,
      projectTitle: project.title,
      repos: project.repos,
      label: `${project.title} (${project.id})`,
    };
  }

  private async openTarget(choice: TargetChoice): Promise<void> {
    if (choice.kind === "all-runs") {
      this.deps.ui.push(new ScriptRunsView(this.deps, { label: "all runs" }));
      return;
    }
    if (choice.kind === "repo-path") {
      const hint = this.deps.target.originCwd;
      const input = await this.deps.ui.prompt(
        hint !== null ? `Repo path (origin cwd: ${hint})` : "Repo path",
        hint !== null ? { value: hint } : {},
      );
      if (input === null) return;
      const repoPath = input.trim();
      if (repoPath === "") {
        this.deps.ui.setStatus("empty repo path — cancelled");
        return;
      }
      this.deps.ui.push(
        new ScriptListView(this.deps, {
          listArg: repoPath,
          repoRoot: null,
          projectId: null,
          projectTitle: null,
          repos: [],
          label: repoPath,
        }),
      );
      return;
    }

    // project: pin the execution repo up-front (multi-repo → explicit pick).
    const project = choice.project;
    if (project.repos.length === 0) {
      this.deps.ui.setStatus(`project ${project.id} has no registered repos`);
      return;
    }
    let repoRoot: string | null = null;
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
      repoRoot = chosen.value;
    } else {
      repoRoot = project.repos[0]?.root ?? null;
    }
    this.deps.ui.push(new ScriptListView(this.deps, this.projectTarget(project, repoRoot)));
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
    if (this.phase !== "ready") {
      if (matchKey(ev, "r") || matchKey(ev, "R")) {
        void this.load();
        return true;
      }
      return false;
    }
    if (this.list.handleKey(ev) === true) return true;
    if (matchKey(ev, "R")) {
      void this.load();
      return true;
    }
    return false;
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "open scripts for target" },
      { keys: "R", description: "reload projects" },
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

// --- script list for one target ------------------------------------------------------

interface ScriptItem {
  name: string;
  id: string;
  command: string;
  source: string;
  flags: string[];
}

function scriptItemFrom(raw: Record<string, unknown>): ScriptItem {
  const flags = [
    raw.runOnWorktreeCreate === true ? "runOnWorktreeCreate" : null,
    raw.runOnSettle === true ? "runOnSettle" : null,
    raw.stopOnSettle === true ? "stopOnSettle" : null,
  ].filter((f): f is string => f !== null);
  return {
    name: str(raw.name) ?? "?",
    id: str(raw.id) ?? "?",
    command: str(raw.command) ?? "",
    source: str(raw.source) ?? "?",
    flags,
  };
}

export class ScriptListView implements ScreenView {
  private readonly deps: ProjectsTuiDeps;
  private readonly target: ScriptTarget;
  private readonly list: SelectList<ScriptItem>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";
  private repoRoot: string | null = null;
  private resolvedProjectId: string | null = null;

  constructor(deps: ProjectsTuiDeps, target: ScriptTarget) {
    this.deps = deps;
    this.target = target;
    this.list = new SelectList<ScriptItem>({
      items: [],
      filterable: true,
      emptyText: "no scripts resolved for this target",
    });
    this.list.onSelect = (item) => {
      if (item.value === null || item.value === undefined) return;
      this.deps.ui.push(
        new PagedTextView(
          `script ${item.value.name}`,
          [
            `id: ${item.value.id}`,
            `command: ${item.value.command}`,
            `source: ${item.value.source}`,
            ...(item.value.flags.length > 0 ? [`flags: ${item.value.flags.join(", ")}`] : []),
            "",
            `target: ${this.target.label}`,
            `repo: ${this.repoRoot ?? "unknown"}`,
            "",
            "x — run (confirm) · R — runs/results · esc — back",
          ],
          () => this.deps.ui.pop(),
        ),
      );
    };
    this.list.onCancel = () => this.deps.ui.pop();
    void this.load();
  }

  /** `scripts list` argv: positional target plus pinned `--repo`. */
  private listArgs(): string[] {
    const args = ["scripts", "list", this.target.listArg];
    if (this.target.repoRoot !== null) args.push("--repo", this.target.repoRoot);
    return args;
  }

  private async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    try {
      const payload = await this.deps.cli(this.listArgs());
      this.repoRoot = str(payload.repo_root) ?? this.target.repoRoot;
      this.resolvedProjectId = str(payload.project_id) ?? this.target.projectId;
      this.list.setItems(
        asArray(payload.scripts).map((s) => {
          const item = scriptItemFrom(s);
          return {
            value: item,
            label: item.name,
            detail: [
              `command: ${item.command}`,
              `source: ${item.source}${item.flags.length > 0 ? ` · ${item.flags.join(", ")}` : ""}`,
              `id: ${item.id}`,
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

  private runFilter(): RunFilter {
    return {
      ...(this.resolvedProjectId !== null ? { projectId: this.resolvedProjectId } : {}),
      ...(this.repoRoot !== null ? { repoRoot: this.repoRoot } : {}),
      label: this.target.label,
    };
  }

  /** `scripts run` — gated, confirmed, explicit project+repo. */
  private runScript(): void {
    const script = this.currentScript();
    if (script === null) return;
    void (async () => {
      const gate = mutationAllowed(this.deps.capability, "scripts run");
      if (!gate.allowed) {
        this.deps.ui.setStatus(`mutations disabled: ${gate.reason ?? "scripts run"}`);
        return;
      }
      const projectId = this.target.projectId ?? this.resolvedProjectId;
      if (projectId === null) {
        this.deps.ui.setStatus(
          "run unavailable: target is not a registered project — scripts run requires <project>",
        );
        return;
      }
      const repoRoot = this.target.repoRoot ?? this.repoRoot;
      const args = ["scripts", "run", projectId, script.name];
      if (repoRoot !== null) args.push("--repo", repoRoot);
      const ok = await this.deps.ui.confirm({
        title: `Run script "${script.name}"?`,
        target: [
          `project: ${projectId}`,
          `script: ${script.name} (${script.id})`,
          `command: ${script.command}`,
          `repo: ${repoRoot ?? "project default"}`,
          `shell: auto`,
          `target: ${formatTargetLabel(this.deps.target)}`,
        ],
        consequence:
          "executes the repo-defined command in a dedicated herdr pane (trusted repo content); " +
          "result stays 'running' until the completion marker is observed",
        confirmLabel: "Run",
      });
      if (!ok) return;
      const result = await this.deps.ui.tasks.run(
        { label: `scripts run ${script.name}`, timeoutMs: 660_000 },
        (signal) => this.deps.cli(args, { signal, timeoutMs: 660_000 }),
      );
      if (result.status === "ok" && result.value !== undefined) {
        const run = asRecord(result.value.run);
        this.deps.ui.setStatus(
          `run ${str(run?.run_id) ?? "?"} started — result: ${str(run?.result) ?? "running"} ` +
            "(running may finalize on the next results/logs read)",
        );
      } else {
        this.deps.ui.setStatus(
          `scripts run ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
        );
      }
    })();
  }

  private runsView(): void {
    this.deps.ui.push(new ScriptRunsView(this.deps, this.runFilter()));
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      lines.push([
        {
          text:
            this.phase === "loading"
              ? `loading scripts for ${this.target.label}…`
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
    if (this.phase !== "ready") {
      if (matchKey(ev, "r") || matchKey(ev, "R")) {
        void this.load();
        return true;
      }
      return false;
    }
    // Delegate first so the `/` filter keeps swallowing x/R/r while typing.
    if (this.list.handleKey(ev) === true) return true;
    if (matchKey(ev, "x")) {
      this.runScript();
      return true;
    }
    if (matchKey(ev, "R")) {
      this.runsView();
      return true;
    }
    if (matchKey(ev, "r")) {
      void this.load();
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
      { keys: "R", description: "runs/results" },
      { keys: "r", description: "reload script list" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- run records (results) -----------------------------------------------------------

function runIsActive(run: Record<string, unknown>): boolean {
  return ACTIVE_RESULTS.has(str(run.result) ?? "");
}

function runSummary(run: Record<string, unknown>): string {
  const script = asRecord(run.script) ?? {};
  return `${str(run.run_id) ?? "?"} — ${str(script.name) ?? "?"} (${str(run.result) ?? "unknown"})`;
}

function runDetailLines(run: Record<string, unknown>): string[] {
  const script = asRecord(run.script) ?? {};
  const repo = asRecord(run.repo) ?? {};
  const trigger = asRecord(run.trigger);
  const result = str(run.result) ?? "unknown";
  const lines = [
    `run: ${str(run.run_id) ?? "?"}`,
    `script: ${str(script.name) ?? "?"} (${str(script.id) ?? "?"})`,
    `command: ${str(script.command) ?? "?"}`,
    `command_line: ${str(run.command_line) ?? "?"}`,
    `result: ${result}${run.exit_code !== null && run.exit_code !== undefined ? ` · exit ${String(run.exit_code)}` : ""}`,
    `repo: ${str(repo.root) ?? "?"}${str(repo.remote) !== null ? ` ← ${str(repo.remote)}` : ""}`,
    `project: ${str(run.project_id) ?? "?"}`,
    `pane: ${str(run.pane_id) ?? "?"} · workspace: ${str(run.workspace_id) ?? "?"} · tab: ${str(run.tab_id) ?? "—"}`,
    `cwd: ${str(run.cwd) ?? "?"}`,
    `started: ${str(run.started_at) ?? "?"} · finished: ${str(run.finished_at) ?? "—"}`,
    `shell: ${str(run.shell_family) ?? "?"} (${str(run.shell_source) ?? "?"})`,
    `host: ${str(run.host) ?? "unknown"} · session_key: ${str(run.session_key) ?? "unknown"}`,
    `log_path: ${cell(run.log_path)}`,
  ];
  if (trigger !== null) {
    lines.push(
      `trigger: ${str(trigger.kind) ?? "?"}${str(trigger.worktree_path) !== null ? ` · ${str(trigger.worktree_path)}` : ""}`,
    );
  }
  if (str(run.error) !== null) lines.push(`error: ${str(run.error)}`);
  if (result === "running" || result === "stopping" || result === "stop_unconfirmed") {
    lines.push(
      "",
      "active run — the durable scrollback completion marker may finalize",
      "this result on the next results/logs read; 'running' is not final.",
    );
  }
  if (result === "unknown") {
    lines.push(
      "",
      "result unknown — pane/marker evidence was insufficient; the plugin",
      "reports this honestly rather than guessing success or failure.",
    );
  }
  return lines;
}

/** `scripts results [project]` list; select a run for detail/stop/logs. */
export class ScriptRunsView implements ScreenView {
  private readonly deps: ProjectsTuiDeps;
  private readonly filter: RunFilter;
  private readonly list: SelectList<Record<string, unknown>>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorText = "";
  private runs: Record<string, unknown>[] = [];

  constructor(deps: ProjectsTuiDeps, filter: RunFilter) {
    this.deps = deps;
    this.filter = filter;
    this.list = new SelectList<Record<string, unknown>>({
      items: [],
      filterable: true,
      emptyText: "no runs recorded",
    });
    this.list.onSelect = (item) => {
      if (item.value !== null && item.value !== undefined) {
        this.deps.ui.push(new ScriptRunView(this.deps, item.value));
      }
    };
    this.list.onCancel = () => this.deps.ui.pop();
    void this.load();
  }

  private async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    const args = ["scripts", "results"];
    if (this.filter.projectId !== undefined) args.push(this.filter.projectId);
    const result = await this.deps.ui.tasks.run(
      { label: "scripts results", timeoutMs: 60_000 },
      (signal) => this.deps.cli(args, { signal, timeoutMs: 60_000 }),
    );
    if (result.status === "ok" && result.value !== undefined) {
      let runs = asArray(result.value.runs);
      // Client-side repo narrowing: the contract filters by project only;
      // per-repo context is applied here on the returned records.
      if (this.filter.repoRoot !== undefined) {
        const wanted = path.resolve(this.filter.repoRoot);
        runs = runs.filter((r) => {
          const root = str(asRecord(r.repo)?.root);
          return root !== null && path.resolve(root) === wanted;
        });
      }
      this.runs = runs;
      this.list.setItems(
        runs.map((run) => {
          const repo = asRecord(run.repo) ?? {};
          return {
            value: run,
            label: runSummary(run),
            detail: [
              `repo: ${str(repo.root) ?? "?"}`,
              `pane: ${str(run.pane_id) ?? "?"} · started ${str(run.started_at) ?? "?"}`,
              `exit: ${cell(run.exit_code)}`,
            ].join("\n"),
          };
        }),
      );
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

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      lines.push([
        {
          text:
            this.phase === "loading"
              ? `loading runs — ${this.filter.label}…`
              : "failed to load runs",
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
    if (this.phase !== "ready") {
      if (matchKey(ev, "r") || matchKey(ev, "R")) {
        void this.load();
        return true;
      }
      return false;
    }
    if (this.list.handleKey(ev) === true) return true;
    if (matchKey(ev, "r") || matchKey(ev, "R")) {
      void this.load();
      return true;
    }
    return false;
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "run detail (stop/logs inside)" },
      { keys: "r", description: "reload runs (reconciles active records)" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- single run: detail + stop + logs -----------------------------------------------

const LOG_VIEW_MAX_LINES = 4000;

/**
 * One run record: paged detail plus `s` stop (active runs only, gated +
 * confirmed) and `l` logs. `r` re-reads via `scripts logs <run-id>`
 * (the contract's single-run read — it also reconciles the record, so
 * a `running` run that finished since last read shows its real result).
 */
export class ScriptRunView extends PagedTextView {
  private readonly deps: ProjectsTuiDeps;
  private run: Record<string, unknown>;

  constructor(deps: ProjectsTuiDeps, run: Record<string, unknown>) {
    super(`run ${str(run.run_id) ?? "?"}`, runDetailLines(run), () => deps.ui.pop());
    this.deps = deps;
    this.run = run;
  }

  private refreshContent(): void {
    this.setContent(`run ${str(this.run.run_id) ?? "?"}`, runDetailLines(this.run));
    this.deps.ui.invalidate();
  }

  private async refreshRun(): Promise<void> {
    const runId = str(this.run.run_id);
    if (runId === null) return;
    const result = await this.deps.ui.tasks.run(
      { label: `refresh run ${runId}`, timeoutMs: 60_000 },
      (signal) => this.deps.cli(["scripts", "logs", runId], { signal, timeoutMs: 60_000 }),
    );
    if (result.status === "ok" && result.value !== undefined) {
      const fresh = asRecord(result.value.run);
      if (fresh !== null) {
        const before = str(this.run.result);
        this.run = fresh;
        this.refreshContent();
        const after = str(fresh.result);
        if (before !== after) {
          this.deps.ui.setStatus(`run ${runId} result updated: ${before ?? "?"} → ${after ?? "?"}`);
        }
      }
    } else if (result.status !== "cancelled") {
      this.deps.ui.setStatus(
        `refresh ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
      );
    }
  }

  /** `scripts stop <run-id>` — gated, confirmed, ownership re-validated by the CLI. */
  private stopRun(): void {
    const runId = str(this.run.run_id);
    if (runId === null) return;
    if (!runIsActive(this.run)) {
      this.deps.ui.setStatus(
        `run ${runId} is not active (result: ${str(this.run.result) ?? "unknown"})`,
      );
      return;
    }
    void (async () => {
      const gate = mutationAllowed(this.deps.capability, "scripts stop");
      if (!gate.allowed) {
        this.deps.ui.setStatus(`mutations disabled: ${gate.reason ?? "scripts stop"}`);
        return;
      }
      const script = asRecord(this.run.script) ?? {};
      const repo = asRecord(this.run.repo) ?? {};
      const ok = await this.deps.ui.confirm({
        title: "Stop script run?",
        target: [
          `run: ${runId}`,
          `script: ${str(script.name) ?? "?"} (${str(script.id) ?? "?"})`,
          `repo: ${str(repo.root) ?? "?"}`,
          `pane: ${str(this.run.pane_id) ?? "?"} (recorded pane only — foreign panes are never touched)`,
          `current result: ${str(this.run.result) ?? "unknown"}`,
          `target: ${formatTargetLabel(this.deps.target)}`,
        ],
        consequence:
          "sends ctrl+c to the run's recorded pane and confirms exit; " +
          "unconfirmed stops are recorded as stop_unconfirmed/unknown — never faked",
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
          .map((o) => `${str(asRecord(o.run)?.run_id) ?? "?"}: ${str(o.action) ?? "?"}`)
          .join(", ");
        this.deps.ui.setStatus(`scripts stop: ${summary || "no handled outcome"}`);
        await this.refreshRun();
      } else {
        this.deps.ui.setStatus(
          `scripts stop ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
        );
      }
    })();
  }

  /** `scripts logs <run-id>` — bounded stored/captured tail, paged. */
  private logsView(): void {
    const runId = str(this.run.run_id);
    if (runId === null) return;
    void (async () => {
      const result = await this.deps.ui.tasks.run(
        { label: `scripts logs ${runId}`, timeoutMs: 60_000 },
        (signal) => this.deps.cli(["scripts", "logs", runId], { signal, timeoutMs: 60_000 }),
      );
      if (result.status !== "ok" || result.value === undefined) {
        this.deps.ui.setStatus(
          `scripts logs ${result.status}: ${result.error ?? "unknown error"}${result.partial ? " (partial)" : ""}`,
        );
        return;
      }
      const fresh = asRecord(result.value.run);
      if (fresh !== null) {
        const before = str(this.run.result);
        this.run = fresh;
        const after = str(fresh.result);
        if (before !== after) {
          this.deps.ui.setStatus(
            `run ${runId} finalized during log read: ${before ?? "?"} → ${after ?? "?"}`,
          );
        }
        this.refreshContent();
      }
      const logPath = str(result.value.log_path);
      const rawLog = result.value.log;
      const header = [
        `run: ${runId}`,
        `result: ${str(asRecord(result.value.run)?.result) ?? str(this.run.result) ?? "unknown"}`,
        `exit_code: ${cell(asRecord(result.value.run)?.exit_code)}`,
        `log_path: ${logPath ?? "—"}`,
        "",
      ];
      if (typeof rawLog !== "string" || rawLog === "") {
        header.push(
          "(no log captured — the run may still be active, or the pane",
          " scrollback was unavailable; nothing is fabricated)",
        );
        this.deps.ui.push(new PagedTextView(`logs — ${runId}`, header, () => this.deps.ui.pop()));
        return;
      }
      const all = rawLog.split("\n");
      const truncated = all.length > LOG_VIEW_MAX_LINES;
      const tail = truncated ? all.slice(-LOG_VIEW_MAX_LINES) : all;
      const lines = [
        ...header,
        ...(truncated ? [`( showing last ${LOG_VIEW_MAX_LINES} of ${all.length} lines )`, ""] : []),
        ...tail,
      ];
      this.deps.ui.push(new PagedTextView(`logs — ${runId}`, lines, () => this.deps.ui.pop()));
    })();
  }

  handleKey(ev: KeyEvent): boolean {
    if (ev.kind !== "key" || ev.ctrl || ev.alt) {
      return super.handleKey(ev);
    }
    if (matchKey(ev, "s")) {
      this.stopRun();
      return true;
    }
    if (matchKey(ev, "l")) {
      this.logsView();
      return true;
    }
    if (matchKey(ev, "r") || matchKey(ev, "R")) {
      void this.refreshRun();
      return true;
    }
    return super.handleKey(ev);
  }

  keymap(): KeyBinding[] {
    return [
      ...super.keymap(),
      ...(runIsActive(this.run)
        ? [{ keys: "s", description: "stop run (confirm)" }]
        : [{ keys: "s", description: "stop — run is not active" }]),
      { keys: "l", description: "logs (bounded tail)" },
      { keys: "r", description: "refresh run record" },
    ];
  }
}
