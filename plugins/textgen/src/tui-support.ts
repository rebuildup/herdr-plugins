/**
 * Shared helpers for the rebuildup.textgen interactive TUI surface
 * (`herdr-plugins.tui/v1`, ADR-0031/0032/0033).
 *
 * Everything here is deliberately thin:
 *
 * - the TUI consumes the plugin's OWN public CLI (`src/cli.ts`) as a
 *   subprocess for every read and `generate` call — the same contract
 *   CLI/MCP/GUI consumers use, so CLI/MCP/GUI behavior cannot drift;
 * - pane opening goes through the documented socket API
 *   (`plugin.pane.open`), never private channels;
 * - target identity is pinned at launch (tui-v1 §3): the `open` action
 *   captures the origin context once and forwards it as explicit
 *   `HERDR_TUI_*` env pins on `plugin.pane.open`. `HERDR_PANE_ID` is the
 *   UI pane's own surface identity and is NEVER used as a target;
 * - generation stays separated from application: the TUI renders the
 *   `generate` result for review/copy only. The contract has no
 *   list/history/result persistence (#249) — results live only in this
 *   view and are labelled "not retained" honestly.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HerdrRpcError, request, resolveTarget } from "../../../packages/herdr-client/src/index";
import { PLUGIN_ID, type TaskKind, taskSpec } from "./model";

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
  /** Origin cwd — a base dir for `@file` input fields and a git-context hint. */
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
 * `tab` per the tui-v1 placement policy: the generation console is a
 * workspace-scale surface, multi-instance safe (each run pins its own
 * target), and pane-backed so `plugin.pane.focus/close` keep working.
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
 * Open the textgen TUI pane through the documented socket API.
 * `plugin.pane.open` is a herdr-state mutation: target resolution runs
 * with `mutation: true` so an implicit default-session fallback fails
 * closed (`target_required`) instead of opening on the wrong session.
 */
export async function openTextgenPane(
  params: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const socketPath = resolveTarget({ mutation: true }).socketPath;
  return request(socketPath, "plugin.pane.open", params, {
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

// --- CLI subprocess bridge ----------------------------------------------------

/** This plugin's root (`plugins/textgen`); HERDR_PLUGIN_ROOT wins. */
export function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot !== undefined && envRoot !== "") return envRoot;
  // src/tui-support.ts → plugins/textgen
  return path.resolve(import.meta.dir, "..");
}

/** Structured failure from the textgen CLI subprocess. */
export class TextgenCliError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "TextgenCliError";
  }
}

export interface CliRunOptions {
  /** Hard cap on the subprocess; default 120s (reads). Long ops pass more. */
  timeoutMs?: number;
  /** AbortSignal (task cancel). See `cancelPolicy`. */
  signal?: AbortSignal;
  /** JSON payload written to the child's stdin (generate input). */
  input?: string;
  /**
   * What an abort does to the child:
   * - "kill" (default): terminate the subprocess — safe for read-only
   *   commands (capability, git-context).
   * - "detach": keep the child running and draining; the promise rejects
   *   `cancelled` only after the child exits. REQUIRED for `generate`:
   *   the agent path owns a dedicated herdr workspace whose cleanup
   *   lives in a `finally` — killing the CLI mid-generation would
   *   orphan it (ADR-0017). The CLI's own `--timeout` bounds the run.
   */
  cancelPolicy?: "kill" | "detach";
}

function parseCliEnvelope(
  stdout: string,
  stderr: string,
  exitCode: number,
): Record<string, unknown> {
  // The CLI emits one JSON document on stdout (pretty-printed); parse
  // the whole stream first, then fall back to per-line candidates for
  // compact single-line emitters (watch JSONL is never used here).
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
  let message = `textgen cli exited ${exitCode} with no JSON output`;
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
  throw new TextgenCliError(message, kind, extra, exitCode);
}

/**
 * Run `bun <plugin>/src/cli.ts <args>` and return the parsed JSON
 * payload. The child inherits the full environment — including
 * HERDR_SOCKET_PATH/HERDR_SESSION/HERDR_PLUGIN_* — so it resolves the
 * SAME herdr session and plugin state dirs the TUI was launched in
 * (tui-v1 §3 identity pinning). No shell, argv only.
 */
