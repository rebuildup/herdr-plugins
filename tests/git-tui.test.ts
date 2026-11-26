import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertTargetFresh, resolvePinnedTarget } from "../plugins/git/src/tui/app";
import {
  branchLabel,
  buildPaneOpenArgs,
  commitLabel,
  describeError,
  diffScopeFor,
  fileDetail,
  fileLabel,
  fileStatusTag,
  formatBranchLine,
  formatChangeCounts,
  parseBranches,
  parsePluginContext,
  resolveTargetSpec,
  StaleTargetError,
  shortSha,
} from "../plugins/git/src/tui/model";
import {
  collectBranches,
  collectCommitShow,
  currentBranchName,
  headSha,
  headShaOrNull,
} from "../plugins/git/src/tui/repo";
import { normalizePath, testEnv } from "./helpers/test-env";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "git-tui-test-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv() });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
}

function initRepo(): string {
  const dir = realpathSync(tempDir());
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

// --- context / target spec ---------------------------------------------------------

describe("parsePluginContext", () => {
  test("parses focused pane/workspace/tab", () => {
    const ctx = parsePluginContext(
      JSON.stringify({
        focused_pane_id: "p1",
        workspace_id: "w1",
        tab_id: "t1",
        selected_text: "ignored",
      }),
    );
    expect(ctx?.focusedPaneId).toBe("p1");
    expect(ctx?.workspaceId).toBe("w1");
    expect(ctx?.tabId).toBe("t1");
  });

  test("returns null for missing/invalid JSON", () => {
    expect(parsePluginContext(undefined)).toBeNull();
    expect(parsePluginContext("")).toBeNull();
    expect(parsePluginContext("not json")).toBeNull();
    expect(parsePluginContext("[1,2]")).toBeNull();
    expect(parsePluginContext('"str"')).toBeNull();
  });

  test("empty-string ids become null", () => {
    const ctx = parsePluginContext(JSON.stringify({ focused_pane_id: "" }));
    expect(ctx?.focusedPaneId).toBeNull();
  });
});

describe("resolveTargetSpec", () => {
  test("explicit env target pane wins over context", () => {
    const spec = resolveTargetSpec({
      HERDR_TUI_TARGET_PANE_ID: "explicit",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "ctx" }),
    } as NodeJS.ProcessEnv);
    expect(spec.paneId).toBe("explicit");
  });

  test("context focused pane used when no explicit override", () => {
    const spec = resolveTargetSpec({
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "ctx" }),
    } as NodeJS.ProcessEnv);
    expect(spec.paneId).toBe("ctx");
  });

  test("cli cwd wins over env cwd", () => {
    const spec = resolveTargetSpec({ HERDR_TUI_TARGET_CWD: "/env" } as NodeJS.ProcessEnv, "/cli");
    expect(spec.cwd).toBe("/cli");
  });

  test("HERDR_PANE_ID is never consulted (it is the UI pane)", () => {
    const spec = resolveTargetSpec({ HERDR_PANE_ID: "ui-pane" } as NodeJS.ProcessEnv);
    expect(spec.paneId).toBeNull();
  });
});

describe("buildPaneOpenArgs", () => {
  test("builds plugin pane open argv", () => {
    const args = buildPaneOpenArgs({
      pluginId: "rebuildup.git",
      entrypoint: "main",
      placement: "tab",
      workspaceId: "w1",
      targetPaneId: "p1",
    });
    expect(args).toEqual([
      "plugin",
      "pane",
      "open",
      "--plugin",
      "rebuildup.git",
      "--entrypoint",
      "main",
      "--placement",
      "tab",
      "--workspace",
      "w1",
      "--env",
      "HERDR_TUI_TARGET_PANE_ID=p1",
    ]);
  });

  test("omits optional flags when unset", () => {
    const args = buildPaneOpenArgs({
      pluginId: "rebuildup.git",
      entrypoint: "main",
      placement: "tab",
      workspaceId: null,
      targetPaneId: null,
    });
    expect(args).not.toContain("--workspace");
    expect(args.some((a) => a.startsWith("--env"))).toBe(false);
  });
});

// --- display formatting --------------------------------------------------------------

