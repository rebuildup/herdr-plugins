/**
 * Shared helpers for the rebuildup.secrets interactive TUI surface
 * (`herdr-plugins.tui/v1`, ADR-0031/0032/0033 + ADR-0027, issue #247).
 *
 * Same architecture as the projects pilot (#240) and the artifacts TUI:
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
 *
 * SECRET BOUNDARY (ADR-0027, normative here):
 * - binding selection passes NAMES only (`--binding <name>`); secret
 *   values never appear in argv, render, logs, or scrollback;
 * - `resolve`/`config`/`capability` payloads are metadata-only by
 *   contract — the view model below whitelists fields defensively so a
 *   future payload regression cannot leak a value into the UI;
 * - `run` hands off to `cli.ts run` with stdio inherited AFTER the TUI
 *   restores the terminal — resolved values flow only into the child
 *   process env, exactly like the CLI path.
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
 * `tab` per the tui-v1 placement policy: the secrets browser is a
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
    entrypoint: "main",
    placement: "tab",
    env,
  };
  if (target.workspaceId !== null) params.workspace_id = target.workspaceId;
  return params;
}

/**
 * Open the secrets TUI pane through the documented socket API.
 * `plugin.pane.open` is a herdr-state mutation: target resolution runs
 * with `mutation: true` so an implicit default-session fallback fails
 * closed (`target_required`) instead of opening on the wrong session.
 */
export async function openSecretsPane(
  params: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const socketPath = resolveTarget({ mutation: true }).socketPath;
  return request(socketPath, "plugin.pane.open", params, {
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

// --- CLI subprocess bridge ----------------------------------------------------

/** This plugin's root (`plugins/secrets`); HERDR_PLUGIN_ROOT wins. */
export function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot !== undefined && envRoot !== "") return envRoot;
  // src/tui-support.ts → plugins/secrets
  return path.resolve(import.meta.dir, "..");
}

/** Structured failure from the secrets CLI subprocess. */
export class SecretsCliError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "SecretsCliError";
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
  let message = `secrets cli exited ${exitCode} with no JSON output`;
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
  throw new SecretsCliError(message, kind, extra, exitCode);
}

/**
 * Run `bun <plugin>/src/cli.ts <args>` and return the parsed JSON
 * payload. The child inherits the full environment — including
 * HERDR_SOCKET_PATH/HERDR_SESSION/HERDR_PLUGIN_* — so it resolves the
 * SAME herdr session and plugin config dirs the TUI was launched in
 * (tui-v1 §3 identity pinning). No shell, argv only.
 *
 * NOTE: this bridge is for JSON-emitting commands only (`config`,
 * `capability`, `resolve`, `inject`). `run` inherits stdio and is
 * handled by `runSecretsExternal` in tui.ts instead.
 */
export function runSecretsCli(
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
      finish(() => reject(new SecretsCliError("cancelled", "cancelled", undefined, 130)));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new SecretsCliError(`cli timed out after ${timeoutMs}ms`, "cli_timeout")),
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
      finish(() => reject(new SecretsCliError(String(err), "cli_spawn_error")));
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

/**
 * Spawn `bun <plugin>/src/cli.ts <args>` with inherited stdio — used
 * ONLY for `run`, whose wrapped command must see the real terminal.
 * The caller (tui.ts) closes the TUI first so raw mode is restored.
 * Resolves the child exit code; never throws on non-zero exit.
 */
export function spawnSecretsCliInherit(
  args: readonly string[],
): Promise<{ code: number | null; error?: string }> {
  const root = pluginRoot();
  const cliPath = path.join(root, "src", "cli.ts");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      resolve({ code: null, error: String(err) });
    });
    child.on("close", (code) => {
      resolve({ code });
    });
  });
}

// --- command-line splitting (run flow) -----------------------------------------

/**
 * Minimal quote-aware command splitter for the `run` flow. No shell is
 * involved — the result is an argv array. Supports single/double
 * quotes and backslash escapes; an unterminated quote is an error,
 * never silently repaired.
 */
export function splitCommandLine(
  input: string,
): { ok: true; argv: string[] } | { ok: false; error: string } {
  const argv: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (quote === '"') {
      if (ch === "\\" && i + 1 < input.length) {
        current += input[i + 1] as string;
        i += 2;
        continue;
      }
      if (ch === '"') {
        quote = null;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      current += input[i + 1] as string;
      hasToken = true;
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken || current !== "") {
        argv.push(current);
        current = "";
        hasToken = false;
      }
      i += 1;
      continue;
    }
    current += ch;
    hasToken = true;
    i += 1;
  }
  if (quote !== null) {
    return { ok: false, error: `unterminated ${quote} quote` };
  }
  if (hasToken || current !== "") argv.push(current);
  return { ok: true, argv };
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
 * (e.g. "run", "inject", "config").
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

/**
 * Declared binding metadata — the ONLY shape the TUI renders for a
 * binding. Whitelisted fields; anything else in the payload (including
 * any accidental value-shaped key) is dropped by construction.
 */
export interface BindingView {
  name: string;
  env: string;
  ref: string;
  projectId: string | null;
  /** Error text when the binding failed config validation. */
  invalidReason: string | null;
}

/**
 * Parse the `config`/`capability` bindings arrays into BindingView.
 * `invalid` entries (from `invalid_bindings`) mark matching names.
 */
