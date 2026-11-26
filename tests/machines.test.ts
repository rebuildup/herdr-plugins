import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MachineEntry } from "../plugins/machines/src/model";
import {
  listMachines,
  probeAllMachines,
  probeMachine,
  probeMachineEntry,
  RemoteError,
  type RunResult,
  resolveMachine,
} from "../plugins/machines/src/remote";
import { loadState, recordProbe, stateFilePath } from "../plugins/machines/src/state";

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "machines-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (savedStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir;
});

// --- fixtures -------------------------------------------------------------------

const MACHINE: MachineEntry = {
  id: "m1",
  label: "Lab Box",
  target: "lab.example.com",
  session: "agents",
  enabled: true,
  selected: false,
};

const MACHINE_DISABLED: MachineEntry = {
  id: "m2",
  label: "Off Box",
  target: "off.example.com",
  session: "default",
  enabled: false,
  selected: false,
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
  { id: "m3" }, // malformed: no target → skipped
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

const SNAPSHOT_RESULT = {
  snapshot: { version: "0.9.5", protocol: 22, panes: [], agents: {} },
  type: "session_snapshot",
};

const PLUGIN_LIST_RESULT = {
  plugins: [
    { plugin_id: "rebuildup.inbox", name: "Inbox", version: "0.4.0" },
    { plugin_id: "rebuildup.handoff" },
  ],
  type: "plugin_list",
};

interface Call {
  args: string[];
  timeoutMs: number;
}

/** Fake herdr: dispatch on argv; records calls for assertions. */
function fakeRunner(handlers: Record<string, (call: Call) => RunResult>): {
  runner: (args: string[], o: { timeoutMs: number }) => Promise<RunResult>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    runner: (args, o) => {
      calls.push({ args: [...args], timeoutMs: o.timeoutMs });
      const key = args.join(" ");
      for (const [pattern, handler] of Object.entries(handlers)) {
        if (key === pattern || key.startsWith(`${pattern} `)) {
          return Promise.resolve(handler({ args: [...args], timeoutMs: o.timeoutMs }));
        }
      }
      return Promise.resolve(failRun(`unexpected args: ${key}`));
    },
  };
}

const LIST_HANDLER = { "machine list --json": () => ok(MACHINE_JSON) };

// --- listMachines ---------------------------------------------------------------

describe("listMachines", () => {
  test("parses machine list --json and skips malformed entries", async () => {
    const { runner } = fakeRunner(LIST_HANDLER);
    const machines = await listMachines(runner);
    expect(machines).toHaveLength(2);
    expect(machines[0]).toEqual(MACHINE);
    expect(machines[1]).toEqual(MACHINE_DISABLED);
  });

  test("throws machine_list_failed on nonzero exit", async () => {
    const { runner } = fakeRunner({
      "machine list --json": () => failRun("boom"),
    });
    await expect(listMachines(runner)).rejects.toMatchObject({
      kind: "machine_list_failed",
    });
  });

  test("throws machine_list_failed on non-JSON output", async () => {
    const { runner } = fakeRunner({
      "machine list --json": () => ok("not json"),
    });
    await expect(listMachines(runner)).rejects.toBeInstanceOf(RemoteError);
  });

  test("throws machine_list_failed on non-array JSON", async () => {
    const { runner } = fakeRunner({
      "machine list --json": () => ok('{"machines":[]}'),
    });
    await expect(listMachines(runner)).rejects.toMatchObject({
      kind: "machine_list_failed",
    });
  });
});

// --- resolveMachine ---------------------------------------------------------------

describe("resolveMachine", () => {
  const machines = [MACHINE, MACHINE_DISABLED];

  test("resolves by exact id", () => {
    expect(resolveMachine("m1", machines)).toBe(MACHINE);
  });

  test("resolves by label case-insensitively", () => {
    expect(resolveMachine("lab box", machines)).toBe(MACHINE);
    expect(resolveMachine("OFF BOX", machines)).toBe(MACHINE_DISABLED);
  });

  test("throws machine_ambiguous on duplicate labels", () => {
    const dup = { ...MACHINE, id: "m9", label: "Lab Box" };
    expect(() => resolveMachine("lab box", [MACHINE, dup])).toThrowError(RemoteError);
    try {
      resolveMachine("lab box", [MACHINE, dup]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteError);
      expect((err as RemoteError).kind).toBe("machine_ambiguous");
    }
  });

  test("throws machine_not_found for unknown selector", () => {
    try {
      resolveMachine("nope", machines);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteError);
      expect((err as RemoteError).kind).toBe("machine_not_found");
    }
  });
});

