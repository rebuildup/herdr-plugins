/**
 * stdio MCP server core for `rebuildup.mcp` (T2, #138).
 *
 * MCP over stdio is newline-delimited JSON-RPC 2.0: one message per
 * line on stdin, one response per line on stdout. stdout is
 * protocol-only; all diagnostics go to stderr. The process lives for
 * one MCP client (spawned per client config — no daemon, ADR-0002)
 * and exits when stdin closes.
 *
 * Protocol surface (contract `herdr-plugins.mcp/v1`):
 *   - `initialize` / `notifications/*` (initialized etc. — ignored)
 *   - `ping`
 *   - `tools/list` / `tools/call` (access-level enforced, contract
 *     error model via `isError` results)
 *   - `resources/list` (empty) / `resources/read` (not found)
 *   - JSON-RPC errors: -32700 parse, -32600 invalid request,
 *     -32601 method not found, -32602 invalid params
 */

import readline from "node:readline";
import { CONTRACT, PLUGIN_ID, PLUGIN_VERSION } from "./model";
import { ALL_TOOL_DEFINITIONS, callTool, type ToolContext, type ToolError } from "./tools";

/** MCP protocol revisions this server can speak (newest first). */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

function negotiateProtocolVersion(requested: unknown): string {
  if (
    typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
  ) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcResponse["error"] & object = { code, message };
  if (data !== undefined) (error as { data?: unknown }).data = data;
  return { jsonrpc: "2.0", id, error };
}

function isRequestId(id: unknown): id is string | number {
  return typeof id === "string" || typeof id === "number";
}

/** MCP tool result carrying structured content + text representation. */
function toolResult(payload: unknown, isError: boolean, error?: ToolError): unknown {
  const doc = isError
    ? {
        contract: CONTRACT,
        ok: false,
        error: {
          code: error?.code ?? "internal",
          message: error?.message ?? "unknown error",
          ...(error?.details !== undefined ? { details: error.details } : {}),
        },
      }
    : payload;
  const text = JSON.stringify(doc, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: doc,
    ...(isError ? { isError: true } : {}),
  };
}

async function handleRequest(
  message: JsonRpcRequest,
  ctx: ToolContext,
): Promise<JsonRpcResponse | null> {
  const id = isRequestId(message.id) ? message.id : null;
  const hasId = message.id !== undefined && message.id !== null;
  const method = typeof message.method === "string" ? message.method : null;

  // Notifications (no id) never get a response — including
  // notifications/* methods we don't implement.
  if (!hasId) return null;
  if (method === null) return rpcError(id, -32600, "missing method");

  const params =
    typeof message.params === "object" && message.params !== null
      ? (message.params as Record<string, unknown>)
      : {};

  switch (method) {
    case "initialize": {
      const result = {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: { name: PLUGIN_ID, version: PLUGIN_VERSION },
        instructions:
          "herdr session/plugin read surface (contract herdr-plugins.mcp/v1). " +
          "Session target was fixed at server start; use herdr_capability to inspect it.",
      };
      return ok(id, result);
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: ALL_TOOL_DEFINITIONS.map((def) => ({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema,
          annotations: {
            readOnlyHint: def.spec.readOnly,
            // Mutations additionally require a non-default access level;
            // clients can read the floor from the description/table.
            ...(def.spec.access !== "read-only"
              ? { destructiveHint: true, openWorldHint: false }
              : {}),
          },
        })),
      });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || name === "") {
        return rpcError(id, -32602, "tools/call requires params.name (string)");
      }
      const outcome = await callTool(name, params.arguments, ctx);
      return ok(id, toolResult(outcome.payload, outcome.isError, outcome.error));
    }
    case "resources/list":
      // v1 exposes no MCP resources; the read surface is tool-based.
      return ok(id, { resources: [] });
    case "resources/read":
      return rpcError(id, -32602, "resource not found: rebuildup.mcp exposes no resources in v1");
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export interface ServeOptions {
  ctx: ToolContext;
  /** Diagnostics sink (default stderr). */
  log?: ((message: string) => void) | undefined;
  /** Input stream (default process.stdin); exposed for tests. */
  input?: NodeJS.ReadableStream | undefined;
  /** Output stream (default process.stdout); exposed for tests. */
  output?: NodeJS.WritableStream | undefined;
}

/**
 * Run the stdio server until the input stream ends. Resolves when the
 * client disconnects (stdin EOF) — the process then exits normally.
 */
export async function serveMcp(options: ServeOptions): Promise<void> {
  const { ctx } = options;
  const log =
    options.log ??
    ((message: string) => {
      process.stderr.write(`[rebuildup.mcp] ${message}\n`);
    });
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  log(
    `serve start: contract=${CONTRACT} access=${ctx.accessLevel} ` +
      `socket=${ctx.socketPath} session=${ctx.sessionName ?? "(resolved live)"} via=${ctx.resolvedVia}`,
  );

  const rl = readline.createInterface({ input, terminal: false });
  const pending: Promise<void>[] = [];

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, "parse error: invalid JSON"))}\n`);
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      output.write(
        `${JSON.stringify(rpcError(null, -32600, "invalid request: expected a JSON-RPC object"))}\n`,
      );
      return;
    }
    const request = message as JsonRpcRequest;
    // Requests are handled concurrently; JSON-RPC ids keep responses
    // matched. Notifications resolve to null and write nothing.
    const task = handleRequest(request, ctx)
      .then((response) => {
        if (response !== null) output.write(`${JSON.stringify(response)}\n`);
      })
      .catch((err: unknown) => {
        log(`handler error: ${err instanceof Error ? err.message : String(err)}`);
        const id = isRequestId(request.id) ? request.id : null;
        output.write(
          `${JSON.stringify(rpcError(id, -32603, "internal error", { cause: String(err) }))}\n`,
        );
      });
    pending.push(task);
  });

  await new Promise<void>((resolveClose) => {
    rl.on("close", resolveClose);
  });
  // Close event subscriptions so their sockets don't keep the process
  // alive after the MCP client disconnects (T4, #140).
  ctx.events.closeAll();
  await Promise.allSettled(pending);
  log("serve stop: stdin closed");
}
