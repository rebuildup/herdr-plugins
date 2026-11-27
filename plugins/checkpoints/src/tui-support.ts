/**
 * Shared helpers for the rebuildup.checkpoints interactive TUI surface
 * (`herdr-plugins.tui/v1`, ADR-0031/0032/0033).
 *
 * Everything here is deliberately thin:
 *
 * - the TUI consumes the plugin's OWN public CLI (`src/cli.ts`) as a
 *   subprocess for every read and mutation — the same contract
 *   CLI/MCP/GUI consumers use, so CLI/MCP/GUI behavior cannot drift;
 * - pane opening goes through the documented socket API
 *   (`plugin.pane.open`), never private channels;
 * - target identity is pinned at launch (tui-v1 §3): the `open` action
 *   captures the origin context once and forwards it as explicit
 *   `HERDR_TUI_*` env pins on `plugin.pane.open`. `HERDR_PANE_ID` is the
 *   UI pane's own surface identity and is NEVER used as a target —
 *   mutation commands always pass the pinned pane id (or `--repo`)
 *   explicitly so the TUI pane can never capture/restore itself by
 *   accident;
 * - read-only commands always pass `--no-drain` so opening a view never
 *   runs the lazy pending-capture drain (safety contract item 1 /
 *   ADR-0033 §3.1). The drain runs only on explicit user action or on
 *   mutation commands, exactly like the CLI.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { HerdrRpcError, request, resolveTarget } from "../../../packages/herdr-client/src/index";
import type { SelectItem } from "../../../packages/tui/src/index";
import { type CheckpointEntry, loadState, PLUGIN_ID, sessionKeyFor } from "./state";

export type { CheckpointEntry };
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
  /** Origin focused pane at launch — the default `create` target. */
  originPaneId: string | null;
  /** Origin cwd — a repo-path hint for `create --repo`, never auto-applied. */
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
 * `tab` per the tui-v1 placement policy: the checkpoint browser is a
 * workspace-scale, multi-instance-safe surface and pane-backed so
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
 * Open the checkpoints TUI pane through the documented socket API.
 * `plugin.pane.open` is a herdr-state mutation: target resolution runs
 * with `mutation: true` so an implicit default-session fallback fails
 * closed (`target_required`) instead of opening on the wrong session.
 */
export async function openCheckpointsPane(
  params: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const socketPath = resolveTarget({ mutation: true }).socketPath;
  return request(socketPath, "plugin.pane.open", params, {
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

// --- CLI subprocess bridge ----------------------------------------------------

/** This plugin's root (`plugins/checkpoints`); HERDR_PLUGIN_ROOT wins. */
export function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot !== undefined && envRoot !== "") return envRoot;
  // src/tui-support.ts → plugins/checkpoints
  return path.resolve(import.meta.dir, "..");
}

/** Structured failure from the checkpoints CLI subprocess. */
export class CheckpointsCliError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CheckpointsCliError";
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
  let message = `checkpoints cli exited ${exitCode} with no JSON output`;
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
  throw new CheckpointsCliError(message, kind, extra, exitCode);
}

/**
 * Run `bun <plugin>/src/cli.ts <args>` and return the parsed JSON
 * payload. The child inherits the full environment — including
 * HERDR_SOCKET_PATH/HERDR_SESSION/HERDR_PLUGIN_* — so it resolves the
 * SAME herdr session and plugin state dirs the TUI was launched in
 * (tui-v1 §3 identity pinning). No shell, argv only.
 *
 * NOTE: the child also inherits `HERDR_PANE_ID` (the UI pane's own
 * id). That is surface identity, never a target: every view passes the
 * pinned pane id or `--repo` explicitly on commands that resolve a
 * repo from a pane, so ambient pane resolution can never fire.
 */
