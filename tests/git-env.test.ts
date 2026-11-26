import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ghChildEnv, sanitizedChildEnv } from "../packages/git-core/src/git-env";
import { collectCommit, collectFiles, collectStatus, resolveRepo } from "../plugins/git/src/git";
import { testEnv } from "./helpers/test-env";

// ---------------------------------------------------------------------------
// sanitizedChildEnv unit tests
// ---------------------------------------------------------------------------

const GIT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_LITERAL_PATHSPECS",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_TRACE2_EVENT",
  "GIT_EDITOR",
  "GIT_EXTERNAL_DIFF",
  "GIT_EXEC_PATH",
  "GIT_QUARANTINE_PATH",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_REFLOG_ACTION",
  "GIT_PROTOCOL_FROM_USER",
  "GIT_TEST_FSYNC",
] as const;

const KEEP_ENV_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_SSL_NO_VERIFY",
  "GIT_TERMINAL_PROMPT",
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of [
  ...GIT_ENV_KEYS,
  ...KEEP_ENV_KEYS,
  "GH_REPO",
  "GH_DEBUG",
  "GH_TOKEN",
  "GH_HOST",
]) {
  savedEnv.set(key, process.env[key]);
}

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of [
    ...GIT_ENV_KEYS,
    ...KEEP_ENV_KEYS,
    "GH_REPO",
    "GH_DEBUG",
    "GH_TOKEN",
    "GH_HOST",
  ]) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

function poisonAmbientGitEnv(): void {
  for (const key of GIT_ENV_KEYS) process.env[key] = `/tmp/poison/${key}`;
  for (const key of KEEP_ENV_KEYS) process.env[key] = `keep-${key}`;
  process.env.GH_REPO = "evil/repo";
  process.env.GH_DEBUG = "api";
  process.env.GH_TOKEN = "ghp_test";
  process.env.GH_HOST = "ghe.example.com";
}

describe("sanitizedChildEnv", () => {
  test("strips every repo/index/object/config-redirecting GIT_* var", () => {
    poisonAmbientGitEnv();
    const env = sanitizedChildEnv();
    for (const key of GIT_ENV_KEYS) {
      expect(env[key], `${key} should be stripped`).toBeUndefined();
    }
  });

  test("preserves intentional auth/identity GIT_* config", () => {
    poisonAmbientGitEnv();
    const env = sanitizedChildEnv();
    for (const key of KEEP_ENV_KEYS) {
      expect(env[key], `${key} should be preserved`).toBe(`keep-${key}`);
    }
  });

  test("overrides apply after stripping (trusted internal channel)", () => {
    poisonAmbientGitEnv();
    const env = sanitizedChildEnv({
      GIT_TERMINAL_PROMPT: "0",
      GIT_INDEX_FILE: "/tmp/scratch-index",
    });
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    // An explicit override may re-introduce a stripped name — that is the
    // documented escape hatch for trusted internal callers (e.g. a scratch
    // index), never ambient env.
    expect(env.GIT_INDEX_FILE).toBe("/tmp/scratch-index");
  });

  test("non-GIT environment passes through", () => {
    poisonAmbientGitEnv();
    const env = sanitizedChildEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });
});

