import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectPrCreate,
  collectPrList,
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
  pr)
    case "\${2:-}" in
      list) cat "\${GH_STUB_LIST_JSON:-/dev/null}" 2>/dev/null || echo '[]';;
      view) cat "\${GH_STUB_VIEW_JSON:-/dev/null}";;
      create) echo "https://github.com/octo/widgets/pull/42";;
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
