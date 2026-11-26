/**
 * rebuildup.conversations interactive TUI (contract `herdr-plugins.tui/v1`,
 * ADR-0031/0032/0033, program #228 ticket #244).
 *
 * Surfaces the read contract (`sessions` / `history` / `search` / `show`)
 * as a browsable terminal UI plus an explicit, confirm-gated `index`
 * re-run. All data flows through this plugin's own CLI
 * (`src/cli.ts <command>` → JSON on stdout) — the same public surface
 * agents and external clients use; the TUI never reads state files or
 * PTY text directly.
 *
 * Safety contract highlights:
 * - opening performs reads only; `index` runs only via `i` + confirm
 *   (mutation_commands gating from `capability`)
 * - untrusted transcript text is rendered through packages/tui's
 *   sanitizer (no CSI/OSC injection)
 * - honest empty/missing/unavailable states; non-TTY gets a plain notice
 *
 * Entrypoints (herdr-plugin.toml):
 *   `bun run src/tui.ts main`  — pane entrypoint (the UI)
 *   `bun run src/tui.ts --open`— action: opens the `main` pane via
 *                               `plugin.pane.open` (HERDR_BIN_PATH) and
 *                               returns promptly
 */

import { spawn } from "node:child_process";
import path from "node:path";
import {
  boundText,
  clip,
  DetailView,
  dim,
  displayWidth,
  hr,
  type KeyBinding,
  type KeyEvent,
  type Line,
  matchKey,
  type ScreenView,
  SelectList,
  TuiApp,
} from "../../../packages/tui/src/index";
import type { ConversationEvent } from "./model";

const PLUGIN_ID = "rebuildup.conversations";
const PLUGIN_ROOT = process.env.HERDR_PLUGIN_ROOT ?? path.resolve(import.meta.dir, "..");
const CLI_PATH = path.join(PLUGIN_ROOT, "src", "cli.ts");
const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";
const CLI_TIMEOUT_MS = 60_000;

// --- CLI bridge -----------------------------------------------------------------

export interface CliResult {
  ok: boolean;
  /** Parsed JSON payload on success. */
  data: Record<string, unknown> | null;
  /** Human-readable failure detail (stderr error.message or transport). */
  error: string | null;
}

/**
 * Run the plugin CLI and parse its single JSON document. The CLI writes
 * the payload to stdout and `{ok:false,error}` diagnostics to stderr;
 * both are handled without leaking either into the TUI frame raw.
 */
export function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: PLUGIN_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, data: null, error: `cli timed out after ${CLI_TIMEOUT_MS}ms` });
    }, CLI_TIMEOUT_MS);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, data: null, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        let message = `cli exited ${code}`;
        try {
          const parsed = JSON.parse(stderr.trim().split("\n").pop() ?? "") as {
            error?: { message?: string };
          };
          if (parsed.error?.message) message = parsed.error.message;
        } catch {
          const tail = stderr.trim().split("\n").pop();
          if (tail) message = boundText(tail, 300);
        }
        resolve({ ok: false, data: null, error: message });
        return;
      }
      try {
        resolve({ ok: true, data: JSON.parse(stdout) as Record<string, unknown>, error: null });
      } catch {
        resolve({ ok: false, data: null, error: "cli produced non-JSON output" });
      }
    });
  });
}

// --- payload → view models ---------------------------------------------------------

export interface SessionEntry {
  key: string;
  provider: string;
  sessionId: string;
  status: string;
  error: string | null;
  stale: boolean;
  staleReason: string | null;
  eventCount: number;
  turnCount: number;
  lastEventAt: string | null;
  cwd: string | null;
  transcriptPresent: boolean;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** `sessions` command payload → selectable entries (order preserved). */
export function sessionEntries(payload: Record<string, unknown>): SessionEntry[] {
  const list = Array.isArray(payload.sessions) ? payload.sessions : [];
  const out: SessionEntry[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    const key = str(s.key);
    if (key === null) continue;
    const identity = (s.identity ?? null) as Record<string, unknown> | null;
    out.push({
      key,
      provider: str(s.provider) ?? "unknown",
      sessionId: str(s.session_id) ?? key,
      status: str(s.status) ?? "unknown",
      error: str(s.error),
      stale: s.stale === true,
      staleReason: str(s.stale_reason),
      eventCount: num(s.event_count),
      turnCount: num(s.turn_count),
      lastEventAt: str(s.last_event_at),
      cwd: str(s.cwd) ?? (identity ? str(identity.cwd) : null),
      transcriptPresent: s.transcript_present !== false,
    });
  }
  return out;
}

/** One row in a paged event browser (history or search result). */
export interface EventRow {
  sessionKey: string;
  event: ConversationEvent;
}

export interface EventPage {
  rows: EventRow[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Honest caveats (malformed lines, duplicates, selector notes). */
  notes: string[];
}

function eventFromJson(raw: unknown): ConversationEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.type !== "string") return null;
  return e as unknown as ConversationEvent;
}

