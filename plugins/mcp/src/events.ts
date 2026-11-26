/**
 * Event subscription hub for `rebuildup.mcp` (T4, #140).
 *
 * Contract `herdr-plugins.mcp/v1` exposes herdr's `events.subscribe`
 * surface as MCP *tools* — the sanctioned "tool polling structured
 * alternative" (contract "Events"): the stdio server is a per-client
 * process, so subscriptions live in-process and clients pull buffered
 * events via `events_poll`/`events_wait` instead of relying on MCP
 * server→client notifications.
 *
 * Honesty rules (inherited invariants):
 * - A dropped subscription socket is NEVER reported as "no events".
 *   Every disconnect emits a `gap` notice; every successful resubscribe
 *   emits a `resync` notice carrying a fresh `session.snapshot` baseline
 *   for the filtered panes. Missed events are reported as missed — the
 *   hub cannot reconstruct them and does not pretend to.
 * - Upstream `events_lost` (herdr fell behind retained history) maps to
 *   gap reason `events_lost`; other stream ends map to `stream_closed`;
 *   failed (re)subscribe attempts map to `socket_unreachable` or
 *   `subscribe_failed` with the upstream error preserved in `detail`.
 * - Filters are applied client-side on event `data` fields
 *   (`pane_id`/`workspace_id`/`agent_status`/`agent`); upstream
 *   `pane_id` scoping is used where the herdr subscription schema
 *   requires it. An event whose data lacks a filtered field is dropped
 *   — absence is never treated as a match.
 */

import {
  HerdrRpcError,
  subscribe as herdrSubscribe,
  type SessionSnapshot,
  type Subscription,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import type { McpErrorCode } from "./model";

// --- Contract-facing types -----------------------------------------------------

/** Contract error raised by the hub; tools.ts maps `code` to ToolError. */
export class EventError extends Error {
  readonly code: McpErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: McpErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "EventError";
    this.code = code;
    this.details = details;
  }
}

function invalidParams(message: string, details?: Record<string, unknown>): never {
  throw new EventError("invalid_params", message, details);
}

/**
 * Subscription types accepted by herdr `events.subscribe` (protocol 22,
 * `Subscription` enum in herdr `src/api/schema/events.rs`). Dotted names
 * are canonical; the wire may emit snake_case — both are normalized.
 * `pane.output_changed` is an emitted EventKind but NOT subscribable
 * upstream, so it is deliberately absent here.
 */
export const SUBSCRIPTION_TYPES = [
  "workspace.created",
  "workspace.updated",
  "workspace.metadata_updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
  // Pane-parameterized upstream (pane_id required by the herdr schema;
  // the hub expands these across the resolved pane set).
  "pane.agent_status_changed",
  "pane.output_matched",
  "pane.scroll_changed",
] as const;
export type SubscriptionType = (typeof SUBSCRIPTION_TYPES)[number];

/** Types that herdr requires a `pane_id` for; expanded per resolved pane. */
export const PARAMETERIZED_TYPES: ReadonlySet<string> = new Set([
  "pane.agent_status_changed",
  "pane.output_matched",
  "pane.scroll_changed",
]);

const SUBSCRIPTION_TYPE_SET: ReadonlySet<string> = new Set(SUBSCRIPTION_TYPES);

/** Raw wire event name → canonical dotted subscription type. */
const CANONICAL_EVENT_NAMES = new Map<string, string>();
for (const type of SUBSCRIPTION_TYPES) {
  CANONICAL_EVENT_NAMES.set(type, type);
  CANONICAL_EVENT_NAMES.set(type.replaceAll(".", "_"), type);
}

/** Normalize a wire event name (`pane_agent_status_changed`,
 * `pane.output_matched`, …) to its canonical dotted form; unknown names
 * pass through unchanged (never fabricated). */
export function canonicalEventName(raw: string): string {
  return CANONICAL_EVENT_NAMES.get(raw) ?? raw;
}

// --- Normalized subscribe spec --------------------------------------------------

