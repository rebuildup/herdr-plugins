import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Negative fixture for issue #170 contract re-check / #209 fix:
 * rebuildup.secrets must never emit secret-shaped material, including
 * content a provider CLI writes to stderr (or stdout) on failure.
 *
 * `provider.ts classifyFailure` classifies provider stderr internally
 * but `detail` carries only the exit/signal fact — provider output is
 * never verbatim in `resolve` stdout JSON, the `run`/`inject` stderr
 * error envelopes, or the `capability --probe` reachability detail
 * (ADR-0027 §3). `capability`'s `cli.detail` likewise reports only the
 * `--version` exit code.
 */

const CLI = path.join(import.meta.dir, "../plugins/secrets/src/cli.ts");
const LEAK_MARKER = "LEAKED-PROVIDER-STDERR-SECRET-9f8e7d";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "secrets-stderr-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Fake `infisical` that fails while echoing secret-shaped stderr. */
function writeLeakyInfisical(dir: string): string {
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, "infisical");
  writeFileSync(
    script,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "infisical 0.0.0-fake"; exit 0; fi
echo "provider error: token=${LEAK_MARKER} request dump" >&2
exit 9
`,
  );
  chmodSync(script, 0o755);
  return binDir;
}

function runCli(args: string[], env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ status: code, stdout, stderr }));
    },
  );
}

function harness(): { configDir: string; env: Record<string, string> } {
  const dir = tempDir();
  const configDir = path.join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      infisical: { domain: "https://infisical.test/api", projectId: "p1" },
      bindings: [{ name: "a", env: "A_KEY", ref: "infisical:dev:/:A_SECRET" }],
    }),
  );
  const binDir = writeLeakyInfisical(dir);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  env.HERDR_PLUGIN_CONFIG_DIR = configDir;
  env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
  return { configDir, env };
}

/** The leak marker must not appear in ANY plugin output surface. */
function expectNoLeak(result: { stdout: string; stderr: string }): void {
  expect(result.stdout).not.toContain(LEAK_MARKER);
  expect(result.stderr).not.toContain(LEAK_MARKER);
}

describe("secrets provider stderr sanitization (#170 negative fixture, #209)", () => {
  test("resolve: provider stderr content never reaches detail or envelopes", async () => {
    const { configDir, env } = harness();
    const result = await runCli(["resolve", "--config-dir", configDir, "--binding", "a"], env);
    expect(result.status).toBe(1);
    expectNoLeak(result);
    const bindings = JSON.parse(result.stdout).bindings as Array<Record<string, unknown>>;
    expect(bindings[0]?.status).toBe("provider_error");
    expect(String(bindings[0]?.detail ?? "")).not.toContain(LEAK_MARKER);
  });

  test("run: resolution_failed envelope carries no provider stderr", async () => {
    const { configDir, env } = harness();
    const result = await runCli(
      ["run", "--config-dir", configDir, "--binding", "a", "--", process.execPath, "-e", "0"],
      env,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("resolution_failed");
    expectNoLeak(result);
  });

  test("inject: resolution_failed envelope carries no provider stderr", async () => {
    const { configDir, env } = harness();
    const result = await runCli(
      ["inject", "--config-dir", configDir, "--binding", "a", "--surface", "workspace"],
      env,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("resolution_failed");
    expectNoLeak(result);
  });

  test("capability --probe: reachability detail carries no provider stderr", async () => {
    const { configDir, env } = harness();
    const result = await runCli(["capability", "--config-dir", configDir, "--probe"], env);
    expect(result.status).toBe(0);
    expectNoLeak(result);
    const provider = JSON.parse(result.stdout).provider as Record<string, unknown>;
    const reachability = provider.reachability as Record<string, unknown>;
    expect(reachability.status).toBe("provider_error");
    if (typeof reachability.detail === "string") {
      expect(reachability.detail).not.toContain(LEAK_MARKER);
    }
  });
});