// --- probeMachineEntry --------------------------------------------------------------

describe("probeMachineEntry", () => {
  test("disabled machine reports disabled without any remote call", async () => {
    const { runner, calls } = fakeRunner({});
    const probe = await probeMachineEntry(MACHINE_DISABLED, { runner });
    expect(probe.state).toBe("disabled");
    expect(probe.reachable).toBeNull();
    expect(probe.plugin_surface).toBe("unknown");
    expect(calls).toHaveLength(0);
  });

  test("ok probe: snapshot version/protocol + plugin surface supported", async () => {
    const { runner, calls } = fakeRunner({
      "--machine m1 api snapshot": () => ok(envelope(SNAPSHOT_RESULT)),
      "--machine m1 plugin list --json": () => ok(envelope(PLUGIN_LIST_RESULT)),
    });
    const probe = await probeMachineEntry(MACHINE, { runner });
    expect(probe.state).toBe("ok");
    expect(probe.reachable).toBe(true);
    expect(probe.server_version).toBe("0.9.5");
    expect(probe.protocol).toBe(22);
    expect(probe.plugin_surface).toBe("supported");
    expect(probe.plugins).toEqual([
      { id: "rebuildup.inbox", name: "Inbox", version: "0.4.0" },
      { id: "rebuildup.handoff", name: null, version: null },
    ]);
    expect(probe.plugin_surface_error).toBeNull();
    expect(probe.error).toBeNull();
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "--machine m1 api snapshot",
      "--machine m1 plugin list --json",
    ]);
  });

  test("nonzero exit → unreachable", async () => {
    const { runner } = fakeRunner({
      "--machine m1 api snapshot": () => failRun("ssh: connect timeout"),
    });
    const probe = await probeMachineEntry(MACHINE, { runner });
    expect(probe.state).toBe("unreachable");
    expect(probe.reachable).toBe(false);
    expect(probe.error_kind).toBe("remote_command_failed");
    expect(probe.error).toContain("unreachable");
    expect(probe.plugin_surface).toBe("unknown");
  });

  test("runner timeout → unreachable", async () => {
    const { runner } = fakeRunner({
      "--machine m1 api snapshot": () => ({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    });
    const probe = await probeMachineEntry(MACHINE, { runner });
    expect(probe.state).toBe("unreachable");
    expect(probe.error_kind).toBe("remote_timeout");
  });

  test("bridge-less remote → unsupported_remote", async () => {
    const { runner } = fakeRunner({
      "--machine m1 api snapshot": () =>
        failRun("remote machine does not support machine API forwarding"),
    });
    const probe = await probeMachineEntry(MACHINE, { runner });
    expect(probe.state).toBe("unsupported_remote");
    expect(probe.error).toContain("machine API forwarding");
  });

  test("remote-api-bridge error envelope → unsupported_remote", async () => {
    const { runner } = fakeRunner({
      "--machine m1 api snapshot": () =>
        ok(
          JSON.stringify({
            id: "cli:api:snapshot",
            error: {
              code: "unsupported",
              message: "remote-api-bridge not available on this herdr",
            },
          }),
        ),
    });
    const probe = await probeMachineEntry(MACHINE, { runner });
    expect(probe.state).toBe("unsupported_remote");
    expect(probe.error_kind).toBe("remote_unsupported");
  });

  test("error envelope on snapshot → error state with remote code", async () => {
    const { runner } = fakeRunner({
      "--machine m1 api snapshot": () =>
        ok(
          JSON.stringify({
            id: "cli:api:snapshot",
            error: { code: "session_not_found", message: "no such session" },
          }),
        ),
    });
    const probe = await probeMachineEntry(MACHINE, { runner });
    expect(probe.state).toBe("error");
    expect(probe.error_kind).toBe("remote_session_not_found");
  });

  test("plugin list failure → state ok, plugin_surface unsupported", async () => {
    const { runner } = fakeRunner({
      "--machine m1 api snapshot": () => ok(envelope(SNAPSHOT_RESULT)),
      "--machine m1 plugin list --json": () =>
        ok(
          JSON.stringify({
            id: "cli:plugin",
            error: { code: "method_not_found", message: "unknown method" },
          }),
        ),
    });
    const probe = await probeMachineEntry(MACHINE, { runner });
    expect(probe.state).toBe("ok");
    expect(probe.server_version).toBe("0.9.5");
    expect(probe.plugin_surface).toBe("unsupported");
    expect(probe.plugins).toBeNull();
    expect(probe.plugin_surface_error).toContain("method_not_found");
    expect(probe.error).toBeNull();
  });

  test("plugin list malformed result → plugin_surface unsupported", async () => {
    const { runner } = fakeRunner({
      "--machine m1 api snapshot": () => ok(envelope(SNAPSHOT_RESULT)),
      "--machine m1 plugin list --json": () => ok(envelope({ type: "plugin_list" })),
    });
    const probe = await probeMachineEntry(MACHINE, { runner });
    expect(probe.state).toBe("ok");
    expect(probe.plugin_surface).toBe("unsupported");
    expect(probe.plugin_surface_error).toContain("no plugins array");
  });
});