export interface EventFilters {
  pane_id?: string;
  workspace_id?: string;
  agent_status?: string;
  agent?: string;
}

export interface OutputMatchSpec {
  source: "visible" | "recent" | "recent_unwrapped" | "detection";
  match: { type: "substring" | "regex"; value: string };
  lines?: number;
  strip_ansi?: boolean;
}

export interface SubscribeSpec {
  /** Canonical subscription types (validated, deduplicated). */
  types: SubscriptionType[];
  filters: EventFilters;
  /** Required when `pane.output_matched` is among `types`. */
  outputMatch?: OutputMatchSpec;
}

const AGENT_STATUS_VALUES = ["idle", "working", "blocked", "done", "unknown"] as const;
const READ_SOURCES = ["visible", "recent", "recent_unwrapped", "detection"] as const;
const MATCH_TYPES = ["substring", "regex"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate raw `events_subscribe` tool arguments into a SubscribeSpec.
 * Throws EventError("invalid_params") on any contract violation —
 * unknown types, missing output_match, bad enums.
 */
export function parseSubscribeArgs(args: Record<string, unknown>): SubscribeSpec {
  const rawTypes = args.types;
  let types: string[];
  if (rawTypes === undefined) {
    types = ["pane.agent_status_changed"];
  } else {
    if (!Array.isArray(rawTypes) || rawTypes.length === 0) {
      invalidParams("types must be a non-empty array of subscription type strings");
    }
    if (rawTypes.some((t) => typeof t !== "string")) {
      invalidParams("types must contain only strings");
    }
    types = [...new Set(rawTypes as string[])];
  }
  for (const type of types) {
    if (!SUBSCRIPTION_TYPE_SET.has(type)) {
      invalidParams(
        `unknown subscription type: ${type} (expected one of ${SUBSCRIPTION_TYPES.join(", ")})`,
        { type },
      );
    }
  }
  const canonicalTypes = types as SubscriptionType[];

  const filters: EventFilters = {};
  for (const key of ["pane_id", "workspace_id", "agent_status", "agent"] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value === "") {
      invalidParams(`filter ${key} must be a non-empty string`);
    }
    filters[key] = value;
  }
  if (
    filters.agent_status !== undefined &&
    !(AGENT_STATUS_VALUES as readonly string[]).includes(filters.agent_status)
  ) {
    invalidParams(
      `filter agent_status must be one of ${AGENT_STATUS_VALUES.join("|")}, got: ${filters.agent_status}`,
    );
  }

  let outputMatch: OutputMatchSpec | undefined;
  if (canonicalTypes.includes("pane.output_matched")) {
    const rawMatch = args.match;
    if (!isRecord(rawMatch)) {
      invalidParams("pane.output_matched requires match: {type: substring|regex, value: string}");
    }
    const matchType = rawMatch.type;
    const matchValue = rawMatch.value;
    if (
      typeof matchType !== "string" ||
      !(MATCH_TYPES as readonly string[]).includes(matchType) ||
      typeof matchValue !== "string" ||
      matchValue === ""
    ) {
      invalidParams("match must be {type: substring|regex, value: non-empty string}");
    }
    const sourceRaw = args.source;
    let source: OutputMatchSpec["source"] = "recent";
    if (sourceRaw !== undefined) {
      if (
        typeof sourceRaw !== "string" ||
        !(READ_SOURCES as readonly string[]).includes(sourceRaw)
      ) {
        invalidParams(`source must be one of ${READ_SOURCES.join("|")}`);
      }
      source = sourceRaw as OutputMatchSpec["source"];
    }
    const lines = args.lines;
    if (
      lines !== undefined &&
      (typeof lines !== "number" || !Number.isFinite(lines) || lines <= 0)
    ) {
      invalidParams("lines must be a positive number");
    }
    const stripAnsi = args.strip_ansi;
    if (stripAnsi !== undefined && typeof stripAnsi !== "boolean") {
      invalidParams("strip_ansi must be a boolean");
    }
    outputMatch = {
      source,
      match: { type: matchType as "substring" | "regex", value: matchValue },
      ...(lines !== undefined ? { lines: Math.floor(lines) } : {}),
      ...(stripAnsi !== undefined ? { strip_ansi: stripAnsi } : {}),
    };
  } else if (
    args.match !== undefined ||
    args.source !== undefined ||
    args.lines !== undefined ||
    args.strip_ansi !== undefined
  ) {
    invalidParams("match/source/lines/strip_ansi are only valid with pane.output_matched");
  }

  return { types: canonicalTypes, filters, ...(outputMatch ? { outputMatch } : {}) };
}

