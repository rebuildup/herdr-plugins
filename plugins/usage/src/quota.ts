/**
 * Subscription quota/reset probing for rebuildup.usage (Issue #91 /
 * parent #28 T2, credential boundary ADR-0014).
 *
 * Reads provider-owned credential artifacts *only* to authenticate
 * read-only quota endpoints, and reports usage windows + reset instants.
 * Credential values never leave the fetch closure: they are not logged,
 * not persisted, not cached, and never appear in output or errors
 * (ADR-0014). Successful readings are cached under the plugin state
 * dir for a short TTL; stale cache is served — explicitly flagged —
 * when the endpoint cannot be reached. Providers without a quota
 * artifact report `unsupported`, never a fabricated zero.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/index";
import type {
  QuotaEndpoints,
  QuotaProviderResult,
  QuotaStatus,
  QuotaWindow,
  QuotaWindowKind,
} from "./model";

const PLUGIN_ID = "rebuildup.usage";

/** Short-term cache for successful quota readings (seconds). */
export const QUOTA_CACHE_TTL_SECONDS = 300;

const DEFAULT_TIMEOUT_MS = 10_000;

const CLAUDE_CREDENTIALS_SERVICE = "Claude Code-credentials";
const CLAUDE_DEFAULT_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const CODEX_DEFAULT_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_DEFAULT_CREDITS_ENDPOINT =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

// --- provider registry ---------------------------------------------------------

interface QuotaProviderSpec {
  id: string;
  implemented: boolean;
  /** Why the provider cannot report quota (absent when implemented). */
  unsupportedReason?: string;
}

/**
 * Providers with a known subscription-quota artifact. `opencode` is
 * declared unsupported up front: its auth store holds per-provider API
 * keys, and no subscription quota/reset artifact exists to read.
 */
export const QUOTA_PROVIDERS: readonly QuotaProviderSpec[] = [
  { id: "claude", implemented: true },
  { id: "codex", implemented: true },
  {
    id: "opencode",
    implemented: false,
    unsupportedReason:
      "opencode auth.json stores per-provider API keys; no subscription quota artifact exists",
  },
];

// --- shared helpers ------------------------------------------------------------

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function isoFromEpochSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value * 1000;
  const iso = new Date(ms).toISOString();
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function isoFromString(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// --- credential boundary (ADR-0014) --------------------------------------------
//
// The only credential material this module may hold is an access token
// inside a `CredentialOk` returned by a `read*Credential` function, used
// solely as an Authorization header for the provider's own quota
// endpoint. Tokens are never: written to state/config, included in
// error messages or logs, returned in command output, or passed to any
// subprocess other than the platform credential reader (`security`).

type CredentialFailure = Extract<
  QuotaStatus,
  "unsupported" | "no_credential" | "credential_expired"
>;

interface CredentialOk {
  ok: true;
  token: string;
  /** Credential expiry in ms epoch; null when the store does not say. */
  expiresAtMs: number | null;
  /** Provider plan label safe to report (e.g. subscription type). */
  plan: string | null;
  /** Extra non-secret request headers (e.g. codex account id). */
  headers: Record<string, string>;
}

type CredentialResult = CredentialOk | { ok: false; status: CredentialFailure; detail: string };

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? os.homedir();
}

