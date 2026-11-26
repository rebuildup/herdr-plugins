import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { herdrSocketEndpoint, testEnv } from "./helpers/test-env";

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
  cwd?: string;
  terminal_title_stripped?: string;
}

interface FakePane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  title?: string;
  cwd?: string;
}

interface FakeHerdr {
  socketPath: string;
  methods: string[];
  setAgents(agents: FakeAgent[]): void;
  setPanes(panes: FakePane[]): void;
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
  let panes: FakePane[] = ["w1:p1", "w1:p2", "w1:p3"].map((id) => ({
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
    server.listen(herdrSocketEndpoint(socketPath), () => resolveListen());
  });
  return {
    socketPath,
    methods,
    setAgents(next: FakeAgent[]) {
      agents = next;
    },
    setPanes(next: FakePane[]) {
      panes = next;
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
  return testEnv({
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
  });
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

describe("inbox contract v1 (filters and tracker links)", () => {
  let herdr: FakeHerdr;
  let stateDir: string;
  let configDir: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    herdr = await fakeHerdr();
    stateDir = mkdtempSync(path.join(tmpdir(), "inbox-state-"));
    configDir = mkdtempSync(path.join(tmpdir(), "inbox-config-"));
    env = cliEnv(stateDir, configDir);
    herdr.setPanes([
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", title: "fix login bug" },
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", title: "write docs" },
      { pane_id: "w2:p9", workspace_id: "ws2", tab_id: "w2:t1", title: "deploy pipeline" },
    ]);
    herdr.setAgents([
      {
        pane_id: "w1:p1",
        agent_status: "done",
        state_change_seq: 3,
        agent_session: { agent: "claude", kind: "session", value: "sess-1" },
        cwd: "/repo/app",
        terminal_title_stripped: "fix login bug",
      },
      { pane_id: "w1:p2", agent_status: "working", state_change_seq: 2 },
      { pane_id: "w2:p9", agent_status: "idle", state_change_seq: 1 },
    ]);
  });

  afterAll(async () => {
    await herdr.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  const cli = (args: string[]) => runCli([...args, "--socket", herdr.socketPath], env);
  const paneIds = (json: Record<string, unknown> | null) =>
    (json?.items as Array<Record<string, unknown>>).map((i) => i.pane_id);

  test("list filters: attention/organize/search/workspace, read-only", async () => {
    const all = await cli(["list"]);
    expect(all.status).toBe(0);
    expect(paneIds(all.json).sort()).toEqual(["w1:p1", "w1:p2", "w2:p9"]);
    expect((all.json?.filters as Record<string, unknown>).attention).toBe(false);

    // Organize p2, then filter by kind.
    await cli(["settle", "w1:p2"]);
    const settled = await cli(["list", "--organize", "settled"]);
    expect(paneIds(settled.json)).toEqual(["w1:p2"]);
    expect((settled.json?.counts as Record<string, number>).total).toBe(1);

    const none = await cli(["list", "--organize", "none"]);
    expect(paneIds(none.json).sort()).toEqual(["w1:p1", "w2:p9"]);

    // Attention: flip p1 to blocked — attention is never hidden by settle.
    herdr.setAgents([
      {
        pane_id: "w1:p1",
        agent_status: "blocked",
        state_change_seq: 4,
        agent_session: { agent: "claude", kind: "session", value: "sess-1" },
        cwd: "/repo/app",
      },
      { pane_id: "w1:p2", agent_status: "working", state_change_seq: 2 },
      { pane_id: "w2:p9", agent_status: "idle", state_change_seq: 1 },
    ]);
    const attention = await cli(["list", "--attention"]);
    expect(paneIds(attention.json)).toEqual(["w1:p1"]);
    // Combined filters.
    const combined = await cli(["list", "--attention", "--search", "login", "--workspace", "w1"]);
    expect(paneIds(combined.json)).toEqual(["w1:p1"]);
    const miss = await cli(["list", "--search", "login", "--workspace", "ws2"]);
    expect(miss.json?.items).toEqual([]);

    // Search hits title/cwd/pane_id case-insensitively.
    const byCwd = await cli(["list", "--search", "/REPO/app"]);
    expect(paneIds(byCwd.json)).toEqual(["w1:p1"]);

    // Filters never mutate state: settled mark on p2 survives every read.
    const again = await cli(["list"]);
    expect(itemByPane(again.json as Record<string, unknown>, "w1:p2")?.organize).toMatchObject({
      kind: "settled",
    });

    // Invalid --organize value is a usage error.
    const bad = await cli(["list", "--organize", "bogus"]);
    expect(bad.status).toBe(2);

    await cli(["restore", "w1:p2"]);
    herdr.setAgents([
      {
        pane_id: "w1:p1",
        agent_status: "done",
        state_change_seq: 4,
        agent_session: { agent: "claude", kind: "session", value: "sess-1" },
        cwd: "/repo/app",
      },
      { pane_id: "w1:p2", agent_status: "working", state_change_seq: 2 },
      { pane_id: "w2:p9", agent_status: "idle", state_change_seq: 1 },
    ]);
  });

  test("link/unlink/links contract and honest errors", async () => {
    // Happy path: PR + Issue links on p1.
    const link = await cli(["link", "w1:p1", "--pr", "owner/repo#42"]);
    expect(link.status).toBe(0);
    expect(link.json?.command).toBe("link");
    expect((link.json?.links as unknown[]).length).toBe(1);

    const linkIssue = await cli(["link", "w1:p1", "--issue", "owner/repo#7"]);
    expect(linkIssue.status).toBe(0);
    expect((linkIssue.json?.links as unknown[]).length).toBe(2);

    // list exposes links additively; counts.linked reflects them.
    const list = await cli(["list"]);
    const p1 = itemByPane(list.json as Record<string, unknown>, "w1:p1");
    expect((p1?.links as Array<Record<string, unknown>>).map((l) => l.ref).sort()).toEqual([
      "owner/repo#42",
      "owner/repo#7",
    ]);
    expect((list.json?.counts as Record<string, number>).linked).toBe(1);

    // links command reads stored state.
    const links = await cli(["links", "w1:p1"]);
    expect(links.status).toBe(0);
    expect((links.json?.links as unknown[]).length).toBe(2);

    // Re-link same ref is idempotent (re-validation), not a duplicate.
    const relink = await cli(["link", "w1:p1", "--pr", "owner/repo#42"]);
    expect((relink.json?.links as unknown[]).length).toBe(2);

    // unlink removes exactly the matching ref.
    const unlink = await cli(["unlink", "w1:p1", "--issue", "owner/repo#7"]);
    expect(unlink.status).toBe(0);
    expect((unlink.json?.removed as Record<string, unknown>)?.ref).toBe("owner/repo#7");
    expect((unlink.json?.links as unknown[]).length).toBe(1);

    // Honest errors: unknown pane, missing link, bad ref, ambiguous kind.
    const noPane = await cli(["link", "w9:p9", "--pr", "owner/repo#1"]);
    expect(noPane.status).not.toBe(0);
    const noLink = await cli(["unlink", "w1:p1", "--issue", "owner/repo#7"]);
    expect(noLink.status).not.toBe(0);
    const badRef = await cli(["link", "w1:p1", "--pr", "not-a-ref"]);
    expect(badRef.status).toBe(2);
    const both = await cli(["link", "w1:p1", "--pr", "owner/repo#1", "--issue", "o/r#2"]);
    expect(both.status).toBe(2);
    const noKind = await cli(["link", "w1:p1"]);
    expect(noKind.status).toBe(2);

    // --verify records anyway with a warning when gh cannot confirm.
    const verified = await cli([
      "link",
      "w1:p2",
      "--pr",
      "definitely-not-a-real-owner-zzz/repo#1",
      "--verify",
    ]);
    expect(verified.status).toBe(0);
    expect((verified.json?.warnings as string[]).length).toBeGreaterThan(0);
    expect((verified.json?.links as unknown[]).length).toBe(1);
    await cli(["unlink", "w1:p2", "--pr", "definitely-not-a-real-owner-zzz/repo#1"]);
  });

  test("stale links never attach to a different agent generation", async () => {
    // p1 currently has pr owner/repo#42 recorded under sess-1.
    // Simulate an agent generation swap: same pane, new session value.
    herdr.setAgents([
      {
        pane_id: "w1:p1",
        agent_status: "done",
        state_change_seq: 4,
        agent_session: { agent: "claude", kind: "session", value: "sess-2" },
      },
      { pane_id: "w1:p2", agent_status: "working", state_change_seq: 2 },
      { pane_id: "w2:p9", agent_status: "idle", state_change_seq: 1 },
    ]);
    const list = await cli(["list"]);
    const p1 = itemByPane(list.json as Record<string, unknown>, "w1:p1");
    expect(p1?.links).toEqual([]);

    // Same seq-advance tolerance: links survive status transitions within
    // the same session — covered by model tests; here verify re-link works
    // as the explicit re-validation path after staleness.
    const relink = await cli(["link", "w1:p1", "--pr", "owner/repo#42"]);
    expect(relink.status).toBe(0);
    expect((relink.json?.links as unknown[]).length).toBe(1);
    await cli(["unlink", "w1:p1", "--pr", "owner/repo#42"]);

    // Restore clears organize state but keeps declared links.
    await cli(["link", "w1:p2", "--issue", "owner/repo#9"]);
    await cli(["settle", "w1:p2"]);
    await cli(["restore", "w1:p2"]);
    const linksAfter = await cli(["links", "w1:p2"]);
    expect((linksAfter.json?.links as unknown[]).length).toBe(1);
    await cli(["unlink", "w1:p2", "--issue", "owner/repo#9"]);
  });

  test("link commands touch only the snapshot read surface", async () => {
    herdr.methods.length = 0;
    await cli(["link", "w1:p1", "--pr", "owner/repo#5"]);
    await cli(["links", "w1:p1"]);
    await cli(["unlink", "w1:p1", "--pr", "owner/repo#5"]);
    const unique = [...new Set(herdr.methods)];
    // No pane.report_metadata (links have no tokens), no execution surfaces.
    expect(unique).toEqual(["session.snapshot"]);
  });

  test("link --verify sanitizes gh env and never echoes gh stderr (#216)", async () => {
    // The fake `gh` is a POSIX sh script; skip where it cannot run.
    if (process.platform === "win32") return;
    const ghBin = mkdtempSync(path.join(tmpdir(), "inbox-fake-gh-"));
    try {
      const ghPath = path.join(ghBin, "gh");
      writeFileSync(
        ghPath,
        [
          "#!/bin/sh",
          // Unset vars expand to empty under plain sh (no `set -u`), so
          // `[ -n "$VAR" ]` doubles as an unset check — and keeps the
          // script free of `${}` for the linter.
          'if [ -n "$GH_DEBUG" ] || [ -n "$GH_REPO" ] || [ -n "$GH_FORCE_TTY" ] || [ -n "$GIT_DIR" ] || [ -n "$GIT_CONFIG_COUNT" ] || [ -n "$GIT_CONFIG_PARAMETERS" ]; then',
          '  echo "env-leak-marker" >&2',
          "  exit 1",
          "fi",
          'if [ "$FAKE_GH_FAIL" = "1" ]; then',
          '  echo "credential-marker-9f8e7d6c" >&2',
          "  exit 1",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(ghPath, 0o755);

      // Ambient poison vars that ghChildEnv must strip before spawn.
      const verifyEnv: Record<string, string> = {
        ...env,
        PATH: `${ghBin}${path.delimiter}${env.PATH ?? ""}`,
        GH_DEBUG: "api",
        GH_REPO: "evil/repo",
        GH_FORCE_TTY: "1",
        GIT_DIR: "/tmp/poison-git-dir",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_PARAMETERS: "'core.sshCommand=evil'",
      };
      const runVerify = (extra: Record<string, string>) =>
        runCli(
          ["link", "w1:p1", "--pr", "owner/repo#216", "--verify", "--socket", herdr.socketPath],
          { ...verifyEnv, ...extra },
        );

      // Sanitized env: the fake gh sees none of the poison vars → exit 0
      // → verification succeeds with no warning. If any var leaked, the
      // stub exits 1 and a warning appears.
      const ok = await runVerify({});
      expect(ok.status).toBe(0);
      expect(ok.json?.warnings).toEqual([]);
      expect((ok.json?.links as unknown[]).length).toBeGreaterThan(0);

      // Failing gh: its stderr carries a credential marker that must
      // never reach warnings[] (or anywhere in the JSON payload).
      const bad = await runVerify({ FAKE_GH_FAIL: "1" });
      expect(bad.status).toBe(0);
      const warnings = bad.json?.warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("link verification failed");
      expect(JSON.stringify(bad.json)).not.toContain("credential-marker");
      expect(JSON.stringify(bad.json)).not.toContain("env-leak-marker");
      // The link is still recorded — verification never blocks.
      expect((bad.json?.links as unknown[]).length).toBeGreaterThan(0);

      await cli(["unlink", "w1:p1", "--pr", "owner/repo#216"]);
    } finally {
      rmSync(ghBin, { recursive: true, force: true });
    }
  });
});
