/**
 * Checkpoint capture/read/delete primitives for rebuildup.checkpoints.
 *
 * A checkpoint is a synthetic commit parented to the repo's HEAD whose
 * tree was built through a *temporary* index (`GIT_INDEX_FILE` under the
 * git common dir): seeded from HEAD, refreshed with `git add -A`, then
 * `write-tree` → `commit-tree -p HEAD` → `update-ref`. The user's real
 * index, staging area, and worktree are never touched (ADR-0011).
 *
 * v1 writes objects to the repository's shared object store directly —
 * upstream T3 Code's private object dir + quarantine is deferred
 * hardening. Submodule gitlinks are recorded but submodule worktree
 * contents are not captured (record-and-warn, see spec).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import {
  type BoundedResult,
  GitError,
  gitOk,
  type RepoInfo,
  resolveRepo,
  runGit,
  runGitBounded,
} from "../../../packages/git-core/src/index";
import type { CheckpointEntry } from "./state";

export const CHECKPOINT_REFS_PREFIX = "refs/herdr-plugins/checkpoints";

/** Fixed author/committer identity for synthetic checkpoint commits. */
const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "herdr checkpoints",
  GIT_AUTHOR_EMAIL: "checkpoints@herdr-plugins.invalid",
  GIT_COMMITTER_NAME: "herdr checkpoints",
  GIT_COMMITTER_EMAIL: "checkpoints@herdr-plugins.invalid",
} as const;

/**
 * Index hardening flags mirroring upstream's capture preamble: no fsmonitor
 * or split-index side effects on the scratch index.
 */
const INDEX_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "splitIndex.sharedIndexExpire=never",
] as const;

const FILES_SUMMARY_MAX_BYTES = 32 * 1024;
const LS_FILES_MAX_BYTES = 64 * 1024 * 1024;

/** Domain errors that are not git failures (structured `kind` on stderr). */
export class CheckpointError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.kind = kind;
  }
}

/**
 * Deterministic repo key: first 16 hex chars of sha256 over the canonical
 * (realpath) repository root. Stable across path aliases that resolve to
 * the same directory; different worktrees of one repository get distinct
 * keys because their roots differ.
 */
export function repoKeyFor(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16);
}

export function checkpointRef(repoKey: string, id: string): string {
  return `${CHECKPOINT_REFS_PREFIX}/${repoKey}/${id}`;
}

/** URL/base36-safe unique id; also the final ref path component. */
export function newCheckpointId(now: Date = new Date()): string {
  return `${now.getTime().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** Canonicalize a repo root so state keys and ref namespaces are stable. */
export async function canonicalRepoRoot(root: string): Promise<string> {
  return realpath(root);
}

export interface ResolvedRepo {
  info: RepoInfo;
  /** Canonical (realpath) worktree root — the value stored in state. */
  root: string;
  repoKey: string;
}

/**
 * Resolve `cwd` (a path inside the work tree) to a capturable repo.
 * Throws GitError for not_a_repo / bare_repo and CheckpointError for
 * conditions v1 refuses to capture (unborn HEAD, sparse checkout).
 */
export async function resolveCheckpointRepo(
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<ResolvedRepo> {
  let info: RepoInfo;
  try {
    info = await resolveRepo(cwd, options);
  } catch (err) {
    // `--show-toplevel` fails inside a bare repo with a generic git_error;
    // probe explicitly so callers get the structured bare_repo kind.
    if (err instanceof GitError && err.kind === "git_error") {
      const bare = await runGit(cwd, ["rev-parse", "--is-bare-repository"], options);
      if (bare.code === 0 && bare.stdout.trim() === "true") {
        throw new GitError("bare_repo", `bare repository has no work tree: ${cwd}`);
      }
    }
    throw err;
  }
  const root = await canonicalRepoRoot(info.root);
  await assertCapturable(root, options);
  return { info, root, repoKey: repoKeyFor(root) };
}

async function assertCapturable(root: string, options: { timeoutMs?: number }): Promise<void> {
  // Unborn HEAD: `rev-parse --verify HEAD^{commit}` fails. In a valid
  // non-bare repo the only routine cause is "no commits yet".
  const head = await runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"], options);
  if (head.code !== 0) {
    throw new CheckpointError("empty_repo", `repository has no commits yet (unborn HEAD): ${root}`);
  }
  // A fresh scratch index loses skip-worktree bits, so `add -A` would
  // stage deletions for every path outside the sparse cone. Refuse
  // rather than publish a false tree (upstream rebuilds the index;
  // deferred hardening).
  // `git config --bool` exits 1 when the key is unset; only "true" matters.
  const sparse = await runGit(root, ["config", "--bool", "core.sparseCheckout"], options);
  if (sparse.code === 0 && sparse.stdout.trim() === "true") {
    throw new CheckpointError(
      "sparse_checkout",
      `sparse checkout is not supported by checkpoints v1: ${root}`,
    );
  }
}

function sanitizeLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const clean = label
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 200);
  return clean === "" ? undefined : clean;
}

function commitMessage(id: string, ref: string, headSha: string, label?: string): string {
  const lines = [`herdr checkpoint ${id}`, "", `ref=${ref}`, `head=${headSha}`];
  if (label !== undefined) lines.push(`label=${label}`);
  return `${lines.join("\n")}\n`;
}

/** Paths of gitlink (submodule) entries in the scratch index, `-z` parsed. */
async function submodulePaths(
  root: string,
  env: Record<string, string>,
  options: { timeoutMs?: number },
): Promise<string[]> {
  const result = await runGit(root, [...INDEX_CONFIG, "ls-files", "-s", "-z"], {
    ...options,
    env,
    maxBuffer: LS_FILES_MAX_BYTES,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit ${result.code}`;
    throw new GitError("git_error", `git ls-files: ${detail}`);
  }
  const paths: string[] = [];
  for (const record of result.stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    if (record.slice(0, tab).startsWith("160000 ")) {
      paths.push(record.slice(tab + 1));
    }
  }
  return paths;
}

