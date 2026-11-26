/**
 * rebuildup.artifacts CLI — artifact registry contract
 * (`herdr-plugins.artifacts/v1`, STABLE) for agents and external
 * clients. Single JSON document on stdout; diagnostics on stderr.
 * Exit 0 success, 1 handled error, 2 usage.
 *
 * T1 (#136) shipped `capability`/`help`; T2 (#141) implements the
 * registry core: `register` (state_copy default / opt-in path_ref),
 * `list`, `get`, `search`, `delete`; T3 (#142) adds kind-specific
 * validation, richer search filters, and `verify` (integrity
 * re-check); T4 (#143) adds `deliver` (v1 path-in-prompt-text
 * attachment via agent.prompt/pane.send_text), `gc` (age-based
 * retention, dry-run), `export` (complete client read surface), and
 * stabilizes contract `herdr-plugins.artifacts/v1`.
 *
 * Registry commands resolve the live session via `session.snapshot`
 * for host/session/owner identity and owner_stale reporting; an
 * unreachable session fails with `session_unreachable` (contract
 * error model). The plugin never executes or renders artifact content
 * (ADR-0024 §4); render-time sandbox/CSP is a herdr-t3 requirement.
 */

import os from "node:os";
import {
  type CallOptions,
  type SessionSnapshot,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import {
  ARTIFACT_ID_PATTERN,
  ARTIFACT_KINDS,
  type ArtifactKind,
  CONTRACT,
  CONTRACT_STATUS,
  CREATED_BY,
  type CreatedBy,
  IMPLEMENTED_COMMANDS,
  MAX_BYTES,
  PLANNED_COMMANDS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  STORAGE_MODES,
  type StorageMode,
} from "./model";
import {
  agentSessionForPane,
  deleteArtifact,
  deliverArtifact,
  gcArtifacts,
  getArtifact,
  listArtifacts,
  RegistryError,
  registerArtifact,
  searchArtifacts,
  verifyArtifacts,
} from "./registry";

interface CliOptions extends CallOptions {
  command: string;
  /** Positional args plus per-command `--flag value` pairs, in order. */
  args: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const command = args.shift() ?? "";
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

interface FlagSpec {
  /** Flags that consume a value. */
  valued?: readonly string[];
  /** Boolean flags (no value). */
  boolean?: readonly string[];
  /** Valued flags that may repeat (last wins unless listed here). */
  multi?: readonly string[];
}

interface ParsedFlags {
  positionals: string[];
  flags: Map<string, string | true>;
  multi: Map<string, string[]>;
}

/** Minimal `--flag value` / `--flag` parser; unknown `--x` is a usage error. */
function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const valued = new Set(spec.valued ?? []);
  const boolean = new Set(spec.boolean ?? []);
  const multi = new Set(spec.multi ?? []);
  const flags = new Map<string, string | true>();
  const multiMap = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (boolean.has(name)) {
        flags.set(name, true);
      } else if (valued.has(name)) {
        const value = args[++i];
        if (value === undefined) usageFail(`missing value for --${name}`);
        if (multi.has(name)) {
          const list = multiMap.get(name) ?? [];
          list.push(value);
          multiMap.set(name, list);
        } else {
          flags.set(name, value);
        }
      } else {
        usageFail(`unknown flag: ${arg}`);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags, multi: multiMap };
}

function flagValue(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagInt(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = flagValue(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    usageFail(`--${name} must be a non-negative integer`);
  }
  return value;
}

/** ISO-8601 filter bound; invalid input is a usage error, not silent. */
function flagIso(flags: Map<string, string | true>, name: string): string | undefined {
  const raw = flagValue(flags, name);
  if (raw === undefined) return undefined;
  if (Number.isNaN(Date.parse(raw))) {
    usageFail(`--${name} must be an ISO-8601 timestamp`);
  }
  return raw;
}

function usageFail(message: string): never {
  fail(message, 2);
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

function cmdCapability(): void {
  emit({
    contract: CONTRACT,
    contract_status: CONTRACT_STATUS,
    command: "capability",
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    read_only: false,
    mutation_commands: ["register", "delete", "deliver", "gc"],
    commands: [...IMPLEMENTED_COMMANDS, ...PLANNED_COMMANDS],
    implemented_commands: [...IMPLEMENTED_COMMANDS],
    planned_commands: [...PLANNED_COMMANDS],
    kinds: [...ARTIFACT_KINDS],
    storage_modes: [...STORAGE_MODES],
    artifact_id_pattern: ARTIFACT_ID_PATTERN.source,
    limits: {
      max_bytes: MAX_BYTES,
      path_ref_oversize: "warn",
    },
    notes: [
      "Contract herdr-plugins.artifacts/v1 is STABLE (T4 #143): register/list/get/search/verify/delete/deliver/gc/export are all implemented; additive changes only from here.",
      "Plugin never executes or renders artifact content; render-time sandbox/CSP/network isolation is a herdr-t3 requirement (ADR-0024, docs/contracts/artifacts-v1.md).",
      "state_copy (default) enforces per-kind caps at register; path_ref records oversize as a warning flag and reports vanished targets as missing_ref.",
      "kind validation: html refuses non-.html/.htm path names and non-document leading bytes (upstream HtmlRender rules); image/pdf/file/other report mime_mismatch / extension_mime_mismatch warnings instead of refusing.",
      "verify re-checks payload existence, sha256, size, mime, and metadata consistency; per-artifact status is ok|corrupt|missing (honest report, exit 0).",
      "deliver sends the artifact's stable absolute path inside agent.prompt (--agent) or pane.send_text (--pane) text; stale panes/agents and missing payloads are refused, upstream RPC codes surface as delivery_failed.rpc_code.",
      "gc collects only unreferenced records older than --older-than; refs-carrying artifacts are skipped (referenced), --dry-run previews, path_ref external files are never deleted.",
      "export emits the complete annotated index for client sync (herdr-t3 read surface); metadata + resolved_path only, never payload bytes.",
      "Registry commands resolve the live session via session.snapshot; unreachable session fails with session_unreachable. gc is pure plugin-state work and needs no session.",
      "v1 attachment delivery is the artifact's stable absolute path inside agent.prompt/pane.send_text text; no structured attachment API exists in herdr protocol 22 (upstream gap candidate, ADR-0024).",
      "SnapShots (OS capture), browser import, and MCP Apps UI are out of plugin scope: herdr-t3/desktop or upstream-blocked on #30 (ADR-0024 section 5).",
    ],
    generated_at: now(),
  });
}

async function snapshotOrFail(options: CallOptions): Promise<SessionSnapshot> {
  try {
    return await sessionSnapshot(options);
  } catch (err) {
    fail(
      `herdr session unreachable: ${err instanceof Error ? err.message : String(err)}`,
      1,
      "session_unreachable",
    );
  }
}

function sessionName(snapshot: SessionSnapshot, options: CallOptions): string {
  const name = snapshot.session?.name;
  if (typeof name === "string" && name !== "") return name;
  return options.session ?? process.env.HERDR_SESSION ?? "default";
}

function parseKind(raw: string | undefined): ArtifactKind | undefined {
  if (raw === undefined) return undefined;
  if (!(ARTIFACT_KINDS as readonly string[]).includes(raw)) {
    usageFail(`--kind must be one of: ${ARTIFACT_KINDS.join(", ")}`);
  }
  return raw as ArtifactKind;
}

function parseStorage(raw: string | undefined): StorageMode | undefined {
  if (raw === undefined) return undefined;
  if (!(STORAGE_MODES as readonly string[]).includes(raw)) {
    usageFail(`--storage must be one of: ${STORAGE_MODES.join(", ")}`);
  }
  return raw as StorageMode;
}

function parseCreatedBy(raw: string | undefined): CreatedBy | undefined {
  if (raw === undefined) return undefined;
  if (!(CREATED_BY as readonly string[]).includes(raw)) {
    usageFail(`--created-by must be one of: ${CREATED_BY.join(", ")}`);
  }
  return raw as CreatedBy;
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function cmdRegister(options: CliOptions): Promise<void> {
  const parsed = parseFlags(options.args, {
    valued: ["path", "kind", "storage", "title", "pane", "created-by", "ref"],
    boolean: ["stdin"],
    multi: ["ref"],
  });
  if (parsed.positionals.length > 0) usageFail(`unexpected argument: ${parsed.positionals[0]}`);
  const pathValue = flagValue(parsed.flags, "path");
  const useStdin = parsed.flags.get("stdin") === true || pathValue === "-";
  if (useStdin && pathValue !== undefined && pathValue !== "-") {
    usageFail("--stdin cannot be combined with --path");
  }
  if (!useStdin && pathValue === undefined) {
    usageFail("register requires --path FILE or --stdin");
  }
  const snapshot = await snapshotOrFail(options);
  const paneId = flagValue(parsed.flags, "pane");
  const record = await registerArtifact({
    sourcePath: useStdin ? undefined : pathValue,
    bytes: useStdin ? await readStdin() : undefined,
    kind: parseKind(flagValue(parsed.flags, "kind")),
    storage: parseStorage(flagValue(parsed.flags, "storage")),
    title: flagValue(parsed.flags, "title"),
    paneId,
    agentSession: paneId !== undefined ? agentSessionForPane(snapshot, paneId) : undefined,
    createdBy: parseCreatedBy(flagValue(parsed.flags, "created-by")),
    refs: parsed.multi.get("ref"),
    host: os.hostname(),
    session: sessionName(snapshot, options),
  });
  emit({
    contract: CONTRACT,
    ok: true,
    command: "register",
    artifact: record,
    generated_at: now(),
  });
}

async function cmdList(options: CliOptions): Promise<void> {
  const parsed = parseFlags(options.args, {
    valued: ["kind", "pane", "agent", "created-by", "session", "limit"],
  });
  if (parsed.positionals.length > 0) usageFail(`unexpected argument: ${parsed.positionals[0]}`);
  const snapshot = await snapshotOrFail(options);
  const result = await listArtifacts({
    kind: parseKind(flagValue(parsed.flags, "kind")),
    paneId: flagValue(parsed.flags, "pane"),
    agentSession: flagValue(parsed.flags, "agent"),
    createdBy: parseCreatedBy(flagValue(parsed.flags, "created-by")),
    session: flagValue(parsed.flags, "session"),
    limit: flagInt(parsed.flags, "limit"),
    snapshot,
  });
  emit({
    contract: CONTRACT,
    ok: true,
    command: "list",
    session: sessionName(snapshot, options),
    ...result,
    generated_at: now(),
  });
}

async function cmdGet(options: CliOptions): Promise<void> {
  const parsed = parseFlags(options.args, {});
  const id = parsed.positionals[0];
  if (id === undefined || parsed.positionals.length !== 1) {
    usageFail("get requires exactly one artifact_id");
  }
  const snapshot = await snapshotOrFail(options);
  const artifact = await getArtifact(id, snapshot);
  emit({
    contract: CONTRACT,
    ok: true,
    command: "get",
    session: sessionName(snapshot, options),
    artifact,
    generated_at: now(),
  });
}

async function cmdSearch(options: CliOptions): Promise<void> {
  const parsed = parseFlags(options.args, {
    valued: ["kind", "pane", "agent", "created-by", "session", "since", "until", "limit"],
  });
  const query = parsed.positionals[0];
  if (query === undefined || parsed.positionals.length !== 1) {
    usageFail("search requires exactly one query");
  }
  const snapshot = await snapshotOrFail(options);
  const result = await searchArtifacts({
    query,
    kind: parseKind(flagValue(parsed.flags, "kind")),
    paneId: flagValue(parsed.flags, "pane"),
    agentSession: flagValue(parsed.flags, "agent"),
    createdBy: parseCreatedBy(flagValue(parsed.flags, "created-by")),
    session: flagValue(parsed.flags, "session"),
    since: flagIso(parsed.flags, "since"),
    until: flagIso(parsed.flags, "until"),
    limit: flagInt(parsed.flags, "limit"),
    snapshot,
  });
  emit({
    contract: CONTRACT,
    ok: true,
    command: "search",
    session: sessionName(snapshot, options),
    ...result,
    generated_at: now(),
  });
}

async function cmdVerify(options: CliOptions): Promise<void> {
  const parsed = parseFlags(options.args, {});
  const id = parsed.positionals[0];
  if (parsed.positionals.length > 1) {
    usageFail("verify accepts at most one artifact_id");
  }
  const snapshot = await snapshotOrFail(options);
  const result = await verifyArtifacts({ artifactId: id, snapshot });
  emit({
    contract: CONTRACT,
    ok: true,
    command: "verify",
    session: sessionName(snapshot, options),
    ...result,
    generated_at: now(),
  });
}

async function cmdDelete(options: CliOptions): Promise<void> {
  const parsed = parseFlags(options.args, { boolean: ["force"] });
  const id = parsed.positionals[0];
  if (id === undefined || parsed.positionals.length !== 1) {
    usageFail("delete requires exactly one artifact_id");
  }
  const snapshot = await snapshotOrFail(options);
  const result = await deleteArtifact(id, parsed.flags.get("force") === true);
  emit({
    contract: CONTRACT,
    ok: true,
    command: "delete",
    session: sessionName(snapshot, options),
    ...result,
    generated_at: now(),
  });
}

async function cmdDeliver(options: CliOptions): Promise<void> {
  const parsed = parseFlags(options.args, {
    valued: ["pane", "agent", "note"],
  });
  const paneId = flagValue(parsed.flags, "pane");
  const agentPaneId = flagValue(parsed.flags, "agent");
  if ((paneId === undefined) === (agentPaneId === undefined)) {
    usageFail("deliver requires exactly one of --pane PANE or --agent PANE");
  }
  const id = parsed.positionals[0];
  if (id === undefined || parsed.positionals.length !== 1) {
    usageFail("deliver requires exactly one artifact_id");
  }
  const snapshot = await snapshotOrFail(options);
  const result = await deliverArtifact({
    artifactId: id,
    target: {
      kind: paneId !== undefined ? "pane" : "agent",
      paneId: (paneId ?? agentPaneId) as string,
    },
    note: flagValue(parsed.flags, "note"),
    snapshot,
    callOptions: options,
  });
  emit({
    contract: CONTRACT,
    ok: true,
    command: "deliver",
    session: sessionName(snapshot, options),
    ...result,
    generated_at: now(),
  });
}

async function cmdGc(options: CliOptions): Promise<void> {
  const parsed = parseFlags(options.args, {
    valued: ["older-than"],
    boolean: ["dry-run"],
  });
  if (parsed.positionals.length > 0) usageFail(`unexpected argument: ${parsed.positionals[0]}`);
  const olderThan = flagIso(parsed.flags, "older-than");
  if (olderThan === undefined) usageFail("gc requires --older-than ISO-8601");
  // gc is pure plugin-state work: no session.snapshot, works offline.
  const result = await gcArtifacts({
    olderThan,
    dryRun: parsed.flags.get("dry-run") === true,
  });
  emit({
    contract: CONTRACT,
    ok: true,
    command: "gc",
    ...result,
    generated_at: now(),
  });
}

async function cmdExport(options: CliOptions): Promise<void> {
  const parsed = parseFlags(options.args, {
    valued: ["kind", "pane", "agent", "created-by", "session", "limit"],
  });
  if (parsed.positionals.length > 0) usageFail(`unexpected argument: ${parsed.positionals[0]}`);
  const snapshot = await snapshotOrFail(options);
  // Export is the complete client read surface: no default page cap —
  // --limit N truncates honestly and `complete` reports the truncation.
  const limit = flagInt(parsed.flags, "limit") ?? 0;
  const filters = {
    kind: parseKind(flagValue(parsed.flags, "kind")),
    paneId: flagValue(parsed.flags, "pane"),
    agentSession: flagValue(parsed.flags, "agent"),
    createdBy: parseCreatedBy(flagValue(parsed.flags, "created-by")),
    session: flagValue(parsed.flags, "session"),
  };
  const result = await listArtifacts({ ...filters, limit, snapshot });
  emit({
    contract: CONTRACT,
    ok: true,
    command: "export",
    session: sessionName(snapshot, options),
    artifacts: result.artifacts,
    total: result.total,
    returned: result.artifacts.length,
    complete: result.artifacts.length >= result.total,
    filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined)),
    orphans: result.orphans,
    corrupt: result.corrupt,
    generated_at: now(),
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "capability":
      cmdCapability();
      return;
    case "help":
    case "--help":
    case "-h":
      emit({
        contract: CONTRACT,
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        usage:
          "bun run src/cli.ts <capability|help|register|list|get|search|verify|delete|deliver|gc|export> " +
          `— planned: ${PLANNED_COMMANDS.join("|") || "none"}`,
      });
      return;
    case "register":
      await cmdRegister(options);
      return;
    case "list":
      await cmdList(options);
      return;
    case "get":
      await cmdGet(options);
      return;
    case "search":
      await cmdSearch(options);
      return;
    case "verify":
      await cmdVerify(options);
      return;
    case "delete":
      await cmdDelete(options);
      return;
    case "deliver":
      await cmdDeliver(options);
      return;
    case "gc":
      await cmdGc(options);
      return;
    case "export":
      await cmdExport(options);
      return;
    default:
      if ((PLANNED_COMMANDS as readonly string[]).includes(options.command)) {
        fail(
          `command '${options.command}' is part of the draft contract but not implemented yet (T4: #143)`,
          1,
          "contract_draft",
          { command: options.command },
        );
      }
      fail(`unknown command: ${options.command}`, 2);
  }
}

main().catch((err) => {
  if (err instanceof RegistryError) {
    // `code` is the contract-specific code (artifact_not_found,
    // target_not_found, missing_ref, delivery_failed, referenced, …);
    // `kind` is the coarse category. Usage errors carry code "usage".
    const error: Record<string, unknown> = {
      code: err.code,
      message: err.message,
      kind: err.kind,
    };
    if (err.extra) Object.assign(error, err.extra);
    process.stderr.write(`${JSON.stringify({ contract: CONTRACT, ok: false, error })}\n`);
    process.exit(err.code === "usage" ? 2 : 1);
  }
  fail(err instanceof Error ? err.message : String(err), 1);
});
