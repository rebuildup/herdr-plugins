/**
 * Cross-machine handoff transport for `rebuildup.handoff` (#105, parent
 * #6 T3).
 *
 * Remote verdict (measured against herdr 0.9.5, protocol 22):
 *
 * - `herdr --remote <ssh-target>` is an interactive TUI attach path only —
 *   it cannot drive `agent.start`/`agent.prompt` headlessly.
 * - `server.ssh_agent.register` forwards the LOCAL ssh-agent socket into a
 *   remote session for agent CLIs; it is not a remote control surface.
 * - Saved machines ARE a programmatic remote path: `herdr machine list
 *   --json` enumerates profiles, and `herdr --machine <label-or-id>
 *   <command>` routes any CLI subcommand through an SSH bridge to the
 *   remote host's `herdr remote-api-bridge`, which forwards the remote
 *   API socket. Every API-backed CLI command (`api snapshot`,
 *   `workspace create`, `tab create`, `agent start|get|prompt|wait`,
 *   `pane close`, …) therefore works against the remote session and
 *   prints the same `{id, result|error}` JSON envelope as local calls.
 *
 * This module wraps that path: machine discovery/resolution, a
 * capability probe, a `HandoffTransport` implementation that shells out
 * per call (each invocation re-establishes the SSH bridge — correct but
 * not free), and the portable bundle writer. No Agent Router involvement
 * (ADR-0017); no socket-protocol reimplementation — the plugin speaks
 * only the official `herdr` CLI.
 */

import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentGetResult,
  AgentStartOptions,
  AgentStatus,
  PaneInfo,
  SessionSnapshot,
  TabCreatedResult,
  WorkspaceCreatedResult,
} from "../../../packages/herdr-client/src/index";
import { pluginDirs } from "../../../packages/herdr-client/src/index";
import type {
  HandoffTransport,
  SurfaceCreateParams,
  WorktreeCreatedResult,
  WorktreeCreateParams,
} from "./execute";
import type { HandoffRecord, RemoteExecutionInfo } from "./model";
import { PLUGIN_ID } from "./model";

// --- Errors -----------------------------------------------------------------

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// --- Process runner (injectable for tests) ------------------------------------

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the runner killed the child at its timeout. */
  timedOut: boolean;
}

export type HerdrRunner = (args: string[], options: { timeoutMs: number }) => Promise<RunResult>;

/** Ambient herdr vars that must never leak into remote CLI children. */
const STRIPPED_ENV = new Set([
  "HERDR_SOCKET_PATH",
  "HERDR_CLIENT_SOCKET_PATH",
  "HERDR_PANE_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_SESSION",
]);

/** Default `herdr` binary; HERDR_BIN_PATH overrides (test/dev hook). */
export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

/**
 * Spawn the local `herdr` CLI. Each remote call is a fresh process: the
 * `--machine` bridge lifetime is bound to the CLI invocation upstream.
 */
export const spawnHerdr: HerdrRunner = (args, options) =>
  new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || STRIPPED_ENV.has(key)) continue;
      env[key] = value;
    }
    const child = spawn(herdrBin(), args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: null, stdout, stderr: `${stderr}${String(err)}`, timedOut });
    });
    child.on("close", (code, signal) => {
      // Node reports SIGTERM kills via `signal`; treat as timeout when the
      // runner's own timeout fired (spawn `timeout` sends SIGTERM).
      timedOut = signal === "SIGTERM";
      resolve({ code, stdout, stderr, timedOut });
    });
  });

// --- Envelope parsing ---------------------------------------------------------

