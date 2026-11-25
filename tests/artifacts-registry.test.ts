import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ARTIFACT_ID_PATTERN, MAX_BYTES } from "../plugins/artifacts/src/model";

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
  const dir = mkdtempSync(path.join(tmpdir(), "artifacts-registry-test-"));
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

/**
 * Minimal fake herdr socket speaking the newline-JSON protocol: answers
 * `session.snapshot` with a fixed session name, pane list, and agent
 * map (same convention as tests/checkpoints.test.ts).
 */
async function fakeHerdrSocket(options: {
  panes?: FakePane[];
  agents?: Record<string, FakeAgent>;
  sessionName?: string;
}): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const socketPath = path.join(tempDir(), "fake-herdr.sock");
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
        const message = JSON.parse(line) as { id?: string; method?: string };
        const result = message.method === "session.snapshot" ? { snapshot } : {};
        conn.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => resolveListen());
  });
  return {
    socketPath,
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
      env: { ...process.env, ...env },
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

function artifactOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.artifact as Record<string, unknown>;
}

function artifactsOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  return payload.artifacts as Record<string, unknown>[];
}

const HTML = "<!doctype html><html><body>hello</body></html>";
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

interface Rig {
  stateDir: string;
  socketPath: string;
  env: Record<string, string>;
  close: () => Promise<void>;
}

async function rig(options?: {
  panes?: FakePane[];
  agents?: Record<string, FakeAgent>;
  sessionName?: string;
}): Promise<Rig> {
  const stateDir = tempDir();
  const fake = await fakeHerdrSocket(options ?? {});
  return {
    stateDir,
    socketPath: fake.socketPath,
    env: {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONFIG_DIR: path.join(stateDir, "config"),
      HERDR_SOCKET_PATH: fake.socketPath,
    },
    close: fake.close,
  };
}

function writeSource(dir: string, name: string, content: string | Buffer): string {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
}

const t = (name: string, fn: () => void | Promise<void>) => test(name, fn, 30_000);

