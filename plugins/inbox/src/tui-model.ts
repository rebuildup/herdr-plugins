/**
 * View-model and parsers for the inbox TUI (`src/tui.ts`, contract
 * `herdr-plugins.tui/v1`). Pure functions only — no I/O, no process
 * control — so the whole surface is unit-testable without a PTY or a
 * live herdr session.
 *
 * The TUI is a thin layer over the existing `herdr-plugins.inbox/v1`
 * CLI: every read goes through `cli.ts list|transitions|capability` and
 * every mutation through `cli.ts settle|snooze|restore|pin|unpin|
 * archive|unarchive|order|link|unlink|reconcile`. This module owns the
 * JSON shapes, display formatting, keymap table, stale-generation
 * check, and the small input parsers (snooze spec, tracker ref, order
 * placement) that mirror — never replace — the CLI's own validation.
 */

import type { KeyBinding } from "../../../packages/tui/src/index";
import type { InboxItem, OrganizeView } from "./model";

// --- CLI JSON shapes -------------------------------------------------------------

export interface ListCounts {
  total: number;
  inbox: number;
  attention: number;
  organized: number;
  pinned: number;
  archived: number;
  linked: number;
}

export interface ListPayload {
  contract?: string;
  generated_at?: string;
  session?: { name?: string | null; socket?: string | null };
  state_file?: string;
  filters?: Record<string, unknown>;
  counts?: Partial<ListCounts>;
  items?: InboxItem[];
}

export type CliJsonResult = { ok: true; payload: ListPayload } | { ok: false; error: string };

/** Parse `cli.ts list` stdout. Never throws. */
export function parseListOutput(stdout: string): CliJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "cli returned non-JSON output" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "cli returned an unexpected payload" };
  }
  const doc = parsed as ListPayload & { ok?: boolean; error?: unknown };
  if (doc.ok === false) {
    const msg =
      typeof doc.error === "object" && doc.error !== null
        ? String((doc.error as { message?: unknown }).message ?? "unknown error")
        : String(doc.error ?? "unknown error");
    return { ok: false, error: msg };
  }
  if (!Array.isArray(doc.items)) {
    return { ok: false, error: "cli payload has no items array" };
  }
  return { ok: true, payload: doc };
}

/** Extract an honest error message from a failed CLI invocation. */
export function cliErrorMessage(status: number, stdout: string, stderr: string): string {
  const text = stderr.trim() || stdout.trim();
  if (text !== "") {
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: unknown } | string;
        ok?: boolean;
      };
      const err = parsed.error;
      if (typeof err === "object" && err !== null && typeof err.message === "string") {
        return err.message;
      }
      if (typeof err === "string") return err;
    } catch {
      // not JSON — fall through to raw text
    }
    return text.slice(0, 300);
  }
  return `cli exited with status ${status}`;
}

// --- Display formatting -----------------------------------------------------------

const ORGANIZE_LABEL: Record<OrganizeView["kind"], string> = {
  settled: "settled",
  snoozed: "snoozed",
  archived: "archived",
};

/** Short badge string for one inbox item (pin / attention / organize / links). */
export function itemBadges(item: InboxItem): string {
  const parts: string[] = [];
  if (item.pinned) parts.push("pin");
  if (item.attention) parts.push("!");
  if (item.organize) {
    const kind = ORGANIZE_LABEL[item.organize.kind];
    parts.push(
      item.organize.kind === "snoozed" && item.organize.until
        ? `${kind}→${item.organize.until}`
        : kind,
    );
  }
  if (!item.in_inbox && item.organize === undefined) parts.push("hidden");
  if (item.links.length > 0) parts.push(`links:${item.links.length}`);
  return parts.join(" ");
}

/** Primary list-row text: title (or pane id fallback) + pane id. */
export function itemTitle(item: InboxItem): string {
  return item.title ?? item.pane_id;
}

/** Searchable text for `/` filtering — mirrors the CLI's search fields
 *  (title, cwd, pane_id) plus link refs and workspace for convenience. */
export function itemSearchText(item: InboxItem): string {
  return [
    item.title,
    item.cwd,
    item.pane_id,
    item.workspace_id,
    item.agent_status,
    ...item.links.map((l) => l.ref),
  ]
    .filter((f): f is string => typeof f === "string")
    .join("\n");
}

/**
 * Scope filter for the main list. `inbox` = default view (in_inbox),
 * `all` = every reported item, `hidden` = organize-hidden items only,
 * `attention` = items currently requiring attention.
 */
export type InboxScope = "inbox" | "all" | "hidden" | "attention";

export const INBOX_SCOPES: readonly InboxScope[] = ["inbox", "all", "hidden", "attention"];

export function scopeLabel(scope: InboxScope): string {
  switch (scope) {
    case "inbox":
      return "inbox";
    case "all":
      return "all";
    case "hidden":
      return "organized/hidden";
    case "attention":
      return "attention";
  }
}

