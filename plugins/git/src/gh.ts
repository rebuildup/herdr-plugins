/**
 * Forge access for rebuildup.git — GitHub pull requests via the host's
 * `gh` CLI (ADR-0008).
 *
 * Same spawn discipline as git.ts: argv only, no shell, hard timeout,
 * `GIT_TERMINAL_PROMPT`-equivalent prompt suppression. Authentication
 * and host selection (github.com vs GHES) come from the user's existing
 * `gh auth` configuration — the plugin never handles tokens itself.
 */

import { spawn } from "node:child_process";

export type GhErrorKind = "gh_missing" | "timeout" | "gh_error";

export class GhError extends Error {
  readonly kind: GhErrorKind;
  constructor(kind: GhErrorKind, message: string) {
    super(message);
    this.name = "GhError";
    this.kind = kind;
  }
}

export interface GhResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Floor for `gh --version`; older releases lack stable --json surfaces. */
export const MIN_GH_VERSION = "2.81.0";

const DEFAULT_TIMEOUT_MS = 10_000;

export function runGh(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number; input?: string | undefined } = {},
): Promise<GhResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        LC_ALL: "C",
      },
      // stdin is always piped and closed immediately when unused, so gh
      // can never block waiting for interactive input.
      stdio: ["pipe", "pipe", "pipe"],
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
        reject(new GhError("timeout", `gh ${args[0] ?? ""} timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > maxBuffer) {
        child.kill("SIGKILL");
        finish(() => reject(new GhError("gh_error", "gh output exceeded buffer limit")));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish(() =>
        reject(
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? new GhError("gh_missing", "gh executable not found on PATH")
            : new GhError("gh_error", String(err)),
        ),
      );
    });
    child.on("close", (code) => {
      finish(() => resolve({ stdout, stderr, code: code ?? -1 }));
    });
    child.stdin?.end(options.input ?? "");
  });
}

/** Run gh and require exit code 0; map failures to GhError. */
export async function ghOk(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number; input?: string | undefined } = {},
): Promise<string> {
  const result = await runGh(cwd, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    // Only the subcommand words go into the message — argv may carry
    // user content (PR title/body) that must not be echoed back.
    throw new GhError("gh_error", `gh ${args.slice(0, 2).join(" ")}: ${detail}`);
  }
  return result.stdout;
}

function parseVersion(text: string): [number, number, number] | null {
  const match = /gh version (\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(version);
  const b = parse(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  }
  return true;
}

/**
 * Verify `gh` exists, meets MIN_GH_VERSION, and is authenticated.
 * Throws GhError("gh_missing" | "gh_error") otherwise — callers map to
 * the structured error contract.
 */
export async function ensureGh(cwd: string, options: { timeoutMs?: number } = {}): Promise<void> {
  const versionOut = await ghOk(cwd, ["--version"], options);
  const parsed = parseVersion(versionOut);
  if (!parsed) {
    throw new GhError("gh_error", `unrecognized gh --version output: ${versionOut.trim()}`);
  }
  const version = parsed.join(".");
  if (!versionAtLeast(version, MIN_GH_VERSION)) {
    throw new GhError("gh_error", `gh ${version} is below the required minimum ${MIN_GH_VERSION}`);
  }
  // `gh auth status` exits non-zero when no host is authenticated.
  const auth = await runGh(cwd, ["auth", "status"], options);
  if (auth.code !== 0) {
    throw new GhError(
      "gh_error",
      `gh is not authenticated: ${(auth.stderr || auth.stdout).trim() || `exit ${auth.code}`}`,
    );
  }
}

/**
 * Resolve the forge repo (`owner/name`) for a pane repository. `gh repo
 * view` inside the repo root applies the user's remote/GH_HOST
 * resolution; an explicit `repo` override skips detection entirely.
 */
export async function resolveForgeRepo(
  repoRoot: string,
  request: { repo?: string | undefined },
  options: { timeoutMs?: number } = {},
): Promise<string> {
  if (request.repo) {
    if (!/^[^\s/]+\/[^\s/]+$/.test(request.repo)) {
      throw new GhError("gh_error", `invalid --repo value: ${JSON.stringify(request.repo)}`);
    }
    return request.repo;
  }
  const out = await ghOk(
    repoRoot,
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    options,
  );
  const repo = out.trim();
  if (!/^[^\s/]+\/[^\s/]+$/.test(repo)) {
    throw new GhError("gh_error", `could not resolve forge repo for ${repoRoot}`);
  }
  return repo;
}

const PR_LIST_FIELDS = "number,title,state,isDraft,author,headRefName,baseRefName,updatedAt,url";

const PR_VIEW_FIELDS = [
  "number",
  "title",
  "state",
  "isDraft",
  "author",
  "headRefName",
  "baseRefName",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "url",
  "body",
  "additions",
  "deletions",
  "changedFiles",
  "createdAt",
  "updatedAt",
  "statusCheckRollup",
  "reviews",
].join(",");

/** Bound `gh pr view` output: truncate body, cap reviews/checks. */
const BODY_MAX_CHARS = 8000;
const REVIEWS_MAX = 10;
const CHECKS_MAX = 50;

function boundPrView(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  if (typeof out.body === "string" && out.body.length > BODY_MAX_CHARS) {
    out.body = `${out.body.slice(0, BODY_MAX_CHARS)}…`;
    out.body_truncated = true;
  }
  if (Array.isArray(out.reviews)) {
    out.reviews = (out.reviews as Record<string, unknown>[]).slice(-REVIEWS_MAX).map((r) => ({
      author: (r.author as Record<string, unknown> | undefined)?.login ?? null,
      state: r.state ?? null,
      submittedAt: r.submittedAt ?? null,
    }));
  }
  if (Array.isArray(out.statusCheckRollup)) {
    const rollup = out.statusCheckRollup as Array<Record<string, unknown>>;
    out.statusCheckRollup = rollup.slice(0, CHECKS_MAX).map((c) => ({
      name: c.name ?? null,
      status: c.status ?? null,
      conclusion: c.conclusion ?? null,
      workflow: c.workflowName ?? null,
    }));
    out.checks_truncated = rollup.length > CHECKS_MAX;
  }
  return out;
}

export interface PrListRequest {
  repo: string;
  limit?: number | undefined;
  state?: "open" | "closed" | "merged" | "all" | undefined;
  head?: string | undefined;
}

export async function collectPrList(
  repoRoot: string,
  request: PrListRequest,
  options: { timeoutMs?: number } = {},
): Promise<unknown[]> {
  const args = ["pr", "list", "--repo", request.repo, "--json", PR_LIST_FIELDS];
  if (request.limit !== undefined) args.push("--limit", String(request.limit));
  if (request.state) args.push("--state", request.state);
  if (request.head) args.push("--head", request.head);
  const out = await ghOk(repoRoot, args, options);
  const parsed = JSON.parse(out) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

export interface PrViewRequest {
  repo: string;
  number: number;
}

export async function collectPrView(
  repoRoot: string,
  request: PrViewRequest,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const out = await ghOk(
    repoRoot,
    ["pr", "view", String(request.number), "--repo", request.repo, "--json", PR_VIEW_FIELDS],
    options,
  );
  return boundPrView(JSON.parse(out) as Record<string, unknown>);
}

/**
 * `pr status`: find the open PR for the current branch, then return its
 * bounded view (includes statusCheckRollup). Returns null when the
 * branch has no open PR — a legitimate state, not an error.
 */
export async function collectPrStatus(
  repoRoot: string,
  request: { repo: string; branch: string },
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown> | null> {
  const listOut = await ghOk(
    repoRoot,
    [
      "pr",
      "list",
      "--repo",
      request.repo,
      "--head",
      request.branch,
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      "1",
    ],
    options,
  );
  const list = JSON.parse(listOut) as Array<{ number?: number }>;
  const number = list[0]?.number;
  if (number === undefined) return null;
  return collectPrView(repoRoot, { repo: request.repo, number }, options);
}

export interface PrCreateRequest {
  repo: string;
  title: string;
  /** Inline body; ignored when `bodyFile` is set. */
  body?: string | undefined;
  /** Path to a body file, or "-" for stdin. */
  bodyFile?: string | undefined;
  draft?: boolean | undefined;
  base?: string | undefined;
  head?: string | undefined;
}

/**
 * `gh pr create` prints the new PR URL on stdout. Long bodies go through
 * `--body-file` (or stdin via "-") so they never appear in argv.
 */
export async function collectPrCreate(
  repoRoot: string,
  request: PrCreateRequest,
  options: { timeoutMs?: number; bodyText?: string | undefined } = {},
): Promise<{ url: string; number: number | null }> {
  const args = ["pr", "create", "--repo", request.repo, "--title", request.title];
  if (request.bodyFile === "-") {
    args.push("--body-file", "-");
  } else if (request.bodyFile) {
    args.push("--body-file", request.bodyFile);
  } else {
    // gh prompts for a body when neither flag is given; pass an explicit
    // empty body to stay non-interactive.
    args.push("--body", request.body ?? "");
  }
  if (request.draft) args.push("--draft");
  if (request.base) args.push("--base", request.base);
  if (request.head) args.push("--head", request.head);
  const out = await ghOk(repoRoot, args, {
    ...options,
    input: request.bodyFile === "-" ? options.bodyText : undefined,
  });
  const url = out.trim().split("\n").pop() ?? "";
  const match = /\/pull\/(\d+)/.exec(url);
  return { url, number: match ? Number(match[1]) : null };
}
