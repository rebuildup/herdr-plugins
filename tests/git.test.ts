import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectBranchCreate,
  collectBranchSwitch,
  collectCommit,
  collectCompare,
  collectDiff,
  collectFetch,
  collectFiles,
  collectLog,
  collectPush,
  collectRemotes,
  collectStage,
  collectStatus,
  collectUnstage,
  collectUpstream,
  GitError,
  parseLogOutput,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelain,
  parsePorcelainZ,
  resolveRepo,
  sanitizeRemoteUrl,
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
  }, 20000);
});

describe("parseLogOutput", () => {
  test("parses records separated by \\x01 with \\x1f fields", () => {
    const out = [
      "\x01abc123\x1fdef456 789abc\x1fT\x1ft@t\x1f2026-01-01T00:00:00+00:00\x1fT\x1ft@t\x1f2026-01-01T00:00:01+00:00\x1ffirst subject",
      "\x01def456\x1f\x1fT\x1ft@t\x1f2026-01-01T00:00:00+00:00\x1fT\x1ft@t\x1f2026-01-01T00:00:01+00:00\x1froot commit",
      "",
    ].join("");
    const commits = parseLogOutput(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      sha: "abc123",
      parents: ["def456", "789abc"],
      subject: "first subject",
    });
    expect(commits[1]?.parents).toEqual([]);
  });
});

describe("parseNameStatusZ", () => {
  test("parses statuses and rename old/new paths", () => {
    const out = ["M", "a.txt", "R100", "old name.txt", "new name.txt", "D", "gone.txt", ""].join(
      "\0",
    );
    const entries = parseNameStatusZ(out);
    expect(entries).toEqual([
      { status: "M", path: "a.txt", oldPath: null },
      { status: "R100", path: "new name.txt", oldPath: "old name.txt" },
      { status: "D", path: "gone.txt", oldPath: null },
    ]);
  });
});

describe("collectLog", () => {
  test("returns commits newest-first with limit and has_more", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    git(repo, ["commit", "-qam", "second"]);
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
    git(repo, ["commit", "-qam", "third"]);

    const all = await collectLog(repo, {});
    expect(all.commits.map((c) => c.subject)).toEqual(["third", "second", "init"]);
    expect(all.hasMore).toBe(false);

    const limited = await collectLog(repo, { limit: 2 });
    expect(limited.commits).toHaveLength(2);
    expect(limited.hasMore).toBe(true);

    const skipped = await collectLog(repo, { limit: 2, skip: 2 });
    expect(skipped.commits.map((c) => c.subject)).toEqual(["init"]);
  });

  test("first-parent follows only the mainline of a merge", async () => {
    const repo = initRepo();
    git(repo, ["checkout", "-qb", "side"]);
    writeFileSync(path.join(repo, "s.txt"), "s\n");
    git(repo, ["add", "s.txt"]);
    git(repo, ["commit", "-qm", "side work"]);
    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(path.join(repo, "a.txt"), "one\nmain\n");
    git(repo, ["commit", "-qam", "main work"]);
    git(repo, ["merge", "--no-ff", "-m", "merge side", "side"]);

    const merged = await collectLog(repo, { firstParent: true, limit: 10 });
    const subjects = merged.commits.map((c) => c.subject);
    expect(subjects).toContain("merge side");
    expect(subjects).toContain("main work");
    // side work is reachable only via the second parent.
    expect(subjects).not.toContain("side work");
  });
});

