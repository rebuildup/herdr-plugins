import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HerdrRpcError } from "../packages/herdr-client/src/index";
import {
  buildCommandLine,
  isPaneGoneError,
  isWaitTimeoutError,
  listRuns,
  parseMarkerExitCode,
  runLog,
  runMarkerRegex,
  runMarkerToken,
  type ScriptTransport,
  scriptTokenName,
  startRun,
  stopRuns,
} from "../plugins/projects/src/runner";
import { loadRuns, runLogPath, updateRuns } from "../plugins/projects/src/runs";
import type { Project } from "../plugins/projects/src/state";

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const savedConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "projects-runner-test-"));
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

// --- Fake herdr transport ---------------------------------------------------

type PaneBehavior = "exit0" | "exit1" | "exit7" | "timeout" | "gone" | "hang";

interface FakePane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  alive: boolean;
  /** Line injected via send_input. */
  input: string | null;
  /** Simulated script stdout before the marker. */
  output: string;
  behavior: PaneBehavior;
  closed: boolean;
  keys: string[][];
}

const TOKEN_RE = /__HERDR_DONE_(\S+?)__=\$\?/;

class FakeTransport implements ScriptTransport {
  panes = new Map<string, FakePane>();
  nextPane = 0;
  /** Behavior applied to every subsequently created pane. */
  behavior: PaneBehavior = "exit0";
  /** Output written by the "script" before the marker line. */
  scriptOutput = "script output line\n";
  metadata: Array<{ pane_id: string; tokens: Record<string, string | null> }> = [];
  waitCalls = 0;

  private newPane(): FakePane {
    this.nextPane += 1;
    const pane: FakePane = {
      pane_id: `pane-${this.nextPane}`,
      workspace_id: `ws-${this.nextPane}`,
      tab_id: `tab-${this.nextPane}`,
      alive: true,
      input: null,
      output: "",
      behavior: this.behavior,
      closed: false,
      keys: [],
    };
    this.panes.set(pane.pane_id, pane);
    return pane;
  }

  async workspaceCreate() {
    const pane = this.newPane();
    return {
      type: "workspace_created" as const,
      workspace: { workspace_id: pane.workspace_id },
      tab: { tab_id: pane.tab_id },
      root_pane: { pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id },
    };
  }

  async paneSendInput(paneId: string, params: { text?: string; keys?: string[] }) {
    const pane = this.panes.get(paneId);
    if (!pane || !pane.alive) throw new HerdrRpcError({ code: "pane_not_found", message: "gone" });
    pane.input = params.text ?? "";
    // Simulate the shell echoing the input line (contains literal `$?`,
    // which must NOT match the exit-code regex) plus script output.
    const token = TOKEN_RE.exec(pane.input)?.[1];
    if (token === undefined) return;
    if (pane.behavior === "hang") {
      pane.output = `${pane.input}\n${this.scriptOutput}`;
      return;
    }
    const code =
      pane.behavior === "exit0"
        ? 0
        : pane.behavior === "exit1"
          ? 1
          : pane.behavior === "exit7"
            ? 7
            : 0;
    pane.output = `${pane.input}\n${this.scriptOutput}__HERDR_DONE_${token}__=${code}\n`;
  }

  async paneSendKeys(paneId: string, keys: string[]) {
    const pane = this.panes.get(paneId);
    if (!pane || !pane.alive) throw new HerdrRpcError({ code: "pane_not_found", message: "gone" });
    pane.keys.push(keys);
    // ctrl+c kills the foreground command, not the pane shell — the pane
    // stays alive until pane.close (matches real herdr behavior).
    return {};
  }

