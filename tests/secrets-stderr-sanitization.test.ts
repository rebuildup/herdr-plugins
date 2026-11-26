import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Negative fixture for issue #170 contract re-check: rebuildup.secrets
 * must never emit secret-shaped material, including content a provider
 * CLI writes to stderr on failure.
 *
 * KNOWN GAP (documented, test skipped): `provider.ts classifyFailure`
 * embeds up to 300 chars of raw provider stderr into the `detail` field
 * that `resolve` prints on stdout and that `run`/`inject`/`capability
 * --probe` surface in error envelopes. A hostile or misconfigured
 * `--domain`/`--infisical-bin` that echoes secret material (or the
 * INFISICAL_TOKEN) in an error message would leak it into plugin output,
 * weakening the ADR-0027 §3 "never emitted" boundary. The desired
 * contract is that `detail` carries only classified, sanitized
 * diagnostics — never verbatim provider output.
 *
 * Un-skip this test once provider stderr is redacted (e.g. fixed
 * classification strings, or stderr scrubbed of env/token values).
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

describe("secrets provider stderr sanitization (#170 negative fixture)", () => {
  test.skip("provider stderr content never reaches emitted detail/envelopes", async () => {
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

    const result = await runCli(["resolve", "--binding", "a"], env);
    expect(result.status).toBe(1);
    // The leak marker must not appear in ANY plugin output surface.
    expect(result.stdout).not.toContain(LEAK_MARKER);
    expect(result.stderr).not.toContain(LEAK_MARKER);
  });
});
