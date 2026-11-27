/**
 * CLI-level regression tests for rebuildup.machines argument parsing
 * (issue: `--socket`/`--session` target flags appended by external
 * clients such as herdr-t3 must be accepted by every command).
 *
 * The spawned CLI always fails later at `herdr machine list` because
 * HERDR_BIN_PATH points at a nonexistent binary — the assertions check
 * that failures are NOT usage/argument errors and that flag values are
 * never counted as probe positionals.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testEnv } from "./helpers/test-env";

const CLI = path.join(__dirname, "..", "plugins", "machines", "src", "cli.ts");

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "machines-cli-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
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

/**
 * Env with a deliberately nonexistent herdr binary so any command that
 * reaches the transport fails fast with `machine_list_failed` — never
 * touching a real herdr session.
 */
function runCli(args: string[]): Promise<CliResult> {
  const env = testEnv({
    HERDR_BIN_PATH: path.join(tempDir(), "no-such-herdr"),
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
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
    child.stdin.end();
  });
}

describe("machines cli target flags", () => {
  test("list accepts --socket and --session (fails later, not with usage)", async () => {
    const res = await runCli(["list", "--socket", "/tmp/fake.sock", "--session", "agents"]);
    expect(res.status).toBe(1);
    expect(res.error?.code).not.toBe("usage");
    expect(res.error?.message).toContain("machine list");
  });

  test("capability accepts --socket and --session", async () => {
    const res = await runCli(["capability", "--socket", "/tmp/fake.sock", "--session", "agents"]);
    expect(res.status).toBe(0);
    expect(res.json?.command).toBe("capability");
  });

  test("probe <selector> with target flags is not a usage error", async () => {
    const res = await runCli(["probe", "m1", "--socket", "/tmp/fake.sock", "--session", "agents"]);
    expect(res.status).toBe(1);
    expect(res.error?.code).not.toBe("usage");
    expect(res.error?.message).toContain("machine list");
  });

  test("probe --all with target flags is not a usage error", async () => {
    const res = await runCli(["probe", "--all", "--socket", "/tmp/fake.sock"]);
    expect(res.status).toBe(1);
    expect(res.error?.code).not.toBe("usage");
    expect(res.error?.message).toContain("machine list");
  });

  test("probe still requires a selector or --all", async () => {
    const res = await runCli(["probe", "--socket", "/tmp/fake.sock"]);
    expect(res.status).toBe(2);
    expect(res.error?.code).toBe("usage");
    expect(res.error?.message).toContain("exactly one");
  });

  test("probe rejects --all mixed with a selector", async () => {
    const res = await runCli(["probe", "--all", "m1", "--session", "agents"]);
    expect(res.status).toBe(2);
    expect(res.error?.code).toBe("usage");
    expect(res.error?.message).toContain("--all");
  });

  test("unknown arguments are still usage errors", async () => {
    const res = await runCli(["list", "--bogus"]);
    expect(res.status).toBe(2);
    expect(res.error?.code).toBe("usage");
    expect(res.error?.message).toContain("--bogus");
  });

  test("list rejects positionals", async () => {
    const res = await runCli(["list", "extra", "--socket", "/tmp/fake.sock"]);
    expect(res.status).toBe(2);
    expect(res.error?.code).toBe("usage");
    expect(res.error?.message).toContain("unexpected argument: extra");
  });

  test("target flags require a value", async () => {
    const res = await runCli(["list", "--socket"]);
    expect(res.status).toBe(2);
    expect(res.error?.code).toBe("usage");
    expect(res.error?.message).toContain("--socket");
  });

  test("help output documents the target flags", async () => {
    const res = await runCli(["help"]);
    expect(res.status).toBe(0);
    expect(res.json?.usage).toContain("--socket");
    expect(res.json?.usage).toContain("--session");
  });
});
