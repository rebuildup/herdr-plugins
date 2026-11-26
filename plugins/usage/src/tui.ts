/**
 * rebuildup.usage interactive TUI (contract `herdr-plugins.tui/v1`,
 * ADR-0031/0032/0033, program #228 ticket #244).
 *
 * Browses the read-only `usage` / `quota` / `cost` / `divergence`
 * reports with in-TUI provider and period filters. The plugin has no
 * mutation commands (`mutation_commands: []`); the only stateful knob
 * is the explicit `--refresh` cache refresh on quota/cost, which is
 * user-triggered, never implicit on open.
 *
 * All data flows through this plugin's own CLI (`src/cli.ts <command>`
 * → JSON on stdout) — the same public surface agents and external
 * clients use. Quota/hub detail views redact credential-shaped keys
 * before display (ADR-0014/0015 boundary).
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

const PLUGIN_ID = "rebuildup.usage";
const PLUGIN_ROOT = process.env.HERDR_PLUGIN_ROOT ?? path.resolve(import.meta.dir, "..");
const CLI_PATH = path.join(PLUGIN_ROOT, "src", "cli.ts");
const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";
const CLI_TIMEOUT_MS = 90_000;

// --- CLI bridge -----------------------------------------------------------------

export interface CliResult {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
}

/** Run the plugin CLI and parse its single JSON document (see conversations tui). */
export function runCli(args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<CliResult> {
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
      resolve({ ok: false, data: null, error: `cli timed out after ${timeoutMs}ms` });
    }, timeoutMs);
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

// --- filters ------------------------------------------------------------------------

export type WindowPreset = "all" | "24h" | "7d" | "30d";
export const WINDOW_ORDER: readonly WindowPreset[] = ["all", "24h", "7d", "30d"];

export interface ReportFilters {
  provider: string; // "" = all
  window: WindowPreset;
}

export function windowArgs(w: WindowPreset, now = Date.now()): string[] {
  const spans: Record<Exclude<WindowPreset, "all">, number> = {
    "24h": 24 * 3600_000,
    "7d": 7 * 24 * 3600_000,
    "30d": 30 * 24 * 3600_000,
  };
  if (w === "all") return [];
  return ["--from", new Date(now - spans[w]).toISOString()];
}

export function providerArgs(provider: string): string[] {
  return provider === "" ? [] : ["--provider", provider];
}

export function windowLabel(w: WindowPreset): string {
  return w === "all" ? "all time" : `last ${w}`;
}

/** Provider ids observed in a report payload (for the `p` cycle). */
export function providersInPayload(payload: Record<string, unknown> | null): string[] {
  const ids = new Set<string>();
  if (payload === null) return [];
  const breakdowns = payload.breakdowns as Record<string, unknown> | undefined;
  const byProvider = Array.isArray(breakdowns?.by_provider) ? breakdowns.by_provider : [];
  for (const row of byProvider) {
    const key = (row as Record<string, unknown> | null)?.key;
    if (typeof key === "string" && key !== "") ids.add(key);
  }
  const coverage = payload.coverage as Record<string, unknown> | undefined;
  const covProviders = Array.isArray(coverage?.providers) ? coverage.providers : [];
  for (const row of covProviders) {
    const p = (row as Record<string, unknown> | null)?.provider;
    if (typeof p === "string" && p !== "") ids.add(p);
  }
  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  for (const row of providers) {
    const p = (row as Record<string, unknown> | null)?.provider;
    if (typeof p === "string" && p !== "") ids.add(p);
  }
  const comparisons = Array.isArray(payload.comparisons) ? payload.comparisons : [];
  for (const row of comparisons) {
    const p = (row as Record<string, unknown> | null)?.provider;
    if (typeof p === "string" && p !== "") ids.add(p);
  }
  return [...ids].sort();
}

/** Cycle provider filter: "" (all) → each observed id → "". */
export function nextProvider(current: string, ids: readonly string[]): string {
  const cycle = ["", ...ids];
  const i = cycle.indexOf(current);
  return cycle[(i + 1) % cycle.length] ?? "";
}

