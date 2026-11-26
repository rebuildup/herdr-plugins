import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  boundIssueView,
  collectIssueCreate,
  collectIssueList,
  collectIssueView,
  collectPrChecks,
  collectPrComments,
  collectPrCreate,
  collectPrList,
  collectPrLogs,
  collectPrReviews,
  collectPrStatus,
  collectPrView,
  ensureGh,
  isValidHeadSha,
  mergePr,
  resolveForgeRepo,
  submitIssueComment,
  submitPrComment,
  submitPrReply,
  submitPrReview,
  updateIssue,
  updatePrReviewers,
  versionAtLeast,
} from "../plugins/git/src/gh";
import { installStub } from "./helpers/stub-bin";
import { joinPathEnv } from "./helpers/test-env";

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
  "GH_STUB_REVIEW_POST_JSON",
  "GH_STUB_ISSUE_COMMENT_POST_JSON",
  "GH_STUB_REPLY_POST_JSON",
  "GH_STUB_POST_STDIN_LOG",
  "GH_STUB_MERGE_VIEW_JSON",
  "GH_STUB_MERGE_VIEW_JSON_POST",
  "GH_STUB_MERGE_PUT_JSON",
  "GH_STUB_AUTO_MERGE_POST_JSON",
  "GH_STUB_AUTO_MERGE_DELETE_JSON",
  "GH_STUB_MERGE_API_FAIL",
  "GH_STUB_CREATE_URL",
  "GH_STUB_CREATE_FAIL",
  "GH_STUB_CREATE_PARTIAL",
  "GH_STUB_STDIN_FILE",
  "GH_STUB_ISSUE_LIST_JSON",
  "GH_STUB_ISSUE_VIEW_JSON",
  "GH_STUB_ISSUE_CREATE_URL",
  "GH_STUB_ISSUE_CREATE_FAIL",
  "GH_STUB_ISSUE_EDIT_FAIL",
  "GH_STUB_ISSUE_CLOSE_FAIL",
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
# Capture stdin once so POST payloads (gh api --input -) can be asserted.
# Raw bytes are kept in a temp file so branches (e.g. pr create
# --body-file -) can still consume the verbatim stream afterwards —
# command substitution would strip trailing newlines.
STDIN_RAW="$(mktemp)"
cat > "$STDIN_RAW" 2>/dev/null || true
STDIN_DATA="$(cat "$STDIN_RAW" 2>/dev/null || true)"
case "\${1:-}" in
  --version) echo "gh version \${GH_STUB_VERSION:-2.105.0}"; exit 0;;
  auth)
    if [ "\${GH_STUB_AUTH_FAIL:-0}" = "1" ]; then echo "not logged in" >&2; exit 1; fi
    echo "github.com"; exit 0;;
  repo) echo "\${GH_STUB_REPO:-octo/widgets}"; exit 0;;
  api)
    case "$*" in
      *--method*POST*|*--method*PUT*|*--method*DELETE*|*--input*)
        if [ -n "\${STDIN_DATA:-}" ] && [ -n "\${GH_STUB_POST_STDIN_LOG:-}" ]; then
          printf '%s\\n' "$STDIN_DATA" >> "$GH_STUB_POST_STDIN_LOG"
        fi
        case "$*" in
          *pulls/*/comments/*/replies*) cat "\${GH_STUB_REPLY_POST_JSON:-/dev/null}";;
          *pulls/*/reviews*) cat "\${GH_STUB_REVIEW_POST_JSON:-/dev/null}";;
          *issues/*/comments*) cat "\${GH_STUB_ISSUE_COMMENT_POST_JSON:-/dev/null}";;
          *pulls/*/auto-merge*)
            if [ "\${GH_STUB_MERGE_API_FAIL:-0}" = "1" ]; then
              echo "auto-merge refused (HTTP 422)" >&2; exit 1
            fi
            case "$*" in
              *--method*DELETE*) cat "\${GH_STUB_AUTO_MERGE_DELETE_JSON:-/dev/null}" 2>/dev/null || true;;
              *) cat "\${GH_STUB_AUTO_MERGE_POST_JSON:-/dev/null}";;
            esac;;
          *pulls/*/merge*)
            if [ "\${GH_STUB_MERGE_API_FAIL:-0}" = "1" ]; then
              echo "Merge is not possible (HTTP 405)" >&2; exit 1
            fi
            cat "\${GH_STUB_MERGE_PUT_JSON:-/dev/null}";;
          *) echo "unexpected POST endpoint: $*" >&2; exit 1;;
        esac
        exit 0;;
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
      view)
        # After a merge/auto-merge write lands, GH_STUB_MERGE_VIEW_JSON_POST
        # models the post-write state (merged / auto_merge_request armed).
        if [ -n "\${GH_STUB_MERGE_VIEW_JSON_POST:-}" ] && [ -f "\${GH_STUB_LOG:-/dev/null}" ] && grep -qE -- "--method PUT|auto-merge" "$GH_STUB_LOG" 2>/dev/null; then
          cat "$GH_STUB_MERGE_VIEW_JSON_POST"
        elif [ -n "\${GH_STUB_MERGE_VIEW_JSON:-}" ]; then cat "$GH_STUB_MERGE_VIEW_JSON";
        else cat "\${GH_STUB_VIEW_JSON:-/dev/null}"; fi;;
      checks)
        if [ "\${GH_STUB_CHECKS_FAIL:-0}" = "1" ]; then
          echo "no checks reported on the 'feature' branch" >&2; exit 1
        fi
        cat "\${GH_STUB_CHECKS_JSON:-/dev/null}";;
      create)
        if [ -n "\${GH_STUB_STDIN_FILE:-}" ]; then cat "$STDIN_RAW" > "$GH_STUB_STDIN_FILE"; fi
        if [ "\${GH_STUB_CREATE_FAIL:-0}" = "1" ]; then
          echo "gh pr create failed" >&2
          # Partial success: a URL on stdout does not make the call succeed.
          if [ "\${GH_STUB_CREATE_PARTIAL:-0}" = "1" ]; then
            echo "\${GH_STUB_CREATE_URL:-https://github.com/octo/widgets/pull/42}"
          fi
          exit 1
        fi
        echo "\${GH_STUB_CREATE_URL:-https://github.com/octo/widgets/pull/42}"
        ;;
      edit) echo "https://github.com/octo/widgets/pull/7";;
      *) exit 1;;
    esac
    exit 0;;
  issue)
    case "\${2:-}" in
      list) cat "\${GH_STUB_ISSUE_LIST_JSON:-/dev/null}" 2>/dev/null || echo '[]';;
      view) cat "\${GH_STUB_ISSUE_VIEW_JSON:-/dev/null}";;
      create)
        if [ "\${GH_STUB_ISSUE_CREATE_FAIL:-0}" = "1" ]; then
          echo "gh issue create failed" >&2; exit 1
        fi
        if [ -n "\${GH_STUB_STDIN_FILE:-}" ]; then cat "$STDIN_RAW" > "$GH_STUB_STDIN_FILE"; fi
        echo "\${GH_STUB_ISSUE_CREATE_URL:-https://github.com/octo/widgets/issues/9}"
        ;;
      edit)
        if [ -n "\${GH_STUB_STDIN_FILE:-}" ]; then cat "$STDIN_RAW" > "$GH_STUB_STDIN_FILE"; fi
        if [ "\${GH_STUB_ISSUE_EDIT_FAIL:-0}" = "1" ]; then
          echo "gh issue edit failed" >&2; exit 1
        fi
        echo "edited";;
      close)
        if [ "\${GH_STUB_ISSUE_CLOSE_FAIL:-0}" = "1" ]; then
          echo "gh issue close failed" >&2; exit 1
        fi
        echo "closed";;
      reopen) echo "reopened";;
      comment) echo "https://github.com/octo/widgets/issues/3#issuecomment-1";;
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