// --- probeMachine / probeAllMachines --------------------------------------------------

describe("probeMachine", () => {
  test("resolves selector then probes", async () => {
    const { runner } = fakeRunner({
      ...LIST_HANDLER,
      "--machine m1 api snapshot": () => ok(envelope(SNAPSHOT_RESULT)),
      "--machine m1 plugin list --json": () => ok(envelope(PLUGIN_LIST_RESULT)),
    });
    const probe = await probeMachine("Lab Box", { runner });
    expect(probe.machine_id).toBe("m1");
    expect(probe.state).toBe("ok");
  });

  test("unknown selector throws machine_not_found", async () => {
    const { runner } = fakeRunner(LIST_HANDLER);
    await expect(probeMachine("ghost", { runner })).rejects.toMatchObject({
      kind: "machine_not_found",
    });
  });
});

describe("probeAllMachines", () => {
  test("probes every machine; disabled is reported without remote calls", async () => {
    const { runner, calls } = fakeRunner({
      ...LIST_HANDLER,
      "--machine m1 api snapshot": () => ok(envelope(SNAPSHOT_RESULT)),
      "--machine m1 plugin list --json": () => ok(envelope(PLUGIN_LIST_RESULT)),
    });
    const probes = await probeAllMachines({ runner });
    expect(probes).toHaveLength(2);
    expect(probes[0]?.state).toBe("ok");
    expect(probes[1]?.state).toBe("disabled");
    const remoteCalls = calls.filter((c) => c.args[0] === "--machine");
    expect(remoteCalls.every((c) => c.args[1] === "m1")).toBe(true);
  });
});

// --- state ---------------------------------------------------------------------------

describe("state", () => {
  test("recordProbe persists and loadState reads it back", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const { runner } = fakeRunner({
      "--machine m1 api snapshot": () => ok(envelope(SNAPSHOT_RESULT)),
      "--machine m1 plugin list --json": () => ok(envelope(PLUGIN_LIST_RESULT)),
    });
    const probe = await probeMachineEntry(MACHINE, { runner });
    await recordProbe(probe);

    const state = await loadState();
    expect(state.probes.m1).toEqual(probe);
    expect(stateFilePath()).toContain("machines");
  });

  test("recordProbe overwrites previous probe for same machine", async () => {
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    const { runner } = fakeRunner({
      "--machine m1 api snapshot": () => ok(envelope(SNAPSHOT_RESULT)),
      "--machine m1 plugin list --json": () => ok(envelope(PLUGIN_LIST_RESULT)),
    });
    const first = await probeMachineEntry(MACHINE, { runner });
    await recordProbe(first);
    const second = { ...first, probed_at: "2999-01-01T00:00:00.000Z" };
    await recordProbe(second);
    const state = await loadState();
    expect(state.probes.m1?.probed_at).toBe("2999-01-01T00:00:00.000Z");
  });
});
