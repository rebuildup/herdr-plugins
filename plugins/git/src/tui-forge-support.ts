/**
 * Shared helpers for the rebuildup.git forge TUI surface
 * (`herdr-plugins.tui/v1`, ADR-0031/0032/0033) — issue #239.
 *
 * Deliberately thin, same discipline as plugins/projects/src/tui-support.ts
 * (dedup candidate once #238's git TUI helpers land — the context-pinning
 * block below is intentionally identical in shape):
 *
 * - the TUI consumes the plugin's OWN public CLI (`src/cli.ts`) as a
 *   subprocess for every read and mutation — the same contract
 *   CLI/MCP/GUI consumers use, so CLI/MCP/GUI behavior cannot drift;
 * - pane opening goes through the documented socket API
 *   (`plugin.pane.open`), never private channels;
 * - target identity is pinned at launch (tui-v1 §3): the `open-forge`
 *   action captures the origin context once and forwards it as explicit
 *   `HERDR_TUI_*` env pins on `plugin.pane.open`. `HERDR_PANE_ID` is the
 *   UI pane's own surface identity and is NEVER used as a target — every
 *   CLI call passes the pinned ORIGIN pane id explicitly, because the
 *   forge repo resolves from that pane's cwd (the UI pane's cwd is the
 *   plugin root and would resolve the wrong repository).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { HerdrRpcError, request, resolveTarget } from "../../../packages/herdr-client/src/index";
import type { SelectItem } from "../../../packages/tui/src/index";

export const PLUGIN_ID = "rebuildup.git";

// --- pinned target identity -------------------------------------------------

/**
 * Origin context captured at launch. Fields are `null` when unknown —
 * the UI must render that honestly rather than guess "current" focus.
 */
export interface PinnedTarget {
  /** Workspace the UI was launched from (pane placement target). */
  workspaceId: string | null;
  tabId: string | null;
  /** Origin focused pane at launch — the forge repo resolves from ITS cwd. */
  originPaneId: string | null;
  /** Origin cwd — display hint only; the CLI re-resolves via the pane. */
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
 * explicit `HERDR_TUI_*` env pins (set by the `open-forge` action) →
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

// --- pane opening (open-forge action → plugin.pane.open) ----------------------

/**
 * Params for `plugin.pane.open` (ADR-0031 verified shape). Placement is
 * `tab` per the tui-v1 placement policy: the forge browser is a
 * workspace-scale surface, multi-instance safe, and pane-backed so
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
    entrypoint: "forge",
    placement: "tab",
    env,
  };
  if (target.workspaceId !== null) params.workspace_id = target.workspaceId;
  return params;
}

/**
 * Open the forge TUI pane through the documented socket API.
 * `plugin.pane.open` is a herdr-state mutation: target resolution runs
 * with `mutation: true` so an implicit default-session fallback fails
 * closed (`target_required`) instead of opening on the wrong session.
 */
export async function openForgePane(
  params: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const socketPath = resolveTarget({ mutation: true }).socketPath;
  return request(socketPath, "plugin.pane.open", params, {
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

// --- CLI subprocess bridge ----------------------------------------------------

/** This plugin's root (`plugins/git`); HERDR_PLUGIN_ROOT wins. */
export function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot !== undefined && envRoot !== "") return envRoot;
  // src/tui-forge-support.ts → plugins/git
  return path.resolve(import.meta.dir, "..");
}

/** Structured failure from the git CLI subprocess. */
export class GitCliError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "GitCliError";
  }
}

export interface CliRunOptions {
  /** Hard cap on the subprocess; default 60s (gh calls are slower). */
  timeoutMs?: number;
  /** AbortSignal (task cancel) — kills the child process. */
  signal?: AbortSignal;
}

function parseCliEnvelope(
  stdout: string,
  stderr: string,
  exitCode: number,
): Record<string, unknown> {
  // The CLI emits one pretty-printed JSON document on stdout; parse the
  // whole stream first, then fall back to per-line candidates.
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
  let message = `git cli exited ${exitCode} with no JSON output`;
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
  throw new GitCliError(message, kind, extra, exitCode);
}

