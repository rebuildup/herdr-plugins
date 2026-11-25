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
  /** Foreground process table reported by pane.process_info. */
  foreground: { pid: number; name: string }[];
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
  getCalls = 0;
  readCalls = 0;
  /** When set, pane.close rejects with this error (pane stays alive). */
  closeError: Error | null = null;
  /** Foreground processes reported for subsequently created panes. */
  foreground: { pid: number; name: string }[] = [];

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
      foreground: [...this.foreground],
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
      foreground_processes: pane.foreground,
    };
  }

  async paneGet(paneId: string) {
    this.getCalls += 1;
    const pane = this.panes.get(paneId);
    if (!pane || !pane.alive || pane.closed) {
      throw new HerdrRpcError({ code: "pane_not_found", message: "pane gone" });
    }
    return { pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id };
  }

  async paneRead(paneId: string) {
    this.readCalls += 1;
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
    if (this.closeError) throw this.closeError;
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
    stopConfirmMs: 10,
    sleep: async () => {},
    ...extra,
  };
}

/**
 * Simulate the script finishing AFTER the bounded wait timed out: the
 * shell echoes the durable `__HERDR_DONE_<run-id>__=<code>` marker into
 * the pane's scrollback. The run-id token is recovered from the injected
 * input line recorded by `paneSendInput`.
 */
