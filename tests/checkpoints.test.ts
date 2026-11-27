import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { herdrSocketEndpoint, normalizePath, testEnv } from "./helpers/test-env";

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const savedConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "checkpoints-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (savedStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir;
  if (savedConfigDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  else process.env.HERDR_PLUGIN_CONFIG_DIR = savedConfigDir;
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
  writeFileSync(path.join(dir, ".gitignore"), "ignored.log\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

const CLI = path.join(__dirname, "..", "plugins", "checkpoints", "src", "cli.ts");

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

// A guaranteed-nonexistent socket path: every CLI spawn gets
// HERDR_SOCKET_PATH pointed here unless a test overrides it, so pane
// resolution can never reach the developer's live herdr session.
const DEAD_SOCKET = path.join(tempDir(), "no-such-herdr.sock");

function cliEnv(extra?: Record<string, string>): Record<string, string> {
  // Plugin dirs are the explicit opt-in channel: tests set them on
  // process.env per-case; everything else HERDR_* stays scrubbed (#199).
  return testEnv({
    HERDR_PLUGIN_STATE_DIR: process.env.HERDR_PLUGIN_STATE_DIR,
    HERDR_PLUGIN_CONFIG_DIR: process.env.HERDR_PLUGIN_CONFIG_DIR,
    HERDR_SOCKET_PATH: DEAD_SOCKET,
    ...extra,
  });
}

function parseCliOutput(stdout: string, stderr: string, status: number): CliResult {
  let json: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    /* usage output */
  }
  try {
    error = (JSON.parse(stderr) as { error?: Record<string, unknown> }).error ?? null;
  } catch {
    /* empty stderr */
  }
  return { status, stdout, stderr, json, error };
}

function runCli(args: string[], extraEnv?: Record<string, string>): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: cliEnv(extraEnv),
    timeout: 30_000,
  });
  return parseCliOutput(result.stdout, result.stderr, result.status ?? -1);
}

/**
 * Async variant for tests that run a fake herdr socket: spawnSync would
 * block the event loop and the fake server could never answer.
 */
function runCliAsync(args: string[], extraEnv?: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: cliEnv(extraEnv),
    });
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
      resolve(parseCliOutput(stdout, stderr, code ?? -1));
    });
  });
}

interface FakePane {
  pane_id: string;
  cwd?: string;
}

/**
 * Minimal fake herdr socket speaking the newline-JSON protocol: answers
 * `session.snapshot` with the given (live-mutated) pane list, `{}` for
 * everything else. `panes` is read per request so tests can mutate it.
 */
async function fakeHerdrSocket(
  panes: FakePane[],
): Promise<{ socketPath: string; close: () => Promise<void> }> {
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
        const message = JSON.parse(line) as { id?: string; method?: string };
        const result = message.method === "session.snapshot" ? { snapshot: { panes } } : {};
        conn.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(herdrSocketEndpoint(socketPath), () => resolveListen());
  });
  return {
    socketPath,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
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

function useStateDir(): string {
  const dir = tempDir();
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "config");
  return dir;
}

function checkpointOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.checkpoint as Record<string, unknown>;
}

function dirtyWorktree(repo: string): void {
  // unstaged modification + staged addition + untracked + ignored file
  writeFileSync(path.join(repo, "a.txt"), "one\nmodified\n");
  writeFileSync(path.join(repo, "staged.txt"), "staged content\n");
  git(repo, ["add", "staged.txt"]);
  writeFileSync(path.join(repo, "untracked.txt"), "untracked content\n");
  writeFileSync(path.join(repo, "ignored.log"), "ignored\n");
}

// Each CLI spawn pays a Bun startup cost; multi-command tests need more
// than the 5s default.
const t = (name: string, fn: () => void | Promise<void>) => test(name, fn, 30_000);

