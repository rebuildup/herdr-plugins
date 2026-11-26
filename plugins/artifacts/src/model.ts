/**
 * Shared contract constants and record types for
 * rebuildup.artifacts (`herdr-plugins.artifacts/v1`, STABLE — ADR-0024).
 *
 * T1 (#136) fixed identity, kinds, storage modes, and size caps; T2
 * (#141) adds the persisted artifact record shape consumed by the
 * registry core (state.ts / registry.ts); T4 (#143) stabilizes v1 with
 * deliver/gc/export.
 */

export const PLUGIN_ID = "rebuildup.artifacts";
export const CONTRACT = "herdr-plugins.artifacts/v1";
/** Contract maturity: "stable" since T4 (#143) shipped deliver/gc/export. */
export const CONTRACT_STATUS = "stable";
export const PLUGIN_VERSION = "0.2.0";

/** Artifact kinds, mirroring upstream T3 attachment kinds. */
export const ARTIFACT_KINDS = ["html", "image", "pdf", "file", "other"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Storage modes (ADR-0024 §2). */
export const STORAGE_MODES = ["state_copy", "path_ref"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

/**
 * Draft per-kind copy caps in bytes (upstream T3 values: image 10 MiB,
 * HTML page 25 MiB; pdf/file/other aligned to 25 MiB). `path_ref`
 * records are never refused for size — oversize becomes a warning.
 */
export const MAX_BYTES: Record<ArtifactKind, number> = {
  html: 25 * 1024 * 1024,
  image: 10 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  file: 25 * 1024 * 1024,
  other: 25 * 1024 * 1024,
};

/** artifact_id shape enforced on every retrieval path (traversal guard). */
export const ARTIFACT_ID_PATTERN = /^art-[A-Za-z0-9_-]+$/;

/** Who initiated registration (contract `owner.created_by`). */
export const CREATED_BY = ["pane", "agent", "handoff", "script", "cli", "unknown"] as const;
export type CreatedBy = (typeof CREATED_BY)[number];

/** State index schema version (`state.json`). */
export const STATE_SCHEMA_VERSION = 1;

/**
 * Advisory render metadata recorded at register time (contract
 * `meta`). For `kind:"html"` the plugin records that consumers must
 * render the document inside an isolated context; sandbox/CSP/network
 * policy is always the client's responsibility (ADR-0024 §4). The
 * plugin never executes or renders content itself.
 */
export interface ArtifactMeta {
  render?: {
    /** HTML documents must be rendered in an isolated context. */
    isolation: "required";
    /** Enforcement point for sandbox/CSP/network policy. */
    policy: "client";
  };
}

/**
 * One durable artifact record — the contract's artifact record
 * (docs/contracts/artifacts-v1.md §Artifact record). `storage.ref` is
 * state-relative for `state_copy` (`artifacts/<id>/<name>`) and the
 * resolved realpath for `path_ref`; `resolved_path` is always the
 * absolute path a consumer may open.
 */
export interface ArtifactRecord {
  contract: typeof CONTRACT;
  artifact_id: string;
  kind: ArtifactKind;
  title?: string | undefined;
  /** Host identity of the registering herdr installation. */
  host: string;
  /** herdr session name the artifact was registered under. */
  session: string;
  owner: {
    pane_id?: string | undefined;
    /** Provider session value reported by the pane's agent, when known. */
    agent_session?: string | undefined;
    created_by: CreatedBy;
  };
  storage: {
    mode: StorageMode;
    ref: string;
    resolved_path: string;
  };
  size: number;
  mime: string;
  sha256: string;
  /** path_ref only: true when size exceeded the per-kind cap at register. */
  oversize: boolean;
  created_at: string;
  /** Additive back-references (conversations event, handoff payload, checkpoint). */
  refs?: string[] | undefined;
  /** Structured warnings recorded at register (e.g. mime_mismatch, oversize). */
  warnings?: string[] | undefined;
  /** Advisory metadata (e.g. html render isolation notice). */
  meta?: ArtifactMeta | undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v !== "");
  return out.length > 0 ? out : undefined;
}

/**
 * Tolerant record parser: malformed persisted entries return null so the
 * state loader can quarantine them into `state.corrupt` instead of
 * failing the whole index (deterministic, honest — never silently
 * dropped into success).
 */
export function parseArtifactRecord(value: unknown): ArtifactRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const artifactId = asString(v.artifact_id);
  const kind = asString(v.kind);
  const host = asString(v.host);
  const session = asString(v.session);
  const createdAt = asString(v.created_at);
  const sha256 = asString(v.sha256);
  const mime = asString(v.mime);
  const size = v.size;
  const storage = v.storage;
  const owner = v.owner;
  if (
    artifactId === undefined ||
    !ARTIFACT_ID_PATTERN.test(artifactId) ||
    kind === undefined ||
    !(ARTIFACT_KINDS as readonly string[]).includes(kind) ||
    host === undefined ||
    session === undefined ||
    createdAt === undefined ||
    sha256 === undefined ||
    mime === undefined ||
    typeof size !== "number" ||
    !Number.isFinite(size) ||
    size < 0 ||
    typeof storage !== "object" ||
    storage === null ||
    typeof owner !== "object" ||
    owner === null
  ) {
    return null;
  }
  const s = storage as Record<string, unknown>;
  const mode = asString(s.mode);
  const ref = asString(s.ref);
  const resolvedPath = asString(s.resolved_path);
  if (
    mode === undefined ||
    !(STORAGE_MODES as readonly string[]).includes(mode) ||
    ref === undefined ||
    resolvedPath === undefined
  ) {
    return null;
  }
  const o = owner as Record<string, unknown>;
  const createdBy = asString(o.created_by);
  const record: ArtifactRecord = {
    contract: CONTRACT,
    artifact_id: artifactId,
    kind: kind as ArtifactKind,
    host,
    session,
    owner: {
      created_by:
        createdBy !== undefined && (CREATED_BY as readonly string[]).includes(createdBy)
          ? (createdBy as CreatedBy)
          : "unknown",
    },
    storage: {
      mode: mode as StorageMode,
      ref,
      resolved_path: resolvedPath,
    },
    size,
    mime,
    sha256,
    oversize: v.oversize === true,
    created_at: createdAt,
  };
  const title = asString(v.title);
  if (title !== undefined) record.title = title;
  const paneId = asString(o.pane_id);
  if (paneId !== undefined) record.owner.pane_id = paneId;
  const agentSession = asString(o.agent_session);
  if (agentSession !== undefined) record.owner.agent_session = agentSession;
  const refs = asStringArray(v.refs);
  if (refs !== undefined) record.refs = refs;
  const warnings = asStringArray(v.warnings);
  if (warnings !== undefined) record.warnings = warnings;
  const meta = parseArtifactMeta(v.meta);
  if (meta !== undefined) record.meta = meta;
  return record;
}

/**
 * Tolerant meta parser: `meta` is advisory, derived data, so a
 * malformed persisted value is dropped rather than quarantining the
 * whole record.
 */
function parseArtifactMeta(value: unknown): ArtifactMeta | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const render = (value as Record<string, unknown>).render;
  if (typeof render !== "object" || render === null) return undefined;
  const r = render as Record<string, unknown>;
  if (r.isolation !== "required" || r.policy !== "client") return undefined;
  return { render: { isolation: "required", policy: "client" } };
}

/**
 * Commands that exist in the contract but are not implemented in this
 * revision. Empty since T4 (#143): v1 is stable and complete.
 */
export const PLANNED_COMMANDS: readonly string[] = [];

/** Implemented commands (T1 capability/help + T2 registry + T3 verify + T4 deliver/gc/export). */
export const IMPLEMENTED_COMMANDS = [
  "capability",
  "help",
  "register",
  "list",
  "get",
  "search",
  "verify",
  "delete",
  "deliver",
  "gc",
  "export",
] as const;