async function readJsonFile(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Claude credential: `$CLAUDE_CONFIG_DIR/.credentials.json`
 * (`claudeAiOauth.accessToken`/`expiresAt`/`subscriptionType`), falling
 * back to the macOS Keychain item `Claude Code-credentials` only when
 * `CLAUDE_CONFIG_DIR` is unset — an explicit config dir is an explicit
 * credential location and must not be second-guessed by the Keychain.
 * `expiresAt` past → `credential_expired`; the plugin never refreshes
 * tokens (that would be a credential mutation).
 */
async function readClaudeCredential(env: NodeJS.ProcessEnv): Promise<CredentialResult> {
  const explicitDir = env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = explicitDir || path.join(homeDir(env), ".claude");
  const file = path.join(configDir, ".credentials.json");

  let parsed = await readJsonFile(file);
  if (parsed === null && explicitDir === undefined && process.platform === "darwin") {
    // macOS Claude Code keeps credentials in the login Keychain; the
    // `security` CLI prints the JSON blob on stdout. Failure is a
    // normal "no credential" outcome, never an error dump.
    parsed = await new Promise<unknown | null>((resolve) => {
      const child = spawn(
        "security",
        ["find-generic-password", "-s", CLAUDE_CREDENTIALS_SERVICE, "-w"],
        { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
      );
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        if (code !== 0 || out.trim() === "") {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(out) as unknown);
        } catch {
          resolve(null);
        }
      });
    });
  }
  if (parsed === null) {
    return {
      ok: false,
      status: "no_credential",
      detail: `no Claude credential at ${file} (and no Keychain item)`,
    };
  }

  const oauth = asRecord(asRecord(parsed)?.claudeAiOauth);
  const token = typeof oauth?.accessToken === "string" ? oauth.accessToken.trim() : "";
  if (token === "") {
    return {
      ok: false,
      status: "no_credential",
      detail: "Claude credential file has no claudeAiOauth.accessToken",
    };
  }
  const expiresAtMs = numOrNull(oauth?.expiresAt);
  if (expiresAtMs !== null && expiresAtMs > 0 && expiresAtMs <= Date.now()) {
    return {
      ok: false,
      status: "credential_expired",
      detail: `Claude OAuth token expired at ${new Date(expiresAtMs).toISOString()}; token refresh is out of scope`,
    };
  }
  const subscription = oauth?.subscriptionType;
  return {
    ok: true,
    token,
    expiresAtMs,
    plan: typeof subscription === "string" && subscription !== "" ? subscription : null,
    headers: {},
  };
}

/** Decode a JWT payload without verifying; returns whitelisted claims only. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1] as string;
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    return asRecord(JSON.parse(json));
  } catch {
    return null;
  }
}

const CODEX_PLAN_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
};

/**
 * Codex credential: `$CODEX_HOME/auth.json` (`tokens.access_token` +
 * `tokens.id_token` claims). Only ChatGPT-account auth has a
 * subscription quota endpoint; `auth_mode: "apikey"` is reported
 * `unsupported`, and a missing/empty store is `no_credential`.
 */
async function readCodexCredential(env: NodeJS.ProcessEnv): Promise<CredentialResult> {
  const home = env.CODEX_HOME?.trim() || path.join(homeDir(env), ".codex");
  const file = path.join(home, "auth.json");
  const parsed = await readJsonFile(file);
  if (parsed === null) {
    return {
      ok: false,
      status: "no_credential",
      detail: `no Codex credential at ${file}`,
    };
  }
  const root = asRecord(parsed);
  const authMode = typeof root?.auth_mode === "string" ? root.auth_mode : "";
  const tokens = asRecord(root?.tokens);
  const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";

  if (authMode === "apikey" || (accessToken === "" && authMode !== "chatgpt")) {
    return {
      ok: false,
      status: "unsupported",
      detail: `codex auth_mode "${authMode || "unknown"}" has no subscription quota artifact`,
    };
  }
  if (accessToken === "") {
    return {
      ok: false,
      status: "no_credential",
      detail: "codex auth.json has no tokens.access_token",
    };
  }

  // Whitelisted id_token claims only — the token itself is never kept
  // beyond the Authorization header and never reported.
  const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : "";
  const claims = idToken !== "" ? decodeJwtClaims(idToken) : null;
  const accountId =
    typeof claims?.chatgpt_account_id === "string" ? claims.chatgpt_account_id.trim() : "";
  const planRaw =
    typeof claims?.plan_type === "string"
      ? claims.plan_type
      : typeof claims?.chatgpt_plan_type === "string"
        ? claims.chatgpt_plan_type
        : null;
  const headers: Record<string, string> = {
    "OpenAI-Beta": "codex-1",
    Originator: "Codex Desktop",
  };
  if (accountId !== "") headers["Chatgpt-Account-Id"] = accountId;
  return {
    ok: true,
    token: accessToken,
    expiresAtMs: null,
    plan: planRaw !== null ? (CODEX_PLAN_LABELS[planRaw] ?? planRaw) : null,
    headers,
  };
}

// --- window mappers (pure, unit-tested) -----------------------------------------

function windowKindForDuration(mins: number | null): QuotaWindowKind {
  if (mins === null) return "other";
  if (mins >= 43_200) return "monthly"; // >= 30 days
  if (mins >= 10_080) return "weekly"; // >= 7 days
  return "session";
}