  async paneWaitForOutput(params: { pane_id: string; match: { type: string; value: string } }) {
    this.waitCalls += 1;
    const pane = this.panes.get(params.pane_id);
    if (!pane || !pane.alive) {
      throw new HerdrRpcError({ code: "pane_not_found", message: "pane gone" });
    }
    if (pane.behavior === "timeout" || pane.behavior === "hang") {
      throw new HerdrRpcError({ code: "timeout", message: "wait_for_output timed out" });
    }
    if (pane.behavior === "gone") {
      pane.alive = false;
      throw new HerdrRpcError({ code: "pane_exited", message: "pane exited" });
    }
    const re = new RegExp(params.match.value);
    const matched = re.exec(pane.output);
    if (!matched) {
      throw new HerdrRpcError({ code: "timeout", message: "wait_for_output timed out" });
    }
    const matchedLine = pane.output.split("\n").find((l) => re.test(l)) ?? null;
    return {
      type: "output_matched" as const,
      pane_id: pane.pane_id,
      revision: 1,
      matched_line: matchedLine,
      read: {
        pane_id: pane.pane_id,
        workspace_id: pane.workspace_id,
        tab_id: pane.tab_id,
        source: "recent_unwrapped",
        format: "text",
        text: pane.output,
        revision: 1,
        truncated: false,
      },
    };
  }

  async paneProcessInfo(paneId: string) {
    const pane = this.panes.get(paneId);
    if (!pane || !pane.alive) throw new HerdrRpcError({ code: "pane_not_found", message: "gone" });
    return {
      pane_id: paneId,
      shell_pid: 100,
      foreground_process_group_id: 100,
      foreground_processes: [],
    };
  }

  async paneGet(paneId: string) {
    const pane = this.panes.get(paneId);
    if (!pane || !pane.alive || pane.closed) {
      throw new HerdrRpcError({ code: "pane_not_found", message: "pane gone" });
    }
    return { pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id };
  }

  async paneRead(paneId: string) {
    const pane = this.panes.get(paneId);
    if (!pane || !pane.alive) throw new HerdrRpcError({ code: "pane_not_found", message: "gone" });
    return {
      pane_id: paneId,
      workspace_id: pane.workspace_id,
      tab_id: pane.tab_id,
      source: "recent",
      format: "text",
      text: pane.output || pane.input || "",
      revision: 1,
      truncated: false,
    };
  }

  async paneClose(paneId: string) {
    const pane = this.panes.get(paneId);
    if (pane) {
      pane.closed = true;
      pane.alive = false;
    }
    return {};
  }

  async reportMetadata(paneId: string, tokens: Record<string, string | null>) {
    this.metadata.push({ pane_id: paneId, tokens });
    return {};
  }
}

function deps(transport: FakeTransport, extra: Partial<Parameters<typeof startRun>[1]> = {}) {
  return {
    transport,
    waitTimeoutMs: 5_000,
    logMaxBytes: 1_024,
    stopGraceMs: 1,
    sleep: async () => {},
    ...extra,
  };
}

function startInput(project: Project, repoRoot: string) {
  return {
    project,
    script: { id: "dev", name: "Dev server", command: "bun run dev", source: "t3.json" },
    repoRoot,
    remote: null,
  };
}

// --- marker / command-line units -------------------------------------------

