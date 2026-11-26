import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { herdrSocketEndpoint, testEnv } from "./helpers/test-env";

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
  const dir = mkdtempSync(path.join(tmpdir(), "artifacts-t4-test-"));
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

interface FakePane {
  pane_id: string;
  cwd?: string;
}

interface FakeAgent {
  agent_session?: { value?: string };
}

interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
}

/**
 * Fake herdr socket: session.snapshot plus the two delivery methods
 * (`agent.prompt`, `pane.send_text`). Every request is recorded so
 * tests can assert the exact wire call. `failMethods` maps a method
 * name to an RPC error the server returns instead of a result.
 */
async function fakeHerdrSocket(options: {
  panes?: FakePane[];
  agents?: Record<string, FakeAgent>;
  sessionName?: string;
  failMethods?: Record<string, { code: string; message: string }>;
}): Promise<{
  socketPath: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const socketPath = path.join(tempDir(), "fake-herdr.sock");
  const requests: RecordedRequest[] = [];
  const snapshot = {
    session: { name: options.sessionName ?? "test-session" },
    panes: options.panes ?? [],
    agents: options.agents ?? {},
  };
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
        const message = JSON.parse(line) as {
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
        };
        const method = message.method ?? "";
        requests.push({ method, params: message.params ?? {} });
        const failure = options.failMethods?.[method];
        const response =
          failure !== undefined
            ? { id: message.id, error: failure }
            : {
                id: message.id,
                result: method === "session.snapshot" ? { snapshot } : {},
              };
        conn.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(herdrSocketEndpoint(socketPath), () => resolveListen());
  });
  return {
    socketPath,
    requests,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
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

function runCli(
  args: string[],
  env: Record<string, string>,
  stdin?: string | Buffer,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: testEnv(env),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(parseCliOutput(stdout, stderr, code ?? -1)));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function expectOk(r: CliResult): Record<string, unknown> {
  expect(r.status).toBe(0);
  expect(r.json).not.toBeNull();
  expect(r.json?.ok).toBe(true);
  return r.json as Record<string, unknown>;
}

function expectErr(r: CliResult, kind?: string): Record<string, unknown> {
  expect(r.status).toBe(1);
  expect(r.json).toBeNull();
  expect(r.error).not.toBeNull();
  if (kind) expect(r.error?.kind).toBe(kind);
  return r.error as Record<string, unknown>;
}

function expectUsage(r: CliResult): void {
  expect(r.status).toBe(2);
  expect(r.error?.code).toBe("usage");
}

function artifactOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.artifact as Record<string, unknown>;
}

const HTML = "<!doctype html><html><body>hello</body></html>";
const TEXT = "plain artifact body\n";

