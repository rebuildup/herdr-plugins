import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { herdrSocketEndpoint, joinPathEnv, testEnv } from "./helpers/test-env";

// ---------------------------------------------------------------------------
// CLI contract tests for `git issue` (Issue #174): fake herdr session on an
// isolated socket, fake `gh` on PATH, and the REAL sibling inbox plugin for
// link/unlink/links delegation (ADR-0013 pattern — plugins/inbox resolves
// as ../inbox from plugins/git).
// ---------------------------------------------------------------------------

const GIT_CLI = path.join(import.meta.dir, "..", "plugins", "git", "src", "cli.ts");
const IS_WINDOWS = process.platform === "win32";

const GH_STUB = `#!/usr/bin/env bash
set -u
case "\${1:-}" in
  --version) echo "gh version 2.105.0"; exit 0;;
  auth) echo "github.com"; exit 0;;
  repo) echo "\${GH_STUB_REPO:-octo/widgets}"; exit 0;;
  issue)
    case "\${2:-}" in
      list) cat "\${GH_STUB_ISSUE_LIST:?}";;
      view) cat "\${GH_STUB_ISSUE_VIEW:?}";;
      create) echo "https://github.com/octo/widgets/issues/9";;
      edit|close|reopen) echo "ok";;
      *) exit 1;;
    esac
    exit 0;;
  api)
    case "$*" in
      *--method*POST*|*--input*) cat "\${GH_STUB_COMMENT_POST:?}";;
      *) exit 1;;
    esac
    exit 0;;
esac
exit 1
`;

