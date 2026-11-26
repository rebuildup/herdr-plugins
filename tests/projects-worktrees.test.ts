import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const savedConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
const savedGitRoot = process.env.HERDR_PROJECTS_ROOT_GIT;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "projects-worktrees-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (savedStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir;
  if (savedConfigDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  else process.env.HERDR_PLUGIN_CONFIG_DIR = savedConfigDir;
  if (savedGitRoot === undefined) delete process.env.HERDR_PROJECTS_ROOT_GIT;
  else process.env.HERDR_PROJECTS_ROOT_GIT = savedGitRoot;
});

function useStateDir(): string {
  const dir = tempDir();
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "config");
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function initRepo(): string {
  const dir = realpathSync(tempDir());
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

function addWorktree(repo: string, name: string, branch: string): string {
  const wt = path.join(realpathSync(tempDir()), name);
  git(repo, ["worktree", "add", wt, "-b", branch]);
  return realpathSync(wt);
}

// --- Fake herdr socket -------------------------------------------------------

interface FakeWorktree {
  path: string;
  branch?: string;
  is_linked_worktree?: boolean;
  is_bare?: boolean;
  is_detached?: boolean;
  is_prunable?: boolean;
  label?: string | null;
  open_workspace_id?: string | null;
}

interface FakePane {
  pane_id: string;
  workspace_id: string;
  cwd?: string | null;
}

interface FakeHerdrOptions {
  /** worktree.list `source` override; null omits the source block. */
  sourceRepoRoot?: string | null;
  worktrees?: FakeWorktree[];
  /** worktree.list error to return instead of a result. */
  worktreeListError?: { code: string; message: string };
  panes?: FakePane[];
  /** session.snapshot error to return instead of a result. */
  snapshotError?: { code: string; message: string };
}

interface FakeHerdr {
  socketPath: string;
  close: () => Promise<void>;
}

/**
 * Minimal fake herdr socket answering only `worktree.list` and
 * `session.snapshot` — the two read methods the #184 association
 * surface uses. Everything else is an honest `unknown_method` error.
 */
async function fakeHerdr(options: FakeHerdrOptions = {}): Promise<FakeHerdr> {
  const socketPath = path.join(tempDir(), "fake-herdr.sock");
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        const message = JSON.parse(line) as {
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
        };
        const reply = (result: unknown) =>
          conn.write(`${JSON.stringify({ id: message.id, result })}\n`);
        const fail = (code: string, msg: string) =>
          conn.write(`${JSON.stringify({ id: message.id, error: { code, message: msg } })}\n`);

        switch (message.method) {
          case "worktree.list": {
            if (options.worktreeListError) {
              fail(options.worktreeListError.code, options.worktreeListError.message);
              break;
            }
            const result: Record<string, unknown> = {
              worktrees: (options.worktrees ?? []).map((wt) => ({
                path: wt.path,
                branch: wt.branch ?? null,
                is_bare: wt.is_bare ?? false,
                is_detached: wt.is_detached ?? false,
                is_linked_worktree: wt.is_linked_worktree ?? true,
                is_prunable: wt.is_prunable ?? false,
                label: wt.label ?? null,
                open_workspace_id: wt.open_workspace_id ?? null,
              })),
            };
            if (options.sourceRepoRoot !== null) {
              result.source = {
                repo_key: "fake",
                repo_name: "fake",
                repo_root: options.sourceRepoRoot ?? "",
                source_checkout_path: options.sourceRepoRoot ?? "",
                source_workspace_id: "ws-src",
              };
            }
            reply(result);
            break;
          }
          case "session.snapshot": {
            if (options.snapshotError) {
              fail(options.snapshotError.code, options.snapshotError.message);
              break;
            }
            reply({
              snapshot: {
                session: { name: "fake" },
                workspaces: [],
                tabs: [],
                panes: options.panes ?? [],
                agents: {},
              },
            });
            break;
          }
          default:
            fail("unknown_method", `fake herdr: unhandled ${String(message.method)}`);
        }
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => resolveListen());
  });
  return {
    socketPath,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

// --- Fake git plugin ---------------------------------------------------------

/**
 * A minimal `rebuildup.git` plugin root: valid manifest + a `src/cli.ts`
 * that answers `status <pane>` with a canned git-v1 payload and echoes
 * the env it was pinned with (for env-pin assertions).
 */
function fakeGitPlugin(): { root: string } {
  const root = tempDir();
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "herdr-plugin.toml"),
    'id = "rebuildup.git"\nname = "Git"\nversion = "0.0.0"\n',
  );
  const callsPath = path.join(root, "calls.jsonl");
  writeFileSync(callsPath, "");
  writeFileSync(
    path.join(root, "src", "cli.ts"),
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  args,
  plugin_id: process.env.HERDR_PLUGIN_ID ?? null,
  state_dir: process.env.HERDR_PLUGIN_STATE_DIR ?? null,
  socket_path: process.env.HERDR_SOCKET_PATH ?? null,
  ambient_pane: process.env.HERDR_PANE_ID ?? null,
  ambient_session: process.env.HERDR_SESSION ?? null,
}) + "\\n");
if (args[0] === "status") {
  const pane = args[1] ?? "?";
  process.stdout.write(JSON.stringify({
    contract: "herdr-plugins.git/v1",
    command: "status",
    pane_id: pane,
    repo: { root: ${JSON.stringify("REPO_ROOT")}, git_dir: "/g", git_common_dir: "/g", bare: false },
    branch: { name: "fake-branch", detached: false, upstream: null, ahead: null, behind: null },
    changes: { staged: 0, unstaged: 2, untracked: 1, conflicted: 0 },
  }) + "\\n");
} else {
  process.stderr.write(JSON.stringify({ contract: "herdr-plugins.git/v1", ok: false, error: { code: "error", kind: "usage", message: "fake git: unsupported" } }) + "\\n");
  process.exit(2);
}
`,
  );
  return { root };
}

function readGitCalls(root: string): Array<Record<string, unknown>> {
  try {
    const text = readFileSync(path.join(root, "calls.jsonl"), "utf8");
    return text
      .split("\n")
      .filter((l: string) => l.trim().length > 0)
      .map((l: string) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// --- CLI helpers --------------------------------------------------------------

const PLUGIN = path.join(__dirname, "..", "plugins", "projects");
const CLI = path.join(PLUGIN, "src", "cli.ts");

/** Strip every ambient HERDR_* except the two plugin dir pins (issue #199). */
function baseEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key.startsWith("HERDR_") &&
      key !== "HERDR_PLUGIN_STATE_DIR" &&
      key !== "HERDR_PLUGIN_CONFIG_DIR"
    ) {
      continue;
    }
    env[key] = value;
  }
  if (extra) Object.assign(env, extra);
  return env;
}

interface ProcResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

function runCli(args: string[], extraEnv?: Record<string, string>): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: baseEnv(extraEnv) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        /* non-JSON output */
      }
      resolve({ status: code ?? -1, stdout, stderr, json });
    });
  });
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  dirty: boolean | null;
  has_submodules: boolean | null;
  is_linked_worktree: boolean;
  open_workspace_id: string | null;
  panes: Array<{
    pane_id: string;
    workspace_id: string | null;
    cwd: string | null;
    commands: Record<string, string>;
    status: {
      contract: string;
      ok: boolean;
      repo_root: string | null;
      branch: string | null;
      detached: boolean;
      changes: { staged: number; unstaged: number; untracked: number; conflicted: number } | null;
    } | null;
    status_error: { kind: string; message: string } | null;
  }>;
  panes_unavailable: boolean;
}

interface RepoEntry {
  root: string;
  branch: string | null;
  dirty: boolean | null;
  has_submodules: boolean | null;
  worktree_submodules: string | null;
  worktrees: WorktreeEntry[] | null;
  worktrees_error: { reason: string; detail?: string } | null;
}

async function reposList(
  projectId: string,
  socketPath: string,
  extraEnv?: Record<string, string>,
): Promise<{ repos: RepoEntry[]; skipped: unknown[]; worktrees_skipped: unknown[] }> {
  const r = await runCli(
    ["repos", "list", projectId, "--socket", socketPath, "--timeout", "15000"],
    extraEnv,
  );
  if (r.status !== 0) {
    throw new Error(`repos list exited ${r.status}: ${r.stderr.slice(0, 500)}`);
  }
  expect(r.json).not.toBeNull();
  return {
    repos: r.json?.repos as RepoEntry[],
    skipped: r.json?.skipped as unknown[],
    worktrees_skipped: (r.json?.worktrees_skipped ?? []) as unknown[],
  };
}

// --- Tests ---------------------------------------------------------------------

describe("repos list worktree association (#184)", () => {
  test("open worktree resolves panes + git status; closed worktree reports path/branch/dirty only", async () => {
    const stateDir = useStateDir();
    const repo = initRepo();
    const openWt = addWorktree(repo, "wt-open", "feature-open");
    const closedWt = addWorktree(repo, "wt-closed", "feature-closed");
    // A worktree of a FOREIGN repo must never be attributed.
    const foreign = initRepo();
    const foreignWt = addWorktree(foreign, "wt-foreign", "foreign-branch");

    const fake = await fakeHerdr({
      sourceRepoRoot: repo,
      worktrees: [
        {
          path: openWt,
          branch: "feature-open",
          is_linked_worktree: true,
          label: "open",
          open_workspace_id: "ws-open",
        },
        {
          path: closedWt,
          branch: "feature-closed",
          is_linked_worktree: true,
          label: "closed",
          open_workspace_id: null,
        },
        {
          path: foreignWt,
          branch: "foreign-branch",
          is_linked_worktree: true,
          open_workspace_id: null,
        },
      ],
      panes: [
        { pane_id: "ws-open:p1", workspace_id: "ws-open", cwd: openWt },
        { pane_id: "ws-open:p2", workspace_id: "ws-open", cwd: openWt },
        { pane_id: "ws-other:p1", workspace_id: "ws-other", cwd: repo },
      ],
    });
    const gitPlugin = fakeGitPlugin();
    try {
      const reg = await runCli(["register", repo], { HERDR_PLUGIN_STATE_DIR: stateDir });
      expect(reg.status).toBe(0);
      const projectId = (reg.json?.project as { id: string }).id;

      const { repos, worktrees_skipped } = await reposList(projectId, fake.socketPath, {
        HERDR_PROJECTS_ROOT_GIT: gitPlugin.root,
      });
      expect(repos).toHaveLength(1);
      const entry = repos[0] as RepoEntry;
      expect(entry.worktrees_error).toBeNull();
      expect(entry.worktrees).not.toBeNull();
      const wts = entry.worktrees as WorktreeEntry[];
      expect(wts).toHaveLength(2);

      const open = wts.find((w) => w.path === openWt);
      expect(open).toBeDefined();
      expect(open?.branch).toBe("feature-open");
      expect(open?.is_linked_worktree).toBe(true);
      expect(open?.open_workspace_id).toBe("ws-open");
      expect(open?.panes_unavailable).toBe(false);
      expect(open?.panes.map((p) => p.pane_id)).toEqual(["ws-open:p1", "ws-open:p2"]);
      // Only panes of the OPEN workspace resolve — ws-other is excluded.
      const p1 = open?.panes[0];
      expect(p1?.commands.status).toBe("status ws-open:p1");
      expect(p1?.commands.diff).toBe("diff ws-open:p1");
      expect(p1?.status?.contract).toBe("herdr-plugins.git/v1");
      expect(p1?.status?.ok).toBe(true);
      expect(p1?.status?.branch).toBe("fake-branch");
      expect(p1?.status?.changes).toEqual({
        staged: 0,
        unstaged: 2,
        untracked: 1,
        conflicted: 0,
      });
      expect(p1?.status_error).toBeNull();

      const closed = wts.find((w) => w.path === closedWt);
      expect(closed).toBeDefined();
      expect(closed?.branch).toBe("feature-closed");
      expect(closed?.open_workspace_id).toBeNull();
      expect(closed?.panes).toEqual([]);
      // Pane-less worktree: no diff/status surface at all — nothing fabricated.
      expect(JSON.stringify(closed)).not.toContain("herdr-plugins.git/v1");

      // Foreign-repo worktree is skipped honestly, never attributed.
      expect(worktrees_skipped).toEqual([{ path: foreignWt, reason: "not_member_repo" }]);

      // Env-pin: the git child saw the GIT plugin's dirs/id/socket and no
      // ambient HERDR_* leaks (issue #199).
      const calls = readGitCalls(gitPlugin.root);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.plugin_id).toBe("rebuildup.git");
        expect(String(call.state_dir)).toContain("rebuildup.git");
        expect(call.socket_path).toBe(fake.socketPath);
        expect(call.ambient_pane).toBeNull();
        expect(call.ambient_session).toBeNull();
      }
    } finally {
      await fake.close();
    }
  }, 60_000);

  test("unreachable herdr socket → worktrees null + session_unreachable, live fields intact", async () => {
    const stateDir = useStateDir();
    const repo = initRepo();
    const deadSocket = path.join(tempDir(), "no-such.sock");
    const reg = await runCli(["register", repo], { HERDR_PLUGIN_STATE_DIR: stateDir });
    expect(reg.status).toBe(0);
    const projectId = (reg.json?.project as { id: string }).id;

    const { repos } = await reposList(projectId, deadSocket);
    const entry = repos[0] as RepoEntry;
    // Git-side live inspection still works offline.
    expect(entry.branch).toBe("main");
    expect(entry.dirty).toBe(false);
    expect(entry.worktrees).toBeNull();
    expect(entry.worktrees_error?.reason).toBe("session_unreachable");
  }, 60_000);

  test("worktree.list RPC error and source repo mismatch degrade honestly", async () => {
    const stateDir = useStateDir();
    const repo = initRepo();
    const wt = addWorktree(repo, "wt", "feature");

    // RPC error path (e.g. untrusted repo): error reason is the RPC code.
    const errFake = await fakeHerdr({
      worktreeListError: { code: "repo_untrusted", message: "repository not trusted" },
    });
    try {
      const reg = await runCli(["register", repo], { HERDR_PLUGIN_STATE_DIR: stateDir });
      const projectId = (reg.json?.project as { id: string }).id;
      const { repos } = await reposList(projectId, errFake.socketPath);
      const entry = repos[0] as RepoEntry;
      expect(entry.worktrees).toBeNull();
      expect(entry.worktrees_error?.reason).toBe("repo_untrusted");
    } finally {
      await errFake.close();
    }

    // Source mismatch: herdr resolved a different repo → skipped, not guessed.
    const mismatchFake = await fakeHerdr({
      sourceRepoRoot: initRepo(),
      worktrees: [{ path: wt, open_workspace_id: null }],
    });
    try {
      const { repos } = await reposList(await projectIdOf(stateDir), mismatchFake.socketPath);
      const entry = repos[0] as RepoEntry;
      expect(entry.worktrees).toBeNull();
      expect(entry.worktrees_error?.reason).toBe("repo_mismatch");
    } finally {
      await mismatchFake.close();
    }
  }, 60_000);

  test("git plugin unavailable → pane pointers kept, status_error plugin_unavailable", async () => {
    const stateDir = useStateDir();
    const repo = initRepo();
    const wt = addWorktree(repo, "wt", "feature");
    const fake = await fakeHerdr({
      sourceRepoRoot: repo,
      worktrees: [{ path: wt, open_workspace_id: "ws-1" }],
      panes: [{ pane_id: "ws-1:p1", workspace_id: "ws-1", cwd: wt }],
    });
    try {
      const reg = await runCli(["register", repo], { HERDR_PLUGIN_STATE_DIR: stateDir });
      const projectId = (reg.json?.project as { id: string }).id;
      const { repos } = await reposList(projectId, fake.socketPath, {
        HERDR_PROJECTS_ROOT_GIT: path.join(tempDir(), "does-not-exist"),
      });
      const wtEntry = (repos[0] as RepoEntry).worktrees?.[0];
      expect(wtEntry?.panes).toHaveLength(1);
      const pane = wtEntry?.panes[0];
      expect(pane?.commands.status).toBe("status ws-1:p1");
      expect(pane?.status).toBeNull();
      expect(pane?.status_error?.kind).toBe("plugin_unavailable");
    } finally {
      await fake.close();
    }
  }, 60_000);

  test("stale open_workspace_id → panes_unavailable, no fabricated pointers", async () => {
    const stateDir = useStateDir();
    const repo = initRepo();
    const wt = addWorktree(repo, "wt", "feature");
    const fake = await fakeHerdr({
      sourceRepoRoot: repo,
      worktrees: [{ path: wt, open_workspace_id: "ws-gone" }],
      panes: [], // snapshot alive but workspace has no panes
    });
    try {
      const reg = await runCli(["register", repo], { HERDR_PLUGIN_STATE_DIR: stateDir });
      const projectId = (reg.json?.project as { id: string }).id;
      const { repos } = await reposList(projectId, fake.socketPath);
      const wtEntry = (repos[0] as RepoEntry).worktrees?.[0];
      expect(wtEntry?.open_workspace_id).toBe("ws-gone");
      expect(wtEntry?.panes).toEqual([]);
      expect(wtEntry?.panes_unavailable).toBe(true);
    } finally {
      await fake.close();
    }
  }, 60_000);

  test("worktree_submodules advisory comes from t3.json", async () => {
    const stateDir = useStateDir();
    const repo = initRepo();
    writeFileSync(path.join(repo, "t3.json"), JSON.stringify({ worktreeSubmodules: "recursive" }));
    const fake = await fakeHerdr({ sourceRepoRoot: repo, worktrees: [] });
    try {
      const reg = await runCli(["register", repo], { HERDR_PLUGIN_STATE_DIR: stateDir });
      const projectId = (reg.json?.project as { id: string }).id;
      const { repos } = await reposList(projectId, fake.socketPath);
      const entry = repos[0] as RepoEntry;
      expect(entry.worktree_submodules).toBe("recursive");
      expect(entry.worktrees).toEqual([]);
    } finally {
      await fake.close();
    }
  }, 60_000);
});

/** Look up the project id registered earlier in the same state dir. */
async function projectIdOf(_stateDir: string): Promise<string> {
  const list = await runCli(["list"]);
  const projects = list.json?.projects as Array<{ id: string }>;
  const id = projects[0]?.id;
  if (!id) throw new Error("no project registered");
  return id;
}
