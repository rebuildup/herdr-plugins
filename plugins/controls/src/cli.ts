/**
 * rebuildup.controls CLI — agent operation core contract
 * (`herdr-plugins.controls/v1`) for agents and external clients.
 * Single JSON document on stdout; diagnostics on stderr.
 * Exit 0 success, 1 handled error, 2 usage.
 *
 * All operations go through herdr's `agent.*` socket API — never PTY
 * text scraping, never fabricated agent state (ADR-0017). `interrupt`
 * is explicitly PTY-level key injection; `read` is scrollback, not
 * structured history.
 */

import {
  AGENT_READ_FORMATS,
  AGENT_READ_SOURCES,
  AGENT_STATUSES,
  type AgentReadFormat,
  type AgentReadResult,
  type AgentReadSource,
  type AgentStatus,
  agentPrompt,
  agentRead,
  agentRename,
  agentSendKeys,
  agentStart,
  agentWait,
  type CallOptions,
} from "../../../packages/herdr-client/src/index";
import { CONTRACT, capabilityPayload } from "./capability";
import { buildCommandText, commandInfoFor } from "./commands";
import {
  checkGeneration,
  type GenerationExpectation,
  identityForAgent,
  isAgentRpcError,
  type ResolvedAgent,
  resolveAgent,
} from "./identity";
import {
  buildLaunchArgs,
  canonicalKind,
  PERMISSION_MODES,
  type PermissionMode,
  type ResumeSessionKind,
} from "./launch";

const PLUGIN_VERSION = "0.6.0";

interface CliOptions extends CallOptions {
  command: string;
  args: string[];
  session: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options: CliOptions = { command, args, session: undefined };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--session") {
      options.session = args[++i];
    } else if (arg === "--socket") {
      options.socketPath = args[++i];
    } else if (arg === "--timeout") {
      const value = Number(args[++i]);
      if (Number.isFinite(value) && value > 0) options.timeoutMs = value;
    } else {
      rest.push(arg);
    }
  }
  options.args = rest;
  return options;
}

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(message: string, code = 1, kind?: string, extra?: Record<string, unknown>): never {
  const error: Record<string, unknown> = {
    code: code === 2 ? "usage" : "error",
    message,
  };
  if (kind) error.kind = kind;
  if (extra) Object.assign(error, extra);
  process.stderr.write(`${JSON.stringify({ contract: CONTRACT, ok: false, error })}\n`);
  process.exit(code);
}

function now(): string {
  return new Date().toISOString();
}

// --- Per-command argument parsing -------------------------------------------

interface ParsedArgs {
  positionals: string[];
  /** Last value per option name. */
  values: Map<string, string>;
  /** All values per option name, for repeatable options. */
  multi: Map<string, string[]>;
  flags: Set<string>;
}

/**
 * Split command args into positionals, `--name value`/`--name=value`
 * options, and bare boolean flags (same convention as
 * rebuildup.projects).
 */
function parseCommandArgs(args: string[], valueFlags: ReadonlySet<string>): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const flags = new Set<string>();
  const push = (name: string, value: string): void => {
    values.set(name, value);
    const list = multi.get(name);
    if (list) list.push(value);
    else multi.set(name, [value]);
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        push(arg.slice(0, eq), arg.slice(eq + 1));
        continue;
      }
      if (valueFlags.has(arg)) {
        const value = args[++i];
        if (value === undefined) fail(`${arg} requires a value`, 2);
        push(arg, value);
      } else {
        flags.add(arg);
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, values, multi, flags };
}

// --- Shared resolution --------------------------------------------------------

const EXPECT_VALUE_FLAGS = new Set([
  "--expect-pane",
  "--expect-state-seq",
  "--expect-agent-session",
]);

function expectationFrom(parsed: ParsedArgs): GenerationExpectation {
  const expected: GenerationExpectation = {};
  const pane = parsed.values.get("--expect-pane");
  if (pane !== undefined) expected.pane = pane;
  const seqRaw = parsed.values.get("--expect-state-seq");
  if (seqRaw !== undefined) {
    const seq = Number(seqRaw);
    if (!Number.isInteger(seq) || seq < 0) {
      fail(`--expect-state-seq must be a non-negative integer, got: ${seqRaw}`, 2);
    }
    expected.stateSeq = seq;
  }
  const session = parsed.values.get("--expect-agent-session");
  if (session !== undefined) expected.agentSession = session;
  return expected;
}