/**
 * TypeScript twin of {@link STUB} for Windows (issue #225). On win32 the
 * extensionless shell script can never be exec'd by argv-only spawn, so
 * `installStub` compiles this source to `gh.exe` via `bun build --compile`.
 *
 * Written without template literals, backslashes, or `${` so it can live
 * inside the outer template literal verbatim; `NL` stands in for "\n".
 * Semantics mirror the bash stub branch-for-branch.
 */
const GH_STUB_TS = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const NL = String.fromCharCode(10);
const env = (n: string): string => process.env[n] ?? "";
const envOr = (n: string, d: string): string => {
  const v = process.env[n];
  return v === undefined || v === "" ? d : v;
};
const line = (s: string): void => {
  process.stdout.write(s + NL);
};
const err = (s: string): void => {
  process.stderr.write(s + NL);
};
const catPath = (p: string): void => {
  try {
    process.stdout.write(readFileSync(p, "utf8"));
  } catch {
    err("cat: " + p + ": No such file or directory");
  }
};
const catEnv = (n: string): void => {
  const f = process.env[n];
  if (f === undefined || f === "") return;
  catPath(f);
};
const catEnvOr = (n: string, fallback: string): void => {
  const f = process.env[n];
  if (f === undefined || f === "") return;
  try {
    process.stdout.write(readFileSync(f, "utf8"));
  } catch {
    line(fallback);
  }
};
const catEnvQuiet = (n: string): void => {
  const f = process.env[n];
  if (f === undefined || f === "") return;
  try {
    process.stdout.write(readFileSync(f, "utf8"));
  } catch {
    /* cat ... 2>/dev/null || true */
  }
};

const args = process.argv.slice(2);
const joined = args.join(" ");
const logFile = process.env.GH_STUB_LOG;
if (logFile !== undefined && logFile !== "") {
  try {
    appendFileSync(logFile, joined + NL);
  } catch {
    /* log write must never fail the stub */
  }
}
const stdinRaw = await Bun.stdin.text();
const stdinData = stdinRaw.replace(new RegExp(NL + "+$"), "");
const cmd = args[0] ?? "";
const sub = args[1] ?? "";
const has = (re: string): boolean => new RegExp(re).test(joined);
let code = 0;
const writeStdinFile = (): void => {
  const f = process.env.GH_STUB_STDIN_FILE;
  if (f !== undefined && f !== "") writeFileSync(f, stdinRaw);
};

if (cmd === "--version") {
  line("gh version " + envOr("GH_STUB_VERSION", "2.105.0"));
} else if (cmd === "auth") {
  if (env("GH_STUB_AUTH_FAIL") === "1") {
    err("not logged in");
    code = 1;
  } else {
    line("github.com");
  }
} else if (cmd === "repo") {
  line(envOr("GH_STUB_REPO", "octo/widgets"));
} else if (cmd === "api") {
  const mutation =
    has("--method[^]*POST") ||
    has("--method[^]*PUT") ||
    has("--method[^]*DELETE") ||
    joined.includes("--input");
  if (mutation) {
    const postLog = process.env.GH_STUB_POST_STDIN_LOG;
    if (stdinData !== "" && postLog !== undefined && postLog !== "") {
      try {
        appendFileSync(postLog, stdinData + NL);
      } catch {
        /* ignore */
      }
    }
    if (has("pulls/[^]*/comments/[^]*/replies")) catEnv("GH_STUB_REPLY_POST_JSON");
    else if (has("pulls/[^]*/reviews")) catEnv("GH_STUB_REVIEW_POST_JSON");
    else if (has("issues/[^]*/comments")) catEnv("GH_STUB_ISSUE_COMMENT_POST_JSON");
    else if (has("pulls/[^]*/auto-merge")) {
      if (env("GH_STUB_MERGE_API_FAIL") === "1") {
        err("auto-merge refused (HTTP 422)");
        code = 1;
      } else if (has("--method[^]*DELETE")) catEnvQuiet("GH_STUB_AUTO_MERGE_DELETE_JSON");
      else catEnv("GH_STUB_AUTO_MERGE_POST_JSON");
    } else if (has("pulls/[^]*/merge")) {
      if (env("GH_STUB_MERGE_API_FAIL") === "1") {
        err("Merge is not possible (HTTP 405)");
        code = 1;
      } else catEnv("GH_STUB_MERGE_PUT_JSON");
    } else {
      err("unexpected POST endpoint: " + joined);
      code = 1;
    }
  } else if (has("pulls/[^]*/reviews")) catEnv("GH_STUB_REVIEWS_JSON");
  else if (has("issues/[^]*/comments")) catEnv("GH_STUB_ISSUE_COMMENTS_JSON");
  else if (has("pulls/[^]*/comments")) catEnv("GH_STUB_LINE_COMMENTS_JSON");
  else if (has("pulls/")) catEnv("GH_STUB_PR_DETAIL_JSON");
  else code = 1;
} else if (cmd === "pr") {
  if (sub === "list") catEnvOr("GH_STUB_LIST_JSON", "[]");
  else if (sub === "view") {
    const post = process.env.GH_STUB_MERGE_VIEW_JSON_POST;
    let done = false;
    if (
      post !== undefined &&
      post !== "" &&
      logFile !== undefined &&
      logFile !== "" &&
      existsSync(logFile)
    ) {
      try {
        if (new RegExp("--method PUT|auto-merge").test(readFileSync(logFile, "utf8"))) {
          catPath(post);
          done = true;
        }
      } catch {
        /* grep failure falls through to the static fixtures */
      }
    }
    if (!done) {
      const mv = process.env.GH_STUB_MERGE_VIEW_JSON;
      if (mv !== undefined && mv !== "") catPath(mv);
      else catEnv("GH_STUB_VIEW_JSON");
    }
  } else if (sub === "checks") {
    if (env("GH_STUB_CHECKS_FAIL") === "1") {
      err("no checks reported on the 'feature' branch");
      code = 1;
    } else catEnv("GH_STUB_CHECKS_JSON");
  } else if (sub === "create") {
    writeStdinFile();
    if (env("GH_STUB_CREATE_FAIL") === "1") {
      err("gh pr create failed");
      if (env("GH_STUB_CREATE_PARTIAL") === "1") {
        line(envOr("GH_STUB_CREATE_URL", "https://github.com/octo/widgets/pull/42"));
      }
      code = 1;
    } else {
      line(envOr("GH_STUB_CREATE_URL", "https://github.com/octo/widgets/pull/42"));
    }
  } else if (sub === "edit") {
    line("https://github.com/octo/widgets/pull/7");
  } else code = 1;
} else if (cmd === "issue") {
  if (sub === "list") catEnvOr("GH_STUB_ISSUE_LIST_JSON", "[]");
  else if (sub === "view") catEnv("GH_STUB_ISSUE_VIEW_JSON");
  else if (sub === "create") {
    if (env("GH_STUB_ISSUE_CREATE_FAIL") === "1") {
      err("gh issue create failed");
      code = 1;
    } else {
      writeStdinFile();
      line(envOr("GH_STUB_ISSUE_CREATE_URL", "https://github.com/octo/widgets/issues/9"));
    }
  } else if (sub === "edit") {
    writeStdinFile();
    if (env("GH_STUB_ISSUE_EDIT_FAIL") === "1") {
      err("gh issue edit failed");
      code = 1;
    } else line("edited");
  } else if (sub === "close") {
    if (env("GH_STUB_ISSUE_CLOSE_FAIL") === "1") {
      err("gh issue close failed");
      code = 1;
    } else line("closed");
  } else if (sub === "reopen") line("reopened");
  else if (sub === "comment") line("https://github.com/octo/widgets/issues/3#issuecomment-1");
  else code = 1;
} else if (cmd === "run") {
  if (sub === "list") catEnv("GH_STUB_RUNS_JSON");
  else if (sub === "view") {
    if (joined.includes("--log")) catEnv("GH_STUB_JOB_LOG");
    else catEnv("GH_STUB_RUN_VIEW_JSON");
  } else code = 1;
} else code = 1;

