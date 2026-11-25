/**
 * Shared git primitives for herdr plugins (rebuildup.git, rebuildup.projects).
 *
 * Every repository query is a `git` binary invocation via argv spawn — no
 * shell, no string interpolation of paths or revisions into command text
 * (ADR-0006). Extracted from plugins/git/src/git.ts so plugins that only
 * need repo resolution / remote identity do not duplicate the spawn path.
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
  options: { timeoutMs?: number; maxBuffer?: number; env?: Record<string, string> } = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        // Caller-supplied vars (e.g. GIT_INDEX_FILE for a scratch index)
        // land before the safety pins so they cannot disable them.
        ...options.env,
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
  options: { timeoutMs?: number; env?: Record<string, string> } = {},
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

/**
 * Repository identity for cross-checkout grouping: the normalized
 * `origin` remote URL when present, else the repo root path. Normalizes
 * scp-like (`git@host:org/repo.git`) and https forms plus host casing
 * and a trailing `.git`/`/` so clones of the same repository compare
 * equal. Returns null for bare/missing remotes handled by callers.
 */
export function normalizeRemoteUrl(url: string): string {
  const trimmed = url.trim();
  const scp = /^([^@\s]+)@([^:\s]+):(.+)$/.exec(trimmed);
  if (scp) {
    const host = (scp[2] as string).toLowerCase();
    const pathPart = (scp[3] as string).replace(/\.git$/i, "").replace(/\/+$/, "");
    return `${host}/${pathPart}`;
  }
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const pathPart = parsed.pathname.replace(/\.git$/i, "").replace(/\/+$/, "");
    return `${host}${pathPart}`;
  } catch {
    return trimmed.replace(/\.git$/i, "").replace(/\/+$/, "");
  }
}

/** Fetch URL of `origin` (falling back to the first remote), normalized. */
export async function repoRemoteIdentity(
  repoRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  const names = (await gitOk(repoRoot, ["remote"], options)).trim().split("\n").filter(Boolean);
  const preferred = names.includes("origin") ? "origin" : names[0];
  if (!preferred) return null;
  const url = (await gitOk(repoRoot, ["remote", "get-url", preferred], options)).trim();
  return normalizeRemoteUrl(url);
}

export interface BoundedResult {
  stdout: string;
  /** True when output hit `maxBytes` and the child was killed early. */
  truncated: boolean;
  /** UTF-8 byte length of the (possibly truncated) returned stdout. */
  bytes: number;
}

/**
 * Run `git <args>` streaming stdout with a hard byte cap. When the cap is
 * exceeded the child is killed and the result resolves with `truncated:
 * true` and the capped prefix — suitable for diff/show payloads that must
 * stay bounded. Non-zero exit without truncation rejects as GitError.
 */
export function runGitBounded(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; maxBytes?: number; env?: Record<string, string> } = {},
): Promise<BoundedResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        ...options.env,
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
      finish(() =>
        reject(new GitError("timeout", `git ${args[0] ?? ""} timed out after ${timeoutMs}ms`)),
      );
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
          const detail = stderr.trim() || `exit ${code ?? -1}`;
          reject(new GitError("git_error", `git ${args.join(" ")}: ${detail}`));
          return;
        }
        const stdout = Buffer.concat(chunks).toString("utf8");
        resolve({ stdout, truncated, bytes: Buffer.byteLength(stdout, "utf8") });
      });
    });
  });
}