describe("collectCompare", () => {
  test("compares HEAD against an explicit base revision", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    git(repo, ["commit", "-qam", "second"]);
    const baseSha = git(repo, ["rev-parse", "HEAD~1"]).trim();

    const result = await collectCompare(repo, { base: baseSha, head: "HEAD" });
    expect(result.mergeBase).toBe(baseSha);
    expect(result.ahead).toBe(1);
    expect(result.behind).toBe(0);
    expect(result.files.map((f) => f.path)).toContain("a.txt");
    expect(result.patch.output).toContain("+two");
  });

  test("uses merge-base for diverged branches", async () => {
    const repo = initRepo();
    git(repo, ["checkout", "-qb", "feature"]);
    writeFileSync(path.join(repo, "f.txt"), "feature\n");
    git(repo, ["add", "f.txt"]);
    git(repo, ["commit", "-qm", "feature commit"]);
    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(path.join(repo, "a.txt"), "one\nmain\n");
    git(repo, ["commit", "-qam", "main commit"]);

    const result = await collectCompare(repo, { base: "main", head: "feature" });
    // merge-base is the init commit; feature adds f.txt only.
    expect(result.files.map((f) => f.path)).toEqual(["f.txt"]);
    expect(result.ahead).toBe(1);
    expect(result.behind).toBe(1);
  });

  test("rejects when no base and no upstream", async () => {
    const repo = initRepo();
    await expect(collectCompare(repo, {})).rejects.toMatchObject({
      kind: "git_error",
    });
  });
});

