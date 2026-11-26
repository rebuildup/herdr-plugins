/**
 * Persistent organize state for the inbox plugin.
 *
 * Stored as a single JSON document under the plugin state dir
 * (`HERDR_PLUGIN_STATE_DIR`, falling back to the platform state dir for
 * external clients). Writes are serialized through an exclusive lock file and
 * committed via tmp+rename so concurrent CLI/hook invocations cannot corrupt
 * or interleave state.
 */

import { realpathSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pluginDirs, resolveSocketPath } from "../../../packages/herdr-client/src/socket";

export const PLUGIN_ID = "rebuildup.inbox";
export const STATE_SCHEMA_VERSION = 2;

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

export interface AgentSessionRef {
  agent?: string;
  kind?: string;
  value?: string;
}

/**
 * Generation-guarded organize mark: clears when the pane's agent session
 * fingerprint changes or `state_change_seq` advances (auto-restore on a new
 * agent generation — see docs/specs/inbox.md).
 */
export interface GenerationMark {
  at: string;
  /** state_change_seq observed when the mark was applied. */
  seq: number;
  agent_session?: AgentSessionRef | null;
}

export interface SettledMark extends GenerationMark {}

export interface SnoozedMark extends GenerationMark {
  until: string;
}

export interface ArchivedMark extends GenerationMark {}

export interface PinnedMark extends GenerationMark {}

export type LinkKind = "pr" | "issue";

/**
 * User-declared tracker reference ("this pane is working on repo#n").
 * Unlike organize marks this is NOT a timed hide: it survives routine
 * `state_change_seq` advances (status transitions) and is guarded only by
 * the agent-session fingerprint plus a seq-regression check — see
 * docs/specs/inbox.md → Explicit tracker links.
 */
export interface PaneLink {
  kind: LinkKind;
  /** Forge repo path as declared, e.g. "owner/name" (subgroups allowed). */
  repo: string;
  number: number;
  /** Canonical display ref "<repo>#<number>". */
  ref: string;
  /** ISO timestamp the link was (re)declared. */
  at: string;
  /** state_change_seq observed at link time; regression means identity reuse. */
  seq: number;
  agent_session?: AgentSessionRef | null;
}

export interface InboxEntry {
  pane_id: string;
  workspace_id?: string | undefined;
  settled?: SettledMark | undefined;
  snoozed?: SnoozedMark | undefined;
  archived?: ArchivedMark | undefined;
  pinned?: PinnedMark | undefined;
  /**
   * Manual order rank (lower sorts first). A layout hint scoped to the pane
   * id — not generation-guarded; cleared by `restore`, `pane.closed`, and
   * retention pruning like every other organize field.
   */
  order?: number | undefined;
  /**
   * User-declared PR/Issue links. Not generation-guarded like organize
   * marks (see PaneLink); resolved for staleness at read time and dropped
   * with the entry on `pane.closed`/retention pruning.
   */
  links?: PaneLink[] | undefined;
  updated_at: string;
}

/**
 * Organize-transition kinds recorded in the per-session log (#182,
 * ADR-0029). `cleared` covers every non-user removal path; `cause`
 * distinguishes them. `pin`/`unpin`/`archive`/`unarchive` are layout or
 * hide-kind mutations outside this enum and are not recorded — the log
 * exists so consumers (rebuildup.projects settle triggers) can observe
 * settle/restore intent, not to mirror every organize write.
 */
export type TransitionKind = "settled" | "snoozed" | "restored" | "cleared";

/** Why an organize mark was cleared without an explicit user restore. */
export type ClearedCause = "expired" | "generation" | "session_mismatch" | "pane_closed" | "pruned";

/**
 * One recorded organize transition. Fields beyond `kind`/`pane_id` are
 * captured from the pane+agent snapshot already loaded by the mutating
 * command — no extra socket calls, no PTY text. `seq` is the per-session
 * monotonic cursor (1-based, gapless until retention drops).
 */
export interface InboxTransition {
  seq: number;
  at: string;
  kind: TransitionKind;
  pane_id: string;
  workspace_id?: string | undefined;
  cwd?: string | undefined;
  agent_status?: string | undefined;
  state_change_seq?: number | undefined;
  agent_session?: AgentSessionRef | null | undefined;
  /** `cleared` transitions only. */
  cause?: ClearedCause | undefined;
}

