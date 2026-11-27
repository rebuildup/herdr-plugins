import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ARTIFACT_ID_PATTERN, MAX_BYTES } from "../plugins/artifacts/src/model";
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
  const dir = mkdtempSync(path.join(tmpdir(), "artifacts-t3-test-"));
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

/** Same minimal fake herdr socket as tests/artifacts-registry.test.ts. */
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
    server.listen(herdrSocketEndpoint(socketPath), () => resolveListen());
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

function artifactOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.artifact as Record<string, unknown>;
}

function artifactsOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  return payload.artifacts as Record<string, unknown>[];
}

function resultsOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  return payload.results as Record<string, unknown>[];
}

const HTML = "<!doctype html><html><body>hello</body></html>";
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

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

function stateJsonPath(stateDir: string): string {
  return path.join(stateDir, "state.json");
}

const t = (name: string, fn: () => void | Promise<void>) => test(name, fn, 30_000);

describe("artifacts kind validation (T3 #142)", () => {
  t("html requires document-start bytes, not just an <html> substring", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      // Doctype/html tag appears mid-document: upstream HTML_DOCUMENT_START
      // is anchored, so this must NOT sniff as text/html.
      const src = writeSource(
        srcDir,
        "page.html",
        "<!-- banner --><html><body>late html</body></html>",
      );
      const result = await runCli(["register", "--path", src], r.env);
      expect(result.status).toBe(1);
      expect(result.error?.kind).toBe("invalid");
    } finally {
      await r.close();
    }
  });

  t("html path sources must keep a .html/.htm name (invalid_html)", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const disguised = writeSource(srcDir, "notes.txt", HTML);
      const inferred = await runCli(["register", "--path", disguised], r.env);
      expect(inferred.status).toBe(1);
      expect(inferred.error?.kind).toBe("invalid");
      const stderr = JSON.parse(inferred.stderr) as { error?: { message?: string } };
      expect(stderr.error?.message ?? "").toContain(".html/.htm");

      const forced = await runCli(["register", "--path", disguised, "--kind", "html"], r.env);
      expect(forced.status).toBe(1);
      expect(forced.error?.kind).toBe("invalid");

      // stdin html has no filename to check — accepted (upstream "pass html").
      const viaStdin = expectOk(
        await runCli(["register", "--stdin", "--kind", "html"], r.env, HTML),
      );
      const artifact = artifactOf(viaStdin);
      expect(artifact.kind).toBe("html");
      const meta = artifact.meta as Record<string, unknown>;
      const render = meta.render as Record<string, unknown>;
      expect(render.isolation).toBe("required");
      expect(render.policy).toBe("client");
    } finally {
      await r.close();
    }
  });

  t("html record carries meta.render; non-html records do not", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const page = writeSource(srcDir, "ok.html", HTML);
      const note = writeSource(srcDir, "note.txt", "plain text");
      const htmlArt = artifactOf(expectOk(await runCli(["register", "--path", page], r.env)));
      expect((htmlArt.meta as Record<string, unknown>).render).toBeDefined();
      const fileArt = artifactOf(
        expectOk(await runCli(["register", "--path", note, "--kind", "file"], r.env)),
      );
      expect(fileArt.meta).toBeUndefined();
    } finally {
      await r.close();
    }
  });

  t("image kind warns on extension/sniff mismatch instead of refusing", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      // .png name but JPEG leading bytes: kind=image is fine, but the
      // extension implies image/png while the sniff says image/jpeg.
      const src = writeSource(srcDir, "photo.png", JPEG_HEAD);
      const reg = expectOk(await runCli(["register", "--path", src], r.env));
      const artifact = artifactOf(reg);
      expect(artifact.kind).toBe("image");
      expect(artifact.mime).toBe("image/jpeg");
      expect(artifact.warnings).toContain("extension_mime_mismatch");
    } finally {
      await r.close();
    }
  });

  t("pdf kind warns mime_mismatch on non-pdf concrete sniff", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "doc.pdf", "not a pdf at all, just text");
      const reg = expectOk(await runCli(["register", "--path", src, "--kind", "pdf"], r.env));
      const artifact = artifactOf(reg);
      // text/plain is generic — no concrete mismatch to report.
      expect(artifact.warnings ?? []).not.toContain("mime_mismatch");

      const pngAsPdf = writeSource(srcDir, "scan.pdf", JPEG_HEAD);
      const reg2 = expectOk(await runCli(["register", "--path", pngAsPdf, "--kind", "pdf"], r.env));
      const artifact2 = artifactOf(reg2);
      expect(artifact2.warnings).toContain("mime_mismatch");
      expect(artifact2.warnings).toContain("extension_mime_mismatch");
    } finally {
      await r.close();
    }
  });
});

