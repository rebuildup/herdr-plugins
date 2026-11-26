import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeClaudeCwd } from "../plugins/conversations/src/claude";
import { herdrSocketEndpoint, socketConsistentEnv, testEnv } from "./helpers/test-env";

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
for (const key of [
  "HERDR_PLUGIN_STATE_DIR",
  "HERDR_PLUGIN_CONFIG_DIR",
  "HERDR_SOCKET_PATH",
  "HERDR_SESSION",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENCODE_DATA_DIR",
  "XDG_DATA_HOME",
]) {
  savedEnv[key] = process.env[key];
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "conversations-t3-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const PLUGIN = path.join(__dirname, "..", "plugins", "conversations");
const CLI = path.join(PLUGIN, "src", "cli.ts");
const DEAD_SOCKET = path.join(tempDir(), "no-such-herdr.sock");

const SESSION_ID = "3bc481ff-60ac-491a-abd0-07c408c85e71";
const SESSION_ID_2 = "11111111-2222-3333-4444-555555555555";
const CWD = "/repo/proj";

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

function cliEnv(extra?: Record<string, string>): Record<string, string> {
  return testEnv({ HERDR_SOCKET_PATH: DEAD_SOCKET, ...extra });
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
    env: cliEnv(socketConsistentEnv(args, extraEnv)),
    timeout: 30_000,
  });
  return parseCliOutput(result.stdout, result.stderr, result.status ?? -1);
}

function runCliAsync(args: string[], extraEnv?: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: cliEnv(socketConsistentEnv(args, extraEnv)),
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
    child.on("close", (code) => resolve(parseCliOutput(stdout, stderr, code ?? -1)));
  });
}

interface FakeAgent {
  pane_id: string;
  agent?: string;
  agent_status?: string;
  state_change_seq?: number;
  cwd?: string;
  agent_session?: { agent?: string; kind?: string; value?: string } | null;
}

