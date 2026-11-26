/**
 * Checkpoint restore primitives for rebuildup.checkpoints (T2, #73).
 *
 * Restore applies a checkpoint commit to the worktree as upstream T3 Code
 * does (`GitVcsDriver.restoreCheckpoint`): `git restore --source <oid>
 * --worktree --staged -- .` synchronizes index+worktree to the captured
 * tree (paths absent from the checkpoint are removed), then bounded
 * `git clean -fd` passes delete untracked files — including files a
 * removed `.gitignore` newly exposes — until a pass reports nothing.
 * A post-verify (`git diff` worktree/index vs the checkpoint commit plus
 * a `git clean -dn` sweep) proves the result before success is reported.
 *
 * Safety contract:
 * - The caller MUST capture and persist a `pre-restore` checkpoint before
 *   invoking {@link restoreWorktree}; on any failure the repo stays
 *   recoverable through that ref.
 * - Shared-worktree isolation is enforced by the CLI layer via the herdr
 *   session snapshot ({@link panesSharingRepo}); this module stays pure
 *   git + path math so it is unit-testable without a session.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { GitError, type GitResult, gitOk, runGit } from "../../../packages/git-core/src/index";
import type { PaneInfo } from "../../../packages/herdr-client/src/index";
import { CheckpointError } from "./capture";

/** `git clean -fd` is repeated while it still prints `Removing ` lines. */
export const MAX_CLEAN_PASSES = 4;

const REMOVING_RE = /^Removing /m;
const WOULD_REMOVE_RE = /^Would remove /m;

function gitDetail(result: GitResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}

/** Count `Would remove ` entries in `git clean -dn` output. */
export function countWouldRemove(output: string): number {
  return output.split("\n").filter((line) => WOULD_REMOVE_RE.test(line)).length;
}

/**
 * Untracked files `git clean -fd` would actually delete after the index
 * is synced to `commit`. `git clean -dn` alone overcounts: a file that
 * is untracked *now* but present in the checkpoint tree becomes tracked
 * once `--staged` runs and survives. So the count is
 * `ls-files --others --exclude-standard` minus the commit's tree paths —
 * exact file granularity (a directory's files count individually).
 */
async function untrackedDeletions(
  repoRoot: string,
  commit: string,
  options: { timeoutMs?: number },
): Promise<number> {
  const [others, tree] = await Promise.all([
    gitOk(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], options),
    gitOk(repoRoot, ["ls-tree", "-r", "--name-only", "-z", commit, "--", "."], options),
  ]);
  const inTree = new Set(tree.split("\0").filter((entry) => entry !== ""));
  let count = 0;
  for (const file of others.split("\0")) {
    if (file !== "" && !inTree.has(file)) count += 1;
  }
  return count;
}

/**
 * Paths (NUL-safe via `--name-only -z`) that differ between `commit` and
 * the current index or worktree — i.e. files a restore would touch.
 * The union of `git diff <commit>` (worktree side) and
 * `git diff --cached <commit>` (index side) is used so staged-only
 * deltas are not undercounted.
 */
async function changedPaths(
  repoRoot: string,
  commit: string,
  options: { timeoutMs?: number },
): Promise<Set<string>> {
  const [worktree, index] = await Promise.all([
    gitOk(repoRoot, ["diff", "--name-only", "-z", "--no-color", commit, "--", "."], options),
    gitOk(
      repoRoot,
      ["diff", "--cached", "--name-only", "-z", "--no-color", commit, "--", "."],
      options,
    ),
  ]);
  const paths = new Set<string>();
  for (const listing of [worktree, index]) {
    for (const entry of listing.split("\0")) {
      if (entry !== "") paths.add(entry);
    }
  }
  return paths;
}

export interface RestorePlan {
  /** Tracked paths whose index or worktree content differs from the checkpoint. */
  files_to_change: number;
  /**
   * Untracked files absent from the checkpoint tree — exactly what the
   * post-restore `git clean -fd` passes would delete (ignored files are
   * excluded via `--exclude-standard`, matching `clean` without `-x`).
   */
  untracked_to_delete: number;
  /** True when restore would change nothing (still captures pre-restore). */
  already_matches: boolean;
}

/**
 * Read-only preview of what {@link restoreWorktree} would do. Never
 * mutates the repo; performs no session/isolation check (plan is safe
 * to run anywhere).
 */
export async function planRestore(
  repoRoot: string,
  commit: string,
  options: { timeoutMs?: number } = {},
): Promise<RestorePlan> {
  const paths = await changedPaths(repoRoot, commit, options);
  const untracked = await untrackedDeletions(repoRoot, commit, options);
  return {
    files_to_change: paths.size,
    untracked_to_delete: untracked,
    already_matches: paths.size === 0 && untracked === 0,
  };
}

/**
 * True when `candidate` equals `root` or lives underneath it. Both sides
 * are expected canonical (realpath) already; the comparison uses
 * path.relative so Windows casing/ separators behave like upstream's
 * `contains` helper.
 */
