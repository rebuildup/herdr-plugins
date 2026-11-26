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

export type GhErrorKind =
  | "gh_missing"
  | "timeout"
  | "gh_error"
  | "stale_head"
  | "merge_blocked"
  | "release_boundary";

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

// ---------------------------------------------------------------------------
// PR review/read extensions (Issue #171, still read-only, ADR-0008).
//
// Reviews, review requests, issue/line comments come from `gh api`
// (REST JSON). Checks come from `gh pr checks --json` — with --json the
// exporter path always exits 0 on success regardless of check state, so
// ghOk is correct here (pending/failed checks are data, not errors).
// Job/run logs come from `gh run list` / `gh run view` and are returned
// as a bounded tail. Every payload echoes head/base refs+shas so callers
// can verify freshness before any later mutation.
// ---------------------------------------------------------------------------

/** Single-page REST fetch size; a full page means "possibly more". */
const GH_API_PAGE = 100;
const PR_DETAIL_ITEMS_MAX = 50;
const PR_BODY_MAX_CHARS = 4000;
const PR_DIFF_HUNK_MAX_CHARS = 8000;
const PR_CHECKS_MAX = 100;
const PR_LOG_LINES_DEFAULT = 200;
const PR_LOG_LINES_MAX = 2000;
const PR_LOG_BYTES_MAX = 256 * 1024;
/** Whole-log fetch budget; the returned payload is still tail-bounded. */
const PR_LOG_FETCH_MAX_BUFFER = 64 * 1024 * 1024;
const PR_RUNS_MAX = 20;
const PR_RUN_JOBS_MAX = 50;

const PR_CHECKS_FIELDS = "bucket,completedAt,description,event,link,name,startedAt,state,workflow";

const PR_RUN_LIST_FIELDS =
  "databaseId,name,workflowName,status,conclusion,url,headSha,createdAt,event,displayTitle";

const PR_RUN_VIEW_FIELDS =
  "databaseId,name,workflowName,status,conclusion,url,headSha,createdAt,jobs";

async function ghApiJson(
  repoRoot: string,
  repo: string,
  endpoint: string,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const out = await ghOk(repoRoot, ["api", `repos/${repo}/${endpoint}`], options);
  return JSON.parse(out) as unknown;
}

/**
 * `gh api` mutation with a JSON body piped through stdin (`--input -`).
 * The payload never appears in argv, matching the `--body-file -` rule
 * for `pr create` — review/comment text may be arbitrarily long or
 * sensitive. DELETE sends no body and tolerates an empty response.
 */