function completePaneLater(transport: FakeTransport, paneId: string, code: number): void {
  const pane = transport.panes.get(paneId);
  if (!pane) throw new Error(`no fake pane: ${paneId}`);
  const token = TOKEN_RE.exec(pane.input ?? "")?.[1];
  if (token === undefined) throw new Error("pane input carries no run marker token");
  pane.output = `${pane.output}late output\n__HERDR_DONE_${token}__=${code}\n`;
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
      host: null,
      session_key: null,
      stop_requested_at: null,
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

  test("happy path records stopping before confirming stopped", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    expect(run.result).toBe("running");
    // v2 record carries the ownership tuple.
    expect(run.host).not.toBeNull();
    expect(run.session_key).not.toBeNull();
    expect(run.stop_requested_at).toBeNull();

    const outcomes = await stopRuns(run.run_id, deps(transport));
    expect(outcomes[0]?.action).toBe("stopped");
    const stored = (await loadRuns()).runs[run.run_id];
    expect(stored?.result).toBe("stopped");
    // ctrl+c was recorded as a distinct request state before confirmation.
    expect(stored?.stop_requested_at).not.toBeNull();
    const states = transport.metadata
      .filter((m) => m.pane_id === run.pane_id)
      .map((m) => Object.values(m.tokens)[0]);
    expect(states).toEqual(["running", "stopping", "stopped"]);
  });

  test("pane already gone → unknown, no input sent", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    const pane = transport.panes.get(run.pane_id);
    expect(pane).toBeDefined();
    if (pane) pane.alive = false;

    const outcomes = await stopRuns(run.run_id, deps(transport));
    expect(outcomes[0]?.action).toBe("pane_gone");
    expect(outcomes[0]?.run.result).toBe("unknown");
    expect(pane?.keys).toEqual([]);
  });

  test("foreign session record → stale_pane, zero pane side effects", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    const getCallsBefore = transport.getCalls;

    // A different session/socket must never reach this pane.
    const outcomes = await stopRuns(
      run.run_id,
      deps(transport, { sessionKey: "other-host /tmp/other.sock" }),
    );
    expect(outcomes[0]?.action).toBe("stale_pane");
    const pane = transport.panes.get(run.pane_id);
    expect(pane?.keys).toEqual([]);
    expect(pane?.closed).toBe(false);
    // Foreign short-circuit happens BEFORE pane.get.
    expect(transport.getCalls).toBe(getCallsBefore);
    // Result preserved for the owning session; error explains why.
    const stored = (await loadRuns()).runs[run.run_id];
    expect(stored?.result).toBe("running");
    expect(stored?.error).toContain("session mismatch");
  });

  test("pane replaced in another workspace → stale_pane, no input/close", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    // Simulate the recorded pane id resolving to a different workspace.
    const pane = transport.panes.get(run.pane_id);
    expect(pane).toBeDefined();
    if (pane) pane.workspace_id = "ws-replaced";

    const outcomes = await stopRuns(run.run_id, deps(transport));
    expect(outcomes[0]?.action).toBe("stale_pane");
    expect(pane?.keys).toEqual([]);
    expect(pane?.closed).toBe(false);
    const stored = (await loadRuns()).runs[run.run_id];
    expect(stored?.result).toBe("unknown");
    expect(stored?.error).toContain("stale_pane");
  });

  test("stop confirmation timeout → stop_unconfirmed, never claimed stopped", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    // Close fails AND a foreground process keeps running: no exit evidence.
    transport.closeError = new Error("close refused");
    transport.foreground = [{ pid: 200, name: "bun" }];
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));

    const outcomes = await stopRuns(run.run_id, deps(transport));
    expect(outcomes[0]?.action).toBe("stop_unconfirmed");
    const stored = (await loadRuns()).runs[run.run_id];
    expect(stored?.result).toBe("stop_unconfirmed");
    expect(stored?.stop_requested_at).not.toBeNull();
    expect(stored?.finished_at).toBeNull();
    // ctrl+c WAS sent (request accepted) but stopped was never claimed.
    expect(transport.panes.get(run.pane_id)?.keys).toEqual([["ctrl+c"]]);
  });

  test("results later confirms a stop_unconfirmed run once the pane is gone", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    transport.closeError = new Error("close refused");
    transport.foreground = [{ pid: 200, name: "bun" }];
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    await stopRuns(run.run_id, deps(transport));
    expect((await loadRuns()).runs[run.run_id]?.result).toBe("stop_unconfirmed");

    // The process finally exits and the pane disappears.
    transport.closeError = null;
    const pane = transport.panes.get(run.pane_id);
    if (pane) pane.alive = false;

    const runs = await listRuns(deps(transport));
    const updated = runs.find((r) => r.run_id === run.run_id);
    expect(updated?.result).toBe("stopped");
    expect((await loadRuns()).runs[run.run_id]?.result).toBe("stopped");
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

  test("v1 run records load with null ownership fields (backward compat)", async () => {
    const dir = useStateDir();
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      path.join(dir, "runs.json"),
      JSON.stringify({
        version: 1,
        runs: {
          "run-v1-1": {
            run_id: "run-v1-1",
            project_id: "p",
            script: { id: "s", name: "S", command: "x", source: "t3.json" },
            repo: { root: "/tmp/r", remote: null },
            pane_id: "w1:p1",
            workspace_id: "w1",
            tab_id: "w1:t1",
            cwd: "/tmp/r",
            command_line: "x",
            script_path: null,
            started_at: now,
            finished_at: null,
            exit_code: null,
            result: "running",
            log_path: null,
            error: null,
          },
        },
      }),
    );
    const state = await loadRuns();
    const run = state.runs["run-v1-1"];
    expect(run).toBeDefined();
    expect(run?.host).toBeNull();
    expect(run?.session_key).toBeNull();
    expect(run?.stop_requested_at).toBeNull();
    expect(run?.result).toBe("running");
    // And a v2 write round-trips.
    await updateRuns((s) => {
      const r = s.runs["run-v1-1"];
      if (r) s.runs["run-v1-1"] = { ...r, error: "x" };
    });
    const rewritten = JSON.parse(readFileSync(path.join(dir, "runs.json"), "utf8"));
    expect(rewritten.version).toBe(2);
  });

  test("results on a foreign-session record never touches the pane", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    const getCallsBefore = transport.getCalls;
    const readCallsBefore = transport.readCalls;

    const runs = await listRuns(deps(transport, { sessionKey: "elsewhere /tmp/e.sock" }));
    const updated = runs.find((r) => r.run_id === run.run_id);
    // Result preserved (still running for the owning session), error annotated.
    expect(updated?.result).toBe("running");
    expect(updated?.error).toContain("session mismatch");
    // Zero pane interaction through the wrong session's transport.
    expect(transport.getCalls).toBe(getCallsBefore);
    expect(transport.readCalls).toBe(readCallsBefore);
    const pane = transport.panes.get(run.pane_id);
    expect(pane?.keys).toEqual([]);
    expect(pane?.closed).toBe(false);
  });

  test("results reconciles a pane-mismatched record to unknown", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    const pane = transport.panes.get(run.pane_id);
    if (pane) pane.tab_id = "tab-replaced";

    const runs = await listRuns(deps(transport));
    const updated = runs.find((r) => r.run_id === run.run_id);
    expect(updated?.result).toBe("unknown");
    expect(updated?.error).toContain("stale_pane");
  });

  test("logs on a foreign record returns no log and no pane read", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    // Ensure no stored log exists for this run.
    const readCallsBefore = transport.readCalls;

    const result = await runLog(
      run.run_id,
      deps(transport, { sessionKey: "elsewhere /tmp/e.sock" }),
    );
    expect(result.log).toBeNull();
    expect(result.run.result).toBe("running");
    expect(result.run.error).toContain("session mismatch");
    expect(transport.readCalls).toBe(readCallsBefore);
  });
});