function labelForKind(kind: QuotaWindowKind): string {
  switch (kind) {
    case "session":
      return "Session";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    default:
      return "Quota";
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

interface MappedQuota {
  windows: QuotaWindow[];
  plan: string | null;
}

/** `GET /api/oauth/usage` → windows. Percentages are already 0-100. */
export function claudeUsageToWindows(body: unknown): MappedQuota {
  const root = asRecord(body);
  const windows: QuotaWindow[] = [];
  const specs: { key: string; id: string; kind: QuotaWindowKind; mins: number }[] = [
    { key: "five_hour", id: "five_hour", kind: "session", mins: 300 },
    { key: "seven_day", id: "seven_day", kind: "weekly", mins: 10_080 },
  ];
  for (const spec of specs) {
    const w = asRecord(root?.[spec.key]);
    const used = numOrNull(w?.utilization);
    if (used === null) continue;
    windows.push({
      id: spec.id,
      label: spec.id === "five_hour" ? "Session (5-hour)" : "Weekly",
      kind: spec.kind,
      used_percent: clampPercent(used),
      resets_at: isoFromString(w?.resets_at),
      window_duration_mins: spec.mins,
    });
  }
  // Model-scoped weekly allowances ship in `limits[]`.
  const limits = Array.isArray(root?.limits) ? root.limits : [];
  for (const entry of limits) {
    const e = asRecord(entry);
    if (e?.kind !== "weekly_scoped") continue;
    const scope = asRecord(e.scope);
    const model = asRecord(scope?.model);
    const displayName = typeof model?.display_name === "string" ? model.display_name : null;
    const percent = numOrNull(e.percent);
    if (displayName === null || displayName === "" || percent === null) continue;
    windows.push({
      id: `seven_day_${slugify(displayName)}`,
      label: `Weekly · ${displayName}`,
      kind: "weekly",
      used_percent: clampPercent(percent),
      resets_at: isoFromString(e.resets_at),
      window_duration_mins: 10_080,
    });
  }
  // Extra-usage / spend caps are monthly quota windows when enabled.
  const extra = asRecord(root?.extra_usage);
  if (extra?.is_enabled === true) {
    let used = numOrNull(extra.utilization);
    if (used === null) {
      const usedCredits = numOrNull(extra.used_credits);
      const limit = numOrNull(extra.monthly_limit);
      if (usedCredits !== null && limit !== null && limit > 0) {
        used = (usedCredits / limit) * 100;
      }
    }
    if (used !== null) {
      windows.push({
        id: "extra_usage",
        label: "Extra usage",
        kind: "monthly",
        used_percent: clampPercent(used),
        resets_at: isoFromString(extra.resets_at),
        window_duration_mins: 43_200,
      });
    }
  }
  const spend = asRecord(root?.spend);
  if (spend?.enabled === true) {
    const usedAmt = asRecord(spend.used);
    const limitAmt = asRecord(spend.limit);
    const usedMinor = numOrNull(usedAmt?.amount_minor);
    const limitMinor = numOrNull(limitAmt?.amount_minor);
    const sameScale =
      typeof usedAmt?.currency === "string" &&
      usedAmt.currency.trim() !== "" &&
      usedAmt.currency === limitAmt?.currency &&
      usedAmt.exponent === limitAmt?.exponent;
    if (sameScale && usedMinor !== null && limitMinor !== null && limitMinor > 0) {
      windows.push({
        id: "monthly_spend",
        label: "Monthly spend",
        kind: "monthly",
        used_percent: clampPercent((usedMinor / limitMinor) * 100),
        resets_at: null,
        window_duration_mins: 43_200,
      });
    }
  }
  return { windows, plan: null };
}

interface CodexWindowRaw {
  used_percent: number;
  reset_at: number | null;
  windowDurationMins: number | null;
}

function codexWindow(raw: unknown, fallbackMins: number): CodexWindowRaw | null {
  const w = asRecord(raw);
  const used = numOrNull(w?.used_percent);
  if (w === null || used === null) return null;
  const limitSeconds = numOrNull(w.limit_window_seconds);
  return {
    used_percent: used,
    reset_at: numOrNull(w.reset_at),
    windowDurationMins: limitSeconds !== null ? limitSeconds / 60 : fallbackMins,
  };
}

/** `GET /backend-api/wham/usage` → windows (primary/secondary positions). */
export function codexUsageToWindows(body: unknown): MappedQuota {
  const root = asRecord(body);
  const rateLimit = asRecord(root?.rate_limit);
  const planRaw = typeof root?.plan_type === "string" ? root.plan_type : null;
  const plan = planRaw !== null ? (CODEX_PLAN_LABELS[planRaw] ?? planRaw) : null;
  const isMonthlyPlan = planRaw === "free" || planRaw === "go";
  const windows: QuotaWindow[] = [];
  const positions: { id: string; raw: unknown; fallback: number }[] = [
    {
      id: "primary",
      raw: rateLimit?.primary_window,
      fallback: isMonthlyPlan ? 43_200 : 300,
    },
    { id: "secondary", raw: rateLimit?.secondary_window, fallback: 10_080 },
  ];
  for (const pos of positions) {
    const w = codexWindow(pos.raw, pos.fallback);
    if (w === null) continue;
    const mins = w.windowDurationMins ?? pos.fallback;
    const kind = windowKindForDuration(mins);
    windows.push({
      id: pos.id,
      label: labelForKind(kind),
      kind,
      used_percent: clampPercent(w.used_percent),
      resets_at: isoFromEpochSeconds(w.reset_at),
      window_duration_mins: Number.isFinite(mins) ? Math.round(mins) : null,
    });
  }
  return { windows, plan };
}

// --- HTTP -----------------------------------------------------------------------

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

interface FetchOutcome {
  ok: boolean;
  /** HTTP status when the request completed; null on transport failure. */
  status: number | null;
  json: unknown;
  /** Sanitized failure detail — never contains headers or tokens. */
  detail: string | null;
}

export async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: FetchImpl,
  request?: { method?: string; body?: string },
): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request?.method ?? "GET",
      headers,
      ...(request?.body !== undefined ? { body: request.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: null,
      json: null,
      detail: `request failed: ${message.slice(0, 200)}`,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, status: response.status, json: null, detail: `HTTP ${response.status}` };
  }
  try {
    return { ok: true, status: response.status, json: await response.json(), detail: null };
  } catch {
    return { ok: false, status: response.status, json: null, detail: "response was not JSON" };
  }
}