export function runCheckpointsCli(
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
      finish(() => reject(new CheckpointsCliError("cancelled", "cancelled", undefined, 130)));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new CheckpointsCliError(`cli timed out after ${timeoutMs}ms`, "cli_timeout")),
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
      finish(() => reject(new CheckpointsCliError(String(err), "cli_spawn_error")));
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

// --- read-only flag ------------------------------------------------------------

/**
 * Every read the TUI performs goes through the CLI with `--no-drain`
 * appended: the lazy pending-capture drain mutates state (it captures
 * work-unit checkpoints), so it must never run implicitly on open
 * (tui-v1 §5.1, ADR-0033 §3.1). Mutations deliberately omit the flag —
 * they are explicit user actions and keep normal CLI drain semantics.
 */
export function readArgs(command: readonly string[]): string[] {
  return [...command, "--no-drain"];
}

/**
 * Count capture-pending marks recorded for THIS herdr session, read
 * straight from plugin state (read-only — never drains). Returns null
 * when the state file cannot be read, so the UI can render "unknown"
 * honestly instead of a fabricated 0.
 */
export async function pendingAutoCaptureCount(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  try {
    const state = await loadState();
    const sessionKey = sessionKeyFor({
      session: env.HERDR_SESSION,
      socketPath: env.HERDR_SOCKET_PATH,
    });
    const entries = state.auto?.[sessionKey];
    if (entries === undefined) return 0;
    return Object.values(entries).filter((e) => e.pending !== undefined).length;
  } catch {
    return null;
  }
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
 * (e.g. "create", "restore", "gc").
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

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** Checkpoint `kind` with the contract's pre-#74 default applied. */
export function checkpointKind(entry: CheckpointEntry): string {
  return entry.kind ?? "manual";
}

/** Short id label: first 8 chars of the checkpoint id. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function repoBasename(repoRoot: string): string {
  const normalized = repoRoot.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] ?? repoRoot;
}

/** Select-list row for one checkpoint entry. */
export function checkpointSelectItem(entry: CheckpointEntry): SelectItem<CheckpointEntry> {
  const kind = checkpointKind(entry);
  const labelParts = [shortId(entry.id), `[${kind}]`];
  if (entry.label !== undefined && entry.label !== "") labelParts.push(entry.label);
  if (entry.group_id !== undefined) labelParts.push(`group:${shortId(entry.group_id)}`);
  const badges = labelParts.join(" ");
  const detailLines = [
    `id: ${entry.id}`,
    `repo: ${entry.repo_root} (${repoBasename(entry.repo_root)})`,
    `ref: ${entry.ref}`,
    `commit: ${entry.commit} · head: ${entry.head_sha}`,
    `branch: ${entry.branch ?? "detached"} · created: ${entry.created_at}`,
    `kind: ${kind}${entry.group_id !== undefined ? ` · group: ${entry.group_id}` : ""}`,
  ];
  if (entry.files_summary !== undefined && entry.files_summary !== "") {
    detailLines.push(
      `files: ${entry.files_summary_truncated === true ? "(truncated) " : ""}${entry.files_summary}`,
    );
  }
  if (entry.submodules !== undefined && entry.submodules.length > 0) {
    detailLines.push(`submodules: ${entry.submodules.length} gitlink(s) recorded`);
  }
  return {
    value: entry,
    label: `${badges} — ${entry.created_at}`,
    detail: detailLines.join("\n"),
  };
}

/** Header lines describing one checkpoint (detail view top section). */
export function checkpointHeaderLines(entry: CheckpointEntry): string[] {
  const lines = [
    `id: ${entry.id}`,
    `kind: ${checkpointKind(entry)}${entry.group_id !== undefined ? ` · group: ${entry.group_id}` : ""}`,
    `repo: ${entry.repo_root}`,
    `ref: ${entry.ref}`,
    `commit: ${entry.commit}`,
    `head: ${entry.head_sha} · branch: ${entry.branch ?? "detached"}`,
    `created: ${entry.created_at}`,
  ];
  if (entry.label !== undefined && entry.label !== "") lines.push(`label: ${entry.label}`);
  if (entry.files_summary !== undefined && entry.files_summary !== "") {
    lines.push(
      `files: ${entry.files_summary_truncated === true ? "(truncated) " : ""}${entry.files_summary}`,
    );
  }
  if (entry.submodules !== undefined && entry.submodules.length > 0) {
    lines.push(`submodules: ${entry.submodules.join(", ")} (worktree contents not captured)`);
  }
  return lines;
}

/** Type guard for a `checkpoints` array element in a `list` payload. */
export function asCheckpoint(value: unknown): CheckpointEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const e = value as Record<string, unknown>;
  if (
    typeof e.id !== "string" ||
    typeof e.repo_root !== "string" ||
    typeof e.ref !== "string" ||
    typeof e.commit !== "string" ||
    typeof e.created_at !== "string"
  ) {
    return null;
  }
  return value as CheckpointEntry;
}