async function ghApiCall(
  repoRoot: string,
  repo: string,
  endpoint: string,
  method: "POST" | "PUT" | "DELETE",
  payload: Record<string, unknown> | undefined,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const args = ["api", `repos/${repo}/${endpoint}`, "--method", method];
  if (payload !== undefined) args.push("--input", "-");
  const out = await ghOk(repoRoot, args, {
    ...options,
    input: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const trimmed = out.trim();
  if (!trimmed) {
    // DELETE legitimately returns an empty body; POST/PUT must produce
    // JSON — an empty response is a transport anomaly, not `{}` data.
    if (method === "DELETE") return {};
    throw new GhError("gh_error", `gh api ${endpoint}: empty response body`);
  }
  return asRecord(JSON.parse(trimmed));
}

async function ghApiPost(
  repoRoot: string,
  repo: string,
  endpoint: string,
  payload: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  return ghApiCall(repoRoot, repo, endpoint, "POST", payload, options);
}

async function ghApiPut(
  repoRoot: string,
  repo: string,
  endpoint: string,
  payload: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  return ghApiCall(repoRoot, repo, endpoint, "PUT", payload, options);
}

async function ghApiDelete(
  repoRoot: string,
  repo: string,
  endpoint: string,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  return ghApiCall(repoRoot, repo, endpoint, "DELETE", undefined, options);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Truncate long text bodies; `*_truncated` is set only when cut. */
function boundBody(value: unknown, maxChars: number): { text: string | null; truncated: boolean } {
  if (typeof value !== "string") return { text: null, truncated: false };
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: `${value.slice(0, maxChars)}…`, truncated: true };
}

interface BoundedPage<T> {
  items: T[];
  /** True when entries were capped or the fetched page was full. */
  truncated: boolean;
}

/**
 * Keep the newest `max` entries (REST lists are chronological ascending).
 * `truncated` is honest-conservative: a full page may hide further pages
 * we did not fetch, so it counts as possibly truncated.
 */
function boundPage<T>(raw: T[], max: number): BoundedPage<T> {
  return {
    items: raw.slice(-max),
    truncated: raw.length > max || raw.length >= GH_API_PAGE,
  };
}

interface PrRefs {
  head: { ref: string | null; sha: string | null };
  base: { ref: string | null; sha: string | null };
  requested_reviewers: Array<{ login: string | null }>;
  requested_teams: Array<{ name: string | null; slug: string | null }>;
}

/** `GET pulls/{n}` — head/base freshness plus review requests. */
async function fetchPrRefs(
  repoRoot: string,
  repo: string,
  number: number,
  options: { timeoutMs?: number } = {},
): Promise<PrRefs> {
  const raw = asRecord(await ghApiJson(repoRoot, repo, `pulls/${number}`, options));
  const head = asRecord(raw.head);
  const base = asRecord(raw.base);
  const reviewers = Array.isArray(raw.requested_reviewers) ? raw.requested_reviewers : [];
  const teams = Array.isArray(raw.requested_teams) ? raw.requested_teams : [];
  return {
    head: { ref: (head.ref as string) ?? null, sha: (head.sha as string) ?? null },
    base: { ref: (base.ref as string) ?? null, sha: (base.sha as string) ?? null },
    requested_reviewers: reviewers.map((u) => ({
      login: (asRecord(u).login as string) ?? null,
    })),
    requested_teams: teams.map((t) => ({
      name: (asRecord(t).name as string) ?? null,
      slug: (asRecord(t).slug as string) ?? null,
    })),
  };
}

export interface PrNumberRequest {
  repo: string;
  number: number;
}

/**
 * `pr reviews`: submitted reviews (state/author/body/submittedAt) plus
 * requested reviewers/teams, bounded. Read-only.
 */
export async function collectPrReviews(
  repoRoot: string,
  request: PrNumberRequest,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const refs = await fetchPrRefs(repoRoot, request.repo, request.number, options);
  const raw = await ghApiJson(
    repoRoot,
    request.repo,
    `pulls/${request.number}/reviews?per_page=${GH_API_PAGE}`,
    options,
  );
  if (!Array.isArray(raw)) {
    throw new GhError("gh_error", "unexpected gh api response for pull request reviews");
  }
  const reviews = raw.map((entry) => {
    const r = asRecord(entry);
    const body = boundBody(r.body, PR_BODY_MAX_CHARS);
    const item: Record<string, unknown> = {
      id: r.id ?? null,
      author: (asRecord(r.user).login as string) ?? null,
      state: r.state ?? null,
      body: body.text,
      submitted_at: r.submitted_at ?? null,
      commit_id: r.commit_id ?? null,
      url: r.html_url ?? null,
    };
    if (body.truncated) item.body_truncated = true;
    return item;
  });
  const bounded = boundPage(reviews, PR_DETAIL_ITEMS_MAX);
  return {
    number: request.number,
    head: refs.head,
    base: refs.base,
    reviews: bounded.items,
    review_requests: {
      users: refs.requested_reviewers.map((u) => u.login),
      teams: refs.requested_teams.map((t) => t.name ?? t.slug),
    },
    reviews_truncated: bounded.truncated,
  };
}

/**
 * `pr comments`: PR conversation (issue comments) and line-level review
 * comments (path/line/side/diff hunk), each bounded separately.
 */
export async function collectPrComments(
  repoRoot: string,
  request: PrNumberRequest,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const refs = await fetchPrRefs(repoRoot, request.repo, request.number, options);
  const issueRaw = await ghApiJson(
    repoRoot,
    request.repo,
    `issues/${request.number}/comments?per_page=${GH_API_PAGE}`,
    options,
  );
  const lineRaw = await ghApiJson(
    repoRoot,
    request.repo,
    `pulls/${request.number}/comments?per_page=${GH_API_PAGE}`,
    options,
  );
  if (!Array.isArray(issueRaw) || !Array.isArray(lineRaw)) {
    throw new GhError("gh_error", "unexpected gh api response for pull request comments");
  }

  const issueComments = issueRaw.map((entry) => {
    const c = asRecord(entry);
    const body = boundBody(c.body, PR_BODY_MAX_CHARS);
    const item: Record<string, unknown> = {
      id: c.id ?? null,
      author: (asRecord(c.user).login as string) ?? null,
      body: body.text,
      created_at: c.created_at ?? null,
      updated_at: c.updated_at ?? null,
      url: c.html_url ?? null,
    };
    if (body.truncated) item.body_truncated = true;
    return item;
  });
  const boundedIssue = boundPage(issueComments, PR_DETAIL_ITEMS_MAX);

  const lineComments = lineRaw.map((entry) => {
    const c = asRecord(entry);
    const body = boundBody(c.body, PR_BODY_MAX_CHARS);
    const hunk = boundBody(c.diff_hunk, PR_DIFF_HUNK_MAX_CHARS);
    const item: Record<string, unknown> = {
      id: c.id ?? null,
      author: (asRecord(c.user).login as string) ?? null,
      path: c.path ?? null,
      line: c.line ?? null,
      original_line: c.original_line ?? null,
      side: c.side ?? null,
      in_reply_to_id: c.in_reply_to_id ?? null,
      body: body.text,
      diff_hunk: hunk.text,
      created_at: c.created_at ?? null,
      updated_at: c.updated_at ?? null,
      url: c.html_url ?? null,
    };
    if (body.truncated) item.body_truncated = true;
    if (hunk.truncated) item.diff_hunk_truncated = true;
    return item;
  });
  const boundedLine = boundPage(lineComments, PR_DETAIL_ITEMS_MAX);

  return {
    number: request.number,
    head: refs.head,
    base: refs.base,
    issue_comments: boundedIssue.items,
    line_comments: boundedLine.items,
    issue_comments_truncated: boundedIssue.truncated,
    line_comments_truncated: boundedLine.truncated,
  };
}

/**
 * `pr checks`: per-check detail via `gh pr checks --json` (name, bucket,
 * state, workflow, link, description, timings, event). gh exits 0 in
 * JSON mode even when checks fail or are pending — those are data.
 * A PR with no reported checks maps to an empty list, not an error.
 */
export async function collectPrChecks(
  repoRoot: string,
  request: PrNumberRequest,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const refs = await fetchPrRefs(repoRoot, request.repo, request.number, options);
  let rawText: string;
  try {
    rawText = await ghOk(
      repoRoot,
      ["pr", "checks", String(request.number), "--repo", request.repo, "--json", PR_CHECKS_FIELDS],
      options,
    );
  } catch (err) {
    if (err instanceof GhError && /no checks reported/.test(err.message)) {
      rawText = "[]";
    } else {
      throw err;
    }
  }
  const parsed = JSON.parse(rawText) as unknown;
  const checks = (Array.isArray(parsed) ? parsed : []).slice(0, PR_CHECKS_MAX).map((entry) => {
    const c = asRecord(entry);
    return {
      name: c.name ?? null,
      bucket: c.bucket ?? null,
      state: c.state ?? null,
      workflow: c.workflow ?? null,
      link: c.link ?? null,
      description: c.description ?? null,
      event: c.event ?? null,
      started_at: c.startedAt ?? null,
      completed_at: c.completedAt ?? null,
    };
  });
  return {
    number: request.number,
    head: refs.head,
    base: refs.base,
    checks,
    checks_truncated: Array.isArray(parsed) && parsed.length > PR_CHECKS_MAX,
  };
}

export interface PrLogsRequest extends PrNumberRequest {
  /** Workflow run id — list that run's jobs. */
  runId?: string | undefined;
  /** Actions job id — fetch that job's log tail. */
  jobId?: string | undefined;
  /** Tail length in lines for job logs (default 200, max 2000). */
  lines?: number | undefined;
}

function mapGhRun(raw: unknown): Record<string, unknown> {
  const r = asRecord(raw);
  return {
    id: r.databaseId ?? null,
    name: r.name ?? null,
    workflow: r.workflowName ?? null,
    status: r.status ?? null,
    conclusion: r.conclusion ?? null,
    url: r.url ?? null,
    head_sha: r.headSha ?? null,
    created_at: r.createdAt ?? null,
    event: r.event ?? null,
    display_title: r.displayTitle ?? null,
  };
}

function mapGhJob(raw: unknown): Record<string, unknown> {
  const j = asRecord(raw);
  return {
    id: j.databaseId ?? null,
    name: j.name ?? null,
    status: j.status ?? null,
    conclusion: j.conclusion ?? null,
    url: j.url ?? null,
    started_at: j.startedAt ?? null,
    completed_at: j.completedAt ?? null,
  };
}

/**
 * `pr logs`: workflow runs for the PR head (default), a run's job list
 * (`runId`), or a job's bounded log tail (`jobId`). All modes echo
 * head/base freshness. Read-only.
 */
export async function collectPrLogs(
  repoRoot: string,
  request: PrLogsRequest,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const refs = await fetchPrRefs(repoRoot, request.repo, request.number, options);
  const base = { number: request.number, head: refs.head, base: refs.base };

  if (request.jobId) {
    const headSha = refs.head.sha;
    if (!headSha) {
      throw new GhError("gh_error", "pull request head sha unavailable for log lookup");
    }
    const log = await ghOk(
      repoRoot,
      ["run", "view", "--job", request.jobId, "--repo", request.repo, "--log"],
      { ...options, maxBuffer: PR_LOG_FETCH_MAX_BUFFER },
    );
    const lines = Math.min(Math.max(request.lines ?? PR_LOG_LINES_DEFAULT, 1), PR_LOG_LINES_MAX);
    const allLines = log.replace(/\r\n/g, "\n").split("\n");
    const tailLines = allLines.slice(-lines);
    let text = tailLines.join("\n");
    let truncated = allLines.length > tailLines.length;
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > PR_LOG_BYTES_MAX) {
      text = Buffer.from(text, "utf8")
        .subarray(Buffer.byteLength(text, "utf8") - PR_LOG_BYTES_MAX)
        .toString("utf8");
      truncated = true;
    }
    return {
      ...base,
      mode: "job",
      job_id: request.jobId,
      head_sha: headSha,
      log: text,
      lines_returned: tailLines.length,
      total_lines: allLines.length,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated,
    };
  }

  if (request.runId) {
    const out = await ghOk(
      repoRoot,
      ["run", "view", request.runId, "--repo", request.repo, "--json", PR_RUN_VIEW_FIELDS],
      options,
    );
    const parsed = asRecord(JSON.parse(out) as unknown);
    const jobsRaw = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    const bounded = jobsRaw.slice(0, PR_RUN_JOBS_MAX);
    return {
      ...base,
      mode: "run",
      run: mapGhRun(parsed),
      jobs: bounded.map(mapGhJob),
      jobs_truncated: jobsRaw.length > PR_RUN_JOBS_MAX,
    };
  }

  const headSha = refs.head.sha;
  if (!headSha) {
    throw new GhError("gh_error", "pull request head sha unavailable for run lookup");
  }
  const out = await ghOk(
    repoRoot,
    [
      "run",
      "list",
      "--repo",
      request.repo,
      "--commit",
      headSha,
      "--limit",
      String(PR_RUNS_MAX),
      "--json",
      PR_RUN_LIST_FIELDS,
    ],
    options,
  );
  const parsed = JSON.parse(out) as unknown;
  const runs = Array.isArray(parsed) ? parsed.slice(0, PR_RUNS_MAX) : [];
  return {
    ...base,
    mode: "runs",
    head_sha: headSha,
    runs: runs.map(mapGhRun),
    runs_truncated: Array.isArray(parsed) && parsed.length > PR_RUNS_MAX,
  };
}

// ---------------------------------------------------------------------------
// PR review/comment mutations (Issue #172, still ADR-0008 gh-CLI discipline).
//
// Every mutation re-fetches `GET pulls/{n}` immediately before writing and
// refuses with GhError("stale_head") when the live head sha differs from the
// caller-supplied `--expect-head` — a review must never land on a commit the
// caller did not last read. Review submission additionally pins
// `commit_id` to that verified head sha in the POST body, so the object
// GitHub records is bound to exactly the sha that passed the guard.
//
// github-delivery boundary: these are explicit user/agent invocations only.
// There is no automation path that submits reviews, posts comments, or
// touches release PRs — in particular the plugin never approves or merges a
// release-* -> main PR on its own.
// ---------------------------------------------------------------------------

/** 40-hex (sha1) or 64-hex (sha256) object id; short shas are rejected. */
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

export function isValidHeadSha(value: string): boolean {
  return HEAD_SHA_PATTERN.test(value);
}

export interface PrMutationRequest extends PrNumberRequest {
  /**
   * Stale-head guard (mandatory): the full head sha the caller last
   * observed via a read surface (`head.sha` in `pr view`/`pr reviews`/
   * `pr comments`/`pr checks`/`pr logs` payloads).
   */
  expectHead: string;
}

/**
 * Re-fetch the PR and require `head.sha === expectHead`. Returns the refs
 * so callers can echo head/base (and pin `commit_id`) without a second
 * fetch. A moved or unreadable head is a structured refusal, never a
 * silent proceed.
 */
async function assertHeadFresh(
  repoRoot: string,
  repo: string,
  number: number,
  expectHead: string,
  options: { timeoutMs?: number } = {},
): Promise<PrRefs> {
  const refs = await fetchPrRefs(repoRoot, repo, number, options);
  const headSha = refs.head.sha;
  if (!headSha) {
    throw new GhError("gh_error", "pull request head sha unavailable for mutation");
  }
  if (headSha !== expectHead) {
    throw new GhError(
      "stale_head",
      `pull request #${number} head moved: expected ${expectHead}, current ${headSha}`,
    );
  }
  return refs;
}

export type PrReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface PrLineComment {
  path: string;
  /** Line on the RIGHT (new) or LEFT (old) side of the diff. */
  line: number;
  side?: "RIGHT" | "LEFT" | undefined;
  body: string;
}

export interface PrReviewRequest extends PrMutationRequest {
  event: PrReviewEvent;
  /** Review summary body; may be empty for bare approve/request-changes. */
  body?: string | undefined;
  /** Optional line comments anchored to the diff (REST `comments` array). */
  comments?: PrLineComment[] | undefined;
}

function validateLineComments(comments: PrLineComment[]): void {
  for (const [i, c] of comments.entries()) {
    if (typeof c.path !== "string" || c.path.length === 0 || c.path.length > 4096) {
      throw new GhError("gh_error", `line comment ${i}: invalid path`);
    }
    if (!Number.isInteger(c.line) || c.line < 1) {
      throw new GhError("gh_error", `line comment ${i}: line must be a positive integer`);
    }
    if (c.side !== undefined && c.side !== "RIGHT" && c.side !== "LEFT") {
      throw new GhError("gh_error", `line comment ${i}: side must be RIGHT or LEFT`);
    }
    if (typeof c.body !== "string" || c.body.trim().length === 0) {
      throw new GhError("gh_error", `line comment ${i}: body must be non-empty`);
    }
  }
}

/** Bounded echo of the review object gh api returns. */
function mapGhReview(raw: Record<string, unknown>): Record<string, unknown> {
  const body = boundBody(raw.body, PR_BODY_MAX_CHARS);
  const item: Record<string, unknown> = {
    id: raw.id ?? null,
    author: (asRecord(raw.user).login as string) ?? null,
    state: raw.state ?? null,
    commit_id: raw.commit_id ?? null,
    submitted_at: raw.submitted_at ?? null,
    url: raw.html_url ?? null,
    body: body.text,
  };
  if (body.truncated) item.body_truncated = true;
  return item;
}

/** Bounded echo of an issue/line comment object gh api returns. */
function mapGhComment(raw: Record<string, unknown>): Record<string, unknown> {
  const body = boundBody(raw.body, PR_BODY_MAX_CHARS);
  const item: Record<string, unknown> = {
    id: raw.id ?? null,
    author: (asRecord(raw.user).login as string) ?? null,
    body: body.text,
    created_at: raw.created_at ?? null,
    updated_at: raw.updated_at ?? null,
    url: raw.html_url ?? null,
  };
  if (body.truncated) item.body_truncated = true;
  return item;
}

function mapReviewRequests(refs: PrRefs): Record<string, unknown> {
  return {
    users: refs.requested_reviewers.map((u) => u.login),
    teams: refs.requested_teams.map((t) => t.name ?? t.slug),
  };
}

/**
 * `pr review`: submit APPROVE / REQUEST_CHANGES / COMMENT via
 * `POST pulls/{n}/reviews`. One transport covers both plain reviews and
 * reviews carrying line comments (`comments[]` with path/line/side/body)
 * because `gh pr review` cannot express the latter. The POST pins
 * `commit_id` to the head sha verified by the stale-head guard.
 */
export async function submitPrReview(
  repoRoot: string,
  request: PrReviewRequest,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const refs = await assertHeadFresh(
    repoRoot,
    request.repo,
    request.number,
    request.expectHead,
    options,
  );
  const comments = request.comments ?? [];
  validateLineComments(comments);
  const payload: Record<string, unknown> = {
    commit_id: refs.head.sha,
    event: request.event,
  };
  if (request.body !== undefined) payload.body = request.body;
  if (comments.length > 0) {
    payload.comments = comments.map((c) => {
      const entry: Record<string, unknown> = {
        path: c.path,
        line: c.line,
        body: c.body,
      };
      if (c.side) entry.side = c.side;
      return entry;
    });
  }
  const review = await ghApiPost(
    repoRoot,
    request.repo,
    `pulls/${request.number}/reviews`,
    payload,
    options,
  );
  return {
    number: request.number,
    head: refs.head,
    base: refs.base,
    review: mapGhReview(review),
  };
}

/**
 * `pr comment`: post a PR-conversation comment via
 * `POST issues/{n}/comments` (`gh pr comment` equivalent; issues and PRs
 * share the endpoint).
 */
export async function submitPrComment(
  repoRoot: string,
  request: PrMutationRequest & { body: string },
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const refs = await assertHeadFresh(
    repoRoot,
    request.repo,
    request.number,
    request.expectHead,
    options,
  );
  const comment = await ghApiPost(
    repoRoot,
    request.repo,
    `issues/${request.number}/comments`,
    { body: request.body },
    options,
  );
  return {
    number: request.number,
    head: refs.head,
    base: refs.base,
    comment: mapGhComment(comment),
  };
}

/**
 * `pr reply`: reply inside a review thread via
 * `POST pulls/{n}/comments/{commentId}/replies`.
 */
export async function submitPrReply(
  repoRoot: string,
  request: PrMutationRequest & { commentId: number; body: string },
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const refs = await assertHeadFresh(
    repoRoot,
    request.repo,
    request.number,
    request.expectHead,
    options,
  );
  const comment = await ghApiPost(
    repoRoot,
    request.repo,
    `pulls/${request.number}/comments/${request.commentId}/replies`,
    { body: request.body },
    options,
  );
  return {
    number: request.number,
    comment_id: request.commentId,
    head: refs.head,
    base: refs.base,
    comment: mapGhComment(comment),
  };
}

const REVIEWER_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/;

export interface PrReviewersRequest extends PrMutationRequest {
  add?: string[] | undefined;
  remove?: string[] | undefined;
}

/**
 * `pr reviewers`: request/dismiss reviewers via `gh pr edit
 * --add-reviewer/--remove-reviewer`. Re-fetches refs afterwards so the
 * echoed `review_requests` reflect the post-mutation state.
 */
export async function updatePrReviewers(
  repoRoot: string,
  request: PrReviewersRequest,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  await assertHeadFresh(repoRoot, request.repo, request.number, request.expectHead, options);
  const add = request.add ?? [];
  const remove = request.remove ?? [];
  for (const [list, what] of [
    [add, "--add-reviewer"],
    [remove, "--remove-reviewer"],
  ] as const) {
    for (const login of list) {
      if (!REVIEWER_LOGIN_PATTERN.test(login)) {
        throw new GhError(
          "gh_error",
          `invalid reviewer login for ${what}: ${JSON.stringify(login)}`,
        );
      }
    }
  }
  if (add.length === 0 && remove.length === 0) {
    throw new GhError("gh_error", "at least one of --add-reviewer/--remove-reviewer is required");
  }
  const args = ["pr", "edit", String(request.number), "--repo", request.repo];
  if (add.length > 0) args.push("--add-reviewer", add.join(","));
  if (remove.length > 0) args.push("--remove-reviewer", remove.join(","));
  await ghOk(repoRoot, args, options);
  // Echo the post-mutation state: requested reviewers may have changed.
  const after = await fetchPrRefs(repoRoot, request.repo, request.number, options);
  return {
    number: request.number,
    head: after.head,
    base: after.base,
    review_requests: mapReviewRequests(after),
  };
}

// ---------------------------------------------------------------------------
// PR merge / auto-merge (Issue #173, ADR-0030).
//
// Same ADR-0008 discipline: argv-only `gh` spawn, `--input -` payloads,
// `--expect-head` stale-head guard. Merge state is re-verified
// immediately before the write via `gh pr view --json` (mergeStateStatus /
// reviewDecision / isDraft / headRefOid) so the merge binds exactly the
// head sha the caller last read; the REST `sha` parameter pins it
// server-side as well.
//
// github-delivery boundary (hard guard): a PR whose head branch matches
// the release-train pattern `release-<digits>(-<digits>)*` is refused
// with GhError("release_boundary") for merge AND auto-merge — release
// approval stays a maintainer decision and the plugin never automates
// or proxies it. Ticket PRs targeting a release branch as *base* are
// unaffected (the guard keys on the head ref only).
// ---------------------------------------------------------------------------

const PR_MERGE_VIEW_FIELDS = [
  "number",
  "state",
  "isDraft",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "headRefOid",
  "headRefName",
  "baseRefName",
  "url",
  "autoMergeRequest",
].join(",");

/** Release-train head branches (`release-0-9-0`, `release-1`, …). */
const RELEASE_HEAD_PATTERN = /^release-\d+(-\d+)*$/i;

/** `gh pr view --json` merge-state projection used by the merge guard. */
async function fetchPrMergeState(
  repoRoot: string,
  repo: string,
  number: number,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const out = await ghOk(
    repoRoot,
    ["pr", "view", String(number), "--repo", repo, "--json", PR_MERGE_VIEW_FIELDS],
    options,
  );
  return asRecord(JSON.parse(out) as unknown);
}

function upperOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.toUpperCase() : null;
}