// --- cache -----------------------------------------------------------------------

interface CachePayload {
  checked_at: string;
  plan: string | null;
  windows: QuotaWindow[];
  reset_credits_available: number | null;
}

function cacheDir(stateDir: string): string {
  return path.join(stateDir, "quota-cache");
}

function cacheFile(stateDir: string, provider: string): string {
  return path.join(cacheDir(stateDir), `${provider}.json`);
}

async function readCache(
  stateDir: string,
  provider: string,
): Promise<{ payload: CachePayload; ageSeconds: number } | null> {
  try {
    const raw = await readFile(cacheFile(stateDir, provider), "utf8");
    const parsed = asRecord(JSON.parse(raw));
    if (parsed === null) return null;
    const checkedAt = typeof parsed.checked_at === "string" ? parsed.checked_at : null;
    const windows = Array.isArray(parsed.windows) ? parsed.windows : null;
    if (checkedAt === null || windows === null) return null;
    const ageMs = Date.now() - Date.parse(checkedAt);
    if (!Number.isFinite(ageMs) || ageMs < 0) return null;
    return {
      payload: {
        checked_at: checkedAt,
        plan: typeof parsed.plan === "string" ? parsed.plan : null,
        windows: windows as QuotaWindow[],
        reset_credits_available:
          typeof parsed.reset_credits_available === "number"
            ? parsed.reset_credits_available
            : null,
      },
      ageSeconds: Math.floor(ageMs / 1000),
    };
  } catch {
    return null;
  }
}

async function writeCache(
  stateDir: string,
  provider: string,
  payload: CachePayload,
): Promise<void> {
  try {
    const dir = cacheDir(stateDir);
    await mkdir(dir, { recursive: true });
    const file = cacheFile(stateDir, provider);
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(tmp, file);
  } catch {
    /* cache is best-effort; a write failure must not fail the report */
  }
}

// --- endpoints --------------------------------------------------------------------

export interface ResolvedQuotaEndpoints {
  claude: string;
  codexUsage: string;
  /** Null when the codex usage endpoint is overridden without an explicit
   * credits endpoint — a mock/proxy must opt in to the credits call. */
  codexCredits: string | null;
}

