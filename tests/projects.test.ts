import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeRemoteUrl, repoRemoteIdentity } from "../packages/git-core/src/index";
import {
  discoverRepos,
  inspectRepo,
  projectIdFromRoot,
  repoIndex,
} from "../plugins/projects/src/model";
import {
  emptyState,
  loadSettings,
  loadState,
  type Project,
  SETTINGS_ALLOW_LIST,
  updateSettings,
  updateState,
} from "../plugins/projects/src/state";

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

  test("keeps non-default ports and preserves path case", () => {
    // Two self-hosted instances on one host must not collapse into one
    // identity; default ports normalize away via URL parsing.
    expect(normalizeRemoteUrl("https://git.example.com:8443/Org/Repo.git")).toBe(
      "git.example.com:8443/Org/Repo",
    );
    expect(normalizeRemoteUrl("https://git.example.com:443/Org/Repo")).toBe(
      "git.example.com/Org/Repo",
    );
    // ssh:// URLs go through URL parsing — the scp-like branch must not
    // misread `host:2222` as an scp path separator.
    expect(normalizeRemoteUrl("ssh://git@git.example.com:2222/Org/Repo.git")).toBe(
      "git.example.com:2222/Org/Repo",
    );
    // Path case is preserved verbatim (case-sensitive forges exist);
    // only host casing is normalized.
    expect(normalizeRemoteUrl("git@github.com:Octo/Widgets.git")).toBe("github.com/Octo/Widgets");
    expect(normalizeRemoteUrl("https://github.com/octo/widgets")).toBe("github.com/octo/widgets");
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

describe("settings store", () => {
  test("updateSettings round-trips per project", async () => {
    useStateDir();
    await updateSettings("p1", (s) => {
      s["display.title"] = "One";
    });
    await updateSettings("p2", (s) => {
      s["display.title"] = "Two";
    });
    expect(await loadSettings("p1")).toEqual({ "display.title": "One" });
    expect(await loadSettings("p2")).toEqual({ "display.title": "Two" });
    expect(await loadSettings("missing")).toEqual({});
  });

  test("corrupt settings file reads as empty", async () => {
    useStateDir();
    const { mkdirSync, writeFileSync: wf } = await import("node:fs");
    const { settingsFilePath } = await import("../plugins/projects/src/state");
    mkdirSync(path.dirname(settingsFilePath("p")), { recursive: true });
    wf(settingsFilePath("p"), "{not json");
    expect(await loadSettings("p")).toEqual({});
  });
});

// --- CLI-level contract tests ---------------------------------------------

const CLI = path.join(__dirname, "..", "plugins", "projects", "src", "cli.ts");

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 15_000,
  });
  let json: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    /* usage output */
  }
  try {
    error = (JSON.parse(result.stderr) as { error?: Record<string, unknown> }).error ?? null;
  } catch {
    /* empty stderr */
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, json, error };
}

function expectOk(r: CliResult): Record<string, unknown> {
  expect(r.status).toBe(0);
  expect(r.json).not.toBeNull();
  return r.json as Record<string, unknown>;
}

function expectErr(r: CliResult, kind?: string): Record<string, unknown> {
  expect(r.status).toBe(1);
  expect(r.error).not.toBeNull();
  if (kind) expect(r.error?.kind).toBe(kind);
  return r.error as Record<string, unknown>;
}

