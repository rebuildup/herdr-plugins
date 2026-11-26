import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claudeLineParser,
  encodeClaudeCwd,
  resolveClaudeTranscript,
} from "../plugins/conversations/src/claude";
import { scanTranscript } from "../plugins/conversations/src/indexer";
import type { ConversationIdentity } from "../plugins/conversations/src/model";

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
for (const key of [
  "HERDR_PLUGIN_STATE_DIR",
  "HERDR_PLUGIN_CONFIG_DIR",
  "HERDR_SOCKET_PATH",
  "HERDR_SESSION",
  "CLAUDE_CONFIG_DIR",
]) {
  savedEnv[key] = process.env[key];
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "conversations-test-"));
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
const CWD = "/repo/proj";

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

/** Keep ambient HERDR_SOCKET_PATH consistent with an explicit --socket flag
 *  (resolveTarget fails closed on contradiction, #83). */
function socketConsistentEnv(
  args: string[],
  extraEnv?: Record<string, string>,
): Record<string, string> | undefined {
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

interface FakePane {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  cwd?: string;
}

/** Fake herdr socket answering session.snapshot from live-mutated state. */
async function fakeHerdr(state: {
  panes: FakePane[];
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

function claudeProjectsRoot(claudeHome: string): string {
  return path.join(claudeHome, "projects");
}

/** Write a claude transcript fixture; returns the file path. */
function writeTranscript(
  claudeHome: string,
  cwd: string,
  sessionId: string,
  lines: unknown[],
): string {
  const dir = path.join(claudeProjectsRoot(claudeHome), encodeClaudeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(
    file,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
  return file;
}

function fixtureLines(): unknown[] {
  return [
    { type: "mode", mode: "normal", sessionId: SESSION_ID }, // bookkeeping: skipped
    {
      type: "user",
      uuid: "u-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      sessionId: SESSION_ID,
      cwd: CWD,
      message: { role: "user", content: "please fix the bug" },
    },
    {
      type: "assistant",
      uuid: "a-1",
      timestamp: "2026-01-01T00:00:02.000Z",
      sessionId: SESSION_ID,
      message: {
        id: "msg-1",
        role: "assistant",
        model: "claude-test-1",
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
          output_tokens_details: { thinking_tokens: 1 },
        },
      },
    },
    {
      type: "user",
      uuid: "u-2",
      timestamp: "2026-01-01T00:00:03.000Z",
      sessionId: SESSION_ID,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "a.txt\n", is_error: false },
        ],
      },
    },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "s-1",
      timestamp: "2026-01-01T00:00:04.000Z",
    },
    "{not valid json",
    { type: "attachment", attachment: { type: "hook_success" } }, // bookkeeping: skipped
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
    },
  };
}

function eventLines(stateDir: string): Record<string, unknown>[] {
  const eventsDir = path.join(stateDir, "events");
  const files = readdirSync(eventsDir);
  expect(files.length).toBe(1);
  return readFileSync(path.join(eventsDir, files[0] as string), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const t = (name: string, fn: () => void | Promise<void>) => test(name, fn, 30_000);

describe("conversations unit", () => {
  test("encodeClaudeCwd matches claude's directory encoding", () => {
    expect(encodeClaudeCwd("/Users/rebui/.dotfiles")).toBe("-Users-rebui--dotfiles");
    expect(encodeClaudeCwd("/repo/proj")).toBe("-repo-proj");
  });

  test("resolveClaudeTranscript prefers cwd dir, falls back to any subdir", async () => {
    const claudeHome = tempDir();
    const env = { CLAUDE_CONFIG_DIR: claudeHome };
    // File only under an unrelated subdir → fallback scan finds it.
    const other = path.join(claudeProjectsRoot(claudeHome), "-other-place");
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, `${SESSION_ID}.jsonl`), "{}\n");
    const found = await resolveClaudeTranscript(SESSION_ID, "/no/such/cwd", env);
    expect(found).toBe(path.join(other, `${SESSION_ID}.jsonl`));
    expect(await resolveClaudeTranscript("missing-id", "/repo", env)).toBeNull();
  });

  test("scanTranscript is incremental and detects rewrites", async () => {
    const dir = tempDir();
    const file = path.join(dir, "s.jsonl");
    const identity = {
      host: "h",
      herdr_session: "s",
      workspace_id: null,
      tab_id: null,
      pane_id: "p1",
      agent: "claude",
      agent_session: { value: "sid" },
      state_change_seq: 1,
    } satisfies ConversationIdentity;
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          role: "assistant",
          model: "m",
          content: [{ type: "text", text: "yo" }],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");

    const factory = (_c: unknown, startTurn: number) =>
      claudeLineParser("s.jsonl", identity, startTurn);

    const first = await scanTranscript(file, null, null, identity, factory as never);
    expect(first.error).toBeNull();
    expect(first.events.map((e) => e.type)).toEqual(["turn", "user_message", "assistant_message"]);
    expect(first.cursor?.line_count).toBe(2);
    expect(first.turn_index).toBe(1);

    // Append one more user line → resume picks up only the new line.
    appendFileSync(
      file,
      JSON.stringify({
        type: "user",
        uuid: "u2",
        timestamp: "2026-01-01T00:00:02Z",
        message: { role: "user", content: "again" },
      }) + "\n",
    );
    const second = await scanTranscript(
      file,
      first.cursor,
      first.guard_hash,
      identity,
      factory as never,
      { startTurn: first.turn_index },
    );
    expect(second.events.map((e) => e.type)).toEqual(["turn", "user_message"]);
    expect(second.events[0]?.turn_index).toBe(2);
    expect(second.reindexed).toBe(false);

    // In-place rewrite of earlier bytes → guard mismatch → full rescan.
    writeFileSync(
      file,
      JSON.stringify({
        type: "user",
        uuid: "uX",
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "rewritten" },
      }) +
        "\n" +
        lines.join("\n") +
        "\n" +
        JSON.stringify({
          type: "user",
          uuid: "u2",
          timestamp: "2026-01-01T00:00:02Z",
          message: { role: "user", content: "again" },
        }) +
        "\n",
    );
    const third = await scanTranscript(
      file,
      second.cursor,
      second.guard_hash,
      identity,
      factory as never,
      { startTurn: second.turn_index },
    );
    expect(third.reindexed).toBe(true);
    expect(third.events.length).toBeGreaterThan(second.events.length);
  });
});

