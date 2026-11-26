/**
 * rebuildup.git interactive TUI (`src/tui.ts` entrypoint, `main`).
 *
 * Surface per `docs/contracts/tui-v1.md` + ADR-0031/0033:
 * - target identity pinned at launch (origin pane/cwd + repo root + HEAD
 *   sha); `HERDR_PANE_ID` is never used as the git target (it is the UI
 *   pane itself, tui-v1 §3.2);
 * - read-only open: the home view performs reads only;
 * - every mutation revalidates pane→cwd→repo-root and HEAD sha first —
 *   a moved HEAD or re-rooted pane aborts with a stale_target state and
 *   a refresh affordance, never a silent retarget (tui-v1 §3.3);
 * - mutations (stage/unstage/commit/push/fetch/branch ops) go through
 *   ConfirmView with the exact target + consequence; bulk stage/unstage
 *   and push are always confirmed;
 * - long ops run through TaskRunner (progress/cancel/timeout);
 * - honest states for not-a-repo / bare / detached / unborn / no
 *   upstream / missing remote — never fabricated success.
 *
 * Forge surfaces (PR/Issue) are intentionally absent — separate ticket
 * (#239). All git access goes through ../git collectors (argv spawn,
 * sanitized env, timeouts) — the same primitives the CLI uses.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import {
  type CallOptions,
  type SessionSnapshot,
  sessionSnapshot,
} from "../../../../packages/herdr-client/src/index";
import {
  clip,
  hr,
  type KeyBinding,
  type KeyEvent,
  type Line,
  matchKey,
  type ScreenView,
  type SelectItem,
  SelectList,
  TuiApp,
  text,
} from "../../../../packages/tui/src/index";
import { displayWidth } from "../../../../packages/tui/src/unicode";
import {
  collectBranchCreate,
  collectBranchSwitch,
  collectCommit,
  collectCompare,
  collectDiff,
  collectFetch,
  collectFiles,
  collectLog,
  collectPush,
  collectRemotes,
  collectStage,
  collectStatus,
  collectUnstage,
  collectUpstream,
  type DiffRequest,
  type FileChange,
  type LogCommit,
  type RemoteInfo,
  resolveRepo,
  type StatusReport,
} from "../git";
import {
  type BranchEntry,
  branchLabel,
  describeError,
  type FileDiffScope,
  fileDetail,
  fileLabel,
  formatBranchLine,
  formatChangeCounts,
  resolveTargetSpec,
  StaleTargetError,
  shortSha,
  type TuiTargetSpec,
} from "./model";
import { collectBranches, collectCommitShow, currentBranchName, headShaOrNull } from "./repo";

// --- Pinned target ---------------------------------------------------------------

/** Error with a `kind` tag consumed by `describeError` (model.ts). */
export class TuiTargetError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "TuiTargetError";
    this.kind = kind;
  }
}

export interface PinnedTarget {
  /** Origin pane id pinned at launch; null for --cwd / context-less runs. */
  paneId: string | null;
  workspaceId: string | null;
  /** Origin cwd the repo was resolved from (pane cwd or --cwd). */
  cwd: string;
  /** Repo root all git commands run against. */
  repoRoot: string;
  /** HEAD sha at launch; null on unborn branches. */
  headSha: string | null;
  /** Branch name at launch; null when detached or unknown. */
  branchName: string | null;
  /** True when HEAD is detached. */
  detached: boolean;
}

function sameDir(a: string, b: string): boolean {
  const canon = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return canon(a) === canon(b);
}

async function paneCwdOf(snapshot: SessionSnapshot, paneId: string): Promise<string> {
  const pane = (snapshot.panes ?? []).find((p) => p.pane_id === paneId);
  if (!pane) {
    throw new TuiTargetError("pane_not_found", `pane not found in session snapshot: ${paneId}`);
  }
  const cwd = pane.cwd ?? (pane as { foreground_cwd?: string }).foreground_cwd;
  if (!cwd || typeof cwd !== "string") {
    throw new TuiTargetError("no_pane_cwd", `pane has no cwd in session snapshot: ${paneId}`);
  }
  return cwd;
}

/**
 * Resolve the pinned git target: pane (via session snapshot) or explicit
 * cwd → repo root → HEAD sha + branch name. Throws TuiTargetError /
 * GitError / TargetResolutionError — callers render `describeError`.
 */
export async function resolvePinnedTarget(
  spec: TuiTargetSpec,
  call: CallOptions = {},
): Promise<PinnedTarget> {
  let cwd = spec.cwd;
  if (!cwd && spec.paneId) {
    const snapshot = await sessionSnapshot(call);
    cwd = await paneCwdOf(snapshot, spec.paneId);
  }
  if (!cwd) {
    throw new TuiTargetError(
      "target_required",
      "no target: launch from a pane context or pass --cwd <path>",
    );
  }
  const repo = await resolveRepo(cwd, { timeoutMs: GIT_TIMEOUT_MS });
  const [headSha, branchName] = await Promise.all([
    headShaOrNull(repo.root, { timeoutMs: GIT_TIMEOUT_MS }),
    currentBranchName(repo.root, { timeoutMs: GIT_TIMEOUT_MS }),
  ]);
  const detached = branchName === "HEAD";
  return {
    paneId: spec.paneId,
    workspaceId: spec.workspaceId,
    cwd,
    repoRoot: repo.root,
    headSha,
    branchName: detached || branchName === null ? null : branchName,
    detached,
  };
}

/**
 * Pre-mutation revalidation (tui-v1 §3.3): the pinned pane must still
 * resolve to the same repo root and HEAD must not have moved. Any drift
 * throws StaleTargetError — callers abort with refresh, never retarget.
 */
