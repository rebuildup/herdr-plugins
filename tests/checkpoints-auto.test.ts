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
import { sessionKeyFor } from "../plugins/checkpoints/src/state";
import { herdrSocketEndpoint, testEnv } from "./helpers/test-env";

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const savedConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "checkpoints-auto-test-"));
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
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

const PLUGIN = path.join(__dirname, "..", "plugins", "checkpoints");
const CLI = path.join(PLUGIN, "src", "cli.ts");
const HOOK = path.join(PLUGIN, "src", "hook.ts");

const DEAD_SOCKET = path.join(tempDir(), "no-such-herdr.sock");

function baseEnv(extra?: Record<string, string>): Record<string, string> {
  return testEnv({
    HERDR_PLUGIN_STATE_DIR: process.env.HERDR_PLUGIN_STATE_DIR,
    HERDR_PLUGIN_CONFIG_DIR: process.env.HERDR_PLUGIN_CONFIG_DIR,
    HERDR_SOCKET_PATH: DEAD_SOCKET,
    ...extra,
  });
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

function parseOut(stdout: string, stderr: string, status: number): CliResult {
  let json: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    /* non-JSON */
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
    env: baseEnv(extraEnv),
    timeout: 30_000,
  });
  return parseOut(result.stdout, result.stderr, result.status ?? -1);
}

function runCliAsync(args: string[], extraEnv?: Record<string, string>): Promise<CliResult> {
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
    child.on("close", (code) => resolve(parseOut(stdout, stderr, code ?? -1)));
  });
}

interface FakeAgent {
  pane_id: string;
  agent_status: string;
  state_change_seq?: number;
  agent_session?: { source?: string; agent?: string; kind?: string; value?: string } | null;
  cwd?: string;
}

interface FakePane {
  pane_id: string;
  cwd?: string;
}

interface MetadataCall {
  pane_id: string;
  source?: string;
  tokens?: Record<string, string | null>;
}

interface FakeState {
  panes: FakePane[];
  agents: FakeAgent[];
  /** When true, session.snapshot answers an error (unreachable sim). */
  failSnapshot?: boolean;
}

/**
 * Fake herdr socket: `session.snapshot` returns the live-mutated
 * panes/agents; `pane.report_metadata` calls are recorded. Everything
 * else answers `{}`.
 */
async function fakeHerdr(state: FakeState): Promise<{
  socketPath: string;
  metadata: MetadataCall[];
  close: () => Promise<void>;
}> {
  const socketPath = path.join(tempDir(), "fake-herdr.sock");
  fakeStates.set(socketPath, state);
  const metadata: MetadataCall[] = [];
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
        let result: unknown = {};
        let error: { code: string; message: string } | undefined;
        if (message.method === "session.snapshot") {
          if (state.failSnapshot) {
            error = { code: "server_unavailable", message: "snapshot disabled" };
          } else {
            result = { snapshot: { panes: state.panes, agents: state.agents } };
          }
        } else if (message.method === "pane.report_metadata") {
          metadata.push(message.params as unknown as MetadataCall);
        }
        conn.write(
          `${JSON.stringify(error ? { id: message.id, error } : { id: message.id, result })}\n`,
        );
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(herdrSocketEndpoint(socketPath), () => resolveListen());
  });
  return {
    socketPath,
    metadata,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

const AGENT_SESSION = { source: "test", agent: "claude", kind: "session_id", value: "s1" };

function agentStatusEvent(paneId: string, status: string): Record<string, string> {
  return {
    HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane_agent_status_changed",
      data: { type: "pane_agent_status_changed", pane_id: paneId, agent_status: status },
    }),
  };
}

// Async spawn: the fake herdr socket lives in this process's event loop,
// so a blocking spawnSync would deadlock the snapshot request.
function runHook(extraEnv: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: baseEnv(extraEnv) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(parseOut(stdout, stderr, code ?? -1)));
  });
}

function useStateDir(): string {
  const dir = tempDir();
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "config");
  return dir;
}

function stateFile(): string {
  return path.join(process.env.HERDR_PLUGIN_STATE_DIR as string, "state.json");
}

function readAutoState(): Record<
  string,
  Record<string, { last_status?: string; pending?: Record<string, unknown> }>