export function parseBindings(bindings: unknown, invalidBindings: unknown): BindingView[] {
  const invalid = new Map<string, string>();
  for (const entry of asArray(invalidBindings)) {
    const name = entry.name;
    if (typeof name === "string") {
      invalid.set(name, typeof entry.error === "string" ? entry.error : "invalid");
    }
  }
  const out: BindingView[] = [];
  for (const raw of asArray(bindings)) {
    const name = raw.name;
    const env = raw.env;
    const ref = raw.ref;
    if (typeof name !== "string" || name === "") continue;
    out.push({
      name,
      env: typeof env === "string" ? env : "?",
      ref: typeof ref === "string" ? ref : "?",
      projectId: typeof raw.projectId === "string" ? raw.projectId : null,
      invalidReason: invalid.get(name) ?? null,
    });
  }
  // Invalid declarations that have no usable name still surface honestly.
  for (const [name, error] of invalid) {
    if (!out.some((b) => b.name === name)) {
      out.push({ name, env: "?", ref: "?", projectId: null, invalidReason: error });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Select-list row for one declared binding (metadata only). */
export function bindingSelectItem(binding: BindingView): SelectItem<BindingView> {
  const disabled = binding.invalidReason !== null;
  return {
    value: binding,
    label: `${binding.name} → ${binding.env}`,
    detail: [
      `ref: ${binding.ref}`,
      ...(binding.projectId !== null ? [`project: ${binding.projectId}`] : []),
      "value: never displayed (ADR-0027)",
      ...(disabled ? [`INVALID: ${binding.invalidReason}`] : []),
    ].join("\n"),
    ...(disabled ? { disabled: true, disabledReason: binding.invalidReason ?? "invalid" } : {}),
  };
}

/**
 * Format a `resolve` payload — METADATA ONLY by contract. Every field
 * is whitelisted; a `value`/`env`/`secret`-shaped key in the payload
 * can never reach the rendered lines (ADR-0027; regression-tested).
 */
export function formatResolvePayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`resolve — ok: ${payload.ok === true ? "yes" : "no"}`);
  const reports = asArray(payload.bindings);
  if (reports.length === 0) {
    lines.push("(no binding reports)");
  }
  for (const r of reports) {
    const name = fmt(r.name);
    const env = fmt(r.env);
    const ref = fmt(r.ref);
    const status = fmt(r.status);
    const detail = typeof r.detail === "string" ? r.detail : null;
    lines.push(`${name} → ${env} [${status}]${detail !== null ? ` — ${detail}` : ""}`);
    lines.push(`  ref: ${ref}`);
  }
  lines.push("");
  lines.push("metadata only — secret values are never emitted (ADR-0027 §3).");
  return lines;
}

/** Format an `inject` result — env NAMES only, never values. */
export function formatInjectResult(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const injected = asRecord(payload.injected);
  if (injected === null) {
    lines.push("inject returned no result payload");
    return lines;
  }
  lines.push(`surface: ${fmt(injected.surface)}`);
  if (typeof injected.pane_id === "string") lines.push(`pane: ${injected.pane_id}`);
  if (typeof injected.tab_id === "string") lines.push(`tab: ${injected.tab_id}`);
  if (typeof injected.workspace_id === "string") {
    lines.push(`workspace: ${injected.workspace_id}`);
  }
  const envNames = Array.isArray(injected.env_names)
    ? injected.env_names.filter((n): n is string => typeof n === "string")
    : [];
  lines.push(`env injected (${envNames.length}): ${envNames.join(", ")}`);
  lines.push("values were passed to surface creation only — never displayed.");
  return lines;
}

/** Format the `capability` payload for an info detail view. */
export function formatCapabilityPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`contract: ${fmt(payload.contract)}`);
  lines.push(`plugin: ${fmt(payload.plugin)} v${fmt(payload.version)}`);
  const provider = asRecord(payload.provider);
  if (provider !== null) {
    lines.push(`provider: ${fmt(provider.name)} @ ${fmt(provider.domain)}`);
    const cli = asRecord(provider.cli);
    if (cli !== null) {
      lines.push(
        `cli: ${fmt(cli.bin)} — ${cli.available === true ? `available${typeof cli.version === "string" ? ` (${cli.version})` : ""}` : `unavailable${typeof cli.detail === "string" ? ` — ${cli.detail}` : ""}`}`,
      );
    }
    const reachability = asRecord(provider.reachability);
    if (reachability !== null) {
      lines.push(
        `reachability: ${fmt(reachability.status)}${typeof reachability.detail === "string" ? ` — ${reachability.detail}` : ""}`,
      );
    }
  }
  if (Array.isArray(payload.mutation_commands)) {
    lines.push(`mutation_commands: ${payload.mutation_commands.join(", ")}`);
  }
  if (Array.isArray(payload.warnings)) {
    for (const w of payload.warnings) {
      if (typeof w === "string") lines.push(`warning: ${w}`);
    }
  }
  if (Array.isArray(payload.config_warnings)) {
    for (const w of payload.config_warnings) {
      if (typeof w === "string") lines.push(`config warning: ${w}`);
    }
  }
  return lines;
}

/** Error text for status lines: kind + message, never a stack. */
export function errorLine(err: unknown): string {
  if (err instanceof SecretsCliError) {
    return `${err.kind}: ${err.message}`;
  }
  if (err instanceof HerdrRpcError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
