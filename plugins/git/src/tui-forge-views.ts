/**
 * Screen views for the rebuildup.git forge TUI (`herdr-plugins.tui/v1`).
 *
 * Safety-contract mapping (ADR-0033 §3 / tui-v1 §5):
 * - read-only open: every `load()` runs only `pr|issue list|view|reviews|
 *   comments|checks|logs|status` — reads. No mutation ever fires
 *   implicitly on open.
 * - explicit target: every CLI call passes the pinned pane id (never
 *   `HERDR_PANE_ID` — that is the UI pane) plus an optional validated
 *   `--repo owner/name` override.
 * - stale generation: PR mutations re-read `pr reviews` (head.sha) +
 *   `pr view` (updatedAt) immediately before writing and pass the fresh
 *   sha as `--expect-head` — the CLI's own stale_head guard is the final
 *   authority. Drift since the view opened asks before applying.
 *   Issue mutations re-read `issue view` and compare `updated_at`
 *   (issues have no head sha — same rule as the CLI contract).
 * - mutation gating: `mutationAllowed` against the `capability`
 *   document ("pr" / "issue"); denied ops refuse with the reason.
 * - irreversible confirmation: `ui.confirm` shows exact target +
 *   consequence for every mutation; merge uses `danger: true`.
 * - timeout/cancel: all mutating CLI work runs inside `ui.tasks.run`.
 * - honest unsupported: gh_missing/gh_error/stale_head/merge_blocked/
 *   release_boundary render their real `kind: message`, never a
 *   fabricated success; the README/CLI fallback is named in errors.
 */

import {
  type ConfirmOptions,
  clip,
  DetailView,
  displayWidth,
  type KeyBinding,
  type KeyEvent,
  type Line,
  matchKey,
  openExternal,
  type ScreenView,
  type SelectItem,
  SelectList,
  type SelectListOptions,
  type TaskRunner,
  type TextInputOptions,
  wrapText,
} from "../../../packages/tui/src/index";
import {
  type CapabilityDoc,
  type CliRunOptions,
  type ForgeTarget,
  formatIssueView,
  formatPrChecksPayload,
  formatPrJobLogPayload,
  formatPrReviewsPayload,
  formatPrView,
  formatTargetLabel,
  GitCliError,
  headShaOf,
  issueSelectItem,
  mutationAllowed,
  type PinnedTarget,
  prSelectItem,
  repoFlagArgs,
  validateRepoOverride,
} from "./tui-forge-support";

// --- shared deps ----------------------------------------------------------------

