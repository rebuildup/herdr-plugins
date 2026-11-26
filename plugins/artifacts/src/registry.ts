/**
 * Artifact registry core for rebuildup.artifacts (contract
 * `herdr-plugins.artifacts/v1`, T2 #141).
 *
 * Owns: register (state_copy default / opt-in path_ref), list, get,
 * search, delete — plus the boundary checks the contract fixes:
 * artifact_id-only retrieval (traversal guard), per-kind size caps for
 * state_copy, oversize-as-warning for path_ref, leading-byte MIME
 * sniffing with html shape refusal, sha256 integrity, host/session/
 * owner identity fields, and deterministic read-time resolution of
 * index/payload inconsistency (missing_ref, owner_stale, orphans,
 * corrupt records — reported, never success).
 *
 * The plugin never executes or renders artifact content (ADR-0024 §4).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { agentPrompt } from "../../../packages/herdr-client/src/agents";
import type { CallOptions } from "../../../packages/herdr-client/src/commands";
import { paneSendText } from "../../../packages/herdr-client/src/panes";
import type { SessionSnapshot } from "../../../packages/herdr-client/src/snapshot";
import {
  ARTIFACT_ID_PATTERN,
  ARTIFACT_KINDS,
  type ArtifactKind,
  type ArtifactRecord,
  CONTRACT,
  type CreatedBy,
  MAX_BYTES,
  type StorageMode,
} from "./model";
import { artifactDir, artifactsRoot, loadState, updateState } from "./state";

export class RegistryError extends Error {
  readonly code: string;
  readonly kind: string;
  readonly extra: Record<string, unknown> | undefined;
  constructor(code: string, kind: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
    this.kind = kind;
    this.extra = extra;
  }
}

function fail(code: string, kind: string, message: string, extra?: Record<string, unknown>): never {
  throw new RegistryError(code, kind, message, extra);
}

const SNIFF_BYTES = 8192;

/** Leading-byte MIME sniff (upstream attachmentStore rules, draft subset). */
export function sniffMime(head: Buffer): string {
  if (head.length >= 5 && head.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  if (head.length >= 6) {
    const sig = head.subarray(0, 6).toString("latin1");
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (head.length >= 2 && head.subarray(0, 2).toString("latin1") === "BM") {
    return "image/bmp";
  }
  // Text-ish content: decode and look for HTML/SVG shape in the prefix.
  if (head.includes(0)) return "application/octet-stream";
  const text = head.toString("utf8");
  // Upstream HtmlRender rule (HTML_DOCUMENT_START): the document must
  // *open* like HTML — `<!doctype html` or `<html` after optional
  // whitespace/BOM. A doctype buried mid-document is not HTML.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (HTML_DOCUMENT_START.test(body)) return "text/html";
  const lower = body.slice(0, 1024).toLowerCase();
  const trimmed = lower.trimStart();
  if (/^<\?xml[\s?]/.test(trimmed) && lower.includes("<svg")) return "image/svg+xml";
  if (trimmed.startsWith("<svg")) return "image/svg+xml";
  return "text/plain";
}

/** Upstream `HtmlRender` document-start rule (anchored, BOM tolerated). */
const HTML_DOCUMENT_START = /^\s*<(?:!doctype\s+html|html)[\s>]/i;

/** Upstream `HtmlRender` file rule: resolved path must end in .html/.htm. */
const HTML_FILE_EXTENSION = /\.html?$/i;

/** Extension → concrete MIME used for sniff-vs-extension mismatch warnings. */
const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
};

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  ".html": "html",
  ".htm": "html",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".bmp": "image",
  ".svg": "image",
  ".ico": "image",
  ".pdf": "pdf",
};

/** Kind inference when --kind is omitted: extension first, then MIME. */
export function detectKind(filename: string, mime: string): ArtifactKind {
  const ext = path.extname(filename).toLowerCase();
  const byExt = KIND_BY_EXT[ext];
  if (byExt !== undefined) return byExt;
  if (mime === "text/html") return "html";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  return "file";
}

