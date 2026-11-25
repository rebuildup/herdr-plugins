import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.join(__dirname, "..", "plugins", "textgen", "src", "cli.ts");

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
for (const key of [
  "HERDR_PLUGIN_CONFIG_DIR",
  "HERDR_PLUGIN_STATE_DIR",
  "HERDR_SOCKET_PATH",
  "HERDR_SESSION",
  "TEXTGEN_E2E_KEY",
]) {
  savedEnv[key] = process.env[key];
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "textgen-git-"));
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

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

function baseEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("HERDR_PLUGIN_") || key === "HERDR_SOCKET_PATH" || key === "HERDR_SESSION") {
      continue;
    }
    env[key] = value;
  }
  if (extra) Object.assign(env, extra);
  return env;
}

function parseOut(stdout: string, stderr: string, status: number): CliResult {
  let json: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    /* non-JSON stdout */
  }
  try {
    error = (JSON.parse(stderr) as { error?: Record<string, unknown> }).error ?? null;
  } catch {
    /* empty stderr */
  }
  return { status, stdout, stderr, json, error };
}

function runCli(
  args: string[],
  extraEnv: Record<string, string>,
  stdin?: string,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: baseEnv(extraEnv) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(parseOut(stdout, stderr, code ?? -1)));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

// --- fake git plugin ---------------------------------------------------------

/**
 * A minimal rebuildup.git stand-in: herdr-plugin.toml declares the plugin
 * id and src/cli.ts answers git-v1 read commands from a fixture file
 * (FAKE_GIT_FIXTURE). Every invocation is appended to FAKE_GIT_LOG so
 * tests can assert exactly which contract commands ran — and that no
 * mutation command ever does.
 */
const FAKE_GIT_CLI = `
const fs = require("node:fs");
const path = require("node:path");
const fixture = JSON.parse(fs.readFileSync(process.env.FAKE_GIT_FIXTURE, "utf8"));
const logFile = process.env.FAKE_GIT_LOG;
if (logFile) fs.appendFileSync(logFile, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
const args = process.argv.slice(2);
let key = args[0] || "";
if (args[0] === "diff") {
  if (args.includes("--staged")) key = "diff --staged";
  else if (args.includes("--stat")) key = "diff --stat";
  else key = "diff";
} else if (args[0] === "pr") {
  key = "pr " + (args[1] || "");
}
const response = fixture.responses[key];
if (response === undefined) {
  process.stderr.write(JSON.stringify({ contract: "herdr-plugins.git/v1", ok: false, error: { code: "error", kind: "git_error", message: "no fixture for " + key } }) + "\\n");
  process.exit(1);
}
if (response.__exit !== undefined) {
  process.stderr.write(JSON.stringify({ contract: "herdr-plugins.git/v1", ok: false, error: response.error || { code: "error", message: "fixture failure" } }) + "\\n");
  process.exit(response.__exit);
}
const { __exit, error, ...payload } = response;
process.stdout.write(JSON.stringify({ contract: "herdr-plugins.git/v1", ...payload }) + "\\n");
`;

interface FakeGit {
  root: string;
  repoRoot: string;
  calls: () => { argv: string[] }[];
}

function fakeGitPlugin(
  responses: Record<string, Record<string, unknown>>,
  opts?: { repoFiles?: Record<string, string> },
): FakeGit {
  const base = tempDir();
  const root = path.join(base, "git-plugin");
  const repoRoot = path.join(base, "repo");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(
    path.join(root, "herdr-plugin.toml"),
    'id = "rebuildup.git"\nname = "Git"\nversion = "0.0.0-fake"\n',
  );
  writeFileSync(path.join(root, "src", "cli.ts"), FAKE_GIT_CLI);
  const fixturePath = path.join(base, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify({ responses }));
  const logPath = path.join(base, "calls.jsonl");
  writeFileSync(logPath, "");
  // Repo content files (convention probes read these directly).
  for (const [rel, content] of Object.entries(opts?.repoFiles ?? {})) {
    const file = path.join(repoRoot, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return {
    root,
    repoRoot,
    calls: () =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { argv: string[] }),
  };
}

function statusResponse(repoRoot: string, branch = "feature/x"): Record<string, unknown> {
  return {
    command: "status",
    pane_id: "w1:p1",
    repo: { root: repoRoot, bare: false },
    branch: { name: branch, detached: false, upstream: "origin/main", ahead: 2, behind: 0 },
    changes: { staged: 2, unstaged: 1, untracked: 3, conflicted: 0 },
  };
}

// --- fake API generator ---------------------------------------------------------

async function fakeApi(
  handler: (req: http.IncomingMessage, body: string) => { status: number; json: unknown },
): Promise<{
  port: number;
  seen: { auth: string | null; body: string }[];
  close: () => Promise<void>;
}> {
  const seen: { auth: string | null; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization ?? null, body });
      const out = handler(req, body);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    seen,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

function writeTextgenConfig(
  root: string,
  api: { port: number; response: unknown },
): { configDir: string; stateDir: string } {
  const configDir = path.join(root, "config");
  const stateDir = path.join(root, "state");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "config.json"),
    `${JSON.stringify(
      {
        apiGenerators: [
          {
            id: "local",
            kind: "openai-compatible",
            endpoint: `http://127.0.0.1:${api.port}/v1`,
            model: "test-model",
            keyEnv: "TEXTGEN_E2E_KEY",
            enabled: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { configDir, stateDir };
}

