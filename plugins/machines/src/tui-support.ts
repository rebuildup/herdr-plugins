/**
 * Shared helpers for the rebuildup.machines interactive TUI surface
 * (`herdr-plugins.tui/v1`, ADR-0031/0032/0033 + ADR-0028, issue #247).
 *
 * Same architecture as the projects pilot (#240):
 *
 * - the TUI consumes the plugin's OWN public CLI (`src/cli.ts`) as a
 *   subprocess for every read — the same contract CLI/MCP/GUI
 *   consumers use, so CLI/MCP/GUI behavior cannot drift;
 * - pane opening goes through the documented socket API
 *   (`plugin.pane.open`), never private channels;
 * - target identity is pinned at launch (tui-v1 §3): the `open` action
 *   captures the origin context once and forwards it as explicit
 *   `HERDR_TUI_*` env pins on `plugin.pane.open`. `HERDR_PANE_ID` is the
 *   UI pane's own surface identity and is NEVER used as a target.
 *
 * READ-ONLY PLUGIN (ADR-0028): machine lifecycle stays with the herdr
 * CLI; the TUI exposes list + on-demand probe only. `probe` is a
 * read-class operation (it records last-known metadata in plugin
 * state) — it runs inside the task runner with progress + cancel.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { HerdrRpcError, request, resolveTarget } from "../../../packages/herdr-client/src/index";
import type { SelectItem } from "../../../packages/tui/src/index";
import { PLUGIN_ID } from "./model";

export { PLUGIN_ID };

// --- pinned target identity -------------------------------------------------

/**
 * Origin context captured at launch. Fields are `null` when unknown —
 * the UI must render that honestly rather than guess "current" focus.
 */
export interface PinnedTarget {
  /** Workspace the UI was launched from (pane placement target). */
  workspaceId: string | null;
  tabId: string | null;
  /** Origin focused pane at launch — context identity, NOT the UI pane. */
  originPaneId: string | null;
  /** Origin cwd — a display hint only, never auto-applied. */
  originCwd: string | null;
  /** Resolved herdr socket the UI talks to (display/diagnostics). */
  socketPath: string | null;
  /** Session name when the socket maps to a named session. */
  session: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Tolerant parse of `HERDR_PLUGIN_CONTEXT_JSON` (never throws). */
export function parsePluginContext(raw: string | undefined | null): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the pinned launch target. Precedence per field:
 * explicit `HERDR_TUI_*` env pins (set by the `open` action) →
 * `HERDR_PLUGIN_CONTEXT_JSON` origin fields → null.
 *
 * `HERDR_PANE_ID` is deliberately ignored: it identifies the UI pane
 * itself (surface identity), which is never a mutation target.
 */
export function resolvePinnedTarget(env: NodeJS.ProcessEnv = process.env): PinnedTarget {
  const context = parsePluginContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  const focusedPane =
    typeof context.focused_pane === "object" && context.focused_pane !== null
      ? (context.focused_pane as Record<string, unknown>)
      : {};

  const workspaceId = str(env.HERDR_TUI_WORKSPACE_ID) ?? str(context.workspace_id);
  const tabId = str(env.HERDR_TUI_TAB_ID) ?? str(context.tab_id);
  const originPaneId =
    str(env.HERDR_TUI_PANE_ID) ??
    str(context.focused_pane_id) ??
    str(focusedPane.pane_id) ??
    str(focusedPane.id);
  const originCwd =
    str(env.HERDR_TUI_CWD) ??
    str(focusedPane.cwd) ??
    str(context.cwd) ??
    str(context.workspace_cwd);

  let socketPath: string | null = null;
  let session: string | null = null;
  try {
    const resolved = resolveTarget({});
    socketPath = resolved.socketPath;
    session = resolved.session;
  } catch {
    // Target-resolution conflicts surface honestly through the CLI
    // subprocess anyway; the TUI only needs display values here.
  }

  return { workspaceId, tabId, originPaneId, originCwd, socketPath, session };
}

/** One-line human description of the pinned target for the status line. */
export function formatTargetLabel(target: PinnedTarget): string {
  const parts: string[] = [];
  if (target.session !== null) parts.push(`session ${target.session}`);
  if (target.workspaceId !== null) parts.push(`ws ${target.workspaceId}`);
  if (target.originPaneId !== null) parts.push(`pane ${target.originPaneId}`);
  if (target.originCwd !== null) parts.push(`cwd ${target.originCwd}`);
  return parts.length > 0 ? parts.join(" · ") : "no pinned target";
}

// --- pane opening (open action → plugin.pane.open) ---------------------------

/**
 * Params for `plugin.pane.open` (ADR-0031 verified shape). Placement is
 * `tab` per the tui-v1 placement policy: the machines inventory is a
 * workspace-scale browser, multi-instance safe, and pane-backed so
 * `plugin.pane.focus/close` keep working.
 */
export function buildPaneOpenParams(target: PinnedTarget): Record<string, unknown> {
  const env: Record<string, string> = {};
  if (target.workspaceId !== null) env.HERDR_TUI_WORKSPACE_ID = target.workspaceId;
  if (target.tabId !== null) env.HERDR_TUI_TAB_ID = target.tabId;
  if (target.originPaneId !== null) env.HERDR_TUI_PANE_ID = target.originPaneId;
  if (target.originCwd !== null) env.HERDR_TUI_CWD = target.originCwd;

  const params: Record<string, unknown> = {
    plugin_id: PLUGIN_ID,
    entrypoint: "main",
    placement: "tab",
    env,
  };
  if (target.workspaceId !== null) params.workspace_id = target.workspaceId;
  return params;
}

/**
 * Open the machines TUI pane through the documented socket API.
 * `plugin.pane.open` is a herdr-state mutation: target resolution runs
 * with `mutation: true` so an implicit default-session fallback fails
 * closed (`target_required`) instead of opening on the wrong session.
 */
export async function openMachinesPane(
  params: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const socketPath = resolveTarget({ mutation: true }).socketPath;
  return request(socketPath, "plugin.pane.open", params, {
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

// --- CLI subprocess bridge ----------------------------------------------------

/** This plugin's root (`plugins/machines`); HERDR_PLUGIN_ROOT wins. */
export function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot !== undefined && envRoot !== "") return envRoot;
  // src/tui-support.ts → plugins/machines
  return path.resolve(import.meta.dir, "..");
}

/** Structured failure from the machines CLI subprocess. */
export class MachinesCliError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "MachinesCliError";
  }
}