/** Path-safe stored filename: basename, restricted charset, bounded length. */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
  const trimmed = base.replace(/^\.+/, "").slice(0, 120);
  return trimmed === "" ? "artifact" : trimmed;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function sha256Bytes(bytes: Buffer): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readHead(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function newArtifactId(): string {
  return `art-${randomBytes(12).toString("hex")}`;
}

export interface RegisterOptions {
  /** Source file path; mutually exclusive with `bytes`. */
  sourcePath?: string | undefined;
  /** Inline bytes (stdin registration). */
  bytes?: Buffer | undefined;
  /** Display/fallback filename used for kind detection and the stored name. */
  filename?: string | undefined;
  kind?: ArtifactKind | undefined;
  storage?: StorageMode | undefined;
  title?: string | undefined;
  paneId?: string | undefined;
  agentSession?: string | undefined;
  createdBy?: CreatedBy | undefined;
  refs?: string[] | undefined;
  host: string;
  session: string;
}

/**
 * Register one artifact. `state_copy` (default) copies bytes into
 * `HERDR_PLUGIN_STATE_DIR/artifacts/<id>/` under the per-kind cap;
 * `path_ref` records the resolved realpath and reports oversize as a
 * warning instead of refusing (ADR-0024 §2).
 */
export async function registerArtifact(options: RegisterOptions): Promise<ArtifactRecord> {
  const storageMode = options.storage ?? "state_copy";
  const hasPath = options.sourcePath !== undefined;
  const hasBytes = options.bytes !== undefined;
  if (hasPath === hasBytes) {
    fail("invalid", "invalid", "register requires exactly one of --path or --stdin");
  }

  let head: Buffer;
  let size: number;
  let sha256: string;
  let realSourcePath: string | undefined;
  let mime: string;
  let filename = options.filename;

  if (hasBytes) {
    const bytes = options.bytes as Buffer;
    head = bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES));
    size = bytes.length;
    sha256 = await sha256Bytes(bytes);
    mime = sniffMime(head);
    filename = filename ?? "stdin";
  } else {
    const source = options.sourcePath as string;
    let resolved: string;
    try {
      resolved = await realpath(source);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      fail(
        code === "ENOENT" || code === "ENOTDIR" ? "source_not_found" : "source_unreadable",
        code === "ENOENT" || code === "ENOTDIR" ? "not_found" : "unavailable",
        `cannot resolve artifact source: ${source}`,
        { source },
      );
    }
    realSourcePath = resolved;
    const info = await stat(resolved);
    if (!info.isFile()) {
      fail("source_not_file", "invalid", `artifact source is not a regular file: ${source}`, {
        source,
      });
    }
    head = await readHead(resolved);
    size = info.size;
    sha256 = await sha256File(resolved);
    mime = sniffMime(head);
    filename = filename ?? path.basename(resolved);
  }

  const kind = options.kind ?? detectKind(filename ?? "", mime);
  if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    fail("unsupported_kind", "invalid", `unsupported artifact kind: ${kind}`, {
      artifact_kind: kind,
    });
  }
  const cap = MAX_BYTES[kind];
  const warnings: string[] = [];

  // Kind-specific validation (T3 #142, upstream HtmlRender/attachmentStore
  // rules, ADR-0024 §4). HTML is the only refusal kind: path sources must
  // keep a .html/.htm name on the *resolved* path and the bytes must open
  // like a document; stdin bytes are judged on content alone (the
  // upstream "pass html instead" equivalent — there is no filename to
  // check). image/pdf/file/other record structured warnings instead.
  if (kind === "html") {
    if (hasPath && realSourcePath !== undefined && !HTML_FILE_EXTENSION.test(realSourcePath)) {
      fail(
        "invalid_html",
        "invalid",
        `kind 'html' requires a .html/.htm file name; resolved path is ${realSourcePath}`,
        { artifact_kind: kind, resolved_path: realSourcePath },
      );
    }
    if (mime !== "text/html") {
      fail("mime_mismatch", "invalid", `kind 'html' requires HTML leading bytes; sniffed ${mime}`, {
        sniffed_mime: mime,
        artifact_kind: kind,
      });
    }
  } else {
    // A concrete sniffed type (not generic text/plain or
    // application/octet-stream) that disagrees with the kind family or
    // with the filename extension is reported as a structured warning —
    // never a refusal for non-html kinds (ADR-0024 §4).
    const concrete = mime !== "text/plain" && mime !== "application/octet-stream";
    if (concrete) {
      const kindMismatch =
        (kind === "image" && mime !== "image/svg+xml" && !mime.startsWith("image/")) ||
        (kind === "pdf" && mime !== "application/pdf");
      if (kindMismatch) warnings.push("mime_mismatch");
      const ext = path.extname(filename ?? "").toLowerCase();
      const extMime = EXT_MIME[ext];
      if (extMime !== undefined && mime !== extMime) {
        warnings.push("extension_mime_mismatch");
      }
    }
  }

  const artifactId = newArtifactId();
  const storedName = sanitizeFilename(filename ?? "artifact");
  let storageRef: string;
  let resolvedPath: string;
  let oversize = false;

  if (storageMode === "state_copy") {
    if (size > cap) {
      fail("too_large", "invalid", `artifact exceeds ${kind} cap of ${cap} bytes (got ${size})`, {
        artifact_kind: kind,
        size,
        max_bytes: cap,
      });
    }
    const dir = artifactDir(artifactId);
    await mkdir(dir, { recursive: true });
    const finalPath = path.join(dir, storedName);
    const tmpPath = `${finalPath}.tmp-${process.pid}`;
    if (hasBytes) {
      await writeFile(tmpPath, options.bytes as Buffer);
    } else {
      await copyFile(realSourcePath as string, tmpPath);
    }
    await rename(tmpPath, finalPath);
    storageRef = `artifacts/${artifactId}/${storedName}`;
    resolvedPath = finalPath;
  } else {
    // path_ref: no bytes copied; oversize is a warning, not a refusal.
    if (realSourcePath === undefined) {
      fail("invalid", "invalid", "path_ref storage requires --path (stdin has no stable ref)");
    }
    oversize = size > cap;
    if (oversize) warnings.push("oversize");
    storageRef = realSourcePath;
    resolvedPath = realSourcePath;
  }

  const createdBy: CreatedBy =
    options.createdBy ??
    (options.agentSession !== undefined ? "agent" : options.paneId !== undefined ? "pane" : "cli");

  const record: ArtifactRecord = {
    contract: CONTRACT,
    artifact_id: artifactId,
    kind,
    host: options.host,
    session: options.session,
    owner: {
      created_by: createdBy,
    },
    storage: {
      mode: storageMode,
      ref: storageRef,
      resolved_path: resolvedPath,
    },
    size,
    mime,
    sha256,
    oversize,
    created_at: new Date().toISOString(),
  };
  if (options.title !== undefined) record.title = options.title;
  if (options.paneId !== undefined) record.owner.pane_id = options.paneId;
  if (options.agentSession !== undefined) record.owner.agent_session = options.agentSession;
  if (options.refs !== undefined && options.refs.length > 0) record.refs = [...options.refs];
  if (warnings.length > 0) record.warnings = warnings;
  // HTML artifacts carry the render-isolation notice as metadata: the
  // plugin validates shape only; sandbox/CSP is a client requirement
  // (ADR-0024 §4, issue #142).
  if (kind === "html") {
    record.meta = { render: { isolation: "required", policy: "client" } };
  }

  // Index insert under the single-writer lock; the payload copy above is
  // already durable, so a failed insert leaves a detectable orphan dir.
  await updateState((state) => {
    if (state.artifacts[artifactId] !== undefined) {
      fail("artifact_id_collision", "unavailable", `artifact id collision: ${artifactId}`);
    }
    state.artifacts[artifactId] = record;
  });
  return record;
}

