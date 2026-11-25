/**
 * HTTP quota hub source for rebuildup.usage (Issue #92 / parent #28 T3).
 *
 * CLIProxyAPI-equivalent integration: a user-configured hub exposes the
 * CLIProxyAPI management API (`GET /v0/management/auth-files`,
 * `POST /v0/management/api-call`). The hub holds provider credentials;
 * this plugin only holds the hub *management key* (ADR-0015) and asks
 * the hub to call each account's provider quota endpoint with the
 * `$TOKEN$` placeholder — real provider tokens never reach this
 * process.
 *
 * Boundary rules (ADR-0015, extending ADR-0014):
 * - The management key comes from an env var named by config
 *   (`keyEnv`); it is sent only as `Authorization: Bearer` to the
 *   configured hub origin. It is never logged, persisted, cached,
 *   emitted, or placed in error details.
 * - Hub responses are treated as untrusted: only whitelisted fields
 *   (account id/provider, quota windows, plan labels) reach the output;
 *   error details carry HTTP status or transport summaries only.
 * - Successful readings cache quota numbers under the plugin state dir
 *   (`quota-cache/hub-<id>.json`) for the shared TTL; stale cache is
 *   served flagged when the hub cannot be reached. Cache holds no
 *   credential material.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/index";
import type { HubAccountResult, QuotaHubConfig, QuotaHubResult, QuotaWindow } from "./model";
import {
  asRecord,
  claudeUsageToWindows,
  codexResetCreditsAvailable,
  codexUsageToWindows,
  decodeJwtClaims,
  type FetchImpl,
  fetchJson,
} from "./quota";

const PLUGIN_ID = "rebuildup.usage";

/** Env var consulted when a hub config does not name `keyEnv`. */
export const DEFAULT_HUB_KEY_ENV = "HERDR_USAGE_QUOTA_HUB_KEY";

const CLAUDE_QUOTA_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

// --- endpoint handling ---------------------------------------------------------

/**
 * Normalize a user-supplied hub URL to a base ending in "/" (the
 * CLIProxyAPI convention: users often paste the panel URL ending in
 * `management.html`). Returns null for non-http(s) or unparseable
 * input. The result carries no credentials — query/hash are dropped.
 */
export function hubBaseUrl(raw: string): { base: string; endpoint: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.pathname = url.pathname.replace(/(\/management\.html)?\/?$/i, "/");
  url.search = "";
  url.hash = "";
  const endpoint = `${url.origin}${url.pathname}`;
  return { base: url.toString(), endpoint };
}

