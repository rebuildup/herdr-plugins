import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionSnapshot } from "../packages/herdr-client/src/index";
import {
  executeHandoff,
  type HandoffTransport,
  reconcileRemoteDelivered,
} from "../plugins/handoff/src/execute";
import {
  buildTransferIdentity,
  createRecord,
  type HandoffRecord,
} from "../plugins/handoff/src/model";
import {
  BUNDLE_CONTRACT,
  buildPortableBundle,
  bundleFilePath,
  listMachines,
  probeRemote,
  RemoteError,
  type RunResult,
  remoteCliTransport,
  remoteInfoOf,
  resolveMachine,
  type SavedMachine,
} from "../plugins/handoff/src/remote";
import { loadState, updateState } from "../plugins/handoff/src/state";

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-remote-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (savedStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir;
});

// --- fixtures -------------------------------------------------------------------

const MACHINE: SavedMachine = {
  id: "m1",
  label: "Lab Box",
  target: "lab.example.com",
  session: "agents",
  enabled: true,
};

const MACHINE_JSON = JSON.stringify([
  {
    id: "m1",
    label: "Lab Box",
    target: "lab.example.com",
    session: "agents",
    enabled: true,
    selected: false,
  },
  {
    id: "m2",
    label: "Off Box",
    target: "off.example.com",
    session: "default",
    enabled: false,
    selected: false,
  },
]);

function envelope(result: unknown): string {
  return `${JSON.stringify({ id: "cli:test", result })}\n`;
}

function ok(stdout: string): RunResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}

function failRun(stderr: string, code = 1): RunResult {
  return { code, stdout: "", stderr, timedOut: false };
}

/** Remote session snapshot as returned inside `api snapshot` result. */
function remoteSnapshot(): Record<string, unknown> {
  return {
    session: { name: "agents" },
    workspaces: [{ workspace_id: "rw1" }],
    tabs: [{ tab_id: "rw1:t1", workspace_id: "rw1" }],
    panes: [{ pane_id: "rw1:p1", workspace_id: "rw1", tab_id: "rw1:t1", cwd: "/remote/repo" }],
    agents: [
      {
        pane_id: "rw1:p9",
        agent: "claude",
        agent_status: "working",
        state_change_seq: 3,
      },
    ],
    version: "0.9.5",
    protocol: 22,
  };
}

/** Fake runner dispatching on argv; records every invocation. */
function fakeRunner(
  handlers: {
    match: (args: string[]) => boolean;
    run: (args: string[]) => RunResult;
  }[],
): { runner: (args: string[], o: { timeoutMs: number }) => Promise<RunResult>; calls: string[][] } {
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push([...args]);
    for (const h of handlers) {
      if (h.match(args)) return h.run(args);
    }
    return failRun(`unexpected args: ${args.join(" ")}`, 2);
  };
  return { runner, calls };
}

function machineListHandler() {
  return {
    match: (args: string[]) => args[0] === "machine" && args[1] === "list",
    run: () => ok(MACHINE_JSON),
  };
}

function snapshotHandler(snapshot: Record<string, unknown> = remoteSnapshot()) {
  return {
    match: (args: string[]) => args.includes("api") && args.includes("snapshot"),
    run: (args: string[]) => {
      void args;
      return ok(envelope({ snapshot, type: "session_snapshot" }));
    },
  };
}

// --- local fixtures for executeHandoff --------------------------------------------

const SESSION_KEY = "testhost /tmp/herdr.sock";

function localSnapshot(): SessionSnapshot {
  return {
    session: { name: "default" },
    panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo" }],
    agents: {
      "w1:p1": {
        agent: "claude",
        agent_status: "working",
        state_change_seq: 7,
        agent_session: { agent: "claude", kind: "session", value: "sess-1" },
      },
    },
  };
}

function makeRecord(): HandoffRecord {
  return createRecord({
    transfer: buildTransferIdentity({
      host: "testhost",
      herdrSession: "default",
      sessionKey: SESSION_KEY,
      pane: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo" },
      agent: {
        agent: "claude",
        agent_status: "working",
        state_change_seq: 7,
        agent_session: { agent: "claude", kind: "session", value: "sess-1" },
      },
    }),
    strategy: "portable_context",
    payload: {
      refs: [
        {
          kind: "conversation_session",
          plugin: "rebuildup.conversations",
          session_key: "claude:sess-1",
        },
        { kind: "external", target: "uri", value: "https://example.com/spec" },
      ],
      excerpt: { text: "continue the migration", truncated: false, source: "note" },
      requirements: ["keep API stable"],
    },
  });
}