/** Absolute path a `state_copy` payload must live at for this record. */
function expectedStoredPath(record: ArtifactRecord): string | null {
  if (record.storage.mode !== "state_copy") return null;
  const name = path.basename(record.storage.ref);
  if (name === "" || name === "." || name === "..") return null;
  const dir = artifactDir(record.artifact_id);
  const expected = path.join(dir, name);
  // Defense in depth: the recorded resolved_path must equal the path the
  // index layout dictates (artifactDir is already traversal-safe).
  if (record.storage.resolved_path !== expected) return null;
  return expected;
}

export interface AnnotatedArtifact extends ArtifactRecord {
  /** Read-time integrity verdict: payload missing or unsafe. */
  missing_ref: boolean;
  /** Read-time owner staleness verdict (only when a live snapshot was consulted). */
  owner_stale: boolean;
  warnings: string[];
}

async function annotate(
  record: ArtifactRecord,
  livePaneIds: ReadonlySet<string> | null,
): Promise<AnnotatedArtifact> {
  const warnings = [...(record.warnings ?? [])];
  let missingRef = false;
  let oversize = record.oversize;

  if (record.storage.mode === "state_copy") {
    const expected = expectedStoredPath(record);
    if (expected === null) {
      missingRef = true;
      warnings.push("storage_ref_missing");
    } else {
      try {
        const info = await lstat(expected);
        // Symlinks inside the artifacts tree are never followed (ADR-0024 §2).
        if (info.isSymbolicLink() || !info.isFile()) {
          missingRef = true;
          warnings.push("storage_ref_missing");
        }
      } catch {
        missingRef = true;
        warnings.push("storage_ref_missing");
      }
    }
  } else {
    try {
      const info = await stat(record.storage.resolved_path);
      if (!info.isFile()) {
        missingRef = true;
        warnings.push("storage_ref_missing");
      } else if (info.size > MAX_BYTES[record.kind] && !oversize) {
        oversize = true;
        warnings.push("oversize");
      }
    } catch {
      missingRef = true;
      warnings.push("storage_ref_missing");
    }
  }

  let ownerStale = false;
  if (
    livePaneIds !== null &&
    record.owner.pane_id !== undefined &&
    !livePaneIds.has(record.owner.pane_id)
  ) {
    ownerStale = true;
    warnings.push("owner_stale");
  }

  return { ...record, oversize, missing_ref: missingRef, owner_stale: ownerStale, warnings };
}