/**
 * Run `bun <plugin>/src/cli.ts <args>` and return the parsed JSON
 * payload. The child inherits the full environment — including
 * HERDR_SOCKET_PATH/HERDR_SESSION/HERDR_PLUGIN_* — so it resolves the
 * SAME herdr session and plugin state dirs the TUI was launched in
 * (tui-v1 §3 identity pinning). No shell, argv only.
 *
 * Every forge call MUST pass the pinned pane id as an explicit
 * positional: `HERDR_PANE_ID` in the child env is the UI pane itself,
 * and the forge repo resolves from the target pane's cwd — falling back
 * to ambient identity would silently target the wrong repository.
 */
export function runGitCli(
  args: readonly string[],
  options: CliRunOptions = {},
): Promise<Record<string, unknown>> {
  const root = pluginRoot();
  const cliPath = path.join(root, "src", "cli.ts");
  const timeoutMs = options.timeoutMs ?? 60_000;
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
      finish(() => reject(new GitCliError("cancelled", "cancelled", undefined, 130)));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new GitCliError(`cli timed out after ${timeoutMs}ms`, "cli_timeout")));
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
      finish(() => reject(new GitCliError(String(err), "cli_spawn_error")));
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
 * ("pr", "issue" for the forge surface).
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

// --- forge target helpers -------------------------------------------------------

/** `owner/name` override grammar — same rule the CLI enforces. */
export const FORGE_REPO_PATTERN = /^[^\s/]+\/[^\s/]+$/;

/**
 * Mutable per-session forge target the views share: the pane id every
 * CLI call passes explicitly, plus an optional `--repo owner/name`
 * override. `paneId` starts as the pinned origin pane; the user may
 * repoint it in-UI (`p`) — never to `HERDR_PANE_ID` (surface identity).
 */
export interface ForgeTarget {
  paneId: string | null;
  repoOverride: string | null;
}

/** Append `--repo <override>` when set (already validated). */
export function repoFlagArgs(target: ForgeTarget): string[] {
  return target.repoOverride !== null ? ["--repo", target.repoOverride] : [];
}

/** Validate a user-entered repo override; returns error text or null. */
export function validateRepoOverride(input: string): string | null {
  const value = input.trim();
  if (value === "") return "empty repo override — cancelled";
  if (value.startsWith("-")) return "repo override must not start with '-'";
  if (!FORGE_REPO_PATTERN.test(value)) {
    return `invalid repo override (expected owner/name): ${JSON.stringify(value)}`;
  }
  return null;
}

// --- payload accessors + formatting (pure, unit-tested) -------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
}

export function fmt(value: unknown): string {
  if (value === null || value === undefined || value === "") return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** `head.sha` echoed by every PR read surface that fetches refs. */
export function headShaOf(payload: Record<string, unknown>): string | null {
  const head = asRecord(payload.head);
  return head !== null ? str(head.sha) : null;
}

function shortSha(sha: string | null): string {
  return sha === null ? "unknown" : sha.slice(0, 12);
}

function authorOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const rec = asRecord(raw);
  return fmt(rec?.login ?? rec?.name);
}

/** Select-list row for one PR from `pr list`. */
export function prSelectItem(pr: Record<string, unknown>): SelectItem<Record<string, unknown>> {
  const number = fmt(pr.number);
  const title = fmt(pr.title);
  const state = fmt(pr.state).toLowerCase();
  const draft = pr.isDraft === true ? " [draft]" : "";
  const labels = [state !== "unknown" ? state : null, draft !== "" ? "draft" : null]
    .filter((l): l is string => l !== null)
    .join(",");
  const suffix = labels !== "" ? ` (${labels})` : "";
  return {
    value: pr,
    label: `#${number} ${title}${suffix}`,
    detail: [
      `number: ${number}`,
      `title: ${title}`,
      `state: ${state}${pr.isDraft === true ? " (draft)" : ""}`,
      `author: ${authorOf(pr.author)}`,
      `head: ${fmt(pr.headRefName)} → base: ${fmt(pr.baseRefName)}`,
      `updated: ${fmt(pr.updatedAt)}`,
      `url: ${fmt(pr.url)}`,
    ].join("\n"),
  };
}

