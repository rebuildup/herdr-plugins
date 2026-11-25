/**
 * Event-hook entrypoint for rebuildup.checkpoints. herdr invokes this
 * command with HERDR_PLUGIN_EVENT and HERDR_PLUGIN_EVENT_JSON set.
 *
 * - `pane.agent_status_changed`: fold the transition into the per-session
 *   auto-capture map — a `working → idle|done` edge records a
 *   capture-pending mark (generation-guarded by `state_change_seq` +
 *   `agent_session`). The hook performs **no git work**: the real
 *   capture runs lazily on the next CLI invocation (ADR-0002).
 * - `pane.closed`: drop the pane's auto-capture bookkeeping.
 *
 * Contract: exits 0 on success; failures are logged to stderr and
 * surfaced in the plugin command log — they must never affect herdr
 * itself, and the hook must stay fast (one `session.snapshot` request,
 * no subprocesses).
 */

import { sessionSnapshot } from "../../../packages/herdr-client/src/index";
import type { AgentInfo, SessionSnapshot } from "../../../packages/herdr-client/src/snapshot";
import { clearPaneAuto, recordAgentStatus } from "./auto";
import { autoSessionEntries, sessionKeyFor, updateState } from "./state";

interface EventEnvelope {
  event?: string;
  data?: {
    type?: string;
    pane_id?: string;
    agent_status?: string;
  };
}

// HERDR_PLUGIN_EVENT carries the dotted hook name ("pane.closed"); the
// JSON envelope serializes EventKind in snake_case ("pane_closed").
// Accept both (same normalization as rebuildup.inbox).
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
  if (name !== "pane.agent_status_changed" && name !== "pane.closed") return;

  const sessionKey = sessionKeyFor({});

  if (name === "pane.closed") {
    await updateState((state) => {
      const entries = state.auto?.[sessionKey];
      if (entries) clearPaneAuto(entries, paneId);
    });
    return;
  }

  // Re-read the snapshot for generation signals: the hook payload
  // carries only pane_id + agent_status (verified herdr 0.9.5).
  // An unreachable session must not fail the hook — the mark is simply
  // not recorded this time.
  let snapshot: SessionSnapshot;
  try {
    snapshot = await sessionSnapshot();
  } catch (err) {
    console.error(`checkpoints hook: snapshot unavailable, skipping: ${String(err)}`);
    return;
  }
  const agents = (snapshot.agents ?? {}) as Record<string, AgentInfo>;
  const agent = agents[paneId];

  const now = new Date();
  await updateState((state) => {
    recordAgentStatus(autoSessionEntries(state, sessionKey), paneId, agent, now);
  });
}

main().catch((err) => {
  console.error(`checkpoints hook failed: ${String(err)}`);
  process.exitCode = 1;
});