export function resolveEndpoints(
  overrides: QuotaEndpoints | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedQuotaEndpoints {
  const claude = overrides?.claude ?? env.HERDR_USAGE_QUOTA_CLAUDE_URL ?? CLAUDE_DEFAULT_ENDPOINT;
  const codexUsage =
    overrides?.codexUsage ?? env.HERDR_USAGE_QUOTA_CODEX_USAGE_URL ?? CODEX_DEFAULT_USAGE_ENDPOINT;
  const codexCredits =
    overrides?.codexCredits ??
    env.HERDR_USAGE_QUOTA_CODEX_CREDITS_URL ??
    (codexUsage === CODEX_DEFAULT_USAGE_ENDPOINT ? CODEX_DEFAULT_CREDITS_ENDPOINT : null);
  return { claude, codexUsage, codexCredits };
}

// --- per-provider probe ------------------------------------------------------------

export interface QuotaOptions {
  /** Provider ids to report; undefined = all registered providers. */
  providers?: string[] | undefined;
  /** Bypass the fresh-cache read (still writes on success). */
  refresh?: boolean | undefined;
  timeoutMs?: number | undefined;
  /** Plugin state dir override (tests); default HERDR_PLUGIN_STATE_DIR layout. */
  stateDir?: string | undefined;
  endpoints?: QuotaEndpoints | undefined;
  /** Cache TTL override in seconds (config `quotaCacheTtlSeconds`). */
  cacheTtlSeconds?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fetchImpl?: FetchImpl | undefined;
  now?: (() => number) | undefined;
}

function baseResult(provider: string, fetchedAt: string, ttl: number): QuotaProviderResult {
  return {
    provider,
    status: "request_failed",
    detail: null,
    plan: null,
    windows: [],
    checked_at: null,
    fetched_at: fetchedAt,
    stale: false,
    stale_reason: null,
    reset_credits_available: null,
    cache: { hit: false, age_seconds: null, ttl_seconds: ttl },
  };
}

function cachedResult(
  provider: string,
  fetchedAt: string,
  ttl: number,
  cache: { payload: CachePayload; ageSeconds: number },
  stale: boolean,
  staleReason: string | null,
): QuotaProviderResult {
  return {
    provider,
    status: "ok",
    detail: null,
    plan: cache.payload.plan,
    windows: cache.payload.windows,
    checked_at: cache.payload.checked_at,
    fetched_at: fetchedAt,
    stale,
    stale_reason: staleReason,
    reset_credits_available: cache.payload.reset_credits_available,
    cache: { hit: true, age_seconds: cache.ageSeconds, ttl_seconds: ttl },
  };
}

async function fetchClaudeQuota(
  cred: CredentialOk,
  endpoint: string,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<{ ok: true; payload: CachePayload } | { ok: false; detail: string }> {
  const res = await fetchJson(
    endpoint,
    {
      authorization: `Bearer ${cred.token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.0 (external, cli)",
    },
    timeoutMs,
    fetchImpl,
  );
  if (!res.ok) return { ok: false, detail: res.detail ?? "request failed" };
  const mapped = claudeUsageToWindows(res.json);
  if (mapped.windows.length === 0) {
    return { ok: false, detail: "quota endpoint returned no usage windows" };
  }
  return {
    ok: true,
    payload: {
      checked_at: new Date().toISOString(),
      plan: cred.plan ?? mapped.plan,
      windows: mapped.windows,
      reset_credits_available: null,
    },
  };
}

/**
 * Count banked Codex reset credits from a `rate-limit-reset-credits`
 * response body: `reset_type === "codex_rate_limits"`, `status ===
 * "available"`, and not yet expired. Pure — shared by the direct
 * quota probe and the hub (api-call) path. Returns null when the
 * body is not the expected shape (missing is never zero-fabricated).
 */
export function codexResetCreditsAvailable(body: unknown, nowMs: number): number | null {
  const root = asRecord(body);
  if (root === null || !Array.isArray(root.credits)) return null;
  let count = 0;
  for (const entry of root.credits) {
    const c = asRecord(entry);
    if (c?.reset_type !== "codex_rate_limits" || c.status !== "available") continue;
    const expires = typeof c.expires_at === "string" ? Date.parse(c.expires_at) : NaN;
    if (!Number.isFinite(expires) || expires <= nowMs) continue;
    count += 1;
  }
  return count;
}

async function fetchCodexCredits(
  cred: CredentialOk,
  endpoint: string,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<number | null> {
  const res = await fetchJson(
    endpoint,
    { authorization: `Bearer ${cred.token}`, ...cred.headers },
    timeoutMs,
    fetchImpl,
  );
  if (!res.ok) return null;
  return codexResetCreditsAvailable(res.json, Date.now());
}

async function fetchCodexQuota(
  cred: CredentialOk,
  endpoints: ResolvedQuotaEndpoints,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<{ ok: true; payload: CachePayload } | { ok: false; detail: string }> {
  const res = await fetchJson(
    endpoints.codexUsage,
    { authorization: `Bearer ${cred.token}`, ...cred.headers },
    timeoutMs,
    fetchImpl,
  );
  if (!res.ok) return { ok: false, detail: res.detail ?? "request failed" };
  const mapped = codexUsageToWindows(res.json);
  if (mapped.windows.length === 0) {
    return { ok: false, detail: "quota endpoint returned no rate-limit windows" };
  }
  const credits =
    endpoints.codexCredits !== null
      ? await fetchCodexCredits(cred, endpoints.codexCredits, timeoutMs, fetchImpl)
      : null;
  return {
    ok: true,
    payload: {
      checked_at: new Date().toISOString(),
      plan: cred.plan ?? mapped.plan,
      windows: mapped.windows,
      reset_credits_available: credits,
    },
  };
}

async function quotaForProvider(
  spec: QuotaProviderSpec,
  options: QuotaOptions,
  endpoints: ResolvedQuotaEndpoints,
  stateDir: string,
  ttl: number,
  timeoutMs: number,
  fetchImpl: FetchImpl,
  env: NodeJS.ProcessEnv,
): Promise<QuotaProviderResult> {
  const now = options.now ?? (() => Date.now());
  const fetchedAt = new Date(now()).toISOString();
  const result = baseResult(spec.id, fetchedAt, ttl);

  if (!spec.implemented) {
    return { ...result, status: "unsupported", detail: spec.unsupportedReason ?? "unsupported" };
  }

  const cred =
    spec.id === "claude"
      ? await readClaudeCredential(env)
      : spec.id === "codex"
        ? await readCodexCredential(env)
        : ({ ok: false, status: "unsupported", detail: "no credential reader" } as const);
  if (!cred.ok) {
    return { ...result, status: cred.status, detail: cred.detail };
  }

  const cached = await readCache(stateDir, spec.id);
  const fresh = cached !== null && cached.ageSeconds < ttl;
  if (options.refresh !== true && fresh && cached !== null) {
    return cachedResult(spec.id, fetchedAt, ttl, cached, false, null);
  }

  const fetched =
    spec.id === "claude"
      ? await fetchClaudeQuota(cred, endpoints.claude, timeoutMs, fetchImpl)
      : await fetchCodexQuota(cred, endpoints, timeoutMs, fetchImpl);

  if (fetched.ok) {
    await writeCache(stateDir, spec.id, fetched.payload);
    return {
      ...result,
      status: "ok",
      plan: fetched.payload.plan,
      windows: fetched.payload.windows,
      checked_at: fetched.payload.checked_at,
      reset_credits_available: fetched.payload.reset_credits_available,
      cache: { hit: false, age_seconds: null, ttl_seconds: ttl },
    };
  }

  // Endpoint failed: serve the last good reading, explicitly stale,
  // rather than reporting a fabricated fresh zero.
  if (cached !== null) {
    return cachedResult(
      spec.id,
      fetchedAt,
      ttl,
      cached,
      true,
      `fetch failed (${fetched.detail}); serving cached reading`,
    );
  }
  return { ...result, status: "request_failed", detail: fetched.detail };
}

/**
 * Collect quota reports for the requested providers. Never throws for
 * per-provider failures — every outcome is a structured status.
 */
export async function collectQuota(options: QuotaOptions = {}): Promise<QuotaProviderResult[]> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttl = options.cacheTtlSeconds ?? QUOTA_CACHE_TTL_SECONDS;
  const stateDir = options.stateDir ?? pluginDirs(PLUGIN_ID).stateDir;
  const endpoints = resolveEndpoints(options.endpoints, env);

  const requested = options.providers ?? QUOTA_PROVIDERS.map((p) => p.id);
  const results: QuotaProviderResult[] = [];
  for (const id of requested) {
    const spec = QUOTA_PROVIDERS.find((p) => p.id === id) ?? {
      id,
      implemented: false,
      unsupportedReason: "no quota source registered for this provider",
    };
    results.push(
      await quotaForProvider(spec, options, endpoints, stateDir, ttl, timeoutMs, fetchImpl, env),
    );
  }
  return results;
}