/** The subset of `TuiApp` the views need (TuiApp satisfies this). */
export interface ForgeTuiUi {
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

export interface ForgeTuiDeps {
  cli(args: readonly string[], options?: CliRunOptions): Promise<Record<string, unknown>>;
  ui: ForgeTuiUi;
  /** `capability` payload fetched at launch; null = unavailable (fail closed). */
  capability: CapabilityDoc | null;
  target: PinnedTarget;
  /** Mutable forge target: pinned pane id + optional repo override. */
  forge: ForgeTarget;
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

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// --- shared flows -----------------------------------------------------------------

/** Current pane id, or null with an honest status when unpinned. */
function requirePane(deps: ForgeTuiDeps): string | null {
  const pane = deps.forge.paneId;
  if (pane === null) {
    deps.ui.setStatus("no pane pinned — press p to set a pane id (its cwd resolves the repo)");
  }
  return pane;
}

/** `p` — repoint the forge target pane (explicit in-UI selection). */
async function promptPaneId(deps: ForgeTuiDeps): Promise<void> {
  const current = deps.forge.paneId ?? "";
  const input = await deps.ui.prompt(
    "Pane id for the forge target (repo resolves from its cwd)",
    current !== "" ? { value: current } : {},
  );
  if (input === null) return;
  const value = input.trim();
  if (value === "") {
    deps.ui.setStatus("empty pane id — cancelled");
    return;
  }
  if (value.startsWith("-")) {
    deps.ui.setStatus("pane id must not start with '-'");
    return;
  }
  deps.forge.paneId = value;
  deps.ui.setStatus(`forge pane → ${value} — press R to reload`);
}

/** `o` — set/clear the `--repo owner/name` override. */
async function promptRepoOverride(deps: ForgeTuiDeps): Promise<void> {
  const current = deps.forge.repoOverride ?? "";
  const input = await deps.ui.prompt(
    "Forge repo override (owner/name — empty clears)",
    current !== "" ? { value: current } : {},
  );
  if (input === null) return;
  const value = input.trim();
  if (value === "") {
    deps.forge.repoOverride = null;
    deps.ui.setStatus("repo override cleared — press R to reload");
    return;
  }
  const problem = validateRepoOverride(value);
  if (problem !== null) {
    deps.ui.setStatus(problem);
    return;
  }
  deps.forge.repoOverride = value;
  deps.ui.setStatus(`repo override → ${value} — press R to reload`);
}

/** Shared `p`/`o` target keys; returns true when consumed. */
function handleTargetKeys(deps: ForgeTuiDeps, ev: KeyEvent): boolean {
  if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
  if (ev.key === "p") {
    void promptPaneId(deps);
    return true;
  }
  if (ev.key === "o") {
    void promptRepoOverride(deps);
    return true;
  }
  return false;
}

const TARGET_KEYMAP: KeyBinding[] = [
  { keys: "p", description: "set forge pane id" },
  { keys: "o", description: "set repo override (owner/name)" },
];

/** Gate a forge mutation; renders the deny reason when blocked. */
function gate(deps: ForgeTuiDeps, command: "pr" | "issue"): boolean {
  const result = mutationAllowed(deps.capability, command);
  if (!result.allowed) {
    deps.ui.setStatus(`mutations disabled: ${result.reason ?? command}`);
    return false;
  }
  return true;
}

/** Run a CLI op inside the task runner; returns payload or null. */
async function runOp(
  deps: ForgeTuiDeps,
  label: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown> | null> {
  const result = await deps.ui.tasks.run(
    { label, timeoutMs: options.timeoutMs ?? 90_000 },
    (signal) => deps.cli(args, { signal, timeoutMs: options.timeoutMs ?? 90_000 }),
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

/** Read-only CLI call for loaders (no task wrapper; loads are user-paced). */
async function readOp(
  deps: ForgeTuiDeps,
  _label: string,
  args: readonly string[],
): Promise<Record<string, unknown>> {
  return deps.cli(args, { timeoutMs: 90_000 });
}

/** Compose `pr|issue <action> <pane> [pos...] [--repo o/n] [flags...]`. */
function forgeArgs(
  deps: ForgeTuiDeps,
  family: "pr" | "issue",
  action: string,
  positional: readonly (string | number)[] = [],
  flags: readonly string[] = [],
): string[] | null {
  const pane = requirePane(deps);
  if (pane === null) return null;
  return [family, action, pane, ...positional.map(String), ...repoFlagArgs(deps.forge), ...flags];
}

function errorText(err: unknown): string {
  if (err instanceof GitCliError) return `${err.kind}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** gh-missing/unsupported hint appended to forge load errors. */
function forgeErrorLines(kind: string | null, message: string): string[] {
  const lines = [`forge error${kind !== null ? ` (${kind})` : ""}: ${message}`];
  if (kind === "gh_missing") {
    lines.push(
      "the host `gh` CLI is required for the forge surface (gh >= 2.81.0 + gh auth login)",
      "CLI fallback: bun run src/cli.ts pr list <pane_id>",
    );
  } else if (kind !== null) {
    lines.push(`CLI fallback: bun run src/cli.ts <cmd> — see plugin README`);
  }
  return lines;
}

// --- shared scrollable detail chrome ------------------------------------------------

/** Minimal scroll state + render skeleton shared by detail-style views. */
class ScrollBody {
  scroll = 0;

  clamp(maxScroll: number): void {
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
  }

  page(delta: number): void {
    this.scroll += delta;
  }
}

function scrollKeys(ev: KeyEvent, body: ScrollBody): boolean {
  // j/k scroll like DetailView; action keys in these views avoid j/k.
  if (matchKey(ev, "up") || matchKey(ev, "k")) {
    body.scroll -= 1;
    return true;
  }
  if (matchKey(ev, "down") || matchKey(ev, "j")) {
    body.scroll += 1;
    return true;
  }
  if (matchKey(ev, "pageup")) {
    body.scroll -= 10;
    return true;
  }
  if (matchKey(ev, "pagedown") || matchKey(ev, "space")) {
    body.scroll += 10;
    return true;
  }
  if (matchKey(ev, "home")) {
    body.scroll = 0;
    return true;
  }
  if (matchKey(ev, "end")) {
    body.scroll = Number.MAX_SAFE_INTEGER;
    return true;
  }
  return false;
}

/** Render wrapped, scroll-clipped text lines for a detail-style view. */
function renderScrollable(
  title: string,
  source: readonly string[],
  body: ScrollBody,
  width: number,
  height: number,
  footer: string,
): Line[] {
  const hasTitle = title !== "";
  const bodyH = Math.max(1, height - (hasTitle ? 3 : 1));
  const wrapped: string[] = [];
  for (const l of source) wrapped.push(...wrapText(l, Math.max(1, width - 2)));
  body.clamp(Math.max(0, wrapped.length - bodyH));
  const view = wrapped.slice(body.scroll, body.scroll + bodyH);
  const lines: Line[] = [];
  if (hasTitle) {
    lines.push([{ text: clip(title, width), style: { bold: true } }]);
    lines.push([{ text: "─".repeat(Math.max(0, width)), style: { dim: true } }]);
  }
  for (const v of view) lines.push([{ text: clip(v, width) }]);
  while (lines.length < height - 1) lines.push([]);
  const pos =
    wrapped.length > 0 ? `${Math.min(body.scroll + 1, wrapped.length)}/${wrapped.length}` : "0/0";
  const footerW = Math.max(0, width - displayWidth(pos) - 2);
  lines.push([
    { text: clip(footer, footerW), style: { dim: true } },
    { text: " ".repeat(Math.max(0, footerW - displayWidth(clip(footer, footerW)))) },
    { text: pos, style: { dim: true } },
  ]);
  return lines.slice(0, height);
}

// --- home view ---------------------------------------------------------------------

export type ForgeHomeTarget = "prs" | "issues" | "pr-status";

/** Root view: pick the forge surface. */
export class ForgeHomeView implements ScreenView {
  private readonly deps: ForgeTuiDeps;
  private readonly onOpen: (target: ForgeHomeTarget) => void;
  private readonly list: SelectList<ForgeHomeTarget>;

  constructor(deps: ForgeTuiDeps, onOpen: (target: ForgeHomeTarget) => void) {
    this.deps = deps;
    this.onOpen = onOpen;
    this.list = new SelectList<ForgeHomeTarget>({
      items: [
        {
          value: "prs",
          label: "Pull requests",
          detail: "list / view / review / comment / merge (gh-backed)",
        },
        {
          value: "issues",
          label: "Issues",
          detail: "list / view / create / edit / comment / close (gh-backed)",
        },
        {
          value: "pr-status",
          label: "PR for current branch",
          detail: "open PR of the pinned pane's current branch, or honest none",
        },
      ],
      filterable: false,
      emptyText: "no forge surfaces",
    });
    this.list.onSelect = (item) => {
      if (item.value) this.onOpen(item.value);
    };
    this.list.onCancel = () => void this.deps.ui.close();
  }

  render(width: number, height: number): Line[] {
    return this.list.render(width, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.list.handleKey(ev) === true) return true;
    return handleTargetKeys(this.deps, ev);
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "enter", description: "open surface" },
      ...TARGET_KEYMAP,
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

// --- PR for current branch ---------------------------------------------------------

/** `pr status` — open PR of the pinned pane's current branch. */
export class PrBranchStatusView implements ScreenView {
  private readonly deps: ForgeTuiDeps;
  private phase: "loading" | "ready" | "error" | "no-pr" = "loading";
  private lines: string[] = [];
  private errorKind: string | null = null;
  private errorMessage = "";
  private readonly body = new ScrollBody();

  constructor(deps: ForgeTuiDeps) {
    this.deps = deps;
    void this.load();
  }

  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    const args = forgeArgs(this.deps, "pr", "status");
    if (args === null) {
      this.phase = "error";
      this.errorKind = null;
      this.errorMessage = "no pane pinned — press p on the home view to set one";
      this.deps.ui.invalidate();
      return;
    }
    try {
      const payload = await readOp(this.deps, "pr status", args);
      const pr = asRecord(payload.pr);
      if (payload.detached === true) {
        this.phase = "no-pr";
        this.lines = [
          `branch: ${typeof payload.branch === "string" ? payload.branch : "HEAD"} (detached)`,
          "",
          "(detached HEAD — no branch PR lookup)",
        ];
      } else if (pr === null) {
        this.phase = "no-pr";
        this.lines = [
          `branch: ${typeof payload.branch === "string" ? payload.branch : "unknown"}`,
          "",
          "(no open PR for the current branch)",
        ];
      } else {
        this.phase = "ready";
        this.lines = formatPrView(pr);
      }
      this.errorKind = null;
      this.errorMessage = "";
    } catch (err) {
      this.phase = "error";
      this.errorKind = err instanceof GitCliError ? err.kind : null;
      this.errorMessage = errorText(err);
    }
    this.deps.ui.invalidate();
  }

  render(width: number, height: number): Line[] {
    if (this.phase === "loading") {
      return renderScrollable("pr status", ["loading…"], this.body, width, height, "");
    }
    if (this.phase === "error") {
      return renderScrollable(
        "pr status",
        forgeErrorLines(this.errorKind, this.errorMessage),
        this.body,
        width,
        height,
        "R — retry · esc — back",
      );
    }
    const title = this.phase === "no-pr" ? "pr status — no open PR" : "pr status";
    return renderScrollable(
      title,
      this.lines,
      this.body,
      width,
      height,
      "R — refresh · esc — back",
    );
  }

  handleKey(ev: KeyEvent): boolean {
    if (scrollKeys(ev, this.body)) return true;
    if (ev.kind === "key" && !ev.ctrl && !ev.alt && (ev.key === "r" || ev.key === "R")) {
      void this.load();
      return true;
    }
    return handleTargetKeys(this.deps, ev);
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      { keys: ["r", "R"], description: "refresh" },
      ...TARGET_KEYMAP,
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- PR list -------------------------------------------------------------------------

type PrListState = "open" | "closed" | "merged" | "all";
const PR_STATES: readonly PrListState[] = ["open", "closed", "merged", "all"];

/** `pr list` browser + `pr create` flow. */
export class PrListView implements ScreenView {
  private readonly deps: ForgeTuiDeps;
  private readonly onOpenPr: (number: number) => void;
  private readonly list: SelectList<Record<string, unknown>>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorKind: string | null = null;
  private errorTextValue = "";
  private state: PrListState = "open";
  private prs: Record<string, unknown>[] = [];

  constructor(deps: ForgeTuiDeps, onOpenPr: (number: number) => void) {
    this.deps = deps;
    this.onOpenPr = onOpenPr;
    this.list = new SelectList<Record<string, unknown>>({
      items: [],
      filterable: true,
      emptyText: "no pull requests",
    });
    this.list.onSelect = (item) => {
      const n = num(item.value?.number);
      if (n !== null) this.onOpenPr(n);
    };
    this.list.onCancel = () => this.deps.ui.pop();
    void this.load();
  }

  /** (Re)load the PR list. Read-only: `pr list` never mutates. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    const args = forgeArgs(this.deps, "pr", "list", [], ["--state", this.state, "--limit", "50"]);
    if (args === null) {
      this.phase = "error";
      this.errorKind = null;
      this.errorTextValue = "no pane pinned — press p to set a pane id";
      this.deps.ui.invalidate();
      return;
    }
    try {
      const payload = await readOp(this.deps, "pr list", args);
      this.prs = asArray(payload.prs);
      this.list.setItems(this.prs.map(prSelectItem));
      this.phase = "ready";
      this.errorKind = null;
      this.errorTextValue = "";
    } catch (err) {
      this.phase = "error";
      this.errorKind = err instanceof GitCliError ? err.kind : null;
      this.errorTextValue = errorText(err);
    }
    this.deps.ui.invalidate();
  }

  private cycleState(): void {
    const i = PR_STATES.indexOf(this.state);
    this.state = PR_STATES[(i + 1) % PR_STATES.length] as PrListState;
    this.deps.ui.setStatus(`pr state filter → ${this.state}`);
    void this.load();
  }

  /** `pr create` — title required; body/base/head/draft optional. */
  private async createFlow(): Promise<void> {
    if (!gate(this.deps, "pr")) return;
    const titleInput = await this.deps.ui.prompt("PR title (required)");
    if (titleInput === null) return;
    const title = titleInput.trim();
    if (title === "") {
      this.deps.ui.setStatus("empty title — cancelled");
      return;
    }
    const body = await this.deps.ui.prompt(
      "PR body (optional — single line; use CLI --body-file for long text)",
    );
    if (body === null) return;
    const base = await this.deps.ui.prompt("Base branch (optional — Enter for repo default)");
    if (base === null) return;
    const head = await this.deps.ui.prompt("Head branch/ref (optional — Enter for current branch)");
    if (head === null) return;
    const draft = await this.deps.ui.confirm({
      title: "Create as draft?",
      target: [
        `repo: ${this.deps.forge.repoOverride ?? "(pane repo)"}`,
        `pane: ${this.deps.forge.paneId ?? "?"}`,
      ],
      consequence: "a draft PR is created on the forge (not marked ready for review)",
      confirmLabel: "Draft",
      cancelLabel: "Ready",
    });
    const ok = await this.deps.ui.confirm({
      title: "Create pull request?",
      target: [
        `title: ${title}`,
        ...(body.trim() !== "" ? [`body: ${body.trim().slice(0, 120)}`] : []),
        ...(base.trim() !== "" ? [`base: ${base.trim()}`] : []),
        ...(head.trim() !== "" ? [`head: ${head.trim()}`] : []),
        `draft: ${draft}`,
        `repo: ${this.deps.forge.repoOverride ?? "(pane repo)"}`,
        `pane: ${this.deps.forge.paneId ?? "?"}`,
        `target: ${formatTargetLabel(this.deps.target)}`,
      ],
      consequence: "creates a pull request on the forge (visible to collaborators)",
      confirmLabel: "Create PR",
    });
    if (!ok) return;
    const flags = [
      "--title",
      title,
      ...(body.trim() !== "" ? ["--body", body.trim()] : []),
      ...(base.trim() !== "" ? ["--base", base.trim()] : []),
      ...(head.trim() !== "" ? ["--head", head.trim()] : []),
      ...(draft ? ["--draft"] : []),
    ];
    const args = forgeArgs(this.deps, "pr", "create", [], flags);
    if (args === null) return;
    const payload = await runOp(this.deps, "pr create", args);
    if (payload !== null) {
      const url = str(payload.url);
      const number = num(payload.number);
      this.deps.ui.setStatus(
        `PR created${number !== null ? ` #${number}` : ""}${url !== null ? ` — ${url}` : ""}`,
      );
      this.deps.onChanged?.();
      await this.load();
      if (number !== null) this.onOpenPr(number);
    }
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: `loading pull requests (${this.state})…`, style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load pull requests", style: { bold: true, fg: "red" } }]);
        for (const l of forgeErrorLines(this.errorKind, this.errorTextValue)) {
          lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
        }
        lines.push([{ text: "R — retry · p — set pane · esc — back", style: { dim: true } }]);
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
      case "s":
        this.cycleState();
        return true;
      case "n":
        void this.createFlow();
        return true;
      case "r":
      case "R":
        void this.load();
        return true;
      default:
        return handleTargetKeys(this.deps, ev);
    }
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "open PR" },
      { keys: "s", description: "cycle state filter" },
      { keys: "n", description: "create PR" },
      { keys: ["r", "R"], description: "refresh" },
      ...TARGET_KEYMAP,
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- PR freshness (stale-generation gate) -------------------------------------------

interface FreshPr {
  /** head.sha from a fresh `pr reviews` read — the --expect-head value. */
  headSha: string;
  /** updatedAt from a fresh `pr view` read — drift detection. */
  updatedAt: string | null;
}

/**
 * Re-read the PR immediately before a mutation (tui-v1 §3.3 / safety
 * item 3). Returns the fresh head sha for `--expect-head`, or null when
 * the mutation must not proceed. A changed `updatedAt` vs the opened
 * view asks before applying; "refresh instead" aborts and reloads.
 */
async function revalidatePr(
  deps: ForgeTuiDeps,
  number: number,
  openedUpdatedAt: string | null,
  openedHeadSha: string | null,
): Promise<FreshPr | null> {
  const pane = deps.forge.paneId;
  if (pane === null) {
    deps.ui.setStatus("no pane pinned — cannot revalidate PR head");
    return null;
  }
  let reviewsPayload: Record<string, unknown>;
  let viewPayload: Record<string, unknown>;
  try {
    [reviewsPayload, viewPayload] = await Promise.all([
      readOp(deps, "pr reviews (freshness)", [
        "pr",
        "reviews",
        pane,
        String(number),
        ...repoFlagArgs(deps.forge),
      ]),
      readOp(deps, "pr view (freshness)", [
        "pr",
        "view",
        pane,
        String(number),
        ...repoFlagArgs(deps.forge),
      ]),
    ]);
  } catch (err) {
    deps.ui.setStatus(`revalidate failed: ${errorText(err)}`);
    return null;
  }
  const headSha = headShaOf(reviewsPayload);
  if (headSha === null) {
    deps.ui.setStatus("revalidate failed: PR head sha unavailable");
    return null;
  }
  const freshView = asRecord(viewPayload.pr);
  const freshUpdatedAt = freshView !== null ? str(freshView.updatedAt) : null;
  const drifted =
    (openedUpdatedAt !== null && freshUpdatedAt !== null && freshUpdatedAt !== openedUpdatedAt) ||
    (openedHeadSha !== null && headSha !== openedHeadSha);
  if (drifted) {
    const proceed = await deps.ui.confirm({
      title: "PR changed since this view opened",
      target: [
        `pr: #${number}`,
        `opened updated_at: ${openedUpdatedAt ?? "unknown"}`,
        `current updated_at: ${freshUpdatedAt ?? "unknown"}`,
        `opened head: ${openedHeadSha?.slice(0, 12) ?? "unknown"}`,
        `current head: ${headSha.slice(0, 12)}`,
      ],
      consequence:
        "the PR moved since this view loaded; applying now binds the mutation to the CURRENT head sha (--expect-head)",
      confirmLabel: "Apply to current head",
      cancelLabel: "Refresh instead",
    });
    if (!proceed) return null;
  }
  return { headSha, updatedAt: freshUpdatedAt };
}

/**
 * Shared tail for PR mutations: gate → confirm → revalidate (fresh
 * --expect-head) → op → reload hook. The CLI re-verifies the head guard
 * itself; `stale_head`/`merge_blocked`/`release_boundary` surface as
 * honest statuses.
 */
async function mutatePr(
  deps: ForgeTuiDeps,
  opts: {
    number: number;
    label: string;
    command: "review" | "comment" | "reviewers" | "merge";
    confirm: ConfirmOptions;
    /** Flag tokens only (e.g. --expect-head <sha>); positionals fixed. */
    buildArgs: (headSha: string) => readonly string[];
    openedUpdatedAt: string | null;
    openedHeadSha: string | null;
    onDone?: () => void;
  },
): Promise<void> {
  if (!gate(deps, "pr")) return;
  const ok = await deps.ui.confirm(opts.confirm);
  if (!ok) return;
  const fresh = await revalidatePr(deps, opts.number, opts.openedUpdatedAt, opts.openedHeadSha);
  if (fresh === null) return;
  const pane = deps.forge.paneId;
  if (pane === null) return;
  const args = [
    "pr",
    opts.command,
    pane,
    String(opts.number),
    ...repoFlagArgs(deps.forge),
    ...opts.buildArgs(fresh.headSha),
  ];
  const payload = await runOp(deps, opts.label, args);
  if (payload !== null) {
    deps.ui.setStatus(`${opts.label} ok`);
    deps.onChanged?.();
    opts.onDone?.();
  }
}

// --- PR detail ---------------------------------------------------------------------

/** PR view + actions (comments/reviews/checks/logs/review/comment/reply/reviewers/merge). */
export class PrDetailView implements ScreenView {
  private readonly deps: ForgeTuiDeps;
  private readonly number: number;
  private pr: Record<string, unknown> | null = null;
  private reviewsPayload: Record<string, unknown> | null = null;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorKind: string | null = null;
  private errorTextValue = "";
  private readonly body = new ScrollBody();