function gitEnv(
  git: FakeGit,
  dirs: { configDir: string; stateDir: string },
  extra?: Record<string, string>,
): Record<string, string> {
  // FAKE_GIT_* point at the per-test fixture/log written by fakeGitPlugin.
  const base = path.dirname(git.root);
  return {
    HERDR_PLUGIN_CONFIG_DIR: dirs.configDir,
    HERDR_PLUGIN_STATE_DIR: dirs.stateDir,
    HERDR_SOCKET_PATH: path.join(base, "dead.sock"),
    FAKE_GIT_FIXTURE: path.join(base, "fixture.json"),
    FAKE_GIT_LOG: path.join(base, "calls.jsonl"),
    TEXTGEN_E2E_KEY: "e2e-secret-key",
    ...extra,
  };
}

const STAGED_PATCH = "diff --git a/src/a.ts b/src/a.ts\n+export function feat() { return 42; }\n";
const UNSTAGED_PATCH = "diff --git a/src/b.ts b/src/b.ts\n- old\n+ new\n";
const COMPARE_PATCH = "diff --git a/src/c.ts b/src/c.ts\n+compare change\n";

// --- tests ---------------------------------------------------------------------

describe("textgen git context adapter", () => {
  test("git-context collects staged diff + conventions for commit_message", async () => {
    const git = fakeGitPlugin(
      {
        status: statusResponse("REPO_ROOT"),
        "diff --staged": {
          command: "diff",
          staged: true,
          format: "patch",
          output: STAGED_PATCH,
          truncated: false,
          bytes: STAGED_PATCH.length,
        },
        "diff --stat": {
          command: "diff",
          staged: false,
          format: "stat",
          stat_output: " src/a.ts | 2 +-\n",
          truncated: false,
          bytes: 20,
        },
      },
      {
        repoFiles: {
          "AGENTS.md": "# Conventions\nUse Conventional Commits: feat/fix/docs scopes.\n",
        },
      },
    );
    // status fixture needs the real repo root — rewrite fixture.
    const fixturePath = path.join(path.dirname(git.root), "fixture.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      responses: Record<string, Record<string, unknown>>;
    };
    fixture.responses.status = statusResponse(git.repoRoot);
    writeFileSync(fixturePath, JSON.stringify(fixture));

    const root = tempDir();
    const dirsCfg = { configDir: path.join(root, "config"), stateDir: path.join(root, "state") };
    mkdirSync(dirsCfg.configDir, { recursive: true });

    const res = await runCli(
      ["git-context", "--task", "commit_message", "--git-pane", "w1:p1", "--git-root", git.root],
      gitEnv(git, dirsCfg),
    );
    expect(res.status).toBe(0);
    expect(res.json?.command).toBe("git-context");
    const input = res.json?.input as Record<string, string>;
    expect(input.diff).toContain("src/a.ts");
    expect(input.conventions).toContain("Conventional Commits");
    expect(res.json?.sources as string[]).toContain("git-v1:diff --staged");
    expect(res.json?.repo_root).toBe(git.repoRoot);
    // Only read commands ran.
    const commands = git.calls().map((c) => c.argv[0]);
    expect(commands).toEqual(["status", "diff"]);
    expect(git.calls()[1]?.argv).toContain("--staged");
  });

  test("generate commit_message via --git-pane feeds collected context to the provider", async () => {
    const api = await fakeApi(() => ({
      status: 200,
      json: {
        choices: [{ message: { content: "feat(core): add feat() helper\n---\nfix(core): typo" } }],
      },
    }));
    try {
      const git = fakeGitPlugin(
        {
          status: statusResponse("REPO_ROOT"),
          "diff --staged": {
            command: "diff",
            staged: true,
            format: "patch",
            output: STAGED_PATCH,
            truncated: false,
            bytes: STAGED_PATCH.length,
          },
        },
        { repoFiles: { "AGENTS.md": "Conventional Commits required.\n" } },
      );
      const fixturePath = path.join(path.dirname(git.root), "fixture.json");
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        responses: Record<string, Record<string, unknown>>;
      };
      fixture.responses.status = statusResponse(git.repoRoot);
      writeFileSync(fixturePath, JSON.stringify(fixture));

      const root = tempDir();
      const cfg = writeTextgenConfig(root, { port: api.port, response: {} });
      const res = await runCli(
        [
          "generate",
          "--task",
          "commit_message",
          "--provider",
          "api:local",
          "--git-pane",
          "w1:p1",
          "--git-root",
          git.root,
        ],
        gitEnv(git, cfg),
        "",
      );
      expect(res.status).toBe(0);
      expect(res.json?.ok).toBe(true);
      expect(res.json?.result).toEqual(["feat(core): add feat() helper", "fix(core): typo"]);
      const gitContext = res.json?.git_context as Record<string, unknown>;
      expect(gitContext.pane_id).toBe("w1:p1");
      expect(gitContext.repo_root).toBe(git.repoRoot);
      // Provider saw the staged diff and the conventions file.
      const sent = api.seen[0]?.body ?? "";
      expect(sent).toContain("src/a.ts");
      expect(sent).toContain("Conventional Commits required");
      expect(sent).not.toContain("src/b.ts");
      // Credential still only travels as a header.
      expect(api.seen[0]?.auth).toBe("Bearer e2e-secret-key");
      expect(res.stdout).not.toContain("e2e-secret-key");
    } finally {
      await api.close();
    }
  });

  test("empty staged diff falls back to unstaged with an explicit scope note", async () => {
    const git = fakeGitPlugin({
      status: statusResponse("REPO_ROOT"),
      "diff --staged": {
        command: "diff",
        staged: true,
        format: "patch",
        output: "",
        truncated: false,
        bytes: 0,
      },
      diff: {
        command: "diff",
        staged: false,
        format: "patch",
        output: UNSTAGED_PATCH,
        truncated: false,
        bytes: UNSTAGED_PATCH.length,
      },
    });
    const fixturePath = path.join(path.dirname(git.root), "fixture.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      responses: Record<string, Record<string, unknown>>;
    };
    fixture.responses.status = statusResponse(git.repoRoot);
    writeFileSync(fixturePath, JSON.stringify(fixture));

    const root = tempDir();
    const dirsCfg = { configDir: path.join(root, "config"), stateDir: path.join(root, "state") };
    mkdirSync(dirsCfg.configDir, { recursive: true });
    const res = await runCli(
      ["git-context", "--task", "commit_message", "--git-pane", "w1:p1", "--git-root", git.root],
      gitEnv(git, dirsCfg),
    );
    expect(res.status).toBe(0);
    const input = res.json?.input as Record<string, string>;
    expect(input.diff).toContain("nothing staged");
    expect(input.diff).toContain("src/b.ts");
    expect(res.json?.sources as string[]).toContain("git-v1:diff (unstaged fallback)");
  });

  test("explicit input overrides collected fields", async () => {
    const api = await fakeApi(() => ({
      status: 200,
      json: { choices: [{ message: { content: "chore: manual" } }] },
    }));
    try {
      const git = fakeGitPlugin({
        status: statusResponse("REPO_ROOT"),
        "diff --staged": {
          command: "diff",
          staged: true,
          format: "patch",
          output: STAGED_PATCH,
          truncated: false,
          bytes: STAGED_PATCH.length,
        },
      });
      const fixturePath = path.join(path.dirname(git.root), "fixture.json");
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        responses: Record<string, Record<string, unknown>>;
      };
      fixture.responses.status = statusResponse(git.repoRoot);
      writeFileSync(fixturePath, JSON.stringify(fixture));

      const root = tempDir();
      const cfg = writeTextgenConfig(root, { port: api.port, response: {} });
      const res = await runCli(
        [
          "generate",
          "--task",
          "commit_message",
          "--provider",
          "api:local",
          "--git-pane",
          "w1:p1",
          "--git-root",
          git.root,
        ],
        gitEnv(git, cfg),
        JSON.stringify({ diff: "CUSTOM-DIFF-MARKER" }),
      );
      expect(res.status).toBe(0);
      const sent = api.seen[0]?.body ?? "";
      expect(sent).toContain("CUSTOM-DIFF-MARKER");
      expect(sent).not.toContain("src/a.ts");
    } finally {
      await api.close();
    }
  });

  test("pr_content gathers compare diff, commits, issue refs, and forge PR context", async () => {
    const api = await fakeApi(() => ({
      status: 200,
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Add feat() helper",
                body: "## Summary\nAdds the helper. Closes #123.",
              }),
            },
          },
        ],
      },
    }));
    try {
      const git = fakeGitPlugin({
        status: statusResponse("REPO_ROOT"),
        compare: {
          command: "compare",
          base: "origin/main",
          head: "HEAD",
          merge_base: "abc",
          ahead: 2,
          behind: 0,
          files: [],
          stat: " src/c.ts | 1 +",
          patch: COMPARE_PATCH,
          patch_truncated: false,
          patch_bytes: COMPARE_PATCH.length,
        },
        log: {
          command: "log",
          commits: [
            { sha: "abcdef1234567890", subject: "feat(core): add helper (#123)" },
            { sha: "1111222233334444", subject: "chore: bump deps" },
          ],
          has_more: false,
        },
        "pr status": {
          command: "pr",
          action: "status",
          repo: "o/r",
          branch: "feature/x",
          pr: {
            number: 55,
            title: "WIP helper",
            state: "OPEN",
            isDraft: true,
            url: "https://github.com/o/r/pull/55",
            body: "draft body",
            headRefName: "feature/x",
            baseRefName: "main",
          },
        },
      });
      const fixturePath = path.join(path.dirname(git.root), "fixture.json");
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        responses: Record<string, Record<string, unknown>>;
      };
      fixture.responses.status = statusResponse(git.repoRoot);
      writeFileSync(fixturePath, JSON.stringify(fixture));

      const root = tempDir();
      const cfg = writeTextgenConfig(root, { port: api.port, response: {} });
      const res = await runCli(
        [
          "generate",
          "--task",
          "pr_content",
          "--provider",
          "api:local",
          "--git-pane",
          "w1:p1",
          "--git-root",
          git.root,
        ],
        gitEnv(git, cfg),
        "",
      );
      expect(res.status).toBe(0);
      const result = res.json?.result as { title: string; body: string };
      expect(result.title).toBe("Add feat() helper");
      const sent = api.seen[0]?.body ?? "";
      expect(sent).toContain("compare change");
      expect(sent).toContain("abcdef1234 feat(core): add helper (#123)");
      expect(sent).toContain("#123");
      expect(sent).toContain("number");
      expect(sent).toContain("draft body");
      expect(sent).toContain("WIP helper");
      const commands = git.calls().map((c) => c.argv.slice(0, 2).join(" "));
      expect(commands).toEqual(["status w1:p1", "compare w1:p1", "log w1:p1", "pr status"]);
    } finally {
      await api.close();
    }
  });

  test("pr_content survives missing forge (gh) with a warning, not a failure", async () => {
    const api = await fakeApi(() => ({
      status: 200,
      json: {
        choices: [{ message: { content: JSON.stringify({ title: "t", body: "b" }) } }],
      },
    }));
    try {
      const git = fakeGitPlugin({
        status: statusResponse("REPO_ROOT"),
        compare: {
          command: "compare",
          patch: COMPARE_PATCH,
          patch_truncated: false,
        },
        log: { command: "log", commits: [], has_more: false },
        "pr status": {
          __exit: 1,
          error: {
            code: "error",
            kind: "gh_missing",
            message: "gh executable not found on PATH",
          },
        },
      });
      const fixturePath = path.join(path.dirname(git.root), "fixture.json");
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        responses: Record<string, Record<string, unknown>>;
      };
      fixture.responses.status = statusResponse(git.repoRoot);
      writeFileSync(fixturePath, JSON.stringify(fixture));

      const root = tempDir();
      const cfg = writeTextgenConfig(root, { port: api.port, response: {} });
      const res = await runCli(
        [
          "generate",
          "--task",
          "pr_content",
          "--provider",
          "api:local",
          "--git-pane",
          "w1:p1",
          "--git-root",
          git.root,
        ],
        gitEnv(git, cfg),
        "",
      );
      expect(res.status).toBe(0);
      expect(res.json?.ok).toBe(true);
      expect(JSON.stringify(res.json?.warnings)).toContain("forge context unavailable");
    } finally {
      await api.close();
    }
  });

  test("branch_name uses status + diff --stat", async () => {
    const api = await fakeApi(() => ({
      status: 200,
      json: { choices: [{ message: { content: "feature/add-feat-helper" } }] },
    }));
    try {
      const git = fakeGitPlugin({
        status: statusResponse("REPO_ROOT"),
        "diff --stat": {
          command: "diff",
          staged: false,
          format: "stat",
          stat_output: " src/a.ts | 2 +-\n src/b.ts | 4 +++-\n",
          truncated: false,
          bytes: 40,
        },
      });
      const fixturePath = path.join(path.dirname(git.root), "fixture.json");
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        responses: Record<string, Record<string, unknown>>;
      };
      fixture.responses.status = statusResponse(git.repoRoot);
      writeFileSync(fixturePath, JSON.stringify(fixture));

      const root = tempDir();
      const cfg = writeTextgenConfig(root, { port: api.port, response: {} });
      const res = await runCli(
        [
          "generate",
          "--task",
          "branch_name",
          "--provider",
          "api:local",
          "--git-pane",
          "w1:p1",
          "--git-root",
          git.root,
        ],
        gitEnv(git, cfg),
        "",
      );
      expect(res.status).toBe(0);
      expect(res.json?.result).toBe("feature/add-feat-helper");
      const sent = api.seen[0]?.body ?? "";
      expect(sent).toContain("6 changed files");
      expect(sent).toContain("src/a.ts | 2");
      const commands = git.calls().map((c) => c.argv.slice(0, 2).join(" "));
      expect(commands).toEqual(["status w1:p1", "diff w1:p1"]);
      expect(git.calls()[1]?.argv).toContain("--stat");
    } finally {
      await api.close();
    }
  });

  test("--git-pane on a non-git task is a usage error", async () => {
    const root = tempDir();
    const cfg = { configDir: path.join(root, "config"), stateDir: path.join(root, "state") };
    mkdirSync(cfg.configDir, { recursive: true });
    const res = await runCli(
      ["generate", "--task", "thread_title", "--git-pane", "w1:p1"],
      {
        HERDR_PLUGIN_CONFIG_DIR: cfg.configDir,
        HERDR_PLUGIN_STATE_DIR: cfg.stateDir,
        HERDR_SOCKET_PATH: path.join(root, "dead.sock"),
      },
      JSON.stringify({ context: "ctx" }),
    );
    expect(res.status).toBe(2);
  });

  test("missing git plugin root is a structured error, not a crash", async () => {
    const root = tempDir();
    const cfg = { configDir: path.join(root, "config"), stateDir: path.join(root, "state") };
    mkdirSync(cfg.configDir, { recursive: true });
    const notGit = path.join(root, "not-git");
    mkdirSync(path.join(notGit, "src"), { recursive: true });
    writeFileSync(path.join(notGit, "herdr-plugin.toml"), 'id = "other.plugin"\n');
    writeFileSync(path.join(notGit, "src", "cli.ts"), "");
    const res = await runCli(
      [
        "generate",
        "--task",
        "commit_message",
        "--provider",
        "agent:claude",
        "--git-pane",
        "w1:p1",
        "--git-root",
        notGit,
      ],
      {
        HERDR_PLUGIN_CONFIG_DIR: cfg.configDir,
        HERDR_PLUGIN_STATE_DIR: cfg.stateDir,
        HERDR_SOCKET_PATH: path.join(root, "dead.sock"),
      },
      "",
    );
    expect(res.status).toBe(1);
    expect(JSON.stringify(res.error)).toContain("git_unavailable");
  });

  test("git-context rejects non-git tasks and missing pane", async () => {
    const root = tempDir();
    const cfg = { configDir: path.join(root, "config"), stateDir: path.join(root, "state") };
    mkdirSync(cfg.configDir, { recursive: true });
    const env = {
      HERDR_PLUGIN_CONFIG_DIR: cfg.configDir,
      HERDR_PLUGIN_STATE_DIR: cfg.stateDir,
      HERDR_SOCKET_PATH: path.join(root, "dead.sock"),
    };
    const badTask = await runCli(["git-context", "--task", "thread_title"], env);
    expect(badTask.status).toBe(2);
    const noPane = await runCli(["git-context", "--task", "commit_message"], env);
    expect(noPane.status).toBe(2);
  });
});
