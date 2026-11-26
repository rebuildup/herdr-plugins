import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InboxState } from "../plugins/inbox/src/state";
import { appendTransition, MAX_TRANSITIONS_PER_SESSION } from "../plugins/inbox/src/transitions";

/**
 * Contract tests for the `transitions` read surface added in #182
 * (ADR-0029): the additive per-session organize-transition log consumed
 * by rebuildup.projects settle triggers. Fake herdr socket; organize
 * commands must keep touching only session.snapshot +
 * pane.report_metadata.
 */

const CLI = path.join(import.meta.dir, "../plugins/inbox/src/cli.ts");
const REPO_CWD = "/tmp/fake-repo-checkout";

interface FakeAgent {
  pane_id: string;
  agent_status: string;
  state_change_seq: number;
  cwd?: string;
  agent_session?: { agent: string; kind: string; value: string } | null;
}

interface FakeHerdr {
  socketPath: string;
  methods: string[];
  setAgents(agents: FakeAgent[]): void;
  close(): Promise<void>;
}

async function fakeHerdr(): Promise<FakeHerdr> {
  const dir = mkdtempSync(path.join(tmpdir(), "inbox-trans-fake-"));
  const socketPath = path.join(dir, "herdr.sock");
  const methods: string[] = [];
  let agents: FakeAgent[] = [
    {
      pane_id: "w1:p1",
      agent_status: "done",
      state_change_seq: 1,
      cwd: REPO_CWD,
      agent_session: { agent: "claude", kind: "session", value: "s-1" },
    },
    { pane_id: "w1:p2", agent_status: "working", state_change_seq: 1, cwd: REPO_CWD },
  ];
  const panes = ["w1:p1", "w1:p2"].map((id) => ({
    pane_id: id,
    workspace_id: "w1",
    tab_id: "w1:t1",
    cwd: REPO_CWD,
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

interface TransitionPage {
  head_seq: number;
  oldest_seq: number | null;
  dropped: number;
  session_key: string;
  transitions: Array<Record<string, unknown>>;
}

function page(json: Record<string, unknown> | null): TransitionPage {
  expect(json?.command).toBe("transitions");
  return json as unknown as TransitionPage;
}

describe("inbox transitions surface (#182)", () => {
  let herdr: FakeHerdr;
  let stateDir: string;
  let configDir: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    herdr = await fakeHerdr();
    stateDir = mkdtempSync(path.join(tmpdir(), "inbox-trans-state-"));
    configDir = mkdtempSync(path.join(tmpdir(), "inbox-trans-config-"));
    env = cliEnv(stateDir, configDir);
  });

  afterAll(async () => {
    await herdr.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  const cli = (args: string[]) => runCli([...args, "--socket", herdr.socketPath], env);

  test("settle/snooze/restore record transitions; pin/archive do not", async () => {
    const settle = await cli(["settle", "w1:p1"]);
    expect(settle.status).toBe(0);
    const snooze = await cli(["snooze", "w1:p2", "--until", "+2h"]);
    expect(snooze.status).toBe(0);
    // pin + archive are layout/hide-kind mutations outside the enum.
    await cli(["pin", "w1:p1"]);
    await cli(["archive", "w1:p2"]);
    // archive replaced snooze as the hide-kind; restore clears it.
    const restore = await cli(["restore", "w1:p2"]);
    expect(restore.status).toBe(0);

    const t = page((await cli(["transitions"])).json);
    expect(t.head_seq).toBe(3);
    expect(t.transitions.map((x) => x.kind)).toEqual(["settled", "snoozed", "restored"]);
    const [s1, s2, s3] = t.transitions;
    expect(s1).toMatchObject({
      seq: 1,
      kind: "settled",
      pane_id: "w1:p1",
      workspace_id: "w1",
      cwd: REPO_CWD,
      agent_status: "done",
      state_change_seq: 1,
    });
    expect(s2).toMatchObject({ seq: 2, kind: "snoozed", pane_id: "w1:p2" });
    expect(s3).toMatchObject({ seq: 3, kind: "restored", pane_id: "w1:p2" });
    expect(typeof s1?.at).toBe("string");
    expect(t.session_key).toContain("herdr.sock");
    expect(t.dropped).toBe(0);
  });

  test("--after is exclusive; default returns the newest page", async () => {
    const all = page((await cli(["transitions"])).json);
    expect(all.transitions).toHaveLength(3);

    const after1 = page((await cli(["transitions", "--after", "1"])).json);
    expect(after1.transitions.map((x) => x.seq)).toEqual([2, 3]);

    const newest = page((await cli(["transitions", "--limit", "1"])).json);
    expect(newest.transitions.map((x) => x.seq)).toEqual([3]);

    const bad = await cli(["transitions", "--after", "-1"]);
    expect(bad.status).toBe(2);
    const badLimit = await cli(["transitions", "--limit", "0"]);
    expect(badLimit.status).toBe(2);
  });

  test("generation advance records a cleared transition with cause", async () => {
    // p1 is still settled from the first test; advance its generation.
    // Same agent-session fingerprint, advanced state_change_seq →
    // cause "generation" (a fingerprint change would be "session_mismatch").
    herdr.setAgents([
      {
        pane_id: "w1:p1",
        agent_status: "working",
        state_change_seq: 2,
        cwd: REPO_CWD,
        agent_session: { agent: "claude", kind: "session", value: "s-1" },
      },
      { pane_id: "w1:p2", agent_status: "working", state_change_seq: 1, cwd: REPO_CWD },
    ]);
    const rec = await cli(["reconcile"]);
    expect(rec.status).toBe(0);

    const t = page((await cli(["transitions", "--after", "3"])).json);
    expect(t.transitions).toHaveLength(1);
    expect(t.transitions[0]).toMatchObject({
      seq: 4,
      kind: "cleared",
      pane_id: "w1:p1",
      cause: "generation",
      agent_status: "working",
      state_change_seq: 2,
    });
  });

  test("no-op restore records nothing; transitions is read-only", async () => {
    const methodsBefore = herdr.methods.length;
    const noop = await cli(["restore", "w1:p2"]);
    expect(noop.status).toBe(0);
    const t = page((await cli(["transitions"])).json);
    expect(t.head_seq).toBe(4);
    // Only session.snapshot reads — no execution-surface methods.
    const used = [...new Set(herdr.methods.slice(methodsBefore))];
    expect(used.sort()).toEqual(["pane.report_metadata", "session.snapshot"]);
  });

  test("capability advertises transitions at v0.4.0", async () => {
    const cap = await cli(["capability"]);
    expect(cap.status).toBe(0);
    expect(cap.json?.version).toBe("0.4.0");
    expect(cap.json?.commands).toContain("transitions");
  });
});

describe("transition log retention (unit)", () => {
  test("appendTransition caps items and counts drops; seq stays monotonic", () => {
    const state: InboxState = { version: 2, sessions: {} };
    for (let i = 0; i < MAX_TRANSITIONS_PER_SESSION + 10; i += 1) {
      appendTransition(state, "k", {
        kind: "settled",
        paneId: `p${i}`,
        ctx: { at: "2026-01-01T00:00:00Z" },
      });
    }
    const log = state.transitions?.k;
    expect(log?.seq).toBe(MAX_TRANSITIONS_PER_SESSION + 10);
    expect(log?.items).toHaveLength(MAX_TRANSITIONS_PER_SESSION);
    expect(log?.dropped).toBe(10);
    expect(log?.items[0]?.seq).toBe(11);
    expect(log?.items.at(-1)?.seq).toBe(MAX_TRANSITIONS_PER_SESSION + 10);
  });
});
