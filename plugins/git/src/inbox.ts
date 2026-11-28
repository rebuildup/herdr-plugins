/**
 * Pane↔tracker link delegation for `git issue link|unlink|links`
 * (Issue #174).
 *
 * Tracker links are pane-scoped, user-declared work associations owned by
 * `rebuildup.inbox` (`herdr-plugins.inbox/v1` link/unlink/links —
 * agent-session fingerprint + seq-regression staleness, `--verify` gh
 * check, organize-state interplay). Duplicating that store inside the git
 * plugin would create a second, divergent link namespace, so the git
 * plugin exposes the same operations as a thin delegating surface over
 * the inbox plugin's public CLI — the ADR-0013 sibling-plugin pattern
 * already used by usage→conversations and textgen→git/usage: resolve the
 * plugin root (explicit override → sibling `../inbox` →
 * `herdr plugin list --json`), invoke its CLI entrypoint — `bin/inbox`
 * for the native build (ADR-0035), `src/cli.ts` under Bun for pre-#291
 * TS-only checkouts — and never touch the inbox plugin's state file
 * directly.
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  herdrConfigDir,
  herdrStateDir,
  pluginPathComponent,
} from "../../../packages/herdr-client/src/index";

export const INBOX_PLUGIN_ID = "rebuildup.inbox";

/** This plugin's own root (plugins/git). */
function gitPluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot && envRoot !== "") return envRoot;
  // src/inbox.ts → plugins/git
  return path.resolve(import.meta.dir, "..");
}

/** Directory name of a plugin id: `rebuildup.inbox` → `inbox`. */
function pluginDirName(pluginId: string): string {
  const dot = pluginId.indexOf(".");
  return dot === -1 ? pluginId : pluginId.slice(dot + 1);
}

async function isPluginRoot(dir: string, pluginId: string): Promise<boolean> {
  try {
    const tomlPath = path.join(dir, "herdr-plugin.toml");
    const toml = await stat(tomlPath);
    if (!toml.isFile()) return false;
    // Native distribution (ADR-0035) ships bin/inbox; pre-#291 TS-only
    // checkouts keep src/cli.ts — accept either CLI entrypoint so an
    // older inbox install still resolves (independent plugin lifecycle).
    const bin = await stat(path.join(dir, "bin", "inbox")).catch(() => null);
    const cli =
      bin?.isFile() === true ? bin : await stat(path.join(dir, "src", "cli.ts")).catch(() => null);
    if (cli === null || !cli.isFile()) return false;
    const text = await readFile(tomlPath, "utf8");
    return text.includes(`id = "${pluginId}"`);
  } catch {
    return false;
  }
}

/** Prefer the native `bin/inbox`; fall back to `src/cli.ts` (pre-#291 checkouts). */
async function inboxCliPath(root: string): Promise<string> {
  const bin = path.join(root, "bin", "inbox");
  const info = await stat(bin).catch(() => null);
  return info?.isFile() === true ? bin : path.join(root, "src", "cli.ts");
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

export type InboxRootResolution =
  | { ok: true; root: string; via: "override" | "sibling" | "herdr-plugin-list" }
  | { ok: false; error: string };

/**
 * Resolve the rebuildup.inbox plugin root. Never throws — failures are
 * reported structurally so the CLI can surface `inbox_unavailable`.
 */
export async function resolveInboxPluginRoot(explicit?: string): Promise<InboxRootResolution> {
  if (explicit !== undefined && explicit !== "") {
    const candidate = path.resolve(explicit);
    if (await isPluginRoot(candidate, INBOX_PLUGIN_ID)) {
      return { ok: true, root: candidate, via: "override" };
    }
    return {
      ok: false,
      error: `plugin root ${candidate} is not a ${INBOX_PLUGIN_ID} plugin`,
    };
  }
  const sibling = path.resolve(gitPluginRoot(), "..", pluginDirName(INBOX_PLUGIN_ID));
  if (await isPluginRoot(sibling, INBOX_PLUGIN_ID)) {
    return { ok: true, root: sibling, via: "sibling" };
  }
  const discovered = await discoverViaHerdr(INBOX_PLUGIN_ID);
  if (discovered !== null && (await isPluginRoot(discovered, INBOX_PLUGIN_ID))) {
    return { ok: true, root: discovered, via: "herdr-plugin-list" };
  }
  return {
    ok: false,
    error:
      `${INBOX_PLUGIN_ID} plugin not found; install it or set inboxPluginRoot ` +
      "in config.json (resolution: override → sibling → herdr plugin list)",
  };
}

export interface InboxCliCallOptions {
  session?: string | undefined;
  socketPath?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface InboxCliRunResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: { code?: string; message?: string } | null;
}

/**
 * Run one inbox CLI command (`<root>/bin/inbox …` — the native binary;
 * ADR-0035). The child env is
 * scrubbed of this plugin's HERDR_PLUGIN_* values (they belong to
 * rebuildup.git and must never redirect the child's state resolution)
 * and pinned to the inbox plugin's own dirs — the same env-pin rule as
 * textgen→git/usage. Ambient socket/session targeting env
 * (`HERDR_SOCKET_PATH`/`HERDR_SESSION`) is preserved so an ambient
 * target stays consistent; explicit `--session`/`--socket` flags are
 * forwarded as argv.
 */
export async function runInboxCli(
  root: string,
  args: string[],
  call: InboxCliCallOptions,
): Promise<InboxCliRunResult> {
  // `.ts` entrypoints run under Bun (process.execPath); a native bin/
  // path spawns directly — mirrors pluginroot.rs run_plugin_cli and the
  // usage→conversations source.ts pattern.
  const cliPath = await inboxCliPath(root);
  const isTs = cliPath.endsWith(".ts");
  const cliArgs = [...args];
  if (call.session !== undefined) cliArgs.push("--session", call.session);
  if (call.socketPath !== undefined) cliArgs.push("--socket", call.socketPath);
  if (call.timeoutMs !== undefined) cliArgs.push("--timeout", String(call.timeoutMs));

  // Derived platform dirs for the *inbox* plugin — deliberately NOT
  // pluginDirs(), which would read HERDR_PLUGIN_STATE_DIR/CONFIG_DIR and
  // hand the child this plugin's (rebuildup.git) directories.
  const component = pluginPathComponent(INBOX_PLUGIN_ID);
  const dirs = {
    configDir: path.join(herdrConfigDir(), "plugins", "config", component),
    stateDir: path.join(herdrStateDir(), "plugins", component),
  };
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
  env.HERDR_PLUGIN_ID = INBOX_PLUGIN_ID;

  return new Promise((resolve, reject) => {
    const argv = isTs ? [cliPath, ...cliArgs] : cliArgs;
    const command = isTs ? process.execPath : cliPath;
    const child = spawn(command, argv, {
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
      let error: InboxCliRunResult["error"] = null;
      try {
        json = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        /* non-JSON stdout */
      }
      try {
        const parsed = JSON.parse(stderr) as {
          error?: { code?: string; message?: string };
        };
        error = parsed.error ?? null;
      } catch {
        /* non-JSON stderr */
      }
      resolve({ status: code ?? -1, stdout, stderr, json, error });
    });
  });
}
