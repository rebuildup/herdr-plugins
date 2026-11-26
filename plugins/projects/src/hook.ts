/**
 * Event-hook entrypoint for rebuildup.projects (#180). herdr invokes
 * this command once per `[[events]]` manifest hook with
 * HERDR_PLUGIN_EVENT and HERDR_PLUGIN_EVENT_JSON set.
 *
 * v1 subscribes ONLY `worktree.created`: the hook appends a
 * `PendingTriggerMark` to `state.json` and does NO socket work, NO git,
 * NO script execution — it must stay fast and must never affect herdr
 * (ADR-0002, same contract as plugins/automations/src/hook.ts and
 * plugins/checkpoints/src/hook.ts):
 *
 * - `worktree.created` (`worktree_created` on the wire) with a
 *   resolvable `worktree.path` → one pending mark keyed by
 *   event+session socket+worktree path (duplicate deliveries collapse).
 * - Missing/invalid payloads and every other event name → exit 0,
 *   nothing recorded. Events herdr never delivered never exist.
 *
 * Marks drain lazily inside the next `scripts`-family CLI call
 * (`scripts tick|run|stop|results|logs`) via `drainWorktreeTriggers`.
 */

import { resolveSocketPath } from "../../../packages/herdr-client/src/index";
import { updateState } from "./state";
import { buildTriggerMark, canonicalTriggerEventName, recordTriggerMark } from "./triggers";

interface EventEnvelope {
  event?: string;
  data?: {
    type?: string;
    worktree?: { path?: string };
    worktree_path?: string;
    workspace?: { workspace_id?: string };
    workspace_id?: string;
    [key: string]: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
  if (!raw) return;
  let envelope: EventEnvelope;
  try {
    envelope = JSON.parse(raw) as EventEnvelope;
  } catch {
    return;
  }
  // HERDR_PLUGIN_EVENT carries the dotted hook name; the JSON envelope
  // serializes EventKind snake_case (`worktree_created`) and EventData
  // `type` likewise. Accept either form (same normalization as
  // inbox/checkpoints/automations).
  const name =
    canonicalTriggerEventName(process.env.HERDR_PLUGIN_EVENT) ??
    canonicalTriggerEventName(envelope.event) ??
    canonicalTriggerEventName(envelope.data?.type);
  if (name === null) return;

  const data = isRecord(envelope.data) ? envelope.data : {};
  // The socket of the EMITTING session — plugin hook env carries
  // HERDR_SOCKET_PATH/HERDR_SESSION (verified herdr 0.9.5 env contract).
  const socketPath = resolveSocketPath({});
  const mark = buildTriggerMark({
    event: name,
    data,
    socketPath,
  });
  if (mark === null) return;

  await updateState((state) => {
    recordTriggerMark(state, mark);
  });
}

main().catch((err) => {
  console.error(`projects hook failed: ${String(err)}`);
  process.exitCode = 1;
});