function mapAutoMergeRequest(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return {
    merge_method: r.mergeMethod ?? null,
    enabled_at: r.enabledAt ?? null,
  };
}

export type PrMergeMethod = "merge" | "squash" | "rebase";

export interface PrMergeRequest extends PrMutationRequest {
  /** Merge method; required for `auto`, optional for immediate merge. */
  method?: PrMergeMethod | undefined;
  /** Arm GitHub auto-merge (fires when branch protection clears). */
  auto?: boolean | undefined;
  /** Disarm auto-merge (`DELETE …/auto-merge`). */
  disableAuto?: boolean | undefined;
}

/**
 * mergeStateStatus values that make an immediate merge impossible or
 * unknowable. UNSTABLE (non-required checks failing) and CLEAN proceed —
 * GitHub remains the authority on required gates; anything else is a
 * structured refusal, never a silent proceed. Auto-merge is the
 * sanctioned path for pending/blocked-on-checks states, so it refuses
 * only states that cannot resolve themselves (DIRTY/DRAFT/UNKNOWN).
 */
const MERGE_STATE_REFUSED = new Set([
  "BEHIND",
  "BLOCKED",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
]);
const AUTO_MERGE_STATE_REFUSED = new Set(["DIRTY", "DRAFT", "UNKNOWN"]);

