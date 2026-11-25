/**
 * Read-only git access for rebuildup.git.
 *
 * Spawn primitives (runGit/gitOk/GitError/resolveRepo) live in
 * packages/git-core, shared with rebuildup.projects. Everything below
 * layers status/diff/history/mutation collectors on top of them —
 * argv spawn only, no shell, no string interpolation (ADR-0006).
 */

import { spawn } from "node:child_process";
import {
  GitError,
  gitOk,
  type RepoInfo,
  resolveRepo,
  runGit,
} from "../../../packages/git-core/src/index";

export { GitError, gitOk, resolveRepo, runGit };
export type { GitErrorKind, GitResult, RepoInfo } from "../../../packages/git-core/src/index";

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

export interface LogCommit {
  sha: string;
  parents: string[];
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  subject: string;
}

// Record separator \x01, field separator \x1f — both illegal in the
// fields we emit, so parsing cannot be confused by path/subject text.
const LOG_FORMAT = "%x01%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s";

export function parseLogOutput(output: string): LogCommit[] {
  const commits: LogCommit[] = [];
  for (const record of output.split("\x01")) {
    if (record.length === 0) continue;
    const f = record.split("\x1f");
    if (f.length < 9) continue;
    commits.push({
      sha: f[0] as string,
      parents: (f[1] as string).split(" ").filter((p) => p.length > 0),
      author: { name: f[2] as string, email: f[3] as string, date: f[4] as string },
      committer: { name: f[5] as string, email: f[6] as string, date: f[7] as string },
      subject: (f[8] as string).replace(/\n+$/, ""),
    });
  }
  return commits;
}

export interface LogRequest {
  limit?: number | undefined;
  skip?: number | undefined;
  all?: boolean | undefined;
  firstParent?: boolean | undefined;
  author?: string | undefined;
  grep?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  pathspec?: string[] | undefined;
}

export interface LogResult {
  commits: LogCommit[];
  hasMore: boolean;
}

const LOG_DEFAULT_LIMIT = 50;
const LOG_MAX_LIMIT = 1000;

export async function collectLog(
  repoRoot: string,
  request: LogRequest = {},
  options: { timeoutMs?: number } = {},
): Promise<LogResult> {
  const limit = Math.min(Math.max(request.limit ?? LOG_DEFAULT_LIMIT, 1), LOG_MAX_LIMIT);
  const args = ["log", `--format=${LOG_FORMAT}`, `--max-count=${limit + 1}`];
  if (request.skip && request.skip > 0) args.push(`--skip=${request.skip}`);
  if (request.all) args.push("--all");
  if (request.firstParent) args.push("--first-parent");
  if (request.author) args.push(`--author=${request.author}`);
  if (request.grep) args.push(`--grep=${request.grep}`);
  if (request.since) args.push(`--since=${request.since}`);
  if (request.until) args.push(`--until=${request.until}`);
  if (request.pathspec && request.pathspec.length > 0) {
    args.push("--", ...request.pathspec);
  }
  const output = await gitOk(repoRoot, args, options);
  const commits = parseLogOutput(output);
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

export interface NameStatusEntry {
  /** Raw status letters, e.g. "M", "A", "D", "R100". */
  status: string;
  path: string;
  oldPath: string | null;
}

/**
 * Parse `git diff --name-status -z` output. Rename/copy records carry
 * status, then old path, then new path as separate NUL fields.
 */
export function parseNameStatusZ(output: string): NameStatusEntry[] {
  const tokens = output.split("\0").filter((t) => t.length > 0);
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i] as string;
    if (status.length === 0) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i + 1] ?? "";
      const path = tokens[i + 2] ?? "";
      i += 2;
      if (path) entries.push({ status, path, oldPath: oldPath || null });
    } else {
      const path = tokens[i + 1] ?? "";
      i += 1;
      if (path) entries.push({ status, path, oldPath: null });
    }
  }
  return entries;
}