/**
 * Bounded per-session transition log. `seq` is the highest issued
 * sequence number (the head cursor); `items` is capped at
 * MAX_TRANSITIONS_PER_SESSION with the oldest dropped into `dropped`.
 */
export interface TransitionLog {
  seq: number;
  dropped: number;
  items: InboxTransition[];
}

/**
 * State is namespaced per herdr session AND per host. The session key is
 * `hostname + canonical socket path`: pane ids are only unique within one
 * session (`w1:p1` exists in every session), and a state file shared across
 * hosts (synced home dir, forwarded socket) must not merge organize marks.
 * The same key namespaces `transitions`.
 */
export interface InboxState {
  version: typeof STATE_SCHEMA_VERSION;
  sessions: Record<string, Record<string, InboxEntry>>;
  /**
   * Organize-transition log per session key (additive, #182/ADR-0029).
   * Optional on disk — state files written before the surface lack it.
   */
  transitions?: Record<string, TransitionLog>;
}

export function emptyState(): InboxState {
  return { version: STATE_SCHEMA_VERSION, sessions: {} };
}

/** Inner per-session entry map, created on demand for writes. */
export function sessionEntries(state: InboxState, sessionKey: string): Record<string, InboxEntry> {
  const entries = state.sessions[sessionKey];
  if (entries) return entries;
  const created: Record<string, InboxEntry> = {};
  state.sessions[sessionKey] = created;
  return created;
}

/**
 * Session discriminator for state namespacing: hostname plus the canonical
 * (symlink-resolved) socket path the command will talk to. Socket path is
 * the only session identity the socket API exposes; canonicalization keeps
 * `/var` vs `/private/var` spellings of the same socket identical.
 */
export function sessionKeyFor(options: {
  session?: string | undefined;
  socketPath?: string | undefined;
}): string {
  const socketPath = options.socketPath ?? resolveSocketPath({ session: options.session });
  let canonical = socketPath;
  try {
    canonical = realpathSync(socketPath);
  } catch {
    canonical = path.resolve(socketPath);
  }
  return `${os.hostname()} ${canonical}`;
}

export function stateFilePath(): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "state.json");
}

function lockPath(): string {
  return `${stateFilePath()}.lock`;
}

export async function loadState(): Promise<InboxState> {
  try {
    const raw = await readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<InboxState>;
    if (
      parsed.version !== STATE_SCHEMA_VERSION ||
      typeof parsed.sessions !== "object" ||
      parsed.sessions === null
    ) {
      return emptyState();
    }
    // The transition log is append-only audit data: keep entries that
    // look well-formed, drop malformed ones individually.
    const transitionsRaw =
      typeof parsed.transitions === "object" && parsed.transitions !== null
        ? parsed.transitions
        : undefined;
    const transitions: Record<string, TransitionLog> = {};
    if (transitionsRaw !== undefined) {
      for (const [key, log] of Object.entries(transitionsRaw)) {
        if (
          typeof log === "object" &&
          log !== null &&
          typeof (log as TransitionLog).seq === "number" &&
          Array.isArray((log as TransitionLog).items)
        ) {
          const l = log as TransitionLog;
          transitions[key] = {
            seq: l.seq,
            dropped: typeof l.dropped === "number" ? l.dropped : 0,
            items: l.items.filter(
              (t): t is InboxTransition =>
                typeof t === "object" &&
                t !== null &&
                typeof (t as InboxTransition).seq === "number" &&
                typeof (t as InboxTransition).kind === "string" &&
                typeof (t as InboxTransition).pane_id === "string",
            ),
          };
        }
      }
    }
    return {
      version: STATE_SCHEMA_VERSION,
      sessions: parsed.sessions,
      ...(Object.keys(transitions).length > 0 ? { transitions } : {}),
    };
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
        throw new Error("inbox state lock timed out; another command may be running");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Read-modify-write under the exclusive lock; mutations must be synchronous. */
export async function updateState<T>(mutate: (state: InboxState) => T | Promise<T>): Promise<T> {
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