describe("ghChildEnv", () => {
  test("strips GH_* targeting/debug vars, keeps auth/host config", () => {
    poisonAmbientGitEnv();
    const env = ghChildEnv({ GH_PROMPT_DISABLED: "1" });
    expect(env.GH_REPO).toBeUndefined();
    expect(env.GH_DEBUG).toBeUndefined();
    expect(env.GH_PROMPT_DISABLED).toBe("1");
    expect(env.GH_TOKEN).toBe("ghp_test");
    expect(env.GH_HOST).toBe("ghe.example.com");
    // git redirection vars are stripped for gh's internal git calls too.
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Negative fixtures against real git: ambient GIT_* must never retarget the
// repository the plugin resolved from the pane cwd.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "git-env-test-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ?? testEnv(),
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
}

function initRepo(): string {
  const dir = realpathSync(tempDir());
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

describe("git operations ignore ambient repo-redirecting GIT_*", () => {
  test("GIT_DIR/GIT_WORK_TREE pointing at repo A do not retarget repo B", async () => {
    const repoA = initRepo();
    const repoB = initRepo();
    writeFileSync(path.join(repoB, "b.txt"), "new\n"); // untracked in B

    process.env.GIT_DIR = path.join(repoA, ".git");
    process.env.GIT_WORK_TREE = repoA;
    try {
      const status = await collectStatus(repoB);
      expect(status.repo.root).toBe(repoB);
      expect(status.changes.untracked).toBe(1);
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
    }
  });

  test("divergent GIT_INDEX_FILE cannot swap the index", async () => {
    const repoA = initRepo();
    const repoB = initRepo();
    // B has a staged change; A's index is clean.
    writeFileSync(path.join(repoB, "a.txt"), "one\ntwo\n");
    git(repoB, ["add", "a.txt"]);

    process.env.GIT_INDEX_FILE = path.join(repoA, ".git", "index");
    try {
      const files = await collectFiles(repoB);
      const staged = files.files.filter((f) => f.staged);
      expect(staged.map((f) => f.path)).toContain("a.txt");
      const status = await collectStatus(repoB);
      expect(status.changes.staged).toBe(1);
    } finally {
      delete process.env.GIT_INDEX_FILE;
    }
  });

  test("linked worktree resolves itself despite ambient GIT_DIR/GIT_WORK_TREE", async () => {
    const main = initRepo();
    const worktree = path.join(tempDir(), "wt");
    git(main, ["worktree", "add", worktree, "-b", "wt-branch"]);

    process.env.GIT_DIR = path.join(main, ".git");
    process.env.GIT_WORK_TREE = main;
    process.env.GIT_COMMON_DIR = path.join(main, ".git");
    try {
      const info = await resolveRepo(worktree);
      expect(info.root).toBe(realpathSync(worktree));
      expect(info.root).not.toBe(main);
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
      delete process.env.GIT_COMMON_DIR;
    }
  });

  test("GIT_CONFIG_COUNT injection cannot override repo identity/config", async () => {
    initRepo();
    const repoB = initRepo();
    writeFileSync(path.join(repoB, "c.txt"), "x\n");
    git(repoB, ["add", "c.txt"]);

    process.env.GIT_CONFIG_COUNT = "2";
    process.env.GIT_CONFIG_KEY_0 = "user.email";
    process.env.GIT_CONFIG_VALUE_0 = "injected@example.com";
    process.env.GIT_CONFIG_KEY_1 = "core.bare";
    process.env.GIT_CONFIG_VALUE_1 = "true";
    try {
      // core.bare=true would break rev-parse/work-tree resolution if honored.
      const info = await resolveRepo(repoB);
      expect(info.bare).toBe(false);
      const commit = await collectCommit(repoB, { messages: ["test commit"] });
      expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
      const author = git(repoB, ["log", "-1", "--format=%ae"]).trim();
      expect(author).toBe("test@example.com");
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
      delete process.env.GIT_CONFIG_KEY_1;
      delete process.env.GIT_CONFIG_VALUE_1;
    }
  });

  test("GIT_CONFIG_PARAMETERS and GIT_CEILING_DISCOVERY cannot confuse discovery", async () => {
    const repo = initRepo();
    const nested = path.join(repo, "sub", "dir");
    spawnSync("mkdir", ["-p", nested]);
    process.env.GIT_CONFIG_PARAMETERS = "'core.bare=true'";
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(repo);
    try {
      const info = await resolveRepo(nested);
      expect(info.root).toBe(repo);
    } finally {
      delete process.env.GIT_CONFIG_PARAMETERS;
      delete process.env.GIT_CEILING_DIRECTORIES;
    }
  });
});