interface Rig {
  stateDir: string;
  env: Record<string, string>;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

async function rig(options?: {
  panes?: FakePane[];
  agents?: Record<string, FakeAgent>;
  failMethods?: Record<string, { code: string; message: string }>;
}): Promise<Rig> {
  const stateDir = tempDir();
  const fake = await fakeHerdrSocket(options ?? {});
  return {
    stateDir,
    env: {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONFIG_DIR: path.join(stateDir, "config"),
      HERDR_SOCKET_PATH: fake.socketPath,
    },
    requests: fake.requests,
    close: fake.close,
  };
}

function writeSource(dir: string, name: string, content: string | Buffer): string {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
}

async function registerText(r: Rig, extra: string[] = []): Promise<string> {
  const srcDir = tempDir();
  const src = writeSource(srcDir, "note.txt", TEXT);
  const reg = expectOk(await runCli(["register", "--path", src, ...extra], r.env));
  return String(artifactOf(reg).artifact_id);
}

async function registerHtml(r: Rig): Promise<string> {
  const srcDir = tempDir();
  const src = writeSource(srcDir, "page.html", HTML);
  const reg = expectOk(await runCli(["register", "--path", src], r.env));
  return String(artifactOf(reg).artifact_id);
}

const t = (name: string, fn: () => void | Promise<void>) => test(name, fn, 30_000);

describe("artifacts deliver (T4 #143)", () => {
  t("deliver --agent sends agent.prompt with the stable absolute path", async () => {
    const r = await rig({
      panes: [{ pane_id: "w1:p1" }],
      agents: { "w1:p1": { agent_session: { value: "sess-1" } } },
    });
    try {
      const id = await registerText(r, ["--title", "Weekly note"]);
      const res = expectOk(
        await runCli(["deliver", "--agent", "w1:p1", id, "--note", "please review"], r.env),
      );
      expect(res.command).toBe("deliver");
      const target = res.target as Record<string, unknown>;
      expect(target.kind).toBe("agent");
      expect(target.pane_id).toBe("w1:p1");
      expect(res.method).toBe("agent.prompt");
      const message = String(res.message);
      const artifact = artifactOf(res) as Record<string, unknown>;
      const resolved = String((artifact.storage as Record<string, unknown>).resolved_path);
      expect(message).toContain(resolved);
      expect(message).toContain(id);
      expect(message).toContain("please review");

      const prompt = r.requests.find((q) => q.method === "agent.prompt");
      expect(prompt).toBeDefined();
      expect(prompt?.params.target).toBe("w1:p1");
      expect(String(prompt?.params.text)).toBe(message);
      // No pane.send_text on the agent path.
      expect(r.requests.some((q) => q.method === "pane.send_text")).toBe(false);
    } finally {
      await r.close();
    }
  });

  t("deliver --pane sends pane.send_text (literal text, no submit)", async () => {
    const r = await rig({ panes: [{ pane_id: "w2:p3" }] });
    try {
      const id = await registerText(r);
      const res = expectOk(await runCli(["deliver", "--pane", "w2:p3", id], r.env));
      expect(res.method).toBe("pane.send_text");
      const send = r.requests.find((q) => q.method === "pane.send_text");
      expect(send).toBeDefined();
      expect(send?.params.pane_id).toBe("w2:p3");
      expect(String(send?.params.text)).toContain(id);
      expect(r.requests.some((q) => q.method === "agent.prompt")).toBe(false);
    } finally {
      await r.close();
    }
  });

  t("deliver refuses a stale/unknown pane (target_not_found)", async () => {
    const r = await rig({ panes: [{ pane_id: "w1:p1" }] });
    try {
      const id = await registerText(r);
      const res = await runCli(["deliver", "--pane", "w9:p9", id], r.env);
      const error = expectErr(res, "not_found");
      expect(error.code).toBe("target_not_found");
      // Nothing was sent.
      expect(r.requests.some((q) => q.method === "pane.send_text")).toBe(false);
      expect(r.requests.some((q) => q.method === "agent.prompt")).toBe(false);
    } finally {
      await r.close();
    }
  });

  t("deliver --agent refuses a pane with no live agent (agent_not_found)", async () => {
    const r = await rig({ panes: [{ pane_id: "w1:p1" }] });
    try {
      const id = await registerText(r);
      const res = await runCli(["deliver", "--agent", "w1:p1", id], r.env);
      const error = expectErr(res, "not_found");
      expect(error.code).toBe("agent_not_found");
      expect(r.requests.some((q) => q.method === "agent.prompt")).toBe(false);
    } finally {
      await r.close();
    }
  });

  t("deliver refuses an artifact whose payload is missing (missing_ref)", async () => {
    const r = await rig({ panes: [{ pane_id: "w1:p1" }] });
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "gone.txt", TEXT);
      const reg = expectOk(
        await runCli(["register", "--path", src, "--storage", "path_ref"], r.env),
      );
      const id = String(artifactOf(reg).artifact_id);
      rmSync(src);
      const res = await runCli(["deliver", "--pane", "w1:p1", id], r.env);
      const error = expectErr(res, "not_found");
      expect(error.code).toBe("missing_ref");
      expect(r.requests.some((q) => q.method === "pane.send_text")).toBe(false);
    } finally {
      await r.close();
    }
  });

  t("deliver surfaces upstream RPC rejection as delivery_failed.rpc_code", async () => {
    const r = await rig({
      panes: [{ pane_id: "w1:p1" }],
      agents: { "w1:p1": {} },
      failMethods: {
        "agent.prompt": { code: "agent_blocked", message: "agent is blocked" },
      },
    });
    try {
      const id = await registerText(r);
      const res = await runCli(["deliver", "--agent", "w1:p1", id], r.env);
      const error = expectErr(res, "unavailable");
      expect(error.code).toBe("delivery_failed");
      expect(error.rpc_code).toBe("agent_blocked");
    } finally {
      await r.close();
    }
  });

  t("deliver usage errors: target flags and artifact_id are required exactly once", async () => {
    const r = await rig({ panes: [{ pane_id: "w1:p1" }] });
    try {
      const id = await registerText(r);
      expectUsage(await runCli(["deliver", id], r.env));
      expectUsage(await runCli(["deliver", "--pane", "w1:p1", "--agent", "w1:p1", id], r.env));
      expectUsage(await runCli(["deliver", "--pane", "w1:p1"], r.env));
      expectUsage(await runCli(["deliver", "--pane", "w1:p1", id, "extra"], r.env));
    } finally {
      await r.close();
    }
  });
});

