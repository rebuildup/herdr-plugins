import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectPrChecks,
  collectPrComments,
  collectPrCreate,
  collectPrList,
  collectPrLogs,
  collectPrReviews,
  collectPrStatus,
  collectPrView,
  ensureGh,
  GhError,
  resolveForgeRepo,
  versionAtLeast,
} from "../plugins/git/src/gh";

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "PATH",
  "GH_STUB_LOG",
  "GH_STUB_VERSION",
  "GH_STUB_AUTH_FAIL",
  "GH_STUB_REPO",
  "GH_STUB_LIST_JSON",
  "GH_STUB_VIEW_JSON",
  "GH_STUB_PR_DETAIL_JSON",
  "GH_STUB_REVIEWS_JSON",
  "GH_STUB_ISSUE_COMMENTS_JSON",
  "GH_STUB_LINE_COMMENTS_JSON",
  "GH_STUB_CHECKS_JSON",
  "GH_STUB_CHECKS_FAIL",
  "GH_STUB_RUNS_JSON",
  "GH_STUB_RUN_VIEW_JSON",
  "GH_STUB_JOB_LOG",
];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-plugin-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) continue;
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
    delete savedEnv[key];
  }
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const STUB = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "\${GH_STUB_LOG:-/dev/null}"
case "\${1:-}" in
  --version) echo "gh version \${GH_STUB_VERSION:-2.105.0}"; exit 0;;
  auth)
    if [ "\${GH_STUB_AUTH_FAIL:-0}" = "1" ]; then echo "not logged in" >&2; exit 1; fi
    echo "github.com"; exit 0;;
  repo) echo "\${GH_STUB_REPO:-octo/widgets}"; exit 0;;
  api)
    case "$*" in
      *pulls/*/reviews*) cat "\${GH_STUB_REVIEWS_JSON:-/dev/null}";;
      *issues/*/comments*) cat "\${GH_STUB_ISSUE_COMMENTS_JSON:-/dev/null}";;
      *pulls/*/comments*) cat "\${GH_STUB_LINE_COMMENTS_JSON:-/dev/null}";;
      *pulls/*) cat "\${GH_STUB_PR_DETAIL_JSON:-/dev/null}";;
      *) exit 1;;
    esac
    exit 0;;
  pr)
    case "\${2:-}" in
      list) cat "\${GH_STUB_LIST_JSON:-/dev/null}" 2>/dev/null || echo '[]';;
      view) cat "\${GH_STUB_VIEW_JSON:-/dev/null}";;
      checks)
        if [ "\${GH_STUB_CHECKS_FAIL:-0}" = "1" ]; then
          echo "no checks reported on the 'feature' branch" >&2; exit 1
        fi
        cat "\${GH_STUB_CHECKS_JSON:-/dev/null}";;
      create) echo "https://github.com/octo/widgets/pull/42";;
      *) exit 1;;
    esac
    exit 0;;
  run)
    case "\${2:-}" in
      list) cat "\${GH_STUB_RUNS_JSON:-/dev/null}";;
      view)
        case "$*" in
          *--log*) cat "\${GH_STUB_JOB_LOG:-/dev/null}";;
          *) cat "\${GH_STUB_RUN_VIEW_JSON:-/dev/null}";;
        esac;;
      *) exit 1;;
    esac
    exit 0;;
esac
exit 1
`;

function installGhStub(): { binDir: string; logFile: string; work: string } {
  const binDir = tempDir();
  const work = tempDir();
  const logFile = path.join(work, "gh.log");
  writeFileSync(path.join(binDir, "gh"), STUB);
  chmodSync(path.join(binDir, "gh"), 0o755);
  setEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
  setEnv("GH_STUB_LOG", logFile);
  return { binDir, logFile, work };
}

function stubCalls(logFile: string): string[] {
  try {
    return readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("versionAtLeast", () => {
  test("compares semver triplets", () => {
    expect(versionAtLeast("2.105.0", "2.81.0")).toBe(true);
    expect(versionAtLeast("2.81.0", "2.81.0")).toBe(true);
    expect(versionAtLeast("2.80.9", "2.81.0")).toBe(false);
    expect(versionAtLeast("10.0.0", "2.81.0")).toBe(true);
    expect(versionAtLeast("garbage", "2.81.0")).toBe(false);
  });
});

describe("ensureGh", () => {
  test("missing gh binary is a structured gh_missing error", async () => {
    const empty = tempDir();
    setEnv("PATH", empty);
    await expect(ensureGh(tempDir())).rejects.toMatchObject({ kind: "gh_missing" });
  });

  test("old gh version is rejected", async () => {
    installGhStub();
    setEnv("GH_STUB_VERSION", "2.80.0");
    await expect(ensureGh(tempDir())).rejects.toMatchObject({ kind: "gh_error" });
  });

  test("unauthenticated gh is a structured error", async () => {
    installGhStub();
    setEnv("GH_STUB_AUTH_FAIL", "1");
    await expect(ensureGh(tempDir())).rejects.toMatchObject({
      kind: "gh_error",
      message: expect.stringContaining("not authenticated"),
    });
  });

  test("happy path passes version + auth checks", async () => {
    installGhStub();
    await ensureGh(tempDir());
  });
});

describe("resolveForgeRepo", () => {
  test("explicit --repo override skips detection", async () => {
    const { logFile } = installGhStub();
    const repo = await resolveForgeRepo(tempDir(), { repo: "octo/override" });
    expect(repo).toBe("octo/override");
    expect(stubCalls(logFile)).toEqual([]);
  });

  test("resolves via gh repo view inside the repo root", async () => {
    const { logFile } = installGhStub();
    const repo = await resolveForgeRepo(tempDir(), {});
    expect(repo).toBe("octo/widgets");
    expect(stubCalls(logFile)[0]).toContain("repo view");
  });
});

describe("pr list", () => {
  test("assembles argv and parses JSON output", async () => {
    const { logFile, work } = installGhStub();
    const listFile = path.join(work, "list.json");
    writeFileSync(listFile, JSON.stringify([{ number: 1, title: "t", state: "OPEN", url: "u" }]));
    setEnv("GH_STUB_LIST_JSON", listFile);
    const prs = await collectPrList(tempDir(), {
      repo: "octo/widgets",
      limit: 5,
      state: "open",
      head: "feature",
    });
    expect(prs).toHaveLength(1);
    const call = stubCalls(logFile).find((c) => c.startsWith("pr list"));
    expect(call).toContain("--repo octo/widgets");
    expect(call).toContain("--limit 5");
    expect(call).toContain("--state open");
    expect(call).toContain("--head feature");
    expect(call).toContain("--json");
  });
});

describe("pr view / status", () => {
  test("view bounds body and review/check payloads", async () => {
    const { work } = installGhStub();
    const viewFile = path.join(work, "view.json");
    writeFileSync(
      viewFile,
      JSON.stringify({
        number: 7,
        title: "big",
        body: "x".repeat(9000),
        reviews: Array.from({ length: 15 }, (_, i) => ({
          author: { login: `u${i}` },
          state: "APPROVED",
          submittedAt: "t",
        })),
        statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    );
    setEnv("GH_STUB_VIEW_JSON", viewFile);
    const pr = (await collectPrView(tempDir(), { repo: "octo/widgets", number: 7 })) as {
      body: string;
      body_truncated?: boolean;
      reviews: unknown[];
    };
    expect(pr.body_truncated).toBe(true);
    expect(pr.body.length).toBeLessThan(8100);
    expect(pr.reviews).toHaveLength(10);
  });

  test("status returns null when the branch has no open PR", async () => {
    const { work } = installGhStub();
    setEnv("GH_STUB_LIST_JSON", path.join(work, "empty.json"));
    writeFileSync(path.join(work, "empty.json"), "[]");
    const pr = await collectPrStatus(tempDir(), { repo: "octo/widgets", branch: "main" });
    expect(pr).toBeNull();
  });

  test("status returns the linked PR view when present", async () => {
    const { work } = installGhStub();
    const listFile = path.join(work, "list.json");
    writeFileSync(listFile, JSON.stringify([{ number: 7 }]));
    setEnv("GH_STUB_LIST_JSON", listFile);
    const viewFile = path.join(work, "view.json");
    writeFileSync(viewFile, JSON.stringify({ number: 7, title: "linked" }));
    setEnv("GH_STUB_VIEW_JSON", viewFile);
    const pr = await collectPrStatus(tempDir(), { repo: "octo/widgets", branch: "feature" });
    expect(pr).toMatchObject({ number: 7, title: "linked" });
  });
});

describe("pr create", () => {
  test("body travels via --body-file stdin, never inline argv", async () => {
    const { logFile } = installGhStub();
    const longBody = "body line\n".repeat(2000);
    const result = await collectPrCreate(
      tempDir(),
      {
        repo: "octo/widgets",
        title: "add thing",
        bodyFile: "-",
        draft: true,
        base: "main",
      },
      { bodyText: longBody },
    );
    expect(result).toEqual({
      url: "https://github.com/octo/widgets/pull/42",
      number: 42,
    });
    const call = stubCalls(logFile).find((c) => c.startsWith("pr create"));
    expect(call).toContain("--body-file -");
    expect(call).toContain("--draft");
    expect(call).toContain("--base main");
    expect(call).not.toContain("body line");
  });

  test("inline --body is passed as an argv value", async () => {
    const { logFile } = installGhStub();
    await collectPrCreate(tempDir(), {
      repo: "octo/widgets",
      title: "t",
      body: "short body",
    });
    const call = stubCalls(logFile).find((c) => c.startsWith("pr create"));
    expect(call).toContain("--body short body");
  });

  test("invalid --repo values are rejected before any gh call", async () => {
    const { logFile } = installGhStub();
    await expect(
      resolveForgeRepo(tempDir(), { repo: "bad repo name with spaces!!" }),
    ).rejects.toMatchObject({ kind: "gh_error" });
    expect(stubCalls(logFile)).toEqual([]);
  });
});

const PR_DETAIL = {
  number: 7,
  head: { ref: "feature/x", sha: "abc123" },
  base: { ref: "main", sha: "def456" },
  requested_reviewers: [{ login: "rev1" }, { login: "rev2" }],
  requested_teams: [{ name: "team-a", slug: "team-a" }],
};

function writeStubJson(work: string, name: string, value: unknown): string {
  const file = path.join(work, name);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

describe("pr reviews", () => {
  test("returns bounded reviews plus review requests and head/base", async () => {
    const { work, logFile } = installGhStub();
    setEnv("GH_STUB_PR_DETAIL_JSON", writeStubJson(work, "detail.json", PR_DETAIL));
    setEnv(
      "GH_STUB_REVIEWS_JSON",
      writeStubJson(work, "reviews.json", [
        {
          id: 1,
          user: { login: "alice" },
          state: "APPROVED",
          body: "looks good",
          submitted_at: "2026-01-01T00:00:00Z",
          commit_id: "abc123",
          html_url: "https://example.com/r/1",
        },
        {
          id: 2,
          user: { login: "bob" },
          state: "CHANGES_REQUESTED",
          body: "x".repeat(5000),
          submitted_at: "2026-01-02T00:00:00Z",
          commit_id: "abc123",
          html_url: "https://example.com/r/2",
        },
      ]),
    );
    const out = (await collectPrReviews(tempDir(), { repo: "octo/widgets", number: 7 })) as {
      head: { ref: string; sha: string };
      base: { ref: string };
      reviews: Array<{ author: string; body_truncated?: boolean }>;
      review_requests: { users: unknown[]; teams: unknown[] };
      reviews_truncated: boolean;
    };
    expect(out.head).toEqual({ ref: "feature/x", sha: "abc123" });
    expect(out.base.ref).toBe("main");
    expect(out.reviews).toHaveLength(2);
    expect(out.reviews[0]).toMatchObject({ author: "alice", state: "APPROVED" });
    expect(out.reviews[1]?.body_truncated).toBe(true);
    expect(out.review_requests.users).toEqual(["rev1", "rev2"]);
    expect(out.review_requests.teams).toEqual(["team-a"]);
    expect(out.reviews_truncated).toBe(false);
    const calls = stubCalls(logFile);
    expect(calls).toContain("api repos/octo/widgets/pulls/7");
    expect(calls.some((c) => c.includes("pulls/7/reviews?per_page=100"))).toBe(true);
  });

  test("caps review count at 50 newest and flags truncation", async () => {
    const { work } = installGhStub();
    setEnv("GH_STUB_PR_DETAIL_JSON", writeStubJson(work, "detail.json", PR_DETAIL));
    setEnv(
      "GH_STUB_REVIEWS_JSON",
      writeStubJson(
        work,
        "reviews.json",
        Array.from({ length: 60 }, (_, i) => ({
          id: i,
          user: { login: `u${i}` },
          state: "COMMENTED",
          submitted_at: "t",
        })),
      ),
    );
    const out = (await collectPrReviews(tempDir(), { repo: "octo/widgets", number: 7 })) as {
      reviews: Array<{ id: number }>;
      reviews_truncated: boolean;
    };
    expect(out.reviews).toHaveLength(50);
    expect(out.reviews[0]?.id).toBe(10); // newest 50 of 60
    expect(out.reviews_truncated).toBe(true);
  });
});

describe("pr comments", () => {
  test("returns issue comments and line comments bounded separately", async () => {
    const { work, logFile } = installGhStub();
    setEnv("GH_STUB_PR_DETAIL_JSON", writeStubJson(work, "detail.json", PR_DETAIL));
    setEnv(
      "GH_STUB_ISSUE_COMMENTS_JSON",
      writeStubJson(work, "issue.json", [
        {
          id: 11,
          user: { login: "carol" },
          body: "pr conversation",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T01:00:00Z",
          html_url: "https://example.com/c/11",
        },
      ]),
    );
    setEnv(
      "GH_STUB_LINE_COMMENTS_JSON",
      writeStubJson(work, "line.json", [
        {
          id: 22,
          user: { login: "dave" },
          path: "src/a.ts",
          line: 42,
          original_line: 40,
          side: "RIGHT",
          in_reply_to_id: null,
          body: "nit: rename this",
          diff_hunk: "@@ -40,6 +40,7 @@",
          created_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          html_url: "https://example.com/c/22",
        },
      ]),
    );
    const out = (await collectPrComments(tempDir(), { repo: "octo/widgets", number: 7 })) as {
      issue_comments: Array<{ author: string; body: string }>;
      line_comments: Array<{
        path: string;
        line: number;
        in_reply_to_id: unknown;
        diff_hunk: string;
      }>;
      issue_comments_truncated: boolean;
      line_comments_truncated: boolean;
    };
    expect(out.issue_comments[0]).toMatchObject({ author: "carol", body: "pr conversation" });
    expect(out.line_comments[0]).toMatchObject({
      path: "src/a.ts",
      line: 42,
      diff_hunk: "@@ -40,6 +40,7 @@",
    });
    expect(out.issue_comments_truncated).toBe(false);
    expect(out.line_comments_truncated).toBe(false);
    const calls = stubCalls(logFile);
    expect(calls.some((c) => c.includes("issues/7/comments?per_page=100"))).toBe(true);
    expect(calls.some((c) => c.includes("pulls/7/comments?per_page=100"))).toBe(true);
  });
});

describe("pr checks", () => {
  test("maps gh pr checks --json fields to bounded snake_case", async () => {
    const { work, logFile } = installGhStub();
    setEnv("GH_STUB_PR_DETAIL_JSON", writeStubJson(work, "detail.json", PR_DETAIL));
    setEnv(
      "GH_STUB_CHECKS_JSON",
      writeStubJson(work, "checks.json", [
        {
          name: "build",
          bucket: "pass",
          state: "SUCCESS",
          workflow: "CI",
          link: "https://example.com/check/1",
          description: "",
          event: "pull_request",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:05:00Z",
        },
      ]),
    );
    const out = (await collectPrChecks(tempDir(), { repo: "octo/widgets", number: 7 })) as {
      checks: Array<{ name: string; bucket: string; workflow: string; started_at: string }>;
      checks_truncated: boolean;
      head: { sha: string };
    };
    expect(out.checks[0]).toMatchObject({
      name: "build",
      bucket: "pass",
      workflow: "CI",
      started_at: "2026-01-01T00:00:00Z",
    });
    expect(out.checks_truncated).toBe(false);
    expect(out.head.sha).toBe("abc123");
    const call = stubCalls(logFile).find((c) => c.startsWith("pr checks"));
    expect(call).toContain("--repo octo/widgets");
    expect(call).toContain("--json");
  });

  test("'no checks reported' maps to an empty list, not an error", async () => {
    const { work } = installGhStub();
    setEnv("GH_STUB_PR_DETAIL_JSON", writeStubJson(work, "detail.json", PR_DETAIL));
    setEnv("GH_STUB_CHECKS_FAIL", "1");
    const out = (await collectPrChecks(tempDir(), { repo: "octo/widgets", number: 7 })) as {
      checks: unknown[];
    };
    expect(out.checks).toEqual([]);
  });
});

describe("pr logs", () => {
  test("default mode lists workflow runs for the PR head sha", async () => {
    const { work, logFile } = installGhStub();
    setEnv("GH_STUB_PR_DETAIL_JSON", writeStubJson(work, "detail.json", PR_DETAIL));
    setEnv(
      "GH_STUB_RUNS_JSON",
      writeStubJson(work, "runs.json", [
        {
          databaseId: 555,
          name: "CI",
          workflowName: "ci.yml",
          status: "completed",
          conclusion: "success",
          url: "https://example.com/run/555",
          headSha: "abc123",
          createdAt: "2026-01-01T00:00:00Z",
          event: "pull_request",
          displayTitle: "feat: x",
        },
      ]),
    );
    const out = (await collectPrLogs(tempDir(), { repo: "octo/widgets", number: 7 })) as {
      mode: string;
      head_sha: string;
      runs: Array<{ id: number; workflow: string; conclusion: string }>;
    };
    expect(out.mode).toBe("runs");
    expect(out.head_sha).toBe("abc123");
    expect(out.runs[0]).toMatchObject({ id: 555, workflow: "ci.yml", conclusion: "success" });
    const call = stubCalls(logFile).find((c) => c.startsWith("run list"));
    expect(call).toContain("--commit abc123");
    expect(call).toContain("--repo octo/widgets");
  });

  test("--run mode returns the run's bounded job list", async () => {
    const { work } = installGhStub();
    setEnv("GH_STUB_PR_DETAIL_JSON", writeStubJson(work, "detail.json", PR_DETAIL));
    setEnv(
      "GH_STUB_RUN_VIEW_JSON",
      writeStubJson(work, "run.json", {
        databaseId: 555,
        name: "CI",
        workflowName: "ci.yml",
        status: "completed",
        conclusion: "success",
        url: "https://example.com/run/555",
        headSha: "abc123",
        createdAt: "2026-01-01T00:00:00Z",
        jobs: [
          {
            databaseId: 9001,
            name: "build",
            status: "completed",
            conclusion: "success",
            url: "https://example.com/job/9001",
            startedAt: "t0",
            completedAt: "t1",
            steps: [{ name: "s1" }],
          },
        ],
      }),
    );
    const out = (await collectPrLogs(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      runId: "555",
    })) as {
      mode: string;
      run: { id: number; workflow: string };
      jobs: Array<{ id: number; name: string; conclusion: string }>;
      jobs_truncated: boolean;
    };
    expect(out.mode).toBe("run");
    expect(out.run).toMatchObject({ id: 555, workflow: "ci.yml" });
    expect(out.jobs[0]).toMatchObject({ id: 9001, name: "build", conclusion: "success" });
    expect(out.jobs[0]).not.toHaveProperty("steps");
    expect(out.jobs_truncated).toBe(false);
  });

  test("--job mode returns a bounded log tail", async () => {
    const { work, logFile } = installGhStub();
    setEnv("GH_STUB_PR_DETAIL_JSON", writeStubJson(work, "detail.json", PR_DETAIL));
    const logLines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    setEnv("GH_STUB_JOB_LOG", writeStubJson(work, "job.log", `${logLines.join("\n")}\n`));
    const out = (await collectPrLogs(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      jobId: "9001",
      lines: 10,
    })) as {
      mode: string;
      job_id: string;
      log: string;
      truncated: boolean;
      total_lines: number;
    };
    expect(out.mode).toBe("job");
    expect(out.job_id).toBe("9001");
    expect(out.truncated).toBe(true);
    expect(out.total_lines).toBe(301); // trailing newline adds an empty line
    expect(out.log).toContain("line 299");
    expect(out.log).not.toContain("line 289\n");
    const call = stubCalls(logFile).find((c) => c.startsWith("run view"));
    expect(call).toContain("--job 9001");
    expect(call).toContain("--log");
  });
});