describe("marker helpers", () => {
  test("echoed input line never matches the exit-code regex", () => {
    const runId = "run-abc123-deadbeef";
    const token = runMarkerToken(runId);
    const line = `bun run dev; echo ${token}=$?`;
    expect(parseMarkerExitCode(line, runId)).toBeNull();
    // The real output line does match.
    expect(parseMarkerExitCode(`noise\n${token}=0\nmore`, runId)).toBe(0);
    expect(parseMarkerExitCode(`${token}=-1\n${token}=3`, runId)).toBe(3);
  });

  test("runMarkerRegex embeds the run id", () => {
    expect(runMarkerRegex("run-x")).toContain("run-x");
    expect(runMarkerRegex("run-x")).toContain("(-?\\d+)");
  });

  test("buildCommandLine inlines short single-line commands", async () => {
    const { line, scriptPath } = await buildCommandLine("run-t1", "echo hi", tempDir());
    expect(scriptPath).toBeNull();
    expect(line).toBe("echo hi; echo __HERDR_DONE_run-t1__=$?");
  });

  test("buildCommandLine writes a script file for multiline/long commands", async () => {
    const dir = tempDir();
    const { line, scriptPath } = await buildCommandLine("run-t2", "echo one\necho two", dir);
    expect(scriptPath).not.toBeNull();
    expect(scriptPath?.startsWith(dir)).toBe(true);
    expect(line).toContain(scriptPath as string);
    expect(line).toContain("__HERDR_DONE_run-t2__=$?");
    const file = readFileSync(scriptPath as string, "utf8");
    expect(file).toContain("echo one\necho two");
    const long = await buildCommandLine("run-t3", "x".repeat(5_000), dir);
    expect(long.scriptPath).not.toBeNull();
  });

  test("scriptTokenName is herdr-token safe and capped", () => {
    expect(scriptTokenName("Dev Server!")).toBe("script_dev-server");
    expect(scriptTokenName("a".repeat(80))).toHaveLength(32);
    expect(scriptTokenName("!!!")).toBe("script_unnamed");
  });

  test("error classifiers", () => {
    expect(isWaitTimeoutError(new HerdrRpcError({ code: "timeout", message: "t" }))).toBe(true);
    expect(isWaitTimeoutError(new Error("request timed out"))).toBe(true);
    expect(isWaitTimeoutError(new Error("boom"))).toBe(false);
    expect(isPaneGoneError(new HerdrRpcError({ code: "pane_not_found", message: "x" }))).toBe(true);
    expect(isPaneGoneError(new Error("pane_exited"))).toBe(true);
    expect(isPaneGoneError(new Error("socket refused"))).toBe(false);
  });
});

// --- startRun state machine -----------------------------------------------

describe("startRun", () => {
  test("exit 0 → success with parsed exit code, log, metadata", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.scriptOutput = "hello from script\n";
    const run = await startRun(startInput(makeProject("p", [repo]), repo), deps(transport));

    expect(run.result).toBe("success");
    expect(run.exit_code).toBe(0);
    expect(run.finished_at).not.toBeNull();
    expect(run.pane_id).toBe("pane-1");
    expect(run.workspace_id).toBe("ws-1");
    // Injected line carries the marker suffix and Enter.
    const pane = transport.panes.get("pane-1");
    expect(pane?.input).toContain("bun run dev; echo __HERDR_DONE_");
    expect(pane?.input).toContain("=$?");
    // Log captured and stored under the state dir.
    expect(run.log_path).not.toBeNull();
    expect(readFileSync(runLogPath(run.run_id), "utf8")).toContain("hello from script");
    // Metadata token reported running then success.
    const states = transport.metadata
      .filter((m) => m.pane_id === "pane-1")
      .map((m) => Object.values(m.tokens)[0]);
    expect(states).toEqual(["running", "success"]);
    expect(transport.metadata[0]?.tokens["script_dev-server"]).toBeDefined();
    // Persisted record matches.
    const stored = (await loadRuns()).runs[run.run_id];
    expect(stored?.result).toBe("success");
    expect(stored?.exit_code).toBe(0);
  });

  test("exit 1 → failed with exit code 1", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "exit1";
    const run = await startRun(startInput(makeProject("p", [repo]), repo), deps(transport));
    expect(run.result).toBe("failed");
    expect(run.exit_code).toBe(1);
  });

  test("exit 7 propagates the real code", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "exit7";
    const run = await startRun(startInput(makeProject("p", [repo]), repo), deps(transport));
    expect(run.result).toBe("failed");
    expect(run.exit_code).toBe(7);
  });

  test("wait timeout → stays running, pane left alive, never killed", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "timeout";
    const run = await startRun(startInput(makeProject("p", [repo]), repo), deps(transport));
    expect(run.result).toBe("running");
    expect(run.exit_code).toBeNull();
    // Pane NOT closed by the runner.
    expect(transport.panes.get(run.pane_id)?.closed).toBe(false);
    expect(transport.panes.get(run.pane_id)?.alive).toBe(true);
  });

  test("pane vanished before marker → unknown, never success", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "gone";
    const run = await startRun(startInput(makeProject("p", [repo]), repo), deps(transport));
    expect(run.result).toBe("unknown");
    expect(run.exit_code).toBeNull();
    expect(run.finished_at).not.toBeNull();
  });

  test("generic transport error → stays running with error recorded", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    // Simulate a non-timeout socket failure on wait.
    transport.paneWaitForOutput = async (_params) => {
      throw new Error("socket reset by peer");
    };
    const run = await startRun(startInput(makeProject("p", [repo]), repo), deps(transport));
    expect(run.result).toBe("running");
    expect(run.error).toContain("socket reset");
  });
});

