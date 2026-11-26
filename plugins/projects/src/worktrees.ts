/**
 * Repo ↔ worktree/diff read association for rebuildup.projects
 * (#184, design verdict ADR-0029 §2).
 *
 * For each registry member repo root the plugin asks herdr
 * `worktree.list` (socket method, `trust_repository: false` — an
 * untrusted-repo failure is reported honestly, never retried with a
 * trust grant) and cross-checks `source.repo_root` against the member
 * root. Each returned checkout is verified with the same
 * `git rev-parse --git-common-dir` identity primitive the #180
 * triggers use — the authoritative same-repo test that covers linked
 * worktrees whose toplevel differs from the member root.
 *
 * Per-worktree liveness reuses `inspectRepo` (branch / dirty /
 * has_submodules — the same bounded git calls `repos list` already
 * performs per member).
 *
 * Diff surface constraint: `herdr-plugins.git/v1` is pane-addressed.
 * A worktree with `open_workspace_id` resolves to panes via
 * `session.snapshot`, and each pane gets (a) pane-addressed git-v1
 * command pointers and (b) a live `status` summary fetched through the
 * sibling git plugin's public CLI (ADR-0013 env-pin spawn — never its
 * state files, never mutations). A worktree with no open workspace
 * reports path/branch/dirty only — no diff fields are fabricated, and
 * the plugin never opens panes/workspaces itself (lifecycle stays
 * herdr/Worktrunk).
 */

import { existsSync } from "node:fs";
import { GitError, type RepoInfo, resolveRepo } from "../../../packages/git-core/src/index";
import {
  type CallOptions,
  HerdrRpcError,
  resolveSocketPath,
  type SessionSnapshot,
  type WorktreeListResult,
  worktreeList,
} from "../../../packages/herdr-client/src/index";
import { canonicalRepoRoot, inspectRepo, type RepoLiveInfo } from "./model";
import {
  GIT_CONTRACT,
  type GitPluginCliResult,
  type GitPluginRootResolution,
  runGitPluginCli,
} from "./plugincli";

/** Bound on sibling-CLI `status` spawns per member repo (all worktrees). */
export const MAX_GIT_STATUS_CALLS = 8;

export interface WorktreeGitStatus {
  contract: typeof GIT_CONTRACT;
  ok: true;
  /** Repo root the git plugin resolved from the pane cwd (may differ
   *  from the worktree path when the pane sits in a subdirectory). */
  repo_root: string | null;
  branch: string | null;
  detached: boolean;
  changes: {
    staged: number;
    unstaged: number;
    untracked: number;
    conflicted: number;
  } | null;
}

export interface WorktreePaneRef {
  pane_id: string;
  workspace_id: string | null;
  cwd: string | null;
  /**
   * Pane-addressed `herdr-plugins.git/v1` read commands a consumer can
   * invoke (status/diff/files/compare). Pointers only — the projects
   * plugin does not fetch diff payloads itself.
   */
  commands: { status: string; diff: string; files: string; compare: string };
  /** Live `status` summary via the sibling git plugin CLI. */
  status: WorktreeGitStatus | null;
  status_error: { kind: string; message: string } | null;
}

export interface AssociatedWorktree {
  path: string;
  /** Live git inspection; null when the checkout is unreachable. */
  branch: string | null;
  dirty: boolean | null;
  has_submodules: boolean | null;
  is_linked_worktree: boolean;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  label: string | null;
  /** herdr workspace the worktree is open in; null when closed/unknown. */
  open_workspace_id: string | null;
  /**
   * Panes of the open workspace resolved from the session snapshot.
   * Empty when the worktree has no open workspace OR the id is stale —
   * `panes_unavailable` distinguishes the two.
   */
  panes: WorktreePaneRef[];
  /**
   * True when `open_workspace_id` was set but no panes could be
   * resolved (stale id or unreachable snapshot). Diff pointers are
   * absent — never fabricated.
   */
  panes_unavailable: boolean;
}

export interface WorktreeAssociationSkip {
  path: string;
  reason: string;
  detail?: string;
}