  constructor(deps: ForgeTuiDeps, number: number) {
    this.deps = deps;
    this.number = number;
    void this.load();
  }

  private get openedUpdatedAt(): string | null {
    const pr = asRecord(this.pr);
    return pr !== null ? str(pr.updatedAt) : null;
  }

  private get openedHeadSha(): string | null {
    return this.reviewsPayload !== null ? headShaOf(this.reviewsPayload) : null;
  }

  /** Read-only load: `pr view` + `pr reviews` (echoes head.sha). */
  async load(): Promise<void> {
    this.phase = "loading";
    this.body.scroll = 0;
    this.deps.ui.invalidate();
    const args = forgeArgs(this.deps, "pr", "view", [this.number]);
    if (args === null) {
      this.phase = "error";
      this.errorKind = null;
      this.errorTextValue = "no pane pinned — press p to set a pane id";
      this.deps.ui.invalidate();
      return;
    }
    const revArgs = forgeArgs(this.deps, "pr", "reviews", [this.number]);
    try {
      const [viewPayload, reviewsPayload] = await Promise.all([
        readOp(this.deps, "pr view", args),
        revArgs !== null
          ? readOp(this.deps, "pr reviews", revArgs).catch(() => null)
          : Promise.resolve(null),
      ]);
      const pr = asRecord(viewPayload.pr);
      if (pr === null) {
        this.phase = "error";
        this.errorKind = null;
        this.errorTextValue = "pr view returned no PR payload";
      } else {
        this.pr = pr;
        this.reviewsPayload = reviewsPayload;
        this.phase = "ready";
        this.errorKind = null;
        this.errorTextValue = "";
      }
    } catch (err) {
      this.phase = "error";
      this.errorKind = err instanceof GitCliError ? err.kind : null;
      this.errorTextValue = errorText(err);
    }
    this.deps.ui.invalidate();
  }