// --- Hub internals ---------------------------------------------------------------

const MAX_BUFFERED_ITEMS = 1000;
const BASELINE_PANE_CAP = 200;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;
const WAIT_TIMEOUT_CAP_MS = 120_000;

export interface BufferedEvent {
  seq: number;
  kind: "event";
  /** Canonical dotted event name (or the raw name when unrecognized). */
  event: string;
  data: unknown;
  at: string;
}

export interface BufferedNotice {
  seq: number;
  kind: "notice";
  /** `gap` = events may have been missed; `resync` = fresh baseline after a gap. */
  notice: "gap" | "resync";
  reason: string;
  at: string;
  detail?: Record<string, unknown>;
}

export type BufferedItem = BufferedEvent | BufferedNotice;

export type SubscriptionStatus = "starting" | "live" | "reconnecting" | "closed";

export interface PollResult {
  subscription_id: string;
  status: SubscriptionStatus;
  /** Pass back as `cursor` to receive only newer items. */
  next_cursor: number;
  events: BufferedEvent[];
  notices: BufferedNotice[];
  reconnects: number;
  timed_out?: boolean;
}

interface SubscriptionEntry {
  id: string;
  spec: SubscribeSpec;
  status: SubscriptionStatus;
  createdAt: string;
  /** Monotonic sequence shared by events and notices (cursor space). */
  seq: number;
  items: BufferedItem[];
  overflowDropped: number;
  reconnects: number;
  closed: boolean;
  upstream: Subscription | null;
  /** Panes the parameterized upstream subscriptions cover (null = none needed). */
  paneIds: string[];
  waiters: Array<() => void>;
}

export interface HubOptions {
  socketPath: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to herdr-client `subscribe`. */
  openSubscription?: (subscriptions: Array<Record<string, unknown>>) => Subscription;
  /** Injectable for tests; defaults to `session.snapshot`. */
  snapshot?: () => Promise<SessionSnapshot>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Gap reason + detail for a failed (re)subscribe attempt. */
function subscribeFailure(err: unknown): { reason: string; detail: Record<string, unknown> } {
  if (err instanceof HerdrRpcError) {
    return {
      reason: "subscribe_failed",
      detail: { upstream_code: err.code, message: err.message },
    };
  }
  const message = errorMessage(err);
  if (/timed out|socket closed|ECONNREFUSED|ENOENT|ECONNRESET|EPIPE/i.test(message)) {
    return { reason: "socket_unreachable", detail: { message } };
  }
  return { reason: "subscribe_failed", detail: { message } };
}

/** Gap reason for a subscription stream that ended or errored mid-flight. */
function streamGapReason(sub: Subscription): { reason: string; detail?: Record<string, unknown> } {
  const terminal = sub.terminalError ?? null;
  if (terminal?.code === "events_lost") {
    return { reason: "events_lost", detail: { upstream: terminal } };
  }
  if (terminal !== null) {
    return { reason: "stream_closed", detail: { upstream: terminal } };
  }
  return { reason: "stream_closed" };
}

export class EventHub {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly openSubscription: (
    subscriptions: Array<Record<string, unknown>>,
  ) => Subscription;
  private readonly snapshot: () => Promise<SessionSnapshot>;
  private readonly entries = new Map<string, SubscriptionEntry>();
  private nextId = 0;