export type WorktreeAssociation =
  | { ok: true; worktrees: AssociatedWorktree[]; skipped: WorktreeAssociationSkip[] }
  | { ok: false; error: { reason: string; detail?: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bool(value: unknown): boolean {
  return value === true;
}

/** True for socket-level failures (ENOENT/ECONNREFUSED/timeout), not RPC errors. */
function isConnectionError(err: unknown): boolean {
  return !(err instanceof HerdrRpcError) && !(err instanceof GitError);
}

function paneCommands(paneId: string): WorktreePaneRef["commands"] {
  return {
    status: `status ${paneId}`,
    diff: `diff ${paneId}`,
    files: `files ${paneId}`,
    compare: `compare ${paneId} <base> <head>`,
  };
}

interface GitStatusJson {
  contract?: unknown;
  repo?: { root?: unknown };
  branch?: { name?: unknown; detached?: unknown };
  changes?: Record<string, unknown>;
}

function changeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Fetch a compact `status` summary for one pane through the sibling
 * git plugin CLI. Returns a structured result — plugin absence, spawn
 * failure, non-zero exit, contract mismatch, and git-plugin errors all
 * degrade to `status: null` + `status_error`, never a thrown error.
 */
async function fetchPaneGitStatus(
  gitRoot: { root: string } | null,
  gitRootError: string | null,
  paneId: string,
  socketPath: string,
  timeoutMs: number,
): Promise<{ status: WorktreeGitStatus | null; error: { kind: string; message: string } | null }> {
  if (gitRoot === null) {
    return {
      status: null,
      error: { kind: "plugin_unavailable", message: gitRootError ?? "git plugin unavailable" },
    };
  }
  let run: GitPluginCliResult;
  try {
    run = await runGitPluginCli(gitRoot.root, ["status", paneId], { socketPath, timeoutMs });
  } catch (err) {
    return {
      status: null,
      error: {
        kind: "spawn_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
  if (run.status !== 0 || run.json === null) {
    const kind = run.error?.kind ?? "git_plugin_error";
    const message =
      run.error?.message ??
      run.stderr.trim().slice(0, 300) ??
      `git plugin status exited ${run.status}`;
    return { status: null, error: { kind, message } };
  }
  const json = run.json as GitStatusJson;
  if (json.contract !== GIT_CONTRACT) {
    return {
      status: null,
      error: {
        kind: "contract_mismatch",
        message: `expected ${GIT_CONTRACT}, got ${String(json.contract)}`,
      },
    };
  }
  const changes = isRecord(json.changes) ? json.changes : null;
  const staged = changeCount(changes?.staged);
  const unstaged = changeCount(changes?.unstaged);
  const untracked = changeCount(changes?.untracked);
  const conflicted = changeCount(changes?.conflicted);
  return {
    status: {
      contract: GIT_CONTRACT,
      ok: true,
      repo_root: str(json.repo?.root) ?? null,
      branch: str(json.branch?.name) ?? null,
      detached: json.branch?.detached === true,
      changes:
        staged !== null && unstaged !== null && untracked !== null && conflicted !== null
          ? { staged, unstaged, untracked, conflicted }
          : null,
    },
    error: null,
  };
}

export interface AssociateOptions {
  /** Socket/session targeting for `worktree.list` + `session.snapshot`. */
  call: CallOptions;
  timeoutMs: number;
  /** Pre-fetched snapshot; null when unavailable (panes stay empty). */
  snapshot: SessionSnapshot | null;
  /**
   * Lazy git-plugin root resolver, invoked at most once per `repos
   * list` call and only when at least one pane needs a status fetch.
   */
  resolveGitRoot: () => Promise<GitPluginRootResolution>;
}

/**
 * Associate one registry member repo with herdr worktrees. `memberRoot`
 * must already be a reachable git work tree (the caller's live
 * inspection succeeded); failures of the association itself are
 * reported structurally — `repos list` degrades per-member, never
 * fails wholesale.
 */
export async function associateRepoWorktrees(
  memberRoot: string,
  options: AssociateOptions,
): Promise<WorktreeAssociation> {
  const gitOptions = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };

  // Member identity: git-common-dir is the authoritative same-repo key
  // (linked worktrees share it; toplevels differ).
  let memberInfo: RepoInfo;
  try {
    memberInfo = await resolveRepo(memberRoot, gitOptions);
  } catch (err) {
    if (err instanceof GitError) {
      return { ok: false, error: { reason: err.kind, detail: err.message } };
    }
    throw err;
  }
  const memberCommonDir = canonicalRepoRoot(memberInfo.gitCommonDir);

  let listed: WorktreeListResult;
  try {
    listed = await worktreeList(memberRoot, options.call);
  } catch (err) {
    if (err instanceof HerdrRpcError) {
      return { ok: false, error: { reason: err.code, detail: err.message } };
    }
    if (isConnectionError(err)) {
      return {
        ok: false,
        error: {
          reason: "session_unreachable",
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }
    throw err;
  }

  // Cross-check the reported source repo against the member root —
  // a mismatch means herdr resolved a different repository; skip
  // honestly rather than attribute foreign worktrees.
  const sourceRoot = str(listed.source?.repo_root);
  if (sourceRoot !== undefined) {
    const canonical = canonicalRepoRoot(sourceRoot);
    if (canonical !== canonicalRepoRoot(memberInfo.root)) {
      return {
        ok: false,
        error: {
          reason: "repo_mismatch",
          detail: `worktree.list source ${sourceRoot} does not match member ${memberInfo.root}`,
        },
      };
    }
  }

  const entries = Array.isArray(listed.worktrees) ? listed.worktrees : [];
  const worktrees: AssociatedWorktree[] = [];
  const skipped: WorktreeAssociationSkip[] = [];
  const skip = (pathValue: string, reason: string, detail?: string): void => {
    skipped.push({ path: pathValue, reason, ...(detail !== undefined ? { detail } : {}) });
  };

  // Resolve panes for every open workspace id up front; the git-plugin
  // root resolves lazily on first use.
  let gitRootPromise: Promise<{ root: string } | { error: string }> | null = null;
  const gitRoot = (): Promise<{ root: string } | { error: string }> => {
    gitRootPromise ??= options
      .resolveGitRoot()
      .then((resolved) => (resolved.ok ? { root: resolved.root } : { error: resolved.error }));
    return gitRootPromise;
  };
  let statusBudget = MAX_GIT_STATUS_CALLS;
  // Mirror commands.ts socketFor(): explicit socketPath wins, then
  // session/env resolution.
  const socketPath =
    options.call.socketPath ?? resolveSocketPath({ session: options.call.session });

  for (const entry of entries) {
    const wtPath = str(entry.path);
    if (wtPath === undefined) {
      skip("<unknown>", "no_path");
      continue;
    }
    if (!existsSync(wtPath)) {
      skip(wtPath, "worktree_gone");
      continue;
    }

    // Same-repo test: the checkout's git-common-dir must equal the
    // member's. Anything else is a foreign worktree — skipped, not
    // attributed.
    let info: RepoInfo;
    try {
      info = await resolveRepo(wtPath, gitOptions);
    } catch (err) {
      skip(wtPath, err instanceof GitError ? err.kind : "repo_unreachable");
      continue;
    }
    if (canonicalRepoRoot(info.gitCommonDir) !== memberCommonDir) {
      skip(wtPath, "not_member_repo");
      continue;
    }

    let live: RepoLiveInfo;
    try {
      live = await inspectRepo(info.root, gitOptions);
    } catch (err) {
      skip(wtPath, err instanceof GitError ? err.kind : "repo_unreachable");
      continue;
    }

    const openWorkspaceId = str(entry.open_workspace_id) ?? null;
    const snapshotPanes =
      openWorkspaceId !== null && options.snapshot !== null
        ? (options.snapshot.panes ?? []).filter((p) => p.workspace_id === openWorkspaceId)
        : [];
    const panesUnavailable = openWorkspaceId !== null && snapshotPanes.length === 0;

    const panes: WorktreePaneRef[] = [];
    for (const pane of snapshotPanes) {
      const paneId = str(pane.pane_id);
      if (paneId === undefined) continue;
      const cwd =
        str(pane.cwd) ?? str((pane as { foreground_cwd?: unknown }).foreground_cwd) ?? null;
      let status: WorktreeGitStatus | null = null;
      let statusError: { kind: string; message: string } | null = null;
      if (cwd !== null && statusBudget > 0) {
        statusBudget -= 1;
        const resolved = await gitRoot();
        const fetched = await fetchPaneGitStatus(
          "root" in resolved ? resolved : null,
          "error" in resolved ? resolved.error : null,
          paneId,
          socketPath,
          options.timeoutMs,
        );
        status = fetched.status;
        statusError = fetched.error;
      } else if (cwd !== null) {
        statusError = { kind: "budget_exceeded", message: "git status budget exhausted" };
      }
      panes.push({
        pane_id: paneId,
        workspace_id: str(pane.workspace_id) ?? openWorkspaceId,
        cwd,
        commands: paneCommands(paneId),
        status,
        status_error: statusError,
      });
    }

    worktrees.push({
      path: wtPath,
      branch: live.branch,
      dirty: live.dirty,
      has_submodules: live.has_submodules,
      is_linked_worktree: bool(entry.is_linked_worktree),
      is_bare: bool(entry.is_bare),
      is_detached: bool(entry.is_detached),
      is_prunable: bool(entry.is_prunable),
      label: str(entry.label) ?? null,
      open_workspace_id: openWorkspaceId,
      panes,
      panes_unavailable: panesUnavailable,
    });
  }

  return { ok: true, worktrees, skipped };
}