describe("display formatting", () => {
  test("shortSha truncates", () => {
    expect(shortSha("abcdef1234567890", 7)).toBe("abcdef1");
    expect(shortSha("abc", 7)).toBe("abc");
  });

  test("formatBranchLine covers upstream states", () => {
    expect(
      formatBranchLine({
        name: "main",
        detached: false,
        upstream: "origin/main",
        ahead: 2,
        behind: 0,
      }),
    ).toBe("main -> origin/main ahead 2");
    expect(
      formatBranchLine({
        name: "main",
        detached: false,
        upstream: null,
        ahead: null,
        behind: null,
      }),
    ).toBe("main (no upstream)");
    expect(
      formatBranchLine({ name: "HEAD", detached: true, upstream: null, ahead: null, behind: null }),
    ).toBe("HEAD (detached)");
  });

  test("formatChangeCounts", () => {
    expect(formatChangeCounts({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })).toBe(
      "clean",
    );
    expect(formatChangeCounts({ staged: 1, unstaged: 2, untracked: 3, conflicted: 1 })).toBe(
      "staged 1 · unstaged 2 · untracked 3 · CONFLICTS 1",
    );
  });

  test("fileStatusTag / fileLabel / fileDetail", () => {
    const f = {
      path: "src/a.ts",
      oldPath: null,
      index: "M",
      worktree: " ",
      kind: "modified" as const,
      staged: true,
      unstaged: false,
      binary: false,
    };
    expect(fileStatusTag(f)).toBe("M ");
    expect(fileLabel(f)).toContain("src/a.ts");
    expect(fileDetail(f)).toContain("staged");
    const u = {
      ...f,
      path: "new.txt",
      index: "?",
      worktree: "?",
      kind: "untracked" as const,
      staged: false,
    };
    expect(fileStatusTag(u)).toBe("??");
  });

  test("diffScopeFor picks the right git diff scope", () => {
    const base = {
      path: "a",
      oldPath: null,
      index: " ",
      worktree: " ",
      kind: "modified" as const,
      staged: false,
      unstaged: true,
      binary: null,
    };
    expect(diffScopeFor(base)).toBe("worktree");
    expect(diffScopeFor({ ...base, staged: true, unstaged: false })).toBe("staged");
    expect(diffScopeFor({ ...base, staged: true, unstaged: true })).toBe("head");
    expect(diffScopeFor({ ...base, kind: "untracked" as const, unstaged: false })).toBe("none");
    expect(diffScopeFor({ ...base, kind: "conflicted" as const })).toBe("worktree");
  });

  test("commitLabel", () => {
    expect(
      commitLabel({
        sha: "abcdef1234567890",
        parents: [],
        author: { name: "A", email: "a@x", date: "d" },
        committer: { name: "A", email: "a@x", date: "d" },
        subject: "msg",
      }),
    ).toBe("abcdef1 msg");
  });
});

// --- branch parsing ---------------------------------------------------------------------

describe("parseBranches / branchLabel", () => {
  test("parses for-each-ref output", () => {
    const out = ["main\t*\torigin/main\t[ahead 1]\tabc123", "dev\t\t\t\tdef456", ""].join("\n");
    const entries = parseBranches(out);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      name: "main",
      current: true,
      upstream: "origin/main",
      track: "[ahead 1]",
    });
    expect(entries[1]).toMatchObject({ name: "dev", current: false, upstream: null });
    expect(branchLabel(entries[0] as never)).toContain("* main");
  });
});

// --- error classification -----------------------------------------------------------------

describe("describeError", () => {
  test("not_a_repo kind maps to honest state", () => {
    const e = describeError({ kind: "not_a_repo", message: "no repo" }, "/x");
    expect(e.title).toBe("Not a git repository");
    expect(e.cliFallback).toContain("cli.ts");
  });

  test("TargetResolutionError-style code maps to target unavailable", () => {
    const e = describeError(Object.assign(new Error("boom"), { code: "target_required" }), null);
    expect(e.title).toBe("Target unavailable");
  });

  test("unknown error falls back to message", () => {
    const e = describeError(new Error("weird"), null);
    expect(e.title).toBe("Error");
    expect(e.lines[0]).toBe("weird");
  });
});

// --- repo collectors against real git ------------------------------------------------------