export function runTextgenCli(
  args: readonly string[],
  options: CliRunOptions = {},
): Promise<Record<string, unknown>> {
  const root = pluginRoot();
  const cliPath = path.join(root, "src", "cli.ts");
  const timeoutMs = options.timeoutMs ?? 120_000;
  const detach = options.cancelPolicy === "detach";
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => {
      aborted = true;
      if (!detach) {
        child.kill();
        finish(() => reject(new TextgenCliError("cancelled", "cancelled", undefined, 130)));
        return;
      }
      // Detach: keep draining so the child never blocks on a full pipe;
      // it exits via its own --timeout and its `finally` workspace
      // cleanup still runs. The rejection lands after close — the
      // TaskRunner race has already reported "cancelled".
    };
    const timer = setTimeout(() => {
      if (detach) {
        // Same detach semantics: the CLI's own --timeout is the real
        // bound; killing here could orphan the agent workspace.
        aborted = true;
        return;
      }
      child.kill();
      finish(() =>
        reject(new TextgenCliError(`cli timed out after ${timeoutMs}ms`, "cli_timeout")),
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
      finish(() => reject(new TextgenCliError(String(err), "cli_spawn_error")));
    });
    child.on("close", (code) => {
      finish(() => {
        if (aborted) {
          reject(new TextgenCliError("cancelled", "cancelled", undefined, 130));
          return;
        }
        try {
          resolve(parseCliEnvelope(stdout, stderr, code ?? -1));
        } catch (err) {
          reject(err);
        }
      });
    });

    // Feed the JSON input payload, then close stdin so `readStdin`
    // terminates. An empty string still satisfies `--input` piped mode
    // callers that send "{}" explicitly.
    const stdin = child.stdin;
    if (stdin !== null) {
      stdin.on("error", () => {
        // EPIPE when the child exits before reading stdin — close path
        // reports the real outcome.
      });
      stdin.end(options.input ?? "");
    }
  });
}

// --- mutation gating (capability / mutation_commands) ------------------------

