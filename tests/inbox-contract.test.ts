import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Contract tests for rebuildup.inbox v0.2.0 (pin / archive / manual order)
 * against a fake herdr socket. The fake records every JSON-RPC method it
 * receives so tests can prove organize commands never touch execution
 * surfaces (no pane.close / agent.* / pty methods — only session.snapshot
 * reads and pane.report_metadata projections).
 */

const CLI = path.join(import.meta.dir, "../plugins/inbox/src/cli.ts");

interface FakeAgent {
  pane_id: string;
  agent_status: string;
  state_change_seq: number;
  agent_session?: { agent: string; kind: string; value: string } | null;
}

interface FakeHerdr {
  socketPath: string;
  methods: string[];
  setAgents(agents: FakeAgent[]): void;
  close(): Promise<void>;
}

async function fakeHerdr(): Promise<FakeHerdr> {
  const dir = mkdtempSync(path.join(tmpdir(), "inbox-fake-"));
  const socketPath = path.join(dir, "herdr.sock");
  const methods: string[] = [];
  let agents: FakeAgent[] = [
    { pane_id: "w1:p1", agent_status: "done", state_change_seq: 1 },
    { pane_id: "w1:p2", agent_status: "working", state_change_seq: 1 },
    { pane_id: "w1:p3", agent_status: "done", state_change_seq: 1 },
  ];
  const panes = ["w1:p1", "w1:p2", "w1:p3"].map((id) => ({
    pane_id: id,
    workspace_id: "w1",
    tab_id: "w1:t1",
  }));

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
        if (message.method) methods.push(message.method);
        const result =
          message.method === "session.snapshot"
            ? { snapshot: { session: { name: "fake" }, panes, agents } }
            : {};
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
    methods,
    setAgents(next: FakeAgent[]) {
      agents = next;
    },
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolveClose();
        });
      }),
  };
}

interface CliResult {
  status: number;
  json: Record<string, unknown> | null;
  stderr: string;
}

function cliEnv(stateDir: string, configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("HERDR_") || value === undefined) continue;
    env[key] = value;
  }
  env.HERDR_PLUGIN_STATE_DIR = stateDir;
  env.HERDR_PLUGIN_CONFIG_DIR = configDir;
  return env;
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status, json, stderr };
}

function itemByPane(json: Record<string, unknown>, paneId: string) {
  const items = json.items as Array<Record<string, unknown>>;
  return items.find((item) => item.pane_id === paneId);
}

