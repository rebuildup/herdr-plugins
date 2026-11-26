/**
 * Shared helpers for the rebuildup.handoff interactive TUI surface
 * (`herdr-plugins.tui/v1`, ADR-0031/0032/0033).
 *
 * Same architecture as the rebuildup.projects/controls TUI (#240/#245):
 *
 * - every contract operation runs through this plugin's OWN CLI
 *   (`src/cli.ts`) as a subprocess — the same
 *   `herdr-plugins.handoff/v1` surface CLI/MCP/GUI consumers use, so
 *   behavior cannot drift and the CLI's staleness gates stay the
 *   single enforcement point;
 * - pane/workspace *enumeration* for execute target pickers is a
 *   read-only `session.snapshot` through the documented socket API
 *   (target selection is herdr state, not plugin state);
 * - pane opening goes through the documented socket API
 *   (`plugin.pane.open`), never private channels;
 * - target identity is pinned at launch (tui-v1 §3): the `open` action
 *   captures the origin context once and forwards it as explicit
 *   `HERDR_TUI_*` env pins on `plugin.pane.open`. `HERDR_PANE_ID` is the
 *   UI pane's own surface identity and is NEVER used as a target.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  type AgentInfo,
  HerdrRpcError,
  type PaneInfo,
  request,
  resolveTarget,
  type SessionSnapshot,
  sessionSnapshot,
  type WorkspaceInfo,
} from "../../../packages/herdr-client/src/index";
import type { SelectItem } from "../../../packages/tui/src/index";
import { HANDOFF_STATUSES, type HandoffRecord, PLUGIN_ID } from "./model";

export { PLUGIN_ID };
export const PLUGIN_VERSION = "0.7.0";

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

  return { workspaceId, tabId, originPaneId, socketPath, session };
}

/** One-line human description of the pinned target for the status line. */
export function formatTargetLabel(target: PinnedTarget): string {
  const parts: string[] = [];
  if (target.session !== null) parts.push(`session ${target.session}`);
  if (target.workspaceId !== null) parts.push(`ws ${target.workspaceId}`);
  if (target.originPaneId !== null) parts.push(`pane ${target.originPaneId}`);
  return parts.length > 0 ? parts.join(" · ") : "no pinned target";
}

// --- pane opening (open action → plugin.pane.open) ---------------------------

/**
 * Params for `plugin.pane.open` (ADR-0031 verified shape). Placement is
 * `tab` per the tui-v1 placement policy: the handoff record browser is
 * a workspace-scale surface, multi-instance safe, and pane-backed so
 * `plugin.pane.focus/close` keep working.
 */