export async function assertTargetFresh(
  target: PinnedTarget,
  call: CallOptions = {},
): Promise<void> {
  if (target.paneId) {
    const snapshot = await sessionSnapshot(call);
    const cwd = await paneCwdOf(snapshot, target.paneId);
    const repo = await resolveRepo(cwd, { timeoutMs: GIT_TIMEOUT_MS });
    if (!sameDir(repo.root, target.repoRoot)) {
      throw new StaleTargetError(
        `stale target: pane ${target.paneId} now resolves to ${repo.root} ` +
          `(was ${target.repoRoot}); reopen the surface`,
      );
    }
  }
  const sha = await headShaOrNull(target.repoRoot, { timeoutMs: GIT_TIMEOUT_MS });
  if (sha !== target.headSha) {
    throw new StaleTargetError(
      `stale target: HEAD moved ` +
        `${target.headSha ? shortSha(target.headSha) : "(unborn)"} -> ` +
        `${sha ? shortSha(sha) : "(unborn)"}; refresh before mutating`,
    );
  }
}

const GIT_TIMEOUT_MS = 10_000;
const REMOTE_TIMEOUT_MS = 60_000;
const MUTATION_TIMEOUT_MS = 60_000;
const DIFF_MAX_BYTES = 256 * 1024;

// --- Screen plumbing ---------------------------------------------------------------

/**
 * ScreenView wrapper adding single-key commands in front of an inner
 * SelectList. Commands are skipped while the list's `/` filter draft is
 * active so printable keys keep typing into the filter.
 */
class CommandList<T> implements ScreenView {
  readonly list: SelectList<T>;
  private readonly commands: Array<{
    keys: string[];
    description: string;
    run: () => void | Promise<void>;
  }> = [];

  constructor(
    items: readonly SelectItem<T>[],
    opts: {
      onSelect: (item: SelectItem<T>) => void;
      onCancel: () => void;
      emptyText?: string;
    },
  ) {
    this.list = new SelectList<T>({
      items,
      ...(opts.emptyText !== undefined ? { emptyText: opts.emptyText } : {}),
    });
    this.list.onSelect = () => {
      const sel = this.list.selected;
      if (sel) opts.onSelect(sel);
    };
    this.list.onCancel = opts.onCancel;
  }

  addCommand(keys: string[], description: string, run: () => void | Promise<void>): void {
    this.commands.push({ keys, description, run });
  }

  setItems(items: readonly SelectItem<T>[]): void {
    this.list.setItems(items);
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.list.filtering) return this.list.handleKey(ev) ?? false;
    if (ev.kind === "key" && !ev.ctrl && !ev.alt) {
      for (const cmd of this.commands) {
        for (const spec of cmd.keys) {
          if (matchKey(ev, spec)) {
            void cmd.run();
            return true;
          }
        }
      }
    }
    return this.list.handleKey(ev) ?? false;
  }

  render(width: number, height: number): Line[] {
    return this.list.render(width, height);
  }

  keymap(): KeyBinding[] {
    const extra = this.commands.map((c) => ({ keys: c.keys, description: c.description }));
    return [...extra, ...(this.list.keymap() ?? [])];
  }
}

/**
 * Scrollable text pager with async (re)load, honest error rendering, and
 * extra single-key commands. Base for diff/log-compare/remote/detail
 * screens. `r` always retries the loader; esc/q fall through to the app
 * stack (back/close).
 */
class PagerScreen implements ScreenView {
  private readonly loadFn: () => Promise<string[]>;
  private readonly titleFn: () => string;
  private lines: string[] = [];
  private error: string[] | null = null;
  private loading = true;
  private scroll = 0;
  private readonly commands: Array<{
    keys: string[];
    description: string;
    run: () => void | Promise<void>;
  }> = [];
  private readonly tui: GitTui;

  constructor(
    tui: GitTui,
    opts: {
      title: string | (() => string);
      load: () => Promise<string[]>;
    },
  ) {
    this.tui = tui;
    this.loadFn = opts.load;
    this.titleFn = typeof opts.title === "function" ? opts.title : () => opts.title as string;
    this.addCommand(["r"], "reload", () => this.reload());
    void this.reload();
  }

  addCommand(keys: string[], description: string, run: () => void | Promise<void>): void {
    this.commands.push({ keys, description, run });
  }

  async reload(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.tui.notify();
    try {
      this.lines = await this.loadFn();
    } catch (err) {
      const honest = describeError(err, this.tui.target?.repoRoot ?? null);
      this.error = ["", honest.title, "", ...honest.lines];
      if (honest.cliFallback) this.error.push("", `CLI fallback: ${honest.cliFallback}`);
    }
    this.loading = false;
    this.scroll = 0;
    this.tui.notify();
  }