describe("inbox contract v1 (pin/archive/order)", () => {
  let herdr: FakeHerdr;
  let stateDir: string;
  let configDir: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    herdr = await fakeHerdr();
    stateDir = mkdtempSync(path.join(tmpdir(), "inbox-state-"));
    configDir = mkdtempSync(path.join(tmpdir(), "inbox-config-"));
    env = cliEnv(stateDir, configDir);
  });

  afterAll(async () => {
    await herdr.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  const cli = (args: string[]) => runCli([...args, "--socket", herdr.socketPath], env);

  test("pin/unpin/archive/unarchive/order/restore flow", async () => {
    // Baseline list.
    const list0 = await cli(["list"]);
    expect(list0.status).toBe(0);
    expect(list0.json?.contract).toBe("herdr-plugins.inbox/v1");
    expect((list0.json?.counts as Record<string, number>).inbox).toBe(3);

    // Pin p2: stays in inbox, sorts first, counts.pinned = 1.
    const pin = await cli(["pin", "w1:p2"]);
    expect(pin.status).toBe(0);
    expect(pin.json?.command).toBe("pin");
    expect(pin.json?.pinned).toBe(true);

    const list1 = await cli(["list"]);
    const items1 = list1.json?.items as Array<Record<string, unknown>>;
    expect(items1[0]?.pane_id).toBe("w1:p2");
    expect(items1[0]?.pinned).toBe(true);
    expect((list1.json?.counts as Record<string, number>).pinned).toBe(1);

    // Archive p3: hidden from default view, organize.kind = archived.
    const archive = await cli(["archive", "w1:p3"]);
    expect(archive.status).toBe(0);
    expect(archive.json?.organize).toMatchObject({ kind: "archived" });

    const list2 = await cli(["list"]);
    const p3 = itemByPane(list2.json as Record<string, unknown>, "w1:p3");
    expect(p3?.in_inbox).toBe(false);
    expect(p3?.organize).toMatchObject({ kind: "archived" });
    expect((list2.json?.counts as Record<string, number>).inbox).toBe(2);
    expect((list2.json?.counts as Record<string, number>).archived).toBe(1);

    // Unarchive returns it.
    const unarchive = await cli(["unarchive", "w1:p3"]);
    expect(unarchive.status).toBe(0);
    expect(unarchive.json?.organize).toBeNull();
    const list3 = await cli(["list"]);
    expect(itemByPane(list3.json as Record<string, unknown>, "w1:p3")?.in_inbox).toBe(true);

    // Order: move p1 before p2 within its group. p1 is unpinned/non-attention;
    // p2 is pinned so it is NOT a valid sibling — use p3 (same group as p1).
    const order = await cli(["order", "w1:p1", "--before", "w1:p3"]);
    expect(order.status).toBe(0);
    expect(order.json?.order).toBe(0);

    const list4 = await cli(["list"]);
    const visible = (list4.json?.items as Array<Record<string, unknown>>).filter((i) => i.in_inbox);
    // p2 pinned first; p1 ordered before p3.
    expect(visible.map((i) => i.pane_id)).toEqual(["w1:p2", "w1:p1", "w1:p3"]);

    // Order rejects a hidden pane and a cross-group reference.
    await cli(["settle", "w1:p3"]);
    const hiddenOrder = await cli(["order", "w1:p3", "--first"]);
    expect(hiddenOrder.status).not.toBe(0);
    const crossGroup = await cli(["order", "w1:p1", "--before", "w1:p2"]);
    expect(crossGroup.status).not.toBe(0);

    // Restore clears everything including pin/order.
    await cli(["restore", "w1:p2"]);
    await cli(["restore", "w1:p1"]);
    const list5 = await cli(["list"]);
    expect((list5.json?.counts as Record<string, number>).pinned).toBe(0);
  });

  test("attention is never hidden by pin/archive/settle/snooze", async () => {
    // Keep state_change_seq constant so organize marks survive resolution —
    // this exercises the defense-in-depth path where attention must force
    // visibility even while a hide-kind mark is still live.
    herdr.setAgents([
      { pane_id: "w1:p1", agent_status: "done", state_change_seq: 5 },
      { pane_id: "w1:p2", agent_status: "working", state_change_seq: 5 },
      { pane_id: "w1:p3", agent_status: "done", state_change_seq: 5 },
    ]);
    await cli(["restore", "w1:p1"]);
    await cli(["archive", "w1:p1"]);
    herdr.setAgents([
      { pane_id: "w1:p1", agent_status: "blocked", state_change_seq: 5 },
      { pane_id: "w1:p2", agent_status: "working", state_change_seq: 5 },
      { pane_id: "w1:p3", agent_status: "done", state_change_seq: 5 },
    ]);
    const list = await cli(["list"]);
    const p1 = itemByPane(list.json as Record<string, unknown>, "w1:p1");
    expect(p1?.attention).toBe(true);
    expect(p1?.in_inbox).toBe(true);
    expect(p1?.organize).toMatchObject({ kind: "archived" });

    // Same for pin + settle on p2.
    await cli(["pin", "w1:p2"]);
    await cli(["settle", "w1:p2"]);
    herdr.setAgents([
      { pane_id: "w1:p1", agent_status: "blocked", state_change_seq: 5 },
      { pane_id: "w1:p2", agent_status: "blocked", state_change_seq: 5 },
      { pane_id: "w1:p3", agent_status: "done", state_change_seq: 5 },
    ]);
    const list2 = await cli(["list"]);
    const p2 = itemByPane(list2.json as Record<string, unknown>, "w1:p2");
    expect(p2?.attention).toBe(true);
    expect(p2?.in_inbox).toBe(true);
    expect(p2?.pinned).toBe(true);
    expect(p2?.organize).toMatchObject({ kind: "settled" });
  });

  test("organize commands never touch execution surfaces", async () => {
    herdr.methods.length = 0;
    await cli(["pin", "w1:p1"]);
    await cli(["archive", "w1:p2"]);
    await cli(["order", "w1:p3", "--last"]);
    await cli(["unarchive", "w1:p2"]);
    await cli(["unpin", "w1:p1"]);
    await cli(["restore", "w1:p3"]);
    await cli(["reconcile"]);

    const unique = [...new Set(herdr.methods)];
    // Read + metadata projection only. Anything else (pane.close,
    // agent.*, pane.send_input, ...) would be an execution-state violation.
    expect(unique.sort()).toEqual(["pane.report_metadata", "session.snapshot"]);
  });
});