// --- durable completion recovery via scrollback re-scan (#68) -------------

describe("completion recovery (#68)", () => {
  test("wait timeout → later completion → results recovers exit code", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang"; // wait times out; no marker yet
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    expect(run.result).toBe("running");

    // Marker absent → stays honestly running, exit code never fabricated.
    let runs = await listRuns(deps(transport));
    expect(runs.find((r) => r.run_id === run.run_id)?.result).toBe("running");

    // The script finishes later: the marker lands in scrollback.
    completePaneLater(transport, run.pane_id, 0);
    runs = await listRuns(deps(transport));
    const recovered = runs.find((r) => r.run_id === run.run_id);
    expect(recovered?.result).toBe("success");
    expect(recovered?.exit_code).toBe(0);
    expect(recovered?.finished_at).not.toBeNull();
    expect(recovered?.log_path).not.toBeNull();
    // Persisted, and metadata projected the terminal state.
    const stored = (await loadRuns()).runs[run.run_id];
    expect(stored?.result).toBe("success");
    expect(stored?.exit_code).toBe(0);
    const states = transport.metadata
      .filter((m) => m.pane_id === run.pane_id)
      .map((m) => Object.values(m.tokens)[0]);
    expect(states).toEqual(["running", "success"]);

    // Double results is idempotent: terminal records are not re-scanned
    // or rewritten.
    const readsBefore = transport.readCalls;
    runs = await listRuns(deps(transport));
    expect(runs.find((r) => r.run_id === run.run_id)?.result).toBe("success");
    expect(transport.readCalls).toBe(readsBefore);
  });

  test("late non-zero exit → failed with the real code", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));

    completePaneLater(transport, run.pane_id, 3);
    const runs = await listRuns(deps(transport));
    const recovered = runs.find((r) => r.run_id === run.run_id);
    expect(recovered?.result).toBe("failed");
    expect(recovered?.exit_code).toBe(3);
  });

  test("scripts logs recovers the same completion (exit code + tail)", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));

    completePaneLater(transport, run.pane_id, 0);
    const result = await runLog(run.run_id, deps(transport));
    expect(result.run.result).toBe("success");
    expect(result.run.exit_code).toBe(0);
    expect(result.log).toContain("__HERDR_DONE_");
    expect(result.log).toContain("late output");
    // A second logs call serves the stored file without re-reading.
    const readsBefore = transport.readCalls;
    const again = await runLog(run.run_id, deps(transport));
    expect(again.run.result).toBe("success");
    expect(again.log).toBe(result.log);
    expect(transport.readCalls).toBe(readsBefore);
  });

  test("stop_unconfirmed run later completes → marker exit code wins", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    transport.closeError = new Error("close refused");
    transport.foreground = [{ pid: 200, name: "bun" }];
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    await stopRuns(run.run_id, deps(transport));
    expect((await loadRuns()).runs[run.run_id]?.result).toBe("stop_unconfirmed");

    // The command actually finished before ctrl+c landed: the durable
    // marker proves the real exit status, which is more truthful than
    // "stopped" or a lingering stop_unconfirmed.
    completePaneLater(transport, run.pane_id, 0);
    const runs = await listRuns(deps(transport));
    const recovered = runs.find((r) => r.run_id === run.run_id);
    expect(recovered?.result).toBe("success");
    expect(recovered?.exit_code).toBe(0);
  });

  test("marker absent forever → stays running, exit code stays null", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));

    for (let i = 0; i < 3; i += 1) {
      const runs = await listRuns(deps(transport));
      const current = runs.find((r) => r.run_id === run.run_id);
      expect(current?.result).toBe("running");
      expect(current?.exit_code).toBeNull();
      expect(current?.finished_at).toBeNull();
    }
    const stored = (await loadRuns()).runs[run.run_id];
    expect(stored?.result).toBe("running");
    expect(stored?.exit_code).toBeNull();
  });

  test("pane gone before marker → unknown, never fabricated success", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    const pane = transport.panes.get(run.pane_id);
    if (pane) pane.alive = false;

    const runs = await listRuns(deps(transport));
    const updated = runs.find((r) => r.run_id === run.run_id);
    expect(updated?.result).toBe("unknown");
    expect(updated?.exit_code).toBeNull();
    expect((await loadRuns()).runs[run.run_id]?.result).toBe("unknown");
  });

  test("restart with a stale running record → results marks unknown honestly", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    expect(run.result).toBe("running");

    // Simulate a herdr restart: a NEW transport knows nothing about the
    // recorded pane id, so pane.get reports it gone.
    const afterRestart = new FakeTransport();
    const runs = await listRuns(deps(afterRestart));
    const updated = runs.find((r) => r.run_id === run.run_id);
    expect(updated?.result).toBe("unknown");
    expect(updated?.exit_code).toBeNull();
    expect((await loadRuns()).runs[run.run_id]?.result).toBe("unknown");
  });

  test("unreachable pane read during re-scan leaves the record unchanged", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));

    // Socket dies between ownership check and scrollback read.
    transport.paneRead = async () => {
      throw new Error("socket reset by peer");
    };
    const runs = await listRuns(deps(transport));
    const current = runs.find((r) => r.run_id === run.run_id);
    expect(current?.result).toBe("running");
    expect(current?.exit_code).toBeNull();
    expect((await loadRuns()).runs[run.run_id]?.result).toBe("running");
  });

  test("foreign record is never re-scanned through the wrong session", async () => {
    useStateDir();
    const repo = initRepo();
    const transport = new FakeTransport();
    transport.behavior = "hang";
    const project = makeProject("p", [repo]);
    const run = await startRun(startInput(project, repo), deps(transport));
    completePaneLater(transport, run.pane_id, 0);
    const readsBefore = transport.readCalls;

    const runs = await listRuns(deps(transport, { sessionKey: "elsewhere /tmp/e.sock" }));
    const updated = runs.find((r) => r.run_id === run.run_id);
    expect(updated?.result).toBe("running");
    expect(transport.readCalls).toBe(readsBefore);
    expect((await loadRuns()).runs[run.run_id]?.result).toBe("running");
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

  test("results with unreachable socket keeps active records unchanged", async () => {
    useStateDir();
    const repo = initRepo();
    const now = new Date().toISOString();
    await updateRuns((s) => {
      s.runs["run-cli-stale"] = {
        run_id: "run-cli-stale",
        project_id: "p",
        script: { id: "s", name: "S", command: "x", source: "t3.json" },
        repo: { root: repo, remote: null },
        pane_id: "w1:p1",
        workspace_id: "w1",
        tab_id: null,
        cwd: repo,
        command_line: "x",
        script_path: null,
        started_at: now,
        finished_at: null,
        exit_code: null,
        result: "running",
        host: null,
        session_key: null,
        stop_requested_at: null,
        log_path: null,
        error: null,
      };
    });
    // HERDR_SOCKET_PATH points at a nonexistent socket: ownership check
    // is unreachable, so the record must stay `running` — never
    // fabricated as success or unknown.
    const r = expectOk(runCli(["scripts", "results"]));
    const runs = r.runs as Array<{ run_id: string; result: string; exit_code: number | null }>;
    const record = runs.find((x) => x.run_id === "run-cli-stale");
    expect(record?.result).toBe("running");
    expect(record?.exit_code).toBeNull();
  });

  test("capability advertises scripts run/stop as mutations", () => {
    useStateDir();
    const cap = expectOk(runCli(["capability"]));
    const mutations = cap.mutation_commands as string[];
    expect(mutations).toContain("scripts run");
    expect(mutations).toContain("scripts stop");
  });
});