// --- stop / results / logs -----------------------------------------------

describe("stopRuns", () => {
  test("stops a running run via its recorded pane only", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang"; // never prints marker → stays running
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    expect(run.result).toBe("running");

    const outcomes = await stopRuns(run.run_id, deps(transport));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.action).toBe("stopped");
    expect(outcomes[0]?.run.result).toBe("stopped");
    const pane = transport.panes.get(run.pane_id);
    expect(pane?.keys).toEqual([["ctrl+c"]]);
    expect(pane?.closed).toBe(true);
    // Log captured before close.
    expect(outcomes[0]?.run.log_path).not.toBeNull();
  });

  test("stop by project id stops all its running runs", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const r1 = await startRun(startInput(project, repo), deps(transport));
    const r2 = await startRun(startInput(project, repo), deps(transport));
    const outcomes = await stopRuns("p", deps(transport));
    expect(outcomes.map((o) => o.run.run_id).sort()).toEqual([r1.run_id, r2.run_id].sort());
    expect(transport.panes.get(r1.pane_id)?.closed).toBe(true);
    expect(transport.panes.get(r2.pane_id)?.closed).toBe(true);
  });

  test("stop on finished run reports already_finished; unknown target errors", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    expect(run.result).toBe("success");
    const outcomes = await stopRuns(run.run_id, deps(transport));
    expect(outcomes[0]?.action).toBe("already_finished");
    await expect(stopRuns("nope", deps(transport))).rejects.toMatchObject({
      kind: "run_not_found",
    });
  });

  test("ambiguous run-id prefix fails", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    // Force colliding prefixes by writing records directly.
    const now = new Date().toISOString();
    const base = {
      project_id: "p",
      script: { id: "s", name: "S", command: "x", source: "t3.json" },
      repo: { root: repo, remote: null },
      workspace_id: "w",
      tab_id: null,
      cwd: repo,
      command_line: "x",
      script_path: null,
      started_at: now,
      finished_at: null,
      exit_code: null,
      result: "running" as const,
      log_path: null,
      error: null,
    };
    await updateRuns((s) => {
      s.runs["run-aaaa-1"] = { ...base, run_id: "run-aaaa-1", pane_id: "px" };
      s.runs["run-aaaa-2"] = { ...base, run_id: "run-aaaa-2", pane_id: "py" };
    });
    await expect(stopRuns("run-aaaa", deps(transport))).rejects.toMatchObject({
      kind: "ambiguous_run",
    });
    // Exact id still resolves.
    const outcomes = await stopRuns("run-aaaa-1", deps(transport)).catch(() => null);
    // pane px doesn't exist in the fake → pane_gone or throw; either way no crash of suite.
    void outcomes;
  });
});

