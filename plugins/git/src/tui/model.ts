/**
 * Pure view-model helpers for the rebuildup.git TUI (`src/tui.ts`).
 *
 * Everything here is synchronous and side-effect free so the unit tests
 * (`tests/git-tui.test.ts`) can pin the formatting/parsing contract
 * without a TTY or a herdr session. Async collectors live in `repo.ts`;
 * screen composition lives in `app.ts`.
 *
 * Contract notes (docs/contracts/tui-v1.md, ADR-0031/0033):
 * - the target identity is pinned at launch from HERDR_PLUGIN_CONTEXT_JSON
 *   (origin pane), never from HERDR_PANE_ID (that is the UI pane itself);
 * - untrusted strings (paths, subjects, remotes) are rendered raw — the
 *   packages/tui renderer sanitizes CSI/OSC before output.
 */

import type { BranchInfo, ChangeCounts, FileChange, LogCommit } from "../git";

// --- Launch context / target identity -----------------------------------------

export interface PluginContextIdentity {
  /** Origin pane the surface was launched from (the git target). */
  focusedPaneId: string | null;
  workspaceId: string | null;
  tabId: string | null;
  /** Raw parsed context for callers that need more fields. */
  raw: Record<string, unknown>;
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Parse `HERDR_PLUGIN_CONTEXT_JSON`. Returns null when the variable is
 * absent or unparseable — callers must treat that as "no pinned target",
 * never guess from ambient state.
 */
export function parsePluginContext(raw: string | undefined): PluginContextIdentity | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return {
      focusedPaneId: nonEmpty(parsed.focused_pane_id),
      workspaceId: nonEmpty(parsed.workspace_id),
      tabId: nonEmpty(parsed.tab_id),
      raw: parsed,
    };
  } catch {
    return null;
  }
}

export interface TuiTargetSpec {
  /** Origin pane id pinned at launch; null when launched with --cwd only. */
  paneId: string | null;
  /** Optional explicit repo cwd (--cwd flag / HERDR_TUI_TARGET_CWD). */
  cwd: string | null;
  workspaceId: string | null;
}

/**
 * Resolve the pinned target spec from the process environment.
 * Precedence: explicit `HERDR_TUI_TARGET_PANE_ID`/`HERDR_TUI_TARGET_CWD`
 * (set by the `open` action helper) > context `focused_pane_id` >
 * context workspace (paneId stays null; cwd may come from --cwd).
 * `HERDR_PANE_ID` is deliberately NOT consulted: inside a pane-backed
 * plugin pane it identifies the UI pane itself (tui-v1 §3.2).
 */
export function resolveTargetSpec(
  env: NodeJS.ProcessEnv = process.env,
  cliCwd?: string,
): TuiTargetSpec {
  const context = parsePluginContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  const paneId = nonEmpty(env.HERDR_TUI_TARGET_PANE_ID) ?? context?.focusedPaneId ?? null;
  const cwd = cliCwd ?? nonEmpty(env.HERDR_TUI_TARGET_CWD) ?? nonEmpty(env.HERDR_TUI_CWD) ?? null;
  return {
    paneId,
    cwd,
    workspaceId: context?.workspaceId ?? null,
  };
}

/**
 * argv for `herdr plugin pane open` used by the `open` action. Pure so
 * the exact invocation is unit-testable. Returns null when no herdr
 * binary path is knowable — callers fall back to "herdr" on PATH.
 */
export function buildPaneOpenArgs(spec: {
  pluginId: string;
  entrypoint: string;
  placement: string;
  workspaceId: string | null;
  targetPaneId: string | null;
}): string[] {
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    spec.pluginId,
    "--entrypoint",
    spec.entrypoint,
    "--placement",
    spec.placement,
  ];
  if (spec.workspaceId) args.push("--workspace", spec.workspaceId);
  if (spec.targetPaneId) {
    args.push("--env", `HERDR_TUI_TARGET_PANE_ID=${spec.targetPaneId}`);
  }
  return args;
}