function localTransport(): HandoffTransport {
  return {
    snapshot: async () => localSnapshot(),
    workspaceCreate: async () => {
      throw new Error("local transport must not create surfaces in remote tests");
    },
    tabCreate: async () => {
      throw new Error("local transport must not create surfaces in remote tests");
    },
    agentStart: async () => {
      throw new Error("unused");
    },
    agentGet: async () => {
      throw new Error("unused");
    },
    agentPrompt: async () => {
      throw new Error("unused");
    },
    agentWait: async () => {
      throw new Error("unused");
    },
    paneClose: async () => {
      throw new Error("unused");
    },
  };
}

async function seed(record: HandoffRecord): Promise<void> {
  await updateState((s) => {
    s.handoffs[record.id] = record;
  });
}

// --- tests ------------------------------------------------------------------------

describe("machine discovery", () => {
  test("listMachines parses `herdr machine list --json`", async () => {
    const { runner, calls } = fakeRunner([machineListHandler()]);
    const machines = await listMachines(runner);
    expect(calls[0]).toEqual(["machine", "list", "--json"]);
    expect(machines).toHaveLength(2);
    expect(machines[0]).toMatchObject({
      id: "m1",
      label: "Lab Box",
      target: "lab.example.com",
      session: "agents",
      enabled: true,
    });
    expect(machines[1]?.enabled).toBe(false);
  });

  test("listMachines fails honestly on non-JSON output", async () => {
    const { runner } = fakeRunner([{ match: () => true, run: () => ok("not json") }]);
    await expect(listMachines(runner)).rejects.toThrow(RemoteError);
  });

  test("resolveMachine matches id exactly and label case-insensitively", () => {
    const machines = [MACHINE];
    expect(resolveMachine("m1", machines).id).toBe("m1");
    expect(resolveMachine("lab box", machines).id).toBe("m1");
    expect(() => resolveMachine("nope", machines)).toThrow(/unknown remote machine/);
  });

  test("resolveMachine rejects ambiguous labels", () => {
    const dup: SavedMachine[] = [
      { ...MACHINE, id: "a" },
      { ...MACHINE, id: "b" },
    ];
    expect(() => resolveMachine("Lab Box", dup)).toThrow(/multiple machines/);
  });
});

