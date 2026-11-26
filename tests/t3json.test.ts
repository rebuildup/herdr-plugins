import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveScripts, ScriptError } from "../plugins/projects/src/scripts";
import {
  loadT3ProjectFile,
  parseT3ProjectFile,
  T3_PROJECT_FILE_MAX_SCRIPTS,
  T3JsonError,
} from "../plugins/projects/src/t3json";
import { testEnv } from "./helpers/test-env";

const dirs: string[] = [];
const savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const savedConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "t3json-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (savedStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir;
  if (savedConfigDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  else process.env.HERDR_PLUGIN_CONFIG_DIR = savedConfigDir;
});

function useDirs(): { stateDir: string; configDir: string } {
  const stateDir = tempDir();
  const configDir = tempDir();
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
  process.env.HERDR_PLUGIN_CONFIG_DIR = configDir;
  return { stateDir, configDir };
}

function writeT3(root: string, content: string | object): void {
  writeFileSync(
    path.join(root, "t3.json"),
    typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function initRepo(): string {
  const dir = realpathSync(tempDir());
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

const VALID_T3 = {
  $schema: "https://t3.codes/schema/t3.json",
  iconPath: "assets/logo.svg",
  defaultThreadEnvMode: "worktree",
  worktreeSubmodules: "top-level",
  worktreeSparsePatternsPath: ".t3/sparse-checkout",
  unknownFutureKey: { nested: true },
  scripts: [
    {
      name: "Dev server",
      command: "bun run dev",
      icon: "play",
      runOnWorktreeCreate: true,
      async: false,
      previewUrl: "http://localhost:3000",
      autoOpenPreview: true,
      extraKey: "ignored",
    },
    { name: "Test", command: "bun test", runOnSettle: true, stopOnSettle: true },
  ],
};

describe("loadT3ProjectFile", () => {
  test("returns null when t3.json is absent", async () => {
    expect(await loadT3ProjectFile(tempDir())).toBeNull();
  });

  test("parses valid file, ignores unknown keys, applies upstream fields", async () => {
    const root = tempDir();
    writeT3(root, VALID_T3);
    const t3 = await loadT3ProjectFile(root);
    expect(t3?.$schema).toBe("https://t3.codes/schema/t3.json");
    expect(t3?.iconPath).toBe("assets/logo.svg");
    expect(t3?.defaultThreadEnvMode).toBe("worktree");
    expect(t3?.worktreeSubmodules).toBe("top-level");
    expect(t3?.worktreeSparsePatternsPath).toBe(".t3/sparse-checkout");
    expect(t3?.scripts).toHaveLength(2);
    const dev = t3?.scripts?.[0];
    expect(dev?.name).toBe("Dev server");
    expect(dev?.runOnWorktreeCreate).toBe(true);
    expect(dev?.async).toBe(false);
    expect(dev?.previewUrl).toBe("http://localhost:3000");
  });

  test("broken JSON is a structured invalid_json error", async () => {
    const root = tempDir();
    writeT3(root, "{not json");
    const err = await loadT3ProjectFile(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(T3JsonError);
    expect((err as T3JsonError).reason).toBe("invalid_json");
    expect((err as T3JsonError).file).toBe(path.join(root, "t3.json"));
  });

  test("schema violations are structured invalid_schema errors", async () => {
    const file = path.join(tempDir(), "t3.json");
    const cases: [string, unknown][] = [
      ["root not object", "[]"],
      ["bad env mode", { defaultThreadEnvMode: "container" }],
      ["bad submodule mode", { worktreeSubmodules: "all" }],
      ["empty script name", { scripts: [{ name: "  ", command: "x" }] }],
      ["missing command", { scripts: [{ name: "x" }] }],
      ["non-boolean flag", { scripts: [{ name: "x", command: "y", async: "yes" }] }],
      ["bad icon", { scripts: [{ name: "x", command: "y", icon: "star" }] }],
      ["scripts not array", { scripts: {} }],
      [
        "over limit",
        {
          scripts: Array.from({ length: T3_PROJECT_FILE_MAX_SCRIPTS + 1 }, (_, i) => ({
            name: `s${i}`,
            command: "x",
          })),
        },
      ],
    ];
    for (const [label, value] of cases) {
      expect(
        () => parseT3ProjectFile(typeof value === "string" ? JSON.parse(value) : value, file),
        label,
      ).toThrow(T3JsonError);
    }
    // Exactly at the limit is fine.
    const atLimit = parseT3ProjectFile(
      {
        scripts: Array.from({ length: T3_PROJECT_FILE_MAX_SCRIPTS }, (_, i) => ({
          name: `s${i}`,
          command: "x",
        })),
      },
      file,
    );
    expect(atLimit.scripts).toHaveLength(T3_PROJECT_FILE_MAX_SCRIPTS);
  });
});

describe("resolveScripts", () => {
  const t3Scripts = [
    { name: "dev", command: "bun dev" },
    { name: "test", command: "bun test", icon: "test" as const },
  ];
  const builtin = [{ name: "builtin-one", command: "echo hi" }];

  test("priority: override > env-default > t3.json > builtin", () => {
    // t3.json wins over builtin.
    let out = resolveScripts({ t3Scripts, builtin });
    expect(out.map((s) => s.name)).toEqual(["dev", "test"]);
    expect(out.every((s) => s.source === "t3.json")).toBe(true);

    // env default wins over t3.json.
    out = resolveScripts({
      envDefault: [{ name: "env-script", command: "env" }],
      t3Scripts,
      builtin,
    });
    expect(out.map((s) => s.name)).toEqual(["env-script"]);
    expect(out[0]?.source).toBe("env-default");

    // override wins over everything.
    out = resolveScripts({
      override: JSON.stringify([{ name: "mine", command: "custom", id: "custom-id" }]),
      envDefault: [{ name: "env-script", command: "env" }],
      t3Scripts,
      builtin,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("mine");
    expect(out[0]?.id).toBe("custom-id");
    expect(out[0]?.source).toBe("override");

    // builtin is the last resort.
    out = resolveScripts({ builtin });
    expect(out[0]?.source).toBe("builtin");

    // nothing defined → empty.
    expect(resolveScripts({})).toEqual([]);
  });

  test("explicit empty override/env lists are authoritative", () => {
    expect(resolveScripts({ override: "[]", t3Scripts, builtin })).toEqual([]);
    expect(resolveScripts({ envDefault: [], t3Scripts, builtin })).toEqual([]);
    // Empty t3.json scripts fall through to builtin (upstream parity).
    const out = resolveScripts({ t3Scripts: [], builtin });
    expect(out[0]?.source).toBe("builtin");
  });

  test("name references resolve against lower layers", () => {
    const out = resolveScripts({
      override: '["dev", {"name":"extra","command":"x"}]',
      envDefault: [{ name: "env-only", command: "e" }],
      t3Scripts,
      builtin,
    });
    expect(out.map((s) => `${s.name}:${s.source}`)).toEqual(["dev:t3.json", "extra:override"]);
    // env name can reach t3.json and builtin but not the override layer.
    const out2 = resolveScripts({
      envDefault: '["dev", "builtin-one"]',
      t3Scripts,
      builtin,
    });
    expect(out2.map((s) => `${s.name}:${s.source}`)).toEqual([
      "dev:t3.json",
      "builtin-one:builtin",
    ]);
  });

  test("unresolvable name and malformed layers are structured errors", () => {
    expect(() => resolveScripts({ override: '["nope"]', t3Scripts })).toThrow(ScriptError);
    try {
      resolveScripts({ override: '["nope"]', t3Scripts });
    } catch (err) {
      expect((err as ScriptError).reason).toBe("unknown_script");
    }
    expect(() => resolveScripts({ override: "not json" })).toThrow(ScriptError);
    expect(() => resolveScripts({ override: "{}" })).toThrow(ScriptError);
    expect(() => resolveScripts({ envDefault: [{ name: "x" }] })).toThrow(ScriptError);
  });

  test("resolved scripts get defaults and deduped ids", () => {
    const out = resolveScripts({
      t3Scripts: [
        { name: "Dev Server!", command: "a" },
        { name: "dev server", command: "b" },
      ],
    });
    expect(out[0]?.id).toBe("dev-server");
    expect(out[1]?.id).toBe("dev-server-2");
    expect(out[0]?.icon).toBe("play");
    expect(out[0]?.runOnWorktreeCreate).toBe(false);
  });
});

// --- CLI-level contract tests ---------------------------------------------

const CLI = path.join(__dirname, "..", "plugins", "projects", "src", "cli.ts");

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: testEnv({
      HERDR_PLUGIN_STATE_DIR: process.env.HERDR_PLUGIN_STATE_DIR,
      HERDR_PLUGIN_CONFIG_DIR: process.env.HERDR_PLUGIN_CONFIG_DIR,
    }),
    timeout: 15_000,
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

function expectOk(r: CliResult): Record<string, unknown> {
  expect(r.status).toBe(0);
  expect(r.json).not.toBeNull();
  return r.json as Record<string, unknown>;
}

function expectErr(r: CliResult, kind?: string): Record<string, unknown> {
  expect(r.status).toBe(1);
  expect(r.error).not.toBeNull();
  if (kind) expect(r.error?.kind).toBe(kind);
  return r.error as Record<string, unknown>;
}

function scriptsOf(payload: Record<string, unknown>): { name: string; source: string }[] {
  return (payload.scripts as { name: string; source: string }[]) ?? [];
}

describe("cli scripts list", () => {
  test("lists t3.json scripts for a registered project and a bare repo path", () => {
    useDirs();
    const repo = initRepo();
    writeT3(repo, {
      scripts: [
        { name: "dev", command: "bun dev", runOnWorktreeCreate: true },
        { name: "lint", command: "bun lint", icon: "lint" },
      ],
    });

    const reg = expectOk(runCli(["register", repo]));
    const id = (reg.project as { id: string }).id;

    const byId = expectOk(runCli(["scripts", "list", id]));
    expect(byId.project_id).toBe(id);
    expect(byId.repo_root).toBe(realpathSync(repo));
    expect(scriptsOf(byId).map((s) => `${s.name}:${s.source}`)).toEqual([
      "dev:t3.json",
      "lint:t3.json",
    ]);

    // Same repo by path resolves to the owning project (override applies).
    const byPath = expectOk(runCli(["scripts", "list", repo]));
    expect(byPath.project_id).toBe(id);
    expect(scriptsOf(byPath)).toHaveLength(2);
  });

  test("unregistered repo path lists t3.json scripts without a project", () => {
    useDirs();
    const repo = initRepo();
    writeT3(repo, { scripts: [{ name: "only", command: "x" }] });
    const out = expectOk(runCli(["scripts", "list", repo]));
    expect(out.project_id).toBeNull();
    expect(scriptsOf(out)[0]?.source).toBe("t3.json");
  });

  test("env defaultScripts beats t3.json; override beats env", () => {
    const { configDir } = useDirs();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ defaultScripts: [{ name: "env-one", command: "e" }] }),
    );
    const repo = initRepo();
    writeT3(repo, { scripts: [{ name: "repo-one", command: "r" }] });

    const reg = expectOk(runCli(["register", repo]));
    const id = (reg.project as { id: string }).id;

    let out = expectOk(runCli(["scripts", "list", id]));
    expect(scriptsOf(out).map((s) => `${s.name}:${s.source}`)).toEqual(["env-one:env-default"]);

    expectOk(
      runCli([
        "settings",
        "set",
        id,
        "defaultProjectScripts",
        '["repo-one", {"name":"custom","command":"c"}]',
      ]),
    );
    out = expectOk(runCli(["scripts", "list", id]));
    expect(scriptsOf(out).map((s) => `${s.name}:${s.source}`)).toEqual([
      "repo-one:t3.json",
      "custom:override",
    ]);
  });

  test("repo without any layer returns an empty script list", () => {
    useDirs();
    const repo = initRepo();
    const out = expectOk(runCli(["scripts", "list", repo]));
    expect(out.scripts).toEqual([]);
  });

  test("broken t3.json fails with t3json_invalid; bad override fails structured", () => {
    useDirs();
    const repo = initRepo();
    writeT3(repo, "{broken");
    const reg = expectOk(runCli(["register", repo]));
    const id = (reg.project as { id: string }).id;
    const err = expectErr(runCli(["scripts", "list", id]), "t3json_invalid");
    expect(err.layer).toBeUndefined();

    const clean = initRepo();
    writeT3(clean, { scripts: [{ name: "ok", command: "x" }] });
    const id2 = (expectOk(runCli(["register", clean, "--id", "clean"])).project as { id: string })
      .id;
    expectOk(runCli(["settings", "set", id2, "defaultProjectScripts", "not-json"]));
    const err2 = expectErr(runCli(["scripts", "list", id2]), "invalid_script_list");
    expect(err2.layer).toBe("override.defaultProjectScripts");
  });

  test("--repo selects member t3.json in multi-repo projects; errors are structured", () => {
    useDirs();
    const repoA = initRepo();
    const repoB = initRepo();
    writeT3(repoA, { scripts: [{ name: "a-script", command: "a" }] });
    writeT3(repoB, { scripts: [{ name: "b-script", command: "b" }] });

    const reg = expectOk(runCli(["register", repoA, "--id", "multi"]));
    const id = (reg.project as { id: string }).id;
    expectOk(runCli(["update", id, "--repo-add", repoB]));

    // Default is the first registered repo.
    expect(scriptsOf(expectOk(runCli(["scripts", "list", id])))[0]?.name).toBe("a-script");
    const picked = expectOk(runCli(["scripts", "list", id, "--repo", repoB]));
    expect(scriptsOf(picked)[0]?.name).toBe("b-script");

    expectErr(
      runCli(["scripts", "list", id, "--repo", repoA.replace(/[^/]+$/, "zzz")]),
      "repo_not_found",
    );
    expect(runCli(["scripts", "list", repoA, "--repo", repoB]).status).toBe(2);
    expect(runCli(["scripts", "list"]).status).toBe(2);
    expect(runCli(["scripts", "bogus"]).status).toBe(2);
    // Unknown target that is neither a project id nor a git work tree.
    const missing = path.join(tempDir(), "does-not-exist");
    expect(runCli(["scripts", "list", missing]).status).toBe(1);
  });
});