/** Extract the checkpoint list from a `list` payload. */
export function asCheckpoints(payload: Record<string, unknown>): CheckpointEntry[] {
  return Array.isArray(payload.checkpoints)
    ? payload.checkpoints.map(asCheckpoint).filter((e): e is CheckpointEntry => e !== null)
    : [];
}

function describeDiffSide(side: unknown): string {
  const s = asRecord(side);
  if (s === null) return "?";
  if (s.kind === "head") return "HEAD";
  const id = typeof s.id === "string" ? s.id : "?";
  return `${shortId(id)} (${id})`;
}

/** Format a `show` payload for a read-only detail view. */
export function formatShowPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const entry = asCheckpoint(payload.checkpoint);
  if (entry !== null) {
    lines.push(...checkpointHeaderLines(entry));
  } else {
    lines.push("show — checkpoint payload missing");
  }
  const ref = asRecord(payload.ref);
  if (ref !== null) {
    lines.push(
      `ref ${fmt(ref.name)}: ${ref.exists === true ? `exists (${fmt(ref.oid)})` : "MISSING — state entry is stale"}`,
    );
  }
  const summary = asRecord(payload.summary);
  if (summary !== null) {
    const output = typeof summary.output === "string" ? summary.output : "";
    lines.push("--- git show ---");
    if (output === "") {
      lines.push("(empty summary)");
    } else {
      lines.push(...output.split("\n"));
    }
    if (summary.truncated === true) lines.push("(summary truncated by --max-bytes)");
  } else if (typeof payload.summary_error === "string" && payload.summary_error !== "") {
    lines.push(`summary unavailable: ${payload.summary_error}`);
  }
  return lines;
}

/** Format a `diff` payload (patch text) for a scrollable viewer. */
export function formatDiffPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`diff ${describeDiffSide(payload.a)} → ${describeDiffSide(payload.b)}`);
  lines.push(`repo: ${fmt(payload.repo_root)}`);
  if (payload.truncated === true) {
    lines.push(
      `(patch truncated at ${fmt(payload.bytes)} bytes — raise --max-bytes via CLI for more)`,
    );
  } else {
    lines.push(`bytes: ${fmt(payload.bytes)}`);
  }
  const patch = typeof payload.patch === "string" ? payload.patch : "";
  lines.push("--- patch ---");
  if (patch === "") {
    lines.push("(empty diff)");
  } else {
    lines.push(...patch.split("\n"));
  }
  return lines;
}