export interface CliRunOptions {
  /** Hard cap on the subprocess; default 120s (reads). Long ops pass more. */
  timeoutMs?: number;
  /** AbortSignal (task cancel) — kills the child process. */
  signal?: AbortSignal;
}

function parseCliEnvelope(
  stdout: string,
  stderr: string,
  exitCode: number,
): Record<string, unknown> {
  // The CLI emits one JSON document on stdout (pretty-printed); parse
  // the whole stream first, then fall back to per-line candidates.
  const trimmed = stdout.trim();
  if (trimmed !== "" && exitCode === 0) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not a single JSON document — try line-wise below
    }
  }
  const candidates = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .reverse();
  for (const line of candidates) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next line
    }
  }
  // Failure path: stderr carries {contract, ok:false, error:{...}}.
  let kind = "cli_error";
  let message = `machines cli exited ${exitCode} with no JSON output`;
  let extra: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(stderr) as {
      error?: { code?: unknown; kind?: unknown; message?: unknown } & Record<string, unknown>;
    };
    const err = parsed.error;
    if (err && typeof err === "object") {
      if (typeof err.message === "string") message = err.message;
      if (typeof err.kind === "string") kind = err.kind;
      else if (typeof err.code === "string") kind = err.code;
      const { code: _c, kind: _k, message: _m, ...rest } = err;
      if (Object.keys(rest).length > 0) extra = rest;
    }
  } catch {
    const tail = stderr.trim().split("\n").slice(-3).join(" | ");
    if (tail !== "") message = `${message}: ${tail.slice(0, 400)}`;
  }
  throw new MachinesCliError(message, kind, extra, exitCode);
}

/**
 * Run `bun <plugin>/src/cli.ts <args>` and return the parsed JSON
 * payload. The child inherits the full environment — including
 * HERDR_SOCKET_PATH/HERDR_SESSION/HERDR_PLUGIN_* — so it resolves the
 * SAME herdr session and plugin state dirs the TUI was launched in
 * (tui-v1 §3 identity pinning). No shell, argv only.
 */