function managementUrl(base: string, path_: string): string {
  return new URL(`v0/management/${path_}`, base).toString();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// --- provider specs --------------------------------------------------------------

interface HubProviderSpec {
  /** auth-files `provider` value this spec answers. */
  provider: string;
  usageUrl: string;
  /** Second upstream GET (codex reset credits); best-effort. */
  creditsUrl?: string;
  headers: (account: Record<string, unknown>) => Record<string, string>;
  /** Fallback plan label when the upstream body does not report one. */
  planFallback: string | null;
  map: (body: unknown) => { windows: QuotaWindow[]; plan: string | null };
}

function codexHeaders(account: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {
    // The hub substitutes the account's real token for this placeholder.
    authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "OpenAI-Beta": "codex-1",
    Originator: "Codex Desktop",
  };
  const idToken = asRecord(account.id_token);
  // Whitelisted claim only — the token itself is never read.
  const accountId =
    typeof idToken?.chatgpt_account_id === "string" ? idToken.chatgpt_account_id : "";
  // auth-files carries parsed claims on some hub versions; fall back to
  // decoding the JWT payload (unverified, claims only).
  const claims =
    accountId !== ""
      ? { chatgpt_account_id: accountId }
      : decodeJwtClaims(typeof idToken?.raw === "string" ? (idToken.raw as string) : "");
  const resolved =
    typeof claims?.chatgpt_account_id === "string" ? claims.chatgpt_account_id.trim() : "";
  if (resolved !== "") headers["Chatgpt-Account-Id"] = resolved;
  return headers;
}

const HUB_PROVIDERS: readonly HubProviderSpec[] = [
  {
    provider: "claude",
    usageUrl: CLAUDE_QUOTA_URL,
    headers: () => ({
      authorization: "Bearer $TOKEN$",
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.0 (external, cli)",
    }),
    planFallback: "Claude Subscription",
    map: claudeUsageToWindows,
  },
  {
    provider: "codex",
    usageUrl: CODEX_USAGE_URL,
    creditsUrl: CODEX_CREDITS_URL,
    headers: codexHeaders,
    planFallback: null,
    map: codexUsageToWindows,
  },
];

function specFor(provider: string): HubProviderSpec | null {
  return HUB_PROVIDERS.find((s) => s.provider === provider) ?? null;
}

// --- hub cache -------------------------------------------------------------------

interface HubCachePayload {
  checked_at: string;
  accounts: {
    account: string;
    provider: string;
    plan: string | null;
    windows: QuotaWindow[];
    reset_credits_available: number | null;
  }[];
}

function hubCacheFile(stateDir: string, hubId: string): string {
  return path.join(stateDir, "quota-cache", `hub-${slugify(hubId) || "hub"}.json`);
}

async function readHubCache(
  stateDir: string,
  hubId: string,
): Promise<{ payload: HubCachePayload; ageSeconds: number } | null> {
  try {
    const raw = await readFile(hubCacheFile(stateDir, hubId), "utf8");
    const parsed = asRecord(JSON.parse(raw));
    if (parsed === null) return null;
    const checkedAt = typeof parsed.checked_at === "string" ? parsed.checked_at : null;
    if (checkedAt === null || !Array.isArray(parsed.accounts)) return null;
    const ageMs = Date.now() - Date.parse(checkedAt);
    if (!Number.isFinite(ageMs) || ageMs < 0) return null;
    return {
      payload: {
        checked_at: checkedAt,
        accounts: (parsed.accounts as Record<string, unknown>[]).flatMap((a) => {
          if (typeof a.account !== "string" || typeof a.provider !== "string") return [];
          return [
            {
              account: a.account,
              provider: a.provider,
              plan: typeof a.plan === "string" ? a.plan : null,
              windows: Array.isArray(a.windows) ? (a.windows as QuotaWindow[]) : [],
              reset_credits_available:
                typeof a.reset_credits_available === "number" ? a.reset_credits_available : null,
            },
          ];
        }),
      },
      ageSeconds: Math.floor(ageMs / 1000),
    };
  } catch {
    return null;
  }
}

async function writeHubCache(
  stateDir: string,
  hubId: string,
  payload: HubCachePayload,
): Promise<void> {
  try {
    const dir = path.join(stateDir, "quota-cache");
    await mkdir(dir, { recursive: true });
    const file = hubCacheFile(stateDir, hubId);
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(tmp, file);
  } catch {
    /* cache is best-effort; a write failure must not fail the report */
  }
}

// --- api-call ---------------------------------------------------------------------

interface ApiCallOutcome {
  ok: boolean;
  /** Upstream HTTP status when the hub relayed one; null on transport failure. */
  statusCode: number | null;
  /** Parsed upstream JSON body (the `body` string field, JSON-decoded). */
  body: unknown;
  /** Sanitized failure detail — never contains keys, tokens, or bodies. */
  detail: string | null;
}

/**
 * `POST /v0/management/api-call` — ask the hub to call `url` as the
 * account, with `header` (the `$TOKEN$` placeholder is substituted
 * hub-side). Response envelope: `{status_code, body}` where `body` is
 * a JSON-encoded string.
 */
async function hubApiCall(
  base: string,
  key: string,
  authIndex: string,
  url: string,
  header: Record<string, string>,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<ApiCallOutcome> {
  const res = await fetchJson(
    managementUrl(base, "api-call"),
    {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    timeoutMs,
    fetchImpl,
    {
      method: "POST",
      body: JSON.stringify({ auth_index: authIndex, method: "GET", url, header }),
    },
  );
  if (!res.ok) {
    return {
      ok: false,
      statusCode: res.status,
      body: null,
      detail: res.detail ?? "request failed",
    };
  }
  const envelope = asRecord(res.json);
  const statusCode = typeof envelope?.status_code === "number" ? envelope.status_code : null;
  const bodyRaw = typeof envelope?.body === "string" ? envelope.body : null;
  if (statusCode === null || bodyRaw === null) {
    return {
      ok: false,
      statusCode: null,
      body: null,
      detail: "api-call response was not the expected shape",
    };
  }
  if (statusCode < 200 || statusCode >= 300) {
    return {
      ok: false,
      statusCode,
      body: null,
      detail: `provider refused the hub request (HTTP ${statusCode})`,
    };
  }
  try {
    return { ok: true, statusCode, body: JSON.parse(bodyRaw) as unknown, detail: null };
  } catch {
    return {
      ok: false,
      statusCode,
      body: null,
      detail: "provider response body was not JSON",
    };
  }
}

// --- per-account probe --------------------------------------------------------------

async function readHubAccount(
  base: string,
  key: string,
  account: Record<string, unknown>,
  spec: HubProviderSpec,
  timeoutMs: number,
  fetchImpl: FetchImpl,
  nowMs: number,
): Promise<Omit<HubAccountResult, "account" | "provider"> & { windows: QuotaWindow[] }> {
  const fail = (detail: string) => ({
    status: "request_failed" as const,
    detail,
    plan: null,
    windows: [] as QuotaWindow[],
    checked_at: null,
    reset_credits_available: null,
  });
  const authIndex = typeof account.auth_index === "string" ? account.auth_index : "";
  if (authIndex === "") return fail("auth file has no auth_index");

  const call = await hubApiCall(
    base,
    key,
    authIndex,
    spec.usageUrl,
    spec.headers(account),
    timeoutMs,
    fetchImpl,
  );
  if (!call.ok) return fail(call.detail ?? "request failed");

  const mapped = spec.map(call.body);
  if (mapped.windows.length === 0) {
    return fail("provider reported no usage windows");
  }
  let credits: number | null = null;
  if (spec.creditsUrl !== undefined) {
    const creditCall = await hubApiCall(
      base,
      key,
      authIndex,
      spec.creditsUrl,
      spec.headers(account),
      timeoutMs,
      fetchImpl,
    );
    if (creditCall.ok) credits = codexResetCreditsAvailable(creditCall.body, nowMs);
  }
  return {
    status: "ok",
    detail: null,
    plan: mapped.plan ?? spec.planFallback,
    windows: mapped.windows,
    checked_at: new Date(nowMs).toISOString(),
    reset_credits_available: credits,
  };
}

// --- hub probe -----------------------------------------------------------------------

export interface HubOptions {
  hubs?: QuotaHubConfig[] | undefined;
  /** Bypass the fresh-cache read (still writes on success). */
  refresh?: boolean | undefined;
  timeoutMs?: number | undefined;
  stateDir?: string | undefined;
  cacheTtlSeconds?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fetchImpl?: FetchImpl | undefined;
  now?: (() => number) | undefined;
}

function baseHubResult(
  config: QuotaHubConfig,
  endpoint: string | null,
  fetchedAt: string,
  ttl: number,
): QuotaHubResult {
  return {
    id: config.id,
    kind: "cliproxy-api",
    endpoint,
    status: "request_failed",
    detail: null,
    checked_at: null,
    fetched_at: fetchedAt,
    stale: false,
    stale_reason: null,
    cache: { hit: false, age_seconds: null, ttl_seconds: ttl },
    accounts: [],
  };
}

function cachedHubResult(
  config: QuotaHubConfig,
  endpoint: string | null,
  fetchedAt: string,
  ttl: number,
  cache: { payload: HubCachePayload; ageSeconds: number },
  stale: boolean,
  staleReason: string | null,
): QuotaHubResult {
  return {
    id: config.id,
    kind: "cliproxy-api",
    endpoint,
    status: "ok",
    detail: null,
    checked_at: cache.payload.checked_at,
    fetched_at: fetchedAt,
    stale,
    stale_reason: staleReason,
    cache: { hit: true, age_seconds: cache.ageSeconds, ttl_seconds: ttl },
    accounts: cache.payload.accounts.map((a) => ({
      account: a.account,
      provider: a.provider,
      status: "ok" as const,
      detail: null,
      plan: a.plan,
      windows: a.windows,
      checked_at: cache.payload.checked_at,
      reset_credits_available: a.reset_credits_available,
    })),
  };
}

async function quotaForHub(
  config: QuotaHubConfig,
  options: HubOptions,
  stateDir: string,
  ttl: number,
  timeoutMs: number,
  fetchImpl: FetchImpl,
  env: NodeJS.ProcessEnv,
): Promise<QuotaHubResult> {
  const now = options.now ?? (() => Date.now());
  const nowMs = now();
  const fetchedAt = new Date(nowMs).toISOString();

  const normalized = hubBaseUrl(config.url);
  const endpoint = normalized?.endpoint ?? null;
  const result = baseHubResult(config, endpoint, fetchedAt, ttl);
  if (normalized === null) {
    return { ...result, detail: "hub URL is not a valid http(s) URL" };
  }
  const { base } = normalized;

  const keyEnv = config.keyEnv ?? DEFAULT_HUB_KEY_ENV;
  const key = env[keyEnv]?.trim() ?? "";
  if (key === "") {
    return {
      ...result,
      status: "no_credential",
      detail: `hub management key env ${keyEnv} is not set`,
    };
  }

  const cached = await readHubCache(stateDir, config.id);
  const fresh = cached !== null && cached.ageSeconds < ttl;
  if (options.refresh !== true && fresh && cached !== null) {
    return cachedHubResult(config, endpoint, fetchedAt, ttl, cached, false, null);
  }

  const authFiles = await fetchJson(
    managementUrl(base, "auth-files"),
    { authorization: `Bearer ${key}` },
    timeoutMs,
    fetchImpl,
  );
  const failWithCache = async (
    status: "unauthorized" | "request_failed",
    detail: string,
  ): Promise<QuotaHubResult> => {
    if (cached !== null) {
      return cachedHubResult(
        config,
        endpoint,
        fetchedAt,
        ttl,
        cached,
        true,
        `hub request failed (${detail}); serving cached reading`,
      );
    }
    return { ...result, status, detail };
  };

  if (!authFiles.ok) {
    if (authFiles.status === 401 || authFiles.status === 403) {
      return failWithCache(
        "unauthorized",
        `hub rejected the management key (HTTP ${authFiles.status})`,
      );
    }
    return failWithCache("request_failed", authFiles.detail ?? "request failed");
  }
  const filesRaw = asRecord(authFiles.json)?.files;
  if (!Array.isArray(filesRaw)) {
    return failWithCache("request_failed", "auth-files response was not the expected shape");
  }

  const accounts: HubAccountResult[] = [];
  const cacheAccounts: HubCachePayload["accounts"] = [];
  for (const entry of filesRaw) {
    const account = asRecord(entry);
    if (account === null || account.disabled === true) continue;
    const accountId = typeof account.id === "string" ? account.id : "";
    const provider = typeof account.provider === "string" ? account.provider : "";
    if (accountId === "" || provider === "") continue;
    const spec = specFor(provider);
    if (spec === null) {
      accounts.push({
        account: accountId,
        provider,
        status: "unsupported",
        detail: `hub provider "${provider}" has no quota mapper in this plugin`,
        plan: null,
        windows: [],
        checked_at: null,
        reset_credits_available: null,
      });
      continue;
    }
    const reading = await readHubAccount(base, key, account, spec, timeoutMs, fetchImpl, nowMs);
    accounts.push({
      account: accountId,
      provider,
      status: reading.status,
      detail: reading.detail,
      plan: reading.plan,
      windows: reading.windows,
      checked_at: reading.checked_at,
      reset_credits_available: reading.reset_credits_available,
    });
    // Only durable readings enter the cache: `ok` windows and stable
    // `unsupported` verdicts. Transient request_failed entries are not
    // cached — a stale serve must not resurrect a failure as fresh.
    if (reading.status === "ok") {
      cacheAccounts.push({
        account: accountId,
        provider,
        plan: reading.plan,
        windows: reading.windows,
        reset_credits_available: reading.reset_credits_available,
      });
    }
  }

  const checkedAt = new Date(nowMs).toISOString();
  await writeHubCache(stateDir, config.id, { checked_at: checkedAt, accounts: cacheAccounts });
  return {
    ...result,
    status: "ok",
    checked_at: checkedAt,
    accounts,
  };
}

/**
 * Collect quota reports for every configured hub. Never throws for
 * per-hub failures — every outcome is a structured status.
 */
export async function collectQuotaHubs(options: HubOptions = {}): Promise<QuotaHubResult[]> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const ttl = options.cacheTtlSeconds ?? 300;
  const stateDir = options.stateDir ?? pluginDirs(PLUGIN_ID).stateDir;
  const results: QuotaHubResult[] = [];
  for (const config of options.hubs ?? []) {
    if (typeof config.id !== "string" || config.id === "" || typeof config.url !== "string") {
      continue;
    }
    results.push(await quotaForHub(config, options, stateDir, ttl, timeoutMs, fetchImpl, env));
  }
  return results;
}
