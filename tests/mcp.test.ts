import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ACCESS_LEVELS,
  CONTRACT,
  DEFAULT_ACCESS_LEVEL,
  ERROR_CODES,
  TOOL_TABLE,
  UPSTREAM_GAPS,
} from "../plugins/mcp/src/model";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-test-"));
  dirs.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("herdr-plugins.mcp/v1 contract skeleton (T1, #135)", () => {
  test("contract id and draft status constants", () => {
    expect(CONTRACT).toBe("herdr-plugins.mcp/v1");
    expect(ACCESS_LEVELS).toEqual(["read-only", "supervised", "full"]);
    expect(DEFAULT_ACCESS_LEVEL).toBe("read-only");
  });

  test("every planned tool declares access level + read-only annotation", () => {
    expect(TOOL_TABLE.length).toBeGreaterThan(0);
    const names = new Set<string>();
    for (const tool of TOOL_TABLE) {
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      expect(ACCESS_LEVELS).toContain(tool.access);
      expect(typeof tool.readOnly).toBe("boolean");
      // readOnlyHint must agree with the access floor: read-only tools
      // never mutate; supervised/full tools may mutate.
      if (tool.access === "read-only") expect(tool.readOnly).toBe(true);
    }
  });

  test("mutation tools require supervised or full", () => {
    const mutations = TOOL_TABLE.filter((t) => !t.readOnly);
    expect(mutations.length).toBeGreaterThan(0);
    for (const tool of mutations) {
      expect(tool.access === "supervised" || tool.access === "full").toBe(true);
    }
  });

  test("error model covers the contract codes", () => {
    for (const code of [
      "capability_denied",
      "not_found",
      "stale_generation",
      "session_unreachable",
      "unsupported",
      "plugin_unavailable",
      "invalid_params",
      "upstream_gap",
    ] as const) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  test("remote HTTP/OAuth is recorded as an upstream gap with tracking issue", () => {
    const remote = UPSTREAM_GAPS.find((g) => g.id === "remote-mcp-http-oauth");
    expect(remote).toBeDefined();
    expect(remote?.tracking).toBe("herdrdev/herdr#6199");
    expect(remote?.v1).toContain("excluded");
  });

  test("capability command emits the contract skeleton as JSON", async () => {
    const stateDir = tempDir();
    const configDir = tempDir();
    const prevState = process.env.HERDR_PLUGIN_STATE_DIR;
    const prevConfig = process.env.HERDR_PLUGIN_CONFIG_DIR;
    const prevSocket = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
    process.env.HERDR_PLUGIN_CONFIG_DIR = configDir;
    // Point at a nonexistent socket so the probe fails fast and honestly.
    process.env.HERDR_SOCKET_PATH = path.join(tempDir(), "missing.sock");
    try {
      // Spawn the real CLI end-to-end; the missing socket makes the
      // session probe fail fast and report reachable:false honestly.
      const proc = Bun.spawn(["bun", "run", "plugins/mcp/src/cli.ts", "capability"], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const doc = JSON.parse(stdout);
      expect(doc.contract).toBe(CONTRACT);
      expect(doc.contract_status).toBe("stable");
      expect(doc.plugin).toBe("rebuildup.mcp");
      expect(doc.negotiated_access_level).toBe("read-only");
      expect(doc.access_levels.levels).toEqual(["read-only", "supervised", "full"]);
      expect(doc.tools.length).toBe(TOOL_TABLE.length);
      const implemented = doc.tools.filter((t: { status: string }) => t.status === "implemented");
      expect(implemented.length).toBe(24); // T2 reads + T3 mutations + T4 events
      expect(doc.surfaces.read).toBe("stable");
      expect(doc.surfaces.events).toBe("stable");
      expect(Array.isArray(doc.plugins)).toBe(true);
      expect(doc.session_resolution.resolved_via).toBeDefined();
      expect(doc.session.reachable).toBe(false);
      expect(
        doc.upstream_gaps.some((g: { tracking: string }) => g.tracking === "herdrdev/herdr#6199"),
      ).toBe(true);
      expect(doc.remote.status).toBe("excluded_v1");
    } finally {
      if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
      else process.env.HERDR_PLUGIN_STATE_DIR = prevState;
      if (prevConfig === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
      else process.env.HERDR_PLUGIN_CONFIG_DIR = prevConfig;
      if (prevSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
      else process.env.HERDR_SOCKET_PATH = prevSocket;
    }
  });

  test("serve starts the stdio MCP server (T2, #138)", async () => {
    // With no herdr socket reachable the server still starts; protocol
    // handling is covered by tests/mcp-server.test.ts. Here we only
    // assert the entrypoint no longer reports not_implemented: send an
    // initialize and expect a JSON-RPC result on stdout.
    const proc = Bun.spawn(["bun", "run", "plugins/mcp/src/cli.ts", "serve"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HERDR_SOCKET_PATH: path.join(tempDir(), "missing.sock"),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
    );
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    const response = JSON.parse(buf.split("\n")[0] ?? "");
    expect(response.id).toBe(1);
    expect(response.result.serverInfo.name).toBe("rebuildup.mcp");
    expect(response.result.capabilities.tools).toBeDefined();
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  });

  test("invalid --access-level is a usage error", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "plugins/mcp/src/cli.ts", "capability", "--access-level", "yolo"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stderr).error.code).toBe("usage");
  });
});