describe("artifacts registry cli (T2 #141)", () => {
  t("register state_copy + get + list roundtrip", async () => {
    const r = await rig({ panes: [{ pane_id: "pane-1" }] });
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "page.html", HTML);
      const reg = expectOk(
        await runCli(["register", "--path", src, "--pane", "pane-1", "--title", "Report"], r.env),
      );
      const artifact = artifactOf(reg);
      expect(artifact.contract).toBe("herdr-plugins.artifacts/v1");
      expect(String(artifact.artifact_id)).toMatch(ARTIFACT_ID_PATTERN);
      expect(artifact.kind).toBe("html");
      expect(artifact.mime).toBe("text/html");
      expect(artifact.session).toBe("test-session");
      expect(artifact.host).toBeTruthy();
      const storage = artifact.storage as Record<string, unknown>;
      expect(storage.mode).toBe("state_copy");
      expect(String(storage.resolved_path).startsWith(r.stateDir)).toBe(true);
      expect(artifact.sha256).toBe(createHash("sha256").update(HTML).digest("hex"));
      expect(artifact.size).toBe(Buffer.byteLength(HTML));
      const owner = artifact.owner as Record<string, unknown>;
      expect(owner.pane_id).toBe("pane-1");
      // Payload bytes were copied into plugin state.
      expect(readFileSync(String(storage.resolved_path), "utf8")).toBe(HTML);

      const got = expectOk(await runCli(["get", String(artifact.artifact_id)], r.env));
      const fetched = artifactOf(got);
      expect(fetched.artifact_id).toBe(artifact.artifact_id);
      expect(fetched.missing_ref).toBe(false);
      expect(fetched.owner_stale).toBe(false);

      const list = expectOk(await runCli(["list"], r.env));
      expect(artifactsOf(list)).toHaveLength(1);
      expect(list.orphans).toEqual([]);
      expect(list.corrupt).toEqual([]);
    } finally {
      await r.close();
    }
  });

  t("register --stdin stores bytes and detects kind from mime", async () => {
    const r = await rig();
    try {
      const reg = expectOk(
        await runCli(["register", "--stdin", "--kind", "image"], r.env, PNG_HEAD),
      );
      const artifact = artifactOf(reg);
      expect(artifact.kind).toBe("image");
      expect(artifact.mime).toBe("image/png");
      expect(artifact.size).toBe(PNG_HEAD.length);
    } finally {
      await r.close();
    }
  });

  t("kind detection falls back to extension then mime", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const pdf = writeSource(srcDir, "doc.pdf", "%PDF-1.4 fake");
      const reg = expectOk(await runCli(["register", "--path", pdf], r.env));
      expect(artifactOf(reg).kind).toBe("pdf");
      expect(artifactOf(reg).mime).toBe("application/pdf");
    } finally {
      await r.close();
    }
  });

  t("html kind refuses non-HTML leading bytes (mime_mismatch)", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "fake.html", "this is not html at all");
      const result = await runCli(["register", "--path", src], r.env);
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("invalid");
      // sniffed mime is text/plain → mime_mismatch refusal for html.
      const err = JSON.parse(result.stderr) as { error?: { message?: string } };
      expect(err.error?.message ?? "").toContain("text/plain");
    } finally {
      await r.close();
    }
  });

  t("state_copy refuses oversize per-kind cap (too_large)", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const big = path.join(srcDir, "big.png");
      writeFileSync(big, Buffer.alloc(MAX_BYTES.image + 1, 1));
      const result = await runCli(["register", "--path", big, "--kind", "image"], r.env);
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("invalid");
      const stderr = JSON.parse(result.stderr) as { error?: { message?: string } };
      expect(stderr.error?.message ?? "").toContain("cap");
    } finally {
      await r.close();
    }
  });

  t("path_ref records oversize as warning and reports missing_ref after delete", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const big = path.join(srcDir, "huge.png");
      writeFileSync(big, Buffer.alloc(MAX_BYTES.image + 1, 2));
      const reg = expectOk(
        await runCli(
          ["register", "--path", big, "--kind", "image", "--storage", "path_ref"],
          r.env,
        ),
      );
      const artifact = artifactOf(reg);
      const storage = artifact.storage as Record<string, unknown>;
      expect(storage.mode).toBe("path_ref");
      expect(storage.ref).toBe(realpathSync(big));
      expect(artifact.oversize).toBe(true);
      expect(artifact.warnings).toContain("oversize");

      rmSync(big);
      const got = expectOk(await runCli(["get", String(artifact.artifact_id)], r.env));
      const fetched = artifactOf(got);
      expect(fetched.missing_ref).toBe(true);
      expect(fetched.warnings).toContain("storage_ref_missing");
    } finally {
      await r.close();
    }
  });

  t("path_ref never deletes the external file on delete", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "keep.bin", "payload");
      const reg = expectOk(
        await runCli(["register", "--path", src, "--kind", "file", "--storage", "path_ref"], r.env),
      );
      const id = String(artifactOf(reg).artifact_id);
      const del = expectOk(await runCli(["delete", id], r.env));
      expect(del.removed_payload).toBe(false);
      expect(existsSync(src)).toBe(true);
      const gone = await runCli(["get", id], r.env);
      expectErr(gone, "not_found");
    } finally {
      await r.close();
    }
  });

  t("artifact_id traversal is rejected on get/delete", async () => {
    const r = await rig();
    try {
      for (const bad of ["../escape", "art-../../etc", "art-", "plain", "art-a/b"]) {
        const got = await runCli(["get", bad], r.env);
        expectErr(got, "not_found");
        const del = await runCli(["delete", bad], r.env);
        expectErr(del, "not_found");
      }
    } finally {
      await r.close();
    }
  });

  t("delete removes state_copy payload; refs require --force", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "note.txt", "hello");
      const reg = expectOk(
        await runCli(["register", "--path", src, "--kind", "file", "--ref", "handoff:h-1"], r.env),
      );
      const artifact = artifactOf(reg);
      const id = String(artifact.artifact_id);
      const payloadPath = String((artifact.storage as Record<string, unknown>).resolved_path);
      expect(existsSync(payloadPath)).toBe(true);

      const refused = await runCli(["delete", id], r.env);
      expectErr(refused, "warning");
      expect(existsSync(payloadPath)).toBe(true);

      const forced = expectOk(await runCli(["delete", id, "--force"], r.env));
      expect(forced.removed_payload).toBe(true);
      expect(existsSync(payloadPath)).toBe(false);
      expect(existsSync(path.dirname(payloadPath))).toBe(false);
      expectErr(await runCli(["get", id], r.env), "not_found");
    } finally {
      await r.close();
    }
  });

  t("search filters by query/kind and honors --since", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const a = writeSource(srcDir, "alpha.html", HTML);
      const b = writeSource(srcDir, "beta.txt", "beta notes");
      expectOk(await runCli(["register", "--path", a, "--title", "Quarterly Report"], r.env));
      expectOk(await runCli(["register", "--path", b, "--kind", "file"], r.env));

      const byTitle = expectOk(await runCli(["search", "quarterly"], r.env));
      expect(artifactsOf(byTitle)).toHaveLength(1);
      expect(artifactsOf(byTitle)[0]?.title).toBe("Quarterly Report");

      const byKind = expectOk(await runCli(["search", "report", "--kind", "file"], r.env));
      // "report" only matches the html artifact's title; kind=file excludes it.
      expect(artifactsOf(byKind)).toHaveLength(0);

      const future = expectOk(
        await runCli(["search", "report", "--since", "2999-01-01T00:00:00Z"], r.env),
      );
      expect(artifactsOf(future)).toHaveLength(0);
    } finally {
      await r.close();
    }
  });

  t("owner fields: pane + agent_session recorded; stale pane flagged on read", async () => {
    const r = await rig({
      panes: [{ pane_id: "pane-live" }],
      agents: { "pane-ghost": { agent_session: { value: "agent-sess-9" } } },
    });
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "x.txt", "x");
      const reg = expectOk(
        await runCli(["register", "--path", src, "--kind", "file", "--pane", "pane-ghost"], r.env),
      );
      const artifact = artifactOf(reg);
      const owner = artifact.owner as Record<string, unknown>;
      expect(owner.pane_id).toBe("pane-ghost");
      expect(owner.agent_session).toBe("agent-sess-9");
      expect(owner.created_by).toBe("agent");

      const got = expectOk(await runCli(["get", String(artifact.artifact_id)], r.env));
      const fetched = artifactOf(got);
      expect(fetched.owner_stale).toBe(true);
      expect(fetched.warnings).toContain("owner_stale");
    } finally {
      await r.close();
    }
  });

  t("unreachable session fails registry commands with session_unreachable", async () => {
    const stateDir = tempDir();
    const env = {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONFIG_DIR: path.join(stateDir, "config"),
      HERDR_SOCKET_PATH: path.join(stateDir, "nonexistent.sock"),
    };
    for (const args of [
      ["list"],
      ["register", "--stdin"],
      ["get", "art-x"],
      ["delete", "art-x"],
      ["search", "q"],
    ]) {
      const result = await runCli(args, env, "data");
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("session_unreachable");
    }
    // capability/help stay socket-free.
    expect((await runCli(["capability"], env)).status).toBe(0);
  });

  t("concurrent registers serialize through the lock without corruption", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          runCli(
            [
              "register",
              "--path",
              writeSource(srcDir, `f${i}.txt`, `content ${i}`),
              "--kind",
              "file",
            ],
            r.env,
          ),
        ),
      );
      for (const result of results) expectOk(result);
      const list = expectOk(await runCli(["list", "--limit", "0"], r.env));
      expect(list.total).toBe(5);
      const ids = new Set(artifactsOf(list).map((a) => a.artifact_id));
      expect(ids.size).toBe(5);
    } finally {
      await r.close();
    }
  });

  t("state_copy payload dir is traversal-safe (id pattern enforced in state layer)", async () => {
    // artifactDir rejects non-pattern ids; the CLI already rejects them,
    // this pins the defense-in-depth guard.
    const { artifactDir } = await import("../plugins/artifacts/src/state");
    const prev = process.env.HERDR_PLUGIN_STATE_DIR;
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir();
    try {
      expect(() => artifactDir("../evil")).toThrow();
      expect(artifactDir("art-abc_123")).toContain(path.join("artifacts", "art-abc_123"));
    } finally {
      if (prev === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
      else process.env.HERDR_PLUGIN_STATE_DIR = prev;
    }
  });
});
