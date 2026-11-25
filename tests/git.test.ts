import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectDiff,
  collectStatus,
  GitError,
  parsePorcelain,
  resolveRepo,
} from "../plugins/git/src/git";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "git-plugin-test-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
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

describe("parsePorcelain", () => {
  test("counts staged, unstaged, untracked, conflicted", () => {
    const out = [
      "M  staged.txt", // staged modification
      " M unstaged.txt", // unstaged modification
      "?? new.txt", // untracked
      "A  added.txt", // staged add
      "UU conflicted.txt", // unmerged
      "!! ignored.log", // ignored — not counted
    ].join("\n");
    expect(parsePorcelain(out)).toEqual({
      staged: 2, // staged.txt + added.txt
      unstaged: 1, // unstaged.txt (unmerged counted only as conflicted)
      untracked: 1,
      conflicted: 1,
    });
  });

  test("empty output yields zero counts", () => {
    expect(parsePorcelain("")).toEqual({
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    });
  });
});

describe("resolveRepo", () => {
  test("resolves repo root from a nested subdirectory", async () => {
    const repo = initRepo();
    const nested = path.join(repo, "sub", "dir");
    spawnSync("mkdir", ["-p", nested]);
    const info = await resolveRepo(nested);
    expect(info.root).toBe(repo);
    expect(info.bare).toBe(false);
  });

  test("throws not_a_repo outside any work tree", async () => {
    const dir = tempDir();
    await expect(resolveRepo(dir)).rejects.toMatchObject({
      kind: "not_a_repo",
    });
    await expect(resolveRepo(dir)).rejects.toBeInstanceOf(GitError);
  });
});

describe("collectStatus", () => {
  test("reports branch and change counts on a dirty repo", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n"); // unstaged modify
    writeFileSync(path.join(repo, "b.txt"), "new\n"); // untracked
    const status = await collectStatus(repo);
    expect(status.repo.root).toBe(repo);
    expect(status.branch.name).toBe("main");
    expect(status.branch.detached).toBe(false);
    expect(status.changes.unstaged).toBe(1);
    expect(status.changes.untracked).toBe(1);
    expect(status.changes.staged).toBe(0);
  });

  test("reports detached HEAD", async () => {
    const repo = initRepo();
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["checkout", "--detach", sha]);
    const status = await collectStatus(repo);
    expect(status.branch.detached).toBe(true);
    expect(status.branch.name).toBe("HEAD");
  });
});

describe("collectDiff", () => {
  test("returns worktree diff and honors byte cap", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "one\nchanged\n");
    const result = await collectDiff(repo, {});
    expect(result.truncated).toBe(false);
    expect(result.output).toContain("+changed");

    const capped = await collectDiff(repo, { maxBytes: 40 });
    expect(capped.truncated).toBe(true);
    expect(capped.bytes).toBeLessThanOrEqual(40);
  });

  test("--staged diffs index vs HEAD", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "one\nstaged\n");
    git(repo, ["add", "a.txt"]);
    const unstaged = await collectDiff(repo, {});
    expect(unstaged.output).not.toContain("+staged");
    const staged = await collectDiff(repo, { staged: true });
    expect(staged.output).toContain("+staged");
  });

  test("revision diff between two commits", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-m", "second"]);
    const result = await collectDiff(repo, { revisions: ["HEAD~1", "HEAD"] });
    expect(result.output).toContain("+two");
  });
});
