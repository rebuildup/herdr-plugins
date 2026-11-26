import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../plugins/secrets/src/config";
import { parseInfisicalRef, validateBinding } from "../plugins/secrets/src/model";
import { herdrSocketEndpoint, testEnv } from "./helpers/test-env";

const CLI = path.join(import.meta.dir, "../plugins/secrets/src/cli.ts");

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "secrets-test-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// --- unit: reference grammar -----------------------------------------------------

describe("parseInfisicalRef", () => {
  test("parses canonical references", () => {
    expect(parseInfisicalRef("infisical:dev:/shared:DEEPSEEK_API_KEY")).toEqual({
      env: "dev",
      path: "/shared",
      secret: "DEEPSEEK_API_KEY",
    });
    expect(parseInfisicalRef("infisical:prod:/backend/db:DB_PASSWORD")).toEqual({
      env: "prod",
      path: "/backend/db",
      secret: "DB_PASSWORD",
    });
    expect(parseInfisicalRef("infisical:dev:/:ROOT_KEY")).toEqual({
      env: "dev",
      path: "/",
      secret: "ROOT_KEY",
    });
  });

  test("rejects non-infisical and malformed references", () => {
    expect(parseInfisicalRef("op://vault/item/field")).toBeNull();
    expect(parseInfisicalRef("infisical:dev:SECRET")).toBeNull();
    expect(parseInfisicalRef("infisical:dev:/path")).toBeNull();
    expect(parseInfisicalRef("infisical:dev:path-no-slash:SECRET")).toBeNull();
    expect(parseInfisicalRef("infisical:dev:/a//b:SECRET")).toBeNull();
    expect(parseInfisicalRef("infisical:dev:/p:S:EXTRA")).toBeNull();
    expect(parseInfisicalRef("infisical::/p:S")).toBeNull();
    expect(parseInfisicalRef("")).toBeNull();
  });
});

describe("validateBinding", () => {
  test("accepts a well-formed binding", () => {
    const result = validateBinding({
      name: "deepseek",
      env: "DEEPSEEK_API_KEY",
      ref: "infisical:dev:/shared:DEEPSEEK_API_KEY",
      projectId: "proj-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binding.projectId).toBe("proj-1");
      expect(result.ref.secret).toBe("DEEPSEEK_API_KEY");
    }
  });

  test("rejects HERDR_* env collisions", () => {
    for (const env of ["HERDR_SESSION", "herdr_foo", "HERDR_PLUGIN_STATE_DIR"]) {
      const result = validateBinding({ name: "x", env, ref: "infisical:dev:/:S" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("HERDR_*");
    }
  });

  test("rejects op:// and invalid env names", () => {
    expect(validateBinding({ name: "x", env: "OK_NAME", ref: "op://v/i/f" }).ok).toBe(false);
    expect(validateBinding({ name: "x", env: "1BAD", ref: "infisical:dev:/:S" }).ok).toBe(false);
    expect(validateBinding({ name: "x", env: "HAS SPACE", ref: "infisical:dev:/:S" }).ok).toBe(
      false,
    );
  });
});

describe("loadConfig", () => {
  test("missing file yields empty config", async () => {
    const dir = tempDir();
    const { config, invalidBindings } = await loadConfig(dir);
    expect(config.bindings).toEqual([]);
    expect(invalidBindings).toEqual([]);
    expect(config.infisical.domain).toBe("https://secrets.rebuildup.dev/api");
  });

  test("invalid bindings are collected, valid ones kept", async () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        infisical: { projectId: "proj-1" },
        bindings: [
          { name: "good", env: "GOOD_KEY", ref: "infisical:dev:/:GOOD" },
          { name: "bad-env", env: "HERDR_X", ref: "infisical:dev:/:BAD" },
          { name: "bad-ref", env: "FINE", ref: "op://v/i/f" },
          { name: "dup", env: "GOOD_KEY", ref: "infisical:dev:/:DUP" },
        ],
      }),
    );
    const { config, invalidBindings } = await loadConfig(dir);
    expect(config.bindings.map((b) => b.name)).toEqual(["good"]);
    expect(invalidBindings.map((b) => b.name).sort()).toEqual(["bad-env", "bad-ref", "dup"]);
  });
});