  handleKey(ev: KeyEvent): boolean {
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    for (const cmd of this.commands) {
      for (const spec of cmd.keys) {
        if (matchKey(ev, spec)) {
          void cmd.run();
          return true;
        }
      }
    }
    const page = 10;
    if (matchKey(ev, "up") || matchKey(ev, "k")) {
      this.scroll = Math.max(0, this.scroll - 1);
      return true;
    }
    if (matchKey(ev, "down") || matchKey(ev, "j")) {
      this.scroll += 1;
      return true;
    }
    if (matchKey(ev, "pageup")) {
      this.scroll = Math.max(0, this.scroll - page);
      return true;
    }
    if (matchKey(ev, "pagedown") || matchKey(ev, "space")) {
      this.scroll += page;
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
    return false;
  }

  render(width: number, height: number): Line[] {
    const out: Line[] = [];
    out.push([{ text: clip(this.titleFn(), width), style: { bold: true } }]);
    out.push(hr(width));
    const bodyH = Math.max(1, height - 3);
    let source: string[];
    if (this.loading && this.lines.length === 0 && this.error === null) {
      source = ["(loading…)"];
    } else if (this.error !== null) {
      source = this.error;
    } else {
      source = this.lines.length === 0 ? ["(empty)"] : this.lines;
    }
    const max = Math.max(0, source.length - bodyH);
    this.scroll = Math.min(this.scroll, max);
    for (let r = 0; r < bodyH; r++) {
      const line = source[this.scroll + r];
      out.push(line === undefined ? [] : paintDiffLine(clip(line, width)));
    }
    const pos = `${Math.min(this.scroll + 1, source.length)}/${source.length}`;
    const state = this.loading ? " …" : this.error !== null ? " !" : "";
    out.push([
      { text: " ".repeat(Math.max(0, width - displayWidth(pos) - state.length - 1)) },
      { text: `${pos}${state}`, style: { dim: true } },
    ]);
    return out.slice(0, height);
  }

  onResize(): void {
    this.scroll = 0;
  }

  keymap(): KeyBinding[] {
    const cmds = this.commands.map((c) => ({ keys: c.keys, description: c.description }));
    return [
      ...cmds,
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      { keys: ["home", "end"], description: "top/bottom" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

/** Light syntactic coloring for diff/patch/log text (sanitized later). */
function paintDiffLine(line: string): Line {
  if (line.startsWith("@@")) return [{ text: line, style: { fg: "cyan", bold: true } }];
  if (line.startsWith("+++") || line.startsWith("---")) {
    return [{ text: line, style: { dim: true } }];
  }
  if (line.startsWith("+")) return [{ text: line, style: { fg: "green" } }];
  if (line.startsWith("-")) return [{ text: line, style: { fg: "red" } }];
  if (line.startsWith("diff ") || line.startsWith("commit ")) {
    return [{ text: line, style: { bold: true } }];
  }
  return text(line);
}

// --- Home screen ---------------------------------------------------------------------

type HomeAction =
  | "files"
  | "diff"
  | "log"
  | "compare"
  | "branches"
  | "remotes"
  | "stage-all"
  | "unstage-all"
  | "commit"
  | "fetch"
  | "push"
  | "upstream"
  | "refresh";

const HOME_ITEMS: Array<{ id: HomeAction; label: string; detail: string }> = [
  { id: "files", label: "Changed files", detail: "per-file stage / unstage / diff" },
  { id: "diff", label: "Diff", detail: "worktree / staged / HEAD patch viewer" },
  { id: "log", label: "Commit history", detail: "log + per-commit show" },
  { id: "compare", label: "Compare", detail: "branch vs upstream (merge-base diff)" },
  { id: "branches", label: "Branches", detail: "list / switch / create / set upstream" },
  { id: "remotes", label: "Remotes", detail: "fetch/push URLs (credentials stripped)" },
  { id: "stage-all", label: "Stage all changes", detail: "git add -A (confirmed)" },
  { id: "unstage-all", label: "Unstage all changes", detail: "git reset (confirmed)" },
  { id: "commit", label: "Commit…", detail: "message form + confirm" },
  { id: "fetch", label: "Fetch…", detail: "pick remote, run git fetch" },
  { id: "push", label: "Push…", detail: "push current branch (confirmed)" },
  { id: "upstream", label: "Set upstream…", detail: "branch --set-upstream-to" },
  { id: "refresh", label: "Refresh", detail: "re-read status (r)" },
];

class HomeScreen implements ScreenView {
  private readonly tui: GitTui;
  private list: CommandList<HomeAction>;

  constructor(tui: GitTui) {
    this.tui = tui;
    this.list = this.buildList();
  }

  private buildList(): CommandList<HomeAction> {
    const changes = this.tui.status?.changes;
    const items: SelectItem<HomeAction>[] = HOME_ITEMS.map((h) => {
      const item: SelectItem<HomeAction> = { value: h.id, label: h.label, detail: h.detail };
      // Mutation gating (contract item 4): disable with reason, not hidden.
      if (
        h.id === "stage-all" &&
        changes &&
        changes.staged + changes.unstaged + changes.untracked === 0
      ) {
        item.disabled = true;
        item.disabledReason = "nothing to stage";
      }
      if (h.id === "unstage-all" && changes && changes.staged === 0) {
        item.disabled = true;
        item.disabledReason = "nothing staged";
      }
      if (h.id === "commit" && changes && changes.staged === 0) {
        item.disabled = true;
        item.disabledReason = "nothing staged";
      }
      return item;
    });
    const list = new CommandList<HomeAction>(items, {
      onSelect: (item) => this.tui.dispatch(item.value),
      onCancel: () => void this.tui.app.close(),
      emptyText: "(no actions)",
    });
    list.addCommand(["r"], "refresh status", () => this.tui.refresh());
    return list;
  }

  /** Rebuild items (enabled/disabled state follows fresh counts). */
  rebuild(): void {
    this.list = this.buildList();
  }

  handleKey(ev: KeyEvent): boolean {
    return this.list.handleKey(ev);
  }

  render(width: number, height: number): Line[] {
    const header: Line[] = [];
    const t = this.tui.target;
    if (this.tui.status) {
      const s = this.tui.status;
      header.push(
        [
          { text: "⎇ ", style: { bold: true } },
          { text: formatBranchLine(s.branch) },
          { text: `   ${formatChangeCounts(s.changes)}`, style: { dim: true } },
        ],
        text(`repo: ${t ? t.repoRoot : "(unresolved)"}`),
      );
      if (t?.headSha) header.push(text(`HEAD: ${shortSha(t.headSha)}`));
    } else {
      header.push(text(`repo: ${t ? t.repoRoot : "(unresolved)"}`));
    }
    if (this.tui.notice) {
      header.push([{ text: this.tui.notice, style: { fg: "yellow" } }]);
    }
    const listH = Math.max(1, height - header.length - 1);
    const rows = this.list.render(width, listH);
    const out = [...header];
    for (const r of rows) out.push(r);
    out.push([{ text: "j/k move · enter open · r refresh · ? help", style: { dim: true } }]);
    return out.slice(0, height);
  }

  keymap(): KeyBinding[] {
    return this.list.keymap();
  }
}

// --- GitTui controller -----------------------------------------------------------------

export interface GitTuiOptions {
  /** Explicit target spec; defaults to resolveTargetSpec(process.env). */
  spec?: TuiTargetSpec;
  /** herdr call options (session/socket) for pane resolution + revalidation. */
  call?: CallOptions;
  /** Injectable app (tests); default TuiApp.create. */
  app?: TuiApp;
}

export class GitTui {
  readonly app: TuiApp;
  readonly call: CallOptions;
  target: PinnedTarget | null = null;
  status: StatusReport | null = null;
  /** Transient one-line notice shown on the home screen/status line. */
  notice: string | null = null;
  private home: HomeScreen | null = null;
  private filesScreen: CommandList<FileChange> | null = null;
  private resolveError: unknown = null;
  private lastSpec: TuiTargetSpec | null = null;
  private statusLeft = "";
  private statusRight = "";

  private constructor(app: TuiApp, call: CallOptions) {
    this.app = app;
    this.call = call;
  }

  static async create(opts: GitTuiOptions = {}): Promise<GitTui> {
    const app = opts.app ?? (await TuiApp.create({ title: "Git" }));
    const tui = new GitTui(app, opts.call ?? {});
    const spec = opts.spec ?? resolveTargetSpec();
    tui.lastSpec = spec;
    await tui.attach(spec);
    return tui;
  }

  /** (Re)resolve the pinned target and show home or the honest error. */
  private async attach(spec: TuiTargetSpec): Promise<void> {
    this.lastSpec = spec;
    try {
      this.target = await resolvePinnedTarget(spec, this.call);
      this.resolveError = null;
      await this.refreshStatus();
      this.showHome();
    } catch (err) {
      this.target = null;
      this.status = null;
      this.resolveError = err;
      this.showResolveError();
    }
  }

  private showHome(): void {
    this.home = new HomeScreen(this);
    this.app.setView(this.home);
    this.syncStatusLine();
  }

  private showResolveError(): void {
    const err = this.resolveError;
    const honest = describeError(err, null);
    const pager = new PagerScreen(this, {
      title: `Git — ${honest.title}`,
      load: async () => [
        "",
        ...honest.lines,
        ...(honest.cliFallback ? ["", `CLI fallback: ${honest.cliFallback}`] : []),
      ],
    });
    pager.addCommand(["r"], "retry", async () => {
      await this.attach(this.lastSpec ?? resolveTargetSpec());
    });
    this.app.setView(pager);
    this.syncStatusLine();
  }

  /** Re-render trigger used by screens after async loads/mutations. */
  notify(): void {
    this.syncStatusLine();
  }

  private syncStatusLine(): void {
    if (this.status && this.target) {
      this.statusLeft = `${formatBranchLine(this.status.branch)} · ${formatChangeCounts(this.status.changes)}`;
      this.statusRight = path.basename(this.target.repoRoot);
    } else if (this.target) {
      this.statusLeft = path.basename(this.target.repoRoot);
      this.statusRight = "";
    } else {
      this.statusLeft = "Git";
      this.statusRight = "";
    }
    this.app.setStatus(this.statusLeft, this.statusRight || "?/h — help");
  }

  async refresh(): Promise<void> {
    await this.refreshStatus();
    this.notice = null;
    this.home?.rebuild();
    this.syncStatusLine();
  }

  private async refreshStatus(): Promise<void> {
    if (!this.target) return;
    try {
      const report = await collectStatus(this.target.repoRoot, { timeoutMs: GIT_TIMEOUT_MS });
      if (this.target.headSha === null) {
        // Unborn branch: collectBranch mislabels HEAD as detached —
        // present the symbolic branch name honestly instead.
        report.branch = {
          name: this.target.branchName ?? "HEAD",
          detached: false,
          upstream: null,
          ahead: null,
          behind: null,
        };
      }
      this.status = report;
      this.resolveError = null;
    } catch (err) {
      this.status = null;
      this.showDataError(err);
    }
  }

  /** Push a pager screen; esc/q pop back through the app stack. */
  private pushPager(title: string | (() => string), load: () => Promise<string[]>): PagerScreen {
    const pager = new PagerScreen(this, { title, load });
    this.app.push(pager);
    return pager;
  }

  private showDataError(err: unknown): void {
    const honest = describeError(err, this.target?.repoRoot ?? null);
    const pager = new PagerScreen(this, {
      title: `Git — ${honest.title}`,
      load: async () => [
        "",
        ...honest.lines,
        ...(honest.cliFallback ? ["", `CLI fallback: ${honest.cliFallback}`] : []),
      ],
    });
    pager.addCommand(["r"], "retry", () => this.refresh());
    this.app.push(pager);
  }

  private showStale(err: StaleTargetError): void {
    const pager = new PagerScreen(this, {
      title: "Git — stale target",
      load: async () => [
        "",
        err.message,
        "",
        "The repository moved since this surface opened. The mutation was",
        "aborted; nothing was retargeted silently (tui-v1 §3.3).",
        "",
        "Press r to refresh status, or close and reopen for a fresh pin.",
      ],
    });
    pager.addCommand(["r"], "refresh", () => this.refresh());
    this.app.push(pager);
  }

  private requireTarget(): PinnedTarget | null {
    if (!this.target) {
      this.notice = "no git target resolved";
      this.syncStatusLine();
      return null;
    }
    return this.target;
  }

  // --- dispatch ------------------------------------------------------------------

  dispatch(action: HomeAction): void {
    switch (action) {
      case "files":
        void this.showFiles();
        break;
      case "diff":
        void this.showDiff();
        break;
      case "log":
        void this.showLog();
        break;
      case "compare":
        void this.showCompare();
        break;
      case "branches":
        void this.showBranches();
        break;
      case "remotes":
        void this.showRemotes();
        break;
      case "stage-all":
        void this.stageAll();
        break;
      case "unstage-all":
        void this.unstageAll();
        break;
      case "commit":
        void this.commitFlow();
        break;
      case "fetch":
        void this.fetchFlow();
        break;
      case "push":
        void this.pushFlow();
        break;
      case "upstream":
        void this.upstreamFlow();
        break;
      case "refresh":
        void this.refresh();
        break;
    }
  }

  // --- read views -----------------------------------------------------------------

  private async loadFiles(): Promise<FileChange[]> {
    const t = this.requireTarget();
    if (!t) return [];
    const res = await collectFiles(t.repoRoot, {}, { timeoutMs: GIT_TIMEOUT_MS });
    return res.files;
  }

  private fileItems(files: FileChange[]): SelectItem<FileChange>[] {
    return files.map((f) => ({ value: f, label: fileLabel(f), detail: fileDetail(f) }));
  }

  private async showFiles(): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    let files: FileChange[];
    try {
      files = await this.loadFiles();
    } catch (err) {
      this.showDataError(err);
      return;
    }
    const screen = new CommandList<FileChange>(this.fileItems(files), {
      emptyText: "(no changes)",
      onSelect: (item) => this.openFileDiff(item.value),
      onCancel: () => this.app.pop(),
    });
    screen.addCommand(["d"], "diff", () => {
      const cur = screen.list.current;
      if (cur && !cur.disabled) this.openFileDiff(cur.value);
    });
    screen.addCommand(["s"], "stage", () => {
      const cur = screen.list.current;
      if (cur && !cur.disabled) void this.fileStage(cur.value, true);
    });
    screen.addCommand(["u"], "unstage", () => {
      const cur = screen.list.current;
      if (cur && !cur.disabled) void this.fileStage(cur.value, false);
    });
    screen.addCommand(["r"], "reload", () => void this.reloadFilesScreen(screen));
    this.filesScreen = screen;
    this.app.push(screen);
  }

  private async reloadFilesScreen(screen: CommandList<FileChange>): Promise<void> {
    try {
      const files = await this.loadFiles();
      screen.setItems(this.fileItems(files));
      await this.refreshStatus();
      this.syncStatusLine();
    } catch (err) {
      this.showDataError(err);
    }
  }

  /** Diff scope for a file — mirrors the model helper's contract. */
  private diffScopeForFile(file: FileChange): FileDiffScope {
    switch (file.kind) {
      case "untracked":
      case "ignored":
        return "none";
      case "conflicted":
        return "worktree";
      default:
        break;
    }
    if (file.staged && file.unstaged) return "head";
    if (file.staged && !file.unstaged) return "staged";
    return "worktree";
  }

  private openFileDiff(file: FileChange): void {
    const scope = this.diffScopeForFile(file);
    if (scope === "none") {
      this.pushPager(`diff — ${file.path}`, async () => [
        fileLabel(file),
        "",
        "No diff exists for this entry:",
        file.kind === "untracked"
          ? "untracked files are not in the index — stage it first (s) to diff."
          : "ignored files are excluded from diffs.",
      ]);
      return;
    }
    this.pushFileDiff(file, scope);
  }

  private pushFileDiff(file: FileChange, initialScope: Exclude<FileDiffScope, "none">): void {
    const t = this.requireTarget();
    if (!t) return;
    const scopes: Array<Exclude<FileDiffScope, "none">> = ["worktree", "staged", "head"];
    let scope = initialScope;
    const paths = [file.path, ...(file.oldPath ? [file.oldPath] : [])];
    const pager = this.pushPager(
      () => `diff (${scope}) — ${file.oldPath ? `${file.oldPath} -> ` : ""}${file.path}`,
      async () => {
        const request: DiffRequest = { paths };
        if (scope === "staged") request.staged = true;
        if (scope === "head") request.revisions = ["HEAD"];
        const res = await collectDiff(t.repoRoot, request, { timeoutMs: GIT_TIMEOUT_MS });
        const lines = res.output.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        const out = [`scope: ${scope} · path: ${paths.join(", ")}`];
        if (res.truncated) out.push("(truncated at byte cap — narrow the path)");
        out.push("");
        out.push(...lines);
        return lines.length === 0 ? ["(empty diff)"] : out;
      },
    );
    pager.addCommand(["tab"], "cycle diff scope", () => {
      const i = scopes.indexOf(scope);
      scope = scopes[(i + 1) % scopes.length] as Exclude<FileDiffScope, "none">;
      void pager.reload();
    });
  }

  private async showDiff(): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    const scopes = ["worktree", "staged", "HEAD"] as const;
    let scope = 0;
    const pager = this.pushPager(
      () => `diff — ${scopes[scope]}`,
      async () => {
        const request: DiffRequest = {};
        if (scope === 1) request.staged = true;
        if (scope === 2) request.revisions = ["HEAD"];
        const res = await collectDiff(
          t.repoRoot,
          { ...request, maxBytes: DIFF_MAX_BYTES },
          { timeoutMs: GIT_TIMEOUT_MS },
        );
        const lines = res.output.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        const out: string[] = [];
        if (res.truncated) out.push("(truncated at byte cap)", "");
        out.push(...lines);
        return lines.length === 0 ? ["(empty diff)"] : out;
      },
    );
    pager.addCommand(["tab"], "cycle scope", () => {
      scope = (scope + 1) % scopes.length;
      void pager.reload();
    });
  }

  private async showLog(): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    let commits: LogCommit[];
    try {
      const res = await collectLog(t.repoRoot, { limit: 100 }, { timeoutMs: GIT_TIMEOUT_MS });
      commits = res.commits;
    } catch (err) {
      this.showDataError(err);
      return;
    }
    const screen = new CommandList<LogCommit>(
      commits.map((c) => ({
        value: c,
        label: `${shortSha(c.sha)} ${c.subject}`,
        detail: c.sha,
      })),
      {
        emptyText: this.target?.headSha ? "(no commits)" : "(unborn branch — no commits yet)",
        onSelect: (item) => void this.showCommit(item.value),
        onCancel: () => this.app.pop(),
      },
    );
    screen.addCommand(["r"], "reload", () => void this.reloadLog(screen));
    this.app.push(screen);
  }

  private async reloadLog(screen: CommandList<LogCommit>): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    try {
      const res = await collectLog(t.repoRoot, { limit: 100 }, { timeoutMs: GIT_TIMEOUT_MS });
      screen.setItems(
        res.commits.map((c) => ({
          value: c,
          label: `${shortSha(c.sha)} ${c.subject}`,
          detail: c.sha,
        })),
      );
      this.syncStatusLine();
    } catch (err) {
      this.showDataError(err);
    }
  }

  private async showCommit(commit: LogCommit): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    this.pushPager(`commit ${shortSha(commit.sha)} — ${commit.subject}`, async () => {
      const out = await collectCommitShow(t.repoRoot, commit.sha, {
        timeoutMs: GIT_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
      });
      const lines = out.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      return lines;
    });
  }