function livePaneIdSet(snapshot: SessionSnapshot | null): ReadonlySet<string> | null {
  if (snapshot === null) return null;
  const ids = new Set<string>();
  for (const pane of snapshot.panes ?? []) {
    if (typeof pane.pane_id === "string") ids.add(pane.pane_id);
  }
  return ids;
}

/** Pane ids present in the live snapshot; null when unreachable. */
export function snapshotPaneIds(snapshot: SessionSnapshot): ReadonlySet<string> {
  return livePaneIdSet(snapshot) ?? new Set<string>();
}

/** Agent session value reported for a pane, when the snapshot has one. */
export function agentSessionForPane(snapshot: SessionSnapshot, paneId: string): string | undefined {
  const agent = snapshot.agents?.[paneId];
  const session = agent?.agent_session;
  if (typeof session === "object" && session !== null) {
    const value = (session as Record<string, unknown>).value;
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

export interface ListOptions {
  kind?: ArtifactKind | undefined;
  paneId?: string | undefined;
  /** Exact match on owner.agent_session. */
  agentSession?: string | undefined;
  /** Exact match on owner.created_by. */
  createdBy?: CreatedBy | undefined;
  /** Filter on the record's session name (not the live session). */
  session?: string | undefined;
  limit?: number | undefined;
  snapshot: SessionSnapshot | null;
}

const DEFAULT_LIMIT = 200;
const MAX_LISTED_ORPHANS = 100;

/** Ids of payload dirs under artifacts/ with no index record. */
async function orphanIds(indexed: ReadonlySet<string>): Promise<string[]> {
  const orphans: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(artifactsRoot());
  } catch {
    return orphans;
  }
  for (const name of entries) {
    if (!ARTIFACT_ID_PATTERN.test(name) || indexed.has(name)) continue;
    orphans.push(name);
    if (orphans.length >= MAX_LISTED_ORPHANS) break;
  }
  return orphans.sort();
}

function applyFilters(
  records: AnnotatedArtifact[],
  options: {
    kind?: ArtifactKind | undefined;
    paneId?: string | undefined;
    agentSession?: string | undefined;
    createdBy?: CreatedBy | undefined;
    session?: string | undefined;
  },
): AnnotatedArtifact[] {
  return records.filter((record) => {
    if (options.kind !== undefined && record.kind !== options.kind) return false;
    if (options.paneId !== undefined && record.owner.pane_id !== options.paneId) return false;
    if (options.agentSession !== undefined && record.owner.agent_session !== options.agentSession)
      return false;
    if (options.createdBy !== undefined && record.owner.created_by !== options.createdBy)
      return false;
    if (options.session !== undefined && record.session !== options.session) return false;
    return true;
  });
}

function sortNewestFirst(records: AnnotatedArtifact[]): AnnotatedArtifact[] {
  return records.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function listArtifacts(options: ListOptions): Promise<{
  artifacts: AnnotatedArtifact[];
  total: number;
  orphans: string[];
  corrupt: string[];
}> {
  const state = await loadState();
  const live = livePaneIdSet(options.snapshot);
  const annotated: AnnotatedArtifact[] = [];
  for (const record of Object.values(state.artifacts)) {
    annotated.push(await annotate(record, live));
  }
  const filtered = sortNewestFirst(applyFilters(annotated, options));
  const limit = options.limit ?? DEFAULT_LIMIT;
  const page = limit > 0 ? filtered.slice(0, limit) : filtered;
  return {
    artifacts: page,
    total: filtered.length,
    orphans: await orphanIds(new Set(Object.keys(state.artifacts))),
    corrupt: [...state.corrupt].sort(),
  };
}

export async function getArtifact(
  artifactId: string,
  snapshot: SessionSnapshot | null,
): Promise<AnnotatedArtifact> {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
    fail("artifact_not_found", "not_found", `unknown or malformed artifact_id: ${artifactId}`, {
      artifact_id: artifactId,
    });
  }
  const state = await loadState();
  const record = state.artifacts[artifactId];
  if (record === undefined) {
    fail("artifact_not_found", "not_found", `artifact not found: ${artifactId}`, {
      artifact_id: artifactId,
    });
  }
  return annotate(record, livePaneIdSet(snapshot));
}

export interface SearchOptions extends ListOptions {
  query: string;
  /** Inclusive lower bound on created_at (ISO-8601, validated by the CLI). */
  since?: string | undefined;
  /** Inclusive upper bound on created_at (ISO-8601, validated by the CLI). */
  until?: string | undefined;
}

/**
 * Free-text surface: identity, kind/mime, filename, owner fields, host,
 * session, and back-references — metadata only, never payload bytes
 * (issue #142: 検索は filename・metadata、content scan はしない).
 */
function searchableText(record: AnnotatedArtifact): string {
  return [
    record.artifact_id,
    record.title ?? "",
    record.kind,
    record.mime,
    record.session,
    record.host,
    path.basename(record.storage.ref),
    record.owner.pane_id ?? "",
    record.owner.agent_session ?? "",
    record.owner.created_by,
    ...(record.refs ?? []),
  ]
    .join("\n")
    .toLowerCase();
}

export async function searchArtifacts(options: SearchOptions): Promise<{
  artifacts: AnnotatedArtifact[];
  total: number;
  query: string;
  orphans: string[];
  corrupt: string[];
}> {
  const query = options.query.trim().toLowerCase();
  if (query === "") {
    fail("usage", "invalid", "search requires a non-empty query");
  }
  const state = await loadState();
  const live = livePaneIdSet(options.snapshot);
  const annotated: AnnotatedArtifact[] = [];
  for (const record of Object.values(state.artifacts)) {
    annotated.push(await annotate(record, live));
  }
  const filtered = sortNewestFirst(
    applyFilters(annotated, options).filter((record) => {
      if (!searchableText(record).includes(query)) return false;
      if (options.since !== undefined && record.created_at < options.since) return false;
      if (options.until !== undefined && record.created_at > options.until) return false;
      return true;
    }),
  );
  const limit = options.limit ?? DEFAULT_LIMIT;
  const page = limit > 0 ? filtered.slice(0, limit) : filtered;
  return {
    artifacts: page,
    total: filtered.length,
    query: options.query,
    orphans: await orphanIds(new Set(Object.keys(state.artifacts))),
    corrupt: [...state.corrupt].sort(),
  };
}

export interface DeleteResult {
  artifact_id: string;
  storage_mode: StorageMode;
  removed_payload: boolean;
}

/**
 * Delete one artifact: index record plus `state_copy` payload. Records
 * carrying `refs` (handoff/conversations/checkpoint back-references)
 * require `--force` — the refusal is structured (`referenced`), never a
 * silent delete. `path_ref` payloads are external files and are NEVER
 * removed by the plugin.
 */
export async function deleteArtifact(artifactId: string, force: boolean): Promise<DeleteResult> {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
    fail("artifact_not_found", "not_found", `unknown or malformed artifact_id: ${artifactId}`, {
      artifact_id: artifactId,
    });
  }
  const removed = await updateState((state) => {
    const record = state.artifacts[artifactId];
    if (record === undefined) {
      fail("artifact_not_found", "not_found", `artifact not found: ${artifactId}`, {
        artifact_id: artifactId,
      });
    }
    if (!force && record.refs !== undefined && record.refs.length > 0) {
      fail(
        "referenced",
        "warning",
        `artifact ${artifactId} is referenced (${record.refs.length} ref(s)); pass --force to delete`,
        { artifact_id: artifactId, refs: record.refs },
      );
    }
    delete state.artifacts[artifactId];
    return record;
  });

  // Payload cleanup happens after the index commit; a failure here leaves
  // a detectable orphan, which list reports honestly.
  let removedPayload = false;
  try {
    await rm(artifactDir(artifactId), { recursive: true, force: true });
    removedPayload = removed.storage.mode === "state_copy";
  } catch {
    removedPayload = false;
  }
  return {
    artifact_id: artifactId,
    storage_mode: removed.storage.mode,
    removed_payload: removedPayload,
  };
}