describe("cli mutations", () => {
  test("register/list/show round-trip with derived id", () => {
    useStateDir();
    const repo = initRepo();
    const reg = expectOk(runCli(["register", repo]));
    const project = reg.project as Project;
    expect(project.id).toBe(
      path
        .basename(repo)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-"),
    );
    expect(project.repos[0]?.root).toBe(realpathSync(repo));

    const list = expectOk(runCli(["list"])).projects as Project[];
    expect(list.map((p) => p.id)).toContain(project.id);
    const show = expectOk(runCli(["show", project.id])).project as Project;
    expect(show.title).toBe(project.title);
  });

  test("register rejects duplicate repo root and duplicate explicit id", () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    expectOk(runCli(["register", repoA, "--id", "dup"]));
    expectErr(runCli(["register", repoA]), "repo_already_registered");
    expectErr(runCli(["register", repoB, "--id", "dup"]), "project_exists");
    // A nonexistent path surfaces as a structured git error, not a crash.
    const missing = runCli(["register", repoA.replace(/[^/]+$/, "other")]);
    expect(missing.status).toBe(1);
  });

  test("update title/pin/archive and repo add/remove", () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    const reg = expectOk(runCli(["register", repoA, "--title", "First"]));
    const id = (reg.project as Project).id;

    const upd = expectOk(
      runCli(["update", id, "--title", "Renamed", "--pinned", "--repo-add", repoB]),
    ).project as Project;
    expect(upd.title).toBe("Renamed");
    expect(upd.pinned).toBe(true);
    expect(upd.repos).toHaveLength(2);

    const rm = expectOk(runCli(["update", id, "--repo-remove", repoB])).project as Project;
    expect(rm.repos).toHaveLength(1);
    expectErr(runCli(["update", id, "--repo-remove", repoB]), "repo_not_found");

    // Repo registered to another project cannot be stolen.
    const other = expectOk(runCli(["register", repoB, "--id", "other"])).project as Project;
    expect(other.id).toBe("other");
    expectErr(runCli(["update", id, "--repo-add", repoB]), "repo_already_registered");
  });

  test("archive hides from list unless --all; unarchive restores", () => {
    useStateDir();
    const repo = initRepo();
    const id = (expectOk(runCli(["register", repo])).project as Project).id;

    expectOk(runCli(["pin", id]));
    expect((expectOk(runCli(["list"])).projects as Project[])[0]?.pinned).toBe(true);
    expectOk(runCli(["unpin", id]));

    expectOk(runCli(["archive", id]));
    expect(expectOk(runCli(["list"])).projects as Project[]).toHaveLength(0);
    const all = expectOk(runCli(["list", "--all"])).projects as Project[];
    expect(all[0]?.archived).toBe(true);
    // Archived state is preserved, not deleted.
    expect((expectOk(runCli(["show", id])).project as Project).archived).toBe(true);

    expectOk(runCli(["unarchive", id]));
    expect(expectOk(runCli(["list"])).projects as Project[]).toHaveLength(1);
    expectErr(runCli(["pin", "nope"]), "project_not_found");
  });

  test("settings set/get/unset with allow-list enforcement", () => {
    useStateDir();
    const repo = initRepo();
    const id = (expectOk(runCli(["register", repo])).project as Project).id;

    const set = expectOk(
      runCli(["settings", "set", id, "defaultProjectScripts", '["dev","test"]']),
    );
    expect((set.settings as Record<string, string>)["defaultProjectScripts"]).toBe(
      '["dev","test"]',
    );

    const one = expectOk(runCli(["settings", "get", id, "defaultProjectScripts"]));
    expect(one.value).toBe('["dev","test"]');
    const all = expectOk(runCli(["settings", "get", id])).settings as Record<string, string>;
    expect(all["display.iconPath"]).toBeUndefined();

    expectErr(runCli(["settings", "set", id, "evil.key", "x"]), "settings_key_not_allowed");
    expectErr(runCli(["settings", "set", "ghost", "display.title", "x"]), "project_not_found");

    expectOk(runCli(["settings", "unset", id, "defaultProjectScripts"]));
    const after = expectOk(runCli(["settings", "get", id, "defaultProjectScripts"]));
    expect(after.value).toBeNull();
    expect(SETTINGS_ALLOW_LIST.has("display.title")).toBe(true);
  });

  test("register rejects non-git path and invalid id", () => {
    useStateDir();
    const notGit = tempDir();
    expectErr(runCli(["register", notGit]), "not_a_repo");
    const repo = initRepo();
    expect(runCli(["register", repo, "--id", "Bad ID!"]).status).toBe(2);
  });
});

// --- repos membership / listing (#51) --------------------------------------