// --- Display formatting ---------------------------------------------------------

export function shortSha(sha: string, len = 7): string {
  return sha.length <= len ? sha : sha.slice(0, len);
}

/** One-line branch badge for the status line / headers. */
export function formatBranchLine(branch: BranchInfo): string {
  if (branch.detached) return "HEAD (detached)";
  const parts = [branch.name];
  if (branch.upstream) {
    parts.push(`-> ${branch.upstream}`);
    if (branch.ahead !== null && branch.ahead > 0) parts.push(`ahead ${branch.ahead}`);
    if (branch.behind !== null && branch.behind > 0) parts.push(`behind ${branch.behind}`);
    if ((branch.ahead ?? 0) === 0 && (branch.behind ?? 0) === 0) parts.push("up to date");
  } else {
    parts.push("(no upstream)");
  }
  return parts.join(" ");
}

/** Compact change counts for the status line. */
export function formatChangeCounts(counts: ChangeCounts): string {
  const total = counts.staged + counts.unstaged + counts.untracked + counts.conflicted;
  if (total === 0) return "clean";
  const parts: string[] = [];
  if (counts.staged > 0) parts.push(`staged ${counts.staged}`);
  if (counts.unstaged > 0) parts.push(`unstaged ${counts.unstaged}`);
  if (counts.untracked > 0) parts.push(`untracked ${counts.untracked}`);
  if (counts.conflicted > 0) parts.push(`CONFLICTS ${counts.conflicted}`);
  return parts.join(" · ");
}

const KIND_LABEL: Record<FileChange["kind"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  typechange: "type",
  untracked: "untracked",
  conflicted: "conflict",
  ignored: "ignored",
};

/** XY status columns + kind marker for a changed file row. */
export function fileStatusTag(file: FileChange): string {
  if (file.kind === "untracked") return "??";
  if (file.kind === "conflicted") return "UU";
  if (file.kind === "ignored") return "!!";
  const x = file.index === " " ? " " : file.index;
  const y = file.worktree === " " ? " " : file.worktree;
  return `${x}${y}`;
}

/** SelectList label for a changed file. */
export function fileLabel(file: FileChange): string {
  const path = file.oldPath !== null ? `${file.oldPath} -> ${file.path}` : file.path;
  return `${fileStatusTag(file)} ${KIND_LABEL[file.kind] ?? file.kind}  ${path}`;
}

/** SelectList detail (right pane / wide terminals) for a changed file. */
export function fileDetail(file: FileChange): string {
  const parts: string[] = [KIND_LABEL[file.kind] ?? file.kind];
  const flags: string[] = [];
  if (file.staged) flags.push("staged");
  if (file.unstaged) flags.push("unstaged");
  if (file.kind === "untracked") flags.push("not in index");
  if (file.binary === true) flags.push("binary");
  if (flags.length > 0) parts.push(flags.join("+"));
  if (file.oldPath !== null) parts.push(`from ${file.oldPath}`);
  return parts.join(" · ");
}

export type FileDiffScope = "staged" | "worktree" | "head" | "none";

/**
 * Which `git diff` scope shows this file's change best:
 * - untracked/ignored: no diff exists ("none" — the view says so honestly)
 * - staged-only: `--staged`
 * - unstaged-only: worktree diff
 * - both staged and unstaged: `HEAD` revision diff (covers both sides)
 * - conflicted: worktree `git diff` shows the combined conflict markers
 */
