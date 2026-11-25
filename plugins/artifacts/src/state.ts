/**
 * Persistent artifact registry state for rebuildup.artifacts.
 *
 * Stored under the plugin state dir (`HERDR_PLUGIN_STATE_DIR`, falling
 * back to the platform state dir for external clients):
 *
 *   state.json            — the artifact index (one JSON document)
 *   artifacts/<id>/       — `state_copy` payload bytes
 *
 * Writes are serialized through an exclusive lock file and committed
 * via tmp+rename so concurrent CLI invocations cannot corrupt or
 * interleave state — same discipline as plugins/handoff and
 * plugins/checkpoints (AGENTS §4). Payload copies are written to a
 * tmp name inside the artifact dir and renamed into place.
 *
 * Records that fail `parseArtifactRecord` are quarantined into
 * `state.corrupt` (id list) so reads can report them honestly instead
 * of failing the whole index or silently succeeding.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/socket";
import {
  ARTIFACT_ID_PATTERN,
  type ArtifactRecord,
  PLUGIN_ID as MODEL_PLUGIN_ID,
  parseArtifactRecord,
  STATE_SCHEMA_VERSION,
} from "./model";

export const PLUGIN_ID = MODEL_PLUGIN_ID;

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

export interface ArtifactsState {
  version: typeof STATE_SCHEMA_VERSION;
  artifacts: Record<string, ArtifactRecord>;
  /** Ids whose persisted record failed parsing (reported, never hidden). */
  corrupt: string[];
}

export function emptyState(): ArtifactsState {
  return { version: STATE_SCHEMA_VERSION, artifacts: {}, corrupt: [] };
}

export function stateFilePath(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "state.json");
}

/** Root of the `state_copy` payload tree: `<stateDir>/artifacts/`. */
export function artifactsRoot(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "artifacts");
}

/**
 * Directory for one artifact's payload. Callers MUST have validated
 * `artifact_id` against ARTIFACT_ID_PATTERN first — the pattern admits
 * no separators, so the result can never escape `artifactsRoot()`.
 */
export function artifactDir(artifactId: string): string {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
    throw new Error(`refusing unsafe artifact_id: ${artifactId}`);
  }
  return path.join(artifactsRoot(), artifactId);
}

function lockPath(): string {
  return `${stateFilePath()}.lock`;
}

export async function loadState(): Promise<ArtifactsState> {
  try {
    const raw = await readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ArtifactsState>;
    if (
      parsed.version !== STATE_SCHEMA_VERSION ||
      typeof parsed.artifacts !== "object" ||
      parsed.artifacts === null
    ) {
      return emptyState();
    }
    const state = emptyState();
    for (const [id, value] of Object.entries(parsed.artifacts)) {
      const record = parseArtifactRecord(value);
      if (record !== null && record.artifact_id === id) {
        state.artifacts[id] = record;
      } else {
        state.corrupt.push(id);
      }
    }
    return state;
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
        throw new Error("artifacts state lock timed out; another command may be running");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Read-modify-write under the exclusive lock; mutations must be synchronous. */
export async function updateState<T>(
  mutate: (state: ArtifactsState) => T | Promise<T>,
): Promise<T> {
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
