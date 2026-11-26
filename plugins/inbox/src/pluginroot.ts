/**
 * Cross-plugin root resolution for rebuildup.inbox (Issue #178).
 *
 * The sibling `rebuildup.git` plugin is consumed only through its public
 * plugin-root CLI contract (`git pr view|comments|checks`) — never its
 * state files or gh internals (same pattern as usage→conversations and
 * textgen→git, ADR-0013). The root is resolved from an explicit override,
 * the sibling `../git` directory, or `herdr plugin list --json`.
 *
 * Vendored from plugins/textgen/src/pluginroot.ts (the resolver is
 * already parameterized by plugin id).
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/index";

/** This plugin's own root (plugins/inbox). */
function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot && envRoot !== "") return envRoot;
  // src/pluginroot.ts → plugins/inbox
  return path.resolve(import.meta.dir, "..");
}

export type PluginRootResolution =
  | { ok: true; root: string; via: "override" | "sibling" | "herdr-plugin-list" }
  | { ok: false; error: string };

/** Directory name of a plugin id: `rebuildup.git` → `git`. */
export function pluginDirName(pluginId: string): string {
  const dot = pluginId.indexOf(".");
  return dot === -1 ? pluginId : pluginId.slice(dot + 1);
}

async function isPluginRoot(dir: string, pluginId: string): Promise<boolean> {
  try {
    const tomlPath = path.join(dir, "herdr-plugin.toml");
    const toml = await stat(tomlPath);
    if (!toml.isFile()) return false;
    const cli = await stat(path.join(dir, "src", "cli.ts"));
    if (!cli.isFile()) return false;
    const text = await readFile(tomlPath, "utf8");
    return text.includes(`id = "${pluginId}"`);
  } catch {
    return false;
  }
}

/** `herdr plugin list --json` → plugin_root for the given plugin id. */
async function discoverViaHerdr(pluginId: string): Promise<string | null> {
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  const stdout = await new Promise<string | null>((resolve) => {
    const child = spawn(herdrBin, ["plugin", "list", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out : null));
  });
  if (stdout === null) return null;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { plugins?: unknown[] }).plugins ?? []);
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const id = e.plugin_id ?? e.id;
      const root = e.plugin_root ?? e.root;
      if (id === pluginId && typeof root === "string" && root !== "") {
        return root;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve a sibling plugin's root. Never throws — failures are reported
 * structurally so callers can degrade to warnings.
 */
export async function resolvePluginRoot(
  pluginId: string,
  explicit?: string,
): Promise<PluginRootResolution> {
  if (explicit !== undefined && explicit !== "") {
    const candidate = path.resolve(explicit);
    if (await isPluginRoot(candidate, pluginId)) {
      return { ok: true, root: candidate, via: "override" };
    }
    return {
      ok: false,
      error: `plugin root ${candidate} is not a ${pluginId} plugin`,
    };
  }
  const sibling = path.resolve(pluginRoot(), "..", pluginDirName(pluginId));
  if (await isPluginRoot(sibling, pluginId)) {
    return { ok: true, root: sibling, via: "sibling" };
  }
  const discovered = await discoverViaHerdr(pluginId);
  if (discovered !== null && (await isPluginRoot(discovered, pluginId))) {
    return { ok: true, root: discovered, via: "herdr-plugin-list" };
  }
  return {
    ok: false,
    error:
      `${pluginId} plugin not found; install it or pass an explicit root ` +
      "(resolution: override → sibling → herdr plugin list)",
  };
}

// --- sibling plugin CLI invocation ---------------------------------------------

export interface PluginCliRunResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

export interface PluginCliCallOptions {
  session?: string | undefined;
  socketPath?: string | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Run one sibling-plugin CLI command (`bun <root>/src/cli.ts …`). The
 * child env is scrubbed of this plugin's HERDR_PLUGIN_* values (they
 * belong to rebuildup.inbox and must never redirect the child's state
 * resolution) and pinned to the *target* plugin's dirs — the same
 * cross-plugin pattern as usage→conversations (ADR-0013).
 */
export function runPluginCli(
  root: string,
  pluginId: string,
  args: string[],
  call: PluginCliCallOptions,
): Promise<PluginCliRunResult> {
  const cliArgs = [path.join(root, "src", "cli.ts"), ...args];
  if (call.session !== undefined) cliArgs.push("--session", call.session);
  if (call.socketPath !== undefined) cliArgs.push("--socket", call.socketPath);
  if (call.timeoutMs !== undefined) cliArgs.push("--timeout", String(call.timeoutMs));

  const dirs = pluginDirs(pluginId);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key === "HERDR_PLUGIN_STATE_DIR" ||
      key === "HERDR_PLUGIN_CONFIG_DIR" ||
      key === "HERDR_PLUGIN_ID" ||
      key === "HERDR_PLUGIN_ROOT" ||
      key === "HERDR_PLUGIN_CONTEXT_JSON" ||
      key === "HERDR_PANE_ID"
    ) {
      continue;
    }
    env[key] = value;
  }
  env.HERDR_PLUGIN_STATE_DIR = dirs.stateDir;
  env.HERDR_PLUGIN_CONFIG_DIR = dirs.configDir;
  env.HERDR_PLUGIN_ID = pluginId;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: (call.timeoutMs ?? 30_000) + 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        /* non-JSON output */
      }
      resolve({ status: code ?? -1, stdout, stderr, json });
    });
  });
}
