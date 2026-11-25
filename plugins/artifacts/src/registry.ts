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
  const lower = text.slice(0, 1024).toLowerCase();
  const trimmed = lower.replace(/^﻿/, "").trimStart();
  if (/<!doctype html|<html[\s>]/.test(trimmed)) return "text/html";
  if (/^<\?xml[\s?]/.test(trimmed) && lower.includes("<svg")) return "image/svg+xml";
  if (trimmed.startsWith("<svg")) return "image/svg+xml";
  return "text/plain";
}

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

  // HTML shape validation is a refusal (upstream HtmlRender rules); other
  // kinds record a mime_mismatch warning instead of failing.
  if (kind === "html" && mime !== "text/html") {
    fail("mime_mismatch", "invalid", `kind 'html' requires HTML leading bytes; sniffed ${mime}`, {
      sniffed_mime: mime,
      artifact_kind: kind,
    });
  }
  const expectedImage = kind === "image" && !mime.startsWith("image/") && mime !== "image/svg+xml";
  const expectedPdf = kind === "pdf" && mime !== "application/pdf";
  if (
    (expectedImage || expectedPdf) &&
    mime !== "text/plain" &&
    mime !== "application/octet-stream"
  ) {
    warnings.push("mime_mismatch");
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
    session?: string | undefined;
  },
): AnnotatedArtifact[] {
  return records.filter((record) => {
    if (options.kind !== undefined && record.kind !== options.kind) return false;
    if (options.paneId !== undefined && record.owner.pane_id !== options.paneId) return false;
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
  since?: string | undefined;
}

function searchableText(record: AnnotatedArtifact): string {
  return [
    record.artifact_id,
    record.title ?? "",
    record.kind,
    record.mime,
    record.session,
    path.basename(record.storage.ref),
    record.owner.pane_id ?? "",
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
