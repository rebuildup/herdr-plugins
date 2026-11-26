import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexLineParser, resolveCodexTranscript } from "../plugins/conversations/src/codex";
import { scanTranscript } from "../plugins/conversations/src/indexer";
import type { ConversationIdentity } from "../plugins/conversations/src/model";
import {
  resolveOpenCodeTranscript,
  scanOpenCodeSession,
} from "../plugins/conversations/src/opencode";

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
  const dir = mkdtempSync(path.join(tmpdir(), "conversations-t2-"));
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

const CODEX_SESSION = "01a1f843-77fa-7d30-b3c1-19f822a13215";
const OPENCODE_SESSION = "ses_test123abc";
const CWD = "/repo/proj";

const IDENTITY: ConversationIdentity = {
  host: "h",
  herdr_session: "s",
  workspace_id: null,
  tab_id: null,
  pane_id: "p1",
  agent: "codex",
  agent_session: { value: CODEX_SESSION },
  state_change_seq: 1,
};

// --- codex fixtures ---------------------------------------------------------

function codexRolloutLines(): unknown[] {
  const ts = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, "0")}.000Z`;
  return [
    {
      timestamp: ts(0),
      ordinal: 0,
      type: "session_meta",
      payload: { id: CODEX_SESSION, cwd: CWD, cli_version: "0.169.0" },
    },
    {
      timestamp: ts(1),
      ordinal: 1,
      type: "turn_context",
      payload: { turn_id: "t1", model: "gpt-6-test", cwd: CWD },
    },
    {
      timestamp: ts(2),
      ordinal: 2,
      type: "event_msg",
      payload: { type: "task_started", turn_id: "t1" },
    },
    // response_item message duplicates the event stream AND carries
    // instruction noise — must be skipped.
    {
      timestamp: ts(3),
      ordinal: 3,
      type: "response_item",
      payload: {
        type: "message",
        id: "msg_u1",
        role: "user",
        content: [{ type: "input_text", text: "fix the bug" }],
      },
    },
    {
      timestamp: ts(4),
      ordinal: 4,
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "t1",
        item: {
          type: "UserMessage",
          id: "item-u1",
          content: [{ type: "text", text: "fix the bug" }],
        },
      },
    },
    {
      timestamp: ts(5),
      ordinal: 5,
      type: "response_item",
      payload: {
        type: "function_call",
        id: "ctc_1",
        call_id: "call_1",
        name: "shell",
        arguments: '{"command":"ls"}',
      },
    },
    {
      timestamp: ts(6),
      ordinal: 6,
      type: "response_item",
      payload: {
        type: "function_call_output",
        id: "ctco_1",
        call_id: "call_1",
        output: [{ type: "input_text", text: "a.txt" }],
      },
    },
    {
      timestamp: ts(7),
      ordinal: 7,
      type: "response_item",
      payload: { type: "reasoning", id: "rs_1", summary: [] },
    },
    {
      timestamp: ts(8),
      ordinal: 8,
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "t1",
        item: {
          type: "AgentMessage",
          id: "item-a1",
          content: [{ type: "text", text: "done" }],
        },
      },
    },
    {
      timestamp: ts(9),
      ordinal: 9,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 5,
            total_tokens: 110,
          },
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 5,
            total_tokens: 110,
          },
        },
      },
    },
    {
      timestamp: ts(10),
      ordinal: 10,
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "t1" },
    },
    "{not valid json",
  ];
}

function writeCodexHome(): { codexHome: string; rolloutPath: string } {
  const codexHome = tempDir();
  const dir = path.join(codexHome, "sessions", "2026", "01", "01");
  mkdirSync(dir, { recursive: true });
  const rolloutPath = path.join(dir, `rollout-2026-01-01T00-00-00-${CODEX_SESSION}.jsonl`);
  writeFileSync(
    rolloutPath,
    codexRolloutLines()
      .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
      .join("\n") + "\n",
  );
  return { codexHome, rolloutPath };
}

// --- opencode fixtures ------------------------------------------------------

const OC_T0 = 1767225600000; // 2026-01-01T00:00:00Z

function ocData(assistantContent: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    time: { created: OC_T0 + 1, completed: OC_T0 + 2 },
    agent: "build",
    model: { id: "gpt-5.4-mini", providerID: "openai" },
    content: assistantContent,
    finish: "stop",
    cost: 0.01,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 0 } },
    ...extra,
  });
}

function writeOpenCodeDb(dir: string): string {
  const dbPath = path.join(dir, "opencode.db");
  const db = new Database(dbPath);
  db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER)");
  db.run(
    "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  const insertSession = db.query(
    "INSERT INTO session_v2 (id, directory, time_created) VALUES (?, ?, ?)",
  );
  const insertMsg = db.query(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insertSession.run(OPENCODE_SESSION, CWD, OC_T0);
  insertMsg.run(
    "msg_u1",
    OPENCODE_SESSION,
    "user",
    1,
    OC_T0 + 1,
    OC_T0 + 1,
    JSON.stringify({ time: { created: OC_T0 + 1 }, text: "hello opencode" }),
  );
  insertMsg.run(
    "msg_a1",
    OPENCODE_SESSION,
    "assistant",
    2,
    OC_T0 + 2,
    OC_T0 + 3,
    ocData([
      { type: "reasoning", text: "thinking…" },
      { type: "text", text: "hi there" },
      {
        type: "tool",
        id: "call-1",
        name: "bash",
        state: {
          status: "completed",
          input: { command: "ls" },
          output: [{ type: "text", text: "file.txt" }],
        },
      },
      {
        type: "tool",
        id: "call-2",
        name: "read",
        state: { status: "error", input: { path: "x" }, error: "boom" },
      },
    ]),
  );
  insertMsg.run(
    "msg_i1",
    OPENCODE_SESSION,
    "idle",
    3,
    OC_T0 + 4,
    OC_T0 + 4,
    JSON.stringify({ time: { created: OC_T0 + 4 }, outcome: "succeeded" }),
  );
  insertMsg.run(
    "msg_c1",
    OPENCODE_SESSION,
    "compaction",
    4,
    OC_T0 + 5,
    OC_T0 + 5,
    JSON.stringify({ time: { created: OC_T0 + 5 } }),
  );
  insertMsg.run("msg_bad", OPENCODE_SESSION, "assistant", 5, OC_T0 + 6, OC_T0 + 6, "{corrupt json");
  db.close();
  return dbPath;
}

// --- CLI helpers ------------------------------------------------------------

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

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


/** Keep ambient HERDR_SOCKET_PATH consistent with an explicit --socket flag
 *  (resolveTarget fails closed on contradiction, #83). */
function socketConsistentEnv(args: string[], extraEnv?: Record<string, string>): Record<string, string> | undefined {
  const i = args.indexOf("--socket");
  const socket = i >= 0 ? args[i + 1] : undefined;
  return socket ? { HERDR_SOCKET_PATH: socket, ...extraEnv } : extraEnv;
}

function runCli(args: string[], extraEnv?: Record<string, string>): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: cliEnv(socketConsistentEnv(args, extraEnv)),
    timeout: 30_000,
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

function runCliAsync(args: string[], extraEnv?: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: cliEnv(socketConsistentEnv(args, extraEnv)) });
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
      let json: Record<string, unknown> | null = null;
      let error: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        /* usage */
      }
      try {
        error = (JSON.parse(stderr) as { error?: Record<string, unknown> }).error ?? null;
      } catch {
        /* empty */
      }
      resolve({ status: code ?? -1, stdout, stderr, json, error });
    });
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
    server.listen(socketPath, () => resolveListen());
  });
  return {
    socketPath,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

function setupEnv(): {
  stateDir: string;
  extra: Record<string, string>;
  codexHome: string;
  opencodeDir: string;
  claudeHome: string;
} {
  const stateDir = tempDir();
  const codexHome = tempDir();
  const opencodeDir = tempDir();
  const claudeHome = tempDir();
  return {
    stateDir,
    codexHome,
    opencodeDir,
    claudeHome,
    extra: {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONFIG_DIR: path.join(stateDir, "config"),
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: codexHome,
      OPENCODE_DATA_DIR: opencodeDir,
      XDG_DATA_HOME: path.join(stateDir, "xdg"), // nonexistent → no ambient opencode
    },
  };
}

const t = (name: string, fn: () => void | Promise<void>) => test(name, fn, 30_000);

describe("codex adapter", () => {
  test("resolveCodexTranscript finds rollout by session id", async () => {
    const { codexHome, rolloutPath } = writeCodexHome();
    const found = await resolveCodexTranscript(CODEX_SESSION, CWD, { CODEX_HOME: codexHome });
    expect(found).toBe(rolloutPath);
    expect(await resolveCodexTranscript("no-such", CWD, { CODEX_HOME: codexHome })).toBeNull();
  });

  test("scanTranscript normalizes a codex rollout", async () => {
    const file = path.join(tempDir(), "rollout.jsonl");
    writeFileSync(
      file,
      codexRolloutLines()
        .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
        .join("\n") + "\n",
    );
    const factory = (_c: unknown, startTurn: number) =>
      codexLineParser("rollout.jsonl", IDENTITY, startTurn);
    const scan = await scanTranscript(file, null, null, IDENTITY, factory as never);
    expect(scan.error).toBeNull();
    expect(scan.malformed_lines).toBe(1);
    const types = scan.events.map((e) => e.type);
    expect(types).toEqual([
      "turn",
      "user_message",
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
    const user = scan.events[1];
    expect(user?.text).toBe("fix the bug");
    expect(user?.turn_index).toBe(1);
    const toolCall = scan.events[2];
    expect(toolCall?.tool_name).toBe("shell");
    expect(toolCall?.tool_use_id).toBe("call_1");
    expect(toolCall?.tool_input).toEqual({ command: "ls" });
    const toolResult = scan.events[3];
    expect(toolResult?.tool_use_id).toBe("call_1");
    expect(toolResult?.text).toBe("a.txt");
    const assistant = scan.events[4];
    expect(assistant?.text).toBe("done");
    expect(assistant?.model).toBe("gpt-6-test");
    expect(assistant?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
      thinking_tokens: 5,
    });
    // resume stays monotonic
    expect(scan.turn_index).toBe(1);
  });

  test("codex legacy event_msg user/agent_message payloads normalize", async () => {
    const file = path.join(tempDir(), "legacy.jsonl");
    const lines = [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "legacy prompt" },
      },
      {
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "legacy reply" },
      },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const factory = (_c: unknown, startTurn: number) =>
      codexLineParser("legacy.jsonl", IDENTITY, startTurn);
    const scan = await scanTranscript(file, null, null, IDENTITY, factory as never);
    expect(scan.events.map((e) => e.type)).toEqual(["turn", "user_message", "assistant_message"]);
    expect(scan.events[2]?.text).toBe("legacy reply");
  });
});

describe("opencode adapter", () => {
  test("resolveOpenCodeTranscript + scanOpenCodeSession normalize v2 rows", async () => {
    const dir = tempDir();
    const dbPath = writeOpenCodeDb(dir);
    const resolution = await resolveOpenCodeTranscript(OPENCODE_SESSION, CWD, {
      OPENCODE_DATA_DIR: dir,
    });
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") return;
    expect(resolution.dbPath).toBe(dbPath);
    expect(resolution.schema).toBe("v2");
    expect(resolution.directory).toBe(CWD);

    const scan = scanOpenCodeSession(resolution, { ...IDENTITY, agent: "opencode" });
    expect(scan.error).toBeNull();
    expect(scan.malformed_lines).toBe(1); // corrupt data row skipped
    expect(scan.turn_count).toBe(1);
    const types = scan.events.map((e) => e.type);
    expect(types).toEqual([
      "turn",
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "system",
    ]);
    const user = scan.events[1];
    expect(user?.text).toBe("hello opencode");
    expect(user?.timestamp).toBe(new Date(OC_T0 + 1).toISOString());
    const assistant = scan.events[2];
    expect(assistant?.text).toBe("hi there");
    expect(assistant?.model).toBe("openai/gpt-5.4-mini");
    expect(assistant?.cost_usd).toBe(0.01);
    expect(assistant?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 25, // output + reasoning
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 0,
      thinking_tokens: 5,
    });
    const okTool = scan.events[3];
    expect(okTool?.tool_name).toBe("bash");
    expect(okTool?.tool_use_id).toBe("call-1");
    const okResult = scan.events[4];
    expect(okResult?.text).toBe("file.txt");
    expect(okResult?.is_error).toBeUndefined();
    const errResult = scan.events[6];
    expect(errResult?.is_error).toBe(true);
    const system = scan.events[7];
    expect(system?.subtype).toBe("compaction");
    // reasoning part never surfaced as text
    expect(JSON.stringify(scan.events)).not.toContain("thinking…");
  });

  test("resolution failures are explicit", async () => {
    const dir = tempDir();
    writeOpenCodeDb(dir);
    // session id absent from the db
    const notFound = await resolveOpenCodeTranscript("ses_absent", CWD, {
      OPENCODE_DATA_DIR: dir,
    });
    expect(notFound.status).toBe("session_not_found");
    // legacy storage layout only
    const legacy = tempDir();
    mkdirSync(path.join(legacy, "storage", "message"), { recursive: true });
    const layout = await resolveOpenCodeTranscript(OPENCODE_SESSION, CWD, {
      OPENCODE_DATA_DIR: legacy,
    });
    expect(layout.status).toBe("unsupported_layout");
    // nothing at all
    const missing = await resolveOpenCodeTranscript(OPENCODE_SESSION, CWD, {
      OPENCODE_DATA_DIR: tempDir(),
      XDG_DATA_HOME: path.join(tempDir(), "xdg"),
    });
    expect(missing.status).toBe("missing");
  });

  test("v1 message+part tables normalize", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "opencode.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)");
    db.run(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    db.run(
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    db.query("INSERT INTO session (id, directory) VALUES (?, ?)").run(OPENCODE_SESSION, CWD);
    db.query(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "msg_v1u",
      OPENCODE_SESSION,
      OC_T0,
      OC_T0,
      JSON.stringify({ role: "user", time: { created: OC_T0 } }),
    );
    db.query(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "prt_v1u1",
      "msg_v1u",
      OPENCODE_SESSION,
      OC_T0,
      OC_T0,
      JSON.stringify({ type: "text", text: "v1 prompt" }),
    );
    db.query(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "msg_v1a",
      OPENCODE_SESSION,
      OC_T0 + 1,
      OC_T0 + 2,
      JSON.stringify({
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        providerID: "anthropic",
        cost: 0.02,
        tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: OC_T0 + 1 },
      }),
    );
    db.query(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "prt_v1a1",
      "msg_v1a",
      OPENCODE_SESSION,
      OC_T0 + 1,
      OC_T0 + 2,
      JSON.stringify({ type: "text", text: "v1 reply" }),
    );
    db.query(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "prt_v1a2",
      "msg_v1a",
      OPENCODE_SESSION,
      OC_T0 + 2,
      OC_T0 + 2,
      JSON.stringify({
        type: "tool",
        tool: "bash",
        callID: "call-v1",
        state: { status: "completed", input: { command: "pwd" }, output: "ok" },
      }),
    );
    db.close();

    const resolution = await resolveOpenCodeTranscript(OPENCODE_SESSION, CWD, {
      OPENCODE_DATA_DIR: dir,
    });
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") return;
    expect(resolution.schema).toBe("v1");
    const scan = scanOpenCodeSession(resolution, { ...IDENTITY, agent: "opencode" });
    expect(scan.error).toBeNull();
    expect(scan.events.map((e) => e.type)).toEqual([
      "turn",
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
    ]);
    expect(scan.events[1]?.text).toBe("v1 prompt");
    expect(scan.events[2]?.text).toBe("v1 reply");
    expect(scan.events[2]?.model).toBe("anthropic/claude-sonnet-4-5");
    expect(scan.events[3]?.tool_use_id).toBe("call-v1");
    expect(scan.events[4]?.text).toBe("ok");
  });
});

describe("conversations t2 cli", () => {
  t("index + history for a codex pane, with paging", async () => {
    const { stateDir, codexHome, extra } = setupEnv();
    const dir = path.join(codexHome, "sessions", "2026", "01", "01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `rollout-2026-01-01T00-00-00-${CODEX_SESSION}.jsonl`),
      codexRolloutLines()
        .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
        .join("\n") + "\n",
    );
    const herdr = await fakeHerdr({
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: CWD }],
      agents: [
        {
          pane_id: "w1:p1",
          agent: "codex",
          agent_status: "idle",
          state_change_seq: 3,
          cwd: CWD,
          agent_session: { agent: "codex", kind: "session", value: CODEX_SESSION },
        },
      ],
    });
    try {
      const idx = await runCliAsync(["index", "--socket", herdr.socketPath], extra);
      expect(idx.status).toBe(0);
      const indexed = idx.json?.indexed as Record<string, unknown>[];
      expect(indexed.length).toBe(1);
      expect(indexed[0]?.provider).toBe("codex");
      expect(indexed[0]?.malformed_lines).toBe(1);

      // history by pane
      const h1 = await runCliAsync(["history", "--pane", "w1:p1", "--offline"], extra);
      expect(h1.status).toBe(0);
      const events = h1.json?.events as Record<string, unknown>[];
      expect(events.map((e) => e.type)).toEqual([
        "turn",
        "user_message",
        "tool_call",
        "tool_result",
        "assistant_message",
      ]);
      const page = h1.json?.page as Record<string, unknown>;
      expect(page.returned).toBe(5);
      expect(page.has_more).toBe(false);
      const session = h1.json?.session as Record<string, unknown>;
      expect(session.provider).toBe("codex");
      expect(session.stale).toBe(false);

      // paging with a tiny limit walks the same events via cursor
      const p1 = await runCliAsync(
        ["history", "--session-id", `codex:${CODEX_SESSION}`, "--limit", "2", "--offline"],
        extra,
      );
      expect(p1.status).toBe(0);
      const page1 = p1.json?.page as Record<string, unknown>;
      expect(page1.returned).toBe(2);
      expect(page1.has_more).toBe(true);
      const p2 = await runCliAsync(
        [
          "history",
          "--session-id",
          `codex:${CODEX_SESSION}`,
          "--limit",
          "3",
          "--cursor",
          String(page1.next_cursor),
          "--offline",
        ],
        extra,
      );
      const all = [
        ...(p1.json?.events as Record<string, unknown>[]),
        ...(p2.json?.events as Record<string, unknown>[]),
      ];
      expect(all.map((e) => e.event_id)).toEqual(events.map((e) => e.event_id));

      // unknown selector → structured error
      const miss = runCli(["history", "--session-id", "codex:nope", "--offline"], extra);
      expect(miss.status).toBe(1);
      expect(miss.error?.kind).toBe("session_not_found");
      // no selector → usage
      const usage = runCli(["history", "--offline"], extra);
      expect(usage.status).toBe(2);
      expect(stateDir).toBeTruthy();
    } finally {
      await herdr.close();
    }
  });

  t("index + history for an opencode pane; rescan rewrites without duplicates", async () => {
    const { stateDir, opencodeDir, extra } = setupEnv();
    writeOpenCodeDb(opencodeDir);
    const herdr = await fakeHerdr({
      panes: [{ pane_id: "w1:p9", cwd: CWD }],
      agents: [
        {
          pane_id: "w1:p9",
          agent: "opencode",
          agent_session: { value: OPENCODE_SESSION },
        },
      ],
    });
    try {
      const first = await runCliAsync(["index", "--socket", herdr.socketPath], extra);
      expect(first.status).toBe(0);
      const indexed = first.json?.indexed as Record<string, unknown>[];
      expect(indexed.length).toBe(1);
      expect(indexed[0]?.provider).toBe("opencode");
      expect(indexed[0]?.reindexed).toBe(true);
      expect(indexed[0]?.malformed_lines).toBe(1);
      const total = indexed[0]?.total_events as number;
      expect(total).toBe(8);

      // second index: full rescan → same count, no duplicated events
      const second = await runCliAsync(["refresh", "--socket", herdr.socketPath], extra);
      expect(second.status).toBe(0);
      const secondIndexed = second.json?.indexed as Record<string, unknown>[];
      expect(secondIndexed[0]?.total_events).toBe(total);
      expect(secondIndexed[0]?.events_appended).toBe(total);

      const h = await runCliAsync(
        ["history", "--session-id", `opencode:${OPENCODE_SESSION}`, "--offline"],
        extra,
      );
      expect(h.status).toBe(0);
      const events = h.json?.events as Record<string, unknown>[];
      expect(events.length).toBe(total);
      const ids = events.map((e) => e.event_id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(events[2]?.model).toBe("openai/gpt-5.4-mini");
      expect(stateDir).toBeTruthy();
    } finally {
      await herdr.close();
    }
  });

  t("opencode session_not_found / unsupported_layout are explicit skips", async () => {
    const { opencodeDir, extra } = setupEnv();
    writeOpenCodeDb(opencodeDir);
    const herdr = await fakeHerdr({
      panes: [
        { pane_id: "w1:p1", cwd: CWD },
        { pane_id: "w1:p2", cwd: CWD },
      ],
      agents: [
        { pane_id: "w1:p1", agent: "opencode", agent_session: { value: "ses_absent" } },
        { pane_id: "w1:p2", agent: "opencode", agent_session: { value: OPENCODE_SESSION } },
      ],
    });
    const legacyDir = tempDir();
    mkdirSync(path.join(legacyDir, "storage", "message"), { recursive: true });
    try {
      // p1: db exists, session absent → session_not_found; p2 indexed ok
      const r = await runCliAsync(["index", "--socket", herdr.socketPath], extra);
      expect(r.status).toBe(0);
      const skipped = r.json?.skipped as Record<string, unknown>[];
      const miss = skipped.find((s) => s.pane_id === "w1:p1");
      expect(miss?.reason).toBe("session_not_found");
      expect(miss?.transcript_path).toContain("opencode.db");
      expect((r.json?.indexed as unknown[]).length).toBe(1);

      // legacy-only layout → unsupported_layout
      const r2 = await runCliAsync(["index", "--socket", herdr.socketPath], {
        ...extra,
        OPENCODE_DATA_DIR: legacyDir,
      });
      const skipped2 = r2.json?.skipped as Record<string, unknown>[];
      expect(skipped2.every((s) => s.reason === "unsupported_layout")).toBe(true);
      expect(skipped2[0]?.data_dir).toBe(legacyDir);
    } finally {
      await herdr.close();
    }
  });

  t("history on a missing events file is explicit, cursor overflow fails", async () => {
    const { stateDir, codexHome, extra } = setupEnv();
    const dir = path.join(codexHome, "sessions", "2026", "01", "01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `rollout-2026-01-01T00-00-00-${CODEX_SESSION}.jsonl`),
      codexRolloutLines()
        .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
        .join("\n") + "\n",
    );
    const herdr = await fakeHerdr({
      panes: [{ pane_id: "w1:p1", cwd: CWD }],
      agents: [{ pane_id: "w1:p1", agent: "codex", agent_session: { value: CODEX_SESSION } }],
    });
    try {
      await runCliAsync(["index", "--socket", herdr.socketPath], extra);
      // delete the events file → record stays, read reports missing
      rmSync(path.join(stateDir, "events", `codex_${CODEX_SESSION}.jsonl`), { force: true });
      const h = await runCliAsync(
        ["history", "--session-id", `codex:${CODEX_SESSION}`, "--offline"],
        extra,
      );
      expect(h.status).toBe(0);
      expect((h.json?.events as unknown[]).length).toBe(0);
      expect((h.json?.page as Record<string, unknown>).events_present).toBe(false);

      // re-index rebuilds the missing event log (missing detection)
      const re = await runCliAsync(["index", "--socket", herdr.socketPath], extra);
      expect(re.status).toBe(0);
      const h2 = await runCliAsync(
        ["history", "--session-id", `codex:${CODEX_SESSION}`, "--offline"],
        extra,
      );
      expect((h2.json?.events as unknown[]).length).toBe(5);

      // cursor beyond the events file size → cursor_invalid
      const eventsPath = path.join(stateDir, "events", `codex_${CODEX_SESSION}.jsonl`);
      const size = statSync(eventsPath).size;
      const bad = runCli(
        [
          "history",
          "--session-id",
          `codex:${CODEX_SESSION}`,
          "--cursor",
          String(size + 1000),
          "--offline",
        ],
        extra,
      );
      expect(bad.status).toBe(1);
      expect(bad.error?.kind).toBe("cursor_invalid");
    } finally {
      await herdr.close();
    }
  });
});