export function diffScopeFor(file: FileChange): FileDiffScope {
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

/** SelectList label for a log entry. */
export function commitLabel(commit: LogCommit): string {
  return `${shortSha(commit.sha)} ${commit.subject}`;
}

/** Detail text for a log entry (wide-terminal detail pane). */
export function commitDetail(commit: LogCommit): string {
  const lines = [
    `sha: ${commit.sha}`,
    `author: ${commit.author.name} <${commit.author.email}> ${commit.author.date}`,
    `committer: ${commit.committer.name} <${commit.committer.email}> ${commit.committer.date}`,
  ];
  if (commit.parents.length > 0) lines.push(`parents: ${commit.parents.join(" ")}`);
  return lines.join("\n");
}

// --- Branch list parsing ---------------------------------------------------------

export interface BranchEntry {
  name: string;
  /** Full ref sha (shortened for display only). */
  sha: string;
  current: boolean;
  /** Upstream short name (`origin/main`) or null. */
  upstream: string | null;
  /** `[ahead N, behind M]`-style raw upstream:track text, or null. */
  track: string | null;
}

/**
 * Parse `git for-each-ref --format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname)`
 * NUL-free tab-separated output (one branch per line).
 */
export function parseBranches(output: string): BranchEntry[] {
  const out: BranchEntry[] = [];
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const [name, head, upstream, track, sha] = line.split("\t");
    if (!name) continue;
    out.push({
      name,
      sha: sha ?? "",
      current: head === "*",
      upstream: upstream && upstream.length > 0 ? upstream : null,
      track: track && track.length > 0 ? track : null,
    });
  }
  return out;
}

export function branchLabel(entry: BranchEntry): string {
  const marker = entry.current ? "* " : "  ";
  const up = entry.upstream ? ` -> ${entry.upstream}` : "";
  const track = entry.track ? ` ${entry.track}` : "";
  return `${marker}${entry.name}${up}${track}  ${shortSha(entry.sha)}`;
}

// --- Error classification ---------------------------------------------------------

export interface HonestError {
  /** Short title for the status/detail header. */
  title: string;
  /** Explanation lines (already plain text). */
  lines: string[];
  /** Suggested CLI fallback command, when one exists. */
  cliFallback: string | null;
}

/**
 * Map a thrown error (GitError kinds, TargetResolutionError, herdr socket
 * errors) to an honest unsupported/error state (contract item 9). Never
 * fabricates a repo state.
 */
export function describeError(err: unknown, cwd: string | null): HonestError {
  const message = err instanceof Error ? err.message : String(err);
  // GitError carries `kind`; TargetResolutionError (herdr-client) carries
  // `code` — accept either so both classify honestly.
  const kind =
    typeof err === "object" && err !== null && "kind" in err
      ? String((err as { kind: unknown }).kind)
      : typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
  switch (kind) {
    case "not_a_repo":
      return {
        title: "Not a git repository",
        lines: [
          `No git work tree contains the target directory.`,
          cwd ? `target cwd: ${cwd}` : "target cwd: (unknown)",
          "",
          "This surface only works inside a git work tree.",
        ],
        cliFallback: "bun run src/cli.ts status <pane_id>",
      };
    case "bare_repo":
      return {
        title: "Bare repository",
        lines: ["The target is a bare repository; there is no work tree to show."],
        cliFallback: "bun run src/cli.ts status <pane_id>",
      };
    case "git_missing":
      return {
        title: "git not found",
        lines: [
          "The `git` executable is not on PATH for this plugin process.",
          "Install git or fix PATH, then reopen this surface.",
        ],
        cliFallback: "bun run src/cli.ts status <pane_id>",
      };
    case "timeout":
      return {
        title: "Timed out",
        lines: [`A git operation timed out.`, message],
        cliFallback: null,
      };
    case "ambient_identity_mismatch":
    case "target_required":
    case "pane_not_found":
    case "no_pane_cwd":
      return {
        title: "Target unavailable",
        lines: [message, "", "The pane this surface was opened for is gone or moved."],
        cliFallback: null,
      };
    default:
      return {
        title: "Error",
        lines: [message],
        cliFallback: "bun run src/cli.ts status <pane_id>",
      };
  }
}

/** Stale-generation marker for the pre-mutation revalidation (tui-v1 §3.3). */
export class StaleTargetError extends Error {
  readonly kind = "stale_target";
  constructor(message: string) {
    super(message);
    this.name = "StaleTargetError";
  }
}