describe("artifacts verify (T3 #142)", () => {
  t("verify reports ok for a consistent state_copy artifact", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "page.html", HTML);
      const reg = expectOk(await runCli(["register", "--path", src], r.env));
      const id = String(artifactOf(reg).artifact_id);

      const v = expectOk(await runCli(["verify", id], r.env));
      const results = resultsOf(v);
      expect(results).toHaveLength(1);
      const result = results[0] as Record<string, unknown>;
      expect(result.artifact_id).toBe(id);
      expect(result.status).toBe("ok");
      expect(result.issues).toEqual([]);
      const checks = result.checks as Record<string, unknown>;
      expect(checks.payload_exists).toBe(true);
      expect(checks.sha256_match).toBe(true);
      expect(checks.size_match).toBe(true);
      expect(checks.mime_match).toBe(true);
      expect(v.summary).toEqual({ total: 1, ok: 1, corrupt: 0, missing: 0 });
    } finally {
      await r.close();
    }
  });

  t("verify reports corrupt on payload tampering and missing on removal", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "data.txt", "original content");
      const reg = expectOk(await runCli(["register", "--path", src, "--kind", "file"], r.env));
      const artifact = artifactOf(reg);
      const id = String(artifact.artifact_id);
      const payloadPath = String((artifact.storage as Record<string, unknown>).resolved_path);

      // Tamper: same length, different bytes → sha256_mismatch only.
      writeFileSync(payloadPath, "tampered content");
      const corrupt = expectOk(await runCli(["verify", id], r.env));
      const corruptResult = resultsOf(corrupt)[0] as Record<string, unknown>;
      expect(corruptResult.status).toBe("corrupt");
      expect(corruptResult.issues).toContain("sha256_mismatch");
      expect((corruptResult.checks as Record<string, unknown>).size_match).toBe(true);

      // Remove: payload gone → missing, never reported as ok.
      rmSync(payloadPath);
      const missing = expectOk(await runCli(["verify", id], r.env));
      const missingResult = resultsOf(missing)[0] as Record<string, unknown>;
      expect(missingResult.status).toBe("missing");
      expect(missingResult.issues).toContain("storage_ref_missing");
      expect((missingResult.checks as Record<string, unknown>).payload_exists).toBe(false);
    } finally {
      await r.close();
    }
  });

  t("verify re-checks path_ref drift honestly", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "live.txt", "version one");
      const reg = expectOk(
        await runCli(["register", "--path", src, "--kind", "file", "--storage", "path_ref"], r.env),
      );
      const id = String(artifactOf(reg).artifact_id);

      const ok = expectOk(await runCli(["verify", id], r.env));
      expect((resultsOf(ok)[0] as Record<string, unknown>).status).toBe("ok");

      writeFileSync(src, "version two — changed");
      const drift = expectOk(await runCli(["verify", id], r.env));
      const driftResult = resultsOf(drift)[0] as Record<string, unknown>;
      expect(driftResult.status).toBe("corrupt");
      expect(driftResult.issues).toContain("sha256_mismatch");
      expect(driftResult.issues).toContain("size_mismatch");
    } finally {
      await r.close();
    }
  });

  t("verify flags oversize_flag_inconsistent when a path_ref shrinks", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const big = path.join(srcDir, "huge.bin");
      writeFileSync(big, Buffer.alloc(MAX_BYTES.file + 1, 7));
      const reg = expectOk(
        await runCli(["register", "--path", big, "--kind", "file", "--storage", "path_ref"], r.env),
      );
      const artifact = artifactOf(reg);
      const id = String(artifact.artifact_id);
      expect(artifact.oversize).toBe(true);

      // Shrink below the cap: oversize flag and recorded size are both stale.
      writeFileSync(big, "small now");
      const v = expectOk(await runCli(["verify", id], r.env));
      const result = resultsOf(v)[0] as Record<string, unknown>;
      expect(result.status).toBe("corrupt");
      expect(result.issues).toContain("oversize_flag_inconsistent");
      expect(result.issues).toContain("size_mismatch");
      expect(result.issues).toContain("sha256_mismatch");
    } finally {
      await r.close();
    }
  });

  t("verify flags storage_ref_invalid on index/payload layout mismatch", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "ok.txt", "fine");
      const reg = expectOk(await runCli(["register", "--path", src, "--kind", "file"], r.env));
      const id = String(artifactOf(reg).artifact_id);

      // Corrupt the index record's resolved_path (metadata inconsistency).
      const statePath = stateJsonPath(r.stateDir);
      const state = JSON.parse(readFileSync(statePath, "utf8")) as {
        artifacts: Record<string, { storage: { resolved_path: string } }>;
      };
      const record = state.artifacts[id];
      expect(record).toBeDefined();
      if (record !== undefined) record.storage.resolved_path = "/tmp/elsewhere.bin";
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

      const v = expectOk(await runCli(["verify", id], r.env));
      const result = resultsOf(v)[0] as Record<string, unknown>;
      expect(result.status).toBe("corrupt");
      expect(result.issues).toContain("storage_ref_invalid");
      // The artifact record itself still parses and annotates.
      expect((result.artifact as Record<string, unknown>).artifact_id).toBe(id);
    } finally {
      await r.close();
    }
  });

  t("verify all summarizes mixed states; unknown id is not_found", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const good = writeSource(srcDir, "good.txt", "good");
      const bad = writeSource(srcDir, "bad.txt", "bad");
      expectOk(await runCli(["register", "--path", good, "--kind", "file"], r.env));
      const regBad = expectOk(await runCli(["register", "--path", bad, "--kind", "file"], r.env));
      const badId = String(artifactOf(regBad).artifact_id);
      const badPayload = String(
        (artifactOf(regBad).storage as Record<string, unknown>).resolved_path,
      );
      rmSync(badPayload);

      const all = expectOk(await runCli(["verify"], r.env));
      expect(all.summary).toEqual({ total: 2, ok: 1, corrupt: 0, missing: 1 });
      const statuses = resultsOf(all)
        .map((x) => x.status)
        .sort();
      expect(statuses).toEqual(["missing", "ok"]);
      expect(all.orphans).toEqual([]);
      expect(all.corrupt).toEqual([]);

      const badIdCheck = await runCli(["verify", "art-doesnotexist"], r.env);
      expectErr(badIdCheck, "not_found");
      const malformed = await runCli(["verify", "../escape"], r.env);
      expectErr(malformed, "not_found");
      expect(String(badId)).toMatch(ARTIFACT_ID_PATTERN);
    } finally {
      await r.close();
    }
  });

  t("verify is a registry command: unreachable session fails honestly", async () => {
    const stateDir = tempDir();
    const env = {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONFIG_DIR: path.join(stateDir, "config"),
      HERDR_SOCKET_PATH: path.join(stateDir, "nonexistent.sock"),
    };
    const result = await runCli(["verify"], env);
    expect(result.status).toBe(1);
    expect(result.error?.kind).toBe("session_unreachable");
  });
});