function mergeBlockedMessage(
  number: number,
  view: Record<string, unknown>,
  reason: string,
): string {
  const parts = [
    `pull request #${number} ${reason}`,
    `mergeStateStatus=${upperOrNull(view.mergeStateStatus) ?? "null"}`,
    `reviewDecision=${upperOrNull(view.reviewDecision) ?? "null"}`,
    `mergeable=${upperOrNull(view.mergeable) ?? "null"}`,
    `isDraft=${view.isDraft === true}`,
  ];
  if (typeof view.headRefName === "string") parts.push(`head=${view.headRefName}`);
  if (typeof view.baseRefName === "string") parts.push(`base=${view.baseRefName}`);
  return parts.join(" ");
}

/**
 * Map gh's HTTP failure for a merge write to the honest taxonomy:
 * 405/409/422 are GitHub refusing the merge itself (protection, conflicts,
 * validation) → `merge_blocked`; everything else stays `gh_error`.
 */
async function mergeWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (
      err instanceof GhError &&
      err.kind === "gh_error" &&
      /HTTP (405|409|422)\b/.test(err.message)
    ) {
      throw new GhError("merge_blocked", err.message);
    }
    throw err;
  }
}

/**
 * `pr merge`: immediate merge (`PUT pulls/{n}/merge`), auto-merge enable
 * (`POST pulls/{n}/auto-merge`), or auto-merge disable
 * (`DELETE pulls/{n}/auto-merge`). The pre-write guard re-fetches the PR
 * merge state and requires `headRefOid === expectHead` — the REST `sha`
 * field then pins the same sha server-side. The result is re-fetched
 * afterwards so `state`/`auto_merge_request` report what GitHub
 * actually did (merged, queued-for-auto-merge, or still open).
 */