/**
 * Resolve + generation-guard the target. RPC errors keep herdr's error
 * code as the structured `kind` (e.g. `agent_not_found`, `timeout`);
 * transport failures become `session_unreachable`.
 */
async function resolveGuarded(
  target: string,
  options: CallOptions,
  parsed: ParsedArgs,
): Promise<ResolvedAgent> {
  let resolved: ResolvedAgent;
  try {
    resolved = await resolveAgent(target, options);
  } catch (err) {
    if (isAgentRpcError(err)) fail(err.message, 1, err.code);
    fail(
      `herdr session unreachable: ${err instanceof Error ? err.message : String(err)}`,
      1,
      "session_unreachable",
    );
  }
  try {
    checkGeneration(resolved, expectationFrom(parsed));
  } catch (err) {
    const e = err as { message?: string; kind?: string; extra?: Record<string, unknown> };
    fail(e.message ?? String(err), 1, e.kind ?? "stale_generation", e.extra);
  }
  return resolved;
}

function parseStatuses(values: string[] | undefined, flag: string): AgentStatus[] | undefined {
  if (values === undefined) return undefined;
  const out: AgentStatus[] = [];
  for (const value of values) {
    if (!(AGENT_STATUSES as readonly string[]).includes(value)) {
      fail(`${flag} must be one of ${AGENT_STATUSES.join("|")}, got: ${value}`, 2);
    }
    out.push(value as AgentStatus);
  }
  return out;
}

function parseTimeoutMs(parsed: ParsedArgs): number | undefined {
  const raw = parsed.values.get("--timeout-ms");
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    fail(`--timeout-ms must be a non-negative number, got: ${raw}`, 2);
  }
  return value;
}

// --- Commands -----------------------------------------------------------------

async function cmdCapability(): Promise<void> {
  emit(capabilityPayload(PLUGIN_VERSION, now()));
}

