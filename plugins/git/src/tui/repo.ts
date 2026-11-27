/**
 * Extra async git collectors used only by the TUI (`src/tui.ts`).
 *
 * The read/mutation primitives shared with the CLI live in `../git.ts`
 * (collectStatus/collectFiles/collectDiff/collectLog/collectCompare/
 * collectStage/...); this module adds the few queries the interactive
 * surface needs that the CLI never exposed: local branch listing, HEAD
 * sha pinning for stale-generation checks, and bounded `git show` output.
 * Same spawn discipline: argv only, sanitized env, timeouts (ADR-0006).
 */

import { GitError, gitOk, runGit } from "../git";
import { type BranchEntry, parseBranches } from "./model";

export type { BranchEntry };
export { parseBranches };

const BRANCH_FORMAT =
  "%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname)";

/**
 * List local branches (`refs/heads`), newest first, with current marker,
 * upstream, and `[ahead/behind]` track info when available.
 */
export async function collectBranches(
  repoRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<BranchEntry[]> {
  const out = await gitOk(
    repoRoot,
    ["for-each-ref", `--format=${BRANCH_FORMAT}`, "--sort=-committerdate", "refs/heads"],
    options,
  );
  return parseBranches(out);
}

/** Current HEAD sha; throws GitError on unborn branches / failures. */
export async function headSha(
  repoRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  return (await gitOk(repoRoot, ["rev-parse", "HEAD"], options)).trim();
}

/** HEAD sha or null on unborn branches / any failure (never throws). */
export async function headShaOrNull(
  repoRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  try {
    return await headSha(repoRoot, options);
  } catch {
    return null;
  }
}

/**
 * Current branch name via `symbolic-ref` — correct on unborn branches
 * where `rev-parse --abbrev-ref HEAD` reports "HEAD". Returns "HEAD" for
 * detached HEAD, null when even symbolic-ref fails.
 */
export async function currentBranchName(
  repoRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  const sym = await runGit(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], options);
  if (sym.code === 0) {
    const name = sym.stdout.trim();
    if (name.length > 0) return name;
  }
  const head = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], options);
  if (head.code === 0) {
    const name = head.stdout.trim();
    if (name.length > 0) return name;
  }
  return null;
}

/**
 * Bounded `git show` for a single commit (metadata + patch). Used for
 * the log detail view; the byte cap keeps scrollback bounded (contract
 * item 10). Throws GitError("git_error") when the output exceeds the cap —
 * callers show the honest error rather than a silently truncated patch.
 */
export async function collectCommitShow(
  repoRoot: string,
  sha: string,
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<string> {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
    throw new GitError("git_error", `invalid commit sha: ${JSON.stringify(sha)}`);
  }
  const result = await runGit(repoRoot, ["show", "--no-color", "--format=fuller", sha], {
    timeoutMs: options.timeoutMs ?? 10_000,
    maxBuffer: options.maxBuffer ?? 512 * 1024,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new GitError("git_error", `git show ${sha.slice(0, 12)}: ${detail}`);
  }
  return result.stdout;
}
