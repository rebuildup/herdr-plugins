/**
 * Persistent project registry for rebuildup.projects.
 *
 * Stored as a single JSON document under the plugin state dir
 * (`HERDR_PLUGIN_STATE_DIR`, falling back to the platform state dir for
 * external clients). The registry is host-global — projects span herdr
 * sessions — so entries are NOT namespaced per session (unlike inbox
 * organize state). Writes are serialized through an exclusive lock file
 * and committed via tmp+rename (AGENTS §4).
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/socket";

export const PLUGIN_ID = "rebuildup.projects";
export const STATE_SCHEMA_VERSION = 1;
export const SETTINGS_SCHEMA_VERSION = 1;

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

export interface ProjectRepo {
  /** Absolute repo root (worktree root for linked worktrees). */
  root: string;
  /** Normalized remote identity (host/path), null when no remote. */
  remote: string | null;
  added_at: string;
}

export interface Project {
  id: string;
  title: string;
  repos: ProjectRepo[];
  pinned: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Pending auto-trigger mark recorded by `src/hook.ts` (#180). One mark
 * per delivered `worktree.created` hook event; drained lazily by the
 * next `scripts`-family CLI invocation (no daemon, ADR-0002 — same
 * mark+drain shape as plugins/automations #146 and plugins/checkpoints
 * auto-capture).
 */
export interface PendingTriggerMark {
  /** Canonical dotted event name; v1 only records `worktree.created`. */
  event: string;
  received_at: string;
  /**
   * Socket the emitting herdr session resolved to at hook time
   * (`HERDR_SOCKET_PATH`/session resolution). The drain runs triggered
   * scripts against THIS socket — the session that owns the worktree —
   * regardless of which session the draining CLI targets.
   */
  socket_path: string;
  /** Absolute checkout path from the event's `worktree.path`. */
  worktree_path: string;
  /** `workspace.workspace_id` from the event payload, when present. */
  workspace_id: string | null;
  /** Raw event `data` payload, kept for audit/future triggers. */
  data: Record<string, unknown>;
}

export interface ProjectsState {
  version: typeof STATE_SCHEMA_VERSION;
  projects: Record<string, Project>;
  /**
   * Undrained auto-trigger marks. Optional on disk — registries written
   * before #180 lack the fields and load as empty/zero.
   */
  pending_triggers?: PendingTriggerMark[];
  /** Count of marks dropped at the pending-triggers cap. */
  pending_triggers_dropped?: number;
  /**
   * Drained inbox organize-transition cursors (#182, ADR-0029), keyed by
   * the inbox `session_key` verbatim (`hostname + canonical socket`) —
   * projects never recomputes inbox's key itself. Value is the last
   * `head_seq` fully processed; absent means "never drained" (the first
   * drain consumes the retained log).
   */
  settle_cursors?: Record<string, number>;
}

export function emptyState(): ProjectsState {
  return { version: STATE_SCHEMA_VERSION, projects: {} };
}

export function stateFilePath(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "state.json");
}

function lockPath(): string {
  return `${stateFilePath()}.lock`;
}

/**
 * Project-scoped settings override keys the plugin will store. Mirrors the
 * upstream project-scoped surface relevant to scripts/display; arbitrary
 * keys are rejected so the store cannot become a dumping ground for
 * unrelated server settings. Extend additively as consumers land.
 */
export const SETTINGS_ALLOW_LIST: ReadonlySet<string> = new Set([
  "defaultProjectScripts",
  "defaultThreadEnvMode",
  "worktreeSubmodules",
  "worktreeCleanup",
  "display.title",
  "display.iconPath",
]);

export async function loadState(): Promise<ProjectsState> {
  try {
    const raw = await readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectsState>;
    if (
      parsed.version !== STATE_SCHEMA_VERSION ||
      typeof parsed.projects !== "object" ||
      parsed.projects === null
    ) {
      return emptyState();
    }
    // Pending trigger marks are best-effort backlog: malformed entries
    // are dropped individually rather than failing the whole registry.
    const pendingRaw = Array.isArray(parsed.pending_triggers) ? parsed.pending_triggers : undefined;
    const pendingTriggers = (pendingRaw ?? []).filter(
      (m): m is PendingTriggerMark =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as PendingTriggerMark).event === "string" &&
        typeof (m as PendingTriggerMark).worktree_path === "string" &&
        typeof (m as PendingTriggerMark).socket_path === "string",
    );
    const dropped = parsed.pending_triggers_dropped;
    const settleCursorsRaw =
      typeof parsed.settle_cursors === "object" && parsed.settle_cursors !== null
        ? parsed.settle_cursors
        : undefined;
    const settleCursors: Record<string, number> = {};
    if (settleCursorsRaw !== undefined) {
      for (const [key, value] of Object.entries(settleCursorsRaw)) {
        if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
          settleCursors[key] = value;
        }
      }
    }
    return {
      version: STATE_SCHEMA_VERSION,
      projects: parsed.projects,
      pending_triggers: pendingTriggers,
      pending_triggers_dropped:
        typeof dropped === "number" && Number.isInteger(dropped) && dropped >= 0 ? dropped : 0,
      ...(Object.keys(settleCursors).length > 0 ? { settle_cursors: settleCursors } : {}),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
}

async function acquireLock(file: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      return async () => {
        await rm(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const info = await stat(file);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(file, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("projects state lock timed out; another command may be running");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Read-modify-write under the exclusive lock; mutations must be synchronous. */
export async function updateState<T>(mutate: (state: ProjectsState) => T | Promise<T>): Promise<T> {
  const release = await acquireLock(lockPath());
  try {
    const state = await loadState();
    const result = await mutate(state);
    await mkdir(path.dirname(stateFilePath()), { recursive: true });
    const tmp = `${stateFilePath()}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, stateFilePath());
    return result;
  } finally {
    await release();
  }
}

// --- Project settings overrides -------------------------------------------
//
// One JSON document per project under `<stateDir>/settings/<id>.json`,
// same single-writer lock + tmp+rename discipline as the registry. Values
// are stored verbatim as strings; typed interpretation belongs to the
// consumer (#50 scripts resolution).

export type ProjectSettings = Record<string, string>;

interface SettingsFile {
  version: number;
  settings: ProjectSettings;
}

export function settingsFilePath(projectId: string): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "settings", `${projectId}.json`);
}

function settingsLockPath(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "settings.lock");
}

export async function loadSettings(projectId: string): Promise<ProjectSettings> {
  let raw: string;
  try {
    raw = await readFile(settingsFilePath(projectId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  // Overrides are non-authoritative: a corrupt file reads as empty rather
  // than failing every command that consults it.
  let parsed: Partial<SettingsFile> | null;
  try {
    parsed = JSON.parse(raw) as Partial<SettingsFile> | null;
  } catch {
    return {};
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.settings !== "object" ||
    parsed.settings === null
  ) {
    return {};
  }
  return parsed.settings;
}

export async function updateSettings<T>(
  projectId: string,
  mutate: (settings: ProjectSettings) => T,
): Promise<T> {
  const release = await acquireLock(settingsLockPath());
  try {
    const settings = await loadSettings(projectId);
    const result = mutate(settings);
    const file: SettingsFile = { version: SETTINGS_SCHEMA_VERSION, settings };
    const target = settingsFilePath(projectId);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
    await rename(tmp, target);
    return result;
  } finally {
    await release();
  }
}