/** Format a `plan` payload (restore preview — advisory, no mutation). */
export function formatPlanPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const entry = asCheckpoint(payload.checkpoint);
  if (entry !== null) {
    lines.push(`restore plan — ${entry.id} (${checkpointKind(entry)})`);
    lines.push(`repo: ${fmt(payload.repo_root)} · commit: ${fmt(payload.commit)}`);
  } else {
    lines.push("restore plan");
    lines.push(`repo: ${fmt(payload.repo_root)} · commit: ${fmt(payload.commit)}`);
  }
  const ref = asRecord(payload.ref);
  if (ref !== null) {
    lines.push(
      `ref ${fmt(ref.name)}: ${ref.exists === true ? `exists (${fmt(ref.oid)})` : "MISSING — planning against recorded commit"}`,
    );
  }
  const plan = asRecord(payload.plan);
  if (plan !== null) {
    lines.push(`files to change: ${fmt(plan.files_to_change)}`);
    lines.push(`untracked files to delete: ${fmt(plan.untracked_to_delete)}`);
    if (plan.already_matches === true) lines.push("worktree already matches the checkpoint");
  }
  for (const w of Array.isArray(payload.warnings) ? payload.warnings : []) {
    lines.push(`warning: ${fmt(w)}`);
  }
  lines.push("(plan is advisory — nothing was mutated)");
  return lines;
}

interface GcRepoReport {
  repo_root?: unknown;
  evaluated?: unknown;
  would_delete?: unknown;
  deleted?: unknown;
  protected?: unknown;
  kept?: unknown;
  orphans?: unknown;
  scanned?: unknown;
  errors?: unknown;
}

/** Format a `gc`/`prune` payload (dry-run or applied). */
export function formatGcPayload(
  payload: Record<string, unknown>,
  command: "gc" | "prune",
): string[] {
  const lines: string[] = [];
  const dryRun = payload.dry_run === true;
  lines.push(`${command}${dryRun ? " dry-run" : ""} — ok: ${fmt(payload.ok)}`);
  const policy = asRecord(payload.policy);
  if (policy !== null) {
    lines.push(
      `policy: max_count=${fmt(policy.max_count)} · max_age_days=${fmt(policy.max_age_days)} · pre_restore_protect_days=${fmt(policy.pre_restore_protect_days)}`,
    );
  }
  const repos = Array.isArray(payload.repos) ? (payload.repos as GcRepoReport[]) : [];
  for (const repo of repos) {
    lines.push(`repo ${fmt(repo.repo_root)}`);
    if (command === "gc") {
      lines.push(`  evaluated: ${fmt(repo.evaluated)} · kept: ${fmt(repo.kept)}`);
      const evict = dryRun ? repo.would_delete : repo.deleted;
      const ids = Array.isArray(evict) ? evict.map(String) : [];
      lines.push(`  ${dryRun ? "would delete" : "deleted"}: ${ids.length}`);
      for (const id of ids.slice(0, 20)) lines.push(`    - ${id}`);
      if (ids.length > 20) lines.push(`    … and ${ids.length - 20} more`);
      const protectedIds = Array.isArray(repo.protected) ? repo.protected.map(String) : [];
      if (protectedIds.length > 0) {
        lines.push(`  protected (recent pre_restore): ${protectedIds.join(", ")}`);
      }
    } else {
      lines.push(`  scanned: ${fmt(repo.scanned)} · orphans: ${fmt(repo.orphans)}`);
      const orphans = Array.isArray(repo.orphans) ? repo.orphans.map(String) : [];
      for (const ref of orphans.slice(0, 20)) {
        lines.push(`    orphan: ${ref}`);
      }
      if (orphans.length > 20) lines.push(`    … and ${orphans.length - 20} more`);
      const deleted = Array.isArray(repo.deleted) ? repo.deleted.map(String) : [];
      if (!dryRun && deleted.length > 0) {
        lines.push(`  deleted: ${deleted.length}`);
      }
    }
    const errors = Array.isArray(repo.errors) ? repo.errors : [];
    for (const e of errors.slice(0, 10)) {
      lines.push(
        `  error: ${fmt(asRecord(e)?.id ?? asRecord(e)?.ref)} — ${fmt(asRecord(e)?.message)}`,
      );
    }
  }
  for (const u of asArray(payload.unreachable)) {
    lines.push(`unreachable: ${fmt(u.repo_root)} (${fmt(u.kind)} — ${fmt(u.message)})`);
  }
  const totals = asRecord(payload.totals);
  if (totals !== null) {
    const parts = Object.entries(totals).map(
      ([k, v]) => `${k}=${Array.isArray(v) ? v.length : fmt(v)}`,
    );
    lines.push(`totals: ${parts.join(" · ")}`);
  }
  if (dryRun && command === "gc") {
    lines.push("(dry-run — press a to apply, r to re-run)");
  } else if (dryRun) {
    lines.push("(dry-run — press a to apply, r to re-run)");
  }
  return lines;
}

