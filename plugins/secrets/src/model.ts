/**
 * rebuildup.secrets — model constants, reference grammar, and binding
 * validation for contract `herdr-plugins.secrets/v1` (Issue #160,
 * boundary ADR-0027).
 *
 * Secret values are never represented here: this module only handles
 * metadata (names, env names, references, statuses).
 */

export const CONTRACT = "herdr-plugins.secrets/v1";
export const PLUGIN_ID = "rebuildup.secrets";
export const PLUGIN_VERSION = "0.1.0";

/** Canonical self-hosted Infisical control plane (secrets-management skill). */
export const CANONICAL_INFISICAL_DOMAIN = "https://secrets.rebuildup.dev/api";

/**
 * Structured resolution statuses. `resolved` means the provider returned
 * a value for the reference during this invocation; the value itself is
 * never part of any report (ADR-0027 §3).
 */
export const RESOLUTION_STATUSES = [
  "resolved",
  "unresolved",
  "provider_unreachable",
  "auth_missing",
  "provider_error",
  "config_error",
] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export class SecretsError extends Error {
  readonly code: string;
  readonly kind?: string;
  constructor(message: string, code = "error", kind?: string) {
    super(message);
    this.name = "SecretsError";
    this.code = code;
    if (kind !== undefined) this.kind = kind;
  }
}

// --- Reference grammar -------------------------------------------------------
//
// `infisical:<env>:<path>:<secret>` — exactly four colon-separated fields.
// `<env>` and `<secret>` are single path segments; `<path>` is an Infisical
// folder path that must start with `/` (`/` is the root) and must not
// contain `:`. `op://` and other providers are rejected in v1 (ADR-0027 §1).

export interface InfisicalRef {
  env: string;
  path: string;
  secret: string;
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Parse an Infisical reference. Returns null for anything that is not a
 * well-formed `infisical:` reference (including `op://` and bare names).
 */
export function parseInfisicalRef(ref: string): InfisicalRef | null {
  if (typeof ref !== "string" || !ref.startsWith("infisical:")) return null;
  const rest = ref.slice("infisical:".length);
  const parts = rest.split(":");
  if (parts.length !== 3) return null;
  const [env, pathPart, secret] = parts as [string, string, string];
  if (!SEGMENT_RE.test(env)) return null;
  // Path must be absolute (`/` root allowed), single slashes only.
  if (!/^\/[A-Za-z0-9_.\-/]*$/.test(pathPart) || pathPart.includes("//")) return null;
  if (!SEGMENT_RE.test(secret)) return null;
  const normalizedPath = pathPart.replace(/\/+$/, "") || "/";
  return { env, path: normalizedPath, secret };
}

// --- Binding / env-name validation -------------------------------------------

/** POSIX-ish environment variable name. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** herdr session-context prefix plugins must never shadow (ADR-0027 §3). */
const HERDR_PREFIX_RE = /^HERDR_/i;

export interface Binding {
  name: string;
  env: string;
  ref: string;
  projectId?: string;
}

export type BindingValidation =
  | { ok: true; binding: Binding; ref: InfisicalRef }
  | { ok: false; name: string; error: string };

/**
 * Validate one declared binding. The `env` target name is the user's
 * contract; `HERDR_*` collisions are rejected at declaration time.
 */
export function validateBinding(raw: unknown): BindingValidation {
  const rec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const name = typeof rec.name === "string" ? rec.name : "";
  const env = typeof rec.env === "string" ? rec.env : "";
  const ref = typeof rec.ref === "string" ? rec.ref : "";
  const fail = (error: string): BindingValidation => ({ ok: false, name, error });

  if (name === "" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    return fail("binding name must be 1-64 chars of [A-Za-z0-9_.-] starting alphanumeric");
  }
  if (env === "" || !ENV_NAME_RE.test(env)) {
    return fail(`env name ${JSON.stringify(env)} is not a valid environment variable name`);
  }
  if (HERDR_PREFIX_RE.test(env)) {
    return fail(`env name ${JSON.stringify(env)} collides with the reserved HERDR_* prefix`);
  }
  const parsed = parseInfisicalRef(ref);
  if (parsed === null) {
    return fail(
      `ref ${JSON.stringify(ref)} is not a valid infisical:<env>:<path>:<secret> reference ` +
        "(op:// and other providers are not resolved in v1, ADR-0027 §1)",
    );
  }
  const binding: Binding = { name, env, ref };
  if (typeof rec.projectId === "string" && rec.projectId !== "") {
    binding.projectId = rec.projectId;
  }
  return { ok: true, binding, ref: parsed };
}

/** Env-name collision check used for per-invocation duplicates too. */
export function isForbiddenEnvName(env: string): boolean {
  return HERDR_PREFIX_RE.test(env);
}