  private detailLines(): string[] {
    const lines = this.pr !== null ? formatPrView(this.pr) : [];
    const headSha = this.openedHeadSha;
    if (headSha !== null) {
      lines.push(`head sha (expect-head): ${headSha}`);
    } else {
      lines.push("head sha: unavailable (reviews read failed — mutations will revalidate)");
    }
    const rr = asRecord(this.reviewsPayload?.review_requests);
    if (rr) {
      const users = Array.isArray(rr.users) ? rr.users.map(String).join(", ") : "";
      const teams = Array.isArray(rr.teams) ? rr.teams.map(String).join(", ") : "";
      const parts = [
        users !== "" ? `users: ${users}` : null,
        teams !== "" ? `teams: ${teams}` : null,
      ].filter((p): p is string => p !== null);
      lines.push(`review requests: ${parts.length > 0 ? parts.join(" · ") : "none"}`);
    }
    return lines;
  }

  // -- sub-views (read-only payload browsers) ------------------------------------

  /** Push a read-only DetailView for a `pr <action>` payload. */
  private pushPrPayload(
    title: string,
    action: string,
    extra: readonly string[],
    formatter: (payload: Record<string, unknown>) => string[],
  ): void {
    void (async () => {
      const args = forgeArgs(this.deps, "pr", action, [this.number, ...extra]);
      if (args === null) return;
      const result = await runOp(this.deps, `pr ${action}`, args);
      if (result === null) return;
      this.deps.ui.push(
        new DetailView({
          title,
          lines: formatter(result),
          onClose: () => this.deps.ui.pop(),
        }),
      );
    })();
  }

  private showReviews(): void {
    this.pushPrPayload(`pr #${this.number} — reviews`, "reviews", [], formatPrReviewsPayload);
  }

  private showChecks(): void {
    this.pushPrPayload(`pr #${this.number} — checks`, "checks", [], formatPrChecksPayload);
  }

  private showComments(): void {
    this.deps.ui.push(
      new PrCommentsView(this.deps, this.number, {
        updatedAt: this.openedUpdatedAt,
        headSha: this.openedHeadSha,
      }),
    );
  }

  private showLogs(): void {
    this.deps.ui.push(new PrLogsView(this.deps, this.number));
  }

  // -- mutations -------------------------------------------------------------------

  private prTargetLines(): string[] {
    const pr = asRecord(this.pr);
    return [
      `pr: #${this.number} ${pr !== null ? String(pr.title ?? "") : ""}`,
      `repo: ${this.deps.forge.repoOverride ?? "(pane repo)"}`,
      `pane: ${this.deps.forge.paneId ?? "?"}`,
      `head: ${this.openedHeadSha?.slice(0, 12) ?? "unknown"} (fresh head verified before write)`,
      `state: ${pr !== null ? String(pr.state ?? "?") : "?"}${pr?.isDraft === true ? " (draft)" : ""}`,
      `mergeState: ${pr !== null ? String(pr.mergeStateStatus ?? "?") : "?"}`,
      `target: ${formatTargetLabel(this.deps.target)}`,
    ];
  }

  private commentFlow(): void {
    void (async () => {
      const body = await this.deps.ui.prompt("PR comment body (required)");
      if (body === null) return;
      const text = body.trim();
      if (text === "") {
        this.deps.ui.setStatus("empty comment — cancelled");
        return;
      }
      await mutatePr(this.deps, {
        number: this.number,
        label: "pr comment",
        command: "comment",
        confirm: {
          title: "Post PR comment?",
          target: [...this.prTargetLines(), `body: ${text.slice(0, 160)}`],
          consequence: "posts a public comment on the pull request",
          confirmLabel: "Post",
        },
        buildArgs: (sha) => ["--body", text, "--expect-head", sha],
        openedUpdatedAt: this.openedUpdatedAt,
        openedHeadSha: this.openedHeadSha,
        onDone: () => void this.load(),
      });
    })();
  }

  private reviewFlow(): void {
    void (async () => {
      const eventItem = await this.deps.ui.select({
        items: [
          { value: "APPROVE", label: "Approve", detail: "submit an approving review" },
          {
            value: "REQUEST_CHANGES",
            label: "Request changes",
            detail: "submit a changes-requested review",
          },
          {
            value: "COMMENT",
            label: "Comment review",
            detail: "submit a review with only a comment body",
          },
        ],
      });
      const event = str(eventItem?.value);
      if (event === null) return;
      const body = await this.deps.ui.prompt("Review body (optional)");
      if (body === null) return;
      const text = body.trim();
      const flag =
        event === "APPROVE"
          ? "--approve"
          : event === "REQUEST_CHANGES"
            ? "--request-changes"
            : "--comment";
      await mutatePr(this.deps, {
        number: this.number,
        label: `pr review (${event.toLowerCase().replace("_", "-")})`,
        command: "review",
        confirm: {
          title: `Submit ${event.replace("_", " ").toLowerCase()} review?`,
          target: [
            ...this.prTargetLines(),
            `event: ${event}`,
            ...(text !== "" ? [`body: ${text.slice(0, 160)}`] : []),
          ],
          consequence: "submits a formal review on the pull request (visible to collaborators)",
          confirmLabel: "Submit review",
          danger: event === "REQUEST_CHANGES",
        },
        buildArgs: (sha) => [flag, ...(text !== "" ? ["--body", text] : []), "--expect-head", sha],
        openedUpdatedAt: this.openedUpdatedAt,
        openedHeadSha: this.openedHeadSha,
        onDone: () => void this.load(),
      });
    })();
  }

  private reviewersFlow(): void {
    void (async () => {
      const addInput = await this.deps.ui.prompt(
        "Reviewers to add (comma-separated logins — empty for none)",
      );
      if (addInput === null) return;
      const removeInput = await this.deps.ui.prompt(
        "Reviewers to remove (comma-separated logins — empty for none)",
      );
      if (removeInput === null) return;
      const split = (raw: string): string[] =>
        raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
      const add = split(addInput);
      const remove = split(removeInput);
      if (add.length === 0 && remove.length === 0) {
        this.deps.ui.setStatus("no reviewers given — cancelled");
        return;
      }
      const rr = asRecord(this.reviewsPayload?.review_requests);
      const currentUsers = Array.isArray(rr?.users) ? rr.users.map(String) : [];
      const currentTeams = Array.isArray(rr?.teams) ? rr.teams.map(String) : [];
      await mutatePr(this.deps, {
        number: this.number,
        label: "pr reviewers",
        command: "reviewers",
        confirm: {
          title: "Update PR reviewers?",
          target: [
            ...this.prTargetLines(),
            `add: ${add.length > 0 ? add.join(", ") : "none"}`,
            `remove: ${remove.length > 0 ? remove.join(", ") : "none"}`,
            `current reviewers: ${[...currentUsers, ...currentTeams].join(", ") || "none"}`,
          ],
          consequence: "requests/dismisses reviewers on the pull request",
          confirmLabel: "Update reviewers",
        },
        buildArgs: (sha) => [
          ...(add.length > 0 ? ["--add-reviewer", add.join(",")] : []),
          ...(remove.length > 0 ? ["--remove-reviewer", remove.join(",")] : []),
          "--expect-head",
          sha,
        ],
        openedUpdatedAt: this.openedUpdatedAt,
        openedHeadSha: this.openedHeadSha,
        onDone: () => void this.load(),
      });
    })();
  }

  private mergeFlow(): void {
    void (async () => {
      const modeItem = await this.deps.ui.select({
        items: [
          { value: "squash", label: "Squash merge", detail: "merge now with squash method" },
          { value: "merge", label: "Merge commit", detail: "merge now with a merge commit" },
          { value: "rebase", label: "Rebase merge", detail: "merge now with rebase method" },
          {
            value: "default",
            label: "Merge (repo default)",
            detail: "merge now, GitHub default method",
          },
          {
            value: "auto",
            label: "Enable auto-merge",
            detail: "arm GitHub auto-merge (method required)",
          },
          {
            value: "disable-auto",
            label: "Disable auto-merge",
            detail: "disarm GitHub auto-merge",
          },
        ],
      });
      const mode = str(modeItem?.value);
      if (mode === null) return;

      let methodFlag: string[] = [];
      let autoFlag: string[] = [];
      if (mode === "auto") {
        const methodItem = await this.deps.ui.select({
          items: [
            { value: "squash", label: "Squash" },
            { value: "merge", label: "Merge commit" },
            { value: "rebase", label: "Rebase" },
          ],
        });
        const method = str(methodItem?.value);
        if (method === null) return;
        methodFlag = [`--${method}`];
        autoFlag = ["--auto"];
      } else if (mode === "disable-auto") {
        autoFlag = ["--disable-auto"];
      } else if (mode !== "default") {
        methodFlag = [`--${mode}`];
      }

      const pr = asRecord(this.pr);
      const irreversible =
        mode === "disable-auto"
          ? "disarms GitHub auto-merge — the PR will no longer merge automatically"
          : mode === "auto"
            ? "arms GitHub auto-merge — the PR merges automatically once checks/reviews clear"
            : "MERGES the pull request immediately — this cannot be undone from the TUI";
      await mutatePr(this.deps, {
        number: this.number,
        label: `pr merge (${mode})`,
        command: "merge",
        confirm: {
          title:
            mode === "disable-auto"
              ? "Disable auto-merge?"
              : mode === "auto"
                ? "Enable auto-merge?"
                : "Merge pull request?",
          target: [
            ...this.prTargetLines(),
            `mode: ${mode}`,
            `reviewDecision: ${pr !== null ? String(pr.reviewDecision ?? "?") : "?"}`,
            `isDraft: ${pr?.isDraft === true}`,
          ],
          consequence: irreversible,
          confirmLabel: mode === "disable-auto" ? "Disable" : mode === "auto" ? "Enable" : "Merge",
          danger: mode !== "auto" && mode !== "disable-auto",
        },
        buildArgs: (sha) => [...methodFlag, ...autoFlag, "--expect-head", sha],
        openedUpdatedAt: this.openedUpdatedAt,
        openedHeadSha: this.openedHeadSha,
        onDone: () => void this.load(),
      });
    })();
  }