process.exitCode = code;
`;

function installGhStub(): { binDir: string; logFile: string; work: string } {
  const binDir = tempDir();
  const work = tempDir();
  const logFile = path.join(work, "gh.log");
  installStub(binDir, { name: "gh", posix: STUB, windows: GH_STUB_TS });
  setEnv("PATH", joinPathEnv(binDir));
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

  test("assembles repo/title/head/base/draft argv", async () => {
    const { logFile } = installGhStub();
    await collectPrCreate(tempDir(), {
      repo: "octo/widgets",
      title: "add thing",
      head: "feature/x",
      base: "release",
      draft: true,
    });
    const call = stubCalls(logFile).find((c) => c.startsWith("pr create"));
    expect(call).toContain("--repo octo/widgets");
    expect(call).toContain("--title add thing");
    expect(call).toContain("--head feature/x");
    expect(call).toContain("--base release");
    expect(call).toContain("--draft");
    // No body flag given: gh must not be left to prompt interactively.
    expect(call).toContain("--body ");
  });

  test("bodyFile path travels via --body-file argv, not stdin", async () => {
    const { logFile } = installGhStub();
    const bodyPath = path.join(tempDir(), "body.md");
    writeFileSync(bodyPath, "file body\n");
    await collectPrCreate(tempDir(), {
      repo: "octo/widgets",
      title: "t",
      bodyFile: bodyPath,
    });
    const call = stubCalls(logFile).find((c) => c.startsWith("pr create"));
    expect(call).toContain(`--body-file ${bodyPath}`);
  });

  test("stdin body reaches gh verbatim via --body-file -", async () => {
    const { work } = installGhStub();
    const stdinFile = path.join(work, "stdin.txt");
    setEnv("GH_STUB_STDIN_FILE", stdinFile);
    const bodyText = "line one\nline two\n";
    await collectPrCreate(
      tempDir(),
      { repo: "octo/widgets", title: "t", bodyFile: "-" },
      { bodyText },
    );
    expect(readFileSync(stdinFile, "utf8")).toBe(bodyText);
  });

  test("parses the PR number from a custom success URL", async () => {
    installGhStub();
    setEnv("GH_STUB_CREATE_URL", "https://github.com/octo/widgets/pull/7");
    const result = await collectPrCreate(tempDir(), {
      repo: "octo/widgets",
      title: "t",
    });
    expect(result).toEqual({
      url: "https://github.com/octo/widgets/pull/7",
      number: 7,
    });
  });

  test("non-PR success output yields number null", async () => {
    installGhStub();
    setEnv("GH_STUB_CREATE_URL", "https://github.com/octo/widgets/pull/");
    const result = await collectPrCreate(tempDir(), {
      repo: "octo/widgets",
      title: "t",
    });
    expect(result.number).toBeNull();
  });

  test("gh failure is a structured gh_error, not a fabricated success", async () => {
    installGhStub();
    setEnv("GH_STUB_CREATE_FAIL", "1");
    await expect(
      collectPrCreate(tempDir(), { repo: "octo/widgets", title: "t" }),
    ).rejects.toMatchObject({ kind: "gh_error" });
  });

  test("partial success (URL on stdout, non-zero exit) is still an error", async () => {
    installGhStub();
    setEnv("GH_STUB_CREATE_FAIL", "1");
    setEnv("GH_STUB_CREATE_PARTIAL", "1");
    await expect(
      collectPrCreate(tempDir(), { repo: "octo/widgets", title: "t" }),
    ).rejects.toMatchObject({ kind: "gh_error" });
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

// ---------------------------------------------------------------------------
// PR review/comment mutations (Issue #172)
// ---------------------------------------------------------------------------

const HEAD_SHA = "a".repeat(40);
const STALE_SHA = "b".repeat(40);

function stubMutationFixtures(work: string): void {
  setEnv("GH_STUB_PR_DETAIL_JSON", writeStubJson(work, "detail.json", PR_DETAIL));
}

function postStdin(work: string): string {
  const file = path.join(work, "post-stdin.log");
  setEnv("GH_STUB_POST_STDIN_LOG", file);
  return file;
}

describe("isValidHeadSha", () => {
  test("accepts full sha1/sha256 hex, rejects short or non-hex", () => {
    expect(isValidHeadSha("a".repeat(40))).toBe(true);
    expect(isValidHeadSha("A".repeat(40))).toBe(true);
    expect(isValidHeadSha("a".repeat(64))).toBe(true);
    expect(isValidHeadSha("abc123")).toBe(false);
    expect(isValidHeadSha("g".repeat(40))).toBe(false);
    expect(isValidHeadSha("")).toBe(false);
  });
});

describe("pr review mutation", () => {
  test("approve POSTs to pulls/{n}/reviews with commit_id pinned to head", async () => {
    const { work, logFile } = installGhStub();
    stubMutationFixtures(work);
    const stdinLog = postStdin(work);
    setEnv(
      "GH_STUB_REVIEW_POST_JSON",
      writeStubJson(work, "review.json", {
        id: 900,
        user: { login: "me" },
        state: "APPROVED",
        body: "",
        commit_id: "abc123",
        submitted_at: "2026-02-01T00:00:00Z",
        html_url: "https://example.com/review/900",
      }),
    );
    const out = (await submitPrReview(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      expectHead: "abc123",
      event: "APPROVE",
    })) as {
      head: { sha: string };
      review: { id: number; state: string; commit_id: string; url: string };
    };
    expect(out.review).toMatchObject({
      id: 900,
      state: "APPROVED",
      commit_id: "abc123",
      url: "https://example.com/review/900",
    });
    expect(out.head.sha).toBe("abc123");
    const call = stubCalls(logFile).find((c) => c.includes("--method POST"));
    expect(call).toContain("api repos/octo/widgets/pulls/7/reviews");
    expect(call).toContain("--input -");
    const payload = readFileSync(stdinLog, "utf8");
    expect(payload).toContain('"commit_id":"abc123"');
    expect(payload).toContain('"event":"APPROVE"');
    // Review body never appears in argv.
    expect(call).not.toContain("looks good");
  });

  test("request-changes with line comments sends comments[] via stdin payload", async () => {
    const { work, logFile } = installGhStub();
    stubMutationFixtures(work);
    const stdinLog = postStdin(work);
    setEnv(
      "GH_STUB_REVIEW_POST_JSON",
      writeStubJson(work, "review.json", {
        id: 901,
        user: { login: "me" },
        state: "CHANGES_REQUESTED",
        commit_id: "abc123",
        html_url: "https://example.com/review/901",
      }),
    );
    const out = (await submitPrReview(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      expectHead: "abc123",
      event: "REQUEST_CHANGES",
      body: "please fix",
      comments: [
        { path: "src/a.ts", line: 42, side: "RIGHT", body: "nit: rename" },
        { path: "src/b.ts", line: 7, body: "second" },
      ],
    })) as { review: { state: string } };
    expect(out.review.state).toBe("CHANGES_REQUESTED");
    const payload = JSON.parse(readFileSync(stdinLog, "utf8").trim()) as {
      event: string;
      body: string;
      comments: Array<{ path: string; line: number; side?: string; body: string }>;
    };
    expect(payload.event).toBe("REQUEST_CHANGES");
    expect(payload.body).toBe("please fix");
    expect(payload.comments).toHaveLength(2);
    expect(payload.comments[0]).toEqual({
      path: "src/a.ts",
      line: 42,
      side: "RIGHT",
      body: "nit: rename",
    });
    expect(payload.comments[1]).not.toHaveProperty("side");
    const call = stubCalls(logFile).find((c) => c.includes("--method POST"));
    expect(call).not.toContain("nit: rename");
    expect(call).not.toContain("please fix");
  });

  test("stale head refuses before any POST", async () => {
    const { work, logFile } = installGhStub();
    stubMutationFixtures(work); // head sha is abc123
    await expect(
      submitPrReview(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        event: "APPROVE",
      }),
    ).rejects.toMatchObject({ kind: "stale_head" });
    const calls = stubCalls(logFile);
    expect(calls.some((c) => c.includes("--method POST"))).toBe(false);
    // The guard still fetched the PR once.
    expect(calls.some((c) => c.includes("api repos/octo/widgets/pulls/7"))).toBe(true);
  });

  test("missing head sha is a structured gh_error, not a proceed", async () => {
    const { work } = installGhStub();
    setEnv(
      "GH_STUB_PR_DETAIL_JSON",
      writeStubJson(work, "detail.json", { number: 7, head: { ref: "x", sha: null } }),
    );
    await expect(
      submitPrReview(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: HEAD_SHA,
        event: "COMMENT",
        body: "hi",
      }),
    ).rejects.toMatchObject({ kind: "gh_error" });
  });

  test("invalid line comment entries are rejected before POST", async () => {
    const { work, logFile } = installGhStub();
    stubMutationFixtures(work);
    await expect(
      submitPrReview(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: "abc123",
        event: "COMMENT",
        comments: [{ path: "", line: 0, body: "" }],
      }),
    ).rejects.toMatchObject({ kind: "gh_error" });
    expect(stubCalls(logFile).some((c) => c.includes("--method POST"))).toBe(false);
  });

  test("gh POST failure maps to gh_error", async () => {
    const { work } = installGhStub();
    stubMutationFixtures(work);
    // No GH_STUB_REVIEW_POST_JSON -> stub cats /dev/null -> empty stdout ->
    // JSON.parse fails inside ghApiPost... use a failing endpoint instead:
    setEnv("GH_STUB_REVIEW_POST_JSON", "not-json{");
    await expect(
      submitPrReview(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: "abc123",
        event: "APPROVE",
      }),
    ).rejects.toThrow();
  });
});

describe("pr comment mutation", () => {
  test("posts to issues/{n}/comments and echoes the comment", async () => {
    const { work, logFile } = installGhStub();
    stubMutationFixtures(work);
    const stdinLog = postStdin(work);
    setEnv(
      "GH_STUB_ISSUE_COMMENT_POST_JSON",
      writeStubJson(work, "comment.json", {
        id: 55,
        user: { login: "me" },
        body: "hello pr",
        created_at: "2026-02-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
        html_url: "https://example.com/comment/55",
      }),
    );
    const out = (await submitPrComment(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      expectHead: "abc123",
      body: "hello pr",
    })) as {
      comment: { id: number; body: string; url: string };
      head: { sha: string };
    };
    expect(out.comment).toMatchObject({ id: 55, body: "hello pr" });
    const call = stubCalls(logFile).find((c) => c.includes("--method POST"));
    expect(call).toContain("api repos/octo/widgets/issues/7/comments");
    const payload = JSON.parse(readFileSync(stdinLog, "utf8").trim()) as { body: string };
    expect(payload.body).toBe("hello pr");
    expect(call).not.toContain("hello pr");
  });

  test("stale head refuses before posting", async () => {
    const { work, logFile } = installGhStub();
    stubMutationFixtures(work);
    await expect(
      submitPrComment(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: STALE_SHA,
        body: "hi",
      }),
    ).rejects.toMatchObject({ kind: "stale_head" });
    expect(stubCalls(logFile).some((c) => c.includes("--method POST"))).toBe(false);
  });
});

describe("pr reply mutation", () => {
  test("posts to pulls/{n}/comments/{id}/replies", async () => {
    const { work, logFile } = installGhStub();
    stubMutationFixtures(work);
    setEnv(
      "GH_STUB_REPLY_POST_JSON",
      writeStubJson(work, "reply.json", {
        id: 77,
        user: { login: "me" },
        body: "done",
        in_reply_to_id: 22,
        html_url: "https://example.com/reply/77",
      }),
    );
    const out = (await submitPrReply(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      expectHead: "abc123",
      commentId: 22,
      body: "done",
    })) as { comment_id: number; comment: { id: number; body: string } };
    expect(out.comment_id).toBe(22);
    expect(out.comment).toMatchObject({ id: 77, body: "done" });
    const call = stubCalls(logFile).find((c) => c.includes("--method POST"));
    expect(call).toContain("api repos/octo/widgets/pulls/7/comments/22/replies");
  });

  test("stale head refuses before posting", async () => {
    const { work, logFile } = installGhStub();
    stubMutationFixtures(work);
    await expect(
      submitPrReply(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: STALE_SHA,
        commentId: 22,
        body: "done",
      }),
    ).rejects.toMatchObject({ kind: "stale_head" });
    expect(stubCalls(logFile).some((c) => c.includes("--method POST"))).toBe(false);
  });
});

describe("pr reviewers mutation", () => {
  test("gh pr edit --add-reviewer/--remove-reviewer then echoes review_requests", async () => {
    const { work, logFile } = installGhStub();
    stubMutationFixtures(work);
    const out = (await updatePrReviewers(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      expectHead: "abc123",
      add: ["alice", "bob"],
      remove: ["carol"],
    })) as {
      review_requests: { users: unknown[]; teams: unknown[] };
      head: { sha: string };
    };
    expect(out.review_requests.users).toEqual(["rev1", "rev2"]);
    expect(out.review_requests.teams).toEqual(["team-a"]);
    expect(out.head.sha).toBe("abc123");
    const call = stubCalls(logFile).find((c) => c.startsWith("pr edit"));
    expect(call).toContain("pr edit 7");
    expect(call).toContain("--repo octo/widgets");
    expect(call).toContain("--add-reviewer alice,bob");
    expect(call).toContain("--remove-reviewer carol");
  });

  test("stale head refuses before gh pr edit", async () => {
    const { work, logFile } = installGhStub();
    stubMutationFixtures(work);
    await expect(
      updatePrReviewers(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: STALE_SHA,
        add: ["alice"],
      }),
    ).rejects.toMatchObject({ kind: "stale_head" });
    expect(stubCalls(logFile).some((c) => c.startsWith("pr edit"))).toBe(false);
  });

  test("invalid reviewer login and empty request are rejected", async () => {
    const { work, logFile } = installGhStub();
    stubMutationFixtures(work);
    await expect(
      updatePrReviewers(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: "abc123",
        add: ["bad login!"],
      }),
    ).rejects.toMatchObject({ kind: "gh_error" });
    await expect(
      updatePrReviewers(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: "abc123",
      }),
    ).rejects.toMatchObject({ kind: "gh_error" });
    expect(stubCalls(logFile).some((c) => c.startsWith("pr edit"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue surface (Issue #174): list/view reads plus create/edit/comment/close
// mutations. Issues have no head sha — there is deliberately no
// --expect-head analog; mutation safety is the CLI-side target gate.
// ---------------------------------------------------------------------------

const ISSUE_VIEW_RAW = {
  number: 5,
  title: "bug: widget crashes",
  state: "OPEN",
  stateReason: "",
  closed: false,
  author: { login: "alice" },
  labels: [{ name: "bug" }, { name: "triage" }],
  assignees: [{ login: "bob" }],
  milestone: { title: "v1" },
  body: "x".repeat(9000),
  comments: Array.from({ length: 60 }, (_, i) => ({
    id: i,
    author: { login: `u${i}` },
    body: i === 59 ? "y".repeat(5000) : `comment ${i}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: `https://example.com/c/${i}`,
  })),
  reactionGroups: [{ content: "THUMBS_UP", users: { totalCount: 3 } }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  url: "https://github.com/octo/widgets/issues/5",
};

