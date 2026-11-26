import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseUntilSpec } from "../plugins/inbox/src/cli";

const NOW = new Date("2026-01-10T12:00:00Z");

describe("parseUntilSpec", () => {
  test("duration specs", () => {
    expect(parseUntilSpec("+30m", NOW).toISOString()).toBe("2026-01-10T12:30:00.000Z");
    expect(parseUntilSpec("+2h", NOW).toISOString()).toBe("2026-01-10T14:00:00.000Z");
    expect(parseUntilSpec("+1d", NOW).toISOString()).toBe("2026-01-11T12:00:00.000Z");
    expect(parseUntilSpec("45m", NOW).toISOString()).toBe("2026-01-10T12:45:00.000Z");
  });

  test("ISO 8601 specs", () => {
    expect(parseUntilSpec("2026-01-10T18:30:00Z", NOW).toISOString()).toBe(
      "2026-01-10T18:30:00.000Z",
    );
    expect(parseUntilSpec("2026-01-10T18:30:00+09:00", NOW).toISOString()).toBe(
      "2026-01-10T09:30:00.000Z",
    );
  });
});

// CLI usage-error contract: strict option parsing exits 2 before any
// herdr socket access, so no session fixture is required.
const INBOX_CLI = path.join(import.meta.dir, "..", "plugins", "inbox", "src", "cli.ts");

function runCli(args: string[]): { status: number; code: string | undefined } {
  const env = { ...process.env };
  for (const key of [
    "HERDR_PANE_ID",
    "HERDR_PLUGIN_CONTEXT_JSON",
    "HERDR_SOCKET_PATH",
    "HERDR_SESSION",
  ]) {
    delete env[key];
  }
  const result = spawnSync(process.execPath, ["run", INBOX_CLI, ...args], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  let code: string | undefined;
  try {
    code = (JSON.parse(result.stderr) as { error?: { code?: string } }).error?.code;
  } catch {
    // assertion below still fails on status/code
  }
  return { status: result.status ?? -1, code };
}

function expectUsage(args: string[]): void {
  const { status, code } = runCli(args);
  expect(status).toBe(2);
  expect(code).toBe("usage");
}

describe("cli usage errors", () => {
  test("every command rejects unknown options with exit 2", () => {
    const cases: string[][] = [
      ["list", "--bogus"],
      ["settle", "p1", "--bogus"],
      ["snooze", "p1", "--until", "+1h", "--bogus"],
      ["restore", "p1", "--bogus"],
      ["reconcile", "--bogus"],
      ["watch", "--bogus"],
      ["capability", "--bogus"],
      ["_wake", "--until", "2026-01-01T00:00:00Z", "--bogus"],
    ];
    for (const args of cases) expectUsage(args);
  }, 60_000);
  test("value flags require values and invalid values are usage errors", () => {
    expectUsage(["snooze", "p1", "--until"]);
    expectUsage(["watch", "--interval"]);
    expectUsage(["watch", "--interval", "abc"]);
    expectUsage(["watch", "--interval", "-1"]);
    expectUsage(["list", "--timeout", "abc"]);
  }, 60_000);
  test("extra positionals and wrong-flag usage are exit 2", () => {
    expectUsage(["list", "extra"]);
    expectUsage(["settle", "p1", "extra"]);
    expectUsage(["restore", "p1", "extra"]);
    expectUsage(["reconcile", "extra"]);
    expectUsage(["capability", "extra"]);
    expectUsage(["settle", "p1", "--until", "+1h"]); // --until is snooze-only
    expectUsage(["watch", "--until", "+1h"]);
  }, 60_000);
});