  private openUrl(): void {
    const url = this.pr !== null ? str(this.pr.url) : null;
    if (url === null) {
      this.deps.ui.setStatus("no PR url in payload");
      return;
    }
    void openExternal(url).then((res) => {
      this.deps.ui.setStatus(res.ok ? `opened ${url}` : `open failed: ${res.reason} — ${url}`);
    });
  }

  // -- ScreenView ---------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    if (this.phase === "loading") {
      return renderScrollable(`pr #${this.number}`, ["loading…"], this.body, width, height, "");
    }
    if (this.phase === "error") {
      return renderScrollable(
        `pr #${this.number}`,
        forgeErrorLines(this.errorKind, this.errorTextValue),
        this.body,
        width,
        height,
        "R — retry · esc — back",
      );
    }
    return renderScrollable(
      `pr #${this.number}`,
      this.detailLines(),
      this.body,
      width,
      height,
      "c comments · v reviews · t checks · l logs · m comment · r review · e reviewers · g merge · u url · R refresh",
    );
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.phase !== "ready") {
      if (scrollKeys(ev, this.body)) return true;
      if (ev.kind === "key" && !ev.ctrl && !ev.alt && (ev.key === "r" || ev.key === "R")) {
        void this.load();
        return true;
      }
      return handleTargetKeys(this.deps, ev);
    }
    if (scrollKeys(ev, this.body)) return true;
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return handleTargetKeys(this.deps, ev);
    switch (ev.key) {
      case "c":
        this.showComments();
        return true;
      case "v":
        this.showReviews();
        return true;
      case "t":
        this.showChecks();
        return true;
      case "l":
        this.showLogs();
        return true;
      case "m":
        this.commentFlow();
        return true;
      case "r":
        this.reviewFlow();
        return true;
      case "e":
        this.reviewersFlow();
        return true;
      case "g":
        this.mergeFlow();
        return true;
      case "u":
        this.openUrl();
        return true;
      case "R":
        void this.load();
        return true;
      default:
        return handleTargetKeys(this.deps, ev);
    }
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      { keys: "c", description: "comments (+ reply)" },
      { keys: "v", description: "reviews" },
      { keys: "t", description: "checks (CI)" },
      { keys: "l", description: "workflow logs" },
      { keys: "m", description: "post comment" },
      { keys: "r", description: "submit review" },
      { keys: "e", description: "edit reviewers" },
      { keys: "g", description: "merge / auto-merge" },
      { keys: "u", description: "open PR url externally" },
      { keys: ["R"], description: "refresh" },
      ...TARGET_KEYMAP,
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- PR comments (with reply) ---------------------------------------------------------

interface CommentItem {
  raw: Record<string, unknown>;
  kind: "issue" | "line";
}

/** `pr comments` browser; `r` replies to the selected line comment. */
export class PrCommentsView implements ScreenView {
  private readonly deps: ForgeTuiDeps;
  private readonly number: number;
  private readonly openedUpdatedAt: string | null;
  private readonly openedHeadSha: string | null;
  private readonly list: SelectList<CommentItem>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorKind: string | null = null;
  private errorTextValue = "";