export function runMachinesCli(
  args: readonly string[],
  options: CliRunOptions = {},
): Promise<Record<string, unknown>> {
  const root = pluginRoot();
  const cliPath = path.join(root, "src", "cli.ts");
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => {
      child.kill();
      finish(() => reject(new MachinesCliError("cancelled", "cancelled", undefined, 130)));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new MachinesCliError(`cli timed out after ${timeoutMs}ms`, "cli_timeout")),
      );
    }, timeoutMs);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish(() => reject(new MachinesCliError(String(err), "cli_spawn_error")));
    });
    child.on("close", (code) => {
      finish(() => {
        try {
          resolve(parseCliEnvelope(stdout, stderr, code ?? -1));
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}

// --- payload → view formatting (pure, unit-tested) ----------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** Saved machine as reported by `herdr machine list --json`. */
export interface MachineView {
  id: string;
  label: string;
  target: string;
  session: string;
  enabled: boolean;
  selected: boolean | null;
}

/** Last-known probe metadata merged into the list item (may be null). */
export interface ProbeView {
  state: string;
  probed_at: string;
  reachable: boolean | null;
  server_version: string | null;
  protocol: number | null;
  plugin_surface: string;
  plugin_surface_error: string | null;
  error_kind: string | null;
  error: string | null;
  plugins: Array<{ id: string; name: string | null; version: string | null }> | null;
}

export interface MachineItem {
  machine: MachineView;
  last_probe: ProbeView | null;
}

/** Tolerant parse of one `list` item; null when malformed (never fabricated). */
export function asMachineItem(value: unknown): MachineItem | null {
  const v = asRecord(value);
  if (v === null) return null;
  const m = asRecord(v.machine);
  if (m === null) return null;
  const id = m.id;
  if (typeof id !== "string" || id === "") return null;
  const machine: MachineView = {
    id,
    label: typeof m.label === "string" && m.label !== "" ? m.label : id,
    target: fmt(m.target),
    session: fmt(m.session),
    enabled: m.enabled !== false,
    selected: typeof m.selected === "boolean" ? m.selected : null,
  };
  const p = asRecord(v.last_probe);
  let lastProbe: ProbeView | null = null;
  if (p !== null && typeof p.state === "string") {
    lastProbe = {
      state: p.state,
      probed_at: fmt(p.probed_at),
      reachable: typeof p.reachable === "boolean" ? p.reachable : null,
      server_version: typeof p.server_version === "string" ? p.server_version : null,
      protocol: typeof p.protocol === "number" ? p.protocol : null,
      plugin_surface: fmt(p.plugin_surface),
      plugin_surface_error:
        typeof p.plugin_surface_error === "string" ? p.plugin_surface_error : null,
      error_kind: typeof p.error_kind === "string" ? p.error_kind : null,
      error: typeof p.error === "string" ? p.error : null,
      plugins: Array.isArray(p.plugins)
        ? p.plugins
            .map((pl) => {
              const r = asRecord(pl);
              if (r === null || typeof r.id !== "string") return null;
              return {
                id: r.id,
                name: typeof r.name === "string" ? r.name : null,
                version: typeof r.version === "string" ? r.version : null,
              };
            })
            .filter(
              (pl): pl is { id: string; name: string | null; version: string | null } =>
                pl !== null,
            )
        : null,
    };
  }
  return { machine, last_probe: lastProbe };
}

export function asMachineItems(value: unknown): MachineItem[] {
  return Array.isArray(value)
    ? value.map(asMachineItem).filter((m): m is MachineItem => m !== null)
    : [];
}

/** One-line probe summary for list rows. */
export function probeSummary(probe: ProbeView | null): string {
  if (probe === null) return "never probed";
  const parts = [`probe: ${probe.state}`];
  if (probe.server_version !== null) parts.push(`v${probe.server_version}`);
  if (probe.protocol !== null) parts.push(`proto ${probe.protocol}`);
  parts.push(`surface ${probe.plugin_surface}`);
  parts.push(`at ${probe.probed_at}`);
  return parts.join(" · ");
}

/** Select-list row for one saved machine. */
export function machineSelectItem(item: MachineItem): SelectItem<MachineItem> {
  const m = item.machine;
  const flags = [
    !m.enabled ? "disabled" : null,
    m.selected === true ? "selected" : null,
    item.last_probe !== null && item.last_probe.state !== "ok"
      ? `probe:${item.last_probe.state}`
      : null,
  ].filter((f): f is string => f !== null);
  const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  return {
    value: item,
    label: `${m.label} (${m.id})${suffix}`,
    detail: [
      `target: ${m.target} · session: ${m.session}`,
      `enabled: ${m.enabled} · selected: ${fmt(m.selected)}`,
      probeSummary(item.last_probe),
      "p probe this machine · a probe all · R refresh",
    ].join("\n"),
  };
}

/** Header + last-probe lines for the machine detail view. */
export function machineHeaderLines(item: MachineItem): string[] {
  const m = item.machine;
  const lines = [
    `machine ${m.label} (${m.id})`,
    `target: ${m.target}`,
    `session: ${m.session}`,
    `enabled: ${m.enabled} · selected: ${fmt(m.selected)}`,
  ];
  const p = item.last_probe;
  if (p === null) {
    lines.push("last probe: never probed");
  } else {
    lines.push(`last probe (${p.probed_at}):`);
    lines.push(`  state: ${p.state} · reachable: ${fmt(p.reachable)}`);
    lines.push(`  server: ${p.server_version ?? "unknown"} · protocol: ${fmt(p.protocol)}`);
    lines.push(`  plugin surface: ${p.plugin_surface}`);
    if (p.plugin_surface_error !== null) {
      lines.push(`  surface error: ${p.plugin_surface_error}`);
    }
    if (p.error_kind !== null || p.error !== null) {
      lines.push(`  error: ${p.error_kind ?? "?"}${p.error !== null ? ` — ${p.error}` : ""}`);
    }
    if (p.plugins !== null) {
      lines.push(`  remote plugins (${p.plugins.length}):`);
      for (const pl of p.plugins) {
        lines.push(
          `    ${pl.id}${pl.name !== null ? ` (${pl.name})` : ""}${pl.version !== null ? ` v${pl.version}` : ""}`,
        );
      }
    }
  }
  lines.push("");
  lines.push("p probe this machine · R refresh list");
  return lines;
}

/** Format a `probe` result payload (one or more MachineProbe entries). */
export function formatProbePayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const results = asArray(payload.results);
  if (results.length === 0) {
    lines.push("(no probe results)");
    return lines;
  }
  for (const r of results) {
    const id = fmt(r.machine_id);
    lines.push(`probe ${id} — ${fmt(r.state)} (at ${fmt(r.probed_at)})`);
    lines.push(
      `  reachable: ${fmt(r.reachable)} · server ${fmt(r.server_version)} · protocol ${fmt(r.protocol)}`,
    );
    lines.push(`  plugin surface: ${fmt(r.plugin_surface)}`);
    if (typeof r.plugin_surface_error === "string") {
      lines.push(`  surface error: ${r.plugin_surface_error}`);
    }
    if (r.error_kind !== null && r.error_kind !== undefined) {
      lines.push(
        `  error: ${fmt(r.error_kind)}${typeof r.error === "string" ? ` — ${r.error}` : ""}`,
      );
    }
    const plugins = Array.isArray(r.plugins) ? r.plugins : null;
    if (plugins !== null && plugins.length > 0) {
      lines.push(`  remote plugins (${plugins.length}):`);
      for (const pl of plugins) {
        const rec = asRecord(pl);
        if (rec === null) continue;
        lines.push(
          `    ${fmt(rec.id)}${typeof rec.name === "string" ? ` (${rec.name})` : ""}${typeof rec.version === "string" ? ` v${rec.version}` : ""}`,
        );
      }
    } else if (plugins !== null) {
      lines.push("  remote plugins: none reported");
    }
  }
  return lines;
}

/** Format the `capability` payload for an info detail view. */
export function formatCapabilityPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`contract: ${fmt(payload.contract)} (${fmt(payload.contract_status)})`);
  lines.push(`plugin: ${fmt(payload.plugin)} v${fmt(payload.version)}`);
  lines.push(`read_only: ${fmt(payload.read_only)}`);
  if (Array.isArray(payload.probe_states)) {
    lines.push(`probe states: ${payload.probe_states.join(", ")}`);
  }
  if (Array.isArray(payload.plugin_surfaces)) {
    lines.push(`plugin surfaces: ${payload.plugin_surfaces.join(", ")}`);
  }
  if (typeof payload.transport === "string") lines.push(`transport: ${payload.transport}`);
  if (Array.isArray(payload.notes)) {
    lines.push("notes:");
    for (const n of payload.notes) {
      if (typeof n === "string") lines.push(`  - ${n}`);
    }
  }
  return lines;
}

/** Error text for status lines: kind + message, never a stack. */
export function errorLine(err: unknown): string {
  if (err instanceof MachinesCliError) {
    return `${err.kind}: ${err.message}`;
  }
  if (err instanceof HerdrRpcError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