interface RepoListEntry {
  root: string;
  remote: string | null;
  added_at: string;
  branch: string | null;
  dirty: boolean | null;
  has_submodules: boolean | null;
}

function reposList(projectId: string): { repos: RepoListEntry[]; skipped: unknown[] } {
  const r = expectOk(runCli(["repos", "list", projectId]));
  return { repos: r.repos as RepoListEntry[], skipped: r.skipped as unknown[] };
}

describe("repos add/remove/list", () => {
  test("add/remove round-trip with live branch/dirty/submodule fields", () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    const id = (expectOk(runCli(["register", repoA])).project as Project).id;

    const added = expectOk(runCli(["repos", "add", id, "--path", repoB])).project as Project;
    expect(added.repos).toHaveLength(2);
    // Adding the same root again is a no-op, matching update --repo-add.
    const again = expectOk(runCli(["repos", "add", id, "--path", repoB])).project as Project;
    expect(again.repos).toHaveLength(2);

    let list = reposList(id);
    expect(list.repos).toHaveLength(2);
    const entryA = list.repos.find((r) => r.root === realpathSync(repoA));
    expect(entryA?.branch).toBe("main");
    expect(entryA?.dirty).toBe(false);
    expect(entryA?.has_submodules).toBe(false);
    expect(list.skipped).toEqual([]);

    // Dirty flag tracks working-tree changes.
    writeFileSync(path.join(repoA, "a.txt"), "changed\n");
    list = reposList(id);
    expect(list.repos.find((r) => r.root === realpathSync(repoA))?.dirty).toBe(true);
    git(repoA, ["checkout", "--", "a.txt"]);

    const removed = expectOk(runCli(["repos", "remove", id, "--path", repoB])).project as Project;
    expect(removed.repos).toHaveLength(1);
    expectErr(runCli(["repos", "remove", id, "--path", repoB]), "repo_not_found");
    expectErr(runCli(["repos", "list", "ghost"]), "project_not_found");
    // Missing --path / project is a usage error (exit 2).
    expect(runCli(["repos", "add", id]).status).toBe(2);
    expect(runCli(["repos", "list"]).status).toBe(2);
  });

  test("repos add rejects non-git paths and cross-project ownership", () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    const idA = (expectOk(runCli(["register", repoA, "--id", "a"])).project as Project).id;
    const idB = (expectOk(runCli(["register", repoB, "--id", "b"])).project as Project).id;

    expectErr(runCli(["repos", "add", idA, "--path", tempDir()]), "not_a_repo");
    expectErr(runCli(["repos", "add", idA, "--path", repoB]), "repo_already_registered");
    expectErr(runCli(["repos", "add", "ghost", "--path", repoA]), "project_not_found");
    expect(idB).toBe("b");
  });

  test("unreachable member repo is skipped, never fabricated", () => {
    useStateDir();
    const repo = initRepo();
    const root = realpathSync(repo);
    const id = (expectOk(runCli(["register", repo])).project as Project).id;
    rmSync(root, { recursive: true, force: true });

    const { repos, skipped } = reposList(id);
    expect(repos).toHaveLength(1);
    expect(repos[0]?.root).toBe(root);
    expect(repos[0]?.branch).toBeNull();
    expect(repos[0]?.dirty).toBeNull();
    expect(repos[0]?.has_submodules).toBeNull();
    expect(skipped).toHaveLength(1);
    expect((skipped[0] as { root: string }).root).toBe(root);
  });
});

