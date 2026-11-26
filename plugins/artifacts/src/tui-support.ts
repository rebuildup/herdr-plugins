/**
 * Shared helpers for the rebuildup.artifacts interactive TUI surface
 * (`herdr-plugins.tui/v1`, ADR-0031/0032/0033, issue #247).
 *
 * Same architecture as the projects pilot (#240):
 *
 * - the TUI consumes the plugin's OWN public CLI (`src/cli.ts`) as a
 *   subprocess for every read and mutation — the same contract
 *   CLI/MCP/GUI consumers use, so CLI/MCP/GUI behavior cannot drift;
 * - pane opening goes through the documented socket API
 *   (`plugin.pane.open`), never private channels;
 * - target identity is pinned at launch (tui-v1 §3): the `open` action
 *   captures the origin context once and forwards it as explicit
 *   `HERDR_TUI_*` env pins on `plugin.pane.open`. `HERDR_PANE_ID` is the
 *   UI pane's own surface identity and is NEVER used as a target.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { HerdrRpcError, request, resolveTarget } from "../../../packages/herdr-client/src/index";
import type { SelectItem } from "../../../packages/tui/src/index";
import { ARTIFACT_KINDS, type ArtifactKind, PLUGIN_ID } from "./model";

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
 * `tab` per the tui-v1 placement policy: the artifact registry is a
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
 * Open the artifacts TUI pane through the documented socket API.
 * `plugin.pane.open` is a herdr-state mutation: target resolution runs
 * with `mutation: true` so an implicit default-session fallback fails
 * closed (`target_required`) instead of opening on the wrong session.
 */
export async function openArtifactsPane(
  params: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const socketPath = resolveTarget({ mutation: true }).socketPath;
  return request(socketPath, "plugin.pane.open", params, {
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

// --- CLI subprocess bridge ----------------------------------------------------

/** This plugin's root (`plugins/artifacts`); HERDR_PLUGIN_ROOT wins. */
export function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot !== undefined && envRoot !== "") return envRoot;
  // src/tui-support.ts → plugins/artifacts
  return path.resolve(import.meta.dir, "..");
}

/** Structured failure from the artifacts CLI subprocess. */
export class ArtifactsCliError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "ArtifactsCliError";
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
  // the whole stream first, then fall back to per-line candidates for
  // compact single-line emitters.
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
  let message = `artifacts cli exited ${exitCode} with no JSON output`;
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
  throw new ArtifactsCliError(message, kind, extra, exitCode);
}

/**
 * Run `bun <plugin>/src/cli.ts <args>` and return the parsed JSON
 * payload. The child inherits the full environment — including
 * HERDR_SOCKET_PATH/HERDR_SESSION/HERDR_PLUGIN_* — so it resolves the
 * SAME herdr session and plugin state dirs the TUI was launched in
 * (tui-v1 §3 identity pinning). No shell, argv only.
 */
export function runArtifactsCli(
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
      finish(() => reject(new ArtifactsCliError("cancelled", "cancelled", undefined, 130)));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new ArtifactsCliError(`cli timed out after ${timeoutMs}ms`, "cli_timeout")),
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
      finish(() => reject(new ArtifactsCliError(String(err), "cli_spawn_error")));
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
 * (e.g. "register", "delete", "deliver", "gc").
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

// --- payload → view formatting (pure, unit-tested) ----------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
}

/** String lists (orphans/corrupt id arrays) — tolerant, never fabricated. */
function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * Tolerant view model for one artifact record (contract
 * `herdr-plugins.artifacts/v1` record + `missing_ref`/`owner_stale`
 * annotations). The plugin never reads payload bytes — this view model
 * is metadata only, matching the CLI surface.
 */
export interface ArtifactView {
  artifact_id: string;
  kind: ArtifactKind | string;
  title: string | null;
  host: string;
  session: string;
  owner_pane_id: string | null;
  owner_agent_session: string | null;
  created_by: string;
  storage_mode: string;
  resolved_path: string;
  size: number;
  mime: string;
  sha256: string;
  oversize: boolean;
  missing_ref: boolean;
  owner_stale: boolean;
  created_at: string;
  refs: string[];
  warnings: string[];
}

