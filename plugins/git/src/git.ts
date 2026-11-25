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

export type FileChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted"
  | "ignored";

export interface FileChange {
  /** Path relative to the repo root (the "to" side for renames/copies). */
  path: string;
  /** Source path for renames/copies; null otherwise. */
  oldPath: string | null;
  /** Raw porcelain XY columns for clients that need the detail. */
  index: string;
  worktree: string;
  kind: FileChangeKind;
  staged: boolean;
  unstaged: boolean;
  /**
   * Binary detection from `git diff --numstat`: true/false for tracked
   * changes, null when not determinable (untracked, conflicted).
   */
  binary: boolean | null;
}

function fileKind(x: string, y: string): FileChangeKind {
  if (x === "?" && y === "?") return "untracked";
  if (x === "!" && y === "!") return "ignored";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return "conflicted";
  }
  if (x === "R" || y === "R") return "renamed";
  if (x === "C" || y === "C") return "copied";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "T" || y === "T") return "typechange";
  return "modified";
}

/**
 * Parse `git status --porcelain=v1 -z` output. With `-z`, paths are
 * unquoted NUL-terminated fields, so special characters survive verbatim.
 * Rename/copy records carry the destination path on the XY line and the
 * source path as the following NUL field.
 */
export function parsePorcelainZ(output: string): FileChange[] {
  const tokens = output.split("\0").filter((t) => t.length > 0);
  const entries: FileChange[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token.length < 4) continue;
    const x = token[0] as string;
    const y = token[1] as string;
    const path = token.slice(3);
    let oldPath: string | null = null;
    if (x === "R" || y === "R" || x === "C" || y === "C") {
      oldPath = tokens[++i] ?? null;
    }
    const kind = fileKind(x, y);
    const tracked = kind !== "untracked" && kind !== "ignored" && kind !== "conflicted";
    entries.push({
      path,
      oldPath,
      index: x,
      worktree: y,
      kind,
      staged: tracked && x !== " " && x !== "?" && x !== "!",
      unstaged: tracked && y !== " " && y !== "?" && y !== "!",
      binary: null,
    });
  }
  return entries;
}

/**
 * Parse `git diff --numstat -z` output into the set of paths reported as
 * binary (`-` added/deleted counts). Rename records carry an empty inline
 * path field followed by old and new path tokens.
 */
export function parseNumstatZ(output: string): {
  binary: Set<string>;
  stats: Map<string, { added: number; deleted: number }>;
} {
  const tokens = output.split("\0").filter((t) => t.length > 0);
  const binary = new Set<string>();
  const stats = new Map<string, { added: number; deleted: number }>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    const match = token.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/);
    if (!match) continue;
    const added = match[1] as string;
    const deleted = match[2] as string;
    const inline = match[3] as string;
    let path = inline;
    if (inline === "") {
      // Rename/copy: next two NUL fields are old then new path.
      i += 2;
      path = tokens[i] ?? "";
    }
    if (path === "") continue;
    if (added === "-") {
      binary.add(path);
    } else {
      stats.set(path, { added: Number(added), deleted: Number(deleted) });
    }
  }
  return { binary, stats };
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

export interface FilesResult {
  files: FileChange[];
}

/**
 * Structured per-file change list for the worktree + index. Binary flags
 * come from `git diff --numstat` on both sides; untracked/conflicted
 * entries report `binary: null`.
 */
export async function collectFiles(
  repoRoot: string,
  request: { pathspec?: string[] | undefined } = {},
  options: { timeoutMs?: number } = {},
): Promise<FilesResult> {
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=normal"];
  if (request.pathspec && request.pathspec.length > 0) {
    args.push("--", ...request.pathspec);
  }
  const porcelain = await gitOk(repoRoot, args, options);
  const files = parsePorcelainZ(porcelain);

  const numstatArgs = (extra: string[]) => ["diff", "--numstat", "-z", ...extra];
  const [unstaged, staged] = await Promise.all([
    gitOk(repoRoot, numstatArgs([]), options),
    gitOk(repoRoot, numstatArgs(["--cached"]), options),
  ]);
  const binaryPaths = new Set<string>([
    ...parseNumstatZ(unstaged).binary,
    ...parseNumstatZ(staged).binary,
  ]);
  for (const file of files) {
    if (file.kind === "untracked" || file.kind === "conflicted" || file.kind === "ignored") {
      continue;
    }
    file.binary =
      binaryPaths.has(file.path) || (file.oldPath !== null && binaryPaths.has(file.oldPath));
  }
  return { files };
}

export type DiffFormat = "patch" | "stat" | "name-status" | "numstat";

export interface DiffRequest {
  staged?: boolean | undefined;
  stat?: boolean | undefined;
  format?: DiffFormat | undefined;
  revisions?: string[] | undefined;
  /** Pathspec limiting the diff (`git diff -- <path>...`). */
  paths?: string[] | undefined;
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
  const format = request.format ?? (request.stat ? "stat" : "patch");
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (request.staged) args.push("--staged");
  if (format === "stat") args.push("--stat");
  else if (format === "name-status") args.push("--name-status", "-z");
  else if (format === "numstat") args.push("--numstat", "-z");
  if (request.revisions && request.revisions.length > 0) {
    args.push(...request.revisions);
  }
  if (request.paths && request.paths.length > 0) {
    args.push("--", ...request.paths);
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