describe("remote probe", () => {
  test("probeRemote returns normalized snapshot + server version", async () => {
    const { runner, calls } = fakeRunner([machineListHandler(), snapshotHandler()]);
    const probe = await probeRemote("lab box", { runner });
    expect(probe.machine.id).toBe("m1");
    expect(probe.server_version).toBe("0.9.5");
    expect(probe.protocol).toBe(22);
    // agents array normalized to pane_id map
    expect(probe.snapshot.agents?.["rw1:p9"]?.agent_status).toBe("working");
    expect(calls.some((c) => c.join(" ").includes("--machine m1 api snapshot"))).toBe(true);
  });

  test("probeRemote classifies unreachable machines", async () => {
    const { runner } = fakeRunner([
      machineListHandler(),
      {
        match: (args) => args.includes("api"),
        run: () =>
          failRun("ssh: connect to host lab.example.com port 22: Operation timed out", 255),
      },
    ]);
    await expect(probeRemote("m1", { runner })).rejects.toMatchObject({
      kind: "remote_unreachable",
    });
  });

  test("probeRemote rejects disabled machines before connecting", async () => {
    const { runner, calls } = fakeRunner([machineListHandler()]);
    await expect(probeRemote("Off Box", { runner })).rejects.toMatchObject({
      kind: "machine_disabled",
    });
    expect(calls.filter((c) => c.includes("--machine"))).toHaveLength(0);
  });

  test("probeRemote rejects unknown selectors", async () => {
    const { runner } = fakeRunner([machineListHandler()]);
    await expect(probeRemote("ghost", { runner })).rejects.toMatchObject({
      kind: "machine_not_found",
    });
  });

  test("remoteCliTransport maps calls to `herdr --machine` argv", async () => {
    const { runner, calls } = fakeRunner([
      {
        match: (args) => args.includes("workspace") && args.includes("create"),
        run: () =>
          ok(
            envelope({
              type: "workspace_created",
              workspace: { workspace_id: "rw9" },
              tab: { tab_id: "rw9:t1", workspace_id: "rw9" },
              root_pane: { pane_id: "rw9:p1", workspace_id: "rw9", tab_id: "rw9:t1" },
            }),
          ),
      },
      {
        match: (args) => args.includes("agent") && args.includes("start"),
        run: () =>
          ok(
            envelope({
              type: "agent_started",
              agent: { pane_id: "rw9:p1", agent_status: "idle" },
              argv: ["claude", "--resume", "s1"],
            }),
          ),
      },
      {
        match: (args) => args.includes("agent") && args.includes("get"),
        run: () => ok(envelope({ agent: { pane_id: "rw9:p1", agent_status: "working" } })),
      },
      {
        match: (args) => args.includes("agent") && args.includes("prompt"),
        run: () => ok(envelope({ type: "prompt_accepted" })),
      },
      {
        match: (args) => args.includes("agent") && args.includes("wait"),
        run: () => ok(envelope({ type: "agent_wait", reached: "done" })),
      },
      {
        match: (args) => args.includes("pane") && args.includes("close"),
        run: () => ok(envelope({ type: "pane_closed" })),
      },
      snapshotHandler(),
    ]);
    const transport = remoteCliTransport(MACHINE, { runner });

    const ws = await transport.workspaceCreate({
      cwd: "/remote/repo",
      label: "handoff x",
      focus: false,
    });
    expect(ws.root_pane.pane_id).toBe("rw9:p1");
    expect(calls.at(-1)).toEqual([
      "--machine",
      "m1",
      "workspace",
      "create",
      "--cwd",
      "/remote/repo",
      "--label",
      "handoff x",
      "--no-focus",
    ]);

    await transport.agentStart({
      name: "handoff ho-1",
      kind: "claude",
      paneId: "rw9:p1",
      args: ["--resume", "s1"],
      timeoutMs: 60_000,
    });
    const startCall = calls.at(-1) as string[];
    expect(startCall.slice(0, 9)).toEqual([
      "--machine",
      "m1",
      "agent",
      "start",
      "handoff ho-1",
      "--kind",
      "claude",
      "--pane",
      "rw9:p1",
    ]);
    expect(startCall).toContain("--timeout");
    expect(startCall.slice(-3)).toEqual(["--", "--resume", "s1"]);

    const agent = await transport.agentGet("rw9:p1");
    expect(agent.agent_status).toBe("working");

    await transport.agentPrompt("rw9:p1", "hello\nworld");
    expect(calls.at(-1)).toEqual(["--machine", "m1", "agent", "prompt", "rw9:p1", "hello\nworld"]);

    await transport.agentWait("rw9:p1", { until: ["idle", "done"], timeoutMs: 5_000 }, 40_000);
    const waitCall = calls.at(-1) as string[];
    expect(waitCall).toContain("--until");
    expect(waitCall).toContain("--timeout");

    await transport.paneClose("rw9:p1");
    expect(calls.at(-1)).toEqual(["--machine", "m1", "pane", "close", "rw9:p1"]);

    const snap = await transport.snapshot();
    expect(snap.agents?.["rw1:p9"]).toBeDefined();
  });

  test("remoteCliTransport surfaces remote error envelopes", async () => {
    const { runner } = fakeRunner([
      {
        match: () => true,
        run: () =>
          failRun(
            `${JSON.stringify({ id: "cli:x", error: { code: "agent_pane_busy", message: "pane busy" } })}\n`,
          ),
      },
    ]);
    const transport = remoteCliTransport(MACHINE, { runner });
    await expect(transport.agentGet("rw1:p1")).rejects.toMatchObject({
      kind: "remote_agent_pane_busy",
    });
  });
});