export type VerifyStatus = "ok" | "corrupt" | "missing";

/** Per-artifact integrity verdict produced by `verify` (issue #142). */
export interface ArtifactVerification {
  artifact_id: string;
  /**
   * `ok` — payload present and hash/size/mime/metadata all consistent;
   * `corrupt` — payload present but a check failed or the record's
   * storage metadata is inconsistent; `missing` — payload absent,
   * not a regular file, or unsafe (symlink inside the artifacts tree).
   */
  status: VerifyStatus;
  /** Structured issue codes explaining a non-ok status. */
  issues: string[];
  checks: {
    payload_exists: boolean;
    /** null when the payload could not be read. */
    sha256_match: boolean | null;
    size_match: boolean | null;
    mime_match: boolean | null;
  };
  /** The annotated record (same shape as `get`). */
  artifact: AnnotatedArtifact;
}

/**
 * Re-check one record against the filesystem: payload existence,
 * sha256 re-hash, size, re-sniffed MIME, storage-layout consistency,
 * and oversize-flag consistency. Register-time warnings are historical
 * facts and are NOT re-reported as verify issues — only current
 * inconsistencies are.
 */
async function verifyRecord(
  record: ArtifactRecord,
  live: ReadonlySet<string> | null,
): Promise<ArtifactVerification> {
  const annotated = await annotate(record, live);
  const issues: string[] = [];
  const checks: ArtifactVerification["checks"] = {
    payload_exists: false,
    sha256_match: null,
    size_match: null,
    mime_match: null,
  };

  // Storage-layout consistency is a metadata check independent of
  // payload readability.
  let metadataBroken = false;
  let payloadPath: string | null;
  if (record.storage.mode === "state_copy") {
    payloadPath = expectedStoredPath(record);
    if (payloadPath === null) {
      metadataBroken = true;
      issues.push("storage_ref_invalid");
    }
  } else {
    payloadPath = record.storage.resolved_path;
  }

  let actualSize: number | null = null;
  if (payloadPath !== null) {
    try {
      // state_copy payloads are lstat'ed so a symlink inside the
      // artifacts tree is never followed (ADR-0024 §2); path_ref
      // targets are external files and are stat'ed.
      const info =
        record.storage.mode === "state_copy" ? await lstat(payloadPath) : await stat(payloadPath);
      const usable =
        record.storage.mode === "state_copy"
          ? info.isFile() && !info.isSymbolicLink()
          : info.isFile();
      if (!usable) {
        issues.push("storage_ref_missing");
      } else {
        checks.payload_exists = true;
        actualSize = info.size;
        const [digest, head] = await Promise.all([sha256File(payloadPath), readHead(payloadPath)]);
        checks.sha256_match = digest === record.sha256;
        checks.size_match = info.size === record.size;
        checks.mime_match = sniffMime(head) === record.mime;
        if (checks.sha256_match === false) issues.push("sha256_mismatch");
        if (checks.size_match === false) issues.push("size_mismatch");
        if (checks.mime_match === false) issues.push("mime_drift");
      }
    } catch {
      issues.push("storage_ref_missing");
    }
  }

  // The oversize flag must agree with the best-known current size
  // (actual payload size when readable, recorded size otherwise).
  const effectiveSize = actualSize ?? record.size;
  if (effectiveSize > MAX_BYTES[record.kind] !== record.oversize) {
    issues.push("oversize_flag_inconsistent");
  }

  let status: VerifyStatus;
  if (metadataBroken) {
    status = "corrupt";
  } else if (!checks.payload_exists) {
    status = "missing";
  } else {
    status = issues.length === 0 ? "ok" : "corrupt";
  }
  return { artifact_id: record.artifact_id, status, issues, checks, artifact: annotated };
}

