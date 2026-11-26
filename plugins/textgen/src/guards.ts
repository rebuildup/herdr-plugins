/**
 * Pre-execution guards for rebuildup.textgen (Issue #109, T3).
 *
 * Before the agent-pane path spawns a dedicated workspace, cheap
 * read-only preconditions run:
 *
 * 1. **Opt-in for expensive tasks** — tasks flagged `requiresOptIn`
 *    in the registry (`review_guide`: multi-step read-only
 *    investigation, largest subscription cost) require either
 *    `config.guards.expensiveTaskOptIn` or a per-call `--allow-expensive`.
 *    Otherwise `task_not_opted_in` (policy) — structural opt-in, same
 *    discipline as ADR-0018's `enabled: true` generators.
 * 2. **Provider availability** — when herdr manifests were reachable,
 *    the resolved agent kind must appear in them (`provider_unavailable`);
 *    when unreachable, a warning is recorded and `agent.start` remains
 *    the authority (fail-open for availability, fail-closed for cost).
 * 3. **Quota guard (opt-in)** — `config.guards.quota.enabled` probes
 *    `rebuildup.usage`'s read-only `quota` command for the agent kind.
 *    A reported window at/above `maxUsedPercent` blocks with
 *    `quota_exceeded`; every probe failure degrades to a
 *    `quota_check_unavailable` warning (never a silent pass, never a
 *    hard dependency on the usage plugin).
 */

import type { TextgenConfig } from "./config";
import type { TaskSpec } from "./model";
import { TextgenError } from "./model";
import type { AgentManifestEntry, ResolvedProvider } from "./providers";
import { makeUsageQuotaProbe, type QuotaProbe, type QuotaProbeResult } from "./quota";

export interface GuardOptions {
  spec: TaskSpec;
  provider: ResolvedProvider;
  config: TextgenConfig;
  /** herdr agent manifests when reachable; undefined = unverified. */
  manifests?: AgentManifestEntry[] | undefined;
  /** Per-call opt-in for `requiresOptIn` tasks (`--allow-expensive`). */
  allowExpensive?: boolean | undefined;
  /** Injectable quota probe (tests); default = usage-plugin CLI probe. */
  quotaProbe?: QuotaProbe | undefined;
  session?: string | undefined;
  socketPath?: string | undefined;
}

export interface GuardResult {
  warnings: string[];
}

export async function checkGenerationGuards(options: GuardOptions): Promise<GuardResult> {
  const { spec, provider, config } = options;
  const warnings: string[] = [];

  // 1. Expensive-task opt-in (policy). Applies to any path — the cost
  //    note is about the task, not the transport.
  if (spec.requiresOptIn === true) {
    const optedIn = config.guards.expensiveTaskOptIn || options.allowExpensive === true;
    if (!optedIn) {
      throw new TextgenError(
        "task_not_opted_in",
        "policy",
        `task ${spec.kind} requires explicit opt-in: set guards.expensiveTaskOptIn ` +
          "in config.json or pass --allow-expensive (multi-step agent investigation)",
        { task: spec.kind },
      );
    }
  }

  if (provider.path !== "agent") {
    // API generators are single-shot; agent-only tasks never reach here
    // (resolveProvider rejects them), and the quota/availability guards
    // below are agent-path concerns only.
    return { warnings };
  }

  const kind = provider.agentKind ?? "";

  // 2. Provider availability via herdr agent manifests.
  if (options.manifests !== undefined) {
    const manifestKinds = new Set(options.manifests.map((m) => m.agent));
    if (kind !== "" && !manifestKinds.has(kind)) {
      throw new TextgenError(
        "provider_unavailable",
        "unavailable",
        `agent provider "${provider.id}" is not present in herdr agent manifests`,
        {
          provider: provider.id,
          kind,
          available: [...manifestKinds].sort(),
        },
      );
    }
  } else {
    warnings.push("agent_availability_unverified");
  }

  // 3. Optional usage-quota probe (soft dependency on rebuildup.usage).
  if (config.guards.quota.enabled && kind !== "") {
    const probe =
      options.quotaProbe ??
      makeUsageQuotaProbe(config.guards.quota, {
        ...(options.session !== undefined ? { session: options.session } : {}),
        ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
      });
    let result: QuotaProbeResult;
    try {
      result = await probe(kind);
    } catch (err) {
      warnings.push(`quota_check_unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return { warnings };
    }
    if (result.status !== "ok") {
      warnings.push(`quota_check_unavailable: ${result.reason} (${result.detail})`);
      return { warnings };
    }
    if (result.maxUsedPercent >= config.guards.quota.maxUsedPercent) {
      throw new TextgenError(
        "quota_exceeded",
        "unavailable",
        `usage quota for ${result.provider} is at ${result.maxUsedPercent}% ` +
          `(threshold ${config.guards.quota.maxUsedPercent}%); generation blocked`,
        {
          provider: result.provider,
          used_percent: result.maxUsedPercent,
          threshold_percent: config.guards.quota.maxUsedPercent,
          windows: result.windowIds,
        },
      );
    }
  }

  return { warnings };
}
