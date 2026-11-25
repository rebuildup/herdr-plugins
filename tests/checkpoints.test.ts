import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

function runCli(args: string[]): CliResult {
  // Never leak the developer's live herdr session into CLI spawns: pane
  // resolution must only happen when a test opts in explicitly.
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
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env,
    timeout: 30_000,
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
    expect(payload.mutation_commands).toEqual(["create", "delete"]);
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
    expect(ckpt.repo_root).toBe(repo);
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
    spawnSync("git", ["init", "--bare", "-q", bare]);
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
});