async function cmdSend(options: CliOptions): Promise<void> {
  const parsed = parseCommandArgs(
    options.args,
    new Set([...EXPECT_VALUE_FLAGS, "--wait-until", "--timeout-ms"]),
  );
  const target = parsed.positionals[0];
  const text = parsed.positionals.slice(1).join(" ");
  if (!target || text === "") {
    fail("send requires <target> and <text>", 2);
  }
  const until = parseStatuses(parsed.multi.get("--wait-until"), "--wait-until");
  const timeoutMs = parseTimeoutMs(parsed);
  const wantsWait = parsed.flags.has("--wait") || until !== undefined;

  const resolved = await resolveGuarded(target as string, options, parsed);

  // herdr rejects agent.prompt on a blocked agent with `agent_blocked`
  // before any input is sent; surface the same semantics as a structured
  // error without ever reporting success (issue #99 requirement).
  if (resolved.identity.agent_status === "blocked") {
    fail(
      `agent is blocked and requires interactive input; agent.prompt would be rejected`,
      1,
      "requires_interactive_input",
      {
        identity: resolved.identity,
        agent_status: "blocked",
        hint: "resolve the interactive prompt in the pane (see `interrupt` for PTY-level keys) or use a structured dialog surface when available",
      },
    );
  }

  const wait =
    wantsWait || timeoutMs !== undefined
      ? {
          ...(until !== undefined ? { until } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }
      : undefined;

  let result: unknown;
  try {
    result = await agentPrompt(target as string, text, wait, options);
  } catch (err) {
    if (isAgentRpcError(err)) fail(err.message, 1, err.code);
    fail(
      `herdr session unreachable: ${err instanceof Error ? err.message : String(err)}`,
      1,
      "session_unreachable",
    );
  }
  emit({
    contract: CONTRACT,
    command: "send",
    identity: resolved.identity,
    waited: wait !== undefined,
    result,
    generated_at: now(),
  });
}

/**
 * `command <target> <slash-command> [args...]` — provider slash-command
 * passthrough. herdr has no structured command API; `agent.prompt`
 * types the literal `/name args` text (bracketed paste + Enter), so
 * the command must start the message (T3 Code composer rule) and the
 * provider TUI decides whether it exists. Same blocked-agent guard as
 * `send`.
 */
async function cmdCommand(options: CliOptions): Promise<void> {
  const parsed = parseCommandArgs(
    options.args,
    new Set([...EXPECT_VALUE_FLAGS, "--wait-until", "--timeout-ms"]),
  );
  const target = parsed.positionals[0];
  const slashCommand = parsed.positionals[1];
  const commandArgs = parsed.positionals.slice(2);
  if (!target || slashCommand === undefined) {
    fail("command requires <target> and <slash-command> (e.g. /model)", 2);
  }

  let built: ReturnType<typeof buildCommandText>;
  try {
    built = buildCommandText(slashCommand as string, commandArgs);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 2);
  }

  const until = parseStatuses(parsed.multi.get("--wait-until"), "--wait-until");
  const timeoutMs = parseTimeoutMs(parsed);
  const wantsWait = parsed.flags.has("--wait") || until !== undefined;

  const resolved = await resolveGuarded(target as string, options, parsed);

  // Same semantics as `send`: herdr rejects agent.prompt on a blocked
  // agent before any input is sent; never report success.
  if (resolved.identity.agent_status === "blocked") {
    fail(
      `agent is blocked and requires interactive input; agent.prompt would be rejected`,
      1,
      "requires_interactive_input",
      {
        identity: resolved.identity,
        agent_status: "blocked",
        hint: "resolve the interactive prompt in the pane (see `interrupt` for PTY-level keys) or use a structured dialog surface when available",
      },
    );
  }

  const wait =
    wantsWait || timeoutMs !== undefined
      ? {
          ...(until !== undefined ? { until } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }
      : undefined;

  let result: unknown;
  try {
    result = await agentPrompt(target as string, built.text, wait, options);
  } catch (err) {
    if (isAgentRpcError(err)) fail(err.message, 1, err.code);
    fail(
      `herdr session unreachable: ${err instanceof Error ? err.message : String(err)}`,
      1,
      "session_unreachable",
    );
  }
  emit({
    contract: CONTRACT,
    command: "command",
    identity: resolved.identity,
    passthrough: "agent.prompt",
    command_name: `/${built.name}`,
    text: built.text,
    provider: commandInfoFor(resolved.identity.agent, built.name),
    fragile: true,
    waited: wait !== undefined,
    result,
    generated_at: now(),
  });
}

async function cmdWait(options: CliOptions): Promise<void> {
  const parsed = parseCommandArgs(
    options.args,
    new Set([...EXPECT_VALUE_FLAGS, "--until", "--timeout-ms"]),
  );
  const target = parsed.positionals[0];
  if (!target || parsed.positionals.length > 1) {
    fail("wait requires exactly one <target>", 2);
  }
  const until = parseStatuses(parsed.multi.get("--until"), "--until");
  const timeoutMs = parseTimeoutMs(parsed);

  const resolved = await resolveGuarded(target as string, options, parsed);

  let result: unknown;
  try {
    result = await agentWait(
      target as string,
      {
        ...(until !== undefined ? { until } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      options,
    );
  } catch (err) {
    if (isAgentRpcError(err)) fail(err.message, 1, err.code);
    fail(
      `herdr session unreachable: ${err instanceof Error ? err.message : String(err)}`,
      1,
      "session_unreachable",
    );
  }
  emit({
    contract: CONTRACT,
    command: "wait",
    identity: resolved.identity,
    result,
    generated_at: now(),
  });
}

async function cmdInterrupt(options: CliOptions): Promise<void> {
  const parsed = parseCommandArgs(
    options.args,
    new Set([...EXPECT_VALUE_FLAGS, "--key", "--keys"]),
  );
  const target = parsed.positionals[0];
  if (!target || parsed.positionals.length > 1) {
    fail("interrupt requires exactly one <target>", 2);
  }
  // --key is repeatable; a comma-separated --keys value is also accepted.
  const keys: string[] = [];
  for (const k of parsed.multi.get("--key") ?? []) keys.push(k);
  const keysOpt = parsed.values.get("--keys");
  if (keysOpt !== undefined) {
    for (const k of keysOpt.split(",")) {
      const trimmed = k.trim();
      if (trimmed !== "") keys.push(trimmed);
    }
  }
  const finalKeys = keys.length > 0 ? keys : ["esc"];

  const resolved = await resolveGuarded(target as string, options, parsed);

  let result: unknown;
  try {
    result = await agentSendKeys(target as string, finalKeys, options);
  } catch (err) {
    if (isAgentRpcError(err)) fail(err.message, 1, err.code);
    fail(
      `herdr session unreachable: ${err instanceof Error ? err.message : String(err)}`,
      1,
      "session_unreachable",
    );
  }
  emit({
    contract: CONTRACT,
    command: "interrupt",
    identity: resolved.identity,
    keys: finalKeys,
    pty_level: true,
    result,
    generated_at: now(),
  });
}

async function cmdRead(options: CliOptions): Promise<void> {
  const parsed = parseCommandArgs(
    options.args,
    new Set([...EXPECT_VALUE_FLAGS, "--source", "--lines", "--format", "--no-strip-ansi"]),
  );
  const target = parsed.positionals[0];
  if (!target || parsed.positionals.length > 1) {
    fail("read requires exactly one <target>", 2);
  }
  const sourceRaw = parsed.values.get("--source") ?? "recent";
  if (!(AGENT_READ_SOURCES as readonly string[]).includes(sourceRaw)) {
    fail(`--source must be one of ${AGENT_READ_SOURCES.join("|")}, got: ${sourceRaw}`, 2);
  }
  const formatRaw = parsed.values.get("--format");
  let format: AgentReadFormat | undefined;
  if (formatRaw !== undefined) {
    if (!(AGENT_READ_FORMATS as readonly string[]).includes(formatRaw)) {
      fail(`--format must be one of ${AGENT_READ_FORMATS.join("|")}, got: ${formatRaw}`, 2);
    }
    format = formatRaw as AgentReadFormat;
  }
  let lines: number | undefined;
  const linesRaw = parsed.values.get("--lines");
  if (linesRaw !== undefined) {
    const value = Number(linesRaw);
    if (!Number.isInteger(value) || value < 0) {
      fail(`--lines must be a non-negative integer, got: ${linesRaw}`, 2);
    }
    lines = value;
  }
  // ansi output is meaningless stripped; strip_ansi defaults to true for
  // text and false for ansi unless the caller says otherwise.
  const stripAnsi = parsed.flags.has("--no-strip-ansi") ? false : format !== "ansi";

  const resolved = await resolveGuarded(target as string, options, parsed);

  let read: AgentReadResult;
  try {
    read = await agentRead(
      target as string,
      {
        source: sourceRaw as AgentReadSource,
        ...(lines !== undefined ? { lines } : {}),
        ...(format !== undefined ? { format } : {}),
        stripAnsi,
      },
      options,
    );
  } catch (err) {
    if (isAgentRpcError(err)) fail(err.message, 1, err.code);
    fail(
      `herdr session unreachable: ${err instanceof Error ? err.message : String(err)}`,
      1,
      "session_unreachable",
    );
  }
  emit({
    contract: CONTRACT,
    command: "read",
    identity: resolved.identity,
    scrollback: true,
    read,
    generated_at: now(),
  });
}

async function cmdRename(options: CliOptions): Promise<void> {
  const parsed = parseCommandArgs(options.args, new Set([...EXPECT_VALUE_FLAGS, "--name"]));
  const target = parsed.positionals[0];
  if (!target || parsed.positionals.length > 1) {
    fail("rename requires exactly one <target>", 2);
  }
  const name = parsed.values.get("--name");
  const clear = parsed.flags.has("--clear");
  if ((name === undefined) === !clear) {
    fail("rename requires exactly one of --name NAME or --clear", 2);
  }

  const resolved = await resolveGuarded(target as string, options, parsed);

  let result: unknown;
  try {
    result = await agentRename(target as string, clear ? null : (name as string), options);
  } catch (err) {
    if (isAgentRpcError(err)) fail(err.message, 1, err.code);
    fail(
      `herdr session unreachable: ${err instanceof Error ? err.message : String(err)}`,
      1,
      "session_unreachable",
    );
  }
  emit({
    contract: CONTRACT,
    command: "rename",
    identity: resolved.identity,
    name: clear ? null : name,
    result,
    generated_at: now(),
  });
}

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** herdr agent.start timeout bounds (src/app/agents.rs). */
const START_TIMEOUT_MIN_MS = 3000;
const START_TIMEOUT_MAX_MS = 300000;

async function cmdStart(options: CliOptions): Promise<void> {
  const parsed = parseCommandArgs(
    options.args,
    new Set([
      "--agent",
      "--name",
      "--model",
      "--reasoning",
      "--permission-mode",
      "--resume",
      "--resume-from",
      "--arg",
      "--timeout-ms",
      "--wait-until",
      "--wait-timeout-ms",
    ]),
  );
  const pane = parsed.positionals[0];
  if (!pane || parsed.positionals.length > 1) {
    fail("start requires exactly one <pane_id>", 2);
  }
  const kindRaw = parsed.values.get("--agent");
  if (kindRaw === undefined || kindRaw === "") {
    fail("start requires --agent <kind>", 2);
  }
  const kind = canonicalKind(kindRaw as string);

  const nameRaw = parsed.values.get("--name");
  // Default name keeps launches distinct; herdr enforces uniqueness.
  const name = nameRaw ?? `${kind}-${Math.random().toString(16).slice(2, 6)}`;
  if (!AGENT_NAME_PATTERN.test(name)) {
    fail(`--name must match [a-z][a-z0-9_-]{0,31} (herdr agent name rules), got: ${name}`, 2);
  }

  const permissionModeRaw = parsed.values.get("--permission-mode");
  let permissionMode: PermissionMode | undefined;
  if (permissionModeRaw !== undefined) {
    if (!(PERMISSION_MODES as readonly string[]).includes(permissionModeRaw)) {
      fail(
        `--permission-mode must be one of ${PERMISSION_MODES.join("|")}, got: ${permissionModeRaw}`,
        2,
      );
    }
    permissionMode = permissionModeRaw as PermissionMode;
  }

  // --- Resume value: --resume <value> or --resume-from <agent target> ---
  const resumeRaw = parsed.values.get("--resume");
  const resumeFrom = parsed.values.get("--resume-from");
  if (resumeRaw !== undefined && resumeFrom !== undefined) {
    fail("start accepts at most one of --resume or --resume-from", 2);
  }
  let resumeValue: string | undefined;
  let resumeSessionKind: ResumeSessionKind | null = null;
  let resumeSource: unknown;
  if (resumeRaw !== undefined) {
    resumeValue = resumeRaw;
  } else if (resumeFrom !== undefined) {
    // Resolve the source agent and reuse its reported session ref —
    // the same agent_session signal every other command echoes.
    const source = await resolveGuarded(resumeFrom, options, parsed);
    const session = source.identity.agent_session;
    if (session?.value === undefined) {
      fail(`target ${resumeFrom} has no reported agent_session to resume`, 1, "no_agent_session", {
        identity: source.identity,
      });
    }
    const sessionAgent = session?.agent ?? null;
    if (sessionAgent !== null && sessionAgent !== kind && sessionAgent !== kindRaw) {
      fail(
        `agent_session reports provider '${sessionAgent}', which does not match --agent '${kindRaw}'`,
        1,
        "resume_session_mismatch",
        { identity: source.identity, expected_agent: kindRaw },
      );
    }
    resumeValue = session.value;
    resumeSessionKind = session?.kind === "path" ? "path" : session?.kind === "id" ? "id" : null;
    // The reporting source is not part of the echoed AgentSessionRef
    // contract; read it from the raw agent record for the launch echo.
    const rawSession = source.agent.agent_session as Record<string, unknown> | null | undefined;
    resumeSource = typeof rawSession?.source === "string" ? rawSession.source : null;
  }

  const extraArgs = parsed.multi.get("--arg") ?? [];
  const unsafeArgs = parsed.flags.has("--unsafe-args");

  let built: ReturnType<typeof buildLaunchArgs>;
  try {
    built = buildLaunchArgs({
      kind,
      ...(parsed.values.get("--model") !== undefined
        ? { model: parsed.values.get("--model") as string }
        : {}),
      ...(parsed.values.get("--reasoning") !== undefined
        ? { reasoning: parsed.values.get("--reasoning") as string }
        : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(resumeValue !== undefined ? { resumeValue } : {}),
      resumeSessionKind,
      extraArgs,
      unsafeArgs,
    });
  } catch (err) {
    const e = err as { message?: string; kind?: string; extra?: Record<string, unknown> };
    if (e.kind === "usage") fail(e.message ?? String(err), 2);
    fail(e.message ?? String(err), 1, e.kind ?? "error", e.extra);
  }

  const timeoutRaw = parsed.values.get("--timeout-ms");
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    const value = Number(timeoutRaw);
    if (!Number.isInteger(value) || value <= START_TIMEOUT_MIN_MS || value > START_TIMEOUT_MAX_MS) {
      fail(
        `--timeout-ms must be an integer in (${START_TIMEOUT_MIN_MS}, ${START_TIMEOUT_MAX_MS}], got: ${timeoutRaw}`,
        2,
      );
    }
    timeoutMs = value;
  }

  // Post-launch wait options are validated before agent.start so a
  // usage error never leaves a launched agent behind.
  const waitUntil = parseStatuses(parsed.multi.get("--wait-until"), "--wait-until");
  const waitTimeoutRaw = parsed.values.get("--wait-timeout-ms");
  let waitTimeoutMs: number | undefined;
  if (waitTimeoutRaw !== undefined) {
    const value = Number(waitTimeoutRaw);
    if (!Number.isFinite(value) || value < 0) {
      fail(`--wait-timeout-ms must be a non-negative number, got: ${waitTimeoutRaw}`, 2);
    }
    waitTimeoutMs = value;
  }

  let started: Awaited<ReturnType<typeof agentStart>>;
  try {
    started = await agentStart(
      {
        name,
        kind,
        paneId: pane as string,
        args: built.args,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      options,
    );
  } catch (err) {
    if (isAgentRpcError(err)) fail(err.message, 1, err.code);
    fail(
      `herdr session unreachable: ${err instanceof Error ? err.message : String(err)}`,
      1,
      "session_unreachable",
    );
  }

  const identity = await identityForAgent(started.agent, options);

  // Optional post-launch observation: agent.start already waits for
  // interactive readiness (timeout_ms above); --wait* adds an explicit
  // agent.wait until idle/working with a structured timeout.
  const wantsWait =
    parsed.flags.has("--wait") || waitUntil !== undefined || waitTimeoutMs !== undefined;
  let waitResult: unknown;
  if (wantsWait) {
    try {
      waitResult = await agentWait(
        (identity.pane_id ?? pane) as string,
        {
          until: waitUntil ?? ["idle", "working"],
          ...(waitTimeoutMs !== undefined ? { timeoutMs: waitTimeoutMs } : {}),
        },
        options,
      );
    } catch (err) {
      if (isAgentRpcError(err)) fail(err.message, 1, err.code, { launched: true, identity });
      fail(
        `herdr session unreachable: ${err instanceof Error ? err.message : String(err)}`,
        1,
        "session_unreachable",
        { launched: true, identity },
      );
    }
  }

  emit({
    contract: CONTRACT,
    command: "start",
    identity,
    launch: {
      kind,
      requested_kind: kindRaw,
      name,
      pane_id: pane,
      args: built.args,
      argv: started.argv,
      applied: built.applied,
      ...(resumeSource !== undefined ? { resume_source: resumeSource } : {}),
    },
    ...(wantsWait ? { waited: true, wait: waitResult } : {}),
    generated_at: now(),
  });
}

const USAGE = `rebuildup.controls — agent operation core (herdr-plugins.controls/v1)

Usage: bun run src/cli.ts <command> [args] [--session NAME] [--socket PATH] [--timeout MS]

Commands:
  capability                                  Contract/provider/operation discovery (offline)
  send <target> <text...> [--wait] [--wait-until STATUS]... [--timeout-ms MS]
  command <target> <slash-command> [args...] [--wait] [--wait-until STATUS]... [--timeout-ms MS]
       (provider slash-command passthrough via agent.prompt; fragile, provider-TUI dependent)
  wait <target> [--until STATUS]... [--timeout-ms MS]
  interrupt <target> [--key KEY]... [--keys k1,k2]   (PTY-level keys; default: esc)
  read <target> [--source visible|recent|recent-unwrapped|detection] [--lines N] [--format text|ansi] [--no-strip-ansi]
  rename <target> (--name NAME | --clear)
  start <pane_id> --agent <kind> [--name NAME] [--model M] [--reasoning L]
       [--permission-mode supervised|auto-accept-edits|auto|full-access]
       [--resume SESSION | --resume-from TARGET] [--arg ARG]... [--unsafe-args]
       [--timeout-ms MS] [--wait] [--wait-until STATUS]... [--wait-timeout-ms MS]

Identity guards (all agent-target commands): --expect-pane ID --expect-state-seq N --expect-agent-session VALUE
  Any mismatch aborts with stale_generation before the agent.* call.

Errors: {contract, ok:false, error:{code,message,kind?}} on stderr; exit 1 handled, 2 usage.`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "capability":
      return cmdCapability();
    case "send":
      return cmdSend(options);
    case "command":
      return cmdCommand(options);
    case "wait":
      return cmdWait(options);
    case "interrupt":
      return cmdInterrupt(options);
    case "read":
      return cmdRead(options);
    case "rename":
      return cmdRename(options);
    case "start":
      return cmdStart(options);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${USAGE}\n`);
      return;
    default:
      fail(`unknown command: ${options.command}\n\n${USAGE}`, 2);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `${JSON.stringify({
        contract: CONTRACT,
        ok: false,
        error: { code: "error", message: String(err) },
      })}\n`,
    );
    process.exit(1);
  });
}