// --- CLI harness -------------------------------------------------------------------

const FAKE_VALUE = "fake-secret-value-160-do-not-leak";

/** Stub `infisical` CLI: JSON output for known names, sentinels/errors otherwise. */
function writeFakeInfisical(dir: string): string {
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, "infisical");
  writeFileSync(
    script,
    `#!/bin/sh
# fake infisical for tests — never emits real secrets
if [ "$1" = "--version" ]; then echo "infisical version 0.0.0-fake"; exit 0; fi
# args: secrets get <name> --env ... --path ... --projectId ... --domain ... -o json --silent
name="$3"
case "$name" in
  *UNREACHABLE*) echo "connect ECONNREFUSED 10.0.0.1:443" >&2; exit 7 ;;
  *NOAUTH*) echo "error: 401 unauthorized: invalid token" >&2; exit 8 ;;
  *MISSING*) printf '[{"secretKey":"%s","secretValue":"*not found*"}]' "$name"; exit 0 ;;
  *) printf '[{"secretKey":"%s","secretValue":"%s-%s"}]' "$name" "${FAKE_VALUE}" "$name"; exit 0 ;;
esac
`,
  );
  chmodSync(script, 0o755);
  return binDir;
}

function writeConfig(dir: string, bindings: unknown[], extra?: Record<string, unknown>): string {
  const configDir = path.join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      infisical: { domain: "https://infisical.test/api", projectId: "proj-test", ...(extra ?? {}) },
      bindings,
    }),
  );
  return configDir;
}

const BINDINGS = [
  { name: "alpha", env: "ALPHA_KEY", ref: "infisical:dev:/:ALPHA_SECRET" },
  { name: "beta", env: "BETA_KEY", ref: "infisical:dev:/team:BETA_SECRET" },
  { name: "missing", env: "MISSING_KEY", ref: "infisical:dev:/:MISSING_SECRET" },
  { name: "unreachable", env: "UNREACH_KEY", ref: "infisical:dev:/:UNREACHABLE_SECRET" },
  { name: "noauth", env: "NOAUTH_KEY", ref: "infisical:dev:/:NOAUTH_SECRET" },
];

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

function baseEnv(extra?: Record<string, string>): Record<string, string> {
  return testEnv(extra);
}

function runCli(args: string[], extraEnv: Record<string, string>): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: baseEnv(extraEnv) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        /* non-JSON */
      }
      resolvePromise({ status: code ?? -1, stdout, stderr, json });
    });
  });
}

function harness(): { configDir: string; env: Record<string, string>; socketPath: string } {
  const dir = tempDir();
  const configDir = writeConfig(dir, BINDINGS);
  const binDir = writeFakeInfisical(dir);
  const socketPath = path.join(dir, "dead.sock"); // no listener unless a test starts one
  return {
    configDir,
    socketPath,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"),
      HERDR_SOCKET_PATH: socketPath,
    },
  };
}

// --- CLI: capability ---------------------------------------------------------------

describe("capability", () => {
  test("reports provider, bindings metadata, and boundary — no values", async () => {
    const { configDir, env } = harness();
    const result = await runCli(["capability", "--config-dir", configDir], env);
    expect(result.status).toBe(0);
    expect(result.json?.contract).toBe("herdr-plugins.secrets/v1");
    const provider = result.json?.provider as Record<string, unknown>;
    expect((provider.cli as Record<string, unknown>).available).toBe(true);
    const bindings = result.json?.bindings as Array<Record<string, unknown>>;
    expect(bindings.map((b) => b.name)).toEqual([
      "alpha",
      "beta",
      "missing",
      "unreachable",
      "noauth",
    ]);
    expect(JSON.stringify(result.json)).not.toContain(FAKE_VALUE);
    // mutation_commands (#224): side-effecting commands only.
    expect(result.json?.mutation_commands).toEqual(["run", "inject", "config"]);
  });
});

// --- CLI: resolve --------------------------------------------------------------------