> {
  const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as {
    auto?: Record<string, Record<string, { last_status?: string; pending?: unknown }>>;
  };
  return (raw.auto ?? {}) as Record<
    string,
    Record<string, { last_status?: string; pending?: Record<string, unknown> }>
  >;
}

function autoEntriesFor(socketPath: string) {
  return readAutoState()[sessionKeyFor({ socketPath })] ?? {};
}

const t = (name: string, fn: () => void | Promise<void>) => test(name, fn, 30_000);

describe("checkpoints auto-capture", () => {
  t("working→idle hook pends lazily; next CLI drains an auto checkpoint", async () => {
    useStateDir();
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "work-unit output\n");

    const fake = await fakeHerdr({
      panes: [{ pane_id: "w1:p1", cwd: repo }],
      agents: [
        {
          pane_id: "w1:p1",
          agent_status: "working",
          state_change_seq: 1,
          agent_session: AGENT_SESSION,
        },
      ],
    });
    try {
      const env = { HERDR_SOCKET_PATH: fake.socketPath };
      // First delivery observes working (baseline), second observes the
      // settle transition — the hook reads status from the snapshot.
      expect((await runHook({ ...env, ...agentStatusEvent("w1:p1", "working") })).status).toBe(0);
      settleWorkingAgent(fake);
      expect((await runHook({ ...env, ...agentStatusEvent("w1:p1", "idle") })).status).toBe(0);

      // Lazy contract: state holds a pending mark, but no checkpoint or
      // hidden ref exists yet.
      const entries = autoEntriesFor(fake.socketPath);
      expect(entries["w1:p1"]?.pending).toBeDefined();
      expect(git(repo, ["for-each-ref", "refs/herdr-plugins/checkpoints"]).trim()).toBe("");

      // Next CLI invocation drains: list captures the work unit.
      const listed = await runCliAsync(["list", "--socket", fake.socketPath], {
        HERDR_SOCKET_PATH: fake.socketPath,
      });
      const payload = listed.json as Record<string, unknown>;
      expect(listed.status).toBe(0);
      const autoCaptures = payload.auto_captures as Record<string, unknown>;
      expect(autoCaptures.captured).toHaveLength(1);
      const ckpts = payload.checkpoints as Record<string, unknown>[];
      expect(ckpts).toHaveLength(1);
      expect(ckpts[0]?.kind).toBe("auto");
      expect(ckpts[0]?.id).toBe((autoCaptures.captured as string[])[0]);

      // Pending mark consumed; metadata tokens projected to the pane.
      expect(autoEntriesFor(fake.socketPath)["w1:p1"]?.pending).toBeUndefined();
      const meta = fake.metadata.find((m) => m.pane_id === "w1:p1");
      expect(meta?.source).toBe("rebuildup.checkpoints");
      expect(meta?.tokens?.checkpoint_latest).toBe(String(ckpts[0]?.id));
      expect(meta?.tokens?.checkpoint_count).toBe("1");

      // The captured tree holds the work-unit state.
      const commit = String(ckpts[0]?.commit);
      expect(git(repo, ["show", `${commit}:a.txt`])).toBe("work-unit output\n");
    } finally {
      await fake.close();
    }
  });

  t("non working→settle transitions never pend a capture", async () => {
    useStateDir();
    const repo = initRepo();
    const fake = await fakeHerdr({
      panes: [{ pane_id: "w1:p1", cwd: repo }],
      agents: [
        {
          pane_id: "w1:p1",
          agent_status: "idle",
          state_change_seq: 1,
          agent_session: AGENT_SESSION,
        },
      ],
    });
    try {
      const env = { HERDR_SOCKET_PATH: fake.socketPath };
      // First-ever observation is idle: no proven working edge.
      expect((await runHook({ ...env, ...agentStatusEvent("w1:p1", "idle") })).status).toBe(0);
      // idle → idle is not a transition.
      expect((await runHook({ ...env, ...agentStatusEvent("w1:p1", "idle") })).status).toBe(0);
      expect(autoEntriesFor(fake.socketPath)["w1:p1"]?.pending).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  t("returning to working clears the pending mark", async () => {
    useStateDir();
    const repo = initRepo();
    const fake = await fakeHerdr({
      panes: [{ pane_id: "w1:p1", cwd: repo }],
      agents: [
        {
          pane_id: "w1:p1",
          agent_status: "working",
          state_change_seq: 1,
          agent_session: AGENT_SESSION,
        },
      ],
    });
    try {
      const env = { HERDR_SOCKET_PATH: fake.socketPath };
      await runHook({ ...env, ...agentStatusEvent("w1:p1", "working") });
      settleWorkingAgent(fake);
      await runHook({ ...env, ...agentStatusEvent("w1:p1", "idle") });
      expect(autoEntriesFor(fake.socketPath)["w1:p1"]?.pending).toBeDefined();

      // Agent starts a new work unit before any CLI ran: mark dropped.
      setAgent(fake, "w1:p1", { agent_status: "working", state_change_seq: 3 });
      await runHook({ ...env, ...agentStatusEvent("w1:p1", "working") });
      expect(autoEntriesFor(fake.socketPath)["w1:p1"]?.pending).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  t("stale generation marks are skipped, never captured", async () => {
    useStateDir();
    const repo = initRepo();
    const fake = await fakeHerdr({
      panes: [{ pane_id: "w1:p1", cwd: repo }],
      agents: [
        {
          pane_id: "w1:p1",
          agent_status: "working",
          state_change_seq: 1,
          agent_session: AGENT_SESSION,
        },
      ],
    });
    try {
      const env = { HERDR_SOCKET_PATH: fake.socketPath };
      await runHook({ ...env, ...agentStatusEvent("w1:p1", "working") });
      settleWorkingAgent(fake);
      await runHook({ ...env, ...agentStatusEvent("w1:p1", "idle") });
      expect(autoEntriesFor(fake.socketPath)["w1:p1"]?.pending).toBeDefined();

      // Generation advanced without a hook delivery (seq 2 → 4): the
      // mark is stale and must not produce a checkpoint.
      setAgent(fake, "w1:p1", { agent_status: "idle", state_change_seq: 4 });
      const listed = await runCliAsync(["list", "--socket", fake.socketPath], {
        HERDR_SOCKET_PATH: fake.socketPath,
      });
      expect(listed.status).toBe(0);
      const autoCaptures = listed.json?.auto_captures as Record<string, unknown>;
      expect(autoCaptures.captured).toHaveLength(0);
      expect(autoCaptures.skipped).toEqual([{ pane_id: "w1:p1", reason: "stale_generation" }]);
      expect(listed.json?.checkpoints).toEqual([]);
      expect(git(repo, ["for-each-ref", "refs/herdr-plugins/checkpoints"]).trim()).toBe("");
    } finally {
      await fake.close();
    }
  });

  t("agent_session mismatch is treated as a new generation", async () => {
    useStateDir();
    const repo = initRepo();
    const fake = await fakeHerdr({
      panes: [{ pane_id: "w1:p1", cwd: repo }],
      agents: [
        {
          pane_id: "w1:p1",
          agent_status: "working",
          state_change_seq: 2,
          agent_session: AGENT_SESSION,
        },
      ],
    });
    try {
      const env = { HERDR_SOCKET_PATH: fake.socketPath };
      await runHook({ ...env, ...agentStatusEvent("w1:p1", "working") });
      settleWorkingAgent(fake);
      await runHook({ ...env, ...agentStatusEvent("w1:p1", "idle") });

      // Same seq but a different agent session: stale mark.
      setAgent(fake, "w1:p1", {
        agent_status: "idle",
        state_change_seq: 2,
        agent_session: { ...AGENT_SESSION, value: "s2" },
      });
      const listed = await runCliAsync(["list", "--socket", fake.socketPath], {
        HERDR_SOCKET_PATH: fake.socketPath,
      });
      const autoCaptures = listed.json?.auto_captures as Record<string, unknown>;
      expect(autoCaptures.captured).toHaveLength(0);
      expect(autoCaptures.skipped).toEqual([{ pane_id: "w1:p1", reason: "stale_generation" }]);
    } finally {
      await fake.close();
    }
  });

  t("pane.closed drops pending marks", async () => {
    useStateDir();
    const repo = initRepo();
    const fake = await fakeHerdr({
      panes: [{ pane_id: "w1:p1", cwd: repo }],
      agents: [
        {
          pane_id: "w1:p1",
          agent_status: "working",
          state_change_seq: 1,
          agent_session: AGENT_SESSION,
        },
      ],
    });
    try {
      const env = { HERDR_SOCKET_PATH: fake.socketPath };
      await runHook({ ...env, ...agentStatusEvent("w1:p1", "working") });
      settleWorkingAgent(fake);
      await runHook({ ...env, ...agentStatusEvent("w1:p1", "idle") });
      expect(autoEntriesFor(fake.socketPath)["w1:p1"]?.pending).toBeDefined();

      const closed = await runHook({
        ...env,
        HERDR_PLUGIN_EVENT: "pane.closed",
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          event: "pane_closed",
          data: { type: "pane_closed", pane_id: "w1:p1" },
        }),
      });
      expect(closed.status).toBe(0);
      expect(autoEntriesFor(fake.socketPath)["w1:p1"]).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  t("unreachable session keeps marks pending for a later drain", async () => {
    useStateDir();
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "later\n");
    const fake = await fakeHerdr({
      panes: [{ pane_id: "w1:p1", cwd: repo }],
      agents: [
        {
          pane_id: "w1:p1",
          agent_status: "working",
          state_change_seq: 1,
          agent_session: AGENT_SESSION,
        },
      ],
    });
    try {
      const env = { HERDR_SOCKET_PATH: fake.socketPath };
      await runHook({ ...env, ...agentStatusEvent("w1:p1", "working") });
      settleWorkingAgent(fake);
      await runHook({ ...env, ...agentStatusEvent("w1:p1", "idle") });

      // Snapshot failing: drain reports session_unreachable, mark survives.
      const state = fakeStates.get(fake.socketPath);
      if (state) state.failSnapshot = true;
      const unreachable = await runCliAsync(["list", "--socket", fake.socketPath], {
        HERDR_SOCKET_PATH: fake.socketPath,
      });
      expect(unreachable.status).toBe(0);
      const unreachableAuto = unreachable.json?.auto_captures as Record<string, unknown>;
      expect(unreachableAuto.session_unreachable).toBe(true);
      expect(autoEntriesFor(fake.socketPath)["w1:p1"]?.pending).toBeDefined();

      // Snapshot back: the same mark drains normally.
      if (state) state.failSnapshot = false;
      const listed = await runCliAsync(["list", "--socket", fake.socketPath], {
        HERDR_SOCKET_PATH: fake.socketPath,
      });
      const autoCaptures = listed.json?.auto_captures as Record<string, unknown>;
      expect(autoCaptures.captured).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  t("create --auto records kind=auto; explicit create supersedes pending", async () => {
    useStateDir();
    const repo = initRepo();
    writeFileSync(path.join(repo, "a.txt"), "manual-ish\n");

    const manual = runCli(["create", "--repo", repo]);
    expect(manual.status).toBe(0);
    const manualEntry = manual.json?.checkpoint as Record<string, unknown>;
    expect(manualEntry.kind).toBe("manual");

    const auto = runCli(["create", "--repo", repo, "--auto"]);
    expect(auto.status).toBe(0);
    const autoEntry = auto.json?.checkpoint as Record<string, unknown>;
    expect(autoEntry.kind).toBe("auto");
  });

  t("hook exits 0 and fast when the session is unreachable", async () => {
    useStateDir();
    const started = Date.now();
    const result = await runHook({
      HERDR_SOCKET_PATH: DEAD_SOCKET,
      ...agentStatusEvent("w1:p9", "idle"),
    });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    // No snapshot → no mark recorded, no state corruption.
    expect(existsSync(stateFile())).toBe(false);
  });
});

// --- fake-state helpers (mutate the object the server reads live) -------

const fakeStates = new Map<string, FakeState>();

function settleWorkingAgent(fake: { socketPath: string }): void {
  const state = fakeStates.get(fake.socketPath);
  const agent = state?.agents.find((a) => a.pane_id === "w1:p1");
  if (agent) {
    agent.agent_status = "idle";
    agent.state_change_seq = (agent.state_change_seq ?? 0) + 1;
  }
}

function setAgent(fake: { socketPath: string }, paneId: string, patch: Partial<FakeAgent>): void {
  const state = fakeStates.get(fake.socketPath);
  const agent = state?.agents.find((a) => a.pane_id === paneId);
  if (agent) Object.assign(agent, patch);
}
