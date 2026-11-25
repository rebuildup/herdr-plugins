/**
 * Read-only git access for rebuildup.git.
 *
 * Every repository query is a `git` binary invocation via argv spawn — no
 * shell, no string interpolation of paths or revisions into command text
 * (ADR-0006). The pane cwd comes from the herdr snapshot and is passed as
 * the spawn working directory.
 */

import { spawn } from "node:child_process";

export type GitErrorKind = "git_missing" | "timeout" | "git_error" | "not_a_repo" | "bare_repo";

export class GitError extends Error {
  readonly kind: GitErrorKind;
  constructor(kind: GitErrorKind, message: string) {
    super(message);
    this.name = "GitError";
    this.kind = kind;
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Run `git <args>` with `cwd` as the working directory. Resolves on any
 * exit code; callers inspect `code`. Rejects on spawn failure, timeout, or
 * output exceeding `maxBuffer`.
 */
export function runGit(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(new GitError("timeout", `git ${args[0] ?? ""} timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > maxBuffer) {
        child.kill("SIGKILL");
        finish(() => reject(new GitError("git_error", "git output exceeded buffer limit")));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish(() =>
        reject(
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? new GitError("git_missing", "git executable not found on PATH")
            : new GitError("git_error", String(err)),
        ),
      );
    });
    child.on("close", (code) => {
      finish(() => resolve({ stdout, stderr, code: code ?? -1 }));
    });
  });
}

/** Run git and require exit code 0; map failures to GitError. */
export async function gitOk(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const result = await runGit(cwd, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new GitError("git_error", `git ${args.join(" ")}: ${detail}`);
  }
  return result.stdout;
}

export interface RepoInfo {
  root: string;
  gitDir: string;
  gitCommonDir: string;
  bare: boolean;
}

/**
 * Resolve the repository containing `cwd`. Throws GitError("not_a_repo")
 * when cwd is outside every work tree and GitError("bare_repo") for bare
 * repositories (status/diff are meaningless there in stage 1).
 */
export async function resolveRepo(
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<RepoInfo> {
  let top: string;
  try {
    top = (await gitOk(cwd, ["rev-parse", "--show-toplevel"], options)).trim();
  } catch (err) {
    if (err instanceof GitError && err.kind === "git_error") {
      // rev-parse exits 128 with "not a git repository" outside work trees.
      if (/not a git repository/i.test(err.message)) {
        throw new GitError("not_a_repo", `no git work tree contains: ${cwd}`);
      }
    }
    throw err;
  }
  const [gitDir, commonDir, bare] = await Promise.all([
    gitOk(top, ["rev-parse", "--absolute-git-dir"], options).then((s) => s.trim()),
    gitOk(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"], options).then((s) =>
      s.trim(),
    ),
    gitOk(top, ["rev-parse", "--is-bare-repository"], options).then((s) => s.trim() === "true"),
  ]);
  if (bare) {
    throw new GitError("bare_repo", `bare repository has no work tree: ${top}`);
  }
  return { root: top, gitDir, gitCommonDir: commonDir, bare };
}

export interface ChangeCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

/**
 * Parse `git status --porcelain=v1` output into file-level counts.
 * XY codes: staged = X set (not space/?/!), unstaged = Y set,
 * untracked = `??`, conflicted = unmerged (`U` in XY or `AA`/`DD`).
 */
export function parsePorcelain(output: string): ChangeCounts {
  const counts: ChangeCounts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  for (const line of output.split("\n")) {
    if (line.length < 3) continue;
    const x = line[0] as string;
    const y = line[1] as string;
    if (x === "?" && y === "?") {
      counts.untracked += 1;
      continue;
    }
    if (x === "!" && y === "!") continue; // ignored
    const unmerged = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    if (unmerged) {
      counts.conflicted += 1;
      continue;
    }
    if (x !== " " && x !== "?") counts.staged += 1;
    if (y !== " " && y !== "?") counts.unstaged += 1;
  }
  return counts;
}

export interface BranchInfo {
  name: string;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

async function upstreamRef(
  repoRoot: string,
  options: { timeoutMs?: number },
): Promise<string | null> {
  const result = await runGit(
    repoRoot,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    options,
  );
  if (result.code !== 0) return null;
  const ref = result.stdout.trim();
  return ref.length > 0 ? ref : null;
}

async function aheadBehind(
  repoRoot: string,
  options: { timeoutMs?: number },
): Promise<{ ahead: number; behind: number } | null> {
  const result = await runGit(
    repoRoot,
    ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    options,
  );
  if (result.code !== 0) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) return null;
  // left = HEAD-only commits (ahead), right = upstream-only (behind)
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

export async function collectBranch(
  repoRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<BranchInfo> {
  const head = (await gitOk(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], options)).trim();
  const detached = head === "HEAD";
  const upstream = await upstreamRef(repoRoot, options);
  const counts = upstream ? await aheadBehind(repoRoot, options) : null;
  return {
    name: head,
    detached,
    upstream,
    ahead: counts?.ahead ?? null,
    behind: counts?.behind ?? null,
  };
}

export interface StatusReport {
  repo: RepoInfo;
  branch: BranchInfo;
  changes: ChangeCounts;
}

export async function collectStatus(
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<StatusReport> {
  const repo = await resolveRepo(cwd, options);
  const [branch, porcelain] = await Promise.all([
    collectBranch(repo.root, options),
    gitOk(repo.root, ["status", "--porcelain=v1", "--untracked-files=normal"], options),
  ]);
  return { repo, branch, changes: parsePorcelain(porcelain) };
}

export interface DiffRequest {
  staged?: boolean | undefined;
  stat?: boolean | undefined;
  revisions?: string[] | undefined;
  maxBytes?: number | undefined;
}

export interface DiffResult {
  output: string;
  truncated: boolean;
  bytes: number;
}

const DIFF_DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Run `git diff` bounded by `maxBytes`. Revisions are argv elements; values
 * starting with `-` are rejected by the caller before reaching here.
 */
export async function collectDiff(
  repoRoot: string,
  request: DiffRequest,
  options: { timeoutMs?: number } = {},
): Promise<DiffResult> {
  const maxBytes = request.maxBytes ?? DIFF_DEFAULT_MAX_BYTES;
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (request.staged) args.push("--staged");
  if (request.stat) args.push("--stat");
  if (request.revisions && request.revisions.length > 0) {
    args.push(...request.revisions);
  }
  // Stream with a byte cap: spawn, accumulate, kill when over the cap.
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn("git", args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    let stderr = "";
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new GitError("timeout", `git diff timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        truncated = true;
        chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (bytes - chunk.length))));
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish(() =>
        reject(
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? new GitError("git_missing", "git executable not found on PATH")
            : new GitError("git_error", String(err)),
        ),
      );
    });
    child.on("close", (code) => {
      finish(() => {
        if (!truncated && code !== 0) {
          const detail = stderr.trim() || `exit ${code}`;
          reject(new GitError("git_error", `git diff: ${detail}`));
          return;
        }
        const output = Buffer.concat(chunks).toString("utf8");
        resolve({ output, truncated, bytes: Buffer.byteLength(output, "utf8") });
      });
    });
  });
}