/** Select-list row for one issue from `issue list`. */
export function issueSelectItem(
  issue: Record<string, unknown>,
): SelectItem<Record<string, unknown>> {
  const number = fmt(issue.number);
  const title = fmt(issue.title);
  const state = fmt(issue.state).toLowerCase();
  const labelsRaw = Array.isArray(issue.labels) ? issue.labels : [];
  const labels = labelsRaw
    .map((l) => (typeof l === "string" ? l : fmt(asRecord(l)?.name)))
    .filter((l) => l !== "unknown" && l !== "")
    .slice(0, 4);
  const labelSuffix = labels.length > 0 ? ` [${labels.join(", ")}]` : "";
  return {
    value: issue,
    label: `#${number} ${title} (${state})${labelSuffix}`,
    detail: [
      `number: ${number}`,
      `title: ${title}`,
      `state: ${state}${(issue.state_reason ?? issue.stateReason) ? ` (${fmt(issue.state_reason ?? issue.stateReason)})` : ""}`,
      `author: ${authorOf(issue.author)}`,
      `labels: ${labels.length > 0 ? labels.join(", ") : "none"}`,
      `assignees: ${Array.isArray(issue.assignees) ? issue.assignees.map(authorOf).join(", ") || "none" : "unknown"}`,
      `updated: ${fmt(issue.updatedAt)}`,
      `url: ${fmt(issue.url)}`,
    ].join("\n"),
  };
}

/** Header + body lines for the PR detail view (`pr view` payload). */
export function formatPrView(pr: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`#${fmt(pr.number)} ${fmt(pr.title)}`);
  lines.push(
    [
      `state: ${fmt(pr.state).toLowerCase()}${pr.isDraft === true ? " (draft)" : ""}`,
      `author: ${authorOf(pr.author)}`,
      `head: ${fmt(pr.headRefName)} → base: ${fmt(pr.baseRefName)}`,
      `mergeable: ${fmt(pr.mergeable).toLowerCase()}`,
      `mergeState: ${fmt(pr.mergeStateStatus)}`,
      `reviewDecision: ${fmt(pr.reviewDecision)}`,
      `diff: +${fmt(pr.additions)}/-${fmt(pr.deletions)} in ${fmt(pr.changedFiles)} files`,
      `created: ${fmt(pr.createdAt)} · updated: ${fmt(pr.updatedAt)}`,
      `url: ${fmt(pr.url)}`,
    ].join("\n"),
  );
  if (Array.isArray(pr.statusCheckRollup)) {
    const checks = asArray(pr.statusCheckRollup);
    const failing = checks.filter((c) => {
      const bucket = fmt(c.bucket ?? c.conclusion ?? c.state).toLowerCase();
      return ["fail", "failure", "error", "cancel"].some((k) => bucket.includes(k));
    });
    lines.push(
      `checks: ${checks.length} reported${failing.length > 0 ? `, ${failing.length} failing` : ""}${pr.checks_truncated === true ? " (truncated)" : ""}`,
    );
  }
  const body = typeof pr.body === "string" ? pr.body : "";
  if (body !== "") {
    lines.push("--- body ---");
    lines.push(...body.split("\n"));
    if (pr.body_truncated === true) lines.push("… (body truncated by contract)");
  } else {
    lines.push("(no body)");
  }
  return lines;
}

/** Format `pr reviews` payload (reviews + review requests). */
export function formatPrReviewsPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`pr #${fmt(payload.number)} — reviews`);
  const head = asRecord(payload.head);
  if (head) lines.push(`head: ${fmt(head.ref)} @ ${shortSha(str(head.sha))}`);
  const rr = asRecord(payload.review_requests);
  if (rr) {
    const users = Array.isArray(rr.users) ? rr.users.map(fmt).join(", ") : "";
    const teams = Array.isArray(rr.teams) ? rr.teams.map(fmt).join(", ") : "";
    const parts = [
      users !== "" ? `users: ${users}` : null,
      teams !== "" ? `teams: ${teams}` : null,
    ].filter((p): p is string => p !== null);
    lines.push(`review requests: ${parts.length > 0 ? parts.join(" · ") : "none"}`);
  }
  const reviews = asArray(payload.reviews);
  if (reviews.length === 0) {
    lines.push("(no submitted reviews)");
  }
  for (const r of reviews) {
    lines.push(
      `${fmt(r.author)} — ${fmt(r.state).toLowerCase()} @ ${fmt(r.submitted_at ?? r.submittedAt)}`,
    );
    const body = typeof r.body === "string" ? r.body : "";
    if (body !== "") {
      for (const l of body.split("\n")) lines.push(`  ${l}`);
      if (r.body_truncated === true) lines.push("  … (truncated)");
    }
  }
  if (payload.reviews_truncated === true)
    lines.push("… (reviews truncated — see CLI for full list)");
  return lines;
}

