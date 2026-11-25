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

export interface ProjectsState {
  version: typeof STATE_SCHEMA_VERSION;
  projects: Record<string, Project>;
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
    return { version: STATE_SCHEMA_VERSION, projects: parsed.projects };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
}

async function acquireLock(): Promise<() => Promise<void>> {
  const file = lockPath();
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
  const release = await acquireLock();
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