/** Subset of the `capability` payload the TUI consults (tui-v1 §5.4). */
export interface CapabilityDoc {
  read_only?: boolean;
  mutation_commands?: unknown;
  tasks?: unknown;
  providers?: unknown;
  guards?: unknown;
  config?: unknown;
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
 * (e.g. "generate", "watch-next-prompt", "config set-default-provider").
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

// --- capability → view model (pure, unit-tested) ------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** One task row from `capability.tasks[]`. */
export interface TextgenTaskInfo {
  kind: TaskKind | string;
  description: string;
  paths: string[];
  inputFields: string[];
  requiredInput: string[];
  output: string;
  requiresOptIn: boolean;
}

/** Parse `capability.tasks` tolerantly; unknown entries are skipped. */
export function capabilityTasks(capability: CapabilityDoc | null): TextgenTaskInfo[] {
  const tasks = asArray(capability?.tasks);
  const out: TextgenTaskInfo[] = [];
  for (const t of tasks) {
    const kind = str(t.kind);
    if (kind === null) continue;
    out.push({
      kind,
      description: str(t.description) ?? "",
      paths: strList(t.paths),
      inputFields: strList(t.input_fields),
      requiredInput: strList(t.required_input),
      output: str(t.output) ?? "text",
      requiresOptIn: t.requires_opt_in === true,
    });
  }
  return out;
}

/** One provider row from `capability.providers.{agent,api}`. */
export interface ProviderOption {
  /** Wire id, e.g. "agent:claude" / "api:openai". */
  id: string;
  path: "agent" | "api";
  /** Short label bits for the select row. */
  detail: string;
  enabled: boolean;
  /** Non-null ⇒ render disabled with this reason (honest unsupported). */
  disabledReason: string | null;
}

/**
 * Flatten agent + api provider lists into selectable options.
 * Disabled/absent-credential/unlisted-manifest providers stay visible
 * with their reason — never silently dropped (contract item 9/4).
 */
export function providerOptions(capability: CapabilityDoc | null): ProviderOption[] {
  const providers = asRecord(capability?.providers);
  const out: ProviderOption[] = [];
  for (const p of asArray(providers?.agent)) {
    const id = str(p.id);
    if (id === null) continue;
    const enabled = p.enabled !== false;
    const availability = str(p.availability);
    let disabledReason: string | null = null;
    if (!enabled) disabledReason = "disabled in config (agentProviders[].enabled)";
    else if (availability === "not_in_manifests")
      disabledReason = "agent kind not in herdr server.agent_manifests";
    const bits = [
      `path agent · kind ${str(p.kind) ?? "?"}`,
      availability !== null ? `availability ${availability}` : null,
      typeof p.model === "string" ? `model ${p.model}` : null,
    ].filter((b): b is string => b !== null);
    out.push({ id, path: "agent", detail: bits.join(" · "), enabled, disabledReason });
  }
  for (const p of asArray(providers?.api)) {
    const id = str(p.id);
    if (id === null) continue;
    const enabled = p.enabled === true;
    const cred = p.credential_configured === true;
    let disabledReason: string | null = null;
    if (!enabled) disabledReason = "disabled — opt in via config add-api-generator --enable";
    else if (!cred) disabledReason = "no credential configured (env var or keys/<id>.key)";
    const bits = [
      `path api · kind ${str(p.kind) ?? "?"}`,
      `endpoint ${str(p.endpoint) ?? "?"}`,
      str(p.model) !== null ? `model ${str(p.model)}` : "no model",
    ];
    out.push({ id, path: "api", detail: bits.join(" · "), enabled, disabledReason });
  }
  return out;
}

/** `guards.expensive_task_opt_in` from the capability document. */
export function expensiveTaskOptIn(capability: CapabilityDoc | null): boolean {
  const guards = asRecord(capability?.guards);
  return guards?.expensive_task_opt_in === true;
}

/** `config.defaultProvider` / `defaultModel` hints (redacted config). */
export function configDefaults(capability: CapabilityDoc | null): {
  provider: string | null;
  model: string | null;
} {
  const config = asRecord(capability?.config);
  return {
    provider: str(config?.defaultProvider),
    model: str(config?.defaultModel),
  };
}

// --- generate argv + input -----------------------------------------------------

export interface GenerateSpec {
  task: TaskKind;
  /** null/undefined → omit --provider (contract resolution order applies). */
  provider?: string | null;
  model?: string | null;
  /** --git-pane value; only valid for git tasks (CLI enforces). */
  gitPane?: string | null;
  /** --allow-expensive for requires_opt_in tasks. */
  allowExpensive?: boolean;
  /** --timeout override in ms (the CLI's own bound). */
  timeoutMs?: number;
}

/** Build the `generate` argv — pure, unit-tested. Input goes via stdin. */
export function buildGenerateArgs(spec: GenerateSpec): string[] {
  const args = ["generate", "--task", spec.task];
  if (spec.provider !== undefined && spec.provider !== null && spec.provider !== "") {
    args.push("--provider", spec.provider);
  }
  if (spec.model !== undefined && spec.model !== null && spec.model.trim() !== "") {
    args.push("--model", spec.model.trim());
  }
  if (spec.gitPane !== undefined && spec.gitPane !== null && spec.gitPane.trim() !== "") {
    args.push("--git-pane", spec.gitPane.trim());
  }
  if (spec.allowExpensive === true) args.push("--allow-expensive");
  if (spec.timeoutMs !== undefined && spec.timeoutMs > 0) {
    args.push("--timeout", String(Math.floor(spec.timeoutMs)));
  }
  // Input JSON is piped on stdin; the CLI reads stdin when it is not a TTY.
  return args;
}

/** Per-task runner/CLI timeout: agent-only tasks use their contract
 *  defaultTimeoutMs; agent+api tasks use the config agent prompt wait
 *  default (300s) — plus a grace margin for workspace cleanup. */
export function generateTimeoutMs(task: TaskKind | string): number {
  try {
    const spec = taskSpec(task as TaskKind);
    const base =
      spec.paths.length === 1 && spec.paths[0] === "agent" ? spec.defaultTimeoutMs : 300_000;
    return base + 60_000;
  } catch {
    return 360_000;
  }
}

// --- input field values ---------------------------------------------------------

/** Cap for `@file` field reads — well under limits.maxInputChars default. */
export const FIELD_FILE_MAX_CHARS = 1_000_000;

export type FieldValueResult = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Resolve one input-field value entered in the TUI. Single-line prompts
 * cannot carry multiline text (packages/tui TextInput flattens pasted
 * newlines), so a leading `@` reads the rest as a file path — resolved
 * against the pinned origin cwd, then the process cwd. File content is
 * used verbatim; the CLI's input boundary + secret guard still apply.
 */
export async function resolveFieldValue(
  raw: string,
  baseDir: string | null,
): Promise<FieldValueResult> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("@") || trimmed.length < 2) {
    return { ok: true, value: raw };
  }
  const rel = trimmed.slice(1).trim();
  if (rel === "") return { ok: false, reason: "@ with no path" };
  const candidates = [
    path.isAbsolute(rel) ? rel : null,
    baseDir !== null ? path.resolve(baseDir, rel) : null,
    path.resolve(process.cwd(), rel),
  ].filter((c): c is string => c !== null);
  let lastError = "unreadable";
  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf8");
      if (content.length > FIELD_FILE_MAX_CHARS) {
        return {
          ok: false,
          reason: `file exceeds ${FIELD_FILE_MAX_CHARS} chars — split it or use the CLI`,
        };
      }
      return { ok: true, value: content };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, reason: `cannot read @file: ${lastError}` };
}

