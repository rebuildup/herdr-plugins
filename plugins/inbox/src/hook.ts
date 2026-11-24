/**
 * Event-hook entrypoint. herdr invokes this command with HERDR_PLUGIN_EVENT
 * and HERDR_PLUGIN_EVENT_JSON set.
 *
 * - `pane.agent_status_changed`: resolve the affected pane's organize marks
 *   against a fresh snapshot and refresh its metadata tokens.
 * - `pane.closed`: drop the pane's organize entry (the pane no longer
 *   exists; a reused pane id starts with clean state).
 *
 * Contract: exits 0 on success; failures are logged to stderr and surfaced
 * in the plugin command log — they must never affect herdr itself.
 */

import { reportPaneMetadata, sessionSnapshot } from "../../../packages/herdr-client/src/index";
import { resolveEntry } from "./model";
import { updateState } from "./state";

interface EventEnvelope {
  event?: string;
  data?: {
    type?: string;
    pane_id?: string;
    agent_status?: string;
  };
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
  const paneId = envelope.data?.pane_id;
  if (!paneId) return;

  if (envelope.event === "pane.closed") {
    await updateState((state) => {
      delete state.entries[paneId];
    });
    return;
  }

  if (envelope.event !== "pane.agent_status_changed") return;

  const snapshot = await sessionSnapshot();
  const agent = snapshot.agents?.[paneId];

  const now = new Date();
  const outcome = await updateState(async (state) => {
    const entry = state.entries[paneId];
    if (!entry) return null;
    const result = resolveEntry(entry, agent, now);
    if (!entry.settled && !entry.snoozed) {
      delete state.entries[paneId];
    }
    entry.updated_at = now.toISOString();
    return result;
  });

  if (!outcome) return;

  // Refresh the pane's inbox metadata token to match resolved organize state.
  const tokens: Record<string, string | null> = {};
  if (outcome.organize) {
    tokens.inbox_state = outcome.organize.kind;
    tokens.inbox_snoozed_until = outcome.organize.until ?? null;
  } else {
    tokens.inbox_state = null;
    tokens.inbox_snoozed_until = null;
  }
  try {
    await reportPaneMetadata(paneId, tokens);
  } catch (err) {
    console.error(`inbox hook: metadata projection failed for ${paneId}: ${String(err)}`);
  }
}

main().catch((err) => {
  console.error(`inbox hook failed: ${String(err)}`);
  process.exitCode = 1;
});