describe("portable bundle", () => {
  test("buildPortableBundle marks plugin-state refs non-resolvable remotely", () => {
    const record = makeRecord();
    const remote = remoteInfoOf({
      machine: MACHINE,
      snapshot: remoteSnapshot() as unknown as SessionSnapshot,
      server_version: "0.9.5",
      protocol: 22,
    });
    const bundle = buildPortableBundle(record, remote, new Date("2026-01-01T00:00:00Z"));
    expect(bundle.contract).toBe(BUNDLE_CONTRACT);
    expect(bundle.handoff_id).toBe(record.id);
    expect(bundle.remote.machine_id).toBe("m1");
    expect(bundle.payload.refs).toHaveLength(2);
    expect(bundle.payload.refs[0]?.portability).toBe("plugin_state");
    expect(bundle.payload.refs[0]?.resolvable_on_remote).toBe(false);
    expect(bundle.payload.refs[1]?.portability).toBe("external");
    expect(bundle.payload.refs[1]?.resolvable_on_remote).toBe(true);
    expect(bundle.payload.excerpt?.text).toBe("continue the migration");
    expect(bundle.instructions.join(" ")).toContain("plugin_state");
  });
});

describe("remote execute", () => {
  test("executeHandoff --remote delivers via remote transport and writes bundle", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const record = makeRecord();
    await seed(record);

    const remoteSnap = remoteSnapshot() as unknown as SessionSnapshot;
    const probe = {
      machine: MACHINE,
      snapshot: remoteSnap,
      server_version: "0.9.5",
      protocol: 22,
    };

    const { runner, calls } = fakeRunner([
      {
        match: (args) => args.includes("workspace") && args.includes("create"),
        run: () =>
          ok(
            envelope({
              type: "workspace_created",
              workspace: { workspace_id: "rw9" },
              tab: { tab_id: "rw9:t1", workspace_id: "rw9" },
              root_pane: { pane_id: "rw9:p1", workspace_id: "rw9", tab_id: "rw9:t1" },
            }),
          ),
      },
      {
        match: (args) => args.includes("agent") && args.includes("start"),
        run: () =>
          ok(
            envelope({
              type: "agent_started",
              agent: { pane_id: "rw9:p1", agent_status: "idle", state_change_seq: 1 },
              argv: ["claude"],
            }),
          ),
      },
      {
        match: (args) => args.includes("agent") && args.includes("get"),
        run: () =>
          ok(
            envelope({
              agent: {
                pane_id: "rw9:p1",
                agent_status: "done",
                state_change_seq: 9,
                agent_session: { agent: "claude", kind: "session", value: "remote-sess" },
              },
            }),
          ),
      },
      {
        match: (args) => args.includes("agent") && args.includes("prompt"),
        run: () => ok(envelope({ type: "prompt_accepted" })),
      },
    ]);
    const remoteTransport = remoteCliTransport(MACHINE, { runner });

    const result = await executeHandoff(
      record.id,
      { remote: "m1", waitMs: 1_000 },
      {
        transport: localTransport(),
        sessionKey: SESSION_KEY,
        remote: { probe, transport: remoteTransport },
      },
    );

    expect(["delivered", "done"]).toContain(result.outcome);
    const exec = result.record.execution;
    expect(exec?.remote?.machine_id).toBe("m1");
    expect(exec?.remote?.session).toBe("agents");
    expect(exec?.remote?.server_version).toBe("0.9.5");
    expect(exec?.bundle?.contract).toBe(BUNDLE_CONTRACT);
    expect(exec?.bundle?.plugin_state_refs).toBe(1);
    expect(exec?.bundle?.external_refs).toBe(1);
    expect(exec?.target?.pane_id).toBe("rw9:p1");

    // Bundle file exists with portable payload.
    const bundlePath = bundleFilePath(record.id);
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as {
      contract: string;
      remote: { machine_id: string };
      payload: { refs: { portability: string }[] };
    };
    expect(bundle.contract).toBe(BUNDLE_CONTRACT);
    expect(bundle.remote.machine_id).toBe("m1");
    expect(bundle.payload.refs[0]?.portability).toBe("plugin_state");

    // The injected prompt carries the portability notice.
    const promptCall = calls.find((c) => c.includes("prompt"));
    expect(promptCall).toBeDefined();
    const promptText = promptCall?.at(-1) ?? "";
    expect(promptText).toContain("Cross-machine transfer");
    expect(promptText).toContain("external_ref");

    // Local transport never created a surface.
    const state = await loadState();
    expect(state.handoffs[record.id]?.status).toBe(result.record.status);
  });

  test("remote target planning uses the REMOTE snapshot", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const record = makeRecord();
    record.target = { workspace_id: "rw1" }; // exists only remotely
    await seed(record);

    const probe = {
      machine: MACHINE,
      snapshot: remoteSnapshot() as unknown as SessionSnapshot,
      server_version: "0.9.5",
      protocol: 22,
    };
    const { runner, calls } = fakeRunner([
      {
        match: (args) => args.includes("tab") && args.includes("create"),
        run: () =>
          ok(
            envelope({
              type: "tab_created",
              tab: { tab_id: "rw1:t2", workspace_id: "rw1" },
              root_pane: { pane_id: "rw1:p2", workspace_id: "rw1", tab_id: "rw1:t2" },
            }),
          ),
      },
      {
        match: (args) => args.includes("agent") && args.includes("start"),
        run: () => ok(envelope({ type: "agent_started", agent: {}, argv: [] })),
      },
      {
        match: (args) => args.includes("agent") && args.includes("get"),
        run: () => ok(envelope({ agent: { pane_id: "rw1:p2", agent_status: "working" } })),
      },
      {
        match: (args) => args.includes("agent") && args.includes("prompt"),
        run: () => ok(envelope({ type: "prompt_accepted" })),
      },
    ]);
    const remoteTransport = remoteCliTransport(MACHINE, { runner });

    const result = await executeHandoff(
      record.id,
      { remote: "m1" },
      {
        transport: localTransport(),
        sessionKey: SESSION_KEY,
        remote: { probe, transport: remoteTransport },
      },
    );

    expect(result.outcome).toBe("delivered");
    const tabCall = calls.find((c) => c.includes("tab") && c.includes("create"));
    expect(tabCall).toBeDefined();
    expect(tabCall).toContain("--workspace");
    expect(tabCall).toContain("rw1");
  });

  test("remote dry_run reports plan + remote info without mutating", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const record = makeRecord();
    await seed(record);
    const probe = {
      machine: MACHINE,
      snapshot: remoteSnapshot() as unknown as SessionSnapshot,
      server_version: "0.9.5",
      protocol: 22,
    };
    const result = await executeHandoff(
      record.id,
      { remote: "m1", dryRun: true },
      {
        transport: localTransport(),
        sessionKey: SESSION_KEY,
        remote: { probe, transport: remoteCliTransport(MACHINE, { runner: async () => ok("") }) },
      },
    );
    expect(result.outcome).toBe("dry_run");
    expect(result.remote?.machine_id).toBe("m1");
    expect(result.prompt_text).toContain("Cross-machine transfer");
    const state = await loadState();
    expect(state.handoffs[record.id]?.status).toBe("pending");
    expect(state.handoffs[record.id]?.execution).toBeUndefined();
  });
});

