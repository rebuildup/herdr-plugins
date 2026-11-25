/**
 * Shared contract constants and record types for
 * rebuildup.artifacts (`herdr-plugins.artifacts/v1`, DRAFT — ADR-0024).
 *
 * T1 (#136) ships the contract skeleton only: identity, kinds, storage
 * modes, and size caps are fixed here so T2–T4 implement against them.
 */

export const PLUGIN_ID = "rebuildup.artifacts";
export const CONTRACT = "herdr-plugins.artifacts/v1";
/** Contract maturity: "draft" until T4 (#143) stabilizes v1. */
export const CONTRACT_STATUS = "draft";
export const PLUGIN_VERSION = "0.1.0";

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

/** Planned registry commands (contract skeleton; T2–T4 implement). */
export const PLANNED_COMMANDS = [
  "register",
  "list",
  "get",
  "search",
  "verify",
  "delete",
  "deliver",
  "gc",
] as const;

/** Implemented commands in this draft revision. */
export const IMPLEMENTED_COMMANDS = ["capability", "help"] as const;