export interface VerifyOptions {
  /** Verify a single artifact; omit to verify the whole index. */
  artifactId?: string | undefined;
  snapshot: SessionSnapshot | null;
}

export async function verifyArtifacts(options: VerifyOptions): Promise<{
  results: ArtifactVerification[];
  summary: { total: number; ok: number; corrupt: number; missing: number };
  orphans: string[];
  /** Index ids whose persisted records failed parsing (same as list/search). */
  corrupt: string[];
}> {
  const state = await loadState();
  let records = Object.values(state.artifacts);
  if (options.artifactId !== undefined) {
    if (!ARTIFACT_ID_PATTERN.test(options.artifactId)) {
      fail(
        "artifact_not_found",
        "not_found",
        `unknown or malformed artifact_id: ${options.artifactId}`,
        {
          artifact_id: options.artifactId,
        },
      );
    }
    const record = state.artifacts[options.artifactId];
    if (record === undefined) {
      fail("artifact_not_found", "not_found", `artifact not found: ${options.artifactId}`, {
        artifact_id: options.artifactId,
      });
    }
    records = [record];
  }
  const live = livePaneIdSet(options.snapshot);
  const results: ArtifactVerification[] = [];
  for (const record of records) {
    results.push(await verifyRecord(record, live));
  }
  results.sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    corrupt: results.filter((r) => r.status === "corrupt").length,
    missing: results.filter((r) => r.status === "missing").length,
  };
  return {
    results,
    summary,
    orphans: await orphanIds(new Set(Object.keys(state.artifacts))),
    corrupt: [...state.corrupt].sort(),
  };
}

// --- Delivery (T4 #143, ADR-0024 §3) -----------------------------------------

/**
 * v1 "attachment": the artifact's stable absolute path embedded in text
 * delivered through `agent.prompt` (target = pane hosting a live agent)
 * or `pane.send_text` (target = plain pane; literal text, no Enter).
 * There is no structured attachment API in herdr protocol 22 — the gap
 * is an upstream Issue candidate, not worked around (ADR-0024 §3).
 */
