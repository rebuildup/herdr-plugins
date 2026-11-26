/**
 * Event-hook helpers for rebuildup.automations (#146).
 *
 * Pure functions only: normalize herdr's wire event names (dotted
 * `pane.agent_status_changed` on HERDR_PLUGIN_EVENT vs snake_case
 * `pane_agent_status_changed` in the JSON envelope / EventData `type`
 * tag), extract the flat identity dimensions used by `event.filter`,
 * and evaluate filter matches. No I/O — the hook entrypoint
 * (`src/hook.ts`) and the `tick` drain (`registry.ts`) share these.
 */

import { HOOK_EVENT_NAMES, type PendingEventMark } from "./model";

/** snake_case wire form → dotted canonical (e.g. `pane_closed` → `pane.closed`). */
const SNAKE_TO_DOTTED = new Map<string, string>(
  HOOK_EVENT_NAMES.map((name) => [name.replaceAll(".", "_"), name]),
);

/**
 * Resolve an event name to its canonical dotted hook name, accepting
 * both wire forms. Returns null for anything outside
 * `HOOK_EVENT_NAMES` — unknown events are ignored, never recorded.
 */
export function canonicalEventName(raw: string | undefined | null): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if ((HOOK_EVENT_NAMES as readonly string[]).includes(raw)) return raw;
  return SNAKE_TO_DOTTED.get(raw) ?? null;
}

/** Flat identity dimensions extracted from an EventData payload. */
export interface EventDimensions {
  pane_id?: string | undefined;
  tab_id?: string | undefined;
  workspace_id?: string | undefined;
  agent?: string | undefined;
  agent_status?: string | undefined;
  workspace_label?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extract filterable dimensions from an event's `data` payload.
 * EventData variants nest identities differently (`pane`/`tab`/
 * `workspace` objects vs flat `pane_id`/`workspace_id` fields), so
 * this merges every known location — first non-empty wins per field.
 */
export function eventDimensions(data: unknown): EventDimensions {
  const dims: EventDimensions = {};
  if (!isRecord(data)) return dims;
  const pane = isRecord(data.pane) ? data.pane : null;
  const tab = isRecord(data.tab) ? data.tab : null;
  const workspace = isRecord(data.workspace) ? data.workspace : null;

  dims.pane_id = str(data.pane_id) ?? str(pane?.pane_id) ?? str(data.previous_pane_id);
  dims.tab_id = str(data.tab_id) ?? str(tab?.tab_id) ?? str(pane?.tab_id);
  dims.workspace_id =
    str(data.workspace_id) ??
    str(pane?.workspace_id) ??
    str(tab?.workspace_id) ??
    str(workspace?.workspace_id);
  dims.workspace_label = str(workspace?.label) ?? str(data.label);
  dims.agent_status =
    str(data.agent_status) ?? str(pane?.agent_status) ?? str(workspace?.agent_status);
  dims.agent =
    str(data.agent) ?? str(data.display_agent) ?? str(pane?.agent) ?? str(pane?.display_agent);
  return dims;
}

/**
 * `event.filter` match: every field the task sets must equal the
 * extracted dimension. Unset filter fields never constrain. A filter
 * field with no corresponding dimension simply does not match.
 */
export function eventMatchesFilter(
  dims: EventDimensions,
  filter: Record<string, string | undefined> | undefined,
): boolean {
  if (filter === undefined) return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (expected === undefined) continue;
    const actual = (dims as Record<string, string | undefined>)[key];
    if (actual !== expected) return false;
  }
  return true;
}

/**
 * Does a pending mark satisfy an event schedule's `on` + `filter`?
 * `scheduleOn`/`filter` come from the parsed `event` schedule.
 */
export function markMatchesSchedule(
  mark: PendingEventMark,
  scheduleOn: string,
  filter: Record<string, string | undefined> | undefined,
): boolean {
  if (mark.event !== scheduleOn) return false;
  return eventMatchesFilter(eventDimensions(mark.data), filter);
}
