import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claudeUsageToWindows,
  codexUsageToWindows,
  QUOTA_CACHE_TTL_SECONDS,
} from "../plugins/usage/src/quota";
import { testEnv } from "./helpers/test-env";

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
for (const key of [
  "HERDR_PLUGIN_STATE_DIR",
  "HERDR_PLUGIN_CONFIG_DIR",
  "HERDR_SOCKET_PATH",
  "HERDR_SESSION",
  "HERDR_PLUGIN_ROOT",
  "HERDR_USAGE_CONVERSATIONS_ROOT",
  "HERDR_USAGE_CONVERSATIONS_STATE_DIR",
  "HERDR_USAGE_CONVERSATIONS_CONFIG_DIR",
  "HERDR_USAGE_QUOTA_CLAUDE_URL",
  "HERDR_USAGE_QUOTA_CODEX_USAGE_URL",
  "HERDR_USAGE_QUOTA_CODEX_CREDITS_URL",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
]) {
  savedEnv[key] = process.env[key];
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "usage-quota-"));
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

const USAGE_CLI = path.join(__dirname, "..", "plugins", "usage", "src", "cli.ts");

// Fake credential material — must never appear in any CLI output.
const CLAUDE_TOKEN = "claude-quota-test-access-token-7f3a9c";
const CLAUDE_REFRESH = "claude-quota-test-refresh-token-DO-NOT-LEAK";
const CODEX_TOKEN = "codex-quota-test-access-token-51bd02";
const CODEX_REFRESH = "codex-quota-test-refresh-token-DO-NOT-LEAK";

function baseEnv(extra?: Record<string, string>): Record<string, string> {
  return testEnv({ HERDR_SOCKET_PATH: path.join(tempDir(), "dead.sock"), ...extra });
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

/** Async: the mock quota endpoints live in this process's event loop,
 * so a synchronous spawn would starve them and every fetch would time
 * out. */
function runQuota(args: string[], extraEnv?: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [USAGE_CLI, "quota", ...args], {
      env: baseEnv(extraEnv),
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
    child.on("close", (code) => {
      let json: Record<string, unknown> | null = null;
      let error: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        /* non-JSON */
      }
      try {
        error = (JSON.parse(stderr) as { error?: Record<string, unknown> }).error ?? null;
      } catch {
        /* empty stderr */
      }
      resolve({ status: code ?? -1, stdout, stderr, json, error });
    });
  });
}

// --- fixtures -------------------------------------------------------------------

interface MockServer {
  url: (route: string) => string;
  hits: Record<string, number>;
  lastHeaders: Record<string, http.IncomingHttpHeaders | undefined>;
  setMode: (mode: "ok" | "fail") => void;
  close: () => Promise<void>;
}

const CLAUDE_USAGE_BODY = {
  five_hour: { utilization: 42.5, resets_at: "2026-01-01T05:00:00.000Z" },
  seven_day: { utilization: 10, resets_at: "2026-01-08T00:00:00.000Z" },
  limits: [
    {
      kind: "weekly_scoped",
      percent: 55,
      resets_at: "2026-01-08T00:00:00.000Z",
      scope: { model: { display_name: "Fable" } },
    },
  ],
  extra_usage: { is_enabled: true, utilization: 3 },
};

const CODEX_USAGE_BODY = {
  plan_type: "pro",
  rate_limit: {
    primary_window: {
      used_percent: 12.5,
      reset_at: 1_767_225_600,
      limit_window_seconds: 18_000,
    },
    secondary_window: { used_percent: 30, reset_at: 1_767_657_600 },
  },
};

const CODEX_CREDITS_BODY = {
  credits: [
    {
      id: "c1",
      status: "available",
      reset_type: "codex_rate_limits",
      expires_at: "2999-01-01T00:00:00.000Z",
    },
    {
      id: "c2",
      status: "available",
      reset_type: "codex_rate_limits",
      expires_at: "2000-01-01T00:00:00.000Z",
    },
    {
      id: "c3",
      status: "redeemed",
      reset_type: "codex_rate_limits",
      expires_at: "2999-01-01T00:00:00.000Z",
    },
  ],
};