describe("boundIssueView", () => {
  test("bounds body, caps comments at newest 50, projects reactions", () => {
    const out = boundIssueView(ISSUE_VIEW_RAW) as {
      body: string;
      body_truncated?: boolean;
      comments: Array<{ id: number; body_truncated?: boolean }>;
      comments_truncated: boolean;
      reactions: Array<{ content: string; count: number }>;
      labels: string[];
      assignees: string[];
      milestone: string | null;
      state_reason: string;
    };
    expect(out.body_truncated).toBe(true);
    expect(out.body.length).toBeLessThan(8100);
    expect(out.comments).toHaveLength(50);
    expect(out.comments[0]?.id).toBe(10); // newest 50 of 60
    expect(out.comments[49]?.body_truncated).toBe(true);
    expect(out.comments_truncated).toBe(true);
    expect(out.reactions).toEqual([{ content: "THUMBS_UP", count: 3 }]);
    expect(out.labels).toEqual(["bug", "triage"]);
    expect(out.assignees).toEqual(["bob"]);
    expect(out.milestone).toBe("v1");
    expect(out.state_reason).toBe("");
  });
});

describe("issue list", () => {
  test("assembles argv and parses JSON output", async () => {
    const { logFile, work } = installGhStub();
    const listFile = writeStubJson(work, "issues.json", [
      { number: 5, title: "t", state: "OPEN", url: "u" },
    ]);
    setEnv("GH_STUB_ISSUE_LIST_JSON", listFile);
    const issues = await collectIssueList(tempDir(), {
      repo: "octo/widgets",
      limit: 7,
      state: "all",
      label: ["bug"],
      assignee: ["bob"],
      author: "alice",
    });
    expect(issues).toHaveLength(1);
    const call = stubCalls(logFile).find((c) => c.startsWith("issue list"));
    expect(call).toContain("--repo octo/widgets");
    expect(call).toContain("--limit 7");
    expect(call).toContain("--state all");
    expect(call).toContain("--label bug");
    expect(call).toContain("--assignee bob");
    expect(call).toContain("--author alice");
    expect(call).toContain("--json");
  });
});