describe("tui repo collectors", () => {
  test("collectBranches lists branches with current marker", async () => {
    const dir = initRepo();
    git(dir, ["checkout", "-b", "feature"]);
    const branches = await collectBranches(dir);
    const names = branches.map((b) => b.name);
    expect(names).toContain("main");
    expect(names).toContain("feature");
    expect(branches.find((b) => b.name === "feature")?.current).toBe(true);
    expect(branches.find((b) => b.name === "main")?.current).toBe(false);
  });

  test("headSha / headShaOrNull", async () => {
    const dir = initRepo();
    const sha = await headSha(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await headShaOrNull(dir)).toBe(sha);
  });

  test("headShaOrNull on unborn branch returns null", async () => {
    const dir = realpathSync(tempDir());
    git(dir, ["init", "-b", "main"]);
    expect(await headShaOrNull(dir)).toBeNull();
    expect(await currentBranchName(dir)).toBe("main");
  });

  test("currentBranchName detached returns HEAD", async () => {
    const dir = initRepo();
    const sha = git(dir, ["rev-parse", "HEAD"]).trim();
    git(dir, ["checkout", "--detach", sha]);
    expect(await currentBranchName(dir)).toBe("HEAD");
  });

  test("collectCommitShow returns bounded commit text", async () => {
    const dir = initRepo();
    const sha = git(dir, ["rev-parse", "HEAD"]).trim();
    const out = await collectCommitShow(dir, sha);
    expect(out).toContain("init");
    expect(out).toContain("commit");
  });

  test("collectCommitShow rejects bad sha", async () => {
    const dir = initRepo();
    await expect(collectCommitShow(dir, "not-a-sha!")).rejects.toThrow();
    await expect(collectCommitShow(dir, "--help")).rejects.toThrow();
  });
});

// --- pinned target resolution + stale revalidation -----------------------------------------

describe("resolvePinnedTarget / assertTargetFresh", () => {
  test("resolves repo root + HEAD pin from cwd (no pane)", async () => {
    const dir = initRepo();
    const target = await resolvePinnedTarget({ paneId: null, cwd: dir, workspaceId: null });
    expect(target.repoRoot).toBe(normalizePath(dir));
    expect(target.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(target.branchName).toBe("main");
    expect(target.detached).toBe(false);
  });

  test("unborn branch pins headSha null + branch name", async () => {
    const dir = realpathSync(tempDir());
    git(dir, ["init", "-b", "main"]);
    const target = await resolvePinnedTarget({ paneId: null, cwd: dir, workspaceId: null });
    expect(target.headSha).toBeNull();
    expect(target.branchName).toBe("main");
  });

  test("no target throws target_required", async () => {
    await expect(
      resolvePinnedTarget({ paneId: null, cwd: null, workspaceId: null }),
    ).rejects.toThrow(/no target/);
  });

  test("not a repo surfaces GitError not_a_repo", async () => {
    const dir = tempDir();
    await expect(
      resolvePinnedTarget({ paneId: null, cwd: dir, workspaceId: null }),
    ).rejects.toMatchObject({ kind: "not_a_repo" });
  });

  test("assertTargetFresh passes when HEAD unchanged", async () => {
    const dir = initRepo();
    const target = await resolvePinnedTarget({ paneId: null, cwd: dir, workspaceId: null });
    await expect(assertTargetFresh(target)).resolves.toBeUndefined();
  });

  test("assertTargetFresh throws StaleTargetError after a commit", async () => {
    const dir = initRepo();
    const target = await resolvePinnedTarget({ paneId: null, cwd: dir, workspaceId: null });
    writeFileSync(path.join(dir, "b.txt"), "two\n");
    git(dir, ["add", "b.txt"]);
    git(dir, ["commit", "-m", "second"]);
    await expect(assertTargetFresh(target)).rejects.toBeInstanceOf(StaleTargetError);
  });

  test("assertTargetFresh throws when unborn HEAD gets first commit", async () => {
    const dir = realpathSync(tempDir());
    git(dir, ["init", "-b", "main"]);
    const target = await resolvePinnedTarget({ paneId: null, cwd: dir, workspaceId: null });
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "init"]);
    await expect(assertTargetFresh(target)).rejects.toBeInstanceOf(StaleTargetError);
  });
});