describe("remote reconcile", () => {
  test("reconcileRemoteDelivered observes via remote agent.get", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const record = makeRecord();
    const probe = {
      machine: MACHINE,
      snapshot: remoteSnapshot() as unknown as SessionSnapshot,
      server_version: "0.9.5",
      protocol: 22,
    };
    const { runner } = fakeRunner([
      {
        match: (args) => args.includes("agent") && args.includes("get"),
        run: () =>
          ok(
            envelope({
              agent: {
                pane_id: "rw9:p1",
                agent_status: "done",
                state_change_seq: 9,
              },
            }),
          ),
      },
    ]);
    const remoteTransport = remoteCliTransport(MACHINE, { runner });
    const remoteInfo = remoteInfoOf(probe);
    record.status = "delivered";
    record.execution = {
      decided_at: new Date().toISOString(),
      strategy_used: "portable_context",
      provider_kind: "claude",
      decision: "test",
      resume_args: null,
      target: { pane_id: "rw9:p1", workspace_id: "rw9", tab_id: "rw9:t1", created: true },
      agent: {
        name: "handoff x",
        kind: "claude",
        pane_id: "rw9:p1",
        agent_session: null,
        state_change_seq: 4,
        agent_status: "working",
      },
      prompt: { delivered_at: new Date().toISOString(), chars: 10, waited: false },
      error: null,
      cleaned_up: false,
      observed: null,
      remote: remoteInfo,
    };
    await seed(record);

    const updated = await reconcileRemoteDelivered(record.id, { transport: remoteTransport });
    expect(updated?.status).toBe("done");
    expect(updated?.execution?.observed?.agent_status).toBe("done");
  });
});
