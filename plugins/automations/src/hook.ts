/**
 * Event-hook entrypoint for rebuildup.automations (#146). herdr invokes
 * this command once per `[[events]]` manifest hook with
 * HERDR_PLUGIN_EVENT and HERDR_PLUGIN_EVENT_JSON set.
 *
 * The hook does NO socket work and NO delivery — it must stay fast and
 * must never affect herdr (ADR-0002, same contract as
 * plugins/checkpoints/src/hook.ts):
 *
 * - Every recognized lifecycle event is appended to the session
 *   registry's `pending_events` marks (capped; overflow counted).
 * - `pane.agent_status_changed` additionally folds the observed
 *   `agent_status` into the latest delivered run targeting that pane
 *   (`result.agent_status`/`agent_status_at` — observed values only,
 *   never a fabricated completion).
 *
 * Marks drain lazily: the next `tick` (OS scheduler entry, `watch`
 * loop, or manual `tick`) evaluates `event` schedules against them and
 * delivers through the same run path as clock fires. Events that herdr
 * never delivered simply never exist — the plugin never invents them.
 */

import { canonicalEventName, eventDimensions } from "./events";
import type { PendingEventMark } from "./model";
import { observeRunAgentStatus, recordPendingEvents } from "./registry";
import { sessionKeyFor, sessionRegistry, updateState } from "./state";

interface EventEnvelope {
  event?: string;
  data?: {
    type?: string;
    pane_id?: string;
    agent_status?: string;
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
  // serializes EventKind snake_case and EventData `type` likewise.
  // Accept either form (same normalization as inbox/checkpoints).
  const name =
    canonicalEventName(process.env.HERDR_PLUGIN_EVENT) ??
    canonicalEventName(envelope.event) ??
    canonicalEventName(envelope.data?.type);
  if (name === null) return;
  const data = isRecord(envelope.data) ? envelope.data : {};

  const sessionKey = sessionKeyFor({});
  const receivedAt = new Date().toISOString();
  const mark: PendingEventMark = { event: name, received_at: receivedAt, data };

  await updateState((state) => {
    const registry = sessionRegistry(state, sessionKey);
    recordPendingEvents(registry, [mark]);
    if (name === "pane.agent_status_changed") {
      const paneId = eventDimensions(data).pane_id;
      const status = typeof data.agent_status === "string" ? data.agent_status : null;
      if (typeof paneId === "string" && status !== null) {
        observeRunAgentStatus(registry, paneId, status, Date.now());
      }
    }
  });
}

main().catch((err) => {
  console.error(`automations hook failed: ${String(err)}`);
  process.exitCode = 1;
});