/** Next scope in the cycle (f key). */
export function nextScope(scope: InboxScope): InboxScope {
  const i = INBOX_SCOPES.indexOf(scope);
  return INBOX_SCOPES[(i + 1) % INBOX_SCOPES.length] as InboxScope;
}

/** Apply scope + free-text query. Case-insensitive AND over terms. */
export function visibleItems(
  items: readonly InboxItem[],
  scope: InboxScope,
  query: string,
): InboxItem[] {
  let out = items;
  switch (scope) {
    case "inbox":
      out = out.filter((i) => i.in_inbox);
      break;
    case "hidden":
      out = out.filter((i) => !i.in_inbox);
      break;
    case "attention":
      out = out.filter((i) => i.attention);
      break;
    case "all":
      break;
  }
  const q = query.trim().toLowerCase();
  if (q === "") return [...out];
  const terms = q.split(/\s+/).filter((t) => t.length > 0);
  return out.filter((item) => {
    const hay = itemSearchText(item).toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** Human-readable detail lines for the read-only detail view. */
export function itemDetailLines(item: InboxItem, generatedAt?: string): string[] {
  const lines: string[] = [];
  lines.push(`pane:      ${item.pane_id}`);
  if (item.workspace_id) lines.push(`workspace: ${item.workspace_id}`);
  if (item.tab_id) lines.push(`tab:       ${item.tab_id}`);
  if (item.title) lines.push(`title:     ${item.title}`);
  if (item.cwd) lines.push(`cwd:       ${item.cwd}`);
  if (item.agent_status) lines.push(`agent:     ${item.agent_status}`);
  if (item.state_change_seq !== undefined) {
    lines.push(`seq:       ${item.state_change_seq}`);
  }
  const sess = item.agent_session;
  if (sess) {
    lines.push(`session:  ${[sess.agent, sess.kind, sess.value].filter(Boolean).join("/")}`);
  }
  lines.push(`pinned:    ${item.pinned ? "yes" : "no"}`);
  if (item.order !== undefined) lines.push(`order:     ${item.order}`);
  lines.push(`attention: ${item.attention ? "yes" : "no"}`);
  lines.push(`inbox:     ${item.in_inbox ? "visible" : "hidden"}`);
  if (item.organize) {
    const o = item.organize;
    lines.push(`organize: ${o.kind} since ${o.since}${o.until ? ` until ${o.until}` : ""}`);
  }
  if (item.links.length > 0) {
    lines.push("links:");
    for (const link of item.links) {
      lines.push(`  ${link.kind}  ${link.ref}  (declared ${link.at})`);
    }
  } else {
    lines.push("links:     none");
  }
  if (generatedAt) lines.push(`generated: ${generatedAt}`);
  lines.push("");
  lines.push("Mutations go through the inbox CLI contract — the TUI never");
  lines.push("writes organize state directly. `?` shows the keymap.");
  return lines;
}

// --- Stale-generation revalidation (contract §3.3) ----------------------------------

export type StaleVerdict =
  | { kind: "ok" }
  | { kind: "gone"; reason: string }
  | { kind: "stale"; reason: string };

function sameSessionRef(a: InboxItem["agent_session"], b: InboxItem["agent_session"]): boolean {
  const norm = (s: InboxItem["agent_session"]) =>
    s ? `${s.agent ?? ""}|${s.kind ?? ""}|${s.value ?? ""}` : "";
  return norm(a) === norm(b);
}

/**
 * Compare the item the user acted on with a fresh read taken immediately
 * before a mutation. `gone` = pane absent from the session snapshot;
 * `stale` = agent-session fingerprint or state_change_seq changed (a
 * different generation or a recycled identity). Any mismatch aborts the
 * mutation — the TUI never silently retargets.
 */
export function staleCheck(
  before: InboxItem | undefined,
  after: InboxItem | undefined,
): StaleVerdict {
  if (!before) return { kind: "gone", reason: "no item was selected" };
  if (!after) {
    return { kind: "gone", reason: `pane ${before.pane_id} is no longer in the session` };
  }
  if (!sameSessionRef(before.agent_session, after.agent_session)) {
    return {
      kind: "stale",
      reason: `agent session changed for ${before.pane_id} (generation swap)`,
    };
  }
  if (before.state_change_seq !== after.state_change_seq) {
    return {
      kind: "stale",
      reason:
        `state_change_seq advanced for ${before.pane_id} ` +
        `(${before.state_change_seq ?? "?"} → ${after.state_change_seq ?? "?"})`,
    };
  }
  return { kind: "ok" };
}

// --- Input parsers (mirror CLI validation; CLI re-validates anyway) -----------------

const TRACKER_REF_RE =
  /^([A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+)#([1-9][0-9]*)$/;

export type LinkSpec =
  | { ok: true; kind: "pr" | "issue"; flag: "--pr" | "--issue"; ref: string }
  | { ok: false; error: string };

/**
 * Parse `pr owner/repo#123` / `issue owner/repo#123` (also `pull`/`pr:`
 * spellings). Anything else is a usage error shown inline — the CLI
 * remains the authority on the tracker-ref grammar.
 */
export function parseLinkSpec(input: string): LinkSpec {
  const trimmed = input.trim();
  const m = /^(pr|pull|issue|bug)\s*[: ]\s*(\S+)$/i.exec(trimmed);
  if (!m) {
    return {
      ok: false,
      error: "expected: pr <owner>/<repo>#<n>  or  issue <owner>/<repo>#<n>",
    };
  }
  const word = (m[1] as string).toLowerCase();
  const kind = word === "issue" || word === "bug" ? "issue" : "pr";
  const ref = m[2] as string;
  if (!TRACKER_REF_RE.test(ref)) {
    return { ok: false, error: `invalid tracker ref: ${ref}` };
  }
  return { ok: true, kind, flag: kind === "pr" ? "--pr" : "--issue", ref };
}

const SNOOZE_SPEC_RE = /^(?:\+?\d+[mhd]|\d{4}-\d{2}-\d{2}[T ].*)$/;

/**
 * Validate a snooze `--until` spec before prompting for confirmation.
 * Mirrors cli.ts parseUntilSpec's accepted shapes: `+30m`/`30m`/`+2h`/`+1d`
 * durations or an ISO-8601 timestamp. Returns the spec to forward to the
 * CLI unchanged (the CLI re-parses it authoritatively).
 */
export function validateSnoozeSpec(
  input: string,
): { ok: true; spec: string } | { ok: false; error: string } {
  const spec = input.trim();
  if (spec === "") return { ok: false, error: "empty snooze spec" };
  if (!SNOOZE_SPEC_RE.test(spec)) {
    return {
      ok: false,
      error: "expected +30m / +2h / +1d, 30m, or an ISO-8601 timestamp",
    };
  }
  if (/^\d{4}-/.test(spec) && Number.isNaN(Date.parse(spec))) {
    return { ok: false, error: `cannot parse timestamp: ${spec}` };
  }
  return { ok: true, spec };
}

// --- Order placement ---------------------------------------------------------------

/**
 * Compute the `order` argv placement for moving `paneId` one step up or
 * down inside its display group (same attention+pinned flags, visible
 * inbox items only — the same scoping `computeOrderRanks` applies).
 * Returns the reference pane id for --before/--after, or an error.
 */
export function orderMoveTarget(
  items: readonly InboxItem[],
  paneId: string,
  dir: "up" | "down",
): { ok: true; flag: "--before" | "--after"; refPaneId: string } | { ok: false; error: string } {
  const moved = items.find((i) => i.pane_id === paneId && i.in_inbox);
  if (!moved)
    return { ok: false, error: `${paneId} is not in the inbox (hidden panes cannot be ordered)` };
  const siblings = items.filter(
    (i) => i.in_inbox && i.attention === moved.attention && i.pinned === moved.pinned,
  );
  const idx = siblings.findIndex((i) => i.pane_id === paneId);
  const targetIdx = dir === "up" ? idx - 1 : idx + 1;
  const target = siblings[targetIdx];
  if (!target) {
    return { ok: false, error: `already at the ${dir === "up" ? "top" : "bottom"} of its group` };
  }
  return dir === "up"
    ? { ok: true, flag: "--before", refPaneId: target.pane_id }
    : { ok: true, flag: "--after", refPaneId: target.pane_id };
}

// --- Keymap (single source for dispatch docs + `?` help) ------------------------------

export const INBOX_TUI_KEYMAP: KeyBinding[] = [
  { keys: ["↑", "k", "↓", "j"], description: "move selection" },
  { keys: ["pgup", "pgdn"], description: "page" },
  { keys: ["home", "end"], description: "first / last" },
  { keys: "/", description: "filter (text search)" },
  { keys: "f", description: "cycle scope: inbox → all → hidden → attention" },
  { keys: "R", description: "refresh list (read-only)" },
  { keys: "enter", description: "item detail" },
  { keys: "s", description: "settle pane (confirm)" },
  { keys: "n", description: "snooze pane (confirm)" },
  { keys: "r", description: "restore pane (confirm)" },
  { keys: "p", description: "pin / unpin (confirm)" },
  { keys: "a", description: "archive / unarchive (confirm)" },
  { keys: ["[", "]"], description: "move up / down in order group (confirm)" },
  { keys: "l", description: "link PR/Issue (confirm)" },
  { keys: "u", description: "unlink PR/Issue (confirm)" },
  { keys: "t", description: "organize-transition log (read-only)" },
  { keys: "c", description: "run reconcile now (explicit, confirm)" },
];
