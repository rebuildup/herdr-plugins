import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeRemoteUrl, repoRemoteIdentity } from "../packages/git-core/src/index";
import { discoverRepos, projectIdFromRoot, repoIndex } from "../plugins/projects/src/model";
import { emptyState, loadState, type Project, updateState } from "../plugins/projects/src/state";

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "projects-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (savedStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir;
});

function useStateDir(): void {
  process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function initRepo(withRemote = false): string {
  const dir = realpathSync(tempDir());
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-qm", "init"]);
  if (withRemote) {
    const bare = tempDir();
    spawnSync("git", ["init", "--bare", "-q", bare]);
    git(dir, ["remote", "add", "origin", `git@github.com:Octo/Widgets.git`]);
  }
  return dir;
}

function makeProject(id: string, roots: string[]): Project {
  const now = new Date().toISOString();
  return {
    id,
    title: id,
    repos: roots.map((root) => ({ root, remote: null, added_at: now })),
    pinned: false,
    archived: false,
    created_at: now,
    updated_at: now,
  };
}

describe("state", () => {
  test("loadState returns empty state when file missing", async () => {
    useStateDir();
    const state = await loadState();
    expect(state.projects).toEqual({});
  });

  test("updateState persists projects across loads", async () => {
    useStateDir();
    await updateState((s) => {
      s.projects["demo"] = makeProject("demo", ["/tmp/x"]);
    });
    const state = await loadState();
    expect(state.projects.demo?.repos).toHaveLength(1);
  });
});

describe("repoIndex / projectIdFromRoot", () => {
  test("indexes canonical repo roots", () => {
    const state = emptyState();
    state.projects["a"] = makeProject("a", ["/tmp/repo"]);
    const index = repoIndex(state);
    expect(index.get("/tmp/repo")).toBe("a");
  });

  test("projectIdFromRoot slugifies", () => {
    expect(projectIdFromRoot("/work/My App!")).toBe("my-app");
    expect(projectIdFromRoot("/")).toBe("project");
  });
});

describe("normalizeRemoteUrl", () => {
  test("unifies scp and https forms", () => {
    expect(normalizeRemoteUrl("git@github.com:Octo/Widgets.git")).toBe("github.com/Octo/Widgets");
    expect(normalizeRemoteUrl("https://github.com/Octo/Widgets.git")).toBe(
      "github.com/Octo/Widgets",
    );
    expect(normalizeRemoteUrl("https://GITHUB.com/Octo/Widgets/")).toBe("github.com/Octo/Widgets");
  });
});

describe("repoRemoteIdentity", () => {
  test("returns normalized origin identity", async () => {
    const repo = initRepo(true);
    expect(await repoRemoteIdentity(repo)).toBe("github.com/Octo/Widgets");
  });

  test("returns null for repos without remotes", async () => {
    const repo = initRepo();
    expect(await repoRemoteIdentity(repo)).toBeNull();
  });
});

describe("discoverRepos", () => {
  test("discovers repos from cwds, skips non-git, marks registered", async () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    const notGit = tempDir();

    const state = emptyState();
    state.projects["existing"] = makeProject("existing", [repoA]);

    const { repos, skipped } = await discoverRepos([repoA, repoB, notGit, repoA], state);
    expect(repos).toHaveLength(2);
    const byRoot = new Map(repos.map((r) => [r.root, r]));
    expect(byRoot.get(repoA)?.registered_project_id).toBe("existing");
    expect(byRoot.get(repoB)?.registered_project_id).toBeNull();
    expect(skipped).toEqual([{ cwd: notGit, reason: "not_a_repo" }]);
  });
});