describe("resolve", () => {
  test("reports per-binding status and never emits values", async () => {
    const { configDir, env } = harness();
    const result = await runCli(
      [
        "resolve",
        "--config-dir",
        configDir,
        "--binding",
        "alpha",
        "--binding",
        "missing",
        "--binding",
        "unreachable",
        "--binding",
        "noauth",
      ],
      env,
    );
    expect(result.status).toBe(1);
    const bindings = result.json?.bindings as Array<Record<string, unknown>>;
    const byName = new Map(bindings.map((b) => [b.name, b.status]));
    expect(byName.get("alpha")).toBe("resolved");
    expect(byName.get("missing")).toBe("unresolved");
    expect(byName.get("unreachable")).toBe("provider_unreachable");
    expect(byName.get("noauth")).toBe("auth_missing");
    expect(result.stdout).not.toContain(FAKE_VALUE);
    expect(result.stderr).not.toContain(FAKE_VALUE);
  });

  test("all-resolved exits 0", async () => {
    const { configDir, env } = harness();
    const result = await runCli(
      ["resolve", "--config-dir", configDir, "--binding", "alpha", "--binding", "beta"],
      env,
    );
    expect(result.status).toBe(0);
    expect(result.json?.ok).toBe(true);
    expect(result.stdout).not.toContain(FAKE_VALUE);
  });

  test("unknown binding is a structured config error", async () => {
    const { configDir, env } = harness();
    const result = await runCli(["resolve", "--config-dir", configDir, "--binding", "nope"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown binding");
  });
});

// --- CLI: run -------------------------------------------------------------------------

describe("run", () => {
  test("injects resolved values into the child env only", async () => {
    const { configDir, env } = harness();
    const script = `console.log("ALPHA=" + process.env.ALPHA_KEY); console.log("BETA=" + process.env.BETA_KEY); console.log("MISSING=" + process.env.MISSING_KEY);`;
    const result = await runCli(
      [
        "run",
        "--config-dir",
        configDir,
        "--binding",
        "alpha",
        "--binding",
        "beta",
        "--",
        process.execPath,
        "-e",
        script,
      ],
      env,
    );
    expect(result.status).toBe(0);
    // The child is a legal sink: it sees the values.
    expect(result.stdout).toContain(`ALPHA=${FAKE_VALUE}-ALPHA_SECRET`);
    expect(result.stdout).toContain(`BETA=${FAKE_VALUE}-BETA_SECRET`);
    expect(result.stdout).toContain("MISSING=undefined");
  });

  test("resolution failure does not start the command", async () => {
    const { configDir, env } = harness();
    const marker = path.join(tempDir(), "should-not-exist");
    const result = await runCli(
      ["run", "--config-dir", configDir, "--binding", "missing", "--", "touch", marker],
      env,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("resolution_failed");
    expect(result.stderr).not.toContain(FAKE_VALUE);
    expect(() => readFileSync(marker)).toThrow();
  });
});

// --- CLI: inject (fake herdr socket) ----------------------------------------------------

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

async function fakeHerdr(): Promise<{
  socketPath: string;
  calls: RecordedCall[];
  close: () => Promise<void>;
}> {
  const dir = tempDir();
  const socketPath = path.join(dir, "herdr.sock");
  const calls: RecordedCall[] = [];
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let msg: { id?: string; method?: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        calls.push({ method: msg.method ?? "", params: msg.params ?? {} });
        const env = (msg.params?.env ?? {}) as Record<string, string>;
        let result: Record<string, unknown>;
        if (msg.method === "workspace.create") {
          result = {
            workspace: { workspace_id: "ws-1" },
            tab: { tab_id: "tab-1", workspace_id: "ws-1" },
            root_pane: { pane_id: "pane-1", workspace_id: "ws-1", tab_id: "tab-1" },
          };
        } else if (msg.method === "tab.create") {
          result = {
            tab: { tab_id: "tab-2", workspace_id: "ws-9" },
            root_pane: { pane_id: "pane-2", workspace_id: "ws-9", tab_id: "tab-2" },
          };
        } else if (msg.method === "pane.split") {
          result = { pane: { pane_id: "pane-3", workspace_id: "ws-9", tab_id: "tab-1" } };
        } else {
          result = {};
        }
        void env;
        conn.write(`${JSON.stringify({ id: msg.id, result: { type: "ok", ...result } })}\n`);
      }
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(herdrSocketEndpoint(socketPath), () => resolveListen());
  });
  return {
    socketPath,
    calls,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

describe("inject", () => {
  test("workspace.create receives env map; CLI reports names only", async () => {
    const { configDir, env } = harness();
    const herdr = await fakeHerdr();
    try {
      const result = await runCli(
        [
          "inject",
          "--config-dir",
          configDir,
          "--binding",
          "alpha",
          "--binding",
          "beta",
          "--surface",
          "workspace",
          "--cwd",
          "/tmp",
        ],
        { ...env, HERDR_SOCKET_PATH: herdr.socketPath },
      );
      expect(result.status).toBe(0);
      expect(result.json?.ok).toBe(true);
      const injected = result.json?.injected as Record<string, unknown>;
      expect(injected.surface).toBe("workspace");
      expect(injected.pane_id).toBe("pane-1");
      expect((injected.env_names as string[]).sort()).toEqual(["ALPHA_KEY", "BETA_KEY"]);
      // Values must not appear anywhere in plugin output.
      expect(result.stdout).not.toContain(FAKE_VALUE);
      expect(result.stderr).not.toContain(FAKE_VALUE);
      // The socket call carried the values (legal sink) — verify server side.
      const create = herdr.calls.find((c) => c.method === "workspace.create");
      expect(create).toBeDefined();
      const sentEnv = create?.params.env as Record<string, string>;
      expect(sentEnv.ALPHA_KEY).toBe(`${FAKE_VALUE}-ALPHA_SECRET`);
      expect(sentEnv.BETA_KEY).toBe(`${FAKE_VALUE}-BETA_SECRET`);
    } finally {
      await herdr.close();
    }
  });

  test("tab and pane surfaces also accept env", async () => {
    const { configDir, env } = harness();
    const herdr = await fakeHerdr();
    try {
      const tabResult = await runCli(
        [
          "inject",
          "--config-dir",
          configDir,
          "--binding",
          "alpha",
          "--surface",
          "tab",
          "--workspace",
          "ws-9",
        ],
        { ...env, HERDR_SOCKET_PATH: herdr.socketPath },
      );
      expect(tabResult.status).toBe(0);
      const tabCall = herdr.calls.find((c) => c.method === "tab.create");
      expect((tabCall?.params.env as Record<string, string>).ALPHA_KEY).toBe(
        `${FAKE_VALUE}-ALPHA_SECRET`,
      );

      const paneResult = await runCli(
        [
          "inject",
          "--config-dir",
          configDir,
          "--binding",
          "alpha",
          "--surface",
          "pane",
          "--target-pane",
          "pane-1",
          "--direction",
          "down",
        ],
        { ...env, HERDR_SOCKET_PATH: herdr.socketPath },
      );
      expect(paneResult.status).toBe(0);
      const paneCall = herdr.calls.find((c) => c.method === "pane.split");
      expect(paneCall?.params.direction).toBe("down");
      expect((paneCall?.params.env as Record<string, string>).ALPHA_KEY).toBe(
        `${FAKE_VALUE}-ALPHA_SECRET`,
      );
    } finally {
      await herdr.close();
    }
  });

  test("resolution failure creates no surface", async () => {
    const { configDir, env } = harness();
    const herdr = await fakeHerdr();
    try {
      const result = await runCli(
        ["inject", "--config-dir", configDir, "--binding", "missing", "--surface", "workspace"],
        { ...env, HERDR_SOCKET_PATH: herdr.socketPath },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("resolution_failed");
      expect(
        herdr.calls.filter((c) => c.method.endsWith(".create") || c.method === "pane.split"),
      ).toEqual([]);
    } finally {
      await herdr.close();
    }
  });
});

// --- CLI: config ----------------------------------------------------------------------

describe("config", () => {
  test("--init writes a starter config and refuses overwrite", async () => {
    const dir = tempDir();
    const configDir = path.join(dir, "cfg");
    const env = baseEnv({
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"),
      PATH: `${writeFakeInfisical(dir)}:${process.env.PATH ?? ""}`,
    });
    const first = await runCli(["config", "--init"], env);
    expect(first.status).toBe(0);
    const file = path.join(configDir, "config.json");
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(written.bindings).toEqual([]);
    const second = await runCli(["config", "--init"], env);
    expect(second.status).toBe(1);
  });
});