/** Parse one artifact payload entry; null when malformed (never fabricated). */
export function asArtifact(value: unknown): ArtifactView | null {
  const v = asRecord(value);
  if (v === null) return null;
  const artifactId = v.artifact_id;
  if (typeof artifactId !== "string" || artifactId === "") return null;
  const storage = asRecord(v.storage);
  const owner = asRecord(v.owner);
  if (storage === null || owner === null) return null;
  const kind = typeof v.kind === "string" ? v.kind : "other";
  return {
    artifact_id: artifactId,
    kind: (ARTIFACT_KINDS as readonly string[]).includes(kind) ? (kind as ArtifactKind) : kind,
    title: typeof v.title === "string" ? v.title : null,
    host: fmt(v.host),
    session: fmt(v.session),
    owner_pane_id: typeof owner.pane_id === "string" ? owner.pane_id : null,
    owner_agent_session: typeof owner.agent_session === "string" ? owner.agent_session : null,
    created_by: fmt(owner.created_by),
    storage_mode: fmt(storage.mode),
    resolved_path: fmt(storage.resolved_path),
    size: typeof v.size === "number" ? v.size : 0,
    mime: fmt(v.mime),
    sha256: fmt(v.sha256),
    oversize: v.oversize === true,
    missing_ref: v.missing_ref === true,
    owner_stale: v.owner_stale === true,
    created_at: fmt(v.created_at),
    refs: Array.isArray(v.refs) ? v.refs.filter((r): r is string => typeof r === "string") : [],
    warnings: Array.isArray(v.warnings)
      ? v.warnings.filter((w): w is string => typeof w === "string")
      : [],
  };
}

export function asArtifacts(value: unknown): ArtifactView[] {
  return Array.isArray(value)
    ? value.map(asArtifact).filter((a): a is ArtifactView => a !== null)
    : [];
}

function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Select-list row for one artifact. */
export function artifactSelectItem(artifact: ArtifactView): SelectItem<ArtifactView> {
  const flags = [
    artifact.missing_ref ? "missing" : null,
    artifact.owner_stale ? "owner-stale" : null,
    artifact.oversize ? "oversize" : null,
    artifact.refs.length > 0 ? `refs:${artifact.refs.length}` : null,
  ].filter((f): f is string => f !== null);
  const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  const title = artifact.title !== null ? ` — ${artifact.title}` : "";
  return {
    value: artifact,
    label: `${artifact.artifact_id} · ${artifact.kind}${title}${suffix}`,
    detail: [
      `kind: ${artifact.kind} · mime: ${artifact.mime} · size: ${humanBytes(artifact.size)}`,
      `path: ${artifact.resolved_path}`,
      `storage: ${artifact.storage_mode} · created: ${artifact.created_at}`,
      `owner: pane ${artifact.owner_pane_id ?? "?"} · by ${artifact.created_by}`,
      `sha256: ${artifact.sha256}`,
      ...(artifact.warnings.length > 0 ? [`warnings: ${artifact.warnings.join(", ")}`] : []),
    ].join("\n"),
  };
}

/** Header + preview guidance lines for the artifact detail view. */
export function artifactHeaderLines(artifact: ArtifactView): string[] {
  const lines = [
    `artifact ${artifact.artifact_id}${artifact.title !== null ? ` — ${artifact.title}` : ""}`,
    `kind: ${artifact.kind} · mime: ${artifact.mime} · size: ${humanBytes(artifact.size)}`,
    `created: ${artifact.created_at} · host: ${artifact.host} · session: ${artifact.session}`,
    `owner: pane ${artifact.owner_pane_id ?? "unknown"} · agent_session ${artifact.owner_agent_session ?? "unknown"} · created_by ${artifact.created_by}`,
    `storage: ${artifact.storage_mode} · sha256 ${artifact.sha256}`,
    `path: ${artifact.resolved_path}`,
  ];
  if (artifact.refs.length > 0) {
    lines.push(`refs (${artifact.refs.length}):`);
    for (const ref of artifact.refs) lines.push(`  ${ref}`);
  }
  if (artifact.warnings.length > 0) {
    lines.push(`warnings: ${artifact.warnings.join(", ")}`);
  }
  if (artifact.missing_ref) {
    lines.push("PAYLOAD MISSING — the resolved path does not exist or is unsafe");
  }
  if (artifact.owner_stale) {
    lines.push("owner-stale — the registering pane is not in the live session snapshot");
  }
  lines.push("");
  lines.push("preview: metadata only — the plugin never renders payload bytes (ADR-0024).");
  if (artifact.kind === "html") {
    lines.push("html renders in an isolated client context; open externally to view.");
  } else if (artifact.kind === "image" || artifact.kind === "pdf") {
    lines.push(`${artifact.kind} cannot be previewed in a terminal; open externally to view.`);
  } else {
    lines.push("open externally (o) for the file content in the OS handler.");
  }
  lines.push("");
  lines.push("d delete · l deliver · v verify · o open externally · R refresh");
  return lines;
}