async function mockServer(): Promise<MockServer> {
  const hits: Record<string, number> = {};
  const lastHeaders: Record<string, http.IncomingHttpHeaders | undefined> = {};
  let mode: "ok" | "fail" = "ok";
  const server = http.createServer((req, res) => {
    const route = req.url ?? "/";
    hits[route] = (hits[route] ?? 0) + 1;
    lastHeaders[route] = req.headers;
    res.setHeader("content-type", "application/json");
    if (mode === "fail") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "boom" }));
      return;
    }
    if (route === "/claude-usage") res.end(JSON.stringify(CLAUDE_USAGE_BODY));
    else if (route === "/codex-usage") res.end(JSON.stringify(CODEX_USAGE_BODY));
    else if (route === "/codex-credits") res.end(JSON.stringify(CODEX_CREDITS_BODY));
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: (route: string) => `http://127.0.0.1:${port}${route}`,
    hits,
    lastHeaders,
    setMode: (m) => {
      mode = m;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface QuotaEnv {
  stateDir: string;
  claudeHome: string;
  codexHome: string;
  env: Record<string, string>;
}

function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

function writeClaudeCredentials(claudeHome: string, expiresAtMs: number): void {
  writeFileSync(
    path.join(claudeHome, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: CLAUDE_TOKEN,
        refreshToken: CLAUDE_REFRESH,
        expiresAt: expiresAtMs,
        subscriptionType: "max",
        scopes: ["user:profile"],
        rateLimitTier: "default_claude_max_20x",
      },
    }),
  );
}

function writeCodexAuth(codexHome: string, authMode = "chatgpt"): void {
  writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({
      auth_mode: authMode,
      OPENAI_API_KEY: authMode === "apikey" ? "sk-test-not-a-real-key" : null,
      tokens:
        authMode === "chatgpt"
          ? {
              id_token: jwt({
                chatgpt_account_id: "acct-test-1",
                plan_type: "pro",
                email: "someone@example.com",
              }),
              access_token: CODEX_TOKEN,
              refresh_token: CODEX_REFRESH,
            }
          : null,
      last_refresh: "2026-01-01T00:00:00Z",
    }),
  );
}

function quotaEnv(server: MockServer): QuotaEnv {
  const stateDir = tempDir();
  const claudeHome = tempDir();
  const codexHome = tempDir();
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeClaudeCredentials(claudeHome, Date.now() + 3_600_000);
  writeCodexAuth(codexHome);
  return {
    stateDir,
    claudeHome,
    codexHome,
    env: {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONFIG_DIR: path.join(stateDir, "config"),
      HOME: tempDir(),
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: codexHome,
      HERDR_USAGE_QUOTA_CLAUDE_URL: server.url("/claude-usage"),
      HERDR_USAGE_QUOTA_CODEX_USAGE_URL: server.url("/codex-usage"),
      HERDR_USAGE_QUOTA_CODEX_CREDITS_URL: server.url("/codex-credits"),
    },
  };
}

interface ProviderEntry {
  provider: string;
  status: string;
  detail: string | null;
  plan: string | null;
  windows: {
    id: string;
    kind: string;
    used_percent: number;
    resets_at: string | null;
    window_duration_mins: number | null;
  }[];
  checked_at: string | null;
  stale: boolean;
  stale_reason: string | null;
  reset_credits_available: number | null;
  cache: { hit: boolean; age_seconds: number | null; ttl_seconds: number };
}

function providersOf(json: Record<string, unknown> | null): ProviderEntry[] {
  return (json?.providers ?? []) as ProviderEntry[];
}

function expectNoSecrets(r: CliResult): void {
  const blob = `${r.stdout}\n${r.stderr}`;
  for (const secret of [
    CLAUDE_TOKEN,
    CLAUDE_REFRESH,
    CODEX_TOKEN,
    CODEX_REFRESH,
    "refreshToken",
    "refresh_token",
    "accessToken",
    "access_token",
    "someone@example.com",
  ]) {
    expect(blob).not.toContain(secret);
  }
}

const t = (name: string, fn: () => void | Promise<void>) => test(name, fn, 60_000);

// --- unit: window mappers -------------------------------------------------------

describe("quota window mappers", () => {
  t("claude usage maps five_hour/seven_day/scoped/extra_usage windows", () => {
    const { windows, plan } = claudeUsageToWindows(CLAUDE_USAGE_BODY);
    expect(plan).toBeNull(); // plan comes from the credential store
    const byId = new Map(windows.map((w) => [w.id, w]));
    expect(byId.get("five_hour")?.kind).toBe("session");
    expect(byId.get("five_hour")?.used_percent).toBe(42.5);
    expect(byId.get("five_hour")?.window_duration_mins).toBe(300);
    expect(byId.get("seven_day")?.kind).toBe("weekly");
    expect(byId.get("seven_day_fable")?.label).toBe("Weekly · Fable");
    expect(byId.get("extra_usage")?.kind).toBe("monthly");
    expect(byId.get("extra_usage")?.used_percent).toBe(3);
  });

  t("codex usage maps primary/secondary with duration-derived kinds", () => {
    const { windows, plan } = codexUsageToWindows(CODEX_USAGE_BODY);
    expect(plan).toBe("Pro");
    const byId = new Map(windows.map((w) => [w.id, w]));
    expect(byId.get("primary")?.kind).toBe("session"); // 18000s = 300min
    expect(byId.get("primary")?.used_percent).toBe(12.5);
    expect(byId.get("primary")?.resets_at).not.toBeNull();
    expect(byId.get("secondary")?.kind).toBe("weekly"); // fallback 10080
  });

  t("malformed bodies yield no windows, never fabricated values", () => {
    expect(claudeUsageToWindows(null).windows).toEqual([]);
    expect(claudeUsageToWindows({ five_hour: { utilization: "x" } }).windows).toEqual([]);
    expect(codexUsageToWindows({ rate_limit: null }).windows).toEqual([]);
    expect(codexUsageToWindows({}).plan).toBeNull();
  });
});