export async function mergePr(
  repoRoot: string,
  request: PrMergeRequest,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  if (request.auto && request.disableAuto) {
    throw new GhError("gh_error", "--auto and --disable-auto are mutually exclusive");
  }
  if (request.auto && request.method === undefined) {
    throw new GhError("gh_error", "auto-merge requires an explicit merge method");
  }
  if (request.disableAuto && request.method !== undefined) {
    throw new GhError("gh_error", "merge method is meaningless with --disable-auto");
  }

  const view = await fetchPrMergeState(repoRoot, request.repo, request.number, options);
  const headSha = typeof view.headRefOid === "string" ? view.headRefOid : null;
  if (!headSha) {
    throw new GhError("gh_error", "pull request head sha unavailable for merge");
  }
  if (headSha !== request.expectHead) {
    throw new GhError(
      "stale_head",
      `pull request #${request.number} head moved: expected ${request.expectHead}, current ${headSha}`,
    );
  }
  const headRef = typeof view.headRefName === "string" ? view.headRefName : "";
  const prState = upperOrNull(view.state);
  const mergeState = upperOrNull(view.mergeStateStatus);
  const isDraft = view.isDraft === true;

  // github-delivery boundary: never merge or arm auto-merge on a
  // release-train head branch — that approval belongs to the maintainer.
  if (RELEASE_HEAD_PATTERN.test(headRef)) {
    throw new GhError(
      "release_boundary",
      `refusing to merge release-train head '${headRef}': release approval is a maintainer decision (github-delivery)`,
    );
  }
  if (prState !== "OPEN") {
    throw new GhError(
      "merge_blocked",
      mergeBlockedMessage(
        request.number,
        view,
        `is ${prState?.toLowerCase() ?? "unknown"}, not open`,
      ),
    );
  }

  let result: string;
  let mergeEcho: Record<string, unknown> | null = null;
  const endpoint = `pulls/${request.number}`;

  if (request.disableAuto) {
    await mergeWrite(() => ghApiDelete(repoRoot, request.repo, `${endpoint}/auto-merge`, options));
    result = "auto_merge_disabled";
  } else if (request.auto) {
    if (isDraft) {
      throw new GhError("merge_blocked", mergeBlockedMessage(request.number, view, "is a draft"));
    }
    if (mergeState !== null && AUTO_MERGE_STATE_REFUSED.has(mergeState)) {
      throw new GhError(
        "merge_blocked",
        mergeBlockedMessage(request.number, view, "cannot be queued for auto-merge"),
      );
    }
    mergeEcho = await mergeWrite(() =>
      ghApiPost(
        repoRoot,
        request.repo,
        `${endpoint}/auto-merge`,
        { merge_method: request.method },
        options,
      ),
    );
    result = "auto_merge_enabled";
  } else {
    if (isDraft) {
      throw new GhError("merge_blocked", mergeBlockedMessage(request.number, view, "is a draft"));
    }
    if (mergeState === null || MERGE_STATE_REFUSED.has(mergeState)) {
      throw new GhError(
        "merge_blocked",
        mergeBlockedMessage(request.number, view, "is not mergeable"),
      );
    }
    const payload: Record<string, unknown> = { sha: headSha };
    if (request.method !== undefined) payload.merge_method = request.method;
    mergeEcho = await mergeWrite(() =>
      ghApiPut(repoRoot, request.repo, `${endpoint}/merge`, payload, options),
    );
    // Honest result: GitHub may accept the call yet leave the PR open
    // (e.g. merge queue deferral) — never claim merged on its behalf.
    result = mergeEcho.merged === true ? "merged" : "pending";
  }

  // Post-write truth: re-fetch state + refs so callers see exactly what
  // GitHub recorded (state, auto_merge_request, head/base).
  const [after, refs] = await Promise.all([
    fetchPrMergeState(repoRoot, request.repo, request.number, options),
    fetchPrRefs(repoRoot, request.repo, request.number, options),
  ]);
  const out: Record<string, unknown> = {
    number: request.number,
    head: refs.head,
    base: refs.base,
    action: request.disableAuto
      ? "auto_merge_disable"
      : request.auto
        ? "auto_merge_enable"
        : "merge",
    method: request.method ?? null,
    result,
    pre_merge_state: {
      merge_state_status: mergeState,
      review_decision: upperOrNull(view.reviewDecision),
      mergeable: upperOrNull(view.mergeable),
    },
    state: upperOrNull(after.state),
    is_draft: after.isDraft === true,
    auto_merge_request: mapAutoMergeRequest(after.autoMergeRequest),
    // Bounded echo of the REST write response ({merged, sha, message} for
    // merge; the auto-merge request object for enable). Small by
    // construction — no user content flows through these endpoints.
    merge: mergeEcho,
  };
  return out;
}