  private async showCompare(): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    let base: string | null = null;
    const pager = this.pushPager(
      () => `compare — ${base ?? "upstream (auto)"}`,
      async () => {
        const res = await collectCompare(
          t.repoRoot,
          { ...(base ? { base } : {}), maxBytes: DIFF_MAX_BYTES },
          { timeoutMs: GIT_TIMEOUT_MS },
        );
        const lines = [
          `${res.base}...${res.head}  (merge-base ${shortSha(res.mergeBase)})`,
          `ahead ${res.ahead} · behind ${res.behind}`,
          "",
          res.stat,
          "",
        ];
        const patch = res.patch.output.split("\n");
        if (patch[patch.length - 1] === "") patch.pop();
        lines.push(...patch);
        if (res.patch.truncated) lines.unshift("(patch truncated at byte cap)", "");
        return lines;
      },
    );
    pager.addCommand(["b"], "set base revision", async () => {
      const answer = await this.app.prompt("base revision (e.g. origin/main, HEAD~5):");
      if (answer === null) return;
      const trimmed = answer.trim();
      if (trimmed.startsWith("-")) {
        this.notice = "invalid base revision";
        this.syncStatusLine();
        return;
      }
      base = trimmed === "" ? null : trimmed;
      await pager.reload();
    });
  }

  private branchItems(entries: BranchEntry[]): SelectItem<BranchEntry>[] {
    return entries.map((b) => ({
      value: b,
      label: branchLabel(b),
      detail: [b.upstream ? `upstream ${b.upstream}` : "no upstream", b.track ?? ""]
        .filter((s) => s !== "")
        .join(" · "),
      ...(b.current ? { disabled: true, disabledReason: "current" } : {}),
    }));
  }

  private async showBranches(): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    let entries: BranchEntry[];
    try {
      entries = await collectBranches(t.repoRoot, { timeoutMs: GIT_TIMEOUT_MS });
    } catch (err) {
      this.showDataError(err);
      return;
    }
    const screen = new CommandList<BranchEntry>(this.branchItems(entries), {
      emptyText: "(no local branches)",
      onSelect: (item) => {
        if (!item.disabled) void this.switchBranch(item.value);
      },
      onCancel: () => this.app.pop(),
    });
    screen.addCommand(["n"], "new branch + switch", () => void this.createBranch(screen));
    screen.addCommand(["u"], "set upstream (current)", () => {
      void this.setUpstreamFor(this.target?.branchName ?? null);
    });
    screen.addCommand(["r"], "reload", () => void this.reloadBranches(screen));
    this.app.push(screen);
  }

  private async reloadBranches(screen: CommandList<BranchEntry>): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    try {
      const entries = await collectBranches(t.repoRoot, { timeoutMs: GIT_TIMEOUT_MS });
      screen.setItems(this.branchItems(entries));
      this.syncStatusLine();
    } catch (err) {
      this.showDataError(err);
    }
  }

  private async switchBranch(entry: BranchEntry): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    const ok = await this.app.confirm({
      title: "Switch branch",
      target: [
        `repo: ${t.repoRoot}`,
        `from: ${t.branchName ?? "HEAD (detached)"}`,
        `to: ${entry.name} (${shortSha(entry.sha)})`,
      ],
      consequence: "git switch changes HEAD; uncommitted changes may conflict.",
      confirmLabel: "Switch",
    });
    if (!ok) return;
    await this.runMutation({
      label: `switch to ${entry.name}`,
      fn: async () => {
        await collectBranchSwitch(
          t.repoRoot,
          { name: entry.name },
          { timeoutMs: MUTATION_TIMEOUT_MS },
        );
        return `switched to ${entry.name}`;
      },
      onOk: async () => {
        // HEAD sha/branch may have moved — re-pin so later mutations
        // validate against the new state.
        const [sha, bn] = await Promise.all([
          headShaOrNull(t.repoRoot),
          currentBranchName(t.repoRoot),
        ]);
        if (this.target) {
          if (sha !== null) this.target.headSha = sha;
          this.target.branchName = bn === "HEAD" ? null : bn;
          this.target.detached = bn === "HEAD";
        }
      },
    });
  }

  private async createBranch(screen: CommandList<BranchEntry>): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    const name = await this.app.prompt("new branch name:");
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.startsWith("-")) {
      this.notice = "invalid branch name";
      this.syncStatusLine();
      return;
    }
    const ok = await this.app.confirm({
      title: "Create and switch branch",
      target: [`repo: ${t.repoRoot}`, `branch: ${trimmed}`],
      consequence: "git switch -c creates the branch and moves HEAD to it.",
      confirmLabel: "Create",
    });
    if (!ok) return;
    await this.runMutation({
      label: `create branch ${trimmed}`,
      fn: async () => {
        await collectBranchCreate(
          t.repoRoot,
          { name: trimmed, switchTo: true },
          { timeoutMs: MUTATION_TIMEOUT_MS },
        );
        return `created and switched to ${trimmed}`;
      },
      onOk: async () => {
        const [sha, bn] = await Promise.all([
          headShaOrNull(t.repoRoot),
          currentBranchName(t.repoRoot),
        ]);
        if (this.target) {
          if (sha !== null) this.target.headSha = sha;
          this.target.branchName = bn === "HEAD" ? null : bn;
          this.target.detached = bn === "HEAD";
        }
        void this.reloadBranches(screen);
      },
    });
  }

  private async setUpstreamFor(branch: string | null): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    if (!branch || t.detached) {
      this.notice = "detached HEAD — no branch to set upstream on";
      this.syncStatusLine();
      return;
    }
    const upstream = await this.app.prompt(`upstream for ${branch} (e.g. origin/main):`);
    if (upstream === null) return;
    const trimmed = upstream.trim();
    if (trimmed === "" || trimmed.startsWith("-")) {
      this.notice = "invalid upstream ref";
      this.syncStatusLine();
      return;
    }
    const ok = await this.app.confirm({
      title: "Set upstream",
      target: [`repo: ${t.repoRoot}`, `branch: ${branch}`, `upstream: ${trimmed}`],
      consequence: "git branch --set-upstream-to records the tracking ref.",
      confirmLabel: "Set",
    });
    if (!ok) return;
    await this.runMutation({
      label: `set upstream ${trimmed}`,
      fn: async () => {
        await collectUpstream(
          t.repoRoot,
          { upstream: trimmed },
          { timeoutMs: MUTATION_TIMEOUT_MS },
        );
        return `upstream set: ${branch} -> ${trimmed}`;
      },
    });
  }

  private async showRemotes(): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    let remotes: RemoteInfo[];
    try {
      remotes = await collectRemotes(t.repoRoot, { timeoutMs: GIT_TIMEOUT_MS });
    } catch (err) {
      this.showDataError(err);
      return;
    }
    this.pushPager("remotes", async () => {
      if (remotes.length === 0) return ["(no remotes configured)"];
      const lines: string[] = [];
      for (const r of remotes) {
        lines.push(r.name, `  fetch: ${r.url}`, `  push:  ${r.pushUrl}`, "");
      }
      lines.pop();
      return lines;
    });
  }

  // --- mutations ---------------------------------------------------------------------

  /**
   * Optional confirm → task(fresh-check + fn) → refresh. Stale targets
   * abort via StaleTargetError surfaced as a dedicated stale screen;
   * nothing retargets silently.
   */
  private async runMutation(opts: {
    label: string;
    fn: () => Promise<string>;
    confirmTitle?: string;
    confirmTarget?: string[];
    consequence?: string;
    danger?: boolean;
    onOk?: () => Promise<void> | void;
  }): Promise<boolean> {
    const t = this.requireTarget();
    if (!t) return false;
    if (opts.confirmTitle) {
      const ok = await this.app.confirm({
        title: opts.confirmTitle,
        target: opts.confirmTarget ?? [
          `repo: ${t.repoRoot}`,
          `branch: ${t.branchName ?? "HEAD (detached)"}`,
        ],
        ...(opts.consequence ? { consequence: opts.consequence } : {}),
        ...(opts.danger ? { danger: true } : {}),
        confirmLabel: "Run",
      });
      if (!ok) return false;
    }
    const res = await this.app.tasks.run(
      { label: opts.label, timeoutMs: MUTATION_TIMEOUT_MS },
      async () => {
        try {
          await assertTargetFresh(t, { ...this.call, mutation: true });
        } catch (err) {
          if (err instanceof StaleTargetError) {
            throw new Error(`__stale__${err.message}`);
          }
          throw err;
        }
        return opts.fn();
      },
    );
    if (res.status === "ok") {
      this.notice = res.value ?? opts.label;
      try {
        await opts.onOk?.();
      } catch {
        // pin refresh is best-effort; the status reload below still runs
      }
      await this.refreshStatus();
      this.syncStatusLine();
      this.home?.rebuild();
      return true;
    }
    if (res.status === "error" && res.error?.startsWith("__stale__")) {
      this.showStale(new StaleTargetError(res.error.slice("__stale__".length)));
      return false;
    }
    this.notice =
      `${opts.label}: ${res.status}` +
      `${res.error ? ` — ${res.error}` : ""}` +
      `${res.partial ? " (partial)" : ""}`;
    this.syncStatusLine();
    return false;
  }

  /** Stage/unstage one file (both sides of a rename). */
  private async fileStage(file: FileChange, staging: boolean): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    if (!staging && file.kind === "untracked") {
      this.notice = `${file.path} is untracked — nothing staged to unstage`;
      this.syncStatusLine();
      return;
    }
    if (staging && file.kind === "ignored") {
      this.notice = `${file.path} is ignored — git add refuses it without -f`;
      this.syncStatusLine();
      return;
    }
    const paths = [file.path, ...(file.oldPath ? [file.oldPath] : [])];
    const verb = staging ? "stage" : "unstage";
    await this.runMutation({
      label: `${verb} ${file.path}`,
      fn: async () => {
        if (staging) {
          await collectStage(t.repoRoot, { paths }, { timeoutMs: MUTATION_TIMEOUT_MS });
        } else {
          await collectUnstage(t.repoRoot, { paths }, { timeoutMs: MUTATION_TIMEOUT_MS });
        }
        return `${staging ? "staged" : "unstaged"} ${file.path}`;
      },
    });
    await this.refreshStatus();
    this.syncStatusLine();
    // Keep an open files screen in sync with the mutation.
    if (this.filesScreen) await this.reloadFilesScreen(this.filesScreen);
  }

  private async stageAll(): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    const c = this.status?.changes;
    const n = c ? c.unstaged + c.untracked + c.conflicted : 0;
    const ok = await this.app.confirm({
      title: "Stage all changes",
      target: [
        `repo: ${t.repoRoot}`,
        `branch: ${t.branchName ?? "HEAD (detached)"}`,
        `~${n} unstaged/untracked file(s)`,
      ],
      consequence: "git add -A stages every change including untracked files.",
      confirmLabel: "Stage all",
    });
    if (!ok) return;
    await this.runMutation({
      label: "stage all",
      fn: async () => {
        await collectStage(t.repoRoot, { all: true }, { timeoutMs: MUTATION_TIMEOUT_MS });
        return "staged all changes";
      },
    });
  }

  private async unstageAll(): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    const ok = await this.app.confirm({
      title: "Unstage all changes",
      target: [`repo: ${t.repoRoot}`, `branch: ${t.branchName ?? "HEAD (detached)"}`],
      consequence: "git reset unstages everything; worktree files are untouched.",
      confirmLabel: "Unstage all",
    });
    if (!ok) return;
    await this.runMutation({
      label: "unstage all",
      fn: async () => {
        await collectUnstage(t.repoRoot, { all: true }, { timeoutMs: MUTATION_TIMEOUT_MS });
        return "unstaged all changes";
      },
    });
  }

  private async commitFlow(): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    const subject = await this.app.prompt("commit subject:");
    if (subject === null) return;
    const subj = subject.trim();
    if (subj === "") {
      this.notice = "empty commit message";
      this.syncStatusLine();
      return;
    }
    const body = await this.app.prompt("commit body (optional, Enter to skip):", {
      placeholder: "(empty)",
    });
    if (body === null) return; // cancelled at the body prompt
    const messages = body.trim() === "" ? [subj] : [subj, body.trim()];
    const staged = this.status?.changes.staged ?? 0;
    const ok = await this.app.confirm({
      title: "Commit",
      target: [
        `repo: ${t.repoRoot}`,
        `branch: ${t.branchName ?? "HEAD (detached)"}`,
        `staged files: ${staged}`,
        `message: ${subj}`,
      ],
      consequence: "creates a new commit on the current branch.",
      confirmLabel: "Commit",
    });
    if (!ok) return;
    await this.runMutation({
      label: "commit",
      fn: async () => {
        const res = await collectCommit(
          t.repoRoot,
          { messages },
          { timeoutMs: MUTATION_TIMEOUT_MS },
        );
        return `committed ${shortSha(res.sha)}`;
      },
      onOk: async () => {
        const sha = await headShaOrNull(t.repoRoot);
        if (sha !== null && this.target) this.target.headSha = sha;
      },
    });
  }

  private async fetchFlow(): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    let remotes: RemoteInfo[];
    try {
      remotes = await collectRemotes(t.repoRoot, { timeoutMs: GIT_TIMEOUT_MS });
    } catch (err) {
      this.showDataError(err);
      return;
    }
    if (remotes.length === 0) {
      this.pushPager("fetch — no remotes", async () => [
        "This repository has no remotes configured.",
        "Add one with: git remote add <name> <url>",
      ]);
      return;
    }
    const choice = await this.app.select<RemoteInfo>({
      items: remotes.map((r) => ({ value: r, label: r.name, detail: r.url })),
      emptyText: "(no remotes)",
    });
    if (!choice) return;
    const remote = choice.value.name;
    const ok = await this.app.confirm({
      title: "Fetch",
      target: [`repo: ${t.repoRoot}`, `remote: ${remote} (${choice.value.url})`],
      consequence: "git fetch downloads objects/refs; it does not touch your worktree.",
      confirmLabel: "Fetch",
    });
    if (!ok) return;
    await this.runMutation({
      label: `fetch ${remote}`,
      fn: async () => {
        const out = await collectFetch(t.repoRoot, { remote }, { timeoutMs: REMOTE_TIMEOUT_MS });
        const last = out
          .split("\n")
          .filter((l) => l.trim() !== "")
          .pop();
        return last ?? `fetched ${remote}`;
      },
    });
  }

  private async pushFlow(): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    if (t.detached || !t.branchName) {
      this.pushPager("push — detached HEAD", async () => [
        "Cannot push: HEAD is detached.",
        "Check out a branch first (Branches → switch).",
      ]);
      return;
    }
    const branch = this.status?.branch ?? null;
    const upstream = branch?.upstream ?? null;
    if (upstream) {
      const remote = upstream.includes("/") ? upstream.slice(0, upstream.indexOf("/")) : upstream;
      const ok = await this.app.confirm({
        title: "Push",
        target: [
          `repo: ${t.repoRoot}`,
          `branch: ${t.branchName}`,
          `upstream: ${upstream} (remote ${remote})`,
        ],
        consequence: "publishes local commits to the upstream branch.",
        confirmLabel: "Push",
      });
      if (!ok) return;
      await this.runMutation({
        label: `push ${t.branchName}`,
        fn: async () => {
          const out = await collectPush(t.repoRoot, { remote }, { timeoutMs: REMOTE_TIMEOUT_MS });
          const last = out
            .split("\n")
            .filter((l) => l.trim() !== "")
            .pop();
          return last ?? `pushed ${t.branchName}`;
        },
      });
      return;
    }
    // No upstream: pick a remote, push -u HEAD:<branch>.
    let remotes: RemoteInfo[];
    try {
      remotes = await collectRemotes(t.repoRoot, { timeoutMs: GIT_TIMEOUT_MS });
    } catch (err) {
      this.showDataError(err);
      return;
    }
    if (remotes.length === 0) {
      this.pushPager("push — no remotes", async () => [
        "This repository has no remotes configured; nowhere to push.",
      ]);
      return;
    }
    const choice = await this.app.select<RemoteInfo>({
      items: remotes.map((r) => ({ value: r, label: r.name, detail: r.url })),
      emptyText: "(no remotes)",
    });
    if (!choice) return;
    const remote = choice.value.name;
    const ok = await this.app.confirm({
      title: "Push (set upstream)",
      target: [
        `repo: ${t.repoRoot}`,
        `branch: ${t.branchName}`,
        `remote: ${remote} (${choice.value.url})`,
        `refspec: HEAD:${t.branchName} (--set-upstream)`,
      ],
      consequence: "creates the remote branch and records upstream tracking.",
      confirmLabel: "Push -u",
    });
    if (!ok) return;
    await this.runMutation({
      label: `push -u ${remote} ${t.branchName}`,
      fn: async () => {
        const out = await collectPush(
          t.repoRoot,
          { remote, refspec: `HEAD:${t.branchName}`, setUpstream: true },
          { timeoutMs: REMOTE_TIMEOUT_MS },
        );
        const last = out
          .split("\n")
          .filter((l) => l.trim() !== "")
          .pop();
        return last ?? `pushed ${t.branchName} -> ${remote}`;
      },
      onOk: async () => {
        await this.refreshStatus();
      },
    });
  }

  private async upstreamFlow(): Promise<void> {
    const t = this.requireTarget();
    if (!t) return;
    await this.setUpstreamFor(t.branchName);
  }
}