describe("conversations cli", () => {
  t("capability advertises the v1 contract and provider support", () => {
    const { extra } = setupEnv();
    const r = runCli(["capability"], extra);
    expect(r.status).toBe(0);
    expect(r.json?.contract).toBe("herdr-plugins.conversations/v1");
    const providers = r.json?.providers as { id: string; status: string }[];
    expect(providers.find((p) => p.id === "claude")?.status).toBe("supported");
    expect(providers.find((p) => p.id === "codex")?.status).toBe("supported");
    expect(providers.find((p) => p.id === "opencode")?.status).toBe("supported");
  });

  t("index normalizes a claude fixture end-to-end", async () => {
    const { stateDir, claudeHome, extra } = setupEnv();
    writeTranscript(claudeHome, CWD, SESSION_ID, fixtureLines());
    const herdr = await fakeHerdr({
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: CWD }],
      agents: [
        {
          pane_id: "w1:p1",
          agent: "claude",
          agent_status: "idle",
          state_change_seq: 7,
          cwd: CWD,
          agent_session: { agent: "claude", kind: "session", value: SESSION_ID },
        },
      ],
    });
    try {
      const r = await runCliAsync(["index", "--socket", herdr.socketPath], extra);
      expect(r.status).toBe(0);
      const indexed = r.json?.indexed as Record<string, unknown>[];
      expect(indexed.length).toBe(1);
      expect(indexed[0]?.events_appended).toBe(6); // turn,user,assistant+tool_call? see below
      const events = eventLines(stateDir);
      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "turn",
        "user_message",
        "assistant_message",
        "tool_call",
        "tool_result",
        "system",
      ]);
      const assistant = events.find((e) => e.type === "assistant_message");
      expect(assistant?.model).toBe("claude-test-1");
      expect(assistant?.usage).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
        thinking_tokens: 1,
      });
      const identity = events[0]?.identity as Record<string, unknown>;
      expect(identity.pane_id).toBe("w1:p1");
      expect(identity.workspace_id).toBe("w1");
      expect(identity.herdr_session).toBe("test-session");
      expect(identity.state_change_seq).toBe(7);
      expect((identity.agent_session as Record<string, unknown>).value).toBe(SESSION_ID);
      const toolCall = events.find((e) => e.type === "tool_call");
      expect(toolCall?.tool_name).toBe("Bash");
      expect(toolCall?.tool_use_id).toBe("tool-1");
      expect(events[1]?.turn_index).toBe(1);
      expect(events[4]?.turn_index).toBe(1);
    } finally {
      await herdr.close();
    }
  });

  t("index is incremental across runs", async () => {
    const { stateDir, claudeHome, extra } = setupEnv();
    const file = writeTranscript(claudeHome, CWD, SESSION_ID, fixtureLines().slice(0, 4));
    const herdr = await fakeHerdr({
      panes: [{ pane_id: "w1:p1", cwd: CWD }],
      agents: [
        {
          pane_id: "w1:p1",
          agent: "claude",
          agent_session: { value: SESSION_ID },
        },
      ],
    });
    try {
      const first = await runCliAsync(["index", "--socket", herdr.socketPath], extra);
      expect(first.status).toBe(0);
      const firstCount = eventLines(stateDir).length;
      appendFileSync(
        file,
        JSON.stringify({
          type: "user",
          uuid: "u-3",
          timestamp: "2026-01-01T00:01:00Z",
          message: { role: "user", content: "second prompt" },
        }) + "\n",
      );
      const second = await runCliAsync(["refresh", "--socket", herdr.socketPath], extra);
      expect(second.status).toBe(0);
      const indexed = second.json?.indexed as Record<string, unknown>[];
      expect(indexed[0]?.events_appended).toBe(2); // turn + user_message
      expect(indexed[0]?.reindexed).toBe(false);
      const all = eventLines(stateDir);
      expect(all.length).toBe(firstCount + 2);
      const lastTurn = all.filter((e) => e.type === "turn").at(-1);
      expect(lastTurn?.turn_index).toBe(2);
    } finally {
      await herdr.close();
    }
  });

  t(
    "unknown provider, missing session, and missing transcript are explicit, not success",
    async () => {
      const { stateDir, claudeHome, extra } = setupEnv();
      const codexHome = tempDir(); // empty CODEX_HOME → codex resolves missing
      writeTranscript(claudeHome, CWD, SESSION_ID, fixtureLines());
      const herdr = await fakeHerdr({
        panes: [
          { pane_id: "w1:p1", cwd: CWD },
          { pane_id: "w1:p2", cwd: CWD },
          { pane_id: "w1:p3", cwd: CWD },
          { pane_id: "w1:p4", cwd: CWD },
        ],
        agents: [
          // supported provider, transcript present → indexed
          { pane_id: "w1:p1", agent: "claude", agent_session: { value: SESSION_ID } },
          // supported provider (T2) but no rollout on disk → transcript_missing
          { pane_id: "w1:p2", agent: "codex", agent_session: { value: "codex-rollout-1" } },
          // claude but no transcript on disk → transcript_missing
          { pane_id: "w1:p3", agent: "claude", agent_session: { value: "no-such-session" } },
          // unlisted provider → unknown_provider
          { pane_id: "w1:p4", agent: "gemini", agent_session: { value: "gem-1" } },
        ],
      });
      try {
        const r = await runCliAsync(["index", "--socket", herdr.socketPath], {
          ...extra,
          CODEX_HOME: codexHome,
        });
        expect(r.status).toBe(0);
        const skipped = r.json?.skipped as Record<string, unknown>[];
        const reasons = skipped.map((s) => s.reason);
        expect(reasons).toContain("unknown_provider");
        expect(reasons).toContain("transcript_missing");
        expect(reasons.filter((x) => x === "transcript_missing").length).toBe(2);
        const unknown = skipped.find((s) => s.reason === "unknown_provider");
        expect(unknown?.pane_id).toBe("w1:p4");
        const codex = skipped.find((s) => s.provider === "codex");
        expect(codex?.reason).toBe("transcript_missing");
        const sessions = await runCliAsync(["sessions", "--socket", herdr.socketPath], extra);
        const list = sessions.json?.sessions as Record<string, unknown>[];
        expect(list.length).toBe(1);
        expect(list[0]?.provider).toBe("claude");
        expect(stateDir).toBeTruthy();
      } finally {
        await herdr.close();
      }
    },
  );

  t("pane reuse / generation change marks the index stale", async () => {
    const { claudeHome, extra } = setupEnv();
    writeTranscript(claudeHome, CWD, SESSION_ID, fixtureLines());
    const herdrState = {
      panes: [{ pane_id: "w1:p1", cwd: CWD }] as FakePane[],
      agents: [
        { pane_id: "w1:p1", agent: "claude", agent_session: { value: SESSION_ID } } as FakeAgent,
      ],
    };
    const herdr = await fakeHerdr(herdrState);
    try {
      const first = await runCliAsync(["index", "--socket", herdr.socketPath], extra);
      expect(first.status).toBe(0);

      // Same pane id, different agent generation (session id changed).
      herdrState.agents = [
        { pane_id: "w1:p1", agent: "claude", agent_session: { value: "different-session" } },
      ];
      const sessions = await runCliAsync(["sessions", "--socket", herdr.socketPath], extra);
      expect(sessions.status).toBe(0);
      const list = sessions.json?.sessions as Record<string, unknown>[];
      const entry = list.find((s) => s.session_id === SESSION_ID);
      expect(entry?.stale).toBe(true);
      expect(entry?.stale_reason).toBe("agent_session_changed");
    } finally {
      await herdr.close();
    }
  });

  t("sessions --offline lists indexed transcripts without a socket", async () => {
    const { stateDir, claudeHome, extra } = setupEnv();
    writeTranscript(claudeHome, CWD, SESSION_ID, fixtureLines());
    const herdr = await fakeHerdr({
      panes: [{ pane_id: "w1:p1", cwd: CWD }],
      agents: [{ pane_id: "w1:p1", agent: "claude", agent_session: { value: SESSION_ID } }],
    });
    try {
      await runCliAsync(["index", "--socket", herdr.socketPath], extra);
    } finally {
      await herdr.close();
    }
    // Dead socket + --offline: still lists, live=null, no stale verdict.
    const r = runCli(["sessions", "--offline"], extra);
    expect(r.status).toBe(0);
    const list = r.json?.sessions as Record<string, unknown>[];
    expect(list.length).toBe(1);
    expect(list[0]?.live).toBeNull();
    expect(list[0]?.stale).toBe(false);
    expect(list[0]?.event_count).toBe(6);
    expect(stateDir).toBeTruthy();
  });
});