// --- contract: quota CLI ---------------------------------------------------------

describe("usage quota contract", () => {
  t("claude+codex quota report windows, plans, credits; no secrets leak", async () => {
    const server = await mockServer();
    try {
      const q = quotaEnv(server);
      const r = await runQuota([], q.env);
      expect(r.status).toBe(0);
      expect(r.json?.contract).toBe("herdr-plugins.usage/v1");
      expect(r.json?.command).toBe("quota");
      expectNoSecrets(r);

      const providers = providersOf(r.json);
      const claude = providers.find((p) => p.provider === "claude");
      const codex = providers.find((p) => p.provider === "codex");
      const opencode = providers.find((p) => p.provider === "opencode");

      expect(claude?.status).toBe("ok");
      expect(claude?.plan).toBe("max");
      expect(claude?.windows.find((w) => w.id === "five_hour")?.used_percent).toBe(42.5);
      expect(claude?.cache.hit).toBe(false);
      expect(claude?.checked_at).not.toBeNull();

      expect(codex?.status).toBe("ok");
      expect(codex?.plan).toBe("Pro");
      expect(codex?.windows.find((w) => w.id === "primary")?.used_percent).toBe(12.5);
      expect(codex?.reset_credits_available).toBe(1); // c1 only: c2 expired, c3 redeemed

      expect(opencode?.status).toBe("unsupported");
      expect(opencode?.windows).toEqual([]);

      // The mock saw the bearer tokens server-side (expected) — the
      // plugin output must not contain them (asserted above).
      expect(server.lastHeaders["/claude-usage"]?.authorization).toBe(`Bearer ${CLAUDE_TOKEN}`);
      const codexHeaders = server.lastHeaders["/codex-usage"];
      expect(codexHeaders?.authorization).toBe(`Bearer ${CODEX_TOKEN}`);
      expect(codexHeaders?.["chatgpt-account-id"]).toBe("acct-test-1");
      expect(codexHeaders?.["openai-beta"]).toBe("codex-1");
    } finally {
      await server.close();
    }
  });

  t("fresh cache hits skip the endpoint; --refresh refetches", async () => {
    const server = await mockServer();
    try {
      const q = quotaEnv(server);
      const first = await runQuota(["--provider", "claude"], q.env);
      expect(first.status).toBe(0);
      expect(server.hits["/claude-usage"]).toBe(1);

      const second = await runQuota(["--provider", "claude"], q.env);
      const claude = providersOf(second.json).find((p) => p.provider === "claude");
      expect(claude?.status).toBe("ok");
      expect(claude?.cache.hit).toBe(true);
      expect(claude?.cache.age_seconds).not.toBeNull();
      expect(claude?.cache.ttl_seconds).toBe(QUOTA_CACHE_TTL_SECONDS);
      expect(server.hits["/claude-usage"]).toBe(1); // no new request

      const refreshed = await runQuota(["--provider", "claude", "--refresh"], q.env);
      const rc = providersOf(refreshed.json).find((p) => p.provider === "claude");
      expect(rc?.cache.hit).toBe(false);
      expect(server.hits["/claude-usage"]).toBe(2);

      // Cache file holds quota numbers only — no credential material.
      const cacheFile = path.join(q.stateDir, "quota-cache", "claude.json");
      expect(existsSync(cacheFile)).toBe(true);
      const cacheBlob = readFileSync(cacheFile, "utf8");
      expect(cacheBlob).not.toContain(CLAUDE_TOKEN);
      expect(cacheBlob).not.toContain(CLAUDE_REFRESH);
      expect(cacheBlob).not.toContain("accessToken");
      expectNoSecrets(refreshed);
    } finally {
      await server.close();
    }
  });

  t("endpoint failure → request_failed; cached reading served stale", async () => {
    const server = await mockServer();
    try {
      const q = quotaEnv(server);
      const ok = await runQuota(["--provider", "claude"], q.env);
      expect(providersOf(ok.json).find((p) => p.provider === "claude")?.status).toBe("ok");

      server.setMode("fail");
      // Fresh state dir → no cache → honest request_failed.
      const q2 = quotaEnv(server);
      const failed = await runQuota(["--provider", "claude"], q2.env);
      const fc = providersOf(failed.json).find((p) => p.provider === "claude");
      expect(fc?.status).toBe("request_failed");
      expect(fc?.detail).toContain("HTTP 500");
      expect(fc?.windows).toEqual([]);
      expect(fc?.checked_at).toBeNull();
      expectNoSecrets(failed);

      // Original state dir has a good cache → stale serve, flagged.
      const stale = await runQuota(["--provider", "claude", "--refresh"], q.env);
      const sc = providersOf(stale.json).find((p) => p.provider === "claude");
      expect(sc?.status).toBe("ok");
      expect(sc?.stale).toBe(true);
      expect(sc?.stale_reason).toContain("fetch failed");
      expect(sc?.windows.length).toBeGreaterThan(0);
      expectNoSecrets(stale);
    } finally {
      await server.close();
    }
  });

  t("expired claude token → credential_expired without any HTTP call", async () => {
    const server = await mockServer();
    try {
      const q = quotaEnv(server);
      writeClaudeCredentials(q.claudeHome, Date.now() - 60_000);
      const r = await runQuota(["--provider", "claude"], q.env);
      const claude = providersOf(r.json).find((p) => p.provider === "claude");
      expect(claude?.status).toBe("credential_expired");
      expect(claude?.windows).toEqual([]);
      expect(claude?.detail).toContain("expired");
      expect(server.hits["/claude-usage"] ?? 0).toBe(0);
      expectNoSecrets(r);
    } finally {
      await server.close();
    }
  });

  t("missing credentials → no_credential; apikey codex → unsupported", async () => {
    const server = await mockServer();
    try {
      const stateDir = tempDir();
      const emptyClaude = tempDir();
      const emptyCodex = tempDir();
      const env = {
        HERDR_PLUGIN_STATE_DIR: stateDir,
        HERDR_PLUGIN_CONFIG_DIR: path.join(stateDir, "config"),
        HOME: tempDir(),
        CLAUDE_CONFIG_DIR: emptyClaude,
        CODEX_HOME: emptyCodex,
        HERDR_USAGE_QUOTA_CLAUDE_URL: server.url("/claude-usage"),
        HERDR_USAGE_QUOTA_CODEX_USAGE_URL: server.url("/codex-usage"),
      };
      const r = await runQuota([], env);
      expect(r.status).toBe(0);
      const providers = providersOf(r.json);
      expect(providers.find((p) => p.provider === "claude")?.status).toBe("no_credential");
      expect(providers.find((p) => p.provider === "codex")?.status).toBe("no_credential");
      expect(server.hits["/claude-usage"] ?? 0).toBe(0);
      expect(server.hits["/codex-usage"] ?? 0).toBe(0);

      // codex apikey mode → unsupported with reason
      writeCodexAuth(emptyCodex, "apikey");
      const r2 = await runQuota(["--provider", "codex"], env);
      const codex = providersOf(r2.json).find((p) => p.provider === "codex");
      expect(codex?.status).toBe("unsupported");
      expect(codex?.detail).toContain("apikey");

      // unknown provider id → unsupported, never an error
      const r3 = await runQuota(["--provider", "bogus-provider"], env);
      const bogus = providersOf(r3.json).find((p) => p.provider === "bogus-provider");
      expect(bogus?.status).toBe("unsupported");
      expectNoSecrets(r);
      expectNoSecrets(r2);
      expectNoSecrets(r3);
    } finally {
      await server.close();
    }
  });

  t("capability advertises the quota source as available", () => {
    const stateDir = tempDir();
    const r = spawnSync(process.execPath, [USAGE_CLI, "capability"], {
      encoding: "utf8",
      env: baseEnv({
        HERDR_PLUGIN_STATE_DIR: stateDir,
        HERDR_PLUGIN_CONFIG_DIR: path.join(stateDir, "config"),
      }),
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    const sources = json.sources as Record<string, unknown>[];
    const quota = sources.find((s) => s.id === "subscription-quota-api");
    expect(quota?.status).toBe("available");
    expect(quota?.credential_boundary).toContain("0014");
    expect((json.commands as string[]).includes("quota")).toBe(true);
  });
});