export interface CaptureOptions {
  timeoutMs?: number;
  label?: string | undefined;
  /**
   * Capture provenance recorded on the state entry: `manual` for
   * explicit `create`, `auto` for lazy work-unit captures, `pre_restore`
   * for the mandatory pre-restore safety capture. Defaults to `manual`.
   */
  kind?: "manual" | "auto" | "pre_restore" | undefined;
  /** Injected for tests; defaults to wall clock + random. */
  id?: string | undefined;
  now?: Date | undefined;
}

/**
 * Capture the worktree state of `repo` into a hidden ref. Returns the
 * state entry; persisting it is the caller's job (state.ts updateState).
 * Never mutates the user's index, staging area, or worktree files.
 */
export async function captureCheckpoint(
  repo: ResolvedRepo,
  options: CaptureOptions = {},
): Promise<CheckpointEntry> {
  const timeoutMs = options.timeoutMs;
  const gitOptions = timeoutMs === undefined ? {} : { timeoutMs };
  const root = repo.root;
  const info = repo.info;

  const headResult = await runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"], gitOptions);
  if (headResult.code !== 0) {
    throw new CheckpointError("empty_repo", `repository has no commits yet: ${root}`);
  }
  const headSha = headResult.stdout.trim();
  const branchRaw = (await gitOk(root, ["rev-parse", "--abbrev-ref", "HEAD"], gitOptions)).trim();
  const branch = branchRaw === "HEAD" ? null : branchRaw;

  const id = options.id ?? newCheckpointId(options.now);
  const ref = checkpointRef(repo.repoKey, id);
  const label = sanitizeLabel(options.label);

  const tempIndex = path.join(info.gitCommonDir, `herdr-checkpoint-index-${randomUUID()}`);
  const env: Record<string, string> = {
    ...COMMIT_IDENTITY,
    GIT_INDEX_FILE: tempIndex,
  };

  try {
    // Seed the scratch index from HEAD, then stage the full worktree
    // state (tracked modifications + staged content + untracked files,
    // .gitignore respected) without touching the real index.
    await gitOk(root, [...INDEX_CONFIG, "read-tree", "HEAD"], { ...gitOptions, env });
    await gitOk(root, [...INDEX_CONFIG, "-c", "core.safecrlf=false", "add", "-A", "--", "."], {
      ...gitOptions,
      env,
    });
    const treeOid = (
      await gitOk(root, [...INDEX_CONFIG, "write-tree"], { ...gitOptions, env })
    ).trim();
    if (treeOid === "") {
      throw new GitError("git_error", "git write-tree returned an empty tree oid");
    }

    const submodules = await submodulePaths(root, env, gitOptions);

    const commitOid = (
      await gitOk(
        root,
        [
          ...INDEX_CONFIG,
          "commit-tree",
          treeOid,
          "-p",
          headSha,
          "-m",
          commitMessage(id, ref, headSha, label),
        ],
        { ...gitOptions, env },
      )
    ).trim();
    if (commitOid === "") {
      throw new GitError("git_error", "git commit-tree returned an empty commit oid");
    }

    await gitOk(root, ["update-ref", ref, commitOid], gitOptions);

    const summary = await runGitBounded(
      root,
      ["diff", "--no-color", "--no-ext-diff", "--name-status", headSha, commitOid],
      { ...gitOptions, maxBytes: FILES_SUMMARY_MAX_BYTES },
    );

    const entry: CheckpointEntry = {
      id,
      repo_root: root,
      repo_key: repo.repoKey,
      ref,
      commit: commitOid,
      head_sha: headSha,
      branch,
      created_at: (options.now ?? new Date()).toISOString(),
    };
    if (label !== undefined) entry.label = label;
    entry.kind = options.kind ?? "manual";
    entry.files_summary = summary.stdout;
    entry.files_summary_truncated = summary.truncated;
    if (submodules.length > 0) entry.submodules = submodules;
    return entry;
  } finally {
    await rm(tempIndex, { force: true });
    await rm(`${tempIndex}.lock`, { force: true });
  }
}

/**
 * OID the ref currently points at, or null when the ref does not exist.
 * Used to detect refs deleted out-of-band or moved by other tools.
 */
export async function verifyRef(
  repoRoot: string,
  ref: string,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  const result = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    ...options,
    maxBuffer: 1024,
  });
  if (result.code !== 0) return null;
  const oid = result.stdout.trim();
  return oid === "" ? null : oid;
}

/** Delete a checkpoint ref; missing refs are a no-op (idempotent). */
export async function deleteRef(
  repoRoot: string,
  ref: string,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const oid = await verifyRef(repoRoot, ref, options);
  if (oid === null) return false;
  await gitOk(repoRoot, ["update-ref", "-d", ref], options);
  return true;
}

/** Bounded `git diff <revA> <revB>` between two resolved revisions. */
export async function diffRevs(
  repoRoot: string,
  revA: string,
  revB: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<BoundedResult> {
  return runGitBounded(repoRoot, ["diff", "--no-color", "--no-ext-diff", revA, revB], options);
}

/** Bounded `git show --stat` summary for one checkpoint commit. */
export async function showCommit(
  repoRoot: string,
  commit: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<BoundedResult> {
  return runGitBounded(repoRoot, ["show", "--no-color", "--stat", commit], options);
}