describe("issue view", () => {
  test("returns the bounded projection", async () => {
    const { work } = installGhStub();
    setEnv("GH_STUB_ISSUE_VIEW_JSON", writeStubJson(work, "iview.json", ISSUE_VIEW_RAW));
    const issue = (await collectIssueView(tempDir(), { repo: "octo/widgets", number: 5 })) as {
      number: number;
      comments_truncated: boolean;
      body_truncated?: boolean;
    };
    expect(issue.number).toBe(5);
    expect(issue.comments_truncated).toBe(true);
    expect(issue.body_truncated).toBe(true);
  });
});

describe("issue create", () => {
  test("labels/assignees travel as argv; URL yields the issue number", async () => {
    const { logFile } = installGhStub();
    const result = await collectIssueCreate(tempDir(), {
      repo: "octo/widgets",
      title: "new bug",
      body: "details",
      labels: ["bug", "triage"],
      assignees: ["bob"],
    });
    expect(result).toEqual({
      url: "https://github.com/octo/widgets/issues/9",
      number: 9,
    });
    const call = stubCalls(logFile).find((c) => c.startsWith("issue create"));
    expect(call).toContain("--repo octo/widgets");
    expect(call).toContain("--title new bug");
    expect(call).toContain("--label bug");
    expect(call).toContain("--label triage");
    expect(call).toContain("--assignee bob");
  });

  test("long body travels via --body-file - stdin, never argv", async () => {
    const { logFile, work } = installGhStub();
    const stdinFile = path.join(work, "stdin.txt");
    setEnv("GH_STUB_STDIN_FILE", stdinFile);
    const bodyText = "issue body line\n".repeat(2000);
    await collectIssueCreate(
      tempDir(),
      { repo: "octo/widgets", title: "t", bodyFile: "-" },
      { bodyText },
    );
    const call = stubCalls(logFile).find((c) => c.startsWith("issue create"));
    expect(call).toContain("--body-file -");
    expect(call).not.toContain("issue body line");
    expect(readFileSync(stdinFile, "utf8")).toBe(bodyText);
  });

  test("gh failure is a structured gh_error", async () => {
    installGhStub();
    setEnv("GH_STUB_ISSUE_CREATE_FAIL", "1");
    await expect(
      collectIssueCreate(tempDir(), { repo: "octo/widgets", title: "t" }),
    ).rejects.toMatchObject({ kind: "gh_error" });
  });
});