  constructor(
    deps: ForgeTuiDeps,
    number: number,
    freshness?: { updatedAt: string | null; headSha: string | null },
  ) {
    this.deps = deps;
    this.number = number;
    this.openedUpdatedAt = freshness?.updatedAt ?? null;
    this.openedHeadSha = freshness?.headSha ?? null;
    this.list = new SelectList<CommentItem>({
      items: [],
      filterable: true,
      emptyText: "no comments",
    });
    this.list.onSelect = (item) => {
      if (item.value === undefined || item.value === null) return;
      const c = item.value.raw;
      const body = typeof c.body === "string" ? c.body : "";
      const head =
        item.value.kind === "line"
          ? `${String(c.path ?? "?")}:${String(c.line ?? "?")}`
          : "conversation";
      this.deps.ui.push(
        new DetailView({
          title: `comment #${String(c.id ?? "?")} — ${head}`,
          lines: [
            `author: ${typeof c.author === "string" ? c.author : "unknown"}`,
            `created: ${String(c.created_at ?? "?")}`,
            ...(typeof c.url === "string" && c.url !== "" ? [`url: ${c.url}`] : []),
            "",
            ...body.split("\n"),
            ...(c.body_truncated === true ? ["… (truncated)"] : []),
          ],
          onClose: () => this.deps.ui.pop(),
        }),
      );
    };
    this.list.onCancel = () => this.deps.ui.pop();
    void this.load();
  }

  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    const args = forgeArgs(this.deps, "pr", "comments", [this.number]);
    if (args === null) {
      this.phase = "error";
      this.errorKind = null;
      this.errorTextValue = "no pane pinned — press p to set a pane id";
      this.deps.ui.invalidate();
      return;
    }
    try {
      const payload = await readOp(this.deps, "pr comments", args);
      const items: CommentItem[] = [];
      for (const c of asArray(payload.issue_comments)) {
        items.push({ raw: c, kind: "issue" });
      }
      for (const c of asArray(payload.line_comments)) {
        items.push({ raw: c, kind: "line" });
      }
      this.list.setItems(
        items.map((item) => {
          const c = item.raw;
          const id = String(c.id ?? "?");
          const author = typeof c.author === "string" ? c.author : "unknown";
          const when = String(c.created_at ?? "");
          const label =
            item.kind === "line"
              ? `L${String(c.line ?? "?")} ${String(c.path ?? "?")} — #${id} ${author}`
              : `#${id} ${author} (conversation)`;
          return {
            value: item,
            label: `${label} ${when}`,
            detail: typeof c.body === "string" ? c.body.slice(0, 400) : "(no body)",
          };
        }),
      );
      this.phase = "ready";
      this.errorKind = null;
      this.errorTextValue = "";
    } catch (err) {
      this.phase = "error";
      this.errorKind = err instanceof GitCliError ? err.kind : null;
      this.errorTextValue = errorText(err);
    }
    this.deps.ui.invalidate();
  }

  /** `r` — reply to the selected line comment (needs its review-comment id). */
  private replyFlow(): void {
    void (async () => {
      const current = this.list.current;
      if (current === null || current.value === undefined || current.value === null) {
        this.deps.ui.setStatus("select a comment first");
        return;
      }
      const item = current.value;
      if (item.kind !== "line") {
        this.deps.ui.setStatus(
          "replies attach to line comments — select one (L…) or use 'm' on the PR for a conversation comment",
        );
        return;
      }
      const commentId = num(item.raw.id);
      if (commentId === null) {
        this.deps.ui.setStatus("selected comment has no id — cannot reply");
        return;
      }
      const body = await this.deps.ui.prompt(`Reply body for comment #${commentId} (required)`);
      if (body === null) return;
      const text = body.trim();
      if (text === "") {
        this.deps.ui.setStatus("empty reply — cancelled");
        return;
      }
      const target = [
        `pr: #${this.number}`,
        `reply to comment: #${commentId}`,
        `path: ${String(item.raw.path ?? "?")}:${String(item.raw.line ?? "?")}`,
        `repo: ${this.deps.forge.repoOverride ?? "(pane repo)"}`,
        `pane: ${this.deps.forge.paneId ?? "?"}`,
        `target: ${formatTargetLabel(this.deps.target)}`,
      ];
      if (!gate(this.deps, "pr")) return;
      const ok = await this.deps.ui.confirm({
        title: "Post review-thread reply?",
        target: [...target, `body: ${text.slice(0, 160)}`],
        consequence: "posts a public reply inside the review thread",
        confirmLabel: "Post reply",
      });
      if (!ok) return;
      const fresh = await revalidatePr(
        this.deps,
        this.number,
        this.openedUpdatedAt,
        this.openedHeadSha,
      );
      if (fresh === null) return;
      const args = forgeArgs(
        this.deps,
        "pr",
        "reply",
        [this.number, commentId],
        ["--body", text, "--expect-head", fresh.headSha],
      );
      if (args === null) return;
      const result = await runOp(this.deps, "pr reply", args);
      if (result !== null) {
        this.deps.ui.setStatus("reply posted");
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: `loading comments for pr #${this.number}…`, style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load comments", style: { bold: true, fg: "red" } }]);
        for (const l of forgeErrorLines(this.errorKind, this.errorTextValue)) {
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
    switch (ev.key) {
      case "r":
        this.replyFlow();
        return true;
      case "R":
        void this.load();
        return true;
      default:
        return handleTargetKeys(this.deps, ev);
    }
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "view comment" },
      { keys: "r", description: "reply to selected line comment" },
      { keys: ["R"], description: "refresh" },
      ...TARGET_KEYMAP,
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- PR logs (runs → jobs → log tail) -------------------------------------------------

type PrLogsMode = "runs" | "jobs";

/** `pr logs` browser: runs list → run's jobs → bounded job log tail. */
export class PrLogsView implements ScreenView {
  private readonly deps: ForgeTuiDeps;
  private readonly number: number;
  private mode: PrLogsMode = "runs";
  private readonly list: SelectList<Record<string, unknown>>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorKind: string | null = null;
  private errorTextValue = "";
  private currentRunId: string | null = null;

  constructor(deps: ForgeTuiDeps, number: number) {
    this.deps = deps;
    this.number = number;
    this.list = new SelectList<Record<string, unknown>>({
      items: [],
      filterable: true,
      emptyText: "no entries",
    });
    this.list.onSelect = (item) => {
      const value = item.value;
      if (value === undefined || value === null) return;
      if (this.mode === "runs") {
        const id = str(value.id);
        if (id !== null) {
          this.currentRunId = id;
          void this.loadJobs(id);
        }
      } else {
        const id = str(value.id);
        if (id !== null) void this.showJobLog(id);
      }
    };
    this.list.onCancel = () => {
      if (this.mode === "jobs") {
        this.mode = "runs";
        this.currentRunId = null;
        this.list.setItems([]);
        void this.loadRuns();
      } else {
        this.deps.ui.pop();
      }
    };
    void this.loadRuns();
  }

  private async loadRuns(): Promise<void> {
    this.mode = "runs";
    this.phase = "loading";
    this.deps.ui.invalidate();
    const args = forgeArgs(this.deps, "pr", "logs", [this.number]);
    if (args === null) {
      this.phase = "error";
      this.errorKind = null;
      this.errorTextValue = "no pane pinned — press p to set a pane id";
      this.deps.ui.invalidate();
      return;
    }
    try {
      const payload = await readOp(this.deps, "pr logs (runs)", args);
      const runs = asArray(payload.runs);
      this.list.setItems(
        runs.map((r) => ({
          value: r,
          label: `run #${String(r.id ?? "?")} ${String(r.name ?? "?")} — ${String(r.status ?? "?")}/${String(r.conclusion ?? "?")}`,
          detail: [
            `workflow: ${String(r.workflow ?? "?")}`,
            `created: ${String(r.created_at ?? "?")}`,
            `title: ${String(r.display_title ?? "")}`,
            `url: ${String(r.url ?? "")}`,
          ].join("\n"),
        })),
      );
      this.phase = "ready";
      this.errorKind = null;
      this.errorTextValue = "";
    } catch (err) {
      this.phase = "error";
      this.errorKind = err instanceof GitCliError ? err.kind : null;
      this.errorTextValue = errorText(err);
    }
    this.deps.ui.invalidate();
  }

  private async loadJobs(runId: string): Promise<void> {
    this.mode = "jobs";
    this.phase = "loading";
    this.deps.ui.invalidate();
    const args = forgeArgs(this.deps, "pr", "logs", [this.number], ["--run", runId]);
    if (args === null) {
      this.phase = "error";
      this.errorKind = null;
      this.errorTextValue = "no pane pinned";
      this.deps.ui.invalidate();
      return;
    }
    try {
      const payload = await readOp(this.deps, "pr logs (run)", args);
      const jobs = asArray(payload.jobs);
      this.list.setItems(
        jobs.map((j) => ({
          value: j,
          label: `job #${String(j.id ?? "?")} ${String(j.name ?? "?")} — ${String(j.status ?? "?")}/${String(j.conclusion ?? "?")}`,
          detail: `url: ${String(j.url ?? "")}`,
        })),
      );
      this.phase = "ready";
      this.errorKind = null;
      this.errorTextValue = "";
    } catch (err) {
      this.phase = "error";
      this.errorKind = err instanceof GitCliError ? err.kind : null;
      this.errorTextValue = errorText(err);
    }
    this.deps.ui.invalidate();
  }

  private async showJobLog(jobId: string): Promise<void> {
    const args = forgeArgs(
      this.deps,
      "pr",
      "logs",
      [this.number],
      ["--job", jobId, "--lines", "500"],
    );
    if (args === null) return;
    const result = await runOp(this.deps, "pr logs (job)", args, { timeoutMs: 120_000 });
    if (result === null) return;
    this.deps.ui.push(
      new DetailView({
        title: `job #${jobId} log`,
        lines: formatPrJobLogPayload(result),
        onClose: () => this.deps.ui.pop(),
      }),
    );
  }

  render(width: number, height: number): Line[] {
    if (this.phase === "loading") {
      const label =
        this.mode === "jobs"
          ? `loading jobs for run #${this.currentRunId ?? "?"}…`
          : `loading runs for pr #${this.number}…`;
      const lines: Line[] = [[{ text: label, style: { dim: true } }]];
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    if (this.phase === "error") {
      const lines: Line[] = [
        [{ text: "failed to load logs", style: { bold: true, fg: "red" } }],
        ...forgeErrorLines(this.errorKind, this.errorTextValue).map(
          (l): Line => [{ text: clip(l, width), style: { fg: "red" } }],
        ),
        [{ text: "R — retry · esc — back", style: { dim: true } }],
      ];
      while (lines.length < height) lines.push([]);
      return lines.slice(0, height);
    }
    return this.list.render(width, height);
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.list.handleKey(ev) === true) return true;
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return false;
    if (ev.key === "r" || ev.key === "R") {
      if (this.mode === "jobs" && this.currentRunId !== null) {
        void this.loadJobs(this.currentRunId);
      } else {
        void this.loadRuns();
      }
      return true;
    }
    return handleTargetKeys(this.deps, ev);
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: this.mode === "runs" ? "open run jobs" : "view job log" },
      { keys: ["esc"], description: this.mode === "jobs" ? "back to runs" : "back" },
      { keys: ["R"], description: "refresh" },
      ...TARGET_KEYMAP,
      { keys: ["q"], description: "back" },
    ];
  }
}

// --- issue freshness -----------------------------------------------------------------

interface FreshIssue {
  updatedAt: string | null;
}

/** Re-read `issue view` before a mutation; drift asks before applying. */
async function revalidateIssue(
  deps: ForgeTuiDeps,
  number: number,
  openedUpdatedAt: string | null,
): Promise<FreshIssue | null> {
  const pane = deps.forge.paneId;
  if (pane === null) {
    deps.ui.setStatus("no pane pinned — cannot revalidate issue");
    return null;
  }
  let payload: Record<string, unknown>;
  try {
    payload = await readOp(deps, "issue view (freshness)", [
      "issue",
      "view",
      pane,
      String(number),
      ...repoFlagArgs(deps.forge),
    ]);
  } catch (err) {
    deps.ui.setStatus(`revalidate failed: ${errorText(err)}`);
    return null;
  }
  const issue = asRecord(payload.issue);
  const freshUpdatedAt = issue !== null ? str(issue.updated_at) : null;
  if (issue === null) {
    deps.ui.setStatus("revalidate failed: issue view returned no payload");
    return null;
  }
  if (openedUpdatedAt !== null && freshUpdatedAt !== null && freshUpdatedAt !== openedUpdatedAt) {
    const proceed = await deps.ui.confirm({
      title: "Issue changed since this view opened",
      target: [
        `issue: #${number}`,
        `opened updated_at: ${openedUpdatedAt}`,
        `current updated_at: ${freshUpdatedAt}`,
      ],
      consequence:
        "the issue changed underneath this view; applying now writes to the latest state",
      confirmLabel: "Apply anyway",
      cancelLabel: "Refresh instead",
    });
    if (!proceed) return null;
  }
  return { updatedAt: freshUpdatedAt };
}

/** Shared tail for issue mutations (no --expect-head; issues have no head sha). */
async function mutateIssue(
  deps: ForgeTuiDeps,
  opts: {
    number: number;
    label: string;
    action: string;
    confirm: ConfirmOptions | null;
    buildArgs: () => readonly string[];
    openedUpdatedAt: string | null;
    onDone?: () => void;
  },
): Promise<void> {
  if (!gate(deps, "issue")) return;
  if (opts.confirm !== null) {
    const ok = await deps.ui.confirm(opts.confirm);
    if (!ok) return;
  }
  const fresh = await revalidateIssue(deps, opts.number, opts.openedUpdatedAt);
  if (fresh === null) return;
  const pane = deps.forge.paneId;
  if (pane === null) return;
  const args = [
    "issue",
    opts.action,
    pane,
    String(opts.number),
    ...repoFlagArgs(deps.forge),
    ...opts.buildArgs(),
  ];
  const payload = await runOp(deps, opts.label, args);
  if (payload !== null) {
    deps.ui.setStatus(`${opts.label} ok`);
    deps.onChanged?.();
    opts.onDone?.();
  }
}

// --- issue list ---------------------------------------------------------------------

/** `issue list` browser + `issue create` flow. */
export class IssueListView implements ScreenView {
  private readonly deps: ForgeTuiDeps;
  private readonly onOpenIssue: (number: number) => void;
  private readonly list: SelectList<Record<string, unknown>>;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorKind: string | null = null;
  private errorTextValue = "";
  private state: "open" | "closed" | "all" = "open";
  private labelFilter = "";
  private issues: Record<string, unknown>[] = [];

  constructor(deps: ForgeTuiDeps, onOpenIssue: (number: number) => void) {
    this.deps = deps;
    this.onOpenIssue = onOpenIssue;
    this.list = new SelectList<Record<string, unknown>>({
      items: [],
      filterable: true,
      emptyText: "no issues",
    });
    this.list.onSelect = (item) => {
      const n = num(item.value?.number);
      if (n !== null) this.onOpenIssue(n);
    };
    this.list.onCancel = () => this.deps.ui.pop();
    void this.load();
  }

  async load(): Promise<void> {
    this.phase = "loading";
    this.deps.ui.invalidate();
    const flags = ["--state", this.state, "--limit", "50"];
    if (this.labelFilter !== "") {
      for (const label of this.labelFilter
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")) {
        flags.push("--label", label);
      }
    }
    const args = forgeArgs(this.deps, "issue", "list", [], flags);
    if (args === null) {
      this.phase = "error";
      this.errorKind = null;
      this.errorTextValue = "no pane pinned — press p to set a pane id";
      this.deps.ui.invalidate();
      return;
    }
    try {
      const payload = await readOp(this.deps, "issue list", args);
      this.issues = asArray(payload.issues);
      this.list.setItems(this.issues.map(issueSelectItem));
      this.phase = "ready";
      this.errorKind = null;
      this.errorTextValue = "";
    } catch (err) {
      this.phase = "error";
      this.errorKind = err instanceof GitCliError ? err.kind : null;
      this.errorTextValue = errorText(err);
    }
    this.deps.ui.invalidate();
  }

  private cycleState(): void {
    this.state = this.state === "open" ? "closed" : this.state === "closed" ? "all" : "open";
    this.deps.ui.setStatus(`issue state filter → ${this.state}`);
    void this.load();
  }

  private async labelFilterFlow(): Promise<void> {
    const input = await this.deps.ui.prompt(
      "Label filter (comma-separated — empty clears)",
      this.labelFilter !== "" ? { value: this.labelFilter } : {},
    );
    if (input === null) return;
    this.labelFilter = input.trim();
    this.deps.ui.setStatus(
      this.labelFilter === "" ? "label filter cleared" : `label filter → ${this.labelFilter}`,
    );
    void this.load();
  }

  /** `issue create` — title required; body/labels/assignees optional. */
  private async createFlow(): Promise<void> {
    if (!gate(this.deps, "issue")) return;
    const titleInput = await this.deps.ui.prompt("Issue title (required)");
    if (titleInput === null) return;
    const title = titleInput.trim();
    if (title === "") {
      this.deps.ui.setStatus("empty title — cancelled");
      return;
    }
    const body = await this.deps.ui.prompt(
      "Issue body (optional — single line; use CLI --body-file for long text)",
    );
    if (body === null) return;
    const labelsInput = await this.deps.ui.prompt("Labels (comma-separated — optional)");
    if (labelsInput === null) return;
    const assigneesInput = await this.deps.ui.prompt("Assignees (comma-separated — optional)");
    if (assigneesInput === null) return;
    const split = (raw: string): string[] =>
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    const labels = split(labelsInput);
    const assignees = split(assigneesInput);
    const ok = await this.deps.ui.confirm({
      title: "Create issue?",
      target: [
        `title: ${title}`,
        ...(body.trim() !== "" ? [`body: ${body.trim().slice(0, 120)}`] : []),
        ...(labels.length > 0 ? [`labels: ${labels.join(", ")}`] : []),
        ...(assignees.length > 0 ? [`assignees: ${assignees.join(", ")}`] : []),
        `repo: ${this.deps.forge.repoOverride ?? "(pane repo)"}`,
        `pane: ${this.deps.forge.paneId ?? "?"}`,
        `target: ${formatTargetLabel(this.deps.target)}`,
      ],
      consequence: "creates an issue on the forge (visible to collaborators)",
      confirmLabel: "Create issue",
    });
    if (!ok) return;
    const flags = [
      "--title",
      title,
      ...(body.trim() !== "" ? ["--body", body.trim()] : []),
      ...labels.flatMap((l) => ["--label", l]),
      ...assignees.flatMap((a) => ["--assignee", a]),
    ];
    const args = forgeArgs(this.deps, "issue", "create", [], flags);
    if (args === null) return;
    const payload = await runOp(this.deps, "issue create", args);
    if (payload !== null) {
      const url = str(payload.url);
      const number = num(payload.number);
      this.deps.ui.setStatus(
        `issue created${number !== null ? ` #${number}` : ""}${url !== null ? ` — ${url}` : ""}`,
      );
      this.deps.onChanged?.();
      await this.load();
      if (number !== null) this.onOpenIssue(number);
    }
  }

  render(width: number, height: number): Line[] {
    if (this.phase !== "ready") {
      const lines: Line[] = [];
      if (this.phase === "loading") {
        lines.push([{ text: `loading issues (${this.state})…`, style: { dim: true } }]);
      } else {
        lines.push([{ text: "failed to load issues", style: { bold: true, fg: "red" } }]);
        for (const l of forgeErrorLines(this.errorKind, this.errorTextValue)) {
          lines.push([{ text: clip(l, width), style: { fg: "red" } }]);
        }
        lines.push([{ text: "R — retry · p — set pane · esc — back", style: { dim: true } }]);
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
      case "s":
        this.cycleState();
        return true;
      case "l":
        void this.labelFilterFlow();
        return true;
      case "n":
        void this.createFlow();
        return true;
      case "r":
      case "R":
        void this.load();
        return true;
      default:
        return handleTargetKeys(this.deps, ev);
    }
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "open issue" },
      { keys: "s", description: "cycle state filter" },
      { keys: "l", description: "label filter" },
      { keys: "n", description: "create issue" },
      { keys: ["r", "R"], description: "refresh" },
      ...TARGET_KEYMAP,
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- issue detail ---------------------------------------------------------------------

/** Issue view + comment/edit/close-reopen actions. */
export class IssueDetailView implements ScreenView {
  private readonly deps: ForgeTuiDeps;
  private readonly number: number;
  private issue: Record<string, unknown> | null = null;
  private phase: "loading" | "ready" | "error" = "loading";
  private errorKind: string | null = null;
  private errorTextValue = "";
  private readonly body = new ScrollBody();

  constructor(deps: ForgeTuiDeps, number: number) {
    this.deps = deps;
    this.number = number;
    void this.load();
  }

  private get openedUpdatedAt(): string | null {
    const issue = asRecord(this.issue);
    return issue !== null ? str(issue.updated_at) : null;
  }

  async load(): Promise<void> {
    this.phase = "loading";
    this.body.scroll = 0;
    this.deps.ui.invalidate();
    const args = forgeArgs(this.deps, "issue", "view", [this.number]);
    if (args === null) {
      this.phase = "error";
      this.errorKind = null;
      this.errorTextValue = "no pane pinned — press p to set a pane id";
      this.deps.ui.invalidate();
      return;
    }
    try {
      const payload = await readOp(this.deps, "issue view", args);
      const issue = asRecord(payload.issue);
      if (issue === null) {
        this.phase = "error";
        this.errorKind = null;
        this.errorTextValue = "issue view returned no issue payload";
      } else {
        this.issue = issue;
        this.phase = "ready";
        this.errorKind = null;
        this.errorTextValue = "";
      }
    } catch (err) {
      this.phase = "error";
      this.errorKind = err instanceof GitCliError ? err.kind : null;
      this.errorTextValue = errorText(err);
    }
    this.deps.ui.invalidate();
  }

  private issueTargetLines(): string[] {
    const issue = asRecord(this.issue);
    return [
      `issue: #${this.number} ${issue !== null ? String(issue.title ?? "") : ""}`,
      `state: ${issue !== null ? String(issue.state ?? "?") : "?"}`,
      `repo: ${this.deps.forge.repoOverride ?? "(pane repo)"}`,
      `pane: ${this.deps.forge.paneId ?? "?"}`,
      `target: ${formatTargetLabel(this.deps.target)}`,
    ];
  }

  private commentFlow(): void {
    void (async () => {
      const body = await this.deps.ui.prompt("Issue comment body (required)");
      if (body === null) return;
      const text = body.trim();
      if (text === "") {
        this.deps.ui.setStatus("empty comment — cancelled");
        return;
      }
      if (!gate(this.deps, "issue")) return;
      const ok = await this.deps.ui.confirm({
        title: "Post issue comment?",
        target: [...this.issueTargetLines(), `body: ${text.slice(0, 160)}`],
        consequence: "posts a public comment on the issue",
        confirmLabel: "Post",
      });
      if (!ok) return;
      const fresh = await revalidateIssue(this.deps, this.number, this.openedUpdatedAt);
      if (fresh === null) return;
      const pane = this.deps.forge.paneId;
      if (pane === null) return;
      const args = [
        "issue",
        "comment",
        pane,
        String(this.number),
        ...repoFlagArgs(this.deps.forge),
        "--body",
        text,
      ];
      const result = await runOp(this.deps, "issue comment", args);
      if (result !== null) {
        this.deps.ui.setStatus("comment posted");
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  /** `issue edit` — any subset of title/body/labels/assignees/state. */
  private editFlow(): void {
    void (async () => {
      const issue = asRecord(this.issue);
      const currentTitle = issue !== null ? (str(issue.title) ?? "") : "";
      const titleInput = await this.deps.ui.prompt("New title (empty keeps current)", {
        value: currentTitle,
      });
      if (titleInput === null) return;
      const title = titleInput.trim();

      const stateItem = await this.deps.ui.select({
        items: [
          {
            value: "keep",
            label: "Keep state",
            detail: `current: ${issue !== null ? String(issue.state ?? "?") : "?"}`,
          },
          { value: "open", label: "Open", detail: "reopen / mark open" },
          { value: "closed", label: "Closed", detail: "close the issue" },
        ],
      });
      const state = str(stateItem?.value) ?? "keep";

      const addLabels = await this.deps.ui.prompt(
        "Labels to add (comma-separated — empty for none)",
      );
      if (addLabels === null) return;
      const removeLabels = await this.deps.ui.prompt(
        "Labels to remove (comma-separated — empty for none)",
      );
      if (removeLabels === null) return;
      const addAssignees = await this.deps.ui.prompt(
        "Assignees to add (comma-separated — empty for none)",
      );
      if (addAssignees === null) return;
      const removeAssignees = await this.deps.ui.prompt(
        "Assignees to remove (comma-separated — empty for none)",
      );
      if (removeAssignees === null) return;

      const split = (raw: string): string[] =>
        raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
      const aLabels = split(addLabels);
      const rLabels = split(removeLabels);
      const aAssignees = split(addAssignees);
      const rAssignees = split(removeAssignees);
      const hasChange =
        (title !== "" && title !== currentTitle) ||
        state !== "keep" ||
        aLabels.length > 0 ||
        rLabels.length > 0 ||
        aAssignees.length > 0 ||
        rAssignees.length > 0;
      if (!hasChange) {
        this.deps.ui.setStatus("no changes — cancelled");
        return;
      }

      const flags: string[] = [];
      if (title !== "" && title !== currentTitle) flags.push("--title", title);
      if (state !== "keep") flags.push("--state", state);
      for (const l of aLabels) flags.push("--add-label", l);
      for (const l of rLabels) flags.push("--remove-label", l);
      for (const a of aAssignees) flags.push("--add-assignee", a);
      for (const a of rAssignees) flags.push("--remove-assignee", a);

      if (!gate(this.deps, "issue")) return;
      const ok = await this.deps.ui.confirm({
        title: "Edit issue?",
        target: [
          ...this.issueTargetLines(),
          ...(title !== "" && title !== currentTitle ? [`new title: ${title}`] : []),
          ...(state !== "keep" ? [`new state: ${state}`] : []),
          ...(aLabels.length > 0 ? [`add labels: ${aLabels.join(", ")}`] : []),
          ...(rLabels.length > 0 ? [`remove labels: ${rLabels.join(", ")}`] : []),
          ...(aAssignees.length > 0 ? [`add assignees: ${aAssignees.join(", ")}`] : []),
          ...(rAssignees.length > 0 ? [`remove assignees: ${rAssignees.join(", ")}`] : []),
        ],
        consequence: "updates the issue on the forge (title/state/labels/assignees)",
        confirmLabel: "Apply edit",
      });
      if (!ok) return;
      await mutateIssue(this.deps, {
        number: this.number,
        label: "issue edit",
        action: "edit",
        confirm: null, // confirmation already shown above
        buildArgs: () => flags,
        openedUpdatedAt: this.openedUpdatedAt,
        onDone: () => void this.load(),
      });
    })();
  }

  /** `issue close` (with reason) / reopen via `issue edit --state open`. */
  private closeReopenFlow(): void {
    void (async () => {
      const issue = asRecord(this.issue);
      const state = issue !== null ? str(issue.state)?.toLowerCase() : null;
      if (state === "closed" || state === "closed".toUpperCase()) {
        // Reopen path: issue edit --state open (close only closes).
        if (!gate(this.deps, "issue")) return;
        const ok = await this.deps.ui.confirm({
          title: "Reopen issue?",
          target: this.issueTargetLines(),
          consequence: "reopens the issue on the forge",
          confirmLabel: "Reopen",
        });
        if (!ok) return;
        const fresh = await revalidateIssue(this.deps, this.number, this.openedUpdatedAt);
        if (fresh === null) return;
        const pane = this.deps.forge.paneId;
        if (pane === null) return;
        const result = await runOp(this.deps, "issue reopen", [
          "issue",
          "edit",
          pane,
          String(this.number),
          ...repoFlagArgs(this.deps.forge),
          "--state",
          "open",
        ]);
        if (result !== null) {
          this.deps.ui.setStatus("issue reopened");
          this.deps.onChanged?.();
          await this.load();
        }
        return;
      }
      // Close path.
      const reasonItem = await this.deps.ui.select({
        items: [
          { value: "completed", label: "Completed", detail: "close as completed" },
          { value: "not planned", label: "Not planned", detail: "close as not planned" },
          { value: "", label: "No reason", detail: "close without a reason" },
        ],
      });
      const reason = str(reasonItem?.value);
      if (reason === null) return;
      if (!gate(this.deps, "issue")) return;
      const ok = await this.deps.ui.confirm({
        title: "Close issue?",
        target: [...this.issueTargetLines(), ...(reason !== "" ? [`reason: ${reason}`] : [])],
        consequence: "closes the issue on the forge",
        confirmLabel: "Close",
      });
      if (!ok) return;
      const fresh = await revalidateIssue(this.deps, this.number, this.openedUpdatedAt);
      if (fresh === null) return;
      const pane = this.deps.forge.paneId;
      if (pane === null) return;
      const result = await runOp(this.deps, "issue close", [
        "issue",
        "close",
        pane,
        String(this.number),
        ...repoFlagArgs(this.deps.forge),
        ...(reason !== "" ? ["--reason", reason] : []),
      ]);
      if (result !== null) {
        this.deps.ui.setStatus("issue closed");
        this.deps.onChanged?.();
        await this.load();
      }
    })();
  }

  private openUrl(): void {
    const url = this.issue !== null ? str(this.issue.url) : null;
    if (url === null) {
      this.deps.ui.setStatus("no issue url in payload");
      return;
    }
    void openExternal(url).then((res) => {
      this.deps.ui.setStatus(res.ok ? `opened ${url}` : `open failed: ${res.reason} — ${url}`);
    });
  }

  render(width: number, height: number): Line[] {
    if (this.phase === "loading") {
      return renderScrollable(`issue #${this.number}`, ["loading…"], this.body, width, height, "");
    }
    if (this.phase === "error") {
      return renderScrollable(
        `issue #${this.number}`,
        forgeErrorLines(this.errorKind, this.errorTextValue),
        this.body,
        width,
        height,
        "R — retry · esc — back",
      );
    }
    return renderScrollable(
      `issue #${this.number}`,
      this.issue !== null ? formatIssueView(this.issue) : [],
      this.body,
      width,
      height,
      "c comment · e edit · x close/reopen · u url · R refresh",
    );
  }

  handleKey(ev: KeyEvent): boolean {
    if (this.phase !== "ready") {
      if (scrollKeys(ev, this.body)) return true;
      if (ev.kind === "key" && !ev.ctrl && !ev.alt && (ev.key === "r" || ev.key === "R")) {
        void this.load();
        return true;
      }
      return handleTargetKeys(this.deps, ev);
    }
    if (scrollKeys(ev, this.body)) return true;
    if (ev.kind !== "key" || ev.ctrl || ev.alt) return handleTargetKeys(this.deps, ev);
    switch (ev.key) {
      case "c":
        this.commentFlow();
        return true;
      case "e":
        this.editFlow();
        return true;
      case "x":
        this.closeReopenFlow();
        return true;
      case "u":
        this.openUrl();
        return true;
      case "R":
        void this.load();
        return true;
      default:
        return handleTargetKeys(this.deps, ev);
    }
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      { keys: "c", description: "post comment" },
      { keys: "e", description: "edit title/state/labels/assignees" },
      { keys: "x", description: "close / reopen" },
      { keys: "u", description: "open issue url externally" },
      { keys: ["R"], description: "refresh" },
      ...TARGET_KEYMAP,
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}
