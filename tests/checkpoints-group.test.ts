import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const savedConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "checkpoints-group-test-"));
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

const DEAD_SOCKET = path.join(tempDir(), "no-such-herdr.sock");

function cliEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { HERDR_SOCKET_PATH: DEAD_SOCKET };
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
    server.listen(socketPath, () => resolveListen());
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

function stateFile(stateDir: string): string {
  return path.join(stateDir, "state.json");
}

function readState(stateDir: string): {
  checkpoints: Record<string, Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(stateFile(stateDir), "utf8")) as {
    checkpoints: Record<string, Record<string, unknown>>;
  };
}

function writeState(stateDir: string, state: unknown): void {
  writeFileSync(stateFile(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}

interface SaveResult {
  id: string;
  repo_root: string;
  group_id?: string;
}

function saveResults(payload: Record<string, unknown>): SaveResult[] {
  return (payload.results as Array<Record<string, unknown>>)
    .filter((r) => r.ok === true)
    .map((r) => {
      const ckpt = r.checkpoint as Record<string, unknown>;
      return {
        id: String(ckpt.id),
        repo_root: String(r.repo_root),
        ...(typeof ckpt.group_id === "string" ? { group_id: ckpt.group_id } : {}),
      };
    });
}

const t = (name: string, fn: () => void | Promise<void>) => test(name, fn, 30_000);

describe("checkpoints multi-repo save/restore-group", () => {
  t("capability advertises the new commands", () => {
    useStateDir();
    const payload = expectOk(runCli(["capability"]));
    for (const cmd of ["save", "restore-group", "gc", "prune"]) {
      expect(payload.commands).toContain(cmd);
    }
    expect(payload.mutation_commands).toContain("restore-group");
  });

  t("save captures one checkpoint per repo under a shared group id", () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    writeFileSync(path.join(repoA, "a.txt"), "alpha\n");
    writeFileSync(path.join(repoB, "b.txt"), "beta\n");

    const saved = expectOk(runCli(["save", "--repo", repoA, "--repo", repoB, "--label", "g1"]));
    expect(saved.ok).toBe(true);
    expect(saved.total).toBe(2);
    expect(saved.succeeded).toBe(2);
    expect(String(saved.group)).toMatch(/^grp-/);

    const results = saveResults(saved);
    expect(results).toHaveLength(2);
    const groupIds = new Set(results.map((r) => r.group_id));
    expect(groupIds.size).toBe(1);
    const groupId = String(saved.group);
    for (const r of results) expect(r.group_id).toBe(groupId);

    // Refs exist in each repo's own namespace.
    for (const repo of [repoA, repoB]) {
      const refs = git(repo, ["for-each-ref", "refs/herdr-plugins/checkpoints"]);
      expect(refs.trim()).not.toBe("");
    }

    // list --group filters to the group members.
    const listed = expectOk(runCli(["list", "--group", groupId]));
    expect(listed.total).toBe(2);
    const ungrouped = expectOk(runCli(["create", "--repo", repoA]));
    expect(String((ungrouped.checkpoint as Record<string, unknown>).group_id ?? "")).toBe("");
    const after = expectOk(runCli(["list", "--group", groupId]));
    expect(after.total).toBe(2);
  });

  t("save discovers the repo set live from session pane cwds", async () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    const plainDir = tempDir();
    const repoASub = path.join(repoA, "subdir");
    spawnSync("mkdir", ["-p", repoASub]);
    writeFileSync(path.join(repoA, "a.txt"), "alpha\n");
    writeFileSync(path.join(repoB, "b.txt"), "beta\n");

    const panes: FakePane[] = [
      { pane_id: "w1:p1", cwd: repoA },
      { pane_id: "w1:p2", cwd: repoASub }, // same repo via a nested cwd
      { pane_id: "w2:p1", cwd: repoB },
      { pane_id: "w3:p1", cwd: plainDir }, // not a repo -> skipped
      { pane_id: "w4:p1" }, // no cwd -> skipped
    ];
    const fake = await fakeHerdrSocket(panes);
    try {
      const saved = await runCliAsync(["save", "--socket", fake.socketPath]);
      const payload = expectOk(saved);
      expect(payload.total).toBe(2);
      expect(payload.succeeded).toBe(2);
      const skipped = payload.skipped_panes as Array<Record<string, unknown>>;
      expect(skipped.map((s) => s.pane_id).sort()).toEqual(["w3:p1", "w4:p1"]);
      const roots = new Set(saveResults(payload).map((r) => r.repo_root));
      expect(roots).toEqual(new Set([repoA, repoB]));
    } finally {
      await fake.close();
    }
  });

  t("save reports per-repo failures without hiding them", () => {
    const stateDir = useStateDir();
    const repoA = initRepo();
    const plain = tempDir();
    writeFileSync(path.join(repoA, "a.txt"), "alpha\n");

    const saved = runCli(["save", "--repo", repoA, "--repo", plain]);
    // Partial failure: stdout carries the report, stderr+exit 1 mark it.
    expect(saved.status).toBe(1);
    expect(saved.json).not.toBeNull();
    expect(saved.json?.ok).toBe(false);
    expect(saved.json?.failed).toBe(1);
    expect(saved.error?.kind).toBe("partial_save");
    const results = saved.json?.results as Array<Record<string, unknown>>;
    const failed = results.find((r) => r.ok === false);
    expect((failed?.error as Record<string, unknown>).kind).toBe("not_a_repo");
    // The good repo's checkpoint was still captured and persisted.
    const entries = Object.values(readState(stateDir).checkpoints);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.repo_root).toBe(repoA);
    expect(entries[0]?.group_id).toBe(String(saved.json?.group));
  });

  t("restore-group restores every member with per-repo pre_restore", () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    // S1 states to capture.
    writeFileSync(path.join(repoA, "a.txt"), "A-v1\n");
    writeFileSync(path.join(repoB, "b.txt"), "B-v1\n");
    writeFileSync(path.join(repoA, "only-a.txt"), "a-only\n");
    const saved = expectOk(runCli(["save", "--repo", repoA, "--repo", repoB]));
    const groupId = String(saved.group);

    // Move both repos to S2.
    writeFileSync(path.join(repoA, "a.txt"), "A-v2-dirty\n");
    writeFileSync(path.join(repoB, "b.txt"), "B-v2-dirty\n");
    writeFileSync(path.join(repoA, "extra.txt"), "extra\n");

    const restored = expectOk(runCli(["restore-group", groupId, "--force"]));
    expect(restored.ok).toBe(true);
    expect(restored.total).toBe(2);
    expect(restored.succeeded).toBe(2);
    expect(restored.failed).toBe(0);

    const results = restored.results as Array<Record<string, unknown>>;
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect((r.pre_restore as Record<string, unknown>).id).toBeDefined();
    }
    expect(readFileSync(path.join(repoA, "a.txt"), "utf8")).toBe("A-v1\n");
    expect(readFileSync(path.join(repoB, "b.txt"), "utf8")).toBe("B-v1\n");
    expect(existsSync(path.join(repoA, "extra.txt"))).toBe(false);
    expect(readFileSync(path.join(repoA, "only-a.txt"), "utf8")).toBe("a-only\n");

    // Each repo got its own pre_restore entry in state.
    const stateDir = process.env.HERDR_PLUGIN_STATE_DIR as string;
    const kinds = Object.values(readState(stateDir).checkpoints).map((e) => e.kind);
    expect(kinds.filter((k) => k === "pre_restore")).toHaveLength(2);
  });

  t("restore-group reports partial failure honestly (ok:false, exit 1)", () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    writeFileSync(path.join(repoA, "a.txt"), "A-v1\n");
    writeFileSync(path.join(repoB, "b.txt"), "B-v1\n");
    const saved = expectOk(runCli(["save", "--repo", repoA, "--repo", repoB]));
    const groupId = String(saved.group);

    // Delete repoB's checkpoint ref out-of-band: its member must fail
    // while repoA still restores.
    const stateDir = process.env.HERDR_PLUGIN_STATE_DIR as string;
    const entryB = Object.values(readState(stateDir).checkpoints).find(
      (e) => e.repo_root === repoB,
    );
    expect(entryB).toBeDefined();
    git(repoB, ["update-ref", "-d", String(entryB?.ref)]);

    writeFileSync(path.join(repoA, "a.txt"), "A-v2\n");
    writeFileSync(path.join(repoB, "b.txt"), "B-v2\n");

    const restored = runCli(["restore-group", groupId, "--force"]);
    expect(restored.status).toBe(1);
    expect(restored.json?.ok).toBe(false);
    expect(restored.json?.succeeded).toBe(1);
    expect(restored.json?.failed).toBe(1);
    expect(restored.error?.kind).toBe("partial_restore");

    const results = restored.json?.results as Array<Record<string, unknown>>;
    const byRepo = new Map(results.map((r) => [String(r.repo_root), r]));
    expect(byRepo.get(repoA)?.ok).toBe(true);
    const failB = byRepo.get(repoB);
    expect(failB?.ok).toBe(false);
    expect((failB?.error as Record<string, unknown>).kind).toBe("checkpoint_ref_missing");

    // The successful repo was genuinely restored — partial success is
    // real work, reported as such, not hidden behind ok:true.
    expect(readFileSync(path.join(repoA, "a.txt"), "utf8")).toBe("A-v1\n");
    expect(readFileSync(path.join(repoB, "b.txt"), "utf8")).toBe("B-v2\n");
  });

  t("restore-group rejects unknown groups and --repo", () => {
    useStateDir();
    expectErr(runCli(["restore-group", "grp-nope", "--force"]), "unknown_group");
    expect(runCli(["restore-group", "grp-x", "--repo", "/tmp", "--force"]).status).toBe(2);
    expect(runCli(["restore-group"]).status).toBe(2);
  });
});