interface FakeHerdr {
  socketPath: string;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function startFakeHerdr(
  socketPath: string,
  snapshot: Record<string, unknown>,
): Promise<FakeHerdr> {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  const requests: FakeHerdr["requests"] = [];
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        const message = JSON.parse(line) as {
          id: string;
          method: string;
          params: Record<string, unknown>;
        };
        requests.push({ method: message.method, params: message.params });
        const result =
          message.method === "session.snapshot"
            ? { type: "session_snapshot", snapshot }
            : { type: "ok" };
        conn.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(herdrSocketEndpoint(socketPath), () => resolve());
  });
  return {
    socketPath,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: { code?: string; kind?: string; message?: string } | null;
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliRun> {
  const childEnv = testEnv(env);
  const result = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const child = spawn(process.execPath, ["run", GIT_CLI, ...args], { env: childEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
  let json: Record<string, unknown> | null = null;
  let error: CliRun["error"] = null;
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    /* non-JSON stdout */
  }
  try {
    error = (JSON.parse(result.stderr) as { error?: CliRun["error"] }).error ?? null;
  } catch {
    /* non-JSON stderr */
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, json, error };
}

describe.skipIf(IS_WINDOWS)("git issue CLI (fake herdr + fake gh)", () => {
  // bun:test evaluates this callback even when skipIf skips the suite, so
  // all filesystem setup is deferred into beforeAll — mkdtempSync("/tmp/…")
  // would throw ENOENT on Windows at collection time (issue #225).
  let workdir = "";
  let xdgConfig = "";
  let xdgState = "";
  let binDir = "";
  let repoDir = "";
  let ghDir = "";
  let sockPath = "";
  let inboxStateFile = "";
  let issueListFile = "";
  let issueViewFile = "";
  let commentPostFile = "";

  const servers: FakeHerdr[] = [];
  const baseEnv = () => ({
    XDG_CONFIG_HOME: xdgConfig,
    XDG_STATE_HOME: xdgState,
    HOME: workdir,
    PATH: joinPathEnv(binDir),
    GH_STUB_ISSUE_LIST: issueListFile,
    GH_STUB_ISSUE_VIEW: issueViewFile,
    GH_STUB_COMMENT_POST: commentPostFile,
  });
  const sessionArg = ["--session", "aaa"];

  beforeAll(async () => {
    workdir = mkdtempSync(path.join("/tmp", "git-issue-"));
    xdgConfig = path.join(workdir, "xdg-config");
    xdgState = path.join(workdir, "xdg-state");
    binDir = path.join(workdir, "bin");
    repoDir = path.join(workdir, "repo");
    ghDir = path.join(workdir, "gh");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(ghDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    sockPath = path.join(xdgConfig, "herdr", "sessions", "aaa", "herdr.sock");
    inboxStateFile = path.join(xdgState, "herdr", "plugins", "rebuildup.inbox", "state.json");

    issueListFile = path.join(ghDir, "issue-list.json");
    issueViewFile = path.join(ghDir, "issue-view.json");
    commentPostFile = path.join(ghDir, "comment-post.json");
    writeFileSync(
      issueListFile,
      JSON.stringify([{ number: 5, title: "bug", state: "OPEN", url: "u" }]),
    );
    writeFileSync(
      issueViewFile,
      JSON.stringify({
        number: 5,
        title: "bug: widget crashes",
        state: "OPEN",
        stateReason: "",
        closed: false,
        author: { login: "alice" },
        labels: [{ name: "bug" }],
        assignees: [],
        milestone: null,
        body: "repro steps",
        comments: [
          {
            id: 1,
            author: { login: "bob" },
            body: "same here",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            url: "https://example.com/c/1",
          },
        ],
        reactionGroups: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        url: "https://github.com/octo/widgets/issues/5",
      }),
    );
    writeFileSync(
      commentPostFile,
      JSON.stringify({
        id: 77,
        user: { login: "alice" },
        body: "hello",
        created_at: "2026-01-03T00:00:00Z",
        updated_at: "2026-01-03T00:00:00Z",
        html_url: "https://example.com/c/77",
      }),
    );

    // Real git repo as the pane cwd so resolveRepo/ensureGh/resolveForgeRepo run.
    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.email", "t@t"]);
    git(repoDir, ["config", "user.name", "t"]);
    writeFileSync(path.join(repoDir, "a.txt"), "one\n");
    git(repoDir, ["add", "a.txt"]);
    git(repoDir, ["commit", "-qm", "init"]);

    writeFileSync(path.join(binDir, "gh"), GH_STUB);
    chmodSync(path.join(binDir, "gh"), 0o755);

    servers.push(
      await startFakeHerdr(sockPath, {
        session: { name: "aaa" },
        workspaces: [{ workspace_id: "w1", title: "aaa" }],
        tabs: [{ tab_id: "t1", workspace_id: "w1" }],
        panes: [
          {
            pane_id: "w1:p1",
            workspace_id: "w1",
            tab_id: "t1",
            cwd: repoDir,
            title: "work",
          },
        ],
        agents: [
          {
            pane_id: "w1:p1",
            agent: "claude",
            agent_status: "idle",
            state_change_seq: 1,
            cwd: repoDir,
          },
        ],
      }),
    );
  });

  afterAll(async () => {
    for (const server of servers) await server.close();
    rmSync(workdir, { recursive: true, force: true });
  });

  test("issue list returns bounded issues via gh", async () => {
    const run = await runCli(["issue", "list", "w1:p1", "--repo", "octo/widgets", ...sessionArg], {
      ...baseEnv(),
    });
    expect(run.status).toBe(0);
    expect(run.json).toMatchObject({
      contract: "herdr-plugins.git/v1",
      command: "issue",
      action: "list",
      repo: "octo/widgets",
    });
    expect((run.json?.issues as unknown[]).length).toBe(1);
  }, 60_000);

  test("issue view returns the bounded projection", async () => {
    const run = await runCli(
      ["issue", "view", "w1:p1", "5", "--repo", "octo/widgets", ...sessionArg],
      {
        ...baseEnv(),
      },
    );
    expect(run.status).toBe(0);
    const issue = run.json?.issue as Record<string, unknown>;
    expect(issue).toMatchObject({
      number: 5,
      title: "bug: widget crashes",
      state: "OPEN",
      author: "alice",
      labels: ["bug"],
    });
    expect(issue.comments_truncated).toBe(false);
  }, 60_000);

  test("issue create is a mutation: fails closed without a target", async () => {
    const run = await runCli(
      ["issue", "create", "w1:p1", "--title", "t", "--repo", "octo/widgets"],
      {
        ...baseEnv(),
      },
    );
    expect(run.status).toBe(1);
    expect(run.error?.code).toBe("target_required");
  }, 60_000);

  test("issue create succeeds with an explicit session target", async () => {
    const run = await runCli(
      ["issue", "create", "w1:p1", "--title", "new bug", "--repo", "octo/widgets", ...sessionArg],
      { ...baseEnv() },
    );
    expect(run.status).toBe(0);
    expect(run.json).toMatchObject({
      action: "create",
      repo: "octo/widgets",
      ok: true,
      url: "https://github.com/octo/widgets/issues/9",
      number: 9,
    });
  }, 60_000);

  test("issue comment posts via gh api and echoes the comment", async () => {
    const run = await runCli(
      [
        "issue",
        "comment",
        "w1:p1",
        "5",
        "--body",
        "hello",
        "--repo",
        "octo/widgets",
        ...sessionArg,
      ],
      { ...baseEnv() },
    );
    expect(run.status).toBe(0);
    expect(run.json).toMatchObject({
      action: "comment",
      ok: true,
      number: 5,
      comment: { id: 77, author: "alice" },
    });
  }, 60_000);

  test("issue edit --state closed closes then echoes post-state view", async () => {
    const run = await runCli(
      ["issue", "edit", "w1:p1", "5", "--state", "closed", "--repo", "octo/widgets", ...sessionArg],
      { ...baseEnv() },
    );
    expect(run.status).toBe(0);
    expect(run.json).toMatchObject({ action: "edit", ok: true, number: 5 });
    expect((run.json?.issue as Record<string, unknown>).number).toBe(5);
  }, 60_000);

  test("issue close delegates to gh issue close", async () => {
    const run = await runCli(
      [
        "issue",
        "close",
        "w1:p1",
        "5",
        "--reason",
        "completed",
        "--repo",
        "octo/widgets",
        ...sessionArg,
      ],
      { ...baseEnv() },
    );
    expect(run.status).toBe(0);
    expect(run.json).toMatchObject({ action: "close", ok: true, number: 5 });
  }, 60_000);

  test("issue link delegates to rebuildup.inbox and records state there", async () => {
    const run = await runCli(["issue", "link", "w1:p1", "octo/widgets#5", ...sessionArg], {
      ...baseEnv(),
    });
    expect(run.status).toBe(0);
    expect(run.json).toMatchObject({
      contract: "herdr-plugins.git/v1",
      command: "issue",
      action: "link",
      pane_id: "w1:p1",
      delegated: "rebuildup.inbox",
      ok: true,
      link: { kind: "issue", repo: "octo/widgets", number: 5, ref: "octo/widgets#5" },
    });
    // The link lives in the INBOX plugin's state file — git keeps none.
    expect(existsSync(inboxStateFile)).toBe(true);
    const state = JSON.parse(readFileSync(inboxStateFile, "utf8")) as {
      sessions: Record<string, Record<string, { links?: unknown[] }>>;
    };
    const paneEntry = Object.values(state.sessions)
      .flatMap((s) => Object.values(s))
      .find((e) => (e.links ?? []).length > 0);
    expect(paneEntry?.links).toEqual([
      expect.objectContaining({ kind: "issue", repo: "octo/widgets", number: 5 }),
    ]);
  }, 60_000);

  test("issue links reads back the delegated links", async () => {
    const run = await runCli(["issue", "links", "w1:p1", ...sessionArg], { ...baseEnv() });
    expect(run.status).toBe(0);
    expect(run.json).toMatchObject({ action: "links", delegated: "rebuildup.inbox" });
    const links = run.json?.links as Array<{ kind: string; ref: string }>;
    expect(links.some((l) => l.kind === "issue" && l.ref === "octo/widgets#5")).toBe(true);
  }, 60_000);

  test("issue unlink removes the delegated link", async () => {
    const run = await runCli(["issue", "unlink", "w1:p1", "octo/widgets#5", ...sessionArg], {
      ...baseEnv(),
    });
    expect(run.status).toBe(0);
    expect(run.json).toMatchObject({
      action: "unlink",
      removed: { kind: "issue", repo: "octo/widgets", number: 5 },
    });
  }, 60_000);

  test("issue link is a mutation: fails closed without a target", async () => {
    const run = await runCli(["issue", "link", "w1:p1", "octo/widgets#5"], { ...baseEnv() });
    expect(run.status).toBe(1);
    // Delegated inbox error: code "error" + kind carries the target code.
    expect(run.error?.kind).toBe("target_required");
  }, 60_000);

  test("issue links on a pane with no inbox state is an honest error", async () => {
    const run = await runCli(["issue", "links", "w9:p9", ...sessionArg], { ...baseEnv() });
    // w9:p9 is not in the snapshot — inbox fails pane lookup before state read.
    expect(run.status).toBe(1);
    expect(run.error).not.toBeNull();
  }, 60_000);
});
