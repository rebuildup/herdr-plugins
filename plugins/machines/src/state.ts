/**
 * Probe-metadata cache for `rebuildup.machines` (#161, ADR-0028 §3).
 *
 * Stores only last-probe metadata per machine id — timestamps,
 * reachability, remote version/protocol, plugin surface. Never
 * credential-adjacent. Single JSON document under the plugin state dir
 * (`HERDR_PLUGIN_STATE_DIR`, platform state dir fallback for external
 * clients); writes serialized through an exclusive lock file and
 * committed via tmp+rename (same discipline as rebuildup.inbox).
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/socket";
import { type MachineProbe, PLUGIN_ID, STATE_SCHEMA_VERSION } from "./model";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

export interface MachinesState {
  version: typeof STATE_SCHEMA_VERSION;
  /** Last probe result per machine id. */
  probes: Record<string, MachineProbe>;
}

export function emptyState(): MachinesState {
  return { version: STATE_SCHEMA_VERSION, probes: {} };
}

export function stateFilePath(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "state.json");
}

function lockPath(): string {
  return `${stateFilePath()}.lock`;
}

export async function loadState(): Promise<MachinesState> {
  try {
    const raw = await readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<MachinesState>;
    if (
      parsed.version !== STATE_SCHEMA_VERSION ||
      typeof parsed.probes !== "object" ||
      parsed.probes === null
    ) {
      return emptyState();
    }
    return { version: STATE_SCHEMA_VERSION, probes: parsed.probes };
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
        throw new Error("machines state lock timed out; another command may be running");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Read-modify-write under the exclusive lock; mutations must be synchronous. */
export async function updateState<T>(mutate: (state: MachinesState) => T | Promise<T>): Promise<T> {
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

/** Record (or overwrite) the last probe result for a machine id. */
export async function recordProbe(probe: MachineProbe): Promise<void> {
  await updateState((state) => {
    state.probes[probe.machine_id] = probe;
    return probe.machine_id;
  });
}
