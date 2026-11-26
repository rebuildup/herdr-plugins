import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ARTIFACT_ID_PATTERN,
  ARTIFACT_KINDS,
  CONTRACT,
  CONTRACT_STATUS,
  MAX_BYTES,
  PLANNED_COMMANDS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  STORAGE_MODES,
} from "../plugins/artifacts/src/model";
import { testEnv } from "./helpers/test-env";

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
for (const key of [
  "HERDR_PLUGIN_STATE_DIR",
  "HERDR_PLUGIN_CONFIG_DIR",
  "HERDR_SOCKET_PATH",
  "HERDR_SESSION",
]) {
  savedEnv[key] = process.env[key];
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "artifacts-test-"));
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

const PLUGIN = path.join(__dirname, "..", "plugins", "artifacts");
const CLI = path.join(PLUGIN, "src", "cli.ts");

function cliEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return testEnv({
    HERDR_PLUGIN_STATE_DIR: tempDir(),
    HERDR_PLUGIN_CONFIG_DIR: tempDir(),
    ...extra,
  });
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

function parseCliOutput(stdout: string, stderr: string, status: number): CliResult {
  let json: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    /* empty stdout */
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
    env: cliEnv(extraEnv),
    timeout: 30_000,
  });
  return parseCliOutput(result.stdout, result.stderr, result.status ?? -1);
}

describe("artifacts contract constants", () => {
  test("contract identity and stable status", () => {
    expect(CONTRACT).toBe("herdr-plugins.artifacts/v1");
    expect(CONTRACT_STATUS).toBe("stable");
    expect(PLUGIN_ID).toBe("rebuildup.artifacts");
    expect(PLUGIN_VERSION).toBe("0.2.0");
  });

  test("kinds, storage modes, and caps match the contract skeleton", () => {
    expect([...ARTIFACT_KINDS]).toEqual(["html", "image", "pdf", "file", "other"]);
    expect([...STORAGE_MODES]).toEqual(["state_copy", "path_ref"]);
    expect(MAX_BYTES.image).toBe(10 * 1024 * 1024);
    for (const kind of ARTIFACT_KINDS) {
      expect(MAX_BYTES[kind]).toBeGreaterThan(0);
    }
    expect(ARTIFACT_ID_PATTERN.test("art-abc_123-XYZ")).toBe(true);
    expect(ARTIFACT_ID_PATTERN.test("../escape")).toBe(false);
    expect(ARTIFACT_ID_PATTERN.test("art-")).toBe(false);
  });
});

describe("artifacts cli (stable contract)", () => {
  test("capability emits the stable contract without herdr", () => {
    const result = runCli(["capability"]);
    expect(result.status).toBe(0);
    expect(result.json).not.toBeNull();
    const doc = result.json as Record<string, unknown>;
    expect(doc.contract).toBe(CONTRACT);
    expect(doc.contract_status).toBe("stable");
    expect(doc.plugin).toBe(PLUGIN_ID);
    expect(doc.version).toBe(PLUGIN_VERSION);
    expect(doc.kinds).toEqual([...ARTIFACT_KINDS]);
    expect(doc.storage_modes).toEqual([...STORAGE_MODES]);
    const limits = doc.limits as Record<string, unknown>;
    expect(limits.max_bytes).toEqual(MAX_BYTES);
    expect(doc.implemented_commands).toEqual([
      "capability",
      "help",
      "register",
      "list",
      "get",
      "search",
      "verify",
      "delete",
      "deliver",
      "gc",
      "export",
    ]);
    expect(doc.planned_commands).toEqual([...PLANNED_COMMANDS]);
    expect(doc.planned_commands).toEqual([]);
  });

  test("help emits usage JSON", () => {
    const result = runCli(["help"]);
    expect(result.status).toBe(0);
    const doc = result.json as Record<string, unknown>;
    expect(doc.contract).toBe(CONTRACT);
    expect(typeof doc.usage).toBe("string");
  });

  test("no args is a usage error (exit 2)", () => {
    const result = runCli([]);
    expect(result.status).toBe(2);
    expect(result.error?.code).toBe("usage");
  });

  test("unknown command is a usage error (exit 2)", () => {
    const result = runCli(["bogus"]);
    expect(result.status).toBe(2);
    expect(result.error?.code).toBe("usage");
  });

  test("v1 is stable: no contract_draft commands remain", () => {
    // PLANNED_COMMANDS is empty since T4 (#143); deliver/gc/export are
    // implemented and covered by tests/artifacts-t4.test.ts.
    expect(PLANNED_COMMANDS).toEqual([]);
    for (const command of ["deliver", "gc", "export"]) {
      const result = runCli([command]);
      expect(result.error?.kind).not.toBe("contract_draft");
    }
  });

  test("capability does not touch plugin state or herdr", () => {
    const stateDir = tempDir();
    const result = runCli(["capability"], {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_SOCKET_PATH: path.join(stateDir, "nonexistent.sock"),
    });
    expect(result.status).toBe(0);
    // No state files are created by a read-only capability call.
    expect(readdirSync(stateDir)).toEqual([]);
  });
});