/** `history` command payload → EventPage. */
export function historyPage(payload: Record<string, unknown>): EventPage {
  const events = Array.isArray(payload.events) ? payload.events : [];
  const page = (payload.page ?? {}) as Record<string, unknown>;
  const notes: string[] = [];
  const malformed = num(page.malformed_lines);
  const dups = num(page.duplicates_skipped);
  if (malformed > 0) notes.push(`${malformed} malformed line(s) skipped`);
  if (dups > 0) notes.push(`${dups} duplicate event(s) skipped`);
  const note = str(payload.selector_note);
  if (note) notes.push(`note: ${note}`);
  const hint = str(payload.hint);
  if (hint) notes.push(hint);
  const session = (payload.session ?? {}) as Record<string, unknown>;
  const sessNote = str(session.error);
  if (sessNote) notes.push(`session: ${sessNote}`);
  return {
    rows: events
      .map((e) => eventFromJson(e))
      .filter((e): e is ConversationEvent => e !== null)
      .map((event) => ({
        sessionKey: str(session.key) ?? "",
        event,
      })),
    nextCursor: str(page.next_cursor),
    hasMore: page.has_more === true,
    notes,
  };
}

/** `search` command payload → EventPage (next_cursor is opaque). */
export function searchPage(payload: Record<string, unknown>): EventPage {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const page = (payload.page ?? {}) as Record<string, unknown>;
  const notes: string[] = [];
  const malformed = num(page.malformed_lines);
  const dups = num(page.duplicates_skipped);
  const restarted = Array.isArray(page.restarted_sessions) ? page.restarted_sessions.length : 0;
  if (malformed > 0) notes.push(`${malformed} malformed line(s) skipped`);
  if (dups > 0) notes.push(`${dups} duplicate event(s) skipped`);
  if (restarted > 0) notes.push(`${restarted} session(s) restarted during scan`);
  const note = str(payload.selector_note);
  if (note) notes.push(`note: ${note}`);
  const hint = str(payload.hint);
  if (hint) notes.push(hint);
  return {
    rows: results
      .map((r) => {
        if (typeof r !== "object" || r === null) return null;
        const rec = r as Record<string, unknown>;
        const event = eventFromJson(rec.event);
        if (event === null) return null;
        return { sessionKey: str(rec.session_key) ?? "", event };
      })
      .filter((r): r is EventRow => r !== null),
    nextCursor: page.has_more === true ? str(page.next_cursor) : null,
    hasMore: page.has_more === true,
    notes,
  };
}

// --- formatting ---------------------------------------------------------------------

function tsShort(ts: string | null): string {
  if (ts === null) return "----";
  // ISO-8601 → "MM-DD HH:MM" (UTC); untrusted but fixed-shape provider data.
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(ts);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : boundText(ts, 16);
}

function eventPreview(event: ConversationEvent): string {
  const parts: string[] = [];
  if (event.text) parts.push(event.text);
  if (event.tool_name) parts.push(`[tool:${event.tool_name}]`);
  if (event.subtype) parts.push(`[${event.subtype}]`);
  if (event.model) parts.push(`<${event.model}>`);
  if (event.is_error === true) parts.push("(error)");
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined === "" ? event.event_id : joined;
}