/** Format `pr comments` payload (conversation + line comments). */
export function formatPrCommentsPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`pr #${fmt(payload.number)} — comments`);
  const head = asRecord(payload.head);
  if (head) lines.push(`head: ${fmt(head.ref)} @ ${shortSha(str(head.sha))}`);

  const issueComments = asArray(payload.issue_comments);
  lines.push("", "conversation:");
  if (issueComments.length === 0) lines.push("  (none)");
  for (const c of issueComments) {
    lines.push(`  #${fmt(c.id)} ${fmt(c.author)} @ ${fmt(c.created_at)}`);
    const body = typeof c.body === "string" ? c.body : "";
    for (const l of body.split("\n")) lines.push(`    ${l}`);
    if (c.body_truncated === true) lines.push("    … (truncated)");
  }
  if (payload.issue_comments_truncated === true) {
    lines.push("  … (truncated — see CLI for full list)");
  }

  const lineComments = asArray(payload.line_comments);
  lines.push("", "line comments:");
  if (lineComments.length === 0) lines.push("  (none)");
  for (const c of lineComments) {
    const reply = c.in_reply_to_id ? ` (reply to #${fmt(c.in_reply_to_id)})` : "";
    lines.push(
      `  #${fmt(c.id)} ${fmt(c.author)} ${fmt(c.path)}:${fmt(c.line)}${fmt(c.side) !== "unknown" ? ` ${fmt(c.side)}` : ""}${reply} @ ${fmt(c.created_at)}`,
    );
    const body = typeof c.body === "string" ? c.body : "";
    for (const l of body.split("\n")) lines.push(`    ${l}`);
    if (c.body_truncated === true) lines.push("    … (truncated)");
  }
  if (payload.line_comments_truncated === true) {
    lines.push("  … (truncated — see CLI for full list)");
  }
  return lines;
}

/** Format `pr checks` payload. */
export function formatPrChecksPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`pr #${fmt(payload.number)} — checks`);
  const head = asRecord(payload.head);
  if (head) lines.push(`head: ${fmt(head.ref)} @ ${shortSha(str(head.sha))}`);
  const checks = asArray(payload.checks);
  if (checks.length === 0) {
    lines.push("(no checks reported)");
    return lines;
  }
  for (const c of checks) {
    const state = [fmt(c.bucket), fmt(c.state), fmt(c.conclusion)]
      .filter((s) => s !== "unknown" && s !== "")
      .join("/");
    lines.push(`${fmt(c.name)} — ${state !== "" ? state : "unknown"}`);
    const detail = [
      c.workflow ? `workflow ${fmt(c.workflow)}` : null,
      c.event ? `event ${fmt(c.event)}` : null,
    ].filter((d): d is string => d !== null);
    if (detail.length > 0) lines.push(`  ${detail.join(" · ")}`);
    if (typeof c.description === "string" && c.description !== "") {
      lines.push(`  ${c.description}`);
    }
    if (typeof c.link === "string" && c.link !== "") lines.push(`  ${c.link}`);
  }
  if (payload.checks_truncated === true) lines.push("… (checks truncated)");
  return lines;
}