describe("issue comment mutation", () => {
  test("posts to issues/{n}/comments via gh api stdin payload", async () => {
    const { work, logFile } = installGhStub();
    setEnv(
      "GH_STUB_ISSUE_COMMENT_POST_JSON",
      writeStubJson(work, "posted.json", {
        id: 77,
        user: { login: "alice" },
        body: "hello",
        created_at: "2026-01-03T00:00:00Z",
        updated_at: "2026-01-03T00:00:00Z",
        html_url: "https://example.com/c/77",
      }),
    );
    const out = (await submitIssueComment(tempDir(), {
      repo: "octo/widgets",
      number: 5,
      body: "hello",
    })) as { number: number; comment: { id: number; author: string } };
    expect(out.number).toBe(5);
    expect(out.comment).toMatchObject({ id: 77, author: "alice" });
    const calls = stubCalls(logFile);
    expect(calls.some((c) => c.includes("api repos/octo/widgets/issues/5/comments"))).toBe(true);
  });
});

describe("issue edit / close", () => {
  test("edit assembles gh issue edit argv then echoes the post-state view", async () => {
    const { work, logFile } = installGhStub();
    setEnv("GH_STUB_ISSUE_VIEW_JSON", writeStubJson(work, "iview.json", ISSUE_VIEW_RAW));
    const out = (await updateIssue(tempDir(), {
      repo: "octo/widgets",
      number: 5,
      title: "renamed",
      addLabels: ["urgent"],
      removeLabels: ["triage"],
      addAssignees: ["carol"],
      state: "closed",
      reason: "completed",
    })) as { number: number; issue: { number: number; state: string } };
    expect(out.number).toBe(5);
    expect(out.issue.number).toBe(5);
    const calls = stubCalls(logFile);
    const edit = calls.find((c) => c.startsWith("issue edit"));
    expect(edit).toContain("--title renamed");
    expect(edit).toContain("--add-label urgent");
    expect(edit).toContain("--remove-label triage");
    expect(edit).toContain("--add-assignee carol");
    const close = calls.find((c) => c.startsWith("issue close"));
    expect(close).toContain("--reason completed");
    expect(calls.some((c) => c.startsWith("issue view 5"))).toBe(true);
  });

  test("state-only edit reopens without gh issue edit", async () => {
    const { work, logFile } = installGhStub();
    setEnv("GH_STUB_ISSUE_VIEW_JSON", writeStubJson(work, "iview.json", ISSUE_VIEW_RAW));
    await updateIssue(tempDir(), { repo: "octo/widgets", number: 5, state: "open" });
    const calls = stubCalls(logFile);
    expect(calls.some((c) => c.startsWith("issue edit"))).toBe(false);
    expect(calls.some((c) => c.startsWith("issue reopen 5"))).toBe(true);
  });

  test("edit body travels via --body-file - stdin", async () => {
    const { work, logFile } = installGhStub();
    setEnv("GH_STUB_ISSUE_VIEW_JSON", writeStubJson(work, "iview.json", ISSUE_VIEW_RAW));
    const stdinFile = path.join(work, "stdin.txt");
    setEnv("GH_STUB_STDIN_FILE", stdinFile);
    const bodyText = "new body\n";
    await updateIssue(tempDir(), { repo: "octo/widgets", number: 5, bodyFile: "-" }, { bodyText });
    const edit = stubCalls(logFile).find((c) => c.startsWith("issue edit"));
    expect(edit).toContain("--body-file -");
    expect(readFileSync(stdinFile, "utf8")).toBe(bodyText);
  });

  test("gh edit failure is a structured gh_error; no view refetch", async () => {
    const { work, logFile } = installGhStub();
    setEnv("GH_STUB_ISSUE_VIEW_JSON", writeStubJson(work, "iview.json", ISSUE_VIEW_RAW));
    setEnv("GH_STUB_ISSUE_EDIT_FAIL", "1");
    await expect(
      updateIssue(tempDir(), { repo: "octo/widgets", number: 5, title: "x" }),
    ).rejects.toMatchObject({ kind: "gh_error" });
    expect(stubCalls(logFile).some((c) => c.startsWith("issue view"))).toBe(false);
  });

  test("invalid reason/state combos are rejected before any gh call", async () => {
    const { logFile } = installGhStub();
    await expect(
      updateIssue(tempDir(), {
        repo: "octo/widgets",
        number: 5,
        state: "closed",
        reason: "bogus",
      }),
    ).rejects.toMatchObject({ kind: "gh_error" });
    await expect(
      updateIssue(tempDir(), {
        repo: "octo/widgets",
        number: 5,
        state: "open",
        reason: "completed",
      }),
    ).rejects.toMatchObject({ kind: "gh_error" });
    expect(stubCalls(logFile).filter((c) => c.startsWith("issue"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PR merge / auto-merge (Issue #173)
// ---------------------------------------------------------------------------

const MERGE_HEAD_SHA = "c".repeat(40);

function mergeViewFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefOid: MERGE_HEAD_SHA,
    headRefName: "feature/x",
    baseRefName: "main",
    url: "https://example.com/pr/7",
    autoMergeRequest: null,
    ...overrides,
  };
}

function stubMergeFixtures(work: string, viewOverrides: Record<string, unknown> = {}): void {
  setEnv("GH_STUB_PR_DETAIL_JSON", writeStubJson(work, "detail.json", PR_DETAIL));
  setEnv(
    "GH_STUB_MERGE_VIEW_JSON",
    writeStubJson(work, "merge-view.json", mergeViewFixture(viewOverrides)),
  );
}

describe("pr merge", () => {
  test("immediate merge PUTs pulls/{n}/merge with sha pinned to verified head", async () => {
    const { work, logFile } = installGhStub();
    stubMergeFixtures(work);
    const stdinLog = postStdin(work);
    setEnv(
      "GH_STUB_MERGE_PUT_JSON",
      writeStubJson(work, "merge.json", { merged: true, sha: "f".repeat(40), message: "Merged" }),
    );
    setEnv(
      "GH_STUB_MERGE_VIEW_JSON_POST",
      writeStubJson(work, "merge-view-post.json", mergeViewFixture({ state: "MERGED" })),
    );
    const out = (await mergePr(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      expectHead: MERGE_HEAD_SHA,
      method: "squash",
    })) as {
      result: string;
      state: string;
      method: string;
      pre_merge_state: { merge_state_status: string; review_decision: string; mergeable: string };
      merge: { merged: boolean; sha: string };
      head: { sha: string };
    };
    expect(out.result).toBe("merged");
    expect(out.state).toBe("MERGED");
    expect(out.method).toBe("squash");
    expect(out.pre_merge_state).toEqual({
      merge_state_status: "CLEAN",
      review_decision: "APPROVED",
      mergeable: "MERGEABLE",
    });
    expect(out.merge).toMatchObject({ merged: true });
    expect(out.head.sha).toBe("abc123");
    const call = stubCalls(logFile).find((c) => c.includes("--method PUT"));
    expect(call).toContain("api repos/octo/widgets/pulls/7/merge");
    expect(call).toContain("--input -");
    const payload = JSON.parse(readFileSync(stdinLog, "utf8").trim()) as {
      sha: string;
      merge_method: string;
    };
    expect(payload.sha).toBe(MERGE_HEAD_SHA);
    expect(payload.merge_method).toBe("squash");
  });

  test("merged:false from GitHub reports result pending, never merged", async () => {
    const { work } = installGhStub();
    stubMergeFixtures(work);
    setEnv(
      "GH_STUB_MERGE_PUT_JSON",
      writeStubJson(work, "merge.json", { merged: false, message: "Merge already in progress" }),
    );
    const out = (await mergePr(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      expectHead: MERGE_HEAD_SHA,
    })) as { result: string; state: string; merge: { merged: boolean } };
    expect(out.result).toBe("pending");
    expect(out.merge.merged).toBe(false);
    // Post-state is still OPEN — honestly reported, not fabricated.
    expect(out.state).toBe("OPEN");
  });

  test("stale head refuses before any merge write", async () => {
    const { work, logFile } = installGhStub();
    stubMergeFixtures(work);
    await expect(
      mergePr(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: STALE_SHA,
        method: "merge",
      }),
    ).rejects.toMatchObject({ kind: "stale_head" });
    const calls = stubCalls(logFile);
    expect(calls.some((c) => c.includes("--method PUT"))).toBe(false);
    expect(calls.some((c) => c.includes("--method POST"))).toBe(false);
  });

  test.each(["BLOCKED", "DIRTY", "BEHIND", "UNKNOWN", "DRAFT", "HAS_HOOKS"])(
    "mergeStateStatus %s refuses with merge_blocked and no write",
    async (status) => {
      const { work, logFile } = installGhStub();
      stubMergeFixtures(work, { mergeStateStatus: status });
      await expect(
        mergePr(tempDir(), {
          repo: "octo/widgets",
          number: 7,
          expectHead: MERGE_HEAD_SHA,
        }),
      ).rejects.toMatchObject({ kind: "merge_blocked" });
      expect(stubCalls(logFile).some((c) => c.includes("--method PUT"))).toBe(false);
    },
  );

  test("UNSTABLE (non-required checks failing) still attempts the merge", async () => {
    const { work } = installGhStub();
    stubMergeFixtures(work, { mergeStateStatus: "UNSTABLE" });
    setEnv(
      "GH_STUB_MERGE_PUT_JSON",
      writeStubJson(work, "merge.json", { merged: true, sha: "f".repeat(40), message: "Merged" }),
    );
    const out = (await mergePr(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      expectHead: MERGE_HEAD_SHA,
    })) as { result: string; pre_merge_state: { merge_state_status: string } };
    expect(out.result).toBe("merged");
    expect(out.pre_merge_state.merge_state_status).toBe("UNSTABLE");
  });

  test("draft PR is refused even when mergeStateStatus is CLEAN", async () => {
    const { work, logFile } = installGhStub();
    stubMergeFixtures(work, { isDraft: true });
    await expect(
      mergePr(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: MERGE_HEAD_SHA,
      }),
    ).rejects.toMatchObject({ kind: "merge_blocked" });
    expect(stubCalls(logFile).some((c) => c.includes("--method PUT"))).toBe(false);
  });

  test("already-merged PR is refused", async () => {
    const { work } = installGhStub();
    stubMergeFixtures(work, { state: "MERGED" });
    await expect(
      mergePr(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: MERGE_HEAD_SHA,
      }),
    ).rejects.toMatchObject({ kind: "merge_blocked" });
  });

  test("release-train head branch is refused with release_boundary (no write)", async () => {
    const { work, logFile } = installGhStub();
    stubMergeFixtures(work, { headRefName: "release-0-9-0", baseRefName: "main" });
    await expect(
      mergePr(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: MERGE_HEAD_SHA,
      }),
    ).rejects.toMatchObject({ kind: "release_boundary" });
    const calls = stubCalls(logFile);
    expect(calls.some((c) => c.includes("--method PUT"))).toBe(false);
    expect(calls.some((c) => c.includes("--method POST"))).toBe(false);
    expect(calls.some((c) => c.includes("--method DELETE"))).toBe(false);
  });

  test("ticket PR targeting a release branch as base is NOT refused", async () => {
    const { work } = installGhStub();
    // head is a ticket branch, base is the release train — normal flow.
    stubMergeFixtures(work, { headRefName: "173", baseRefName: "release-0-9-0" });
    setEnv(
      "GH_STUB_MERGE_PUT_JSON",
      writeStubJson(work, "merge.json", { merged: true, sha: "f".repeat(40), message: "Merged" }),
    );
    const out = (await mergePr(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      expectHead: MERGE_HEAD_SHA,
    })) as { result: string };
    expect(out.result).toBe("merged");
  });

  test("GitHub 405 refusal maps to merge_blocked", async () => {
    const { work } = installGhStub();
    stubMergeFixtures(work);
    setEnv("GH_STUB_MERGE_API_FAIL", "1");
    await expect(
      mergePr(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: MERGE_HEAD_SHA,
      }),
    ).rejects.toMatchObject({ kind: "merge_blocked" });
  });
});