describe("checkpoints gc/prune", () => {
  t("gc evicts beyond max-count, keeps newest, dry-run mutates nothing", () => {
    const stateDir = useStateDir();
    const repo = initRepo();
    for (let i = 0; i < 3; i += 1) {
      writeFileSync(path.join(repo, "a.txt"), `v${i}\n`);
      expectOk(runCli(["create", "--repo", repo]));
    }
    const before = expectOk(runCli(["list", "--repo", repo]));
    expect(before.total).toBe(3);

    const dry = expectOk(runCli(["gc", "--repo", repo, "--max-count", "1", "--dry-run"]));
    expect(dry.dry_run).toBe(true);
    const dryRepo = (dry.repos as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(dryRepo.would_delete).toHaveLength(2);
    expect((dry.totals as Record<string, unknown>).would_delete).toBe(2);
    // Nothing changed.
    expect(git(repo, ["for-each-ref", "refs/herdr-plugins/checkpoints"]).trim()).not.toBe("");
    expect(expectOk(runCli(["list", "--repo", repo])).total).toBe(3);

    const gc = expectOk(runCli(["gc", "--repo", repo, "--max-count", "1"]));
    expect(gc.dry_run).toBe(false);
    const repoReport = (gc.repos as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(repoReport.deleted).toHaveLength(2);
    expect(repoReport.kept).toBe(1);

    // State and refs agree: exactly one entry remains and its ref lives.
    const after = expectOk(runCli(["list", "--repo", repo]));
    expect(after.total).toBe(1);
    const remaining = (after.checkpoints as Array<Record<string, unknown>>)[0] as Record<
      string,
      unknown
    >;
    const refs = git(repo, ["for-each-ref", "refs/herdr-plugins/checkpoints"]);
    expect(refs).toContain(String(remaining.ref));
    expect(Object.keys(readState(stateDir).checkpoints)).toHaveLength(1);
  });

  t("gc evicts by age and protects recent pre_restore entries", () => {
    const stateDir = useStateDir();
    const repo = initRepo();
    // One manual checkpoint, then a restore to mint a pre_restore entry.
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    const created = expectOk(runCli(["create", "--repo", repo]));
    const id = String((created.checkpoint as Record<string, unknown>).id);
    writeFileSync(path.join(repo, "a.txt"), "v2\n");
    expectOk(runCli(["restore", id, "--force"]));

    // Age every entry past the retention window, but keep the
    // pre_restore entry inside its protection window by giving it a
    // recent created_at while the manual one is ancient.
    const state = readState(stateDir);
    const now = Date.now();
    for (const [key, entry] of Object.entries(state.checkpoints)) {
      const isPre = entry.kind === "pre_restore";
      entry.created_at = new Date(now - (isPre ? 1 : 40) * 86_400_000).toISOString();
      state.checkpoints[key] = entry;
    }
    writeState(stateDir, state);

    const gc = expectOk(
      runCli(["gc", "--repo", repo, "--max-age-days", "30", "--protect-days", "7"]),
    );
    const repoReport = (gc.repos as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    // The 40-day-old manual checkpoint is evicted; the 1-day-old
    // pre_restore entry is protected.
    expect(repoReport.deleted).toHaveLength(1);
    expect((repoReport.protected as string[]).length).toBeGreaterThanOrEqual(1);

    const after = expectOk(runCli(["list", "--repo", repo]));
    const kinds = (after.checkpoints as Array<Record<string, unknown>>).map((e) => e.kind);
    expect(kinds).toContain("pre_restore");
    expect(kinds).not.toContain("manual");

    // With protection disabled the pre_restore entry is evictable too.
    const gc2 = expectOk(
      runCli(["gc", "--repo", repo, "--max-age-days", "0.5", "--protect-days", "0.1"]),
    );
    expect((gc2.totals as Record<string, unknown>).deleted).toBe(1);
    expect(expectOk(runCli(["list", "--repo", repo])).total).toBe(0);
  });

  t("prune deletes only refs the state index does not reference", () => {
    useStateDir();
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    const created = expectOk(runCli(["create", "--repo", repo]));
    const entry = created.checkpoint as Record<string, unknown>;
    const repoKey = String(entry.repo_key);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();

    // Orphan ref: under our namespace but absent from state.
    const orphanRef = `refs/herdr-plugins/checkpoints/${repoKey}/orphan-1`;
    git(repo, ["update-ref", orphanRef, head]);
    // Foreign ref outside our namespace must never be touched.
    const foreignRef = "refs/herdr-plugins/other/orphan";
    git(repo, ["update-ref", foreignRef, head]);

    const dry = expectOk(runCli(["prune", "--repo", repo, "--dry-run"]));
    const dryRepo = (dry.repos as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(dryRepo.orphans).toEqual([orphanRef]);
    expect(git(repo, ["rev-parse", "--verify", orphanRef]).trim()).toBe(head);

    const pruned = expectOk(runCli(["prune", "--repo", repo]));
    expect(pruned.ok).toBe(true);
    const totals = pruned.totals as Record<string, unknown>;
    expect(totals.orphans).toBe(1);
    expect(totals.deleted).toBe(1);

    // Orphan gone; state-referenced ref and foreign ref untouched.
    expect(git(repo, ["for-each-ref", "--format=%(refname)", orphanRef]).trim()).toBe("");
    expect(git(repo, ["rev-parse", "--verify", String(entry.ref)]).trim()).toBe(
      String(entry.commit),
    );
    expect(git(repo, ["rev-parse", "--verify", foreignRef]).trim()).toBe(head);
    expect(expectOk(runCli(["list", "--repo", repo])).total).toBe(1);
  });

  t("gc never deletes a ref still referenced by state", () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    writeFileSync(path.join(repoA, "a.txt"), "a\n");
    writeFileSync(path.join(repoB, "b.txt"), "b\n");
    expectOk(runCli(["create", "--repo", repoA]));
    expectOk(runCli(["create", "--repo", repoB]));

    // Aggressive gc across all repos: nothing exceeds defaults, so
    // every state-referenced ref must survive.
    const gc = expectOk(runCli(["gc", "--max-count", "100", "--max-age-days", "3650"]));
    expect(gc.ok).toBe(true);
    for (const repo of [repoA, repoB]) {
      const refs = git(repo, ["for-each-ref", "refs/herdr-plugins/checkpoints"]);
      expect(refs.trim()).not.toBe("");
    }
    expect(expectOk(runCli(["list"])).total).toBe(2);
  });
});

describe("checkpoints linked worktrees", () => {
  t("restore --repo into a linked worktree of the same repository", () => {
    useStateDir();
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    writeFileSync(path.join(repo, "captured.txt"), "captured\n");
    const created = expectOk(runCli(["create", "--repo", repo]));
    const id = String((created.checkpoint as Record<string, unknown>).id);

    // Linked worktree of the same repo (shared object store + refs).
    const wtParent = tempDir();
    const wt = path.join(wtParent, "wt");
    git(repo, ["worktree", "add", "--detach", wt]);

    // Move the main worktree away and dirty the linked worktree.
    writeFileSync(path.join(repo, "a.txt"), "v2-dirty\n");
    writeFileSync(path.join(repo, "captured.txt"), "changed\n");
    writeFileSync(path.join(wt, "wt-only.txt"), "wt only\n");

    const restored = expectOk(runCli(["restore", id, "--repo", wt, "--force"]));
    expect(restored.ok).toBe(true);
    expect(readFileSync(path.join(wt, "a.txt"), "utf8")).toBe("v1\n");
    expect(readFileSync(path.join(wt, "captured.txt"), "utf8")).toBe("captured\n");
    // Post-checkpoint untracked file in the target worktree removed.
    expect(existsSync(path.join(wt, "wt-only.txt"))).toBe(false);
    // Main worktree untouched by the linked-worktree restore.
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("v2-dirty\n");

    git(repo, ["worktree", "remove", "--force", wt]);
  });
});
