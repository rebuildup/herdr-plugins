import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { machinesBinary } from "./helpers/machines-bin";
import { testEnv } from "./helpers/test-env";

/**
 * Contract tests for the NATIVE rebuildup.machines plugin (Issue #326,
 * ADR-0035). The binary under test is resolved by {@link machinesBinary}:
 * committed `plugins/machines/bin/machines` prebuilt, then cargo
 * `target/{debug,release}` outputs.
 *
 * Coverage mirrors the retired TS suites at the public-CLI boundary:
 * strict usage errors, capability shape, --socket/--session target
 * flags, list/probe against a stub `herdr` CLI (HERDR_BIN_PATH), probe
 * state taxonomy (ok/disabled/unreachable/unsupported_remote/
 * plugin_surface unsupported), state persistence, and the non-TTY
 * `tui` fallback. No real herdr session is touched.
 */

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "machines-native-"));
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

function runCli(args: string[], extra: Record<string, string> = {}): Promise<CliResult> {
  const env = testEnv(extra);
  return new Promise((resolve, reject) => {
    const child = spawn(machinesBinary(), args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(parseOut(stdout, stderr, code ?? -1));
    });
    child.stdin.end();
  });
}

// --- stub herdr --------------------------------------------------------------

/**
 * Minimal file-driven `herdr` stub (same contract as the diff harness):
 * `machine list --json` from machines.json; `--machine <id> api
 * snapshot` / `plugin list --json` from per-id files; failure markers
 * per scenario.
 */
function installHerdrStub(dir: string): { bin: string; stubDir: string } {
  const stubDir = path.join(dir, "stub");
  const binDir = path.join(dir, "bin");
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const script = `#!/bin/sh
D="$MACHINES_STUB_DIR"
if [ "$1" = "machine" ] && [ "$2" = "list" ]; then
  if [ -f "$D/fail-list" ]; then echo "herdr: backend down" >&2; exit 1; fi
  cat "$D/machines.json"; exit 0
fi
if [ "$1" = "--machine" ]; then
  id="$2"; shift 2
  case "$1" in
    api)
      if [ -f "$D/fail-snapshot-$id" ]; then echo "ssh: connect failed" >&2; exit 3; fi
      if [ -f "$D/bridge-$id" ]; then
        printf '%s\\n' '{"id":"s","error":{"code":"unsupported","message":"does not support machine API forwarding (remote-api-bridge)"}}'
        exit 0
      fi
      printf '%s\\n' "{\\"id\\":\\"s\\",\\"result\\":{\\"snapshot\\":$(cat "$D/snapshot-$id.json")}}"
      exit 0 ;;
    plugin)
      if [ -f "$D/fail-plugins-$id" ]; then echo "plugin list: method not found" >&2; exit 1; fi
      printf '%s\\n' "{\\"id\\":\\"s\\",\\"result\\":{\\"plugins\\":$(cat "$D/plugins-$id.json")}}"
      exit 0 ;;
  esac
fi
echo "herdr stub: unsupported $*" >&2; exit 9
`;
  const bin = path.join(binDir, "herdr");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return { bin, stubDir };
}

function seedStub(stubDir: string): void {
  const w = (name: string, value: unknown) =>
    writeFileSync(path.join(stubDir, name), `${JSON.stringify(value)}\n`);
  w("machines.json", [
    {
      id: "m-ok",
      label: "Lab Box",
      target: "lab.example.com",
      session: "agents",
      enabled: true,
      selected: false,
    },
    {
      id: "m-disabled",
      label: "Old Box",
      target: "old.example.com",
      session: "default",
      enabled: false,
    },
    {
      id: "m-dead",
      label: "Dead Box",
      target: "dead.example.com",
      session: "default",
      enabled: true,
    },
    { id: "m-no-target" },
  ]);
  w("snapshot-m-ok.json", { version: "0.9.5", protocol: 22 });
  w("snapshot-m-dead.json", { version: "0.9.5", protocol: 22 });
  w("plugins-m-ok.json", [{ plugin_id: "rebuildup.inbox", name: "Inbox", version: "0.7.0" }]);
  writeFileSync(path.join(stubDir, "fail-snapshot-m-dead"), "");
}