// --- result rendering ------------------------------------------------------------

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * Format a successful `generate` payload for the result view.
 * The footer ALWAYS states the retention reality: textgen returns
 * results to the caller only — nothing is persisted plugin-side (#249)
 * and nothing is auto-applied to any agent/forge.
 */
export function formatGenerateResult(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`task: ${fmt(payload.task)}`);
  lines.push(`provider: ${fmt(payload.provider)} · path ${fmt(payload.path)}`);
  lines.push(`model: ${fmt(payload.model)} · elapsed ${fmt(payload.elapsed_ms)}ms`);
  const git = asRecord(payload.git_context);
  if (git !== null) {
    lines.push(
      `git context: pane ${fmt(git.pane_id)} · repo ${fmt(git.repo_root)} · branch ${fmt(git.branch)}`,
    );
  }
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((w): w is string => typeof w === "string")
    : [];
  for (const w of warnings) lines.push(`warning: ${w}`);
  lines.push("─".repeat(40));

  const result = payload.result;
  if (typeof result === "string") {
    lines.push(result);
  } else if (Array.isArray(result)) {
    result.forEach((candidate, i) => {
      lines.push(`--- candidate ${i + 1} ---`);
      lines.push(String(candidate));
    });
  } else {
    const pr = asRecord(result);
    if (pr !== null && (typeof pr.title === "string" || typeof pr.body === "string")) {
      lines.push(`title: ${fmt(pr.title)}`);
      lines.push("");
      lines.push(typeof pr.body === "string" ? pr.body : fmt(pr.body));
    } else {
      lines.push(JSON.stringify(result, null, 2));
    }
  }

  lines.push("─".repeat(40));
  lines.push("not retained: textgen returns results to the caller only — nothing is");
  lines.push("persisted plugin-side and nothing is applied to an agent, git, or forge.");
  lines.push("adopting a result is always an explicit manual step (#249).");
  return lines;
}

/** Result text for the clipboard — raw result only, no chrome. */
export function resultClipboardText(payload: Record<string, unknown>): string {
  const result = payload.result;
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(String).join("\n\n---\n\n");
  const pr = asRecord(result);
  if (pr !== null && (typeof pr.title === "string" || typeof pr.body === "string")) {
    return `${fmt(pr.title)}\n\n${typeof pr.body === "string" ? pr.body : ""}`.trimEnd();
  }
  return JSON.stringify(result, null, 2);
}

// --- clipboard -------------------------------------------------------------------

export type ClipboardResult = { ok: true } | { ok: false; reason: string };

interface ClipboardTool {
  argv: string[];
  /** Text goes via stdin, never argv (untrusted content). */
}

function clipboardTool(platform: NodeJS.Platform): ClipboardTool[] {
  if (platform === "darwin") return [{ argv: ["pbcopy"] }];
  if (platform === "win32") return [{ argv: ["clip.exe"] }];
  return [
    { argv: ["wl-copy"] },
    { argv: ["xclip", "-selection", "clipboard"] },
    { argv: ["xsel", "--clipboard", "--input"] },
  ];
}

/**
 * Copy text to the OS clipboard through a well-known tool, text on
 * stdin only. Always an explicit user action; reports honest failure
 * when no tool exists (contract items 8/9 — never fake success).
 */
export function copyToClipboard(
  text: string,
  options: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<ClipboardResult> {
  const platform = options.platform ?? process.platform;
  const tools = clipboardTool(platform);
  return (async () => {
    let lastReason = "no clipboard tool found";
    for (const tool of tools) {
      const result = await new Promise<ClipboardResult>((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(tool.argv[0] as string, tool.argv.slice(1), {
            env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
            stdio: ["pipe", "ignore", "ignore"],
          });
        } catch {
          resolve({ ok: false, reason: "spawn-failed" });
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          resolve({ ok: false, reason: "timeout" });
        }, options.timeoutMs ?? 5_000);
        if (typeof timer === "object" && timer && "unref" in timer) {
          (timer as { unref: () => void }).unref();
        }
        child.on("error", () => {
          clearTimeout(timer);
          resolve({ ok: false, reason: "spawn-failed" });
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code === 0 ? { ok: true } : { ok: false, reason: `exit ${code ?? "?"}` });
        });
        const stdin = child.stdin;
        if (stdin !== null) {
          stdin.on("error", () => {
            // EPIPE — the exit handler reports the real outcome.
          });
          stdin.end(text);
        }
      });
      if (result.ok) return result;
      lastReason = result.reason;
      // "spawn-failed" means the tool binary is absent — try the next.
      if (result.reason !== "spawn-failed" && result.reason !== "exit 127") break;
    }
    return { ok: false, reason: lastReason };
  })();
}

/** Error text for status lines: kind + message, never a stack. */
export function errorLine(err: unknown): string {
  if (err instanceof TextgenCliError) {
    return `${err.kind}: ${err.message}`;
  }
  if (err instanceof HerdrRpcError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