/** Format a `verify` payload (whole index or single artifact). */
export function formatVerifyPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const summary = asRecord(payload.summary);
  if (summary !== null) {
    lines.push(
      `verify summary — total ${fmt(summary.total)} · ok ${fmt(summary.ok)} · corrupt ${fmt(summary.corrupt)} · missing ${fmt(summary.missing)}`,
    );
  }
  const results = asArray(payload.results);
  if (results.length === 0) {
    lines.push("(no verification results)");
  }
  for (const r of results) {
    const id = fmt(r.artifact_id);
    const status = fmt(r.status);
    const issues = Array.isArray(r.issues)
      ? r.issues.filter((i): i is string => typeof i === "string")
      : [];
    lines.push(`${id} — ${status}${issues.length > 0 ? ` (${issues.join(", ")})` : ""}`);
    const checks = asRecord(r.checks);
    if (checks !== null) {
      for (const [name, value] of Object.entries(checks)) {
        const check = asRecord(value);
        const ok = check?.ok;
        const detail = check?.detail;
        lines.push(
          `  ${name}: ${ok === true ? "ok" : ok === false ? "FAIL" : fmt(ok)}${typeof detail === "string" ? ` — ${detail}` : ""}`,
        );
      }
    }
  }
  const orphans = asStrings(payload.orphans);
  if (orphans.length > 0) {
    lines.push(`orphans (${orphans.length}): ${orphans.join(", ")}`);
  }
  const corrupt = asStrings(payload.corrupt);
  if (corrupt.length > 0) {
    lines.push(`corrupt index entries: ${corrupt.join(", ")}`);
  }
  return lines;
}

/** Format a `gc` payload (dry-run or applied). */
export function formatGcPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const policy = asRecord(payload.policy);
  const dryRun = payload.dry_run === true;
  lines.push(
    `gc ${dryRun ? "dry-run" : "applied"} — older_than ${fmt(policy?.older_than)} · evaluated ${fmt(payload.evaluated)} · expired ${fmt(payload.expired)}`,
  );
  const totals = asRecord(payload.totals);
  if (totals !== null) {
    lines.push(
      `totals: deleted ${fmt(totals.deleted)} · would_delete ${fmt(totals.would_delete)} · skipped_referenced ${fmt(totals.skipped_referenced)} · skipped_other ${fmt(totals.skipped_other)} · kept ${fmt(totals.kept)} · errors ${fmt(totals.errors)}`,
    );
  }
  const entries = asArray(payload.entries);
  if (entries.length === 0) {
    lines.push("(no entries)");
  }
  for (const e of entries) {
    const reason = typeof e.reason === "string" ? ` — ${e.reason}` : "";
    const error = typeof e.error === "string" ? ` — ${e.error}` : "";
    lines.push(`${fmt(e.artifact_id)}: ${fmt(e.action)}${reason}${error} (${fmt(e.storage_mode)})`);
  }
  return lines;
}

/** Format a `list`/`search` payload header (counts + honest gaps). */
export function formatIndexMeta(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const total = payload.total;
  const returned = Array.isArray(payload.artifacts) ? payload.artifacts.length : 0;
  if (typeof total === "number" && returned < total) {
    lines.push(`showing ${returned} of ${total} artifacts (CLI page limit)`);
  }
  const orphans = asStrings(payload.orphans);
  if (orphans.length > 0) {
    lines.push(`orphans: ${orphans.length} payload dir(s) without index records`);
  }
  const corrupt = asStrings(payload.corrupt);
  if (corrupt.length > 0) {
    lines.push(`corrupt index entries: ${corrupt.length}`);
  }
  return lines;
}

/** Format a `deliver` result for the status/detail line. */
export function formatDeliverResult(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`delivered ${fmt(payload.artifact_id)}`);
  const target = asRecord(payload.target);
  if (target !== null) {
    lines.push(`target: ${fmt(target.kind)} pane ${fmt(target.pane_id)}`);
  }
  if (typeof payload.method === "string") lines.push(`method: ${payload.method}`);
  if (typeof payload.message === "string") {
    lines.push("message sent:");
    for (const l of payload.message.split("\n")) lines.push(`  ${l}`);
  }
  return lines;
}

/** Error text for status lines: kind + message, never a stack. */
export function errorLine(err: unknown): string {
  if (err instanceof ArtifactsCliError) {
    return `${err.kind}: ${err.message}`;
  }
  if (err instanceof HerdrRpcError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