describe("artifacts search filters (T3 #142)", () => {
  t("search filters by owner agent_session, created_by, and period bounds", async () => {
    const r = await rig({
      panes: [{ pane_id: "pane-a" }, { pane_id: "pane-b" }],
      agents: {
        "pane-a": { agent_session: { value: "sess-alpha" } },
        "pane-b": { agent_session: { value: "sess-beta" } },
      },
    });
    try {
      const srcDir = tempDir();
      const a = writeSource(srcDir, "a.txt", "alpha artifact");
      const b = writeSource(srcDir, "b.txt", "beta artifact");
      const c = writeSource(srcDir, "c.txt", "cli artifact");
      expectOk(
        await runCli(
          [
            "register",
            "--path",
            a,
            "--kind",
            "file",
            "--pane",
            "pane-a",
            "--title",
            "quarterly sync",
          ],
          r.env,
        ),
      );
      expectOk(
        await runCli(
          [
            "register",
            "--path",
            b,
            "--kind",
            "file",
            "--pane",
            "pane-b",
            "--title",
            "quarterly sync",
          ],
          r.env,
        ),
      );
      expectOk(
        await runCli(
          ["register", "--path", c, "--kind", "file", "--title", "quarterly sync"],
          r.env,
        ),
      );

      // Owner scope: --agent matches owner.agent_session exactly.
      const byAgent = expectOk(
        await runCli(["search", "quarterly", "--agent", "sess-alpha"], r.env),
      );
      const agentIds = artifactsOf(byAgent).map(
        (x) => (x.owner as Record<string, unknown>).agent_session,
      );
      expect(agentIds).toEqual(["sess-alpha"]);

      const byCreatedBy = expectOk(
        await runCli(["search", "quarterly", "--created-by", "cli"], r.env),
      );
      expect(artifactsOf(byCreatedBy)).toHaveLength(1);
      expect(
        ((artifactsOf(byCreatedBy)[0]?.owner ?? {}) as Record<string, unknown>).created_by,
      ).toBe("cli");

      // Period: since in the future excludes everything; until in the
      // past excludes everything; a wide window keeps all.
      const future = expectOk(
        await runCli(["search", "quarterly", "--since", "2999-01-01T00:00:00Z"], r.env),
      );
      expect(artifactsOf(future)).toHaveLength(0);
      const past = expectOk(
        await runCli(["search", "quarterly", "--until", "2000-01-01T00:00:00Z"], r.env),
      );
      expect(artifactsOf(past)).toHaveLength(0);
      const window = expectOk(
        await runCli(
          [
            "search",
            "quarterly",
            "--since",
            "2000-01-01T00:00:00Z",
            "--until",
            "2999-01-01T00:00:00Z",
          ],
          r.env,
        ),
      );
      expect(artifactsOf(window)).toHaveLength(3);

      // list shares the owner filters.
      const listed = expectOk(await runCli(["list", "--agent", "sess-beta"], r.env));
      expect(artifactsOf(listed)).toHaveLength(1);
      expect(((artifactsOf(listed)[0]?.owner ?? {}) as Record<string, unknown>).agent_session).toBe(
        "sess-beta",
      );
    } finally {
      await r.close();
    }
  });

  t("search boundary: unknown kind and invalid timestamps are usage errors", async () => {
    const r = await rig();
    try {
      for (const args of [
        ["search", "q", "--kind", "bogus"],
        ["list", "--kind", "bogus"],
        ["search", "q", "--since", "not-a-date"],
        ["search", "q", "--until", "yesterday"],
        ["search", "q", "--created-by", "bogus"],
      ]) {
        const result = await runCli(args, r.env);
        expect(result.status).toBe(2);
        expect(result.error?.code).toBe("usage");
      }
    } finally {
      await r.close();
    }
  });

  t("free-text search covers filename, owner, and refs metadata", async () => {
    const r = await rig();
    try {
      const srcDir = tempDir();
      const src = writeSource(srcDir, "quarterly-report.txt", "numbers");
      expectOk(
        await runCli(
          [
            "register",
            "--path",
            src,
            "--kind",
            "file",
            "--pane",
            "pane-1",
            "--ref",
            "conversations:evt-42",
          ],
          r.env,
        ),
      );
      // Filename fragment.
      const byName = expectOk(await runCli(["search", "quarterly-report"], r.env));
      expect(artifactsOf(byName)).toHaveLength(1);
      // Back-reference (conversation event linkage, T1 ADR model).
      const byRef = expectOk(await runCli(["search", "evt-42"], r.env));
      expect(artifactsOf(byRef)).toHaveLength(1);
      // Owner pane id.
      const byPane = expectOk(await runCli(["search", "pane-1"], r.env));
      expect(artifactsOf(byPane)).toHaveLength(1);
      // No content scan: payload text is not searchable.
      const byContent = expectOk(await runCli(["search", "numbers"], r.env));
      expect(artifactsOf(byContent)).toHaveLength(0);
    } finally {
      await r.close();
    }
  });
});