describe("repository identity grouping (#51)", () => {
  test("scp/https/case/.git remote spellings unify to one identity", () => {
    useStateDir();
    const repoA = initRepo();
    git(repoA, ["remote", "add", "origin", "git@github.com:Octo/Widgets.git"]);
    const repoB = initRepo();
    git(repoB, ["remote", "add", "origin", "https://GITHUB.com/Octo/Widgets"]);

    const id = (expectOk(runCli(["register", repoA])).project as Project).id;
    const added = expectOk(runCli(["repos", "add", id, "--path", repoB])).project as Project;
    const remotes = added.repos.map((r) => r.remote);
    expect(remotes).toEqual(["github.com/Octo/Widgets", "github.com/Octo/Widgets"]);

    const { repos } = reposList(id);
    expect(repos.map((r) => r.remote)).toEqual([
      "github.com/Octo/Widgets",
      "github.com/Octo/Widgets",
    ]);
  });

  test("linked worktree checkout joins the same project with shared identity", () => {
    useStateDir();
    const repo = initRepo();
    git(repo, ["remote", "add", "origin", "git@github.com:Octo/Widgets.git"]);
    const wt = path.join(tempDir(), "wt");
    git(repo, ["worktree", "add", wt, "-b", "feature"]);

    const id = (expectOk(runCli(["register", repo])).project as Project).id;
    const added = expectOk(runCli(["repos", "add", id, "--path", wt])).project as Project;
    expect(added.repos).toHaveLength(2);
    expect(new Set(added.repos.map((r) => r.remote)).size).toBe(1);
    expect(added.repos.map((r) => r.root).sort()).toEqual(
      [realpathSync(repo), realpathSync(wt)].sort(),
    );

    const { repos } = reposList(id);
    const wtEntry = repos.find((r) => r.root === realpathSync(wt));
    expect(wtEntry?.branch).toBe("feature");
  });

  test("same-name repos and non-git folders stay isolated", () => {
    useStateDir();
    // Two unrelated repos sharing a basename get distinct projects.
    const parentA = tempDir();
    const parentB = tempDir();
    const repoA = path.join(parentA, "app");
    const repoB = path.join(parentB, "app");
    for (const dir of [repoA, repoB]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const dir of [repoA, repoB]) {
      git(dir, ["init", "-b", "main"]);
      git(dir, ["config", "user.email", "t@t"]);
      git(dir, ["config", "user.name", "t"]);
      writeFileSync(path.join(dir, "a.txt"), "x\n");
      git(dir, ["add", "a.txt"]);
      git(dir, ["commit", "-qm", "init"]);
    }
    // A plain external folder must not be absorbed into either project.
    const external = tempDir();

    const idA = (expectOk(runCli(["register", repoA])).project as Project).id;
    const idB = (expectOk(runCli(["register", repoB])).project as Project).id;
    expect(idA).not.toBe(idB);

    expectErr(runCli(["repos", "add", idA, "--path", external]), "not_a_repo");
    expectErr(runCli(["repos", "add", idA, "--path", repoB]), "repo_already_registered");

    expect(reposList(idA).repos).toHaveLength(1);
    expect(reposList(idB).repos).toHaveLength(1);
    const { repos: reposA } = reposList(idA);
    expect(reposA[0]?.remote).toBeNull(); // no remote: identity falls back to root
  });
});

describe("submodule detection", () => {
  test("inspectRepo reports has_submodules and dirty state", async () => {
    const sub = initRepo();
    const superRepo = initRepo();
    git(superRepo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"]);
    git(superRepo, ["commit", "-qm", "add submodule"]);

    const info = await inspectRepo(realpathSync(superRepo));
    expect(info.has_submodules).toBe(true);
    expect(info.branch).toBe("main");
    expect(info.dirty).toBe(false);

    const plain = await inspectRepo(realpathSync(initRepo()));
    expect(plain.has_submodules).toBe(false);
  });

  test("inspectRepo reports has_submodules null when the probe fails", async () => {
    const repo = initRepo();
    // Shim `git` so only `submodule` invocations fail; rev-parse/status
    // still succeed, isolating the best-effort probe.
    const shimDir = tempDir();
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      path.join(shimDir, "git"),
      `#!/bin/sh\nif [ "$1" = "submodule" ]; then exit 1; fi\nexec ${realGit} "$@"\n`,
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${savedPath ?? ""}`;
    try {
      const info = await inspectRepo(realpathSync(repo));
      expect(info.branch).toBe("main");
      expect(info.dirty).toBe(false);
      expect(info.has_submodules).toBeNull();
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