/** Format `pr logs` mode=runs payload. */
export function formatPrRunsPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(
    `pr #${fmt(payload.number)} — workflow runs (head ${shortSha(str(asRecord(payload.head)?.sha ?? null))})`,
  );
  const runs = asArray(payload.runs);
  if (runs.length === 0) {
    lines.push("(no workflow runs for the PR head)");
    return lines;
  }
  for (const r of runs) {
    lines.push(
      `run #${fmt(r.id)} ${fmt(r.name)} — ${fmt(r.status)}/${fmt(r.conclusion)} @ ${fmt(r.created_at)}`,
    );
    if (typeof r.display_title === "string" && r.display_title !== "") {
      lines.push(`  ${r.display_title}`);
    }
    if (typeof r.url === "string" && r.url !== "") lines.push(`  ${r.url}`);
  }
  if (payload.runs_truncated === true) lines.push("… (runs truncated)");
  return lines;
}

/** Format `pr logs` mode=run payload (job list). */
export function formatPrRunJobsPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const run = asRecord(payload.run);
  lines.push(
    `run #${fmt(run?.id ?? payload.run_id)} ${fmt(run?.name)} — ${fmt(run?.status)}/${fmt(run?.conclusion)}`,
  );
  const jobs = asArray(payload.jobs);
  if (jobs.length === 0) {
    lines.push("(no jobs reported)");
    return lines;
  }
  for (const j of jobs) {
    lines.push(`job #${fmt(j.id)} ${fmt(j.name)} — ${fmt(j.status)}/${fmt(j.conclusion)}`);
  }
  if (payload.jobs_truncated === true) lines.push("… (jobs truncated)");
  return lines;
}

/** Format `pr logs` mode=job payload (bounded log tail). */
export function formatPrJobLogPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(
    `job #${fmt(payload.job_id)} log — ${fmt(payload.lines_returned)}/${fmt(payload.total_lines)} lines${payload.truncated === true ? " (truncated)" : ""}`,
  );
  const log = typeof payload.log === "string" ? payload.log : "";
  if (log === "") {
    lines.push("(empty log)");
    return lines;
  }
  lines.push("---");
  lines.push(...log.split("\n"));
  return lines;
}

/** Header + body lines for the issue detail view (`issue view` payload). */
export function formatIssueView(issue: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`#${fmt(issue.number)} ${fmt(issue.title)}`);
  lines.push(
    [
      `state: ${fmt(issue.state).toLowerCase()}${(issue.state_reason ?? issue.stateReason) ? ` (${fmt(issue.state_reason ?? issue.stateReason)})` : ""}`,
      `author: ${authorOf(issue.author)}`,
      `labels: ${Array.isArray(issue.labels) && issue.labels.length > 0 ? issue.labels.map((l) => (typeof l === "string" ? l : fmt(asRecord(l)?.name))).join(", ") : "none"}`,
      `assignees: ${Array.isArray(issue.assignees) && issue.assignees.length > 0 ? issue.assignees.map(authorOf).join(", ") : "none"}`,
      `milestone: ${fmt(issue.milestone)}`,
      `created: ${fmt(issue.created_at)} · updated: ${fmt(issue.updated_at)}`,
      `url: ${fmt(issue.url)}`,
    ].join("\n"),
  );
  const body = typeof issue.body === "string" ? issue.body : "";
  if (body !== "") {
    lines.push("--- body ---");
    lines.push(...body.split("\n"));
    if (issue.body_truncated === true) lines.push("… (body truncated by contract)");
  } else {
    lines.push("(no body)");
  }
  const comments = asArray(issue.comments);
  lines.push("", `comments (${comments.length}${issue.comments_truncated === true ? "+" : ""}):`);
  if (comments.length === 0) lines.push("  (none)");
  for (const c of comments) {
    lines.push(`  #${fmt(c.id)} ${fmt(c.author)} @ ${fmt(c.created_at)}`);
    const text = typeof c.body === "string" ? c.body : "";
    for (const l of text.split("\n")) lines.push(`    ${l}`);
    if (c.body_truncated === true) lines.push("    … (truncated)");
  }
  if (issue.comments_truncated === true) {
    lines.push("  … (truncated — see CLI for full list)");
  }
  return lines;
}

/** Error text for status lines: kind + message, never a stack. */
export function errorLine(err: unknown): string {
  if (err instanceof GitCliError) {
    return `${err.kind}: ${err.message}`;
  }
  if (err instanceof HerdrRpcError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