/** Detail lines for one event (read-only inspection; sanitized at render). */
export function eventDetailLines(row: EventRow): string[] {
  const e = row.event;
  const lines: string[] = [];
  lines.push(`type:        ${e.type}`);
  lines.push(`event_id:    ${e.event_id}`);
  if (row.sessionKey !== "") lines.push(`session:     ${row.sessionKey}`);
  if (e.turn_index !== null && e.turn_index !== undefined) {
    lines.push(`turn:        ${e.turn_index}`);
  }
  lines.push(`timestamp:   ${e.timestamp ?? "(none)"}`);
  if (e.sidechain === true) lines.push(`sidechain:   true`);
  if (e.model) lines.push(`model:       ${e.model}`);
  if (e.tool_use_id) lines.push(`tool_use_id: ${e.tool_use_id}`);
  if (e.tool_name) lines.push(`tool_name:   ${e.tool_name}`);
  if (e.is_error !== undefined) lines.push(`is_error:    ${e.is_error}`);
  if (e.subtype) lines.push(`subtype:     ${e.subtype}`);
  if (e.usage) {
    const u = e.usage;
    lines.push(
      `usage:       in=${u.input_tokens} out=${u.output_tokens} ` +
        `cache_read=${u.cache_read_input_tokens} cache_write=${u.cache_creation_input_tokens}` +
        (u.thinking_tokens !== undefined ? ` thinking=${u.thinking_tokens}` : ""),
    );
  }
  if (e.cost_usd !== undefined) lines.push(`cost_usd:    ${e.cost_usd}`);
  if (e.text !== undefined && e.text !== "") {
    lines.push("", "text:", boundText(e.text, 8000), ...(e.text_truncated ? ["(truncated)"] : []));
  }
  if (e.tool_input !== undefined) {
    let rendered: string;
    try {
      rendered = JSON.stringify(e.tool_input, null, 2);
    } catch {
      rendered = String(e.tool_input);
    }
    lines.push(
      "",
      "tool_input:",
      boundText(rendered, 4000),
      ...(e.input_truncated ? ["(truncated)"] : []),
    );
  }
  return lines;
}

// --- paged event browser -------------------------------------------------------------

export type EventLoader = (
  cursor: string | null,
) => Promise<{ ok: true; page: EventPage } | { ok: false; error: string }>;

/**
 * Scrollable, paged event list shared by `history` (per session) and
 * `search` (cross-session). Read-only; `n`/`p` page through opaque
 * cursors, `enter` opens a sanitized detail view.
 */
export class EventListView implements ScreenView {
  private readonly titleText: string;
  private readonly emptyText: string;
  private readonly loadPage: EventLoader;
  private cursors: (string | null)[] = [null];
  private pos = 0;
  private rows: EventRow[] = [];
  private notes: string[] = [];
  private loading = false;
  private error: string | null = null;
  private scroll = 0;
  private readonly app: TuiApp;

  constructor(app: TuiApp, opts: { title: string; emptyText?: string; load: EventLoader }) {
    this.app = app;
    this.titleText = opts.title;
    this.emptyText = opts.emptyText ?? "(no events)";
    this.loadPage = opts.load;
    void this.refresh();
  }