async function fakeHerdr(state: {
  panes: { pane_id: string; workspace_id?: string; tab_id?: string; cwd?: string }[];
  agents: FakeAgent[];
}): Promise<{ socketPath: string; close: () => Promise<void> }> {
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
        const result =
          message.method === "session.snapshot"
            ? {
                snapshot: {
                  session: { name: "test-session" },
                  panes: state.panes,
                  agents: state.agents,
                },
              }
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
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

function writeTranscript(
  claudeHome: string,
  cwd: string,
  sessionId: string,
  lines: unknown[],
): string {
  const dir = path.join(claudeHome, "projects", encodeClaudeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(
    file,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
  return file;
}

function userLine(uuid: string, text: string, second = 0): unknown {
  return {
    type: "user",
    uuid,
    timestamp: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    message: { role: "user", content: text },
  };
}

function assistantLine(uuid: string, text: string, second: number): unknown {
  return {
    type: "assistant",
    uuid,
    timestamp: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    message: {
      id: `msg-${uuid}`,
      role: "assistant",
      model: "claude-test-1",
      content: [
        { type: "text", text },
        { type: "tool_use", id: `tool-${uuid}`, name: "Bash", input: { command: "ls" } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function toolResultLine(uuid: string, toolUseId: string, second: number): unknown {
  return {
    type: "user",
    uuid,
    timestamp: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "out", is_error: false }],
    },
  };
}

/** Two-turn fixture with searchable text and usage-bearing assistant events. */
function fixtureLines(): unknown[] {
  return [
    userLine("u-1", "please fix the needle bug", 1),
    assistantLine("a-1", "working on the needle", 2),
    toolResultLine("u-2", "tool-a-1", 3),
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "s-1",
      timestamp: "2026-01-01T00:00:04.000Z",
    },
    userLine("u-3", "second prompt about haystack", 5),
    assistantLine("a-2", "done with needle cleanup", 6),
    toolResultLine("u-4", "tool-a-2", 7),
    "{not valid json",
  ];
}

function setupEnv(): { stateDir: string; claudeHome: string; extra: Record<string, string> } {
  const stateDir = tempDir();
  const claudeHome = tempDir();
  return {
    stateDir,
    claudeHome,
    extra: {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONFIG_DIR: path.join(stateDir, "config"),
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: path.join(stateDir, "no-codex"),
      OPENCODE_DATA_DIR: path.join(stateDir, "no-opencode"),
      XDG_DATA_HOME: path.join(stateDir, "no-xdg"),
    },
  };
}

function herdrFor(claudeSessions: { pane: string; sessionId: string; cwd?: string }[]) {
  return fakeHerdr({
    panes: claudeSessions.map((s) => ({
      pane_id: s.pane,
      workspace_id: "w1",
      tab_id: "w1:t1",
      cwd: s.cwd ?? CWD,
    })),
    agents: claudeSessions.map((s) => ({
      pane_id: s.pane,
      agent: "claude",
      agent_status: "idle",
      state_change_seq: 1,
      cwd: s.cwd ?? CWD,
      agent_session: { agent: "claude", kind: "session", value: s.sessionId },
    })),
  });
}

const t = (name: string, fn: () => void | Promise<void>) => test(name, fn, 30_000);

describe("conversations t3 read APIs", () => {
  t("capability advertises search/show/usage", () => {
    const { extra } = setupEnv();
    const r = runCli(["capability"], extra);
    expect(r.status).toBe(0);
    const commands = r.json?.commands as string[];
    expect(commands).toContain("search");
    expect(commands).toContain("show");
    expect(commands).toContain("usage");
  });

  t("search matches case-insensitively with session/event refs and filters", async () => {
    const { claudeHome, extra } = setupEnv();
    writeTranscript(claudeHome, CWD, SESSION_ID, fixtureLines());
    writeTranscript(claudeHome, "/other", SESSION_ID_2, [userLine("x-1", "unrelated chatter", 1)]);
    const herdr = await herdrFor([
      { pane: "w1:p1", sessionId: SESSION_ID },
      { pane: "w1:p2", sessionId: SESSION_ID_2, cwd: "/other" },
    ]);
    try {
      const idx = await runCliAsync(["index", "--socket", herdr.socketPath], extra);
      expect(idx.status).toBe(0);
      expect((idx.json?.indexed as unknown[]).length).toBe(2);

      // case-insensitive substring across both sessions
      const all = await runCliAsync(["search", "NEEDLE", "--offline"], extra);
      expect(all.status).toBe(0);
      const results = all.json?.results as Record<string, unknown>[];
      const texts = results.map((r) => (r.event as Record<string, unknown>).text);
      expect(texts).toContain("please fix the needle bug");
      expect(texts).toContain("working on the needle");
      expect(texts).toContain("done with needle cleanup");
      expect(results.every((r) => r.session_key === `claude:${SESSION_ID}`)).toBe(true);
      expect(results[0]?.matched_fields).toContain("text");

      // --type filter
      const typed = await runCliAsync(
        ["search", "needle", "--type", "assistant_message", "--offline"],
        extra,
      );
      const typedResults = typed.json?.results as Record<string, unknown>[];
      expect(typedResults.length).toBe(2);
      expect(typedResults.every((r) => r.type === "assistant_message")).toBe(true);

      // --session-id + --pane filters
      const scoped = await runCliAsync(
        ["search", "needle", "--session-id", `claude:${SESSION_ID}`, "--offline"],
        extra,
      );
      expect((scoped.json?.results as unknown[]).length).toBe(3);
      const byPane = await runCliAsync(["search", "needle", "--pane", "w1:p2", "--offline"], extra);
      expect((byPane.json?.results as unknown[]).length).toBe(0);
      expect(byPane.json?.selector_note).toBe("filtered_by_pane");

      // tool_name is searchable
      const tool = await runCliAsync(["search", "Bash", "--offline"], extra);
      const toolResults = tool.json?.results as Record<string, unknown>[];
      expect(toolResults.some((r) => r.type === "tool_call")).toBe(true);

      // invalid --type → usage error
      const bad = runCli(["search", "x", "--type", "bogus", "--offline"], extra);
      expect(bad.status).toBe(2);
      // missing query → usage error
      expect(runCli(["search", "--offline"], extra).status).toBe(2);
    } finally {
      await herdr.close();
    }
  });

  t("search + history cursors survive an index update without dup/miss", async () => {
    const { stateDir, claudeHome, extra } = setupEnv();
    const file = writeTranscript(claudeHome, CWD, SESSION_ID, [
      userLine("u-1", "needle one", 1),
      userLine("u-2", "needle two", 2),
      userLine("u-3", "needle three", 3),
      userLine("u-4", "needle four", 4),
    ]);
    const herdr = await herdrFor([{ pane: "w1:p1", sessionId: SESSION_ID }]);
    try {
      await runCliAsync(["index", "--socket", herdr.socketPath], extra);

      // history paging across an appended index run
      const h1 = await runCliAsync(
        ["history", "--session-id", `claude:${SESSION_ID}`, "--limit", "3", "--offline"],
        extra,
      );
      const page1 = h1.json?.page as Record<string, unknown>;
      expect(page1.has_more).toBe(true);
      appendFileSync(file, JSON.stringify(userLine("u-5", "needle five", 5)) + "\n");
      const idx2 = await runCliAsync(["refresh", "--socket", herdr.socketPath], extra);
      expect(idx2.status).toBe(0);
      const h2 = await runCliAsync(
        [
          "history",
          "--session-id",
          `claude:${SESSION_ID}`,
          "--limit",
          "10",
          "--cursor",
          String(page1.next_cursor),
          "--offline",
        ],
        extra,
      );
      const allEvents = [
        ...(h1.json?.events as Record<string, unknown>[]),
        ...(h2.json?.events as Record<string, unknown>[]),
      ];
      const ids = allEvents.map((e) => e.event_id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(allEvents.length).toBe(10); // 4 turns + 4 user + new turn + new user
      expect(stateDir).toBeTruthy();

      // search paging across another index update
      const s1 = await runCliAsync(["search", "needle", "--limit", "2", "--offline"], extra);
      const sp1 = s1.json?.page as Record<string, unknown>;
      expect(sp1.has_more).toBe(true);
      appendFileSync(file, JSON.stringify(userLine("u-6", "needle six", 6)) + "\n");
      await runCliAsync(["index", "--socket", herdr.socketPath], extra);
      const s2 = await runCliAsync(
        ["search", "needle", "--limit", "10", "--cursor", String(sp1.next_cursor), "--offline"],
        extra,
      );
      const allMatches = [
        ...(s1.json?.results as Record<string, unknown>[]),
        ...(s2.json?.results as Record<string, unknown>[]),
      ];
      const matchIds = allMatches.map((r) => r.event_id);
      expect(new Set(matchIds).size).toBe(matchIds.length);
      expect(matchIds.length).toBe(6); // five needle prompts + needle six
      expect(allMatches.every((r) => r.session_key === `claude:${SESSION_ID}`)).toBe(true);

      // malformed cursor → usage error
      const badCursor = runCli(["search", "needle", "--cursor", "!!!", "--offline"], extra);
      expect(badCursor.status).toBe(2);
    } finally {
      await herdr.close();
    }
  });

  t("show resolves event_id, tool:<id>, and turn:<n>", async () => {
    const { claudeHome, extra } = setupEnv();
    writeTranscript(claudeHome, CWD, SESSION_ID, fixtureLines());
    const herdr = await herdrFor([{ pane: "w1:p1", sessionId: SESSION_ID }]);
    try {
      await runCliAsync(["index", "--socket", herdr.socketPath], extra);

      // bare event_id (claude uuid; user_message carries the :message suffix)
      const byEvent = await runCliAsync(["show", "u-1:message", "--offline"], extra);
      expect(byEvent.status).toBe(0);
      expect(byEvent.json?.resolved).toEqual({ kind: "event_id" });
      expect(byEvent.json?.matched).toBe(1);
      const ev = (byEvent.json?.results as Record<string, unknown>[])[0]?.event as Record<
        string,
        unknown
      >;
      expect(ev.text).toBe("please fix the needle bug");

      // tool:<id> → tool_call + tool_result
      const byTool = await runCliAsync(["show", "tool:tool-a-1", "--offline"], extra);
      expect(byTool.status).toBe(0);
      expect(byTool.json?.resolved).toEqual({ kind: "tool_use_id" });
      const toolResults = byTool.json?.results as Record<string, unknown>[];
      expect(toolResults.length).toBe(2);
      expect(toolResults.map((r) => (r.event as Record<string, unknown>).type).sort()).toEqual([
        "tool_call",
        "tool_result",
      ]);

      // turn:<n> → all events of that turn
      const byTurn = await runCliAsync(["show", "turn:2", "--offline"], extra);
      expect(byTurn.status).toBe(0);
      const turnResults = byTurn.json?.results as Record<string, unknown>[];
      expect(turnResults.length).toBeGreaterThan(0);
      expect(turnResults.every((r) => (r.event as Record<string, unknown>).turn_index === 2)).toBe(
        true,
      );

      // unknown ref → explicit empty, not fabricated
      const miss = await runCliAsync(["show", "no-such-id", "--offline"], extra);
      expect(miss.status).toBe(0);
      expect(miss.json?.matched).toBe(0);
      expect((miss.json?.results as unknown[]).length).toBe(0);
    } finally {
      await herdr.close();
    }
  });

  t("usage pages only events carrying provider usage", async () => {
    const { claudeHome, extra } = setupEnv();
    writeTranscript(claudeHome, CWD, SESSION_ID, fixtureLines());
    const herdr = await herdrFor([{ pane: "w1:p1", sessionId: SESSION_ID }]);
    try {
      await runCliAsync(["index", "--socket", herdr.socketPath], extra);
      const r = await runCliAsync(["usage", "--offline"], extra);
      expect(r.status).toBe(0);
      const results = r.json?.results as Record<string, unknown>[];
      expect(results.length).toBe(2); // two assistant_message events with usage
      expect(results.every((r2) => r2.type === "assistant_message")).toBe(true);
      expect(
        results.every(
          (r2) =>
            typeof (r2.event as Record<string, unknown>).usage === "object" &&
            (r2.event as Record<string, unknown>).usage !== null,
        ),
      ).toBe(true);
      // scoped to one session
      const scoped = await runCliAsync(
        ["usage", "--session-id", `claude:${SESSION_ID}`, "--offline"],
        extra,
      );
      expect((scoped.json?.results as unknown[]).length).toBe(2);
    } finally {
      await herdr.close();
    }
  });

  t("stale/missing are explicit: events file, transcript, and empty index", async () => {
    const { stateDir, claudeHome, extra } = setupEnv();
    const transcript = writeTranscript(claudeHome, CWD, SESSION_ID, fixtureLines());
    const herdr = await herdrFor([{ pane: "w1:p1", sessionId: SESSION_ID }]);
    try {
      await runCliAsync(["index", "--socket", herdr.socketPath], extra);

      // provider-side transcript deleted → transcript_present:false,
      // indexed events still readable, status unchanged until re-index
      rmSync(transcript, { force: true });
      const s = await runCliAsync(["search", "needle", "--offline"], extra);
      const sess = (s.json?.sessions as Record<string, unknown>[])[0];
      expect(sess?.transcript_present).toBe(false);
      expect((s.json?.results as unknown[]).length).toBe(3);

      // events file deleted → events_present:false + empty results
      rmSync(path.join(stateDir, "events", `claude_${SESSION_ID}.jsonl`), { force: true });
      const s2 = await runCliAsync(["search", "needle", "--offline"], extra);
      const sess2 = (s2.json?.sessions as Record<string, unknown>[])[0];
      expect(sess2?.events_present).toBe(false);
      expect((s2.json?.results as unknown[]).length).toBe(0);
      const sh = await runCliAsync(["show", "u-1", "--offline"], extra);
      expect((sh.json?.results as unknown[]).length).toBe(0);
      expect((sh.json?.sessions as Record<string, unknown>[])[0]?.events_present).toBe(false);

      // sessions listing also reports transcript_present
      const list = await runCliAsync(["sessions", "--offline"], extra);
      const entry = (list.json?.sessions as Record<string, unknown>[])[0];
      expect(entry?.transcript_present).toBe(false);
    } finally {
      await herdr.close();
    }
  });

  t("empty index and unknown selectors are explicit not_indexed", async () => {
    const { extra } = setupEnv();
    // nothing indexed at all
    const empty = await runCliAsync(["search", "anything", "--offline"], extra);
    expect(empty.status).toBe(0);
    expect((empty.json?.results as unknown[]).length).toBe(0);
    expect(empty.json?.hint).toContain("index");

    // explicit selector with no matching record → session_not_found + hint
    const miss = runCli(["search", "x", "--session-id", "claude:nope", "--offline"], extra);
    expect(miss.status).toBe(1);
    expect(miss.error?.kind).toBe("session_not_found");
    const missShow = runCli(["show", "abc", "--pane", "w9:p9", "--offline"], extra);
    expect(missShow.status).toBe(1);
    expect(missShow.error?.kind).toBe("session_not_found");
  });
});