describe("artifacts gc (T4 #143)", () => {
  t("gc --dry-run reports candidates without mutating state", async () => {
    const r = await rig();
    try {
      const id = await registerText(r);
      const future = new Date(Date.now() + 60_000).toISOString();
      const res = expectOk(await runCli(["gc", "--older-than", future, "--dry-run"], r.env));
      expect(res.dry_run).toBe(true);
      const totals = res.totals as Record<string, unknown>;
      expect(totals.would_delete).toBe(1);
      const entries = res.entries as Record<string, unknown>[];
      expect(entries[0]?.artifact_id).toBe(id);
      expect(entries[0]?.action).toBe("would_delete");
      // Nothing deleted: the record and payload still exist.
      const list = expectOk(await runCli(["list"], r.env));
      expect((list.artifacts as unknown[]).length).toBe(1);
    } finally {
      await r.close();
    }
  });

  t("gc collects expired unreferenced artifacts; referenced ones are skipped", async () => {
    const r = await rig();
    try {
      const plain = await registerText(r);
      const referenced = await registerText(r, ["--ref", "handoff:record/ho-1"]);
      const future = new Date(Date.now() + 60_000).toISOString();

      const dry = expectOk(await runCli(["gc", "--older-than", future, "--dry-run"], r.env));
      const entries = dry.entries as Record<string, unknown>[];
      const byId = new Map(entries.map((e) => [String(e.artifact_id), e]));
      expect(byId.get(plain)?.action).toBe("would_delete");
      expect(byId.get(referenced)?.action).toBe("skipped");
      expect(byId.get(referenced)?.reason).toBe("referenced");

      const res = expectOk(await runCli(["gc", "--older-than", future], r.env));
      const totals = res.totals as Record<string, unknown>;
      expect(totals.deleted).toBe(1);
      expect(totals.skipped_referenced).toBe(1);

      const list = expectOk(await runCli(["list"], r.env));
      const remaining = (list.artifacts as Record<string, unknown>[]).map((a) =>
        String(a.artifact_id),
      );
      expect(remaining).toEqual([referenced]);
      // state_copy payload dir for the collected artifact is gone.
      expect(existsSync(path.join(r.stateDir, "artifacts", plain))).toBe(false);
      expect(existsSync(path.join(r.stateDir, "artifacts", referenced))).toBe(true);
      // Referenced artifact still requires --force on delete.
      const del = await runCli(["delete", referenced], r.env);
      expect(del.error?.kind).toBe("warning");
    } finally {
      await r.close();
    }
  });

  t("gc never deletes path_ref external files", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "external.bin", TEXT);
      const reg = expectOk(
        await runCli(["register", "--path", src, "--storage", "path_ref"], r.env),
      );
      const id = String(artifactOf(reg).artifact_id);
      const future = new Date(Date.now() + 60_000).toISOString();
      const res = expectOk(await runCli(["gc", "--older-than", future], r.env));
      const totals = res.totals as Record<string, unknown>;
      expect(totals.deleted).toBe(1);
      expect(existsSync(src)).toBe(true);
      const list = expectOk(await runCli(["list"], r.env));
      expect((list.artifacts as unknown[]).length).toBe(0);
      void id;
    } finally {
      await r.close();
    }
  });

  t("gc keeps non-expired artifacts and needs no herdr session", async () => {
    const r = await rig();
    try {
      await registerText(r);
      const past = new Date(Date.now() - 60_000).toISOString();
      // Point the socket at nothing: gc must not touch the session.
      const env = { ...r.env, HERDR_SOCKET_PATH: path.join(r.stateDir, "gone.sock") };
      const res = expectOk(await runCli(["gc", "--older-than", past], env));
      const totals = res.totals as Record<string, unknown>;
      expect(totals.kept).toBe(1);
      expect(totals.deleted).toBe(0);
      const list = expectOk(await runCli(["list"], r.env));
      expect((list.artifacts as unknown[]).length).toBe(1);
    } finally {
      await r.close();
    }
  });

  t("gc requires --older-than and rejects invalid timestamps", async () => {
    const r = await rig();
    try {
      expectUsage(await runCli(["gc"], r.env));
      expectUsage(await runCli(["gc", "--older-than", "not-a-date"], r.env));
      expectUsage(await runCli(["gc", "--older-than", new Date().toISOString(), "extra"], r.env));
    } finally {
      await r.close();
    }
  });
});

describe("artifacts export (T4 #143)", () => {
  t("export emits the complete annotated index with filters echoed", async () => {
    const r = await rig();
    try {
      const id1 = await registerHtml(r);
      const id2 = await registerText(r, ["--kind", "file"]);
      const res = expectOk(await runCli(["export"], r.env));
      expect(res.command).toBe("export");
      const artifacts = res.artifacts as Record<string, unknown>[];
      expect(artifacts.map((a) => a.artifact_id).sort()).toEqual([id1, id2].sort());
      expect(res.total).toBe(2);
      expect(res.returned).toBe(2);
      expect(res.complete).toBe(true);
      // Same read annotations as list/get.
      expect(artifacts[0]?.missing_ref).toBe(false);

      const filtered = expectOk(await runCli(["export", "--kind", "file"], r.env));
      const fArtifacts = filtered.artifacts as Record<string, unknown>[];
      expect(fArtifacts).toHaveLength(1);
      expect(fArtifacts[0]?.artifact_id).toBe(id2);
      expect((filtered.filters as Record<string, unknown>).kind).toBe("file");
    } finally {
      await r.close();
    }
  });

  t("export --limit truncates honestly (complete:false)", async () => {
    const r = await rig();
    try {
      await registerText(r);
      await registerText(r);
      const res = expectOk(await runCli(["export", "--limit", "1"], r.env));
      expect(res.returned).toBe(1);
      expect(res.total).toBe(2);
      expect(res.complete).toBe(false);
    } finally {
      await r.close();
    }
  });
});