export type DeliverTargetKind = "agent" | "pane";

export interface DeliverTarget {
  kind: DeliverTargetKind;
  paneId: string;
}

/** Transport seams; defaults hit the real herdr socket wrappers. */
export interface DeliverDeps {
  agentPrompt?: ((target: string, text: string) => Promise<unknown>) | undefined;
  paneSendText?: ((paneId: string, text: string) => Promise<unknown>) | undefined;
}

export interface DeliverOptions {
  artifactId: string;
  target: DeliverTarget;
  /** Optional free-text note appended to the delivery message. */
  note?: string | undefined;
  /** Live snapshot for target staleness checks (pane/agent existence). */
  snapshot: SessionSnapshot;
  /** Socket/session resolution for the default transports. */
  callOptions?: CallOptions | undefined;
  deps?: DeliverDeps | undefined;
}

export interface DeliverResult {
  artifact_id: string;
  target: { kind: DeliverTargetKind; pane_id: string };
  /** Wire method used: `agent.prompt` or `pane.send_text`. */
  method: "agent.prompt" | "pane.send_text";
  /** The exact text sent — auditable, never fabricated. */
  message: string;
  artifact: AnnotatedArtifact;
}

/**
 * Assemble the delivery text: a provenance-tagged header, the stable
 * absolute path on its own line (the v1 attachment), and minimal
 * metadata an agent needs to sanity-check what it is being handed.
 */
export function buildDeliveryText(record: ArtifactRecord, note?: string): string {
  const title = record.title !== undefined ? ` "${record.title}"` : "";
  const lines = [
    `[artifacts] ${record.artifact_id} — ${record.kind} artifact${title}`,
    `path: ${record.storage.resolved_path}`,
    `mime: ${record.mime} · size: ${record.size} bytes · sha256: ${record.sha256}`,
  ];
  if (note !== undefined && note !== "") lines.push(`note: ${note}`);
  return lines.join("\n");
}

function rpcCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/**
 * Deliver one artifact's path reference to a pane or its agent.
 *
 * Refusals (all structured, never silent):
 * - `artifact_not_found` — unknown/malformed id (from getArtifact).
 * - `missing_ref` — payload absent/unsafe; delivering a dead path
 *   would fabricate a usable attachment, so it is refused.
 * - `target_not_found` — pane id absent from the live snapshot (stale
 *   or wrong-session pane; never deliver into the void).
 * - `agent_not_found` — `--agent` target pane has no live agent in the
 *   snapshot (`agent.prompt` would be meaningless).
 * - `delivery_failed` — herdr rejected or the transport failed; the
 *   upstream RPC `code` (e.g. `agent_blocked`) is preserved in
 *   `rpc_code`.
 *
 * Delivery is side-effect free on the index: the sent text lives in
 * pane/agent scrollback, which is not durable state the plugin owns,
 * so no `refs` entry is fabricated (AGENTS §4).
 */
export async function deliverArtifact(options: DeliverOptions): Promise<DeliverResult> {
  const artifact = await getArtifact(options.artifactId, options.snapshot);
  if (artifact.missing_ref) {
    fail(
      "missing_ref",
      "not_found",
      `artifact ${options.artifactId} payload is missing; refusing to deliver a dead path`,
      {
        artifact_id: options.artifactId,
        warnings: artifact.warnings,
      },
    );
  }

  const paneId = options.target.paneId;
  const pane = (options.snapshot.panes ?? []).find((p) => p.pane_id === paneId);
  if (pane === undefined) {
    fail(
      "target_not_found",
      "not_found",
      `deliver target pane not present in live session: ${paneId}`,
      { pane_id: paneId, target_kind: options.target.kind },
    );
  }
  if (options.target.kind === "agent" && options.snapshot.agents?.[paneId] === undefined) {
    fail("agent_not_found", "not_found", `deliver target pane has no live agent: ${paneId}`, {
      pane_id: paneId,
      target_kind: options.target.kind,
    });
  }

  const message = buildDeliveryText(artifact, options.note);
  const callOptions = options.callOptions ?? {};
  const sendAgent =
    options.deps?.agentPrompt ??
    ((target: string, text: string) => agentPrompt(target, text, undefined, callOptions));
  const sendPane =
    options.deps?.paneSendText ??
    ((id: string, text: string) => paneSendText(id, text, callOptions));

  try {
    if (options.target.kind === "agent") {
      await sendAgent(paneId, message);
    } else {
      await sendPane(paneId, message);
    }
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    const code = rpcCode(err);
    fail(
      "delivery_failed",
      "unavailable",
      `deliver send failed for pane ${paneId}: ${err instanceof Error ? err.message : String(err)}`,
      {
        pane_id: paneId,
        target_kind: options.target.kind,
        ...(code !== undefined ? { rpc_code: code } : {}),
      },
    );
  }

  return {
    artifact_id: artifact.artifact_id,
    target: { kind: options.target.kind, pane_id: paneId },
    method: options.target.kind === "agent" ? "agent.prompt" : "pane.send_text",
    message,
    artifact,
  };
}

