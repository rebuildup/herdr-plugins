import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectDiff,
  collectFiles,
  collectStatus,
  GitError,
  parseNumstatZ,
  parsePorcelain,
  parsePorcelainZ,
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

describe("parsePorcelainZ", () => {
  test("parses rename with old path, untracked, and special characters", () => {
    const out = ["R  renamed file.txt", "a file.txt", " M sub/b.txt", "?? sp ace?.txt", ""].join(
      "\0",
    );
    const entries = parsePorcelainZ(out);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      path: "renamed file.txt",
      oldPath: "a file.txt",
      kind: "renamed",
      staged: true,
      unstaged: false,
    });
    expect(entries[1]).toMatchObject({
      path: "sub/b.txt",
      kind: "modified",
      staged: false,
      unstaged: true,
    });
    expect(entries[2]).toMatchObject({
      path: "sp ace?.txt",
      kind: "untracked",
      binary: null,
    });
  });

  test("marks unmerged entries conflicted", () => {
    const entries = parsePorcelainZ("UU conflicted.txt\0AA both.txt\0");
    expect(entries.map((e) => e.kind)).toEqual(["conflicted", "conflicted"]);
  });
});

describe("parseNumstatZ", () => {
  test("collects binary paths and rename destinations", () => {
    const out = [
      "-\t-\tbin.dat",
      "1\t0\tsub/b.txt",
      "0\t0\t",
      "old name.txt",
      "new name.txt",
      "",
    ].join("\0");
    const { binary, stats } = parseNumstatZ(out);
    expect(binary.has("bin.dat")).toBe(true);
    expect(stats.get("sub/b.txt")).toEqual({ added: 1, deleted: 0 });
    expect(stats.get("new name.txt")).toEqual({ added: 0, deleted: 0 });
  });
});

describe("collectFiles", () => {
  test("lists staged rename, unstaged modify, untracked, binary", async () => {
    const repo = initRepo();
    git(repo, ["mv", "a.txt", "b.txt"]);
    writeFileSync(path.join(repo, "b.txt"), "one\nmore\n");
    writeFileSync(path.join(repo, "c.txt"), "new\n");
    writeFileSync(path.join(repo, "bin.dat"), "x\0y");
    git(repo, ["add", "bin.dat"]);

    const { files } = await collectFiles(repo);
    const byPath = new Map(files.map((f) => [f.path, f]));

    const renamed = byPath.get("b.txt");
    expect(renamed).toMatchObject({ kind: "renamed", oldPath: "a.txt", staged: true });
    // b.txt has a staged rename plus an unstaged modification.
    expect(renamed?.unstaged).toBe(true);

    const untracked = byPath.get("c.txt");
    expect(untracked).toMatchObject({ kind: "untracked", binary: null });

    const binary = byPath.get("bin.dat");
    expect(binary).toMatchObject({ kind: "added", binary: true });
  });

  test("pathspec limits the file list", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    writeFileSync(path.join(repo, "z.txt"), "zzz\n");
    const { files } = await collectFiles(repo, { pathspec: ["a.txt"] });
    expect(files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  test("surfaces conflicted entries during a merge", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "side-a\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-qm", "a"]);
    git(repo, ["checkout", "-qb", "side"]);
    writeFileSync(path.join(repo, "a.txt"), "side-b\n");
    git(repo, ["commit", "-qam", "b"]);
    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(path.join(repo, "a.txt"), "main-c\n");
    git(repo, ["commit", "-qam", "c"]);
    spawnSync("git", ["merge", "side"], { cwd: repo });
    const { files } = await collectFiles(repo);
    const conflicted = files.find((f) => f.path === "a.txt");
    expect(conflicted?.kind).toBe("conflicted");
    expect(conflicted?.binary).toBeNull();
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

  test("--path limits the diff to the given pathspec", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "z.txt"), "zee\n");
    git(repo, ["add", "z.txt"]);
    git(repo, ["commit", "-qm", "add z"]);
    writeFileSync(path.join(repo, "a.txt"), "one\nchanged-a\n");
    writeFileSync(path.join(repo, "z.txt"), "zee\nchanged-z\n");
    const all = await collectDiff(repo, {});
    expect(all.output).toContain("z.txt");
    const scoped = await collectDiff(repo, { paths: ["a.txt"] });
    expect(scoped.output).toContain("a.txt");
    expect(scoped.output).not.toContain("z.txt");
  });

  test("name-status and numstat formats return bounded machine output", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "one\nchanged\n");
    writeFileSync(path.join(repo, "n.txt"), "new\n");

    const nameStatus = await collectDiff(repo, { format: "name-status" });
    // -z format: status letter and path are NUL-separated.
    expect(nameStatus.output).toContain("M\0a.txt");
    expect(nameStatus.output).not.toContain("diff --git");

    const numstat = await collectDiff(repo, { format: "numstat" });
    expect(numstat.output).toContain("1\t0\ta.txt");
  });
});