describe("checkpoints cli", () => {
  t("capability advertises the v1 contract", () => {
    useStateDir();
    const payload = expectOk(runCli(["capability"]));
    expect(payload.contract).toBe("herdr-plugins.checkpoints/v1");
    expect(payload.plugin).toBe("rebuildup.checkpoints");
    expect(payload.commands).toContain("create");
    expect(payload.mutation_commands).toEqual([
      "create",
      "save",
      "delete",
      "restore",
      "restore-group",
      "gc",
      "prune",
    ]);
  });

  t("create requires a repo target", () => {
    useStateDir();
    const r = runCli(["create"]);
    expect(r.status).toBe(2);
  });

  t("create captures worktree state without touching the user index", () => {
    useStateDir();
    const repo = initRepo();
    dirtyWorktree(repo);
    const statusBefore = git(repo, ["status", "--porcelain"]);
    const cachedBefore = git(repo, ["diff", "--cached", "--name-only"]);

    const payload = expectOk(runCli(["create", "--repo", repo, "--label", "wip"]));
    const ckpt = checkpointOf(payload);
    expect(typeof ckpt.id).toBe("string");
    expect(normalizePath(String(ckpt.repo_root))).toBe(normalizePath(repo));
    expect(ckpt.branch).toBe("main");
    expect(ckpt.label).toBe("wip");
    expect(String(ckpt.ref)).toMatch(/^refs\/herdr-plugins\/checkpoints\/[0-9a-f]{16}\/.+/);

    // The hidden ref resolves to a real commit whose tree holds the
    // captured worktree state — including the untracked file.
    const commit = String(ckpt.commit);
    const tree = git(repo, ["ls-tree", "-r", "--name-only", commit]);
    expect(tree).toContain("untracked.txt");
    expect(tree).toContain("staged.txt");
    expect(tree).not.toContain("ignored.log");
    const blob = git(repo, ["show", `${commit}:untracked.txt`]);
    expect(blob).toBe("untracked content\n");

    // User-visible state is byte-identical: porcelain status, staged
    // diff, and the real index file are untouched.
    expect(git(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe(cachedBefore);
    expect(statusBefore).toContain("staged.txt");
    expect(statusBefore).toContain("untracked.txt");
  });

  t("list/show/delete round-trip", () => {
    useStateDir();
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "changed\n");

    const created = expectOk(runCli(["create", "--repo", repo]));
    const id = String(checkpointOf(created).id);

    const list = expectOk(runCli(["list", "--repo", repo]));
    expect(list.count).toBe(1);
    const entries = list.checkpoints as Record<string, unknown>[];
    expect(entries[0]?.id).toBe(id);

    const shown = expectOk(runCli(["show", id]));
    const ref = shown.ref as Record<string, unknown>;
    expect(ref.exists).toBe(true);
    expect(ref.oid).toBe(checkpointOf(created).commit);
    const summary = shown.summary as Record<string, unknown>;
    expect(String(summary.output)).toContain("a.txt");

    const deleted = expectOk(runCli(["delete", id]));
    expect(deleted.ref_existed).toBe(true);
    // The ref itself is gone.
    const refs = git(repo, ["for-each-ref", "refs/herdr-plugins/checkpoints"]);
    expect(refs.trim()).toBe("");

    const after = expectOk(runCli(["list", "--repo", repo]));
    expect(after.count).toBe(0);
    // State entry is gone: a second delete is an honest unknown id.
    const again = runCli(["delete", id]);
    expectErr(again, "unknown_checkpoint");
    const showGone = runCli(["show", id]);
    expectErr(showGone, "unknown_checkpoint");
  });

  t("diff between two checkpoints and against HEAD", () => {
    useStateDir();
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    const first = expectOk(runCli(["create", "--repo", repo]));
    const idA = String(checkpointOf(first).id);

    writeFileSync(path.join(repo, "a.txt"), "v2\n");
    writeFileSync(path.join(repo, "b.txt"), "new file\n");
    const second = expectOk(runCli(["create", "--repo", repo]));
    const idB = String(checkpointOf(second).id);

    const both = expectOk(runCli(["diff", idA, idB]));
    const patchAB = String(both.patch);
    expect(patchAB).toContain("a.txt");
    expect(patchAB).toContain("b.txt");
    expect(patchAB).toContain("+v2");
    expect(both.truncated).toBe(false);

    // diff idA HEAD: HEAD still points at the original commit, so the
    // patch shows the same captured delta reversed direction-wise.
    const vsHead = expectOk(runCli(["diff", idA, "HEAD"]));
    expect(String(vsHead.patch)).toContain("a.txt");
    expect((vsHead.a as Record<string, unknown>).kind).toBe("checkpoint");
    expect((vsHead.b as Record<string, unknown>).kind).toBe("head");

    // Reverse order diffs the other way.
    const reversed = expectOk(runCli(["diff", idB, idA]));
    expect(String(reversed.patch)).toContain("-v2");
  });

  t("state persists on disk under HERDR_PLUGIN_STATE_DIR", () => {
    const stateDir = useStateDir();
    const repo = initRepo();
    writeFileSync(path.join(repo, "x.txt"), "x\n");
    const created = expectOk(runCli(["create", "--repo", repo]));
    const id = String(checkpointOf(created).id);

    const file = path.join(stateDir, "state.json");
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      checkpoints: Record<string, Record<string, unknown>>;
    };
    expect(raw.version).toBe(1);
    const entry = raw.checkpoints[id];
    expect(entry).toBeDefined();
    expect(entry?.repo_key).toMatch(/^[0-9a-f]{16}$/);
    expect(entry?.head_sha).toBe(git(repo, ["rev-parse", "HEAD"]).trim());
    expect(String(entry?.ref)).toContain(`/${id}`);
  });

  t("rejects non-repo and bare repo targets", () => {
    useStateDir();
    const plain = tempDir();
    const notRepo = runCli(["create", "--repo", plain]);
    expectErr(notRepo, "not_a_repo");

    const bare = path.join(tempDir(), "bare.git");
    spawnSync("git", ["init", "--bare", "-q", bare], { env: testEnv() });
    const bareResult = runCli(["create", "--repo", bare]);
    expectErr(bareResult, "bare_repo");
  });

  t("unborn HEAD repo reports empty_repo", () => {
    useStateDir();
    const repo = realpathSync(tempDir());
    git(repo, ["init", "-b", "main"]);
    writeFileSync(path.join(repo, "a.txt"), "one\n");
    const r = runCli(["create", "--repo", repo]);
    expectErr(r, "empty_repo");
  });

  t("list without --repo aggregates all repos", () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    writeFileSync(path.join(repoA, "a.txt"), "a\n");
    writeFileSync(path.join(repoB, "b.txt"), "b\n");
    expectOk(runCli(["create", "--repo", repoA]));
    expectOk(runCli(["create", "--repo", repoB]));

    const all = expectOk(runCli(["list"]));
    expect(all.total).toBe(2);
    const filtered = expectOk(runCli(["list", "--repo", repoA]));
    expect(filtered.total).toBe(1);
  });

  t("diff rejects unknown ids and cross-repo pairs", () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    writeFileSync(path.join(repoA, "a.txt"), "a\n");
    writeFileSync(path.join(repoB, "b.txt"), "b\n");
    const a = expectOk(runCli(["create", "--repo", repoA]));
    const b = expectOk(runCli(["create", "--repo", repoB]));
    const idA = String(checkpointOf(a).id);
    const idB = String(checkpointOf(b).id);

    expectErr(runCli(["diff", idA, "nope"]), "unknown_checkpoint");
    expectErr(runCli(["diff", idA, idB]), "cross_repo");
    // HEAD vs HEAD is a usage error (exit 2), not a handled failure.
    expect(runCli(["diff", "HEAD", "HEAD"]).status).toBe(2);
  });

  t("plan reports files-to-change and untracked-to-delete without mutating", () => {
    useStateDir();
    const repo = initRepo();
    // Checkpoint the "one\n" state plus an untracked file.
    writeFileSync(path.join(repo, "keep.txt"), "keep me\n");
    const created = expectOk(runCli(["create", "--repo", repo]));
    const id = String(checkpointOf(created).id);
    const statusBefore = git(repo, ["status", "--porcelain"]);

    // Dirty the worktree: modify tracked, add untracked, stage a file.
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    writeFileSync(path.join(repo, "extra.txt"), "extra\n");
    writeFileSync(path.join(repo, "staged.txt"), "staged\n");
    git(repo, ["add", "staged.txt"]);

    const planned = expectOk(runCli(["plan", id]));
    const plan = planned.plan as Record<string, unknown>;
    // a.txt differs worktree-side; staged.txt is tracked in the index;
    // keep.txt is in the checkpoint but missing from the real index, so
    // --staged restore would add it — all three count as changes.
    // Untracked extra.txt is a delete, not a change.
    expect(plan.files_to_change).toBe(3);
    expect(plan.untracked_to_delete).toBe(1);
    expect(plan.already_matches).toBe(false);
    expect((planned.ref as Record<string, unknown>).exists).toBe(true);
    // plan is read-only: worktree untouched.
    expect(git(repo, ["status", "--porcelain"])).not.toBe(statusBefore);
    expect(readFileSync(path.join(repo, "extra.txt"), "utf8")).toBe("extra\n");

    // Unknown id and usage errors.
    expectErr(runCli(["plan", "nope"]), "unknown_checkpoint");
    expect(runCli(["plan"]).status).toBe(2);
  });

  t("restore round-trips worktree+index and always captures pre-restore", () => {
    useStateDir();
    const repo = initRepo();
    // Capture state S1: a.txt modified, untracked u1.txt present.
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    writeFileSync(path.join(repo, "u1.txt"), "untracked-one\n");
    const s1 = expectOk(runCli(["create", "--repo", repo]));
    const idS1 = String(checkpointOf(s1).id);

    // Move to state S2: different content + new untracked + staged file.
    writeFileSync(path.join(repo, "a.txt"), "v2-dirty\n");
    writeFileSync(path.join(repo, "u2.txt"), "untracked-two\n");
    writeFileSync(path.join(repo, "staged.txt"), "staged\n");
    git(repo, ["add", "staged.txt"]);
    writeFileSync(path.join(repo, "ignored.log"), "ignored\n");

    // Dead socket => session unreachable; --force is required.
    const refused = runCli(["restore", idS1]);
    expectErr(refused, "session_unreachable");

    const restored = expectOk(runCli(["restore", idS1, "--force"]));
    expect(restored.ok).toBe(true);
    expect(restored.isolation).toBe("forced");
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v1\n");
    expect(readFileSync(path.join(repo, "u1.txt"), "utf8")).toBe("untracked-one\n");
    // Post-checkpoint untracked files are deleted; staged additions too
    // (they were never in the checkpoint tree).
    expect(existsSync(path.join(repo, "u2.txt"))).toBe(false);
    expect(existsSync(path.join(repo, "staged.txt"))).toBe(false);
    // Ignored files survive: clean -fd does not pass -x, and the
    // checkpoint never captured them either.
    expect(readFileSync(path.join(repo, "ignored.log"), "utf8")).toBe("ignored\n");
    // Worktree+index now equal the checkpoint commit exactly.
    const commit = String(checkpointOf(s1).commit);
    expect(
      spawnSync("git", ["diff", "--quiet", commit, "--", "."], { cwd: repo, env: testEnv() })
        .status,
    ).toBe(0);
    expect(
      spawnSync("git", ["diff", "--cached", "--quiet", commit, "--", "."], {
        cwd: repo,
        env: testEnv(),
      }).status,
    ).toBe(0);

    // The mandatory pre-restore checkpoint captured S2 and is persisted.
    const pre = restored.pre_restore as Record<string, unknown>;
    expect(typeof pre.id).toBe("string");
    expect(pre.label).toBe(`pre-restore:${idS1}`);
    const preBlob = git(repo, ["show", `${String(pre.commit)}:a.txt`]);
    expect(preBlob).toBe("v2-dirty\n");
    const list = expectOk(runCli(["list", "--repo", repo]));
    expect(list.total).toBe(2);

    // Restoring the pre-restore checkpoint returns to S2 (recoverable).
    const back = expectOk(runCli(["restore", String(pre.id), "--force"]));
    expect(back.ok).toBe(true);
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v2-dirty\n");
    expect(existsSync(path.join(repo, "u2.txt"))).toBe(true);
    // Its own pre-restore backup exists too — restores always chain.
    expect((back.pre_restore as Record<string, unknown>).id).not.toBe(pre.id);
  });

  t("restore deletes tracked paths absent from the checkpoint", () => {
    useStateDir();
    const repo = initRepo();
    // Delete a tracked file, then capture: the checkpoint tree lacks it.
    rmSync(path.join(repo, "a.txt"));
    const created = expectOk(runCli(["create", "--repo", repo]));
    const id = String(checkpointOf(created).id);

    // Resurrect a.txt as a dirty modification, then restore.
    writeFileSync(path.join(repo, "a.txt"), "resurrected\n");
    const restored = expectOk(runCli(["restore", id, "--force"]));
    expect(restored.ok).toBe(true);
    expect(existsSync(path.join(repo, "a.txt"))).toBe(false);
    // Worktree+index match the checkpoint tree (a.txt absent); vs HEAD
    // this correctly reads as a staged deletion — the checkpoint state.
    const commit = String(checkpointOf(created).commit);
    expect(
      spawnSync("git", ["diff", "--quiet", commit, "--", "."], { cwd: repo, env: testEnv() })
        .status,
    ).toBe(0);
    expect(
      spawnSync("git", ["diff", "--cached", "--quiet", commit, "--", "."], {
        cwd: repo,
        env: testEnv(),
      }).status,
    ).toBe(0);
  });

  t("restore refuses shared worktrees unless --force", async () => {
    useStateDir();
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    const created = expectOk(runCli(["create", "--repo", repo]));
    const id = String(checkpointOf(created).id);
    writeFileSync(path.join(repo, "a.txt"), "v2\n");

    const subdir = path.join(repo, "subdir");
    mkdirSync(subdir, { recursive: true });
    const panes: FakePane[] = [
      { pane_id: "w1:p1", cwd: repo },
      { pane_id: "w1:p2", cwd: subdir }, // nested under the repo root
      { pane_id: "w2:p1", cwd: tempDir() }, // unrelated pane does not count
    ];
    const fake = await fakeHerdrSocket(panes);
    try {
      const refused = await runCliAsync(["restore", id, "--socket", fake.socketPath], {
        HERDR_SOCKET_PATH: fake.socketPath,
      });
      const error = expectErr(refused, "shared_worktree");
      expect(error.panes).toEqual(["w1:p1", "w1:p2"]);
      // Refusal happened before any mutation: no pre-restore checkpoint.
      expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v2\n");
      const list = expectOk(runCli(["list", "--repo", repo]));
      expect(list.total).toBe(1);

      // --force overrides the refusal.
      const forced = await runCliAsync(["restore", id, "--socket", fake.socketPath, "--force"], {
        HERDR_SOCKET_PATH: fake.socketPath,
      });
      expectOk(forced);
      expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v1\n");
    } finally {
      await fake.close();
    }
  });

  t("restore allows a single sharing pane without --force", async () => {
    useStateDir();
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    const created = expectOk(runCli(["create", "--repo", repo]));
    const id = String(checkpointOf(created).id);
    writeFileSync(path.join(repo, "a.txt"), "v2\n");

    const panes: FakePane[] = [
      { pane_id: "w1:p1", cwd: repo },
      { pane_id: "w2:p1", cwd: tempDir() },
    ];
    const fake = await fakeHerdrSocket(panes);
    try {
      const restored = await runCliAsync(["restore", id, "--socket", fake.socketPath], {
        HERDR_SOCKET_PATH: fake.socketPath,
      });
      const payload = expectOk(restored);
      expect(payload.isolation).toBe("single_pane");
      expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v1\n");
    } finally {
      await fake.close();
    }
  });

  t("mid-restore failure keeps pre-restore checkpoint for recovery", () => {
    useStateDir();
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    const created = expectOk(runCli(["create", "--repo", repo]));
    const id = String(checkpointOf(created).id);

    // S2: tracked modification + an undeletable untracked directory.
    writeFileSync(path.join(repo, "a.txt"), "v2-dirty\n");
    const lockedDir = path.join(repo, "locked");
    mkdirSync(lockedDir);
    writeFileSync(path.join(lockedDir, "keep.txt"), "locked\n");
    chmodSync(lockedDir, 0o555);

    try {
      // git clean -fd cannot empty the read-only dir -> clean_failed.
      // The tracked restore already ran; the pre-restore ref must exist.
      const failed = runCli(["restore", id, "--force"]);
      const error = expectErr(failed, "clean_failed");
      const preId = error.pre_restore_checkpoint_id as string;
      expect(typeof preId).toBe("string");
      expect(error.pre_restore_ref).toBeDefined();

      // The pre-restore checkpoint captured S2 (dirty a.txt + locked/).
      const preShow = expectOk(runCli(["show", preId]));
      expect(String((preShow.summary as Record<string, unknown>).output)).toContain("a.txt");

      // Recover: make the dir removable, then restore the pre-restore id.
      chmodSync(lockedDir, 0o755);
      const recovered = expectOk(runCli(["restore", preId, "--force"]));
      expect(recovered.ok).toBe(true);
      expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v2-dirty\n");
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  t("restore rejects unknown ids, missing refs, and foreign --repo", () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    writeFileSync(path.join(repoA, "a.txt"), "v1\n");
    const created = expectOk(runCli(["create", "--repo", repoA]));
    const id = String(checkpointOf(created).id);

    expectErr(runCli(["restore", "nope", "--force"]), "unknown_checkpoint");
    expectErr(runCli(["restore", id, "--repo", repoB, "--force"]), "repo_mismatch");
    expect(runCli(["restore"]).status).toBe(2);

    // Delete the hidden ref out-of-band: restore must refuse honestly.
    const entry = checkpointOf(created);
    git(repoA, ["update-ref", "-d", String(entry.ref)]);
    const missing = runCli(["restore", id, "--force"]);
    expectErr(missing, "checkpoint_ref_missing");
    // plan still works against the recorded commit, with a warning.
    const planned = expectOk(runCli(["plan", id]));
    expect((planned.ref as Record<string, unknown>).exists).toBe(false);
    expect(planned.warnings).toBeDefined();
  });
});
