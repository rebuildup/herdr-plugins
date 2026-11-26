/**
 * Infisical provider resolution for rebuildup.secrets (ADR-0027 §1/§3).
 *
 * Resolution shells out to the official `infisical` CLI per invocation:
 *   infisical secrets get <secret> --env <env> --path <path>
 *     --projectId <id> --domain <domain> -o json
 *
 * The plugin never stores Infisical tokens or credentials: the child
 * inherits the caller's environment (same trust domain as running the
 * CLI directly), plus an optional declared `tokenEnv` → `INFISICAL_TOKEN`
 * mapping. Values move only through the child's stdout into memory and
 * then to one of the two legal sinks — they are never written to
 * argv, files, logs, or CLI output.
 */

import { spawn } from "node:child_process";
import type { SecretsConfig } from "./config";
import type { InfisicalRef } from "./model";

export interface ResolveTarget {
  ref: InfisicalRef;
  /** Infisical project id (binding override already applied by caller). */
  projectId: string;
}

export type ResolveOutcome =
  | { ok: true; value: string }
  | {
      ok: false;
      status: "unresolved" | "provider_unreachable" | "auth_missing" | "provider_error";
      detail: string;
    };

export interface ProviderOptions {
  /** Override the `infisical` binary (tests / non-PATH installs). */
  bin?: string;
  /** Per-call timeout; default 20_000 ms. */
  timeoutMs?: number;
  /** Extra env for the child (never used for secret values). */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Sentinel the CLI prints for a missing secret in `-o json` output. */
const NOT_FOUND_SENTINEL = "*not found*";

function classifyFailure(
  exitCode: number | null,
  stderr: string,
): {
  status: "provider_unreachable" | "auth_missing" | "provider_error";
  detail: string;
} {
  const text = stderr.toLowerCase();
  const detail =
    (stderr.trim() === ""
      ? `exit code ${exitCode ?? "signal"}`
      : stderr.trim().replace(/\s+/g, " ").slice(0, 300)) || `exit code ${exitCode ?? "signal"}`;
  if (
    /econnrefused|enotfound|eai_again|etimedout|timed? ?out|network|socket hang up|getaddrinfo|dns|502|503|504/i.test(
      text,
    )
  ) {
    return { status: "provider_unreachable", detail };
  }
  if (
    /unauthorized|unauthenticated|401|403|forbidden|invalid token|expired token|login|not authenticated|permission denied/i.test(
      text,
    )
  ) {
    return { status: "auth_missing", detail };
  }
  if (exitCode === null) {
    return { status: "provider_unreachable", detail: `infisical CLI did not exit (${detail})` };
  }
  return { status: "provider_error", detail };
}

/**
 * Resolve one Infisical reference to its value. The returned `value` is
 * secret material: callers must keep it in memory only and route it to a
 * legal sink (ADR-0027 §3). Error details never contain secret values —
 * on success-path parse anomalies we report structure, not content.
 */
export function resolveSecret(
  config: SecretsConfig,
  target: ResolveTarget,
  options: ProviderOptions = {},
): Promise<ResolveOutcome> {
  const bin = options.bin ?? "infisical";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { ref } = target;

  const args = [
    "secrets",
    "get",
    ref.secret,
    "--env",
    ref.env,
    "--path",
    ref.path,
    "--projectId",
    target.projectId,
    "--domain",
    config.infisical.domain,
    "-o",
    "json",
    "--silent",
  ];

  // Optional declared token mapping: config names an env var holding a
  // token; we forward it to the CLI's INFISICAL_TOKEN env contract. The
  // value itself never appears in argv.
  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  if (options.env) Object.assign(childEnv, options.env);
  const tokenEnv = config.infisical.tokenEnv;
  if (tokenEnv !== undefined && tokenEnv !== "") {
    const tokenValue = process.env[tokenEnv];
    if (tokenValue !== undefined && tokenValue !== "") {
      childEnv.INFISICAL_TOKEN = tokenValue;
    }
  }

  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome: ResolveOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        status: "provider_unreachable",
        detail: `infisical secrets get timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      // Bound captured output; the value itself is expected on stdout.
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish({
        ok: false,
        status: "provider_unreachable",
        detail: `failed to spawn infisical CLI: ${err.message}`,
      });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, ...classifyFailure(code, stderr) });
        return;
      }
      let entries: unknown;
      try {
        entries = JSON.parse(stdout);
      } catch {
        finish({
          ok: false,
          status: "provider_error",
          detail: "infisical returned non-JSON output for secrets get -o json",
        });
        return;
      }
      const list = Array.isArray(entries) ? entries : [entries];
      const match = list.find(
        (e): e is { secretKey?: unknown; secretValue?: unknown } =>
          typeof e === "object" && e !== null,
      );
      if (match === undefined || typeof match.secretValue !== "string") {
        finish({ ok: false, status: "unresolved", detail: "provider returned no secret entry" });
        return;
      }
      if (match.secretValue === NOT_FOUND_SENTINEL) {
        finish({
          ok: false,
          status: "unresolved",
          detail: `secret ${ref.secret} not found at ${ref.env}:${ref.path}`,
        });
        return;
      }
      finish({ ok: true, value: match.secretValue });
    });
  });
}

/**
 * Cheap provider reachability/auth probe: resolve a guaranteed-absent
 * sentinel secret. `*not found*` proves server reachability + working
 * auth without touching a real value.
 */
export async function probeProvider(
  config: SecretsConfig,
  target: ResolveTarget,
  options: ProviderOptions = {},
): Promise<{
  reachable: boolean;
  status: "ok" | "unresolved" | "provider_unreachable" | "auth_missing" | "provider_error";
  detail?: string;
}> {
  const outcome = await resolveSecret(
    config,
    {
      ref: { ...target.ref, secret: "__REBuildup_SECRETS_PROBE_000__" },
      projectId: target.projectId,
    },
    options,
  );
  if (outcome.ok || outcome.status === "unresolved") {
    // Any structured provider answer — including the `*not found*`
    // sentinel for our guaranteed-absent probe name — proves the server
    // is reachable and credentials work, without touching a real value.
    return { reachable: true, status: "ok" };
  }
  return {
    reachable: outcome.status !== "provider_unreachable",
    status: outcome.status,
    ...(outcome.detail !== "" ? { detail: outcome.detail } : {}),
  };
}