// --- secret redaction (ADR-0014/0015 display boundary) --------------------------------

const SECRET_KEY = /key|token|secret|credential|authorization|password/i;

/** Deep-copy `value` dropping object keys that look like credential material. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = redactSecrets(v);
    }
    return out;
  }
  return value;
}

// --- small formatting helpers ------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtUsd(n: number | null): string {
  if (n === null) return "(not reported)";
  return `$${n.toFixed(n < 0.01 ? 6 : 4)}`;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec).filter((r): r is Record<string, unknown> => r !== null) : [];
}

/** Pretty JSON lines for a DetailView, bounded. */
export function jsonLines(value: unknown, maxLines = 400): string[] {
  let textOut: string;
  try {
    textOut = JSON.stringify(redactSecrets(value), null, 2);
  } catch {
    textOut = String(value);
  }
  const lines = textOut.split("\n");
  if (lines.length > maxLines) {
    return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`];
  }
  return lines;
}

// --- shared async report view ------------------------------------------------------------

interface ReportViewOptions {
  title: string;
  /** CLI args (command first). */
  args: (filters: ReportFilters) => string[];
  /** Render payload → lines (excluding chrome). */
  render: (payload: Record<string, unknown>, filters: ReportFilters) => string[];
  /** Optional extra key handling; return true when consumed. */
  onKey?: (ev: KeyEvent, view: ReportViewBase) => boolean;
  keymapExtra?: KeyBinding[];
  /** Whether period filters apply (usage/cost/divergence: yes; quota: no). */
  windowed?: boolean;
  /** Refresh uses --refresh (quota/cost network refetch). */
  refreshable?: boolean;
  emptyText?: string;
}

/**
 * Base class for report screens: loads via runCli inside app.tasks,
 * renders honest loading/error/empty states, shared r/w/p/f keys.
 */
export class ReportViewBase implements ScreenView {
  protected readonly app: TuiApp;
  protected readonly opts: ReportViewOptions;
  protected payload: Record<string, unknown> | null = null;
  protected error: string | null = null;
  protected loading = false;
  protected providerIds: string[] = [];
  private scroll = 0;

  constructor(app: TuiApp, opts: ReportViewOptions) {
    this.app = app;
    this.opts = opts;
    void this.reload(false);
  }

  get filters(): ReportFilters {
    return this.appFilters;
  }

  protected appFilters: ReportFilters = { provider: "", window: "all" };

  protected async reload(refresh: boolean): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    const args = this.opts.args(this.appFilters);
    if (refresh) args.push("--refresh");
    const res = await this.app.tasks.run(
      { label: `usage ${this.opts.title}`, timeoutMs: CLI_TIMEOUT_MS + 30_000 },
      async () => runCli(args, CLI_TIMEOUT_MS + 30_000),
    );
    this.loading = false;
    if (res.status !== "ok" || res.value === undefined) {
      this.error = res.error ?? res.status;
      this.payload = null;
      return;
    }
    const v = res.value;
    if (v.ok && v.data) {
      this.payload = v.data;
      this.providerIds = providersInPayload(v.data);
    } else {
      this.error = v.error ?? "report failed";
      this.payload = null;
    }
  }

  handleKey(ev: KeyEvent): boolean {
    if (ev.kind !== "key") return false;
    if (this.opts.onKey?.(ev, this) === true) return true;
    if (matchKey(ev, "r")) {
      void this.reload(false);
      return true;
    }
    if (matchKey(ev, "f") && this.opts.refreshable === true) {
      void this.reload(true);
      return true;
    }
    if (matchKey(ev, "p")) {
      this.appFilters = {
        ...this.appFilters,
        provider: nextProvider(this.appFilters.provider, this.providerIds),
      };
      void this.reload(false);
      return true;
    }
    if (matchKey(ev, "w") && this.opts.windowed !== false) {
      const i = WINDOW_ORDER.indexOf(this.appFilters.window);
      this.appFilters = {
        ...this.appFilters,
        window: WINDOW_ORDER[(i + 1) % WINDOW_ORDER.length] ?? "all",
      };
      void this.reload(false);
      return true;
    }
    if (matchKey(ev, "up") || matchKey(ev, "k")) {
      this.scroll = Math.max(0, this.scroll - 1);
      return true;
    }
    if (matchKey(ev, "down") || matchKey(ev, "j")) {
      this.scroll += 1;
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
    return false;
  }

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    const filterDesc =
      `provider: ${this.appFilters.provider === "" ? "all" : this.appFilters.provider}` +
      (this.opts.windowed !== false ? ` · window: ${windowLabel(this.appFilters.window)}` : "");
    lines.push([
      { text: clip(`${this.opts.title} — ${filterDesc}`, width), style: { bold: true } },
    ]);
    lines.push(hr(width));

    const bodyH = Math.max(1, height - 4);
    let body: string[];
    if (this.loading && this.payload === null) {
      body = ["loading…"];
    } else if (this.error !== null) {
      body = [`error: ${this.error}`, "", "r — retry · esc — back"];
    } else if (this.payload === null) {
      body = [this.opts.emptyText ?? "(no data)"];
    } else {
      body = this.opts.render(this.payload, this.appFilters);
    }
    // Wrap each source line into display rows (bounded).
    const wrapped: string[] = [];
    for (const l of body) {
      for (const wl of wrapPlain(l, Math.max(10, width - 2))) wrapped.push(wl);
      if (wrapped.length > 2000) break;
    }
    const maxScroll = Math.max(0, wrapped.length - bodyH);
    this.scroll = Math.min(this.scroll, maxScroll);
    const view = wrapped.slice(this.scroll, this.scroll + bodyH);
    for (const v of view) lines.push([{ text: clip(v, width) }]);
    while (lines.length < height - 2) lines.push([]);
    lines.push(hr(width));
    const hints =
      "  ↑↓/jk — scroll · r — reload" +
      (this.opts.windowed !== false ? " · w — window" : "") +
      " · p — provider" +
      (this.opts.refreshable === true ? " · f — refresh" : "") +
      " · esc — back";
    lines.push(dim(clip(hints, width)));
    return lines.slice(0, height);
  }

  keymap(): KeyBinding[] {
    const b: KeyBinding[] = [
      { keys: ["↑", "k", "↓", "j"], description: "scroll" },
      { keys: ["pgup", "pgdn", "space"], description: "page" },
      { keys: "r", description: "reload" },
      { keys: "p", description: "cycle provider" },
    ];
    if (this.opts.windowed !== false) b.push({ keys: "w", description: "cycle window" });
    if (this.opts.refreshable === true) b.push({ keys: "f", description: "refresh sources" });
    b.push({ keys: ["esc", "q"], description: "back" });
    return [...b, ...(this.opts.keymapExtra ?? [])];
  }
}

/** Word-wrap a plain line to `width` cells (ASCII-safe approximation). */
export function wrapPlain(s: string, width: number): string[] {
  if (displayWidth(s) <= width) return [s];
  const words = s.split(/\s+/).filter((w) => w !== "");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur === "" ? w : `${cur} ${w}`;
    if (displayWidth(candidate) <= width) {
      cur = candidate;
    } else {
      if (cur !== "") out.push(cur);
      cur = w;
    }
  }
  if (cur !== "") out.push(cur);
  // Hard-split any still-too-long word.
  const final: string[] = [];
  for (const l of out) {
    if (displayWidth(l) <= width) {
      final.push(l);
    } else {
      let rest = l;
      while (displayWidth(rest) > width) {
        final.push(clip(rest, width));
        rest = rest.slice(width);
      }
      if (rest !== "") final.push(rest);
    }
  }
  return final.length > 0 ? final : [""];
}

// --- usage / cost report -----------------------------------------------------------------

function breakdownLines(
  breakdowns: Record<string, unknown> | null,
  dims: readonly string[],
  maxRows: number,
): string[] {
  const lines: string[] = [];
  if (breakdowns === null) return lines;
  for (const dim of dims) {
    const rows = arr(breakdowns[dim]);
    if (rows.length === 0) continue;
    lines.push(`  ${dim}:`);
    for (const r of rows.slice(0, maxRows)) {
      const key = str(r.key) ?? "(none)";
      const cost =
        typeof r.provider_reported_cost_usd === "number"
          ? ` · cost ${fmtUsd(r.provider_reported_cost_usd)}`
          : "";
      lines.push(
        `    ${clip(key, 28).padEnd(28)} ev=${fmtInt(num(r.events)).padStart(7)} ` +
          `in=${fmtInt(num(r.input_tokens)).padStart(10)} out=${fmtInt(num(r.output_tokens)).padStart(10)} ` +
          `total=${fmtInt(num(r.total_tokens)).padStart(12)}${cost}`,
      );
    }
    if (rows.length > maxRows) lines.push(`    … ${rows.length - maxRows} more (b — browse)`);
  }
  return lines;
}

function usageReportLines(payload: Record<string, unknown>, title: string): string[] {
  const lines: string[] = [];
  const totals = rec(payload.totals);
  const hints: string[] = [];
  if (str(payload.hint)) hints.push(str(payload.hint) as string);
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  for (const w of warnings) {
    if (typeof w === "string") hints.push(`warning: ${w}`);
  }

  if (totals === null) {
    lines.push("(no totals in payload)");
  } else {
    lines.push("totals:");
    lines.push(
      `  events=${fmtInt(num(totals.events))} · sessions_with_usage=${fmtInt(num(totals.sessions_with_usage))}`,
    );
    lines.push(
      `  tokens: in=${fmtInt(num(totals.input_tokens))} out=${fmtInt(num(totals.output_tokens))} ` +
        `cache_read=${fmtInt(num(totals.cache_read_input_tokens))} ` +
        `cache_write=${fmtInt(num(totals.cache_creation_input_tokens))} ` +
        `total=${fmtInt(num(totals.total_tokens))}` +
        (totals.thinking_tokens !== null && totals.thinking_tokens !== undefined
          ? ` (thinking=${fmtInt(num(totals.thinking_tokens))})`
          : ""),
    );
    lines.push(
      `  provider-reported cost: ${fmtUsd(
        typeof totals.provider_reported_cost_usd === "number"
          ? totals.provider_reported_cost_usd
          : null,
      )} over ${fmtInt(num(totals.provider_reported_cost_events))} event(s) — not a bill`,
    );
    const excluded = num(totals.excluded_untimestamped_events);
    const dups = num(totals.duplicate_events_skipped);
    const noId = num(totals.events_without_event_id);
    if (excluded + dups + noId > 0) {
      lines.push(`  excluded: untimestamped=${excluded} duplicates=${dups} no_event_id=${noId}`);
    }
  }

  if (title === "cost") {
    const cost = rec(payload.cost);
    if (cost !== null) {
      lines.push("", "cost (ESTIMATE — list-price math, never a bill):");
      lines.push(`  estimated_cost_usd: ${fmtUsd(numOrNull(cost.estimated_cost_usd))}`);
      lines.push(`  estimate_complete: ${cost.estimate_complete === true}`);
      lines.push(
        `  priced_models=${num(cost.priced_models)} · unpriced_models=${num(
          Array.isArray(cost.unpriced_models) ? cost.unpriced_models.length : 0,
        )}`,
      );
      const pricing = rec(cost.pricing);
      if (pricing !== null) {
        lines.push(
          `  pricing: ${str(pricing.status) ?? "?"} · source=${str(pricing.source) ?? "?"}` +
            ` · known_models=${num(pricing.known_models)} · user_overrides=${num(pricing.user_overrides)}`,
        );
        const detail = str(pricing.detail);
        if (detail) lines.push(`  pricing detail: ${detail}`);
      }
      const disclaimer = str(cost.disclaimer);
      if (disclaimer) lines.push(`  ${disclaimer}`);
    }
  }

  const cacheTokens = rec(payload.cache_tokens);
  if (cacheTokens !== null) {
    const providers = arr(cacheTokens.providers);
    if (providers.length > 0) {
      lines.push("", "cache tokens:");
      for (const p of providers) {
        const detail = str(p.detail);
        lines.push(
          `  ${str(p.provider) ?? "?"}: ${str(p.status) ?? "?"} · ` +
            `read=${fmtInt(num(p.cache_read_input_tokens))} write=${fmtInt(num(p.cache_creation_input_tokens))}` +
            (detail ? ` · ${detail}` : ""),
        );
      }
    }
  }

  const coverage = rec(payload.coverage);
  if (coverage !== null) {
    lines.push(
      "",
      `coverage: sessions=${num(coverage.sessions_total)} ok=${num(coverage.sessions_ok)} ` +
        `issues=${num(coverage.sessions_with_issues)} stale=${num(coverage.sessions_stale)} ` +
        `events_missing=${num(coverage.sessions_events_missing)}`,
    );
    const covProviders = arr(coverage.providers);
    if (covProviders.length > 0) {
      lines.push("  providers:");
      for (const p of covProviders) {
        lines.push(
          `    ${str(p.provider) ?? "?"}: status=${str(p.provider_status) ?? "?"} ` +
            `sessions=${num(p.sessions)} ok=${num(p.sessions_ok)} ` +
            `issues=${num(p.sessions_with_issues)} usage_events=${num(p.usage_events)}`,
        );
      }
    }
  }

  const breakdowns = rec(payload.breakdowns);
  const bd = breakdownLines(breakdowns, ["by_provider", "by_model"], 12);
  if (bd.length > 0) {
    lines.push("", "breakdowns:");
    lines.push(...bd);
  }

  const sessions = arr(payload.sessions);
  if (sessions.length > 0) {
    lines.push("", `sessions contributing: ${sessions.length}`);
  }

  const source = rec(payload.source);
  if (source !== null) {
    lines.push(
      `source: ${str(source.plugin) ?? "?"} via ${str(source.resolved_via) ?? "?"} · ` +
        `pages=${num(source.pages)} complete=${source.complete === true}`,
    );
  }
  for (const h of hints) lines.push(h);
  return lines;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// --- report views -------------------------------------------------------------------------

const BREAKDOWN_DIMS = [
  "by_provider",
  "by_model",
  "by_host",
  "by_project",
  "by_session",
  "by_pane",
] as const;

class UsageReportView extends ReportViewBase {
  constructor(app: TuiApp, command: "usage" | "cost") {
    super(app, {
      title: command === "usage" ? "usage" : "cost estimate",
      windowed: true,
      refreshable: command === "cost",
      args: (f) => [command, ...windowArgs(f.window), ...providerArgs(f.provider)],
      render: (payload) => usageReportLines(payload, command),
      emptyText: "no usage data — run `rebuildup.conversations index` first",
    });
  }

  /** `b` — browse breakdown entries (dimension → entry → JSON detail). */
  protected openBreakdowns(): void {
    const payload = this.payload;
    if (payload === null) return;
    const breakdowns = rec(payload.breakdowns);
    if (breakdowns === null) {
      this.app.setStatus("no breakdowns in current report", "", { dim: true });
      return;
    }
    const dims = BREAKDOWN_DIMS.filter((d) => arr(breakdowns[d]).length > 0);
    if (dims.length === 0) {
      this.app.setStatus("no breakdown rows in current report", "", { dim: true });
      return;
    }
    void (async () => {
      const dim = await this.app.select({
        items: dims.map((d) => ({
          value: d,
          label: d,
          detail: `${arr(breakdowns[d]).length} rows`,
        })),
      });
      if (dim === null) return;
      const rows = arr(breakdowns[dim.value]);
      const entry = await this.app.select({
        items: rows.map((r, i) => ({
          value: i,
          label: str(r.key) ?? "(none)",
          detail: `events=${num(r.events)} total_tokens=${num(r.total_tokens)}`,
        })),
      });
      if (entry === null) return;
      const row = rows[entry.value];
      if (row === undefined) return;
      const view = new DetailView({
        title: `${dim.value} — ${str(row.key) ?? "(none)"}`,
        lines: jsonLines(row),
      });
      view.onClose = () => this.app.pop();
      this.app.push(view);
    })();
  }

  override handleKey(ev: KeyEvent): boolean {
    if (ev.kind === "key" && matchKey(ev, "b")) {
      this.openBreakdowns();
      return true;
    }
    return super.handleKey(ev);
  }

  override keymap(): KeyBinding[] {
    return [...super.keymap(), { keys: "b", description: "browse breakdowns" }];
  }
}

// --- quota view ------------------------------------------------------------------------------

interface QuotaItem {
  kind: "provider" | "hub-account";
  label: string;
  detail: string;
  data: Record<string, unknown>;
}

export function quotaItems(payload: Record<string, unknown>): QuotaItem[] {
  const items: QuotaItem[] = [];
  for (const p of arr(payload.providers)) {
    const provider = str(p.provider) ?? "?";
    const status = str(p.status) ?? "?";
    const windows = arr(p.windows);
    const used = windows
      .map((w) => {
        const pct = w.used_percent;
        const label = str(w.label) ?? str(w.id) ?? "window";
        return typeof pct === "number" ? `${label} ${pct.toFixed(0)}%` : null;
      })
      .filter((s): s is string => s !== null)
      .join(", ");
    const stale = p.stale === true ? " · STALE" : "";
    const detailStr = str(p.detail);
    items.push({
      kind: "provider",
      label: provider,
      detail:
        `${status}${stale}` +
        (used !== "" ? ` · ${used}` : "") +
        (detailStr ? ` · ${detailStr}` : ""),
      data: p,
    });
  }
  for (const hub of arr(payload.hubs)) {
    const hubId = str(hub.id) ?? "hub";
    for (const acct of arr(hub.accounts)) {
      const provider = str(acct.provider) ?? "?";
      const status = str(acct.status) ?? "?";
      const windows = arr(acct.windows);
      const used = windows
        .map((w) => {
          const pct = w.used_percent;
          const label = str(w.label) ?? str(w.id) ?? "window";
          return typeof pct === "number" ? `${label} ${pct.toFixed(0)}%` : null;
        })
        .filter((s): s is string => s !== null)
        .join(", ");
      items.push({
        kind: "hub-account",
        label: `${hubId} · ${str(acct.account) ?? "account"}`,
        detail: `${provider}: ${status}${used !== "" ? ` · ${used}` : ""}`,
        data: { hub: hubId, account: acct },
      });
    }
    if (arr(hub.accounts).length === 0) {
      items.push({
        kind: "hub-account",
        label: hubId,
        detail: `hub status: ${str(hub.status) ?? "?"}${str(hub.detail) ? ` · ${str(hub.detail)}` : ""}`,
        data: { hub: hubId, hub_status: hub.status, detail: hub.detail },
      });
    }
  }
  return items;
}

class QuotaView extends ReportViewBase {
  private items: QuotaItem[] = [];
  private readonly list: SelectList<QuotaItem>;

  constructor(app: TuiApp) {
    super(app, {
      title: "quota",
      windowed: false,
      refreshable: true,
      args: (f) => ["quota", ...providerArgs(f.provider)],
      render: () => [],
      emptyText: "no quota providers reported",
    });
    this.list = new SelectList<QuotaItem>({
      items: [],
      emptyText: "(no quota providers — f to refresh sources)",
      filterable: true,
    });
    this.list.onSelect = (item) => {
      if (item.value === null) return;
      const view = new DetailView({
        title: item.value.label,
        lines: jsonLines(item.value.data),
      });
      view.onClose = () => this.app.pop();
      this.app.push(view);
    };
    this.list.onCancel = () => this.app.pop();
  }

  protected override async reload(refresh: boolean): Promise<void> {
    await super.reload(refresh);
    this.items = this.payload !== null ? quotaItems(this.payload) : [];
    this.list.setItems(this.items.map((i) => ({ value: i, label: i.label, detail: i.detail })));
  }

  override handleKey(ev: KeyEvent): boolean {
    // The SelectList owns navigation/enter/filter; ReportViewBase owns
    // r/f/p. SelectList returns false for unbound keys, so both get a turn.
    if (this.list.handleKey(ev) === true) return true;
    return super.handleKey(ev);
  }

  override render(width: number, height: number): Line[] {
    const header = `quota — provider: ${this.appFilters.provider === "" ? "all" : this.appFilters.provider}`;
    const lines: Line[] = [[{ text: clip(header, width), style: { bold: true } }], hr(width)];
    if (this.loading && this.payload === null) {
      lines.push([{ text: "  loading…", style: { dim: true } }]);
    } else if (this.error !== null) {
      lines.push([{ text: `  error: ${clip(this.error, width - 10)}`, style: { fg: "red" } }]);
    } else if (this.payload !== null) {
      const cache = rec(this.payload.cache);
      if (cache !== null) {
        lines.push(
          dim(
            `  cache ttl=${num(cache.ttl_seconds)}s · providers=${this.items.length} · f — refresh sources`,
          ),
        );
      }
      // The SelectList renders the provider/account rows.
      const inner = this.list.render(width, Math.max(1, height - lines.length - 2));
      for (const l of inner.slice(0, Math.max(0, height - lines.length - 2))) lines.push(l);
    } else {
      lines.push([{ text: `  ${this.opts.emptyText ?? "(no data)"}`, style: { dim: true } }]);
    }
    while (lines.length < height - 2) lines.push([]);
    lines.push(hr(width));
    lines.push(
      dim(
        "  ↑↓/jk — move · / — filter · enter — detail · r — reload · f — refresh · p — provider · esc — back",
      ),
    );
    return lines.slice(0, height);
  }

  override keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "detail" },
      { keys: "r", description: "reload (cached)" },
      { keys: "f", description: "refresh sources" },
      { keys: "p", description: "cycle provider" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- divergence view -------------------------------------------------------------------------

interface DivergenceItem {
  provider: string;
  verdict: string;
  detail: string;
  data: Record<string, unknown>;
}

export function divergenceItems(payload: Record<string, unknown>): DivergenceItem[] {
  return arr(payload.comparisons).map((c) => {
    const provider = str(c.provider) ?? "?";
    const verdict = str(c.verdict) ?? "?";
    const detail = str(c.detail);
    const quota = rec(c.quota);
    const measured = rec(c.measured);
    const bits: string[] = [];
    if (quota !== null) bits.push(`quota:${str(quota.status) ?? "?"}`);
    if (measured !== null) bits.push(`measured total_tokens=${num(measured.total_tokens)}`);
    return {
      provider,
      verdict,
      detail: [verdict, detail, ...bits].filter((s) => s !== null && s !== "").join(" · "),
      data: c,
    };
  });
}

class DivergenceView extends ReportViewBase {
  private items: DivergenceItem[] = [];
  private readonly list: SelectList<DivergenceItem>;

  constructor(app: TuiApp) {
    super(app, {
      title: "quota vs measured divergence",
      windowed: true,
      args: (f) => ["divergence", ...windowArgs(f.window), ...providerArgs(f.provider)],
      render: () => [],
      emptyText: "no divergence data",
    });
    this.list = new SelectList<DivergenceItem>({
      items: [],
      emptyText: "(no comparisons)",
      filterable: true,
    });
    this.list.onSelect = (item) => {
      if (item.value === null) return;
      const view = new DetailView({
        title: `divergence — ${item.value.provider}`,
        lines: jsonLines(item.value.data),
      });
      view.onClose = () => this.app.pop();
      this.app.push(view);
    };
    this.list.onCancel = () => this.app.pop();
  }

  protected override async reload(refresh: boolean): Promise<void> {
    await super.reload(refresh);
    this.items = this.payload !== null ? divergenceItems(this.payload) : [];
    this.list.setItems(this.items.map((i) => ({ value: i, label: i.provider, detail: i.detail })));
  }

  override handleKey(ev: KeyEvent): boolean {
    if (this.list.handleKey(ev) === true) return true;
    return super.handleKey(ev);
  }

  override render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    const header =
      `divergence — provider: ${this.appFilters.provider === "" ? "all" : this.appFilters.provider}` +
      ` · window: ${windowLabel(this.appFilters.window)}`;
    lines.push([{ text: clip(header, width), style: { bold: true } }], hr(width));
    if (this.payload !== null) {
      for (const n of Array.isArray(this.payload.notes) ? this.payload.notes : []) {
        if (typeof n === "string") lines.push(dim(`  note: ${clip(n, width - 8)}`));
      }
      const hubs = arr(this.payload.hubs);
      if (hubs.length > 0) {
        lines.push(dim(`  hub readings (excluded from comparisons): ${hubs.length}`));
      }
    }
    const innerH = Math.max(1, height - lines.length - 2);
    if (this.loading && this.payload === null) {
      lines.push([{ text: "  loading…", style: { dim: true } }]);
    } else if (this.error !== null) {
      lines.push([{ text: `  error: ${clip(this.error, width - 10)}`, style: { fg: "red" } }]);
    } else {
      const inner = this.list.render(width, innerH);
      for (const l of inner.slice(0, innerH)) lines.push(l);
    }
    while (lines.length < height - 2) lines.push([]);
    lines.push(hr(width));
    lines.push(
      dim(
        "  ↑↓/jk — move · / — filter · enter — detail · r — reload · w — window · p — provider · esc — back",
      ),
    );
    return lines.slice(0, height);
  }

  override keymap(): KeyBinding[] {
    return [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "comparison detail" },
      { keys: "r", description: "reload" },
      { keys: "w", description: "cycle window" },
      { keys: "p", description: "cycle provider" },
      { keys: ["esc", "q"], description: "back" },
    ];
  }
}

// --- top-level reports picker -----------------------------------------------------------------

interface ReportEntry {
  id: "usage" | "quota" | "cost" | "divergence";
  label: string;
  detail: string;
}

const REPORTS: readonly ReportEntry[] = [
  {
    id: "usage",
    label: "usage",
    detail: "token totals by provider/model/host/project/session/pane",
  },
  { id: "quota", label: "quota", detail: "subscription quota & reset windows (direct + hubs)" },
  { id: "cost", label: "cost", detail: "estimated API cost (list-price estimate, never a bill)" },
  { id: "divergence", label: "divergence", detail: "quota vs measured usage, side by side" },
];

class ReportsView implements ScreenView {
  private readonly app: TuiApp;
  private readonly list: SelectList<ReportEntry>;

  constructor(app: TuiApp) {
    this.app = app;
    this.list = new SelectList<ReportEntry>({
      items: REPORTS.map((r) => ({ value: r, label: r.label, detail: r.detail })),
      filterable: false,
    });
    this.list.onSelect = (item) => {
      if (item.value === null) return;
      this.openReport(item.value.id);
    };
    this.list.onCancel = () => void this.app.close();
  }

  private openReport(id: ReportEntry["id"]): void {
    switch (id) {
      case "usage":
        this.app.push(new UsageReportView(this.app, "usage"));
        break;
      case "cost":
        this.app.push(new UsageReportView(this.app, "cost"));
        break;
      case "quota":
        this.app.push(new QuotaView(this.app));
        break;
      case "divergence":
        this.app.push(new DivergenceView(this.app));
        break;
    }
  }

  handleKey(ev: KeyEvent): boolean {
    return this.list.handleKey(ev) === true;
  }

  render(width: number, height: number): Line[] {
    return this.list.render(width, height);
  }

  keymap(): KeyBinding[] {
    return this.list.keymap();
  }
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
      `usage: failed to open TUI pane (herdr ${HERDR_BIN}): ${result.error ?? `exit ${result.code}`}\n`,
    );
    return 1;
  }
  return 0;
}

const NON_TTY_NOTICE = [
  "rebuildup.usage TUI requires an interactive terminal.",
  "CLI equivalent: bun run src/cli.ts <capability|usage|quota|cost|divergence>",
];

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--open")) return openPane();

  if (!process.stdin.isTTY) {
    for (const line of NON_TTY_NOTICE) process.stdout.write(`${line}\n`);
    return 0;
  }

  const app = await TuiApp.create({ title: "rebuildup.usage" });
  app.setView(new ReportsView(app));
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