export interface CompareResult {
  /** Revision the comparison is anchored on (as requested). */
  base: string;
  head: string;
  mergeBase: string;
  ahead: number;
  behind: number;
  files: NameStatusEntry[];
  stat: string;
  patch: DiffResult;
}

/**
 * Branch/revision comparison: `git diff <merge-base> <head>` plus
 * ahead/behind counts. `base` defaults to the upstream of `head`'s
 * branch; with no arguments this compares HEAD against its upstream.
 */
export async function collectCompare(
  repoRoot: string,
  request: { base?: string | undefined; head?: string | undefined; maxBytes?: number | undefined },
  options: { timeoutMs?: number } = {},
): Promise<CompareResult> {
  let base = request.base;
  const head = request.head ?? "HEAD";
  if (!base) {
    const upstream = await upstreamRef(repoRoot, options);
    if (!upstream) {
      throw new GitError("git_error", "no upstream configured; pass an explicit base revision");
    }
    base = upstream;
  }
  const mergeBase = (await gitOk(repoRoot, ["merge-base", base, head], options))
    .trim()
    .split("\n")[0] as string;
  const counts = await runGit(
    repoRoot,
    ["rev-list", "--left-right", "--count", `${base}...${head}`],
    options,
  );
  const match = counts.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  // rev-list --left-right --count base...head: left = base-only (behind),
  // right = head-only (ahead).
  const behind = match ? Number(match[1]) : 0;
  const ahead = match ? Number(match[2]) : 0;
  const [nameStatus, stat, patch] = await Promise.all([
    gitOk(repoRoot, ["diff", "--name-status", "-z", mergeBase, head], options),
    gitOk(repoRoot, ["diff", "--stat", mergeBase, head], options),
    collectDiff(repoRoot, { revisions: [mergeBase, head], maxBytes: request.maxBytes }, options),
  ]);
  return {
    base,
    head,
    mergeBase,
    ahead,
    behind,
    files: parseNameStatusZ(nameStatus),
    stat: stat.trimEnd(),
    patch,
  };
}

/**
 * Mutation helpers (stage 2). All go through the same argv-spawn +
 * timeout + env-hygiene path as reads; non-zero exits surface as
 * GitError("git_error") carrying stderr. Callers validate arguments —
 * nothing here interpolates into shell text.
 */

/** Reject empty or option-like values that could inject git flags. */
export function assertSafeGitArg(value: string, what: string): void {
  if (value.length === 0 || value.startsWith("-")) {
    throw new GitError("git_error", `invalid ${what}: ${JSON.stringify(value)}`);
  }
}

export async function collectStage(
  repoRoot: string,
  request: { all?: boolean | undefined; paths?: string[] | undefined },
  options: { timeoutMs?: number } = {},
): Promise<string> {
  for (const p of request.paths ?? []) assertSafeGitArg(p, "path");
  if (!request.all && (!request.paths || request.paths.length === 0)) {
    throw new GitError("git_error", "stage requires --all or at least one --path");
  }
  const args = request.all ? ["add", "-A"] : ["add", "--", ...(request.paths as string[])];
  return (await gitOk(repoRoot, args, options)).trim();
}

export async function collectUnstage(
  repoRoot: string,
  request: { all?: boolean | undefined; paths?: string[] | undefined },
  options: { timeoutMs?: number } = {},
): Promise<string> {
  for (const p of request.paths ?? []) assertSafeGitArg(p, "path");
  if (!request.all && (!request.paths || request.paths.length === 0)) {
    throw new GitError("git_error", "unstage requires --all or at least one --path");
  }
  // `git reset -q` unstages everything (mixed reset to HEAD). On an
  // unborn branch it fails with a structured git_error — acceptable.
  const args = request.all
    ? ["reset", "-q"]
    : ["restore", "--staged", "--", ...(request.paths as string[])];
  return (await gitOk(repoRoot, args, options)).trim();
}