interface CliEnvelope {
  id?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

/** Extract the last JSON envelope line from stdout (or stderr for errors). */
function parseEnvelope(run: RunResult): CliEnvelope {
  for (const text of [run.stdout, run.stderr]) {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{") && l.endsWith("}"));
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i] as string) as CliEnvelope;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          ("result" in parsed || "error" in parsed)
        ) {
          return parsed;
        }
      } catch {
        /* not JSON */
      }
    }
  }
  return {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Run a remote CLI command and return its `result` payload. Throws
 * RemoteError on transport failure, nonzero exit, or an `{error}`
 * envelope — the remote server's own error code/message is preserved.
 */
async function runRemote(
  runner: HerdrRunner,
  selector: string,
  cliArgs: string[],
  timeoutMs: number,
): Promise<unknown> {
  const args = ["--machine", selector, ...cliArgs];
  const run = await runner(args, { timeoutMs });
  if (run.timedOut) {
    throw new RemoteError(
      `herdr --machine ${selector} ${cliArgs.join(" ")} timed out after ${timeoutMs}ms`,
      "remote_timeout",
      { args },
    );
  }
  const envelope = parseEnvelope(run);
  if (envelope.error !== undefined) {
    const code = typeof envelope.error.code === "string" ? envelope.error.code : "remote_error";
    const message =
      typeof envelope.error.message === "string" ? envelope.error.message : "remote command failed";
    throw new RemoteError(`${code}: ${message}`, `remote_${code}`, { code, message });
  }
  if (run.code !== 0) {
    const detail = (run.stderr || run.stdout).trim().slice(0, 400);
    throw new RemoteError(
      `herdr --machine ${selector} exited ${run.code ?? "?"}: ${detail || "no output"}`,
      "remote_command_failed",
      { exit_code: run.code, stderr: run.stderr.slice(0, 2000) },
    );
  }
  if (!("result" in envelope)) {
    throw new RemoteError(
      `herdr --machine ${selector} returned no result envelope: ${(run.stdout || run.stderr).slice(0, 300)}`,
      "remote_malformed",
    );
  }
  return envelope.result;
}

// --- Saved machines ------------------------------------------------------------

export interface SavedMachine {
  id: string;
  label: string;
  /** SSH target (host alias / user@host). */
  target: string;
  /** Remote herdr session name bound to the profile. */
  session: string;
  enabled: boolean;
}

export const DEFAULT_CALL_TIMEOUT_MS = 45_000;
/** Client ceiling added on top of server-side waits (mirrors execute.ts). */
const CLIENT_MARGIN_MS = 30_000;

export async function listMachines(runner: HerdrRunner = spawnHerdr): Promise<SavedMachine[]> {
  const run = await runner(["machine", "list", "--json"], { timeoutMs: DEFAULT_CALL_TIMEOUT_MS });
  if (run.code !== 0) {
    throw new RemoteError(
      `herdr machine list failed: ${(run.stderr || run.stdout).trim().slice(0, 300)}`,
      "machine_list_failed",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    throw new RemoteError(
      "herdr machine list --json returned non-JSON output",
      "machine_list_failed",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new RemoteError("herdr machine list --json returned a non-array", "machine_list_failed");
  }
  const machines: SavedMachine[] = [];
  for (const entry of parsed) {
    const e = asRecord(entry);
    if (typeof e.id !== "string" || typeof e.target !== "string") continue;
    machines.push({
      id: e.id,
      label: typeof e.label === "string" ? e.label : e.id,
      target: e.target,
      session: typeof e.session === "string" ? e.session : "default",
      enabled: e.enabled !== false,
    });
  }
  return machines;
}

/**
 * Resolve a `--remote` selector (machine id or label) against the saved
 * machine list. Labels match case-insensitively; ids match exactly.
 */
export function resolveMachine(selector: string, machines: SavedMachine[]): SavedMachine {
  const byId = machines.find((m) => m.id === selector);
  if (byId !== undefined) return byId;
  const lower = selector.toLowerCase();
  const byLabel = machines.filter((m) => m.label.toLowerCase() === lower);
  if (byLabel.length === 1) return byLabel[0] as SavedMachine;
  if (byLabel.length > 1) {
    throw new RemoteError(
      `remote selector "${selector}" matches multiple machines; use the machine id`,
      "machine_ambiguous",
      { matches: byLabel.map((m) => m.id) },
    );
  }
  throw new RemoteError(
    `unknown remote machine "${selector}"; run \`handoff remote-probe\` to list saved machines`,
    "machine_not_found",
    { selector },
  );
}

// --- Capability probe -----------------------------------------------------------

export interface RemoteProbe {
  machine: SavedMachine;
  /** Remote `session.snapshot` payload (agents normalized to a map). */
  snapshot: SessionSnapshot;
  server_version: string | null;
  protocol: number | null;
}

/**
 * Probe a saved machine: resolve the selector, then fetch the remote
 * `session.snapshot` through `herdr --machine <sel> api snapshot`.
 * Any failure is classified — unreachable host, disabled machine, old
 * herdr without `remote-api-bridge`, or malformed output — and thrown
 * as RemoteError; success is never assumed.
 */
export async function probeRemote(
  selector: string,
  deps: { runner?: HerdrRunner; machines?: SavedMachine[] } = {},
): Promise<RemoteProbe> {
  const runner = deps.runner ?? spawnHerdr;
  const machines = deps.machines ?? (await listMachines(runner));
  const machine = resolveMachine(selector, machines);
  if (!machine.enabled) {
    throw new RemoteError(
      `remote machine "${machine.label}" is disabled; enable it with \`herdr machine enable ${machine.id}\``,
      "machine_disabled",
      { machine_id: machine.id },
    );
  }
  let result: unknown;
  try {
    result = await runRemote(runner, machine.id, ["api", "snapshot"], DEFAULT_CALL_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof RemoteError) {
      // A missing remote-api-bridge surfaces as a remote-side failure;
      // reclassify known herdr capability gaps honestly.
      if (/remote-api-bridge|machine API forwarding|does not support/i.test(err.message)) {
        throw new RemoteError(
          `remote machine "${machine.label}" runs a herdr without machine API forwarding (needs remote-api-bridge, herdr ≥ the version that introduced it); upgrade herdr on ${machine.target}`,
          "unsupported_remote",
          { machine_id: machine.id, cause: err.message },
        );
      }
      if (err.kind === "remote_command_failed" || err.kind === "remote_timeout") {
        throw new RemoteError(
          `remote machine "${machine.label}" (${machine.target}) unreachable: ${err.message}`,
          "remote_unreachable",
          { machine_id: machine.id, cause: err.message },
        );
      }
    }
    throw err;
  }
  const record = asRecord(result);
  const rawSnapshot = asRecord(record.snapshot ?? result);
  const snapshot = normalizeSnapshot(rawSnapshot);
  const version = typeof rawSnapshot.version === "string" ? rawSnapshot.version : null;
  const protocol = typeof rawSnapshot.protocol === "number" ? rawSnapshot.protocol : null;
  return { machine, snapshot, server_version: version, protocol };
}

/** `session.snapshot` normalizes `agents` array → pane_id map (same as herdr-client). */
function normalizeSnapshot(raw: Record<string, unknown>): SessionSnapshot {
  const snapshot = raw as unknown as SessionSnapshot;
  if (Array.isArray(snapshot.agents)) {
    const map: Record<string, AgentGetResult> = {};
    for (const agent of snapshot.agents as unknown as Array<
      AgentGetResult & { pane_id?: string }
    >) {
      if (typeof agent?.pane_id === "string") map[agent.pane_id] = agent;
    }
    snapshot.agents = map;
  }
  return snapshot;
}

export function remoteInfoOf(probe: RemoteProbe): RemoteExecutionInfo {
  return {
    machine_id: probe.machine.id,
    label: probe.machine.label,
    target: probe.machine.target,
    session: probe.machine.session,
    enabled: probe.machine.enabled,
    probed_at: new Date().toISOString(),
    server_version: probe.server_version,
    protocol: probe.protocol,
  };
}

// --- CLI-backed remote transport -------------------------------------------------

function surfaceArgs(params: SurfaceCreateParams): string[] {
  const args: string[] = [];
  if (params.cwd !== undefined) args.push("--cwd", params.cwd);
  if (params.label !== undefined) args.push("--label", params.label);
  if (params.focus === true) args.push("--focus");
  else if (params.focus === false) args.push("--no-focus");
  return args;
}

/**
 * `HandoffTransport` over `herdr --machine <id> <cli>`. Each method maps
 * to the official CLI subcommand that wraps the same socket-API method;
 * result envelopes are unwrapped with the same tolerant shapes as
 * packages/herdr-client. Every call re-opens the SSH bridge — slow but
 * stateless and honest.
 */
export function remoteCliTransport(
  machine: SavedMachine,
  deps: { runner?: HerdrRunner } = {},
): HandoffTransport {
  const runner = deps.runner ?? spawnHerdr;
  const sel = machine.id;
  const call = (cliArgs: string[], timeoutMs = DEFAULT_CALL_TIMEOUT_MS) =>
    runRemote(runner, sel, cliArgs, timeoutMs);

  return {
    async snapshot(): Promise<SessionSnapshot> {
      const result = asRecord(await call(["api", "snapshot"]));
      return normalizeSnapshot(asRecord(result.snapshot ?? result));
    },

    async workspaceCreate(params: SurfaceCreateParams): Promise<WorkspaceCreatedResult> {
      const result = asRecord(await call(["workspace", "create", ...surfaceArgs(params)]));
      return {
        type: "workspace_created",
        workspace: asRecord(result.workspace),
        tab: asRecord(result.tab),
        root_pane: asRecord(result.root_pane) as unknown as PaneInfo,
      } as unknown as WorkspaceCreatedResult;
    },

    async tabCreate(
      params: SurfaceCreateParams & { workspace_id?: string | undefined },
    ): Promise<TabCreatedResult> {
      const args = ["tab", "create"];
      if (params.workspace_id !== undefined) args.push("--workspace", params.workspace_id);
      args.push(...surfaceArgs(params));
      const result = asRecord(await call(args));
      return {
        type: "tab_created",
        tab: asRecord(result.tab),
        root_pane: asRecord(result.root_pane) as unknown as PaneInfo,
      } as unknown as TabCreatedResult;
    },

    async agentStart(params: AgentStartOptions): Promise<unknown> {
      const args = ["agent", "start", params.name, "--kind", params.kind, "--pane", params.paneId];
      if (params.timeoutMs !== undefined) args.push("--timeout", String(params.timeoutMs));
      if (params.args !== undefined && params.args.length > 0) args.push("--", ...params.args);
      const clientTimeout =
        (params.timeoutMs ?? 30_000) + CLIENT_MARGIN_MS + DEFAULT_CALL_TIMEOUT_MS;
      const result = asRecord(await call(args, clientTimeout));
      // Tolerant unwrap mirrors agents.ts: `{type:"agent_started",agent,argv}`.
      const inner = asRecord(result.agent_started ?? result);
      return { agent: inner.agent ?? result.agent, argv: inner.argv ?? [] };
    },

    async agentGet(target: string): Promise<AgentGetResult> {
      const result = asRecord(await call(["agent", "get", target]));
      return asRecord(result.agent ?? result) as unknown as AgentGetResult;
    },

    async agentPrompt(
      target: string,
      text: string,
      wait?: { until?: AgentStatus[] | undefined; timeoutMs?: number | undefined },
      timeoutMs?: number,
    ): Promise<unknown> {
      const args = ["agent", "prompt", target, text];
      if (wait?.until !== undefined) {
        for (const status of wait.until) args.push("--until", status);
      }
      if (wait?.timeoutMs !== undefined) args.push("--timeout", String(wait.timeoutMs));
      // wait implies --wait upstream; without it the CLI submits only.
      if (wait !== undefined) args.splice(3, 0, "--wait");
      return call(args, timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    },

    async agentWait(
      target: string,
      params: { until?: AgentStatus[] | undefined; timeoutMs?: number | undefined },
      timeoutMs?: number,
    ): Promise<unknown> {
      const args = ["agent", "wait", target];
      if (params.until !== undefined) {
        for (const status of params.until) args.push("--until", status);
      }
      if (params.timeoutMs !== undefined) args.push("--timeout", String(params.timeoutMs));
      const clientTimeout =
        timeoutMs ?? (params.timeoutMs ?? 0) + CLIENT_MARGIN_MS + DEFAULT_CALL_TIMEOUT_MS;
      return call(args, clientTimeout);
    },

    async paneClose(paneId: string): Promise<unknown> {
      return call(["pane", "close", paneId]);
    },

    async worktreeCreate(params: WorktreeCreateParams): Promise<WorktreeCreatedResult> {
      const args = ["worktree", "create"];
      if (params.cwd !== undefined) args.push("--cwd", params.cwd);
      if (params.label !== undefined) args.push("--label", params.label);
      if (params.branch !== undefined) args.push("--branch", params.branch);
      if (params.base !== undefined) args.push("--base", params.base);
      if (params.path !== undefined) args.push("--path", params.path);
      if (params.focus === true) args.push("--focus");
      else if (params.focus === false) args.push("--no-focus");
      const result = asRecord(await call(args));
      return {
        type: "worktree_created",
        workspace: result.workspace,
        tab: result.tab,
        root_pane: asRecord(result.root_pane) as unknown as PaneInfo,
        worktree: asRecord(result.worktree),
      } as unknown as WorktreeCreatedResult;
    },
  };
}

// --- Portable bundle -------------------------------------------------------------

export const BUNDLE_CONTRACT = "herdr-plugins.handoff/bundle/v1";

export interface BundleRefEntry {
  ref: HandoffRecord["payload"]["refs"][number];
  /**
   * `plugin_state` refs resolve against rebuildup.* plugin state on the
   * SOURCE host only — the remote host has no access unless the same
   * plugins+state exist there. `external` refs carry their value inline.
   */
  portability: "plugin_state" | "external";
  resolvable_on_remote: boolean;
}

export interface PortableBundle {
  contract: typeof BUNDLE_CONTRACT;
  generated_at: string;
  generator: typeof PLUGIN_ID;
  handoff_id: string;
  remote: RemoteExecutionInfo;
  source: HandoffRecord["transfer"];
  strategy: HandoffRecord["strategy"];
  target_hint: HandoffRecord["target"];
  payload: {
    refs: BundleRefEntry[];
    excerpt: HandoffRecord["payload"]["excerpt"] | null;
    requirements: string[];
  };
  /** Human/agent-facing transfer instructions. */
  instructions: string[];
}

/**
 * Build the portable bundle for a cross-machine handoff. The payload is
 * already references + bounded excerpt; the bundle makes portability
 * explicit: plugin-state refs are marked `plugin_state` /
 * `resolvable_on_remote: false` (they are external_ref on the remote
 * host), external refs keep their inline value, and the excerpt +
 * requirements travel inline. No transcript copies, no fabricated
 * remote resolution.
 */
export function buildPortableBundle(
  record: HandoffRecord,
  remote: RemoteExecutionInfo,
  now: Date = new Date(),
): PortableBundle {
  const refs: BundleRefEntry[] = record.payload.refs.map((ref) => ({
    ref,
    portability: ref.kind === "external" ? "external" : "plugin_state",
    resolvable_on_remote: ref.kind === "external",
  }));
  const pluginStateRefs = refs.filter((r) => r.portability === "plugin_state").length;
  const instructions = [
    `Handoff ${record.id} was transferred to remote herdr machine "${remote.label}" (${remote.target}, session ${remote.session}).`,
    "Source identity (host/session/workspace/pane/agent_session/state_change_seq) is recorded under `source`; it describes the ORIGIN agent, not this session.",
    "Payload refs of portability `plugin_state` name objects in rebuildup.* plugin state on the SOURCE host; treat them as external_ref here — do not assume the owning plugins or their state exist on this host.",
    "The bounded excerpt and requirements under `payload` are the inline context for this transfer; resolve external refs on demand.",
    ...(pluginStateRefs > 0
      ? [
          `${pluginStateRefs} plugin_state ref(s) cannot be resolved on the remote host; if their content is required, re-create equivalent refs locally or ask the operator to transfer the underlying objects.`,
        ]
      : []),
  ];
  return {
    contract: BUNDLE_CONTRACT,
    generated_at: now.toISOString(),
    generator: PLUGIN_ID,
    handoff_id: record.id,
    remote,
    source: record.transfer,
    strategy: record.strategy,
    target_hint: record.target,
    payload: {
      refs,
      excerpt: record.payload.excerpt ?? null,
      requirements: record.payload.requirements ?? [],
    },
    instructions,
  };
}

export function bundleFilePath(handoffId: string): string {
  return path.join(pluginDirs(PLUGIN_ID).stateDir, "bundles", `${handoffId}.json`);
}

/** Atomic tmp+rename write, same discipline as state.ts. */
export async function writeBundle(bundle: PortableBundle, handoffId: string): Promise<string> {
  const file = bundleFilePath(handoffId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(bundle, null, 2)}\n`);
  await rename(tmp, file);
  return file;
}