/** Format the `auto_captures` drain report merged into a payload. */
export function formatAutoCaptures(payload: Record<string, unknown>): string[] | null {
  const report = asRecord(payload.auto_captures);
  if (report === null) return null;
  const lines: string[] = [];
  const captured = Array.isArray(report.captured) ? report.captured.map(String) : [];
  const skipped = Array.isArray(report.skipped) ? report.skipped : [];
  lines.push(`auto-captures: ${captured.length} captured, ${skipped.length} skipped`);
  for (const id of captured.slice(0, 20)) lines.push(`  captured: ${id}`);
  for (const s of skipped.slice(0, 20)) {
    const rec = asRecord(s);
    lines.push(`  skipped ${fmt(rec?.pane_id)} — ${fmt(rec?.reason)}`);
  }
  if (report.session_unreachable === true) {
    lines.push("herdr session unreachable — pending marks left for a later invocation");
  }
  return lines;
}

/** Format a `save`/`restore`/`restore-group` result payload. */
export function formatMutationPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const command = fmt(payload.command);
  lines.push(`${command} — ok: ${fmt(payload.ok)}`);
  if (typeof payload.group === "string") lines.push(`group: ${payload.group}`);
  if (payload.pre_restore !== null && payload.pre_restore !== undefined) {
    const pre = asRecord(payload.pre_restore);
    if (pre !== null) lines.push(`pre-restore checkpoint: ${fmt(pre.id)} (${fmt(pre.ref)})`);
  }
  if (typeof payload.restored_commit === "string") {
    lines.push(`restored commit: ${payload.restored_commit}`);
  }
  if (typeof payload.isolation === "string") {
    lines.push(`isolation: ${payload.isolation}`);
    const sharing = Array.isArray(payload.sharing_panes) ? payload.sharing_panes.map(String) : [];
    if (sharing.length > 0) lines.push(`sharing panes: ${sharing.join(", ")}`);
  }
  if (typeof payload.clean_passes === "number") {
    lines.push(`clean passes: ${payload.clean_passes}`);
  }
  const results = Array.isArray(payload.results) ? payload.results : null;
  if (results !== null) {
    lines.push(`repos: ${fmt(payload.succeeded)}/${fmt(payload.total)} succeeded`);
    for (const r of results.slice(0, 30)) {
      const rec = asRecord(r);
      if (rec === null) continue;
      const status = rec.ok === true ? "ok" : `FAILED (${fmt(asRecord(rec.error)?.kind)})`;
      lines.push(`  ${fmt(rec.repo_root)} — ${status}`);
      if (rec.ok !== true) {
        lines.push(`    ${fmt(asRecord(rec.error)?.message)}`);
      }
    }
  }
  for (const w of Array.isArray(payload.warnings) ? payload.warnings : []) {
    lines.push(`warning: ${fmt(w)}`);
  }
  const skipped = asArray(payload.skipped_panes);
  for (const s of skipped) {
    lines.push(`skipped pane ${fmt(s.pane_id)} — ${fmt(s.reason)}`);
  }
  const autoLines = formatAutoCaptures(payload);
  if (autoLines !== null) lines.push(...autoLines);
  return lines;
}

/** Error text for status lines: kind + message, never a stack. */
export function errorLine(err: unknown): string {
  if (err instanceof CheckpointsCliError) {
    return `${err.kind}: ${err.message}`;
  }
  if (err instanceof HerdrRpcError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