  constructor(options: HubOptions) {
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs;
    this.openSubscription =
      options.openSubscription ??
      ((subscriptions) =>
        herdrSubscribe(this.socketPath, subscriptions, { timeoutMs: this.timeoutMs }));
    this.snapshot =
      options.snapshot ??
      (() => sessionSnapshot({ socketPath: this.socketPath, timeoutMs: this.timeoutMs }));
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Resolve the pane set covered by pane-parameterized upstream
   * subscriptions. Explicit `pane_id` must exist in the live snapshot;
   * `workspace_id` must name a live workspace; with neither, every live
   * pane is covered (re-resolved on each reconnect).
   */
  private async resolvePaneIds(entry: SubscriptionEntry): Promise<string[]> {
    const needsPanes = entry.spec.types.some((t) => PARAMETERIZED_TYPES.has(t));
    const filters = entry.spec.filters;
    if (!needsPanes && filters.pane_id === undefined && filters.workspace_id === undefined) {
      entry.paneIds = [];
      return [];
    }
    let snap: SessionSnapshot;
    try {
      snap = await this.snapshot();
    } catch (err) {
      throw new EventError(
        "session_unreachable",
        `events.subscribe: session.snapshot failed: ${errorMessage(err)}`,
      );
    }
    const panes = snap.panes ?? [];
    if (filters.pane_id !== undefined) {
      const found = panes.some((p) => p.pane_id === filters.pane_id);
      if (!found) {
        throw new EventError(
          "not_found",
          `pane not found in live session snapshot: ${filters.pane_id}`,
          { pane_id: filters.pane_id },
        );
      }
      entry.paneIds = [filters.pane_id];
      return entry.paneIds;
    }
    if (filters.workspace_id !== undefined) {
      const workspaceExists = (snap.workspaces ?? []).some(
        (w) => w.workspace_id === filters.workspace_id,
      );
      if (!workspaceExists) {
        throw new EventError(
          "not_found",
          `workspace not found in live session snapshot: ${filters.workspace_id}`,
          { workspace_id: filters.workspace_id },
        );
      }
      entry.paneIds = panes
        .filter((p) => p.workspace_id === filters.workspace_id)
        .map((p) => p.pane_id);
      return entry.paneIds;
    }
    entry.paneIds = panes.map((p) => p.pane_id);
    return entry.paneIds;
  }

  /** Build the upstream `events.subscribe` params for one connect attempt. */
  private async buildUpstreamSubscriptions(
    entry: SubscriptionEntry,
  ): Promise<Array<Record<string, unknown>>> {
    const paneIds = await this.resolvePaneIds(entry);
    const subscriptions: Array<Record<string, unknown>> = [];
    for (const type of entry.spec.types) {
      if (!PARAMETERIZED_TYPES.has(type)) {
        subscriptions.push({ type });
        continue;
      }
      // Upstream requires pane_id for parameterized types; with no pane
      // filter the resolved set is every live pane. A workspace filter
      // matching zero panes contributes zero subscriptions for this
      // type — lifecycle types still flow; pane_count: 0 is reported.
      for (const paneId of paneIds) {
        if (type === "pane.agent_status_changed") {
          const sub: Record<string, unknown> = { type, pane_id: paneId };
          if (entry.spec.filters.agent_status !== undefined) {
            sub.agent_status = entry.spec.filters.agent_status;
          }
          subscriptions.push(sub);
        } else if (type === "pane.scroll_changed") {
          subscriptions.push({ type, pane_id: paneId });
        } else {
          // pane.output_matched — validated present by parseSubscribeArgs.
          const om = entry.spec.outputMatch as OutputMatchSpec;
          subscriptions.push({
            type,
            pane_id: paneId,
            source: om.source,
            ...(om.lines !== undefined ? { lines: om.lines } : {}),
            match: { type: om.match.type, value: om.match.value },
            ...(om.strip_ansi !== undefined ? { strip_ansi: om.strip_ansi } : {}),
          });
        }
      }
    }
    return subscriptions;
  }

  /** Fresh snapshot-derived state for the covered panes (resync baseline). */
  private async buildBaseline(entry: SubscriptionEntry): Promise<Record<string, unknown>> {
    try {
      const snap = await this.snapshot();
      const wanted = new Set(entry.paneIds);
      const allPanes = snap.panes ?? [];
      const selected = allPanes.filter((p) => wanted.size === 0 || wanted.has(p.pane_id));
      const panes = selected.slice(0, BASELINE_PANE_CAP).map((p) => {
        const agent = snap.agents?.[p.pane_id];
        const paneRecord = p as Record<string, unknown>;
        const paneStatus =
          typeof paneRecord.agent_status === "string" ? paneRecord.agent_status : undefined;
        const paneSeq =
          typeof paneRecord.state_change_seq === "number" ? paneRecord.state_change_seq : undefined;
        return {
          pane_id: p.pane_id,
          workspace_id: p.workspace_id ?? null,
          tab_id: p.tab_id ?? null,
          agent_status: agent?.agent_status ?? paneStatus ?? null,
          state_change_seq: agent?.state_change_seq ?? paneSeq ?? null,
          agent: agent?.agent ?? null,
        };
      });
      return {
        captured_at: new Date().toISOString(),
        pane_count: panes.length,
        truncated: selected.length > BASELINE_PANE_CAP,
        panes,
        note: "current state only — events missed during the gap are not reconstructable",
      };
    } catch (err) {
      return {
        captured_at: new Date().toISOString(),
        error: errorMessage(err),
        note: "baseline snapshot failed; resync state unknown — treat pane state as stale",
      };
    }
  }

  private pushItem(entry: SubscriptionEntry, item: BufferedItem): void {
    entry.seq += 1;
    entry.items.push({ ...item, seq: entry.seq } as BufferedItem);
    while (entry.items.length > MAX_BUFFERED_ITEMS) {
      entry.items.shift();
      entry.overflowDropped += 1;
    }
    if (entry.overflowDropped > 0) {
      // Report buffer overflow once as a gap notice, then reset.
      const dropped = entry.overflowDropped;
      entry.overflowDropped = 0;
      entry.seq += 1;
      entry.items.push({
        seq: entry.seq,
        kind: "notice",
        notice: "gap",
        reason: "buffer_overflow",
        at: new Date().toISOString(),
        detail: { dropped_events: dropped },
      });
    }
    for (const wake of entry.waiters.splice(0)) wake();
  }

  private pushEvent(entry: SubscriptionEntry, rawEvent: string, data: unknown): void {
    const event = canonicalEventName(rawEvent);
    const filters = entry.spec.filters;
    const record = asRecord(data);
    // Client-side filters: a missing field never satisfies a set filter.
    if (filters.pane_id !== undefined && record.pane_id !== filters.pane_id) return;
    if (filters.workspace_id !== undefined && record.workspace_id !== filters.workspace_id) {
      return;
    }
    if (filters.agent_status !== undefined && record.agent_status !== filters.agent_status) {
      return;
    }
    if (
      filters.agent !== undefined &&
      record.agent !== filters.agent &&
      record.display_agent !== filters.agent
    ) {
      return;
    }
    this.pushItem(entry, {
      seq: 0,
      kind: "event",
      event,
      data,
      at: new Date().toISOString(),
    });
  }

  private pushNotice(
    entry: SubscriptionEntry,
    notice: "gap" | "resync",
    reason: string,
    detail?: Record<string, unknown>,
  ): void {
    this.pushItem(entry, {
      seq: 0,
      kind: "notice",
      notice,
      reason,
      at: new Date().toISOString(),
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  /** Consume the current upstream subscription until it ends. */
  private async drain(entry: SubscriptionEntry, sub: Subscription): Promise<void> {
    entry.upstream = sub;
    try {
      for await (const ev of sub.events) {
        if (entry.closed) break;
        this.pushEvent(entry, ev.event, ev.data);
      }
      if (!entry.closed) {
        const { reason, detail } = streamGapReason(sub);
        this.pushNotice(entry, "gap", reason, detail);
      }
    } catch (err) {
      if (!entry.closed) {
        this.pushNotice(entry, "gap", "stream_closed", { message: errorMessage(err) });
      }
    } finally {
      entry.upstream = null;
      sub.close();
    }
  }

  /**
   * Reconnect loop: retries with capped exponential backoff until the
   * entry closes or a resubscribe succeeds. Every failed attempt is a
   * `gap` notice; success emits `resync` with a fresh baseline.
   * Returns the live subscription, or null when the entry closed.
   */
  private async reconnect(entry: SubscriptionEntry): Promise<Subscription | null> {
    entry.status = "reconnecting";
    let attempt = 0;
    while (!entry.closed) {
      attempt += 1;
      await sleep(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1)));
      if (entry.closed) return null;
      try {
        const subscriptions = await this.buildUpstreamSubscriptions(entry);
        const next = this.openSubscription(subscriptions);
        try {
          await next.started;
        } catch (err) {
          next.close();
          throw err;
        }
        if (entry.closed) {
          next.close();
          return null;
        }
        attempt = 0;
        entry.reconnects += 1;
        const baseline = await this.buildBaseline(entry);
        if (entry.closed) {
          next.close();
          return null;
        }
        entry.status = "live";
        this.pushNotice(entry, "resync", "reconnect", {
          baseline,
          upstream_subscriptions: subscriptions.length,
        });
        return next;
      } catch (err) {
        if (entry.closed) return null;
        if (err instanceof EventError) {
          // e.g. explicit pane_id vanished while disconnected — the
          // subscription can never succeed again; degrade honestly
          // instead of retrying forever.
          this.pushNotice(entry, "gap", "target_gone", {
            code: err.code,
            message: err.message,
          });
          entry.status = "closed";
          entry.closed = true;
          return null;
        }
        const { reason, detail } = subscribeFailure(err);
        this.pushNotice(entry, "gap", reason, detail);
      }
    }
    return null;
  }

  /** Pump loop: drain → reconnect → drain, until unsubscribe/closeAll. */
  private async pump(entry: SubscriptionEntry, first: Subscription): Promise<void> {
    let sub: Subscription | null = first;
    while (!entry.closed && sub !== null) {
      await this.drain(entry, sub);
      if (entry.closed) break;
      sub = await this.reconnect(entry);
    }
    entry.status = "closed";
  }

  /**
   * Register a subscription. The first upstream connect is awaited
   * eagerly: subscribe/ack failures (bad pane, unreachable socket,
   * rejected subscription) surface to the caller instead of looping.
   */
  async subscribe(spec: SubscribeSpec): Promise<{
    id: string;
    status: SubscriptionStatus;
    types: SubscriptionType[];
    filters: EventFilters;
    pane_ids: string[];
    pane_count: number;
    upstream_subscriptions: number;
    baseline: Record<string, unknown>;
    reconnect_policy: string;
  }> {
    const id = `sub-${++this.nextId}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: SubscriptionEntry = {
      id,
      spec,
      status: "starting",
      createdAt: new Date().toISOString(),
      seq: 0,
      items: [],
      overflowDropped: 0,
      reconnects: 0,
      closed: false,
      upstream: null,
      paneIds: [],
      waiters: [],
    };
    // First connect attempt inline so failures reach the caller.
    const subscriptions = await this.buildUpstreamSubscriptions(entry);
    const sub = this.openSubscription(subscriptions);
    try {
      await sub.started;
    } catch (err) {
      sub.close();
      if (err instanceof HerdrRpcError && /not_found|unknown/i.test(err.code)) {
        throw new EventError("not_found", `events.subscribe rejected: ${err.message}`, {
          upstream_code: err.code,
        });
      }
      throw new EventError(
        "session_unreachable",
        `events.subscribe failed: ${errorMessage(err)}`,
        subscribeFailure(err).detail,
      );
    }
    entry.status = "live";
    const baseline = await this.buildBaseline(entry);
    this.entries.set(id, entry);
    void this.pump(entry, sub);
    return {
      id,
      status: entry.status,
      types: spec.types,
      filters: spec.filters,
      pane_ids: entry.paneIds,
      pane_count: entry.paneIds.length,
      upstream_subscriptions: subscriptions.length,
      baseline,
      reconnect_policy:
        "auto-resubscribe with capped backoff; gap+resync notices bracket every disconnect",
    };
  }

  private getEntry(id: string): SubscriptionEntry {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new EventError("not_found", `unknown event subscription: ${id}`, {
        subscription_id: id,
      });
    }
    return entry;
  }

  private pollEntry(entry: SubscriptionEntry, cursor: number | undefined): PollResult {
    const after = cursor ?? 0;
    const events: BufferedEvent[] = [];
    const notices: BufferedNotice[] = [];
    for (const item of entry.items) {
      if (item.seq <= after) continue;
      if (item.kind === "event") events.push(item);
      else notices.push(item);
    }
    return {
      subscription_id: entry.id,
      status: entry.status,
      next_cursor: entry.seq,
      events,
      notices,
      reconnects: entry.reconnects,
    };
  }

  /** Non-blocking read of buffered items newer than `cursor`. */
  poll(id: string, cursor?: number): PollResult {
    const entry = this.getEntry(id);
    if (cursor !== undefined && (!Number.isFinite(cursor) || cursor < 0)) {
      invalidParams("cursor must be a non-negative number");
    }
    return this.pollEntry(entry, cursor);
  }

  /**
   * Block until at least one event newer than `cursor` arrives (or
   * `timeoutMs` elapses, capped at 120s). Notices do not satisfy the
   * wait but are returned. `types` optionally narrows matching event
   * names to canonical subscription types.
   */
  async wait(
    id: string,
    options: { cursor?: number; types?: string[]; timeoutMs?: number } = {},
  ): Promise<PollResult> {
    const entry = this.getEntry(id);
    if (options.cursor !== undefined && (!Number.isFinite(options.cursor) || options.cursor < 0)) {
      invalidParams("cursor must be a non-negative number");
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      invalidParams("timeout_ms must be a positive number");
    }
    const wanted =
      options.types === undefined ? null : new Set(options.types.map(canonicalEventName));
    if (wanted !== null) {
      for (const t of wanted) {
        if (!SUBSCRIPTION_TYPE_SET.has(t)) {
          invalidParams(`unknown event type filter: ${t}`);
        }
      }
    }
    const deadline = Date.now() + Math.min(timeoutMs, WAIT_TIMEOUT_CAP_MS);
    const hasMatch = (): boolean =>
      entry.items.some(
        (item) =>
          item.kind === "event" &&
          item.seq > (options.cursor ?? 0) &&
          (wanted === null || wanted.has(item.event)),
      );
    while (!entry.closed && !hasMatch() && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
        entry.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const result = this.pollEntry(entry, options.cursor);
    return { ...result, timed_out: !hasMatch() };
  }

  /** Tear down one subscription; buffered items are discarded honestly. */
  unsubscribe(id: string): {
    subscription_id: string;
    closed: boolean;
    discarded_items: number;
  } {
    const entry = this.getEntry(id);
    entry.closed = true;
    entry.upstream?.close();
    for (const wake of entry.waiters.splice(0)) wake();
    const discarded = entry.items.length;
    this.entries.delete(id);
    return { subscription_id: id, closed: true, discarded_items: discarded };
  }

  /** Close every subscription (server shutdown / stdin EOF). */
  closeAll(): void {
    for (const entry of this.entries.values()) {
      entry.closed = true;
      entry.upstream?.close();
      for (const wake of entry.waiters.splice(0)) wake();
    }
    this.entries.clear();
  }
}
