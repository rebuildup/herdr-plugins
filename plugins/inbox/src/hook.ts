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
import { removeWatchLink, sessionEntries, sessionKeyFor, updateState } from "./state";
import { appendClearedTransitions, appendTransition } from "./transitions";

interface EventEnvelope {
  event?: string;
  data?: {
    type?: string;
    pane_id?: string;
    agent_status?: string;
  };
}

// HERDR_PLUGIN_EVENT carries the dotted hook name ("pane.closed"); the JSON
// envelope serializes EventKind in snake_case ("pane_closed"). Accept both.
function eventName(envelope: EventEnvelope): string {
  const env = process.env.HERDR_PLUGIN_EVENT;
  if (env) return env;
  if (envelope.event === "pane_closed") return "pane.closed";
  if (envelope.event === "pane_agent_status_changed") return "pane.agent_status_changed";
  return envelope.event ?? "";
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
  const name = eventName(envelope);

  // Hooks only run inside the herdr plugin runtime (HERDR_SOCKET_PATH is
  // always set there); mutation:true keeps a manually-invoked hook from
  // silently falling back to the implicit default session.
  const sessionKey = sessionKeyFor({ mutation: true });

  if (name === "pane.closed") {
    await updateState((state) => {
      const entries = state.sessions[sessionKey];
      const entry = entries?.[paneId];
      // Record the organize clear before dropping the entry — the pane is
      // gone, so only the stored workspace id survives as context.
      const hadHideKind =
        entry !== undefined &&
        (entry.settled !== undefined ||
          entry.snoozed !== undefined ||
          entry.archived !== undefined);
      if (entries) delete entries[paneId];
      // Drop every watch baseline for the closed pane: its declared links
      // died with the entry, so no poll baseline may outlive them (#178).
      const paneWatch = state.watch?.[sessionKey]?.[paneId];
      if (paneWatch) {
        for (const ref of Object.keys(paneWatch)) {
          removeWatchLink(state, sessionKey, paneId, ref);
        }
      }
      if (hadHideKind) {
        appendTransition(state, sessionKey, {
          kind: "cleared",
          paneId,
          ctx: { workspaceId: entry?.workspace_id, at: new Date().toISOString() },
          cause: "pane_closed",
        });
      }
    });
    return;
  }

  if (name !== "pane.agent_status_changed") return;

  const snapshot = await sessionSnapshot({ mutation: true });
  const agent = snapshot.agents?.[paneId];

  const now = new Date();
  const pane = (snapshot.panes ?? []).find((p) => p.pane_id === paneId);
  const outcome = await updateState(async (state) => {
    const entries = sessionEntries(state, sessionKey);
    const entry = entries[paneId];
    if (!entry) return null;
    const result = resolveEntry(entry, agent, now);
    const hasState =
      entry.settled !== undefined ||
      entry.snoozed !== undefined ||
      entry.archived !== undefined ||
      entry.pinned !== undefined ||
      entry.order !== undefined ||
      (entry.links?.length ?? 0) > 0;
    if (!hasState) {
      delete entries[paneId];
    }
    entry.updated_at = now.toISOString();
    // Organize-transition log (#182): hide-kind clears resolved by this
    // hook are real organize mutations and must be recorded. Pin clears
    // are layout hints and are not transitions.
    const hideClears = result.clearedMarks.filter((m) => m.field !== "pinned");
    if (hideClears.length > 0) {
      appendClearedTransitions(state, sessionKey, paneId, hideClears, {
        pane,
        agent,
        workspaceId: entry.workspace_id,
        at: now.toISOString(),
      });
    }
    return { ...result, pinned: entry.pinned !== undefined };
  });

  if (!outcome) return;

  // Refresh the pane's inbox metadata token to match resolved organize state.
  const tokens: Record<string, string | null> = {
    inbox_state: outcome.organize?.kind ?? null,
    inbox_snoozed_until: outcome.organize?.until ?? null,
    inbox_pinned: outcome.pinned ? "true" : null,
  };
  try {
    await reportPaneMetadata(paneId, tokens, { mutation: true });
  } catch (err) {
    console.error(`inbox hook: metadata projection failed for ${paneId}: ${String(err)}`);
  }
}

main().catch((err) => {
  console.error(`inbox hook failed: ${String(err)}`);
  process.exitCode = 1;
});