describe("mutations", () => {
  test("stage paths / --all then commit returns new sha", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "one\nchanged\n");
    writeFileSync(path.join(repo, "n.txt"), "new\n");

    await collectStage(repo, { paths: ["a.txt"] });
    let status = await collectStatus(repo);
    expect(status.changes.staged).toBe(1);
    expect(status.changes.unstaged).toBe(0);
    expect(status.changes.untracked).toBe(1);

    // n.txt stays untracked until staged explicitly.
    await collectStage(repo, { paths: ["n.txt"] });
    const commit = await collectCommit(repo, { messages: ["work", "details"] });
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
    const log = git(repo, ["log", "-1", "--format=%s %b"]).trim();
    expect(log).toContain("work");
    expect(log).toContain("details");

    status = await collectStatus(repo);
    expect(status.changes.staged + status.changes.unstaged + status.changes.untracked).toBe(0);
  });

  test("unstage --all and per-path restore the index", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "one\nchanged\n");
    git(repo, ["add", "a.txt"]);
    await collectUnstage(repo, { paths: ["a.txt"] });
    let status = await collectStatus(repo);
    expect(status.changes.staged).toBe(0);
    expect(status.changes.unstaged).toBe(1);

    git(repo, ["add", "a.txt"]);
    await collectUnstage(repo, { all: true });
    status = await collectStatus(repo);
    expect(status.changes.staged).toBe(0);
  });

  test("stage/unstage require --all or --path", async () => {
    const repo = initRepo();
    await expect(collectStage(repo, {})).rejects.toMatchObject({ kind: "git_error" });
    await expect(collectUnstage(repo, {})).rejects.toMatchObject({ kind: "git_error" });
  });

  test("rejects option-like path injection", async () => {
    const repo = initRepo();
    await expect(collectStage(repo, { paths: ["--all"] })).rejects.toMatchObject({
      kind: "git_error",
    });
  });

  test("commit without -m fails; --allow-empty works", async () => {
    const repo = initRepo();
    await expect(collectCommit(repo, { messages: [] })).rejects.toMatchObject({
      kind: "git_error",
    });
    const empty = await collectCommit(repo, { messages: ["noop"], allowEmpty: true });
    expect(empty.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("commit with nothing staged fails as git_error", async () => {
    const repo = initRepo();
    await expect(collectCommit(repo, { messages: ["nothing"] })).rejects.toMatchObject({
      kind: "git_error",
    });
  });

  test("branch create/switch and upstream round-trip", async () => {
    const repo = initRepo();
    await collectBranchCreate(repo, { name: "feature", switchTo: true });
    let status = await collectStatus(repo);
    expect(status.branch.name).toBe("feature");

    await collectBranchCreate(repo, { name: "other" });
    await collectBranchSwitch(repo, { name: "feature" });
    status = await collectStatus(repo);
    expect(status.branch.name).toBe("feature");

    // upstream against a real remote-tracking ref (bare remote + push)
    const bare = tempDir();
    spawnSync("git", ["init", "--bare", "-q", bare]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-q", "origin", "feature"]);
    const out = await collectUpstream(repo, { upstream: "origin/feature" });
    expect(out).toContain("feature");
    status = await collectStatus(repo);
    expect(status.branch.upstream).toBe("origin/feature");
  }, 20000);

  test("branch name injection is rejected", async () => {
    const repo = initRepo();
    await expect(collectBranchCreate(repo, { name: "--help" })).rejects.toMatchObject({
      kind: "git_error",
    });
  });
});

describe("remote operations", () => {
  function repoWithRemote(): { repo: string; bare: string } {
    const repo = initRepo();
    const bare = tempDir();
    spawnSync("git", ["init", "--bare", "-q", bare]);
    // Pin HEAD so clones check out main regardless of the host's
    // init.defaultBranch (Linux CI defaults differ from macOS).
    spawnSync("git", ["-C", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
    git(repo, ["remote", "add", "origin", bare]);
    return { repo, bare };
  }

  test("push --set-upstream then fetch round-trips", async () => {
    const { repo, bare } = repoWithRemote();
    writeFileSync(path.join(repo, "a.txt"), "one\nchanged\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-qm", "work"]);

    await collectPush(repo, {
      remote: "origin",
      refspec: "HEAD:main",
      setUpstream: true,
    });
    let status = await collectStatus(repo);
    expect(status.branch.upstream).toBe("origin/main");

    // Advance the bare remote from a second clone, then fetch.
    const clone = tempDir();
    spawnSync("git", ["clone", "-q", bare, clone]);
    git(clone, ["config", "user.email", "t@t"]);
    git(clone, ["config", "user.name", "t"]);
    writeFileSync(path.join(clone, "b.txt"), "remote\n");
    git(clone, ["add", "b.txt"]);
    git(clone, ["commit", "-qm", "remote work"]);
    git(clone, ["push", "-q", "origin", "HEAD:main"]);

    // fetch/push report progress on stderr, so collect* returns "" on success.
    await collectFetch(repo, {});
    status = await collectStatus(repo);
    expect(status.branch.upstream).toBe("origin/main");
    expect(status.branch.behind).toBe(1);
  }, 20000);

  test("push without upstream errors structurally", async () => {
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "one\nx\n");
    git(repo, ["commit", "-qam", "w"]);
    await expect(collectPush(repo, {})).rejects.toMatchObject({ kind: "git_error" });
  });

  test("force push requires the explicit flag", async () => {
    const { repo } = repoWithRemote();
    git(repo, ["push", "-q", "origin", "HEAD:main"]);
    writeFileSync(path.join(repo, "a.txt"), "one\nrewritten\n");
    git(repo, ["commit", "-qam", "rewrite"]);
    git(repo, ["push", "-q", "origin", "HEAD:main"]);
    // Diverge local history from what the remote now holds.
    git(repo, ["reset", "-q", "--hard", "HEAD~1"]);
    writeFileSync(path.join(repo, "a.txt"), "one\nother\n");
    git(repo, ["commit", "-qam", "other"]);
    // Plain push is rejected (non-fast-forward); force-with-lease succeeds.
    await expect(
      collectPush(repo, { remote: "origin", refspec: "HEAD:main" }),
    ).rejects.toMatchObject({
      kind: "git_error",
    });
    await collectPush(repo, { remote: "origin", refspec: "HEAD:main", forceWithLease: true });
  }, 20000);

  test("remote list strips URL credentials", async () => {
    const repo = initRepo();
    git(repo, ["remote", "add", "origin", "https://user:secret@example.com/org/repo.git"]);
    git(repo, ["remote", "add", "ssh", "git@example.com:org/other.git"]);
    const remotes = await collectRemotes(repo);
    const byName = new Map(remotes.map((r) => [r.name, r]));
    expect(byName.get("origin")?.url).toBe("https://example.com/org/repo.git");
    expect(byName.get("ssh")?.url).toBe("git@example.com:org/other.git");
    expect(sanitizeRemoteUrl("https://oauth2:TOKEN@gitlab.com/x/y.git")).toBe(
      "https://gitlab.com/x/y.git",
    );
  }, 20000);
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

// ---------------------------------------------------------------------------
// CLI contract tests: strict option parsing and the usage/runtime exit-code
// boundary. Every case here fails during argument validation, before any
// herdr socket or git access, so no session fixture is required.
// ---------------------------------------------------------------------------

const GIT_CLI = path.join(import.meta.dir, "..", "plugins", "git", "src", "cli.ts");

function runCli(args: string[]): { status: number; error: { code?: string; message?: string } } {
  const env = { ...process.env };
  for (const key of [
    "HERDR_PANE_ID",
    "HERDR_PLUGIN_CONTEXT_JSON",
    "HERDR_SOCKET_PATH",
    "HERDR_SESSION",
  ]) {
    delete env[key];
  }
  const result = spawnSync(process.execPath, ["run", GIT_CLI, ...args], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  let error: { code?: string; message?: string } = {};
  try {
    error = (JSON.parse(result.stderr) as { error?: typeof error }).error ?? {};
  } catch {
    // Non-JSON stderr still fails the assertions below via status/code.
  }
  return { status: result.status ?? -1, error };
}

function expectUsage(args: string[]): void {
  const { status, error } = runCli(args);
  expect(status).toBe(2);
  expect(error.code).toBe("usage");
}

describe("cli usage errors", () => {
  test("every command rejects unknown options with exit 2", () => {
    const cases: string[][] = [
      ["status", "p1", "--bogus"],
      ["files", "p1", "--bogus"],
      ["diff", "p1", "--bogus"],
      ["log", "p1", "--bogus"],
      ["compare", "p1", "--bogus"],
      ["stage", "p1", "--all", "--bogus"],
      ["unstage", "p1", "--path", "x", "--bogus"],
      ["commit", "p1", "-m", "hi", "--bogus"],
      ["branch", "create", "p1", "n", "--bogus"],
      ["branch", "switch", "p1", "n", "--bogus"],
      ["upstream", "p1", "ref", "--bogus"],
      ["fetch", "p1", "--bogus"],
      ["push", "p1", "--bogus"],
      ["remote", "p1", "--bogus"],
      ["pr", "list", "p1", "--bogus"],
      ["pr", "status", "p1", "--bogus"],
      ["pr", "view", "p1", "1", "--bogus"],
      ["pr", "create", "p1", "--title", "t", "--bogus"],
      ["project", "p1", "--bogus"],
      ["capability", "--bogus"],
    ];
    for (const args of cases) expectUsage(args);
  }, 60_000);
  test("--flag=value on a boolean flag and bare --name= are usage errors", () => {
    expectUsage(["push", "p1", "--set-upstream=yes"]);
    expectUsage(["diff", "p1", "--staged=1"]);
    expectUsage(["status", "p1", "--bogus=1"]);
  }, 60_000);
  test("value flags require a value; globals are validated too", () => {
    expectUsage(["files", "p1", "--path"]);
    expectUsage(["commit", "p1", "-m"]);
    expectUsage(["diff", "p1", "--max-bytes"]);
    expectUsage(["status", "p1", "--timeout"]);
    expectUsage(["status", "p1", "--timeout", "abc"]);
    expectUsage(["status", "p1", "--session"]);
    expectUsage(["status", "p1", "--timeout=-5"]);
  }, 60_000);
  test("extra positionals are usage errors", () => {
    expectUsage(["status", "p1", "p2"]);
    expectUsage(["remote", "p1", "extra"]);
    expectUsage(["fetch", "p1", "r1", "r2"]);
    expectUsage(["push", "p1", "r1", "r2", "r3"]);
    expectUsage(["compare", "p1", "a", "b", "c"]);
    expectUsage(["diff", "p1", "a", "b", "c"]);
    expectUsage(["log", "p1", "p2"]);
    expectUsage(["capability", "extra"]);
  }, 60_000);
  test("stage/unstage require --all or --path (was git_error exit 1)", () => {
    expectUsage(["stage", "p1"]);
    expectUsage(["unstage", "p1"]);
    expectUsage(["stage", "p1", "--all", "--path", "x"]);
    expectUsage(["unstage", "p1", "--all", "--path=x"]);
  }, 60_000);
  test("commit requires -m (was git_error exit 1)", () => {
    expectUsage(["commit", "p1"]);
    expectUsage(["commit", "p1", "--allow-empty"]);
    expectUsage(["commit", "p1", "-m", ""]);
  }, 60_000);
  test("branch validates subcommand and per-subcommand flags", () => {
    expectUsage(["branch"]);
    expectUsage(["branch", "bogus", "p1", "n"]);
    expectUsage(["branch", "switch", "p1", "n", "--switch"]);
  }, 60_000);
  test("pr validates action, per-action flags, and required args", () => {
    expectUsage(["pr"]);
    expectUsage(["pr", "bogus", "p1"]);
    expectUsage(["pr", "list", "p1", "--title", "t"]); // --title is create-only
    expectUsage(["pr", "status", "p1", "--state", "open"]);
    expectUsage(["pr", "view", "p1"]); // missing PR number
    expectUsage(["pr", "view", "p1", "abc"]);
    expectUsage(["pr", "view", "p1", "1", "2"]);
    expectUsage(["pr", "list", "p1", "extra"]);
    expectUsage(["pr", "create", "p1"]); // missing --title
    expectUsage(["pr", "create", "p1", "--title", "t", "--body", "b", "--body-file", "f"]);
    expectUsage(["pr", "create", "p1", "--title", "t", "extra"]);
    expectUsage(["pr", "create", "p1", "--title", "t", "--repo", "not-a-repo"]);
    expectUsage(["pr", "list", "p1", "--state", "bogus"]);
    expectUsage(["pr", "list", "p1", "--limit", "0"]);
  }, 60_000);
  test("issue validates action, per-action flags, and required args", () => {
    expectUsage(["issue"]);
    expectUsage(["issue", "bogus", "p1"]);
    expectUsage(["issue", "list", "p1", "--title", "t"]); // --title is create-only
    expectUsage(["issue", "view", "p1"]); // missing issue number
    expectUsage(["issue", "view", "p1", "abc"]);
    expectUsage(["issue", "view", "p1", "1", "2"]);
    expectUsage(["issue", "list", "p1", "extra"]);
    expectUsage(["issue", "list", "p1", "--state", "bogus"]);
    expectUsage(["issue", "list", "p1", "--limit", "0"]);
    expectUsage(["issue", "create", "p1"]); // missing --title
    expectUsage(["issue", "create", "p1", "--title", "t", "--body", "b", "--body-file", "f"]);
    expectUsage(["issue", "create", "p1", "--title", "t", "extra"]);
    expectUsage(["issue", "create", "p1", "--title", "t", "--repo", "not-a-repo"]);
    expectUsage(["issue", "edit", "p1"]); // missing number
    expectUsage(["issue", "edit", "p1", "1"]); // no fields to update
    expectUsage(["issue", "edit", "p1", "1", "--state", "bogus"]);
    expectUsage(["issue", "edit", "p1", "1", "--title", "t", "--body", "b", "--body-file", "f"]);
    expectUsage(["issue", "comment", "p1"]); // missing number
    expectUsage(["issue", "close", "p1", "1", "--reason", "bogus"]);
    expectUsage(["issue", "link", "p1"]); // missing ref
    expectUsage(["issue", "link", "p1", "not-a-ref"]);
    expectUsage(["issue", "link", "p1", "owner/repo#0"]);
    expectUsage(["issue", "link", "p1", "owner/repo#5", "extra"]);
    expectUsage(["issue", "unlink", "p1", "owner/repo"]);
    expectUsage(["issue", "links", "p1", "extra"]);
    expectUsage(["issue", "links", "p1", "--verify"]); // --verify is link-only
  }, 60_000);
});
