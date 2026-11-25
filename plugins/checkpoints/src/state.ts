/**
 * Persistent checkpoint registry for rebuildup.checkpoints.
 *
 * Stored as a single JSON document under the plugin state dir
 * (`HERDR_PLUGIN_STATE_DIR`, falling back to the platform state dir for
 * external clients). Checkpoints are host-global records that reference
 * hidden git refs inside each repository's own object store — the state
 * file is only the index, never the payload. Writes are serialized
 * through an exclusive lock file and committed via tmp+rename
 * (AGENTS §4), same shape as rebuildup.projects.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/socket";

export const PLUGIN_ID = "rebuildup.checkpoints";
export const STATE_SCHEMA_VERSION = 1;

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

/**
 * One captured worktree state. `ref` is the hidden git ref holding the
 * synthetic commit; `commit` is that commit's oid (verified against the
 * ref at read time — a ref that moved or vanished is reported, never
 * silently trusted).
 */
export interface CheckpointEntry {
  /** Short unique id, also the last ref path component. */
  id: string;
  /** Canonical (realpath) repository root the checkpoint belongs to. */
  repo_root: string;
  /** Deterministic repo key: sha256(repo_root) hex, first 16 chars. */
  repo_key: string;
  /** Full hidden ref, e.g. refs/herdr-plugins/checkpoints/<key>/<id>. */
  ref: string;
  /** Synthetic commit oid the ref pointed at capture time. */
  commit: string;
  /** HEAD commit the checkpoint was parented to. */
  head_sha: string;
  /** Branch name at capture; null when HEAD was detached. */
  branch: string | null;
  /** ISO-8601 capture timestamp. */
  created_at: string;
  label?: string | undefined;
  /**
   * Bounded `git diff --name-status head commit` output captured at
   * create time; null fields mean "not computed / truncated away".
   */
  files_summary?: string | undefined;
  files_summary_truncated?: boolean | undefined;
  /** Paths of gitlinks (submodules) recorded in the checkpoint tree. */
  submodules?: string[] | undefined;
}

export interface CheckpointsState {
  version: typeof STATE_SCHEMA_VERSION;
  checkpoints: Record<string, CheckpointEntry>;
}

export function emptyState(): CheckpointsState {
  return { version: STATE_SCHEMA_VERSION, checkpoints: {} };
}

export function stateFilePath(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "state.json");
}

function lockPath(): string {
  return `${stateFilePath()}.lock`;
}

export async function loadState(): Promise<CheckpointsState> {
  try {
    const raw = await readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CheckpointsState>;
    if (
      parsed.version !== STATE_SCHEMA_VERSION ||
      typeof parsed.checkpoints !== "object" ||
      parsed.checkpoints === null
    ) {
      return emptyState();
    }
    return { version: STATE_SCHEMA_VERSION, checkpoints: parsed.checkpoints };
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
        throw new Error("checkpoints state lock timed out; another command may be running");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Read-modify-write under the exclusive lock; mutations must be synchronous. */
export async function updateState<T>(
  mutate: (state: CheckpointsState) => T | Promise<T>,
): Promise<T> {
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
