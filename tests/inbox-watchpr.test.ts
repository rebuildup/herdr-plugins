import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LinkWatchObservation } from "../plugins/inbox/src/state";
import {
  buildObservation,
  collectWatchTargets,
  diffObservation,
  pollBackoffMs,
  pruneWatchSession,
} from "../plugins/inbox/src/watchpr";
import { installStub } from "./helpers/stub-bin";
import { herdrSocketEndpoint, joinPathEnv, testEnv } from "./helpers/test-env";

/**
 * Tests for `inbox watch-pr` (Issue #178):
 * - pure unit tests for observation building / diffing / backoff / pruning
 * - contract tests against a fake herdr socket + a fake `gh` on PATH,
 *   exercising the REAL git plugin CLI as the only gh path (ADR-0013).
 *
 * HERDR_* env is stripped in every spawned CLI (issue #199 hygiene); the
 * fake socket, plugin state/config dirs, and gh stub dir are pinned
 * explicitly per spawn.
 */

const INBOX_CLI = path.join(import.meta.dir, "../plugins/inbox/src/cli.ts");

const dirs: string[] = [];
function tempDir(prefix = "inbox-watchpr-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit: buildObservation / diffObservation / pollBackoffMs / targets
// ---------------------------------------------------------------------------

const OBS_BASE: LinkWatchObservation = {
  state: "OPEN",
  isDraft: false,
  mergeStateStatus: "BLOCKED",
  mergeable: "MERGEABLE",
  updatedAt: "2026-01-10T00:00:00Z",
  author: "agent-bot",
  failingChecks: [],
  reviewKeys: [],
  commentKeys: [],
};

describe("buildObservation", () => {
  test("normalizes view/comments/checks and excludes the PR author's activity", () => {
    const obs = buildObservation(
      {
        pr: {
          state: "open",
          isDraft: false,
          mergeStateStatus: "BLOCKED",
          mergeable: "MERGEABLE",
          updatedAt: "2026-01-10T01:00:00Z",
          author: { login: "Agent-Bot" },
          reviews: [
            { author: "reviewer1", state: "APPROVED", submittedAt: "2026-01-10T00:30:00Z" },
            // PR author's own review — self proxy, must not wake.
            { author: "agent-bot", state: "COMMENTED", submittedAt: "2026-01-10T00:31:00Z" },
          ],
        },
      },
      {
        issue_comments: [
          { id: 11, author: "someone" },
          { id: 12, author: "agent-bot" }, // self comment — excluded
        ],
        line_comments: [{ id: 21, author: "reviewer1" }],
      },
      {
        checks: [
          { name: "ci", bucket: "fail" },
          { name: "lint", bucket: "pass" },
          { name: "e2e", bucket: "cancel" },
        ],
      },
    );
    expect("error" in obs).toBe(false);
    if ("error" in obs) return;
    expect(obs.state).toBe("OPEN");
    expect(obs.author).toBe("Agent-Bot");
    expect(obs.reviewKeys).toEqual(["reviewer1|APPROVED|2026-01-10T00:30:00Z"]);
    expect(obs.commentKeys).toEqual(["11", "21"]);
    expect(obs.failingChecks).toEqual(["ci", "e2e"]);
  });

  test("missing pr payload is an error, not data", () => {
    const obs = buildObservation({}, {}, {});
    expect("error" in obs).toBe(true);
  });
});

describe("diffObservation", () => {
  test("first observation is a silent baseline (even when already terminal)", () => {
    const merged = { ...OBS_BASE, state: "MERGED" };
    const diff = diffObservation(undefined, merged);
    expect(diff.triggers).toEqual([]);
    expect(diff.terminal).toBe("merged");
    const open = diffObservation(undefined, OBS_BASE);
    expect(open.triggers).toEqual([]);
    expect(open.terminal).toBeUndefined();
  });

  test("merge/close transitions trigger and terminate", () => {
    expect(diffObservation(OBS_BASE, { ...OBS_BASE, state: "MERGED" })).toMatchObject({
      triggers: ["merged"],
      terminal: "merged",
    });
    expect(diffObservation(OBS_BASE, { ...OBS_BASE, state: "CLOSED" })).toMatchObject({
      triggers: ["closed"],
      terminal: "closed",
    });
  });

  test("new failing checks trigger once (set diff, not flap)", () => {
    const next = { ...OBS_BASE, failingChecks: ["ci"] };
    const diff = diffObservation(OBS_BASE, next);
    expect(diff.triggers).toEqual(["check_failed"]);
    expect(diff.newFailingChecks).toEqual(["ci"]);
    // Same failure persisting is not a new trigger.
    expect(diffObservation(next, next).triggers).toEqual([]);
    // Recovery then re-failure triggers again (real transition).
    const recovered = diffObservation(next, OBS_BASE);
    expect(recovered.triggers).toEqual([]);
    expect(diffObservation(OBS_BASE, next).triggers).toEqual(["check_failed"]);
  });

  test("mergeStateStatus DIRTY transition triggers merge_conflict; other churn does not", () => {
    expect(diffObservation(OBS_BASE, { ...OBS_BASE, mergeStateStatus: "DIRTY" }).triggers).toEqual([
      "merge_conflict",
    ]);
    expect(diffObservation({ ...OBS_BASE, mergeStateStatus: "DIRTY" }, OBS_BASE).triggers).toEqual(
      [],
    );
    expect(
      diffObservation(OBS_BASE, { ...OBS_BASE, mergeStateStatus: "UNSTABLE" }).triggers,
    ).toEqual([]);
    expect(diffObservation(OBS_BASE, { ...OBS_BASE, mergeStateStatus: "CLEAN" }).triggers).toEqual(
      [],
    );
  });

  test("new reviews/comments trigger with counts", () => {
    const next = {
      ...OBS_BASE,
      reviewKeys: ["rev|APPROVED|t1"],
      commentKeys: ["5", "6"],
    };
    const diff = diffObservation(OBS_BASE, next);
    expect(diff.triggers).toEqual(["review", "comment"]);
    expect(diff.newReviewCount).toBe(1);
    expect(diff.newCommentCount).toBe(2);
  });
});

describe("pollBackoffMs", () => {
  test("exponential with cap", () => {
    expect(pollBackoffMs(120_000, 1)).toBe(240_000);
    expect(pollBackoffMs(120_000, 3)).toBe(960_000);
    expect(pollBackoffMs(120_000, 10)).toBe(1_800_000);
  });
});

// ---------------------------------------------------------------------------
// Contract harness: fake herdr socket + fake gh + real git plugin CLI
// ---------------------------------------------------------------------------

interface FakeHerdr {
  socketPath: string;
  setPanes(panes: Array<Record<string, unknown>>): void;
  setAgents(agents: Array<Record<string, unknown>>): void;
  close(): Promise<void>;
}

async function fakeHerdr(
  panes: Array<Record<string, unknown>>,
  agents: Array<Record<string, unknown>>,
): Promise<FakeHerdr> {
  const dir = tempDir("inbox-watchpr-sock-");
  const socketPath = path.join(dir, "herdr.sock");
  let currentPanes = panes;
  let currentAgents = agents;
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
                snapshot: { session: { name: "fake" }, panes: currentPanes, agents: currentAgents },
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
    setPanes(next) {
      currentPanes = next;
    },
    setAgents(next) {
      currentAgents = next;
    },
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

/** Env for spawned inbox CLIs: HERDR_* scrubbed by testEnv, dirs + gh stub pinned. */
function cliEnv(
  stateDir: string,
  configDir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return testEnv({
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
    ...extra,
  });
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  lines: Array<Record<string, unknown>>;
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  // process.execPath is bun itself — a bare "bun" argv does not resolve
  // through PATH on Windows (issue #266).
  const proc = Bun.spawn([process.execPath, "run", INBOX_CLI, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // JSONL commands emit compact one-object-per-line docs; single-doc
  // commands pretty-print, so only parse complete `{`-prefixed lines that
  // happen to be self-contained JSON (compact events).
  const lines = stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((line): line is Record<string, unknown> => line !== null);
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status, stdout, stderr, json, lines };
}

// --- fake gh ---------------------------------------------------------------

const GH_STUB = `#!/usr/bin/env bash
set -u
DIR="\${GH_STUB_DIR:?}"
printf '%s\\n' "$*" >> "\${GH_STUB_LOG:-/dev/null}"
case "\${1:-}" in
  --version) echo "gh version \${GH_STUB_VERSION:-2.105.0}"; exit 0;;
  auth)
    if [ "\${GH_STUB_AUTH_FAIL:-0}" = "1" ]; then echo "not logged in" >&2; exit 1; fi
    echo "github.com"; exit 0;;
  api)
    if [ "\${GH_STUB_FAIL:-0}" = "1" ]; then
      echo "HTTP 403: API rate limit exceeded" >&2; exit 1
    fi
    case "$*" in
      *issues/*/comments*) cat "$DIR/issue-comments.json" 2>/dev/null || echo '[]';;
      *pulls/*/comments*) cat "$DIR/line-comments.json" 2>/dev/null || echo '[]';;
      *pulls/*) cat "$DIR/pulls.json";;
      *) exit 1;;
    esac
    exit 0;;
  pr)
    if [ "\${GH_STUB_FAIL:-0}" = "1" ]; then
      echo "HTTP 403: API rate limit exceeded" >&2; exit 1
    fi
    case "\${2:-}" in
      view) cat "$DIR/view.json";;
      checks) cat "$DIR/checks.json";;
      *) exit 1;;
    esac
    exit 0;;
esac
exit 1
`;

/**
 * TypeScript twin of {@link GH_STUB} for Windows (issue #225) — compiled
 * to `gh.exe` by `installStub`. No backslashes/backticks/`${` so it can
 * sit inside the template literal; `NL` stands in for "\n".
 */
const GH_STUB_TS = `import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const NL = String.fromCharCode(10);
const args = process.argv.slice(2);
const joined = args.join(" ");
const cmd = args[0] ?? "";
const sub = args[1] ?? "";
const has = (re: string): boolean => new RegExp(re).test(joined);
const DIR = process.env.GH_STUB_DIR;
let code = 0;

if (DIR === undefined || DIR === "") {
  process.stderr.write("GH_STUB_DIR: parameter null or not set" + NL);
  code = 1;
} else {
  const logFile = process.env.GH_STUB_LOG;
  if (logFile !== undefined && logFile !== "") {
    try {
      appendFileSync(logFile, joined + NL);
    } catch {
      /* ignore */
    }
  }
  const catFixture = (name: string): void => {
    try {
      process.stdout.write(readFileSync(path.join(DIR, name), "utf8"));
    } catch {
      process.stderr.write("cat: " + path.join(DIR, name) + ": No such file or directory" + NL);
    }
  };
  const catFixtureOrEmpty = (name: string): void => {
    try {
      process.stdout.write(readFileSync(path.join(DIR, name), "utf8"));
    } catch {
      process.stdout.write("[]" + NL);
    }
  };
  const fail = (): void => {
    process.stderr.write("HTTP 403: API rate limit exceeded" + NL);
    code = 1;
  };

  if (cmd === "--version") {
    const v = process.env.GH_STUB_VERSION;
    process.stdout.write("gh version " + (v === undefined || v === "" ? "2.105.0" : v) + NL);
  } else if (cmd === "auth") {
    if (process.env.GH_STUB_AUTH_FAIL === "1") {
      process.stderr.write("not logged in" + NL);
      code = 1;
    } else process.stdout.write("github.com" + NL);
  } else if (cmd === "api") {
    if (process.env.GH_STUB_FAIL === "1") fail();
    else if (has("issues/[^]*/comments")) catFixtureOrEmpty("issue-comments.json");
    else if (has("pulls/[^]*/comments")) catFixtureOrEmpty("line-comments.json");
    else if (has("pulls/")) catFixture("pulls.json");
    else code = 1;
  } else if (cmd === "pr") {
    if (process.env.GH_STUB_FAIL === "1") fail();
    else if (sub === "view") catFixture("view.json");
    else if (sub === "checks") catFixture("checks.json");
    else code = 1;
  } else code = 1;
}
process.exitCode = code;
`;

interface GhStub {
  binDir: string;
  stubDir: string;
  logFile: string;
  env: Record<string, string>;
  calls(): string[];
  write(name: string, value: unknown): void;
}

function installGhStub(): GhStub {
  const binDir = tempDir("inbox-watchpr-bin-");
  const stubDir = tempDir("inbox-watchpr-gh-");
  const logFile = path.join(tempDir("inbox-watchpr-log-"), "gh.log");
  installStub(binDir, { name: "gh", posix: GH_STUB, windows: GH_STUB_TS });
  const stub: GhStub = {
    binDir,
    stubDir,
    logFile,
    env: {
      PATH: joinPathEnv(binDir),
      GH_STUB_DIR: stubDir,
      GH_STUB_LOG: logFile,
    },
    calls() {
      try {
        return readFileSync(logFile, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    write(name, value) {
      writeFileSync(path.join(stubDir, name), `${JSON.stringify(value)}\n`);
    },
  };
  return stub;
}

// --- fixtures ---------------------------------------------------------------

function prView(state = "OPEN", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 5,
    title: "feature",
    state,
    isDraft: false,
    author: { login: "agent-bot" },
    headRefName: "feature",
    baseRefName: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "",
    url: "https://github.com/octo/widgets/pull/5",
    body: "",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-10T00:00:00Z",
    statusCheckRollup: [],
    reviews: [],
    ...overrides,
  };
}

function seedGh(stub: GhStub): void {
  stub.write("view.json", prView());
  stub.write("pulls.json", {
    head: { ref: "feature", sha: "abc123" },
    base: { ref: "main", sha: "def456" },
    requested_reviewers: [],
    requested_teams: [],
  });
  stub.write("issue-comments.json", [{ id: 1, author: "someone", body: "hi" }]);
  stub.write("line-comments.json", []);
  // `gh pr checks --json` emits a bare array (no wrapper object).
  stub.write("checks.json", [{ name: "ci", bucket: "pass", state: "SUCCESS" }]);
}

interface Harness {
  fake: FakeHerdr;
  stub: GhStub;
  stateDir: string;
  configDir: string;
  repoDir: string;
  env: Record<string, string>;
  pane: Record<string, unknown>;
  agent: Record<string, unknown>;
}

async function harness(opts: { agentSession?: boolean } = {}): Promise<Harness> {
  const stateDir = tempDir("inbox-watchpr-state-");
  const configDir = tempDir("inbox-watchpr-config-");
  const repoDir = tempDir("inbox-watchpr-repo-");
  // The git plugin resolves the pane cwd to a repo root via real git.
  const init = Bun.spawnSync(["git", "init", "-q", repoDir], { env: testEnv() });
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);

  const stub = installGhStub();
  seedGh(stub);

  const agent: Record<string, unknown> = {
    pane_id: "w1:p1",
    agent_status: "done",
    state_change_seq: 1,
  };
  if (opts.agentSession) {
    agent.agent_session = { agent: "claude", kind: "session", value: "sess-1" };
  }
  const pane: Record<string, unknown> = {
    pane_id: "w1:p1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    cwd: repoDir,
  };
  const fake = await fakeHerdr([pane], [agent]);
  const env = cliEnv(stateDir, configDir, stub.env);
  return { fake, stub, stateDir, configDir, repoDir, env, pane, agent };
}

function stateJson(stateDir: string): {
  sessions: Record<string, Record<string, Record<string, unknown>>>;
  watch?: Record<string, Record<string, Record<string, Record<string, unknown>>>>;
} {
  return JSON.parse(readFileSync(path.join(stateDir, "state.json"), "utf8"));
}

function watchRecord(stateDir: string): Record<string, unknown> | undefined {
  const state = stateJson(stateDir);
  const sessionKey = Object.keys(state.watch ?? {})[0];
  const paneWatch = sessionKey ? state.watch?.[sessionKey]?.["w1:p1"] : undefined;
  return paneWatch?.["octo/widgets#5"];
}

const SOCKET = (h: Harness) => ["--socket", h.fake.socketPath];

describe("watch-pr contract", () => {
  test("no declared PR links → no_links, gh never invoked", async () => {
    const h = await harness();
    try {
      const res = await runCli(["watch-pr", "--once", ...SOCKET(h)], h.env);
      expect(res.status).toBe(0);
      const types = res.lines.map((l) => l.type);
      expect(types).toEqual(["watch-pr.started", "watch-pr.tick", "watch-pr.stopped"]);
      expect(res.lines.at(-1)).toMatchObject({ type: "watch-pr.stopped", reason: "no_links" });
      expect(h.stub.calls()).toEqual([]);
    } finally {
      await h.fake.close();
    }
  }, 60000);

  test("issue links are not polled (no git read surface) → no_links", async () => {
    const h = await harness();
    try {
      await runCli(["link", "w1:p1", "--issue", "octo/widgets#5", ...SOCKET(h)], h.env);
      const res = await runCli(["watch-pr", "--once", ...SOCKET(h)], h.env);
      expect(res.lines.at(-1)).toMatchObject({ type: "watch-pr.stopped", reason: "no_links" });
      expect(h.stub.calls()).toEqual([]);
    } finally {
      await h.fake.close();
    }
  }, 60000);

  test("baseline poll stores observation without attention; check failure restores", async () => {
    const h = await harness();
    try {
      await runCli(["settle", "w1:p1", ...SOCKET(h)], h.env);
      await runCli(["link", "w1:p1", "--pr", "octo/widgets#5", ...SOCKET(h)], h.env);

      // Tick 1: baseline only — no triggers, settle mark survives.
      const first = await runCli(["watch-pr", "--once", ...SOCKET(h)], h.env);
      const poll1 = first.lines.find((l) => l.type === "watch-pr.poll");
      expect(poll1).toMatchObject({ ok: true, baseline: true, triggers: [] });
      expect(first.lines.some((l) => l.type === "watch-pr.attention")).toBe(false);
      let state = stateJson(h.stateDir);
      const sessionKey = Object.keys(state.sessions)[0] as string;
      expect(state.sessions[sessionKey]?.["w1:p1"]?.settled).toBeDefined();
      expect(watchRecord(h.stateDir)).toMatchObject({ consecutive_failures: 0 });

      // gh now reports a failing check → attention return.
      h.stub.write("checks.json", [
        { name: "ci", bucket: "fail", state: "FAILURE" },
        { name: "lint", bucket: "pass", state: "SUCCESS" },
      ]);
      const second = await runCli(["watch-pr", "--once", ...SOCKET(h)], h.env);
      const attention = second.lines.find((l) => l.type === "watch-pr.attention");
      expect(attention).toMatchObject({
        pane_id: "w1:p1",
        triggers: ["check_failed"],
        cleared: ["settled"],
      });
      const poll2 = second.lines.find((l) => l.type === "watch-pr.poll");
      expect(poll2).toMatchObject({ baseline: false, triggers: ["check_failed"] });

      state = stateJson(h.stateDir);
      const entry = state.sessions[sessionKey]?.["w1:p1"];
      expect(entry?.settled).toBeUndefined();
      expect(entry?.links).toHaveLength(1); // links survive attention return
      expect(watchRecord(h.stateDir)).toMatchObject({
        observation: { failingChecks: ["ci"] },
      });

      // Tick 3 with unchanged gh data: dedupe — no second attention event.
      const third = await runCli(["watch-pr", "--once", ...SOCKET(h)], h.env);
      expect(third.lines.some((l) => l.type === "watch-pr.attention")).toBe(false);
      const poll3 = third.lines.find((l) => l.type === "watch-pr.poll");
      expect(poll3).toMatchObject({ triggers: [] });
    } finally {
      await h.fake.close();
    }
  }, 60000);

  test("PR merge triggers attention once, records terminal, watch exits all_terminal", async () => {
    const h = await harness();
    try {
      await runCli(["snooze", "w1:p1", "--until", "+1h", ...SOCKET(h)], h.env);
      await runCli(["link", "w1:p1", "--pr", "octo/widgets#5", ...SOCKET(h)], h.env);
      await runCli(["watch-pr", "--once", ...SOCKET(h)], h.env); // baseline

      h.stub.write("view.json", prView("MERGED"));
      const merged = await runCli(["watch-pr", "--once", ...SOCKET(h)], h.env);
      const attention = merged.lines.find((l) => l.type === "watch-pr.attention");
      expect(attention).toMatchObject({ triggers: ["merged"], cleared: ["snoozed"] });
      expect(watchRecord(h.stateDir)).toMatchObject({ terminal: "merged" });

      // Streaming mode: next tick sees nothing pending → exits all_terminal.
      const proc = Bun.spawn(
        ["bun", "run", INBOX_CLI, "watch-pr", "--interval", "1", ...SOCKET(h)],
        { env: h.env, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, , status] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      void stdout;
      const lines = stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(status).toBe(0);
      expect(lines.at(-1)).toMatchObject({
        type: "watch-pr.stopped",
        reason: "all_terminal",
      });
      // The merged PR is never polled again after terminal.
      const callsAfterTerminal = h.stub.calls().filter((c) => c.includes("pr view")).length;
      expect(callsAfterTerminal).toBe(2); // baseline + merged-diff ticks only
    } finally {
      await h.fake.close();
    }
  }, 60000);

  test("unreachable gh → honest error state with backoff, no fabricated data", async () => {
    const h = await harness();
    try {
      await runCli(["link", "w1:p1", "--pr", "octo/widgets#5", ...SOCKET(h)], h.env);
      // Remove gh from PATH entirely while keeping bun/git resolvable:
      // only the toolchain dirs, never the dir containing `gh`.
      // Directories are platform-specific and joined with path.delimiter —
      // the POSIX "/usr/bin:/bin" literals are meaningless on Windows,
      // where git lives under "C:\Program Files\Git\cmd" (#266).
      const toolDirs = [path.dirname(process.execPath)];
      if (process.platform === "win32") {
        const gitBin = Bun.which("git");
        if (gitBin !== null) toolDirs.push(path.dirname(gitBin));
      } else {
        toolDirs.push("/usr/bin", "/bin");
      }
      toolDirs.push(tempDir("inbox-watchpr-empty-"));
      const noGhPath = toolDirs.join(path.delimiter);
      const noGhEnv = { ...h.env, PATH: noGhPath };

      const first = await runCli(["watch-pr", "--once", ...SOCKET(h)], noGhEnv);
      const err = first.lines.find((l) => l.type === "watch-pr.error");
      expect(err).toMatchObject({
        pane_id: "w1:p1",
        ref: "octo/widgets#5",
        ok: false,
        consecutive_failures: 1,
      });
      expect(typeof err?.error).toBe("string");
      expect(err?.next_poll_at).not.toBeNull();
      expect(err?.last_checked_at).toBeNull(); // never successfully checked
      const rec = watchRecord(h.stateDir) as Record<string, unknown> | undefined;
      expect(rec?.observation).toBeUndefined(); // no fabricated baseline
      expect(rec?.last_error).toBeTruthy();

      // Immediate second pass: backoff defers the poll — no new gh spawn.
      const callsBefore = h.stub.calls().length;
      const second = await runCli(["watch-pr", "--once", ...SOCKET(h)], noGhEnv);
      const tick = second.lines.find((l) => l.type === "watch-pr.tick");
      expect(tick).toMatchObject({ deferred: 1, polled: 0, failed: 0 });
      expect(h.stub.calls().length).toBe(callsBefore);
    } finally {
      await h.fake.close();
    }
  }, 60000);

  test("gh rate-limit failure reports error and preserves last good freshness", async () => {
    const h = await harness();
    try {
      await runCli(["link", "w1:p1", "--pr", "octo/widgets#5", ...SOCKET(h)], h.env);
      await runCli(["watch-pr", "--once", ...SOCKET(h)], h.env); // good baseline
      const goodChecked = (watchRecord(h.stateDir) as Record<string, unknown>)
        .last_checked_at as string;

      const failEnv = { ...h.env, GH_STUB_FAIL: "1" };
      const res = await runCli(["watch-pr", "--once", ...SOCKET(h)], failEnv);
      const err = res.lines.find((l) => l.type === "watch-pr.error");
      expect(err).toMatchObject({
        ok: false,
        consecutive_failures: 1,
        last_checked_at: goodChecked, // staleness is honest, not reset
      });
      expect(String(err?.error)).toContain("rate limit");
      // Baseline observation survives the failed poll untouched.
      const rec = watchRecord(h.stateDir) as Record<string, unknown>;
      expect((rec.observation as Record<string, unknown>).state).toBe("OPEN");
      expect(rec.last_error).toBeTruthy();
    } finally {
      await h.fake.close();
    }
  }, 60000);

  test("pane without organize marks: attention event is a no-op on state", async () => {
    const h = await harness();
    try {
      await runCli(["link", "w1:p1", "--pr", "octo/widgets#5", ...SOCKET(h)], h.env);
      await runCli(["watch-pr", "--once", ...SOCKET(h)], h.env);
      h.stub.write("issue-comments.json", [
        { id: 1, author: "someone", body: "hi" },
        { id: 2, author: "reviewer", body: "new comment" },
      ]);
      const res = await runCli(["watch-pr", "--once", ...SOCKET(h)], h.env);
      const attention = res.lines.find((l) => l.type === "watch-pr.attention");
      expect(attention).toMatchObject({ triggers: ["comment"], cleared: [] });
      const state = stateJson(h.stateDir);
      const sessionKey = Object.keys(state.sessions)[0] as string;
      const entry = state.sessions[sessionKey]?.["w1:p1"];
      expect(entry?.settled).toBeUndefined();
      expect(entry?.snoozed).toBeUndefined();
      expect(entry?.archived).toBeUndefined();
      expect(entry?.links).toHaveLength(1);
    } finally {
      await h.fake.close();
    }
  }, 60000);

  test("stale link (agent-session change) is never polled", async () => {
    const h = await harness({ agentSession: true });
    try {
      await runCli(["link", "w1:p1", "--pr", "octo/widgets#5", ...SOCKET(h)], h.env);
      // Agent generation swap: new session fingerprint → link goes stale.
      h.fake.setAgents([
        {
          pane_id: "w1:p1",
          agent_status: "done",
          state_change_seq: 1,
          agent_session: { agent: "claude", kind: "session", value: "sess-2" },
        },
      ]);
      const res = await runCli(["watch-pr", "--once", ...SOCKET(h)], h.env);
      expect(res.lines.at(-1)).toMatchObject({
        type: "watch-pr.stopped",
        reason: "no_links",
      });
      expect(h.stub.calls()).toEqual([]);
    } finally {
      await h.fake.close();
    }
  }, 60000);

  test("unlink removes the watch baseline", async () => {
    const h = await harness();
    try {
      await runCli(["link", "w1:p1", "--pr", "octo/widgets#5", ...SOCKET(h)], h.env);
      await runCli(["watch-pr", "--once", ...SOCKET(h)], h.env);
      expect(watchRecord(h.stateDir)).toBeDefined();
      await runCli(["unlink", "w1:p1", "--pr", "octo/widgets#5", ...SOCKET(h)], h.env);
      expect(watchRecord(h.stateDir)).toBeUndefined();
    } finally {
      await h.fake.close();
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// Unit: target collection / pruning (uses plain objects, no socket)
// ---------------------------------------------------------------------------

describe("collectWatchTargets / pruneWatchSession", () => {
  test("only live-pane pr links are targets; issue links and absent panes excluded", () => {
    const now = new Date();
    const entries = {
      "w1:p1": {
        pane_id: "w1:p1",
        links: [
          {
            kind: "pr" as const,
            repo: "o/r",
            number: 1,
            ref: "o/r#1",
            at: now.toISOString(),
            seq: 1,
          },
          {
            kind: "issue" as const,
            repo: "o/r",
            number: 2,
            ref: "o/r#2",
            at: now.toISOString(),
            seq: 1,
          },
        ],
        updated_at: now.toISOString(),
      },
      "w1:p2": {
        pane_id: "w1:p2",
        links: [
          {
            kind: "pr" as const,
            repo: "o/r",
            number: 3,
            ref: "o/r#3",
            at: now.toISOString(),
            seq: 1,
          },
        ],
        updated_at: now.toISOString(),
      },
    };
    const scan = collectWatchTargets(entries, undefined, new Set(["w1:p1"]), undefined);
    expect(scan.totalPrLinks).toBe(2);
    expect(scan.targets).toHaveLength(1);
    expect(scan.targets[0]?.ref).toBe("o/r#1");
    expect(scan.absentPaneIds).toEqual(["w1:p2"]);
    expect(scan.terminalCount).toBe(0);
  });

  test("pruneWatchSession drops baselines for unlinked/closed panes only", () => {
    const now = new Date();
    const state = {
      version: 2 as const,
      sessions: {
        "host /sock": {
          "w1:p1": {
            pane_id: "w1:p1",
            links: [
              {
                kind: "pr" as const,
                repo: "o/r",
                number: 1,
                ref: "o/r#1",
                at: now.toISOString(),
                seq: 1,
              },
            ],
            updated_at: now.toISOString(),
          },
        },
      },
      watch: {
        "host /sock": {
          "w1:p1": {
            "o/r#1": { first_seen_at: now.toISOString(), consecutive_failures: 0 },
            "o/r#9": { first_seen_at: now.toISOString(), consecutive_failures: 0 },
          },
          "w1:p9": {
            "o/r#2": { first_seen_at: now.toISOString(), consecutive_failures: 0 },
          },
        },
      },
    };
    const removed = pruneWatchSession(
      state,
      "host /sock",
      state.sessions["host /sock"] ?? {},
      {},
      [{ pane_id: "w1:p1" } as never],
      now,
    );
    expect(removed).toBe(3); // o/r#9 + o/r#2 refs, plus the emptied w1:p9 pane
    const watch = state.watch?.["host /sock"];
    expect(Object.keys(watch?.["w1:p1"] ?? {})).toEqual(["o/r#1"]);
    expect(watch?.["w1:p9"]).toBeUndefined();
  });
});