export function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function canonicalizeExisting(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    // Pane cwd may have been deleted; fall back to the resolved absolute
    // path so containment still works for surviving parents.
    return path.resolve(target);
  }
}

/**
 * Pane ids whose cwd is the target repo root or nested underneath it.
 * Containment (not repo resolution) is deliberate: a pane cwd inside the
 * worktree but outside every repo — e.g. a freshly created directory —
 * still shares the worktree and must count. cwds that cannot be
 * canonicalized fall back to `path.resolve`.
 */
export async function panesSharingRepo(
  panes: readonly PaneInfo[],
  repoRoot: string,
): Promise<string[]> {
  const sharing = new Set<string>();
  for (const pane of panes) {
    const cwd = pane.cwd ?? (pane as { foreground_cwd?: string }).foreground_cwd;
    if (typeof cwd !== "string" || cwd === "") continue;
    const canonical = await canonicalizeExisting(cwd);
    if (pathContains(repoRoot, canonical)) sharing.add(pane.pane_id);
  }
  return [...sharing];
}

export interface RestoreWorktreeOptions {
  timeoutMs?: number;
}

/**
 * Apply `commit` to the worktree+index of `repoRoot`, then delete
 * untracked files and verify the result. Throws CheckpointError with a
 * structured `kind` on any failure; the caller is responsible for having
 * persisted a pre-restore checkpoint first.
 */
export async function restoreWorktree(
  repoRoot: string,
  commit: string,
  options: RestoreWorktreeOptions = {},
): Promise<{ clean_passes: number }> {
  const timeoutMs = options.timeoutMs;
  const gitOptions = timeoutMs === undefined ? {} : { timeoutMs };

  // Sync index+worktree to the checkpoint tree. --ignore-skip-worktree-
  // bits mirrors upstream: v1 refuses sparse checkouts, so every
  // skip-worktree bit is manual and capture recorded the file anyway.
  const restore = await runGit(
    repoRoot,
    [
      "restore",
      "--source",
      commit,
      "--worktree",
      "--staged",
      "--ignore-skip-worktree-bits",
      "--",
      ".",
    ],
    gitOptions,
  );
  if (restore.code !== 0) {
    throw new CheckpointError(
      "restore_failed",
      `git restore --source ${commit}: ${gitDetail(restore)}`,
    );
  }

  // `git clean -fd` is repeated because removing an untracked
  // .gitignore exposes files it previously hid; bounded like upstream.
  let cleanPasses = 0;
  let stillRemoving = false;
  for (let pass = 0; pass < MAX_CLEAN_PASSES; pass += 1) {
    cleanPasses += 1;
    const clean = await runGit(repoRoot, ["clean", "-fd", "--", "."], gitOptions);
    if (clean.code !== 0) {
      throw new CheckpointError(
        "clean_failed",
        `git clean -fd (pass ${cleanPasses}): ${gitDetail(clean)}`,
      );
    }
    stillRemoving = REMOVING_RE.test(clean.stdout);
    if (!stillRemoving) break;
  }
  if (stillRemoving) {
    const dry = await runGit(repoRoot, ["clean", "-dn", "--", "."], gitOptions);
    const remaining = countWouldRemove(dry.stdout);
    throw new CheckpointError(
      "clean_incomplete",
      `untracked files remain after ${MAX_CLEAN_PASSES} git clean passes ` +
        `(${remaining} would still be removed); restore stopped before verify`,
    );
  }

  // Post-verify: worktree and index must both equal the checkpoint tree,
  // and no untracked (non-ignored) entries may remain. Any mismatch is a
  // structured failure — the pre-restore checkpoint still allows recovery.
  const worktreeDiff = await runGit(repoRoot, ["diff", "--quiet", commit, "--", "."], gitOptions);
  if (worktreeDiff.code !== 0 && worktreeDiff.code !== 1) {
    throw new GitError("git_error", `git diff --quiet ${commit}: ${gitDetail(worktreeDiff)}`);
  }
  const indexDiff = await runGit(
    repoRoot,
    ["diff", "--cached", "--quiet", commit, "--", "."],
    gitOptions,
  );
  if (indexDiff.code !== 0 && indexDiff.code !== 1) {
    throw new GitError("git_error", `git diff --cached --quiet ${commit}: ${gitDetail(indexDiff)}`);
  }
  const dry = await runGit(repoRoot, ["clean", "-dn", "--", "."], gitOptions);
  const remainingUntracked = countWouldRemove(dry.stdout);
  if (worktreeDiff.code === 1 || indexDiff.code === 1 || remainingUntracked > 0) {
    const parts: string[] = [];
    if (worktreeDiff.code === 1) parts.push("worktree differs from checkpoint");
    if (indexDiff.code === 1) parts.push("index differs from checkpoint");
    if (remainingUntracked > 0) parts.push(`${remainingUntracked} untracked entries remain`);
    throw new CheckpointError(
      "restore_verify_failed",
      `post-restore verification failed: ${parts.join("; ")}`,
    );
  }

  return { clean_passes: cleanPasses };
}
