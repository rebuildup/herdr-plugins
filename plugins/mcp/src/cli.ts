/**
 * rebuildup.mcp CLI — discovery and (from T2, #138) the stdio MCP
 * server entrypoint for contract `herdr-plugins.mcp/v1` (draft).
 *
 * T1 (#135) scope: `capability` reports the contract skeleton —
 * access levels, planned tool table, session resolution, upstream
 * gaps — and `serve` honestly reports `not_implemented` until the
 * server core lands. Boundary decisions: ADR-0025.
 *
 * All commands emit a single JSON document on stdout; diagnostics go
 * to stderr. Exit code 0 on success, 1 on handled errors, 2 on usage.
 */

import {
  pluginDirs,
  resolveSocketPath,
  sessionSnapshot,
} from "../../../packages/herdr-client/src/index";
import {
  ACCESS_LEVELS,
  type AccessLevel,
  CONTRACT,
  CONTRACT_STATUS,
  DEFAULT_ACCESS_LEVEL,
  ERROR_CODES,
  PLUGIN_ID,
  PLUGIN_VERSION,
  TOOL_TABLE,
  UPSTREAM_GAPS,
} from "./model";

interface CliOptions {
  command: string;
  session: string | undefined;
  socketPath: string | undefined;
  accessLevel: AccessLevel;
}

function parseArgs(argv: string[]): CliOptions {
  const [command = "help", ...args] = argv;
  const options: CliOptions = {
    command,
    session: undefined,
    socketPath: undefined,
    accessLevel: DEFAULT_ACCESS_LEVEL,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--session") {
      options.session = args[++i];
    } else if (arg === "--socket") {
      options.socketPath = args[++i];
    } else if (arg === "--access-level") {
      const value = args[++i];
      if (!ACCESS_LEVELS.includes(value as AccessLevel)) {
        fail(`unknown --access-level: ${value} (expected ${ACCESS_LEVELS.join("|")})`, 2);
      }
      options.accessLevel = value as AccessLevel;
    } else {
      fail(`unknown argument: ${arg}`, 2);
    }
  }
  return options;
}

function emit(document: unknown): void {
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

function fail(message: string, code: 1 | 2): never {
  process.stderr.write(
    `${JSON.stringify({ contract: CONTRACT, ok: false, error: { code: code === 2 ? "usage" : "error", message } })}\n`,
  );
  process.exit(code);
}

function resolvedSocket(options: CliOptions): string {
  // Pane-scoped env (HERDR_PANE_ID etc.) is ignored by design
  // (ADR-0025 §4): resolveSocketPath only honors HERDR_SOCKET_PATH /
  // HERDR_SESSION, which legitimately describe the target session.
  return options.socketPath ?? resolveSocketPath({ session: options.session });
}

async function probeSession(options: CliOptions): Promise<{
  reachable: boolean;
  session_name?: string;
  error?: string;
}> {
  try {
    const snapshot = await sessionSnapshot({
      session: options.session,
      socketPath: options.socketPath,
      timeoutMs: 2000,
    });
    const name = snapshot.session?.name;
    return name === undefined ? { reachable: true } : { reachable: true, session_name: name };
  } catch (err) {
    return { reachable: false, error: String(err) };
  }
}

async function cmdCapability(options: CliOptions): Promise<void> {
  const session = await probeSession(options);
  emit({
    contract: CONTRACT,
    contract_status: CONTRACT_STATUS,
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    commands: ["capability", "serve", "help"],
    actions: [],
    events: [],
    startup: [],
    state_file: null,
    config_dir: pluginDirs(PLUGIN_ID).configDir,
    socket: resolvedSocket(options),
    session,
    access_levels: {
      levels: [...ACCESS_LEVELS],
      default: DEFAULT_ACCESS_LEVEL,
      semantics:
        "read-only: read tools only; supervised: + mutations with identity echo and stale guards (provider permission mode capped); full: + environment-level operations. Below-level mutation calls fail capability_denied.",
      t3_mapping: {
        "read-only": "read-only",
        supervised: "approval-required..auto band",
        full: "full-access",
      },
    },
    negotiated_access_level: options.accessLevel,
    tools: TOOL_TABLE.map((tool) => ({
      name: tool.name,
      access: tool.access,
      read_only: tool.readOnly,
      status: tool.status,
      backs_onto: tool.backs_onto,
    })),
    error_codes: [...ERROR_CODES],
    upstream_gaps: UPSTREAM_GAPS,
    remote: {
      status: "excluded_v1",
      tracking: "herdrdev/herdr#6199",
      note: "no inbound HTTP/OAuth in herdr; local stdio only, no bespoke public server",
    },
    state: "no durable state in v1 (per-client stdio process; ADR-0025 §5)",
  });
}

async function cmdServe(options: CliOptions): Promise<void> {
  // Honest not-implemented until T2 (#138) lands the stdio server core.
  emit({
    contract: CONTRACT,
    ok: false,
    error: {
      code: "unsupported",
      message:
        "rebuildup.mcp serve is not implemented yet (T1 skeleton, issue #135); the stdio MCP server core lands in T2 (#138)",
      details: { ticket: "#138", access_level: options.accessLevel },
    },
  });
  process.exit(1);
}

const USAGE = `rebuildup.mcp — outside-agent MCP surface (contract ${CONTRACT}, ${CONTRACT_STATUS})

Usage:
  mcp capability [--session NAME] [--socket PATH] [--access-level L]
  mcp serve [--session NAME] [--socket PATH] [--access-level L]
  mcp help

Access levels: ${ACCESS_LEVELS.join(" | ")} (default ${DEFAULT_ACCESS_LEVEL})

Session resolution: --socket > --session/HERDR_SESSION > HERDR_SOCKET_PATH
> default session socket. Pane env vars are ignored (ADR-0025 §4).
serve is a per-client stdio MCP server; it lands in T2 (#138) — T1
ships the contract skeleton and capability discovery only.
Remote HTTP/OAuth is an upstream gap (herdrdev/herdr#6199), out of v1.
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  switch (options.command) {
    case "capability":
      return cmdCapability(options);
    case "serve":
      return cmdServe(options);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
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