export async function collectCommit(
  repoRoot: string,
  request: { messages: string[]; allowEmpty?: boolean | undefined },
  options: { timeoutMs?: number } = {},
): Promise<{ sha: string; summary: string }> {
  if (request.messages.length === 0) {
    throw new GitError("git_error", "commit requires at least one -m message");
  }
  const args = ["commit"];
  for (const message of request.messages) args.push("-m", message);
  if (request.allowEmpty) args.push("--allow-empty");
  const summary = (await gitOk(repoRoot, args, options)).trim();
  const sha = (await gitOk(repoRoot, ["rev-parse", "HEAD"], options)).trim();
  return { sha, summary };
}

export async function collectBranchCreate(
  repoRoot: string,
  request: { name: string; switchTo?: boolean | undefined },
  options: { timeoutMs?: number } = {},
): Promise<string> {
  assertSafeGitArg(request.name, "branch name");
  const args = request.switchTo ? ["switch", "-c", request.name] : ["branch", request.name];
  return (await gitOk(repoRoot, args, options)).trim();
}

export async function collectBranchSwitch(
  repoRoot: string,
  request: { name: string },
  options: { timeoutMs?: number } = {},
): Promise<string> {
  assertSafeGitArg(request.name, "branch name");
  return (await gitOk(repoRoot, ["switch", request.name], options)).trim();
}

export async function collectUpstream(
  repoRoot: string,
  request: { upstream: string },
  options: { timeoutMs?: number } = {},
): Promise<string> {
  assertSafeGitArg(request.upstream, "upstream ref");
  return (await gitOk(repoRoot, ["branch", "--set-upstream-to", request.upstream], options)).trim();
}

export async function collectFetch(
  repoRoot: string,
  request: { remote?: string | undefined; prune?: boolean | undefined },
  options: { timeoutMs?: number } = {},
): Promise<string> {
  if (request.remote) assertSafeGitArg(request.remote, "remote");
  const args = ["fetch"];
  if (request.prune) args.push("--prune");
  if (request.remote) args.push(request.remote);
  return (await gitOk(repoRoot, args, options)).trim();
}

export async function collectPush(
  repoRoot: string,
  request: {
    remote?: string | undefined;
    refspec?: string | undefined;
    setUpstream?: boolean | undefined;
    forceWithLease?: boolean | undefined;
  },
  options: { timeoutMs?: number } = {},
): Promise<string> {
  if (request.remote) assertSafeGitArg(request.remote, "remote");
  if (request.refspec) assertSafeGitArg(request.refspec, "refspec");
  const args = ["push"];
  if (request.setUpstream) args.push("--set-upstream");
  if (request.forceWithLease) args.push("--force-with-lease");
  if (request.remote) args.push(request.remote);
  if (request.refspec) args.push(request.refspec);
  return (await gitOk(repoRoot, args, options)).trim();
}

export interface RemoteInfo {
  name: string;
  /** Fetch URL with any embedded credentials stripped. */
  url: string;
  /** Push URL with any embedded credentials stripped; falls back to `url`. */
  pushUrl: string;
}

/** Remove userinfo (and any token in it) from a remote URL. */
export function sanitizeRemoteUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // scp-like syntax (git@host:path) or unparsable: return as-is — it
    // cannot carry an https userinfo token in that form.
    return url;
  }
}

export async function collectRemotes(
  repoRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<RemoteInfo[]> {
  const names = (await gitOk(repoRoot, ["remote"], options)).trim().split("\n").filter(Boolean);
  const remotes: RemoteInfo[] = [];
  for (const name of names) {
    const [url, pushUrl] = await Promise.all([
      gitOk(repoRoot, ["remote", "get-url", name], options).then((s) => s.trim()),
      runGit(repoRoot, ["remote", "get-url", "--push", name], options).then((r) =>
        r.code === 0 ? r.stdout.trim() : "",
      ),
    ]);
    remotes.push({
      name,
      url: sanitizeRemoteUrl(url),
      pushUrl: sanitizeRemoteUrl(pushUrl || url),
    });
  }
  return remotes;
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
    const timeoutMs = options.timeoutMs ?? 10_000;
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