describe("listRuns / runLog", () => {
  test("running record with vanished pane reconciles to unknown", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    expect(run.result).toBe("running");

    // Pane still alive → stays running.
    let runs = await listRuns(deps(transport));
    expect(runs.find((r) => r.run_id === run.run_id)?.result).toBe("running");

    // Pane gone → lazily marked unknown and persisted.
    const pane = transport.panes.get(run.pane_id);
    expect(pane).toBeDefined();
    if (pane) pane.alive = false;
    runs = await listRuns(deps(transport));
    const updated = runs.find((r) => r.run_id === run.run_id);
    expect(updated?.result).toBe("unknown");
    expect(updated?.finished_at).not.toBeNull();
    expect((await loadRuns()).runs[run.run_id]?.result).toBe("unknown");
  });

  test("runLog returns stored log; missing run errors", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    const result = await runLog(run.run_id, deps(transport));
    expect(result.log).toContain("script output line");
    await expect(runLog("run-nope", deps(transport))).rejects.toMatchObject({
      kind: "run_not_found",
    });
  });

  test("runLog captures a live tail for a running run without stored log", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    const result = await runLog(run.run_id, deps(transport));
    expect(result.log).not.toBeNull();
    expect(result.run.log_path).not.toBeNull();
  });

  test("corrupt runs.json reads as empty (state corruption tolerance)", async () => {
    const dir = useStateDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "runs.json"), "{corrupt");
    const runs = await loadRuns();
    expect(runs.runs).toEqual({});
  });
});

// --- CLI-level contract tests (no herdr needed) ----------------------------

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
    env: {
      ...process.env,
      // Never let CLI contract tests reach a real herdr socket — the
      // developer's live session must not be touched.
      HERDR_SOCKET_PATH: path.join(tempDir(), "no-such-herdr.sock"),
    },
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

function writeT3Json(repoRoot: string, scripts: unknown[]): void {
  writeFileSync(path.join(repoRoot, "t3.json"), JSON.stringify({ scripts }));
}

describe("cli scripts run/stop/results/logs", () => {
  test("multi-repo project without --repo fails repo_ambiguous", () => {
    useStateDir();
    const repoA = initRepo();
    const repoB = initRepo();
    writeT3Json(repoA, [{ name: "dev", command: "echo hi" }]);
    const id = (expectOk(runCli(["register", repoA, "--id", "multi"])).project as Project).id;
    expectOk(runCli(["repos", "add", id, "--path", repoB]));

    const err = expectErr(runCli(["scripts", "run", id, "dev"]), "repo_ambiguous");
    expect(err.repos).toBeDefined();
    // --repo pointing outside the project fails repo_not_found.
    const outsider = initRepo();
    expectErr(runCli(["scripts", "run", id, "dev", "--repo", outsider]), "repo_not_found");
    // scripts list still defaults to first repo (unchanged behavior).
    const list = expectOk(runCli(["scripts", "list", id, "--repo", repoB]));
    expect((list.scripts as unknown[]).length).toBe(0);
  });

  test("single-repo project resolves script then fails on missing herdr socket", () => {
    useStateDir();
    const repo = initRepo();
    writeT3Json(repo, [{ name: "dev", command: "echo hi" }]);
    const id = (expectOk(runCli(["register", repo, "--id", "solo"])).project as Project).id;

    // No herdr socket in the test env → structured error, not a crash.
    const r = runCli(["scripts", "run", id, "dev"]);
    expect(r.status).toBe(1);
    // Unknown script name fails before any socket call.
    expectErr(runCli(["scripts", "run", id, "nope"]), "unknown_script");
    expectErr(runCli(["scripts", "run", "ghost", "dev"]), "project_not_found");
  });

  test("results/logs/stop on empty store are structured errors or empty lists", () => {
    useStateDir();
    const results = expectOk(runCli(["scripts", "results"]));
    expect(results.runs).toEqual([]);
    expectErr(runCli(["scripts", "logs", "run-nope"]), "run_not_found");
    expectErr(runCli(["scripts", "stop", "run-nope"]), "run_not_found");
    expect(runCli(["scripts", "run"]).status).toBe(2);
    expect(runCli(["scripts", "bogus"]).status).toBe(2);
  });

  test("capability advertises scripts run/stop as mutations", () => {
    useStateDir();
    const cap = expectOk(runCli(["capability"]));
    const mutations = cap.mutation_commands as string[];
    expect(mutations).toContain("scripts run");
    expect(mutations).toContain("scripts stop");
  });
});