function stubEnv(bin: string, stubDir: string, stateDir: string): Record<string, string> {
  return {
    HERDR_BIN_PATH: bin,
    MACHINES_STUB_DIR: stubDir,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONFIG_DIR: path.join(stateDir, "..", "config"),
  };
}

// --- usage errors -------------------------------------------------------------

describe("machines native cli usage", () => {
  test("capability emits the contract document", async () => {
    const res = await runCli(["capability"]);
    expect(res.status).toBe(0);
    expect(res.json?.contract).toBe("herdr-plugins.machines/v1");
    expect(res.json?.command).toBe("capability");
    expect(res.json?.read_only).toBe(true);
    expect(res.json?.mutation_commands).toEqual([]);
    expect(res.json?.commands).toEqual(["capability", "list", "probe"]);
    expect(res.json?.probe_states).toContain("unsupported_remote");
    expect(typeof res.json?.state_file).toBe("string");
  });

  test("help emits usage", async () => {
    const res = await runCli(["help"]);
    expect(res.status).toBe(0);
    expect(String(res.json?.usage)).toContain("--socket");
    expect(String(res.json?.usage)).toContain("--session");
  });

  test("list accepts --socket/--session (fails later, not with usage)", async () => {
    const res = await runCli(["list", "--socket", "/tmp/fake.sock", "--session", "agents"], {
      HERDR_BIN_PATH: path.join(tempDir(), "no-such-herdr"),
    });
    expect(res.status).toBe(1);
    expect(res.error?.code).not.toBe("usage");
    expect(res.error?.message).toContain("machine list");
  });

  test("probe requires a selector or --all", async () => {
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

  test("unknown arguments are usage errors", async () => {
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

  test("unknown command is a usage error", async () => {
    const res = await runCli(["bogus"]);
    expect(res.status).toBe(2);
    expect(res.error?.code).toBe("usage");
    expect(res.error?.message).toContain("unknown command: bogus");
  });
});

// --- list / probe against the stub ---------------------------------------------

describe("machines native list/probe", () => {
  test("list merges machines with last_probe=null on fresh state", async () => {
    const dir = tempDir();
    const { bin, stubDir } = installHerdrStub(dir);
    seedStub(stubDir);
    const stateDir = path.join(dir, "state");
    const res = await runCli(["list"], stubEnv(bin, stubDir, stateDir));
    expect(res.status).toBe(0);
    const machines = res.json?.machines as Array<Record<string, unknown>>;
    expect(machines).toHaveLength(3); // malformed entry skipped
    const first = machines[0] as { machine: { id: string }; last_probe: unknown };
    expect(first.machine.id).toBe("m-ok");
    expect(first.last_probe).toBeNull();
    expect(res.json?.total).toBe(3);
  });

  test("probe ok records snapshot + plugin surface and persists state", async () => {
    const dir = tempDir();
    const { bin, stubDir } = installHerdrStub(dir);
    seedStub(stubDir);
    const stateDir = path.join(dir, "state");
    const env = stubEnv(bin, stubDir, stateDir);
    const res = await runCli(["probe", "m-ok"], env);
    expect(res.status).toBe(0);
    const results = res.json?.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    const probe = results[0] as Record<string, unknown>;
    expect(probe.state).toBe("ok");
    expect(probe.reachable).toBe(true);
    expect(probe.server_version).toBe("0.9.5");
    expect(probe.protocol).toBe(22);
    expect(probe.plugin_surface).toBe("supported");
    expect(probe.plugins).toEqual([{ id: "rebuildup.inbox", name: "Inbox", version: "0.7.0" }]);

    // State persisted: list now reports last_probe.
    const list = await runCli(["list"], env);
    const items = list.json?.machines as Array<{
      machine: { id: string };
      last_probe: { state: string } | null;
    }>;
    const ok = items.find((i) => i.machine.id === "m-ok");
    expect(ok?.last_probe?.state).toBe("ok");
  });

  test("probe disabled reports disabled without a remote call", async () => {
    const dir = tempDir();
    const { bin, stubDir } = installHerdrStub(dir);
    seedStub(stubDir);
    const res = await runCli(["probe", "m-disabled"], stubEnv(bin, stubDir, path.join(dir, "s")));
    expect(res.status).toBe(0);
    const probe = (res.json?.results as Array<Record<string, unknown>>)[0];
    expect(probe?.state).toBe("disabled");
    expect(probe?.reachable).toBeNull();
    expect(probe?.plugin_surface).toBe("unknown");
  });

  test("probe unreachable classifies transport failure honestly", async () => {
    const dir = tempDir();
    const { bin, stubDir } = installHerdrStub(dir);
    seedStub(stubDir);
    const res = await runCli(["probe", "m-dead"], stubEnv(bin, stubDir, path.join(dir, "s")));
    expect(res.status).toBe(0);
    const probe = (res.json?.results as Array<Record<string, unknown>>)[0];
    expect(probe?.state).toBe("unreachable");
    expect(probe?.reachable).toBe(false);
    expect(probe?.error_kind).toBe("remote_command_failed");
  });

  test("probe --all covers every saved machine sequentially", async () => {
    const dir = tempDir();
    const { bin, stubDir } = installHerdrStub(dir);
    seedStub(stubDir);
    const res = await runCli(["probe", "--all"], stubEnv(bin, stubDir, path.join(dir, "s")));
    expect(res.status).toBe(0);
    const results = res.json?.results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.machine_id)).toEqual(["m-ok", "m-disabled", "m-dead"]);
    expect(results.map((r) => r.state)).toEqual(["ok", "disabled", "unreachable"]);
  });

  test("unknown and ambiguous selectors are usage errors", async () => {
    const dir = tempDir();
    const { bin, stubDir } = installHerdrStub(dir);
    seedStub(stubDir);
    const env = stubEnv(bin, stubDir, path.join(dir, "s"));
    const missing = await runCli(["probe", "nope"], env);
    expect(missing.status).toBe(2);
    expect(missing.error?.kind).toBe("machine_not_found");
  });

  test("machine list failure is honest (exit 1, machine_list_failed)", async () => {
    const dir = tempDir();
    const { bin, stubDir } = installHerdrStub(dir);
    seedStub(stubDir);
    writeFileSync(path.join(stubDir, "fail-list"), "");
    const res = await runCli(["list"], stubEnv(bin, stubDir, path.join(dir, "s")));
    expect(res.status).toBe(1);
    expect(res.error?.kind).toBe("machine_list_failed");
  });

  test("missing herdr binary fails honestly", async () => {
    const res = await runCli(["list"], {
      HERDR_BIN_PATH: path.join(tempDir(), "no-such-herdr"),
    });
    expect(res.status).toBe(1);
    expect(res.error?.kind).toBe("machine_list_failed");
  });
});

// --- non-TTY tui fallback --------------------------------------------------------

describe("machines native tui fallback", () => {
  test("piped stdin renders the plain-text list, never a fake TUI", async () => {
    const dir = tempDir();
    const { bin, stubDir } = installHerdrStub(dir);
    seedStub(stubDir);
    const env = testEnv(stubEnv(bin, stubDir, path.join(dir, "s")));
    const result = await new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = spawn(machinesBinary(), ["tui"], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr });
      });
      child.stdin.end();
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Lab Box (m-ok)");
    expect(result.stdout).toContain("target=lab.example.com");
    expect(result.stdout).toContain("probe=never");
    expect(result.stdout).toContain("hint: run inside a herdr pane");
  });

  test("tui unknown subcommand is a usage error", async () => {
    const res = await runCli(["tui", "bogus"]);
    expect(res.status).toBe(2);
  });
});