  /** (Re)load the current page. Exposed for tests. */
  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    const cursor = this.cursors[this.pos] ?? null;
    const res = await this.loadPage(cursor);
    this.loading = false;
    if (!res.ok) {
      this.error = res.error;
      this.rows = [];
      this.notes = [];
      this.hasMore = false;
      this.nextCursor = null;
      return;
    }
    this.rows = res.page.rows;
    this.notes = res.page.notes;
    this.hasMore = res.page.hasMore;
    this.nextCursor = res.page.nextCursor;
    this.scroll = 0;
  }

  private async goto(delta: 1 | -1): Promise<void> {
    const nextPos = this.pos + delta;
    if (nextPos < 0 || nextPos >= this.cursors.length) return;
    this.pos = nextPos;
    await this.refresh();
  }

  private async next(): Promise<void> {
    if (this.loading || !this.hasMore || this.nextCursor === null) return;
    this.cursors = this.cursors.slice(0, this.pos + 1);
    this.cursors.push(this.nextCursor);
    this.pos += 1;
    await this.refresh();
  }

  private hasMore = false;
  private nextCursor: string | null = null;

  private openDetail(row: EventRow): void {
    const view = new DetailView({
      title: `${row.event.type} · ${row.event.event_id}`,
      lines: eventDetailLines(row),
    });
    view.onClose = () => this.app.pop();
    this.app.push(view);
  }

  handleKey(ev: KeyEvent): boolean {
    if (ev.kind !== "key") return false;
    if (this.loading) {
      // While a page loads, only cancel-ish keys pass through to the app.
      return !matchKey(ev, "escape");
    }
    if (matchKey(ev, "down") || matchKey(ev, "j")) {
      this.scroll += 1;
      return true;
    }
    if (matchKey(ev, "up") || matchKey(ev, "k")) {
      this.scroll = Math.max(0, this.scroll - 1);
      return true;
    }
    if (matchKey(ev, "pageup")) {
      this.scroll = Math.max(0, this.scroll - 10);
      return true;
    }
    if (matchKey(ev, "pagedown") || matchKey(ev, "space")) {
      this.scroll += 10;
      return true;
    }
    if (matchKey(ev, "home")) {
      this.scroll = 0;
      return true;
    }
    if (matchKey(ev, "end")) {
      this.scroll = Number.MAX_SAFE_INTEGER;
      return true;
    }
    if (matchKey(ev, "enter")) {
      const row = this.rows[this.scroll];
      if (row) this.openDetail(row);
      return true;
    }
    if (matchKey(ev, "n")) {
      void this.next();
      return true;
    }
    if (matchKey(ev, "p")) {
      void this.goto(-1);
      return true;
    }
    if (matchKey(ev, "r")) {
      void this.refresh();
      return true;
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    const header = `${this.titleText} — page ${this.pos + 1}/${Math.max(1, this.cursors.length)}`;
    lines.push([{ text: clip(header, width), style: { bold: true } }]);
    if (this.loading) {
      lines.push(dim("  loading…"));
    } else if (this.error !== null) {
      lines.push([{ text: `  error: ${clip(this.error, width - 10)}`, style: { fg: "red" } }]);
      lines.push(dim("  r — retry"));
    } else if (this.rows.length === 0) {
      lines.push([{ text: `  ${this.emptyText}`, style: { dim: true } }]);
      for (const n of this.notes.slice(0, 3)) lines.push(dim(`  ${clip(n, width - 4)}`));
    } else {
      const bodyH = Math.max(1, height - lines.length - 2);
      const maxScroll = Math.max(0, this.rows.length - bodyH);
      this.scroll = Math.min(this.scroll, maxScroll);
      const windowRows = this.rows.slice(this.scroll, this.scroll + bodyH);
      for (const row of windowRows) {
        const e = row.event;
        const badge = `[${e.type}]`.padEnd(18);
        const turn = e.turn_index !== null && e.turn_index !== undefined ? `t${e.turn_index}` : "-";
        const left = `${badge} ${turn.padEnd(5)} ${tsShort(e.timestamp ?? null).padEnd(11)} `;
        const preview = clip(eventPreview(e), Math.max(10, width - displayWidth(left) - 4));
        lines.push([{ text: `  ${left}`, style: { dim: true } }, { text: preview }]);
      }
      if (this.rows.length > bodyH) {
        lines.push(
          dim(
            `  ${this.scroll + 1}-${Math.min(this.scroll + bodyH, this.rows.length)}/${this.rows.length}`,
          ),
        );
      }
      const noteLines = this.notes.slice(0, Math.max(0, height - lines.length - 2));
      for (const n of noteLines) lines.push(dim(`  ${clip(n, width - 4)}`));
    }
    lines.push(hr(width));
    lines.push(
      dim(
        this.error !== null
          ? "  r — retry · esc — back"
          : "  ↑↓/jk — scroll · enter — detail · n/p — page · r — reload · esc — back",
      ),
    );
    while (lines.length < height) lines.push([]);
    return lines.slice(0, height);
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      { keys: "enter", description: "event detail" },
      { keys: ["n", "p"], description: "next/prev page" },
      { keys: "r", description: "reload" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- sessions browser -----------------------------------------------------------------

interface CapabilityInfo {
  ok: boolean;
  mutationCommands: Set<string>;
  error: string | null;
}

/**
 * Top-level session list. Read-only on open; `i` runs the `index`
 * mutation only after capability gating + explicit confirmation.
 */
export class SessionsView implements ScreenView {
  private readonly app: TuiApp;
  private readonly list: SelectList<SessionEntry>;
  private entries: SessionEntry[] = [];
  private caps: CapabilityInfo = { ok: false, mutationCommands: new Set(), error: null };
  private notice: string | null = null;

  constructor(app: TuiApp) {
    this.app = app;
    this.list = new SelectList<SessionEntry>({
      items: [],
      emptyText: "(no indexed sessions — press i to index, or run `bun run src/cli.ts index`)",
      filterable: true,
    });
    this.list.onSelect = (item) => {
      if (item.value) this.openSession(item.value);
    };
    this.list.onCancel = () => void this.app.close();
    void this.boot();
  }

  private async boot(): Promise<void> {
    const [caps, sessions] = await Promise.all([runCli(["capability"]), runCli(["sessions"])]);
    if (caps.ok && caps.data) {
      const cmds = Array.isArray(caps.data.mutation_commands) ? caps.data.mutation_commands : [];
      this.caps = {
        ok: true,
        mutationCommands: new Set(cmds.filter((c): c is string => typeof c === "string")),
        error: null,
      };
    } else {
      this.caps = {
        ok: false,
        mutationCommands: new Set(),
        error: caps.error ?? "capability unavailable",
      };
    }
    this.applySessions(sessions);
  }

  private applySessions(res: CliResult): void {
    if (!res.ok || !res.data) {
      this.notice = `sessions: ${res.error ?? "unavailable"}`;
      this.list.setItems([]);
      return;
    }
    this.entries = sessionEntries(res.data);
    this.list.setItems(
      this.entries.map((e) => ({
        value: e,
        label: `${e.provider}:${shortId(e.sessionId)}`,
        detail:
          `${e.status}${e.stale ? " · STALE" : ""} · ${e.eventCount} events · ` +
          `${e.turnCount} turns · last ${tsShort(e.lastEventAt)} · ${e.cwd ?? "(no cwd)"}` +
          (e.error ? ` · error: ${e.error}` : "") +
          (!e.transcriptPresent ? " · transcript missing" : ""),
      })),
    );
  }

  private async reload(): Promise<void> {
    this.notice = null;
    const res = await runCli(["sessions"]);
    this.applySessions(res);
  }

  private openSession(entry: SessionEntry): void {
    const view = new EventListView(this.app, {
      title: `history — ${entry.key}`,
      emptyText: `no events for ${entry.key} (status: ${entry.status})`,
      load: async (cursor) => {
        const args = ["history", "--session-id", entry.key, "--limit", "200"];
        if (cursor !== null) args.push("--cursor", cursor);
        const res = await runCli(args);
        if (!res.ok || !res.data) return { ok: false, error: res.error ?? "history failed" };
        return { ok: true, page: historyPage(res.data) };
      },
    });
    this.app.push(view);
  }

  private async search(): Promise<void> {
    const query = await this.app.prompt("Search all indexed sessions", {
      placeholder: "substring over text/tool/model fields",
    });
    if (query === null || query.trim() === "") return;
    const q = query.trim();
    const view = new EventListView(this.app, {
      title: `search — "${q}"`,
      emptyText: `no matches for "${q}"`,
      load: async (cursor) => {
        const args = ["search", q, "--limit", "200"];
        if (cursor !== null) args.push("--cursor", cursor);
        const res = await runCli(args);
        if (!res.ok || !res.data) return { ok: false, error: res.error ?? "search failed" };
        return { ok: true, page: searchPage(res.data) };
      },
    });
    this.app.push(view);
  }

  private async reindex(): Promise<void> {
    if (!this.caps.ok) {
      this.notice = `reindex unavailable: capability check failed (${this.caps.error ?? "unknown"})`;
      return;
    }
    if (!this.caps.mutationCommands.has("index")) {
      this.notice = "reindex unavailable: 'index' not in mutation_commands";
      return;
    }
    const ok = await this.app.confirm({
      title: "Reindex conversations",
      target: [
        "scope: every agent pane transcript visible to herdr in this session",
        "writes: <stateDir>/events/*.jsonl + state.json (opencode logs are rewritten)",
      ],
      consequence:
        "Re-scans provider transcripts and rewrites normalized event logs. " +
        "This is the plugin's only mutation; it never touches PTY or agent state.",
      confirmLabel: "Reindex",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    this.notice = "indexing…";
    const result = await this.app.tasks.run(
      { label: "Indexing transcripts", timeoutMs: 120_000 },
      async () => runCli(["index"]),
    );
    if (result.status !== "ok" || result.value === undefined) {
      this.notice = `index failed: ${result.error ?? result.status}`;
      return;
    }
    const v = result.value;
    if (v.ok && v.data) {
      const indexed = num(v.data.sessions_indexed);
      const appended = num(v.data.events_appended);
      const skipped = Array.isArray(v.data.skipped) ? v.data.skipped.length : 0;
      this.notice = `indexed ${indexed} session(s), ${appended} event(s) appended, ${skipped} skipped`;
    } else {
      this.notice = `index failed: ${v.error ?? "unknown"}`;
    }
    await this.reload();
  }

  handleKey(ev: KeyEvent): boolean {
    if (ev.kind !== "key") return false;
    // The SelectList gets first refusal: while its `/`-filter is active it
    // swallows every key, so i/s/r can never fire mid-filter.
    if (this.list.handleKey(ev) === true) return true;
    if (matchKey(ev, "i")) {
      void this.reindex();
      return true;
    }
    if (matchKey(ev, "s")) {
      void this.search();
      return true;
    }
    if (matchKey(ev, "r")) {
      void this.reload();
      return true;
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    const out = this.list.render(width, Math.max(1, height - 2));
    const lines = out.slice(0, Math.max(0, height - 2));
    while (lines.length < Math.max(0, height - 2)) lines.push([]);
    const status = this.notice ?? this.caps.error ?? "";
    lines.push(hr(width));
    lines.push(dim(`  ${clip(status, width - 4)}`));
    lines.push(
      dim("  enter — history · / — filter · s — search · i — reindex · r — reload · esc — close"),
    );
    return lines.slice(0, height);
  }

  keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter sessions" },
      { keys: "enter", description: "session history" },
      { keys: "s", description: "search all sessions" },
      { keys: "i", description: "reindex (confirm)" },
      { keys: "r", description: "reload" },
      { keys: ["esc", "q"], description: "close" },
    ];
  }
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

// --- entrypoint ------------------------------------------------------------------------

/** argv for `plugin.pane.open` (exported for tests). */
export function paneOpenArgs(): string[] {
  return [
    "plugin",
    "pane",
    "open",
    "--plugin",
    PLUGIN_ID,
    "--entrypoint",
    "main",
    "--placement",
    "tab",
  ];
}

/** `--open` action: ask herdr to open the `main` pane, then exit promptly. */
async function openPane(): Promise<number> {
  const result = await new Promise<{ code: number | null; error: string | null }>((resolve) => {
    const child = spawn(HERDR_BIN, paneOpenArgs(), {
      cwd: PLUGIN_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: null, error: err.message }));
    child.on("close", (code) => resolve({ code, error: stderr.trim() || null }));
  });
  if (result.code !== 0) {
    process.stderr.write(
      `conversations: failed to open TUI pane (herdr ${HERDR_BIN}): ${result.error ?? `exit ${result.code}`}\n`,
    );
    return 1;
  }
  return 0;
}

const NON_TTY_NOTICE = [
  "rebuildup.conversations TUI requires an interactive terminal.",
  "CLI equivalent: bun run src/cli.ts <capability|index|refresh|sessions|history|search|show|usage>",
];

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--open")) return openPane();

  if (!process.stdin.isTTY) {
    for (const line of NON_TTY_NOTICE) process.stdout.write(`${line}\n`);
    return 0;
  }

  const app = await TuiApp.create({
    title: "rebuildup.conversations",
    keymap: [
      { keys: "s", description: "search all sessions" },
      { keys: "i", description: "reindex (confirm)" },
      { keys: "r", description: "reload" },
    ],
  });
  app.setView(new SessionsView(app));
  await app.closed;
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