export function buildPaneOpenParams(target: PinnedTarget): Record<string, unknown> {
  const env: Record<string, string> = {};
  if (target.workspaceId !== null) env.HERDR_TUI_WORKSPACE_ID = target.workspaceId;
  if (target.tabId !== null) env.HERDR_TUI_TAB_ID = target.tabId;
  if (target.originPaneId !== null) env.HERDR_TUI_PANE_ID = target.originPaneId;

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
 * Open the handoff TUI pane through the documented socket API.
 * `plugin.pane.open` is a herdr-state mutation: target resolution runs
 * with `mutation: true` so an implicit default-session fallback fails
 * closed (`target_required`) instead of opening on the wrong session.
 */
export async function openHandoffPane(
  params: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const socketPath = resolveTarget({ mutation: true }).socketPath;
  return request(socketPath, "plugin.pane.open", params, {
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

// --- CLI subprocess bridge ----------------------------------------------------

/** This plugin's root (`plugins/handoff`); HERDR_PLUGIN_ROOT wins. */
export function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot !== undefined && envRoot !== "") return envRoot;
  // src/tui-support.ts → plugins/handoff
  return path.resolve(import.meta.dir, "..");
}

/** Structured failure from the handoff CLI subprocess. */
export class HandoffCliError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "HandoffCliError";
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
  let kind = "cli_error";
  let message = `handoff cli exited ${exitCode} with no JSON output`;
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
  throw new HandoffCliError(message, kind, extra, exitCode);
}

/**
 * Run `bun <plugin>/src/cli.ts <args>` and return the parsed JSON
 * payload. The child inherits the full environment — including
 * HERDR_SOCKET_PATH/HERDR_SESSION/HERDR_PLUGIN_* — so it resolves the
 * SAME herdr session and plugin state dirs the TUI was launched in
 * (tui-v1 §3 identity pinning). No shell, argv only.
 */
export function runHandoffCli(
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
      finish(() => reject(new HandoffCliError("cancelled", "cancelled", undefined, 130)));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new HandoffCliError(`cli timed out after ${timeoutMs}ms`, "cli_timeout")),
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
      finish(() => reject(new HandoffCliError(String(err), "cli_spawn_error")));
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

// --- mutation gating (capability / mutation_commands) ------------------------

/** Subset of the `capability` payload the TUI consults (tui-v1 §5.4). */
export interface CapabilityDoc {
  read_only?: boolean;
  mutation_commands?: unknown;
  [key: string]: unknown;
}

export interface MutationGate {
  allowed: boolean;
  /** Human-readable reason when disabled — rendered, never hidden. */
  reason: string | null;
}

/**
 * Fail-closed gate: a missing capability document disables ALL
 * mutations (honest unsupported, contract item 9/4). `command` is the
 * CLI command path exactly as listed in `mutation_commands`
 * (handoff: "create", "status", "execute", "delegate", "merge-back").
 */
export function mutationAllowed(capability: CapabilityDoc | null, command: string): MutationGate {
  if (capability === null) {
    return {
      allowed: false,
      reason: "capability document unavailable — mutations disabled (fail closed)",
    };
  }
  if (capability.read_only === true) {
    return { allowed: false, reason: "plugin reports read_only" };
  }
  const commands = Array.isArray(capability.mutation_commands)
    ? capability.mutation_commands.filter((c): c is string => typeof c === "string")
    : [];
  if (!commands.includes(command)) {
    return {
      allowed: false,
      reason: `"${command}" is not in mutation_commands`,
    };
  }
  return { allowed: true, reason: null };
}

// --- session reads (documented socket API; never mutations) -------------------

export interface SessionSurfaces {
  panes: PaneInfo[];
  workspaces: WorkspaceInfo[];
  /** pane_id → AgentInfo (busy-pane detection for target pickers). */
  agents: Record<string, AgentInfo>;
  sessionName: string | null;
}

/**
 * Read-only enumeration for execute target pickers
 * (`--target-pane`/`--target-workspace`). `session.snapshot` is the
 * documented public socket surface. Never used for mutation decisions;
 * `execute` revalidates everything through its own staleness gates.
 */
export async function readSessionSurfaces(): Promise<SessionSurfaces> {
  const snapshot: SessionSnapshot = await sessionSnapshot({});
  return {
    panes: snapshot.panes ?? [],
    workspaces: snapshot.workspaces ?? [],
    agents: snapshot.agents ?? {},
    sessionName: str(snapshot.session?.name),
  };
}

/** Focus a pane through the documented `pane.focus` socket method. */
export async function focusPane(paneId: string): Promise<unknown> {
  const socketPath = resolveTarget({}).socketPath;
  return request(socketPath, "pane.focus", { pane_id: paneId });
}

/**
 * Whether the record's source pane may be focused from THIS session.
 * Pane ids repeat across sessions, so focus is only attempted when the
 * record's host matches this host AND its herdr session matches the
 * resolved one (`null` = default/implicit socket on both sides).
 */
export function canFocusSource(
  record: HandoffRecord,
  current: { host: string; session: string | null },
): boolean {
  if (record.transfer.host !== current.host) return false;
  const recorded = record.transfer.herdr_session;
  if (recorded === null) return current.session === null;
  return recorded === current.session;
}

/** Current host for `canFocusSource` (display/focus guard only). */
export function localHost(): string {
  return os.hostname();
}

/** Error text for status lines: kind + message, never a stack. */
export function errorLine(err: unknown): string {
  if (err instanceof HandoffCliError) {
    return `${err.kind}: ${err.message}`;
  }
  if (err instanceof HerdrRpcError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// --- record → view formatting (pure, unit-tested) ------------------------------

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
}

/** List-item row for one handoff record (from `list` payload `items[]`). */
export function recordSelectItem(item: Record<string, unknown>): SelectItem<string> {
  const id = str(item.id) ?? "?";
  const status = str(item.status) ?? "?";
  const strategy = str(item.strategy) ?? "?";
  const transfer = asRecord(item.transfer);
  const paneId = str(transfer?.pane_id);
  const provider = str(transfer?.provider_kind);
  const rel = asRecord(item.relationship);
  const badges = [
    status,
    strategy,
    rel !== null ? `${str(rel.kind) ?? "link"}→${str(rel.parent_id) ?? "?"}` : null,
    typeof item.child_count === "number" && (item.child_count as number) > 0
      ? `children:${item.child_count}`
      : null,
  ].filter((b): b is string => b !== null);
  const label = `${id}  [${badges.join(" ")}]`;
  const detail = [
    `status: ${status} · strategy: ${strategy}`,
    `source: ${fmt(transfer?.host)} / ${fmt(transfer?.herdr_session)} pane ${paneId ?? "?"}${provider !== null ? ` (${provider})` : ""}`,
    `created: ${fmt(item.created_at)} · refs: ${fmt(item.ref_count)}`,
    `target pane: ${fmt(item.target_pane_id)}`,
    `transfer_check: ${fmt(asRecord(item.transfer_check)?.state)}`,
  ].join("\n");
  return { value: id, label, detail };
}

/** Header + check lines for a `status` payload (detail view top). */
export function formatStatusLines(payload: Record<string, unknown>): string[] {
  const record = asRecord(payload.handoff) as HandoffRecord | null;
  const lines: string[] = [];
  if (record === null) {
    lines.push("status returned no handoff record");
    return lines;
  }
  const t = record.transfer;
  lines.push(`id: ${record.id} · status: ${record.status} · strategy: ${record.strategy}`);
  lines.push(
    `source: host ${t.host} · session ${t.herdr_session ?? "default"} · ws ${t.workspace_id ?? "?"} · tab ${t.tab_id ?? "?"} · pane ${t.pane_id}`,
  );
  lines.push(
    `provider: ${t.provider_kind ?? "unknown"} · agent_session: ${t.agent_session?.value ?? "none"} · seq: ${t.state_change_seq ?? "?"}`,
  );
  if (record.target !== null && record.target !== undefined) {
    lines.push(
      `target hint: ${
        [
          record.target.pane_id !== undefined ? `pane ${record.target.pane_id}` : null,
          record.target.workspace_id !== undefined ? `ws ${record.target.workspace_id}` : null,
          record.target.provider_hint !== undefined
            ? `provider ${record.target.provider_hint}`
            : null,
        ]
          .filter((s): s is string => s !== null)
          .join(" · ") || "(empty)"
      }`,
    );
  }
  const exec = record.execution;
  if (exec !== undefined) {
    lines.push(
      `execution: ${exec.strategy_used} (${exec.provider_kind ?? "?"}) → ${exec.target?.pane_id ?? "no target"} agent ${exec.agent?.name ?? "?"}/${exec.agent?.kind ?? "?"}`,
    );
    if (exec.remote !== undefined) {
      lines.push(
        `remote: ${exec.remote.label} (${exec.remote.machine_id}) → ${exec.remote.target} session ${exec.remote.session} · server ${exec.remote.server_version ?? "?"}`,
      );
    }
    if (exec.worktree !== undefined) {
      lines.push(
        `worktree: ${exec.worktree.path} branch ${exec.worktree.branch ?? "?"} ws ${exec.worktree.workspace_id ?? "?"}`,
      );
    }
    if (exec.error !== null && exec.error !== undefined) {
      lines.push(`exec error @${exec.error.step}: ${exec.error.message}`);
    }
  } else {
    lines.push("execution: never executed");
  }
  const lineage = asRecord(payload.lineage);
  if (lineage !== null) {
    const rel = asRecord(lineage.relationship);
    const parent = asRecord(lineage.parent);
    const children = asArray(lineage.children);
    if (rel !== null) {
      lines.push(
        `lineage: ${str(rel.kind)} → parent ${str(rel.parent_id)}${parent !== null ? ` (${str(parent.status)})` : ""}${lineage.parent_missing === true ? " [parent MISSING]" : ""}`,
      );
    }
    if (children.length > 0) {
      lines.push(
        `children: ${children.map((c) => `${str(c.id)}(${str(c.status)}/${str(c.kind) ?? "?"})`).join(", ")}`,
      );
    }
  }
  const tc = asRecord(payload.transfer_check);
  const kc = asRecord(payload.target_check);
  const rc = asRecord(payload.remote_check);
  lines.push(
    `transfer_check: ${fmt(tc?.state)}${tc?.reason !== undefined && tc?.reason !== null ? ` (${fmt(tc.reason)})` : ""}` +
      ` · target_check: ${fmt(kc?.state)}${kc?.reason !== undefined && kc?.reason !== null ? ` (${fmt(kc.reason)})` : ""}` +
      ` · remote_check: ${fmt(rc?.state)}`,
  );
  if (payload.payload_resolution === null || payload.payload_resolution === undefined) {
    lines.push("payload refs: unresolved (--no-resolve-refs; press R to resolve)");
  } else if (Array.isArray(payload.payload_resolution)) {
    const res = payload.payload_resolution as Record<string, unknown>[];
    const byState = new Map<string, number>();
    for (const r of res) {
      const s = str(r.state) ?? "unknown";
      byState.set(s, (byState.get(s) ?? 0) + 1);
    }
    const summary = [...byState.entries()].map(([s, n]) => `${s}:${n}`).join(" ");
    lines.push(`payload refs: ${res.length} — ${summary} · missing: ${fmt(payload.missing_refs)}`);
  } else {
    lines.push("payload refs: resolved (unexpected shape)");
  }
  lines.push("");
  lines.push(
    "ops: x execute · d delegate · m merge-back · i resume-info · f focus source · R refresh+refs · s reconcile · r reload",
  );
  return lines;
}

/** Confirmation target lines for execute/delegate/merge-back. */
export function mutationTargetLines(record: HandoffRecord, extra: readonly string[]): string[] {
  const t = record.transfer;
  const exec = record.execution;
  const lines = [
    `handoff: ${record.id} (${record.status}/${record.strategy})`,
    `source: ${t.host} session ${t.herdr_session ?? "default"} pane ${t.pane_id}${t.provider_kind !== null ? ` provider ${t.provider_kind}` : ""}`,
    `agent_session: ${t.agent_session?.value ?? "none"} · seq: ${t.state_change_seq ?? "?"}`,
  ];
  if (exec?.target != null) {
    lines.push(`executed target pane: ${exec.target.pane_id}`);
  }
  if (exec?.remote !== undefined) {
    lines.push(
      `remote machine: ${exec.remote.label} (${exec.remote.machine_id}) → ${exec.remote.target} session ${exec.remote.session}`,
    );
  }
  if (exec?.worktree !== undefined) {
    lines.push(`worktree: ${exec.worktree.path}`);
  }
  lines.push(...extra);
  return lines;
}

/** `remote-probe` list-mode payload → machine select items. */
export function machineSelectItems(payload: Record<string, unknown>): SelectItem<string>[] {
  return asArray(payload.machines).map((m) => {
    const id = str(m.id) ?? "?";
    const label = str(m.label) ?? id;
    const target = str(m.target);
    const session = str(m.session);
    return {
      value: id,
      label: `${label} (${id})${m.enabled === false ? " [disabled]" : ""}`,
      detail: [
        `target: ${target ?? "unknown"} · session: ${session ?? "default"}`,
        `enabled: ${fmt(m.enabled)}`,
      ].join("\n"),
      ...(m.enabled === false ? { disabled: true, disabledReason: "machine disabled" } : {}),
    };
  });
}

/** `resume-info` payload → display lines. */
export function formatResumeInfoLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const providers = asArray(payload.providers);
  if (providers.length === 0) {
    lines.push("(no provider resume info)");
    return lines;
  }
  for (const p of providers) {
    const kind = str(p.kind) ?? "?";
    const status = str(p.native_resume) ?? "unknown";
    const src = str(p.session_id_source);
    const tpl = Array.isArray(p.resume_args_template)
      ? (p.resume_args_template as unknown[]).join(" ")
      : null;
    lines.push(
      `${kind}: native_resume=${status}${src !== null ? ` · session id from ${src}` : ""}${tpl !== null ? ` · args: ${tpl}` : ""}`,
    );
    if (typeof p.notes === "string" && p.notes !== "") lines.push(`  ${p.notes}`);
  }
  if (Array.isArray(payload.notes)) {
    for (const n of payload.notes) {
      if (typeof n === "string") lines.push(`note: ${n}`);
    }
  }
  return lines;
}

/** Dry-run payload → plan/decision lines shown before confirm. */
export function formatDryRunLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const plan = asRecord(payload.plan);
  if (plan !== null) {
    lines.push(`plan kind: ${fmt(plan.kind)}`);
    const pane = asRecord(plan.pane);
    if (pane !== null) {
      lines.push(
        `target pane: ${fmt(pane.pane_id)} ws ${fmt(pane.workspace_id)} tab ${fmt(pane.tab_id)} cwd ${fmt(pane.cwd)}`,
      );
    }
    if (plan.workspace_id !== undefined) lines.push(`target workspace: ${fmt(plan.workspace_id)}`);
  }
  const decision = asRecord(payload.decision);
  if (decision !== null) {
    lines.push(
      `strategy: ${fmt(decision.used)} — ${fmt(decision.reason)}${decision.provider_kind !== undefined ? ` (provider ${fmt(decision.provider_kind)})` : ""}`,
    );
    if (Array.isArray(decision.resume_args) && decision.resume_args.length > 0) {
      lines.push(`resume args: ${(decision.resume_args as unknown[]).join(" ")}`);
    }
  }
  const promptText = str(payload.prompt_text);
  if (promptText !== null) {
    const bounded = promptText.length > 600 ? `${promptText.slice(0, 597)}…` : promptText;
    lines.push("prompt preview:", ...bounded.split("\n").map((l) => `  ${l}`));
  }
  if (payload.dry_run === true) lines.push("(dry-run: nothing was mutated)");
  return lines;
}

/** Status filter options for the list view. */
export const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "all statuses" },
  ...HANDOFF_STATUSES.map((s) => ({ value: s as string, label: s as string })),
];