describe("pr auto-merge", () => {
  test("--auto POSTs pulls/{n}/auto-merge with merge_method and echoes armed state", async () => {
    const { work, logFile } = installGhStub();
    stubMergeFixtures(work, { mergeStateStatus: "BLOCKED" }); // pending checks
    const stdinLog = postStdin(work);
    setEnv(
      "GH_STUB_AUTO_MERGE_POST_JSON",
      writeStubJson(work, "auto.json", { merge_method: "squash", enabled_by: { login: "me" } }),
    );
    setEnv(
      "GH_STUB_MERGE_VIEW_JSON_POST",
      writeStubJson(
        work,
        "auto-view-post.json",
        mergeViewFixture({
          autoMergeRequest: { mergeMethod: "SQUASH", enabledAt: "2026-02-01T00:00:00Z" },
        }),
      ),
    );
    const out = (await mergePr(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      expectHead: MERGE_HEAD_SHA,
      method: "squash",
      auto: true,
    })) as {
      result: string;
      action: string;
      state: string;
      auto_merge_request: { merge_method: string } | null;
    };
    expect(out.result).toBe("auto_merge_enabled");
    expect(out.action).toBe("auto_merge_enable");
    expect(out.state).toBe("OPEN"); // queued, not merged — honest
    expect(out.auto_merge_request).toMatchObject({ merge_method: "SQUASH" });
    const call = stubCalls(logFile).find((c) => c.includes("--method POST"));
    expect(call).toContain("api repos/octo/widgets/pulls/7/auto-merge");
    const payload = JSON.parse(readFileSync(stdinLog, "utf8").trim()) as {
      merge_method: string;
    };
    expect(payload.merge_method).toBe("squash");
  });

  test("auto-merge refuses DIRTY/DRAFT/UNKNOWN but allows BLOCKED (pending checks)", async () => {
    const { work, logFile } = installGhStub();
    for (const status of ["DIRTY", "DRAFT", "UNKNOWN"]) {
      stubMergeFixtures(work, { mergeStateStatus: status });
      await expect(
        mergePr(tempDir(), {
          repo: "octo/widgets",
          number: 7,
          expectHead: MERGE_HEAD_SHA,
          method: "merge",
          auto: true,
        }),
      ).rejects.toMatchObject({ kind: "merge_blocked" });
    }
    // BLOCKED with pending checks is exactly what auto-merge is for.
    stubMergeFixtures(work, { mergeStateStatus: "BLOCKED" });
    setEnv(
      "GH_STUB_AUTO_MERGE_POST_JSON",
      writeStubJson(work, "auto.json", { merge_method: "merge" }),
    );
    const out = (await mergePr(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      expectHead: MERGE_HEAD_SHA,
      method: "merge",
      auto: true,
    })) as { result: string };
    expect(out.result).toBe("auto_merge_enabled");
    expect(stubCalls(logFile).filter((c) => c.includes("--method POST"))).toHaveLength(1);
  });

  test("auto-merge without a method is rejected before any fetch", async () => {
    const { work, logFile } = installGhStub();
    stubMergeFixtures(work);
    await expect(
      mergePr(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: MERGE_HEAD_SHA,
        auto: true,
      }),
    ).rejects.toMatchObject({ kind: "gh_error" });
    expect(stubCalls(logFile)).toEqual([]);
  });

  test("release-train head refuses auto-merge too", async () => {
    const { work, logFile } = installGhStub();
    stubMergeFixtures(work, { headRefName: "release-1-0-0" });
    await expect(
      mergePr(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: MERGE_HEAD_SHA,
        method: "squash",
        auto: true,
      }),
    ).rejects.toMatchObject({ kind: "release_boundary" });
    expect(stubCalls(logFile).some((c) => c.includes("--method POST"))).toBe(false);
  });

  test("--disable-auto DELETEs pulls/{n}/auto-merge", async () => {
    const { work, logFile } = installGhStub();
    stubMergeFixtures(work);
    const out = (await mergePr(tempDir(), {
      repo: "octo/widgets",
      number: 7,
      expectHead: MERGE_HEAD_SHA,
      disableAuto: true,
    })) as { result: string; action: string };
    expect(out.result).toBe("auto_merge_disabled");
    expect(out.action).toBe("auto_merge_disable");
    const call = stubCalls(logFile).find((c) => c.includes("--method DELETE"));
    expect(call).toContain("api repos/octo/widgets/pulls/7/auto-merge");
  });

  test("--disable-auto still enforces the stale-head guard", async () => {
    const { work, logFile } = installGhStub();
    stubMergeFixtures(work);
    await expect(
      mergePr(tempDir(), {
        repo: "octo/widgets",
        number: 7,
        expectHead: STALE_SHA,
        disableAuto: true,
      }),
    ).rejects.toMatchObject({ kind: "stale_head" });
    expect(stubCalls(logFile).some((c) => c.includes("--method DELETE"))).toBe(false);
  });
});
