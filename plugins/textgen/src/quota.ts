/**
 * Optional usage-quota guard for rebuildup.textgen (Issue #109, T3).
 *
 * `review_guide` is a multi-step read-only investigation: it consumes a
 * provider subscription like any agent turn, so before spawning the
 * dedicated pane the plugin may consult `rebuildup.usage`'s read-only
 * `quota` command (`herdr-plugins.usage/v1`) for the resolved agent
 * kind. This is a *soft* dependency by contract:
 *
 * - the usage plugin is never required — an unresolvable root, a
 *   non-zero exit, a contract mismatch, or a non-`ok` provider status
 *   all degrade to a structured "unavailable" result that the caller
 *   turns into a warning, never a hard failure;
 * - only the public CLI contract is consumed (same cross-plugin
 *   pattern as gitcontext.ts, ADR-0013); the child's HERDR_PLUGIN_*
 *   env is scrubbed and pinned to the usage plugin dirs;
 * - quota *values* are used only for the threshold comparison — they
 *   are never persisted, and only provider/status/percent appear in
 *   errors and warnings.
 */

import type { QuotaGuardConfig } from "./config";
import { resolvePluginRoot, runPluginCli } from "./pluginroot";

export const USAGE_PLUGIN_ID = "rebuildup.usage";
export const USAGE_CONTRACT = "herdr-plugins.usage/v1";

/** Outcome of one quota probe; `unavailable` covers every soft failure. */
export type QuotaProbeResult =
  | {
      status: "ok";
      /** Highest `used_percent` across the provider's reported windows. */
      maxUsedPercent: number;
      /** Provider id as reported by the usage plugin. */
      provider: string;
      /** Window ids that reached the max (for error details). */
      windowIds: string[];
    }
  | {
      status: "unavailable";
      /** Machine-stable reason: unsupported | no_credential | … | probe_failed. */
      reason: string;
      detail: string;
    };

/** Injectable probe: `(agentKind) => result`. Never throws by contract. */
export type QuotaProbe = (kind: string) => Promise<QuotaProbeResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the max `used_percent` for `kind` from a `quota` command
 * payload. Pure — separated from the spawn so tests can feed fixtures.
 * Returns null when the provider is absent or reports a non-ok status.
 */
export function parseUsageQuotaPayload(
  json: Record<string, unknown>,
  kind: string,
): { maxUsedPercent: number; windowIds: string[] } | { reason: string } | null {
  if (json.contract !== USAGE_CONTRACT) return null;
  const providers = Array.isArray(json.providers) ? json.providers : [];
  const entry = providers.find(
    (p) => isRecord(p) && (p.provider === kind || p.provider === `agent:${kind}`),
  );
  if (!isRecord(entry)) return null;
  const status = typeof entry.status === "string" ? entry.status : "unknown";
  if (status !== "ok") return { reason: status };
  const windows = Array.isArray(entry.windows) ? entry.windows : [];
  let max = 0;
  const windowIds: string[] = [];
  for (const w of windows) {
    if (!isRecord(w)) continue;
    const pct = typeof w.used_percent === "number" ? w.used_percent : null;
    if (pct === null) continue;
    if (pct > max) {
      max = pct;
      windowIds.length = 0;
      if (typeof w.id === "string") windowIds.push(w.id);
    } else if (pct === max && typeof w.id === "string") {
      windowIds.push(w.id);
    }
  }
  return { maxUsedPercent: max, windowIds };
}

export interface UsageQuotaProbeOptions {
  /** Explicit usage plugin root (config `guards.quota.usagePluginRoot`). */
  usagePluginRoot?: string | undefined;
  /** Guard timeout; also bounds the child process. */
  timeoutMs: number;
  session?: string | undefined;
  socketPath?: string | undefined;
  /** Injectable runner for tests; defaults to the real sibling CLI spawn. */
  run?:
    | ((
        root: string,
        args: string[],
        call: { session?: string; socketPath?: string; timeoutMs?: number },
      ) => Promise<{
        status: number;
        stdout: string;
        stderr: string;
        json: Record<string, unknown> | null;
      }>)
    | undefined;
}

/**
 * Probe the usage plugin's `quota` command for one agent kind. Every
 * failure path returns `{status:"unavailable"}` — the guard treats
 * "cannot check" as "proceed with a warning", never as a block.
 */
export async function probeUsageQuota(
  kind: string,
  options: UsageQuotaProbeOptions,
): Promise<QuotaProbeResult> {
  const unavailable = (reason: string, detail: string): QuotaProbeResult => ({
    status: "unavailable",
    reason,
    detail,
  });

  let root: string;
  try {
    const resolved = await resolvePluginRoot(USAGE_PLUGIN_ID, options.usagePluginRoot);
    if (!resolved.ok) return unavailable("plugin_unresolved", resolved.error);
    root = resolved.root;
  } catch (err) {
    return unavailable("plugin_unresolved", err instanceof Error ? err.message : String(err));
  }

  const run =
    options.run ??
    ((r: string, args: string[], call: Parameters<typeof runPluginCli>[3]) =>
      runPluginCli(r, USAGE_PLUGIN_ID, args, call));

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run(root, ["quota", "--provider", kind], {
      ...(options.session !== undefined ? { session: options.session } : {}),
      ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
      timeoutMs: options.timeoutMs,
    });
  } catch (err) {
    return unavailable("probe_failed", err instanceof Error ? err.message : String(err));
  }

  if (result.status !== 0 || result.json === null) {
    const detail = result.stderr.trim().slice(0, 200) || `exit ${result.status}`;
    return unavailable("probe_failed", detail);
  }

  const parsed = parseUsageQuotaPayload(result.json, kind);
  if (parsed === null) {
    return unavailable(
      "contract_mismatch",
      `usage plugin returned unexpected payload (contract ${String(result.json.contract)})`,
    );
  }
  if ("reason" in parsed) {
    return unavailable(parsed.reason, `usage plugin reports ${parsed.reason} for ${kind}`);
  }
  return {
    status: "ok",
    maxUsedPercent: parsed.maxUsedPercent,
    provider: kind,
    windowIds: parsed.windowIds,
  };
}

/** Build the default probe bound to guard config + call options. */
export function makeUsageQuotaProbe(
  config: QuotaGuardConfig,
  call: { session?: string | undefined; socketPath?: string | undefined } = {},
): QuotaProbe {
  return (kind: string) =>
    probeUsageQuota(kind, {
      timeoutMs: config.timeoutMs,
      ...(config.usagePluginRoot !== undefined ? { usagePluginRoot: config.usagePluginRoot } : {}),
      ...(call.session !== undefined ? { session: call.session } : {}),
      ...(call.socketPath !== undefined ? { socketPath: call.socketPath } : {}),
    });
}