// --- Retention (T4 #143) -------------------------------------------------------

export interface GcOptions {
  /** ISO-8601; artifacts with created_at strictly before this are expired. */
  olderThan: string;
  /** Report only — no index or payload mutation. */
  dryRun: boolean;
}

export type GcAction = "deleted" | "would_delete" | "skipped";

export interface GcEntry {
  artifact_id: string;
  action: GcAction;
  /** Why a candidate was not deleted. */
  reason?: "referenced" | "invalid_created_at" | "delete_failed";
  storage_mode?: StorageMode;
  removed_payload?: boolean;
  error?: string;
}

export interface GcResult {
  policy: { older_than: string };
  dry_run: boolean;
  evaluated: number;
  expired: number;
  entries: GcEntry[];
  totals: {
    evaluated: number;
    expired: number;
    deleted: number;
    would_delete: number;
    skipped_referenced: number;
    skipped_other: number;
    kept: number;
    errors: number;
  };
  orphans: string[];
  corrupt: string[];
}

/**
 * `gc` — bounded retention for artifact records (contract v1, same
 * shape as checkpoints gc). Candidates are records whose `created_at`
 * is strictly before `--older-than`; among those, records carrying
 * `refs` (handoff/conversations/checkpoint back-references) are NEVER
 * collected — they are reported `skipped`/`referenced` and require an
 * explicit `delete --force`. `path_ref` records lose only their index
 * entry; external files are never removed by the plugin.
 *
 * Unparseable `created_at` is treated as not-provably-expired and
 * skipped — retention never guesses. Orphan payload dirs (no index
 * record) are reported via `orphans`, not collected: without a record
 * there is no honest age/ownership evidence. `--dry-run` performs the
 * full evaluation without mutating anything.
 *
 * gc needs no live herdr session — it is pure plugin-state work.
 */
export async function gcArtifacts(options: GcOptions): Promise<GcResult> {
  const threshold = Date.parse(options.olderThan);
  if (Number.isNaN(threshold)) {
    fail("usage", "invalid", `--older-than must be an ISO-8601 timestamp: ${options.olderThan}`);
  }
  const state = await loadState();
  const records = Object.values(state.artifacts);

  const entries: GcEntry[] = [];
  const totals = {
    evaluated: records.length,
    expired: 0,
    deleted: 0,
    would_delete: 0,
    skipped_referenced: 0,
    skipped_other: 0,
    kept: 0,
    errors: 0,
  };

  const candidates: ArtifactRecord[] = [];
  for (const record of records) {
    const created = Date.parse(record.created_at);
    if (Number.isNaN(created)) {
      entries.push({
        artifact_id: record.artifact_id,
        action: "skipped",
        reason: "invalid_created_at",
        storage_mode: record.storage.mode,
      });
      totals.skipped_other += 1;
      continue;
    }
    if (created >= threshold) {
      totals.kept += 1;
      continue;
    }
    totals.expired += 1;
    if (record.refs !== undefined && record.refs.length > 0) {
      entries.push({
        artifact_id: record.artifact_id,
        action: "skipped",
        reason: "referenced",
        storage_mode: record.storage.mode,
      });
      totals.skipped_referenced += 1;
      continue;
    }
    candidates.push(record);
  }

  if (options.dryRun) {
    for (const record of candidates) {
      entries.push({
        artifact_id: record.artifact_id,
        action: "would_delete",
        storage_mode: record.storage.mode,
      });
      totals.would_delete += 1;
    }
  } else {
    for (const record of candidates) {
      try {
        const removed = await deleteArtifact(record.artifact_id, false);
        entries.push({
          artifact_id: record.artifact_id,
          action: "deleted",
          storage_mode: removed.storage_mode,
          removed_payload: removed.removed_payload,
        });
        totals.deleted += 1;
      } catch (err) {
        entries.push({
          artifact_id: record.artifact_id,
          action: "skipped",
          reason: "delete_failed",
          storage_mode: record.storage.mode,
          error: err instanceof Error ? err.message : String(err),
        });
        totals.errors += 1;
      }
    }
  }

  entries.sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
  return {
    policy: { older_than: options.olderThan },
    dry_run: options.dryRun,
    evaluated: records.length,
    expired: totals.expired,
    entries,
    totals,
    orphans: await orphanIds(new Set(Object.keys(state.artifacts))),
    corrupt: [...state.corrupt].sort(),
  };
}
