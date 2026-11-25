/**
 * Git/forge context adapter for rebuildup.textgen (Issue #108, parent
 * #29 T2).
 *
 * The git-related tasks (`branch_name`, `commit_message`, `pr_content`)
 * need repository context: staged/unstaged diffs, commit lists, forge PR
 * state, and repository conventions. All of it is gathered through the
 * `rebuildup.git` plugin's public read-only CLI contract
 * (`herdr-plugins.git/v1`) — the same cross-plugin consumption pattern
 * as `rebuildup.usage` → `rebuildup.conversations` (ADR-0013): the git
 * plugin root is resolved from an explicit override, the sibling
 * `../git` directory, or `herdr plugin list --json`, and only its CLI
 * is invoked. Other plugins' state files are never read, and git/forge
 * mutations (`stage`, `commit`, `branch`, `pr create`, …) are never
 * invoked — generation stays strictly separated from execution
 * (ADR-0017): the caller adopts or discards the result.
 *
 * Repository *content* convention files (AGENTS.md, commitlint config,
 * CONTRIBUTING.md) are read directly from the repo root reported by
 * git-v1 `status` — that is the target repository, not plugin state.
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pluginDirs } from "../../../packages/herdr-client/src/index";
import { type TaskKind, TextgenError } from "./model";

export const GIT_PLUGIN_ID = "rebuildup.git";
export const GIT_CONTRACT = "herdr-plugins.git/v1";

/** Tasks that can source their input from a pane's repository. */
export const GIT_TASKS: ReadonlySet<TaskKind> = new Set([
  "branch_name",
  "commit_message",
  "pr_content",
]);

export function isGitTask(kind: TaskKind): boolean {
  return GIT_TASKS.has(kind);
}

/** This plugin's own root (plugins/textgen). */
function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot && envRoot !== "") return envRoot;
  // src/gitcontext.ts → plugins/textgen
  return path.resolve(import.meta.dir, "..");
}

export type GitRootResolution =
  | { ok: true; root: string; via: "override" | "sibling" | "herdr-plugin-list" }
  | { ok: false; error: string };

async function isGitPluginRoot(dir: string): Promise<boolean> {
  try {
    const tomlPath = path.join(dir, "herdr-plugin.toml");
    const toml = await stat(tomlPath);
    if (!toml.isFile()) return false;
    const cli = await stat(path.join(dir, "src", "cli.ts"));
    if (!cli.isFile()) return false;
    const { readFile: rf } = await import("node:fs/promises");
    const text = await rf(tomlPath, "utf8");
    return text.includes(`id = "${GIT_PLUGIN_ID}"`);
  } catch {
    return false;
  }
}

/** `herdr plugin list --json` → plugin_root for rebuildup.git. */
async function discoverViaHerdr(): Promise<string | null> {
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
      if (id === GIT_PLUGIN_ID && typeof root === "string" && root !== "") {
        return root;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve the rebuildup.git plugin root. Never throws — failures are
 * structured for the CLI error envelope.
 */
export async function resolveGitPluginRoot(explicit?: string): Promise<GitRootResolution> {
  if (explicit !== undefined && explicit !== "") {
    const candidate = path.resolve(explicit);
    if (await isGitPluginRoot(candidate)) {
      return { ok: true, root: candidate, via: "override" };
    }
    return {
      ok: false,
      error: `git plugin root ${candidate} is not a ${GIT_PLUGIN_ID} plugin`,
    };
  }
  const sibling = path.resolve(pluginRoot(), "..", "git");
  if (await isGitPluginRoot(sibling)) {
    return { ok: true, root: sibling, via: "sibling" };
  }
  const discovered = await discoverViaHerdr();
  if (discovered !== null && (await isGitPluginRoot(discovered))) {
    return { ok: true, root: discovered, via: "herdr-plugin-list" };
  }
  return {
    ok: false,
    error:
      `${GIT_PLUGIN_ID} plugin not found; install it or pass --git-root / set ` +
      "gitPluginRoot in config.json (resolution: override → sibling → herdr plugin list)",
  };
}

// --- git CLI invocation ---------------------------------------------------------

export interface GitCallOptions {
  session?: string | undefined;
  socketPath?: string | undefined;
  timeoutMs?: number | undefined;
}

interface CliRunResult {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

/**
 * Run one read-only git-plugin CLI command. The child env is scrubbed of
 * this plugin's HERDR_PLUGIN_* values (they belong to rebuildup.textgen
 * and must never redirect the child's state resolution) and pinned to
 * the *git* plugin dirs, mirroring the usage→conversations pattern.
 */
export function runGitCli(
  root: string,
  args: string[],
  call: GitCallOptions,
): Promise<CliRunResult> {
  const cliArgs = [path.join(root, "src", "cli.ts"), ...args];
  if (call.session !== undefined) cliArgs.push("--session", call.session);
  if (call.socketPath !== undefined) cliArgs.push("--socket", call.socketPath);
  if (call.timeoutMs !== undefined) cliArgs.push("--timeout", String(call.timeoutMs));

  const gitDirs = pluginDirs(GIT_PLUGIN_ID);
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
  env.HERDR_PLUGIN_STATE_DIR = gitDirs.stateDir;
  env.HERDR_PLUGIN_CONFIG_DIR = gitDirs.configDir;
  env.HERDR_PLUGIN_ID = GIT_PLUGIN_ID;

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

function gitFail(message: string, kind = "git_error"): never {
  throw new TextgenError("git_cli_failed", kind, message);
}

/**
 * Invoke a git-plugin command and return its JSON payload. Verifies the
 * `herdr-plugins.git/v1` contract on every response — a plugin that
 * answers with a different contract is an error, never silently trusted.
 */
export async function gitCommand(
  root: string,
  args: string[],
  call: GitCallOptions,
): Promise<Record<string, unknown>> {
  const run = await runGitCli(root, args, call);
  if (run.status !== 0 || run.json === null) {
    let detail = run.stderr.trim();
    try {
      const errJson = JSON.parse(run.stderr) as {
        error?: { message?: string; kind?: string };
      };
      if (errJson.error?.message) detail = errJson.error.message;
      if (errJson.error?.kind) {
        gitFail(`git plugin ${args[0] ?? ""} failed: ${detail}`, errJson.error.kind);
      }
    } catch (err) {
      if (err instanceof TextgenError) throw err;
      /* keep raw stderr */
    }
    gitFail(
      `git plugin ${args[0] ?? ""} failed (exit ${run.status}): ${detail || run.stdout.slice(0, 400)}`,
    );
  }
  const json = run.json;
  if (json.contract !== GIT_CONTRACT) {
    throw new TextgenError(
      "git_contract_mismatch",
      "git_error",
      `git plugin returned unexpected contract ${String(json.contract)}`,
      { expected: GIT_CONTRACT },
    );
  }
  return json;
}

// --- context collection ---------------------------------------------------------

export interface GitContextOptions extends GitCallOptions {
  task: TaskKind;
  pane: string;
  gitRoot: string;
  /** Byte cap forwarded to git diff/compare --max-bytes. */
  diffMaxBytes?: number | undefined;
}

export interface GitContextResult {
  /** Collected task-input fields (subset of the task's inputFields). */
  input: Record<string, string | number>;
  /** Human-readable provenance, e.g. "git-v1:status", "git-v1:diff --staged". */
  sources: string[];
  warnings: string[];
  repoRoot: string | null;
  branch: string | null;
}

const DIFF_MAX_BYTES = 120_000;
const CONVENTION_FILE_MAX_CHARS = 8_000;
const CONVENTION_TOTAL_MAX_CHARS = 40_000;

/**
 * Repository convention files probed at the repo root, in priority
 * order. Presence is detected by stat; content is capped. These are
 * repository files (the generation target), not plugin state.
 */
const CONVENTION_FILES = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.yaml",
  ".commitlintrc.yml",
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
] as const;

async function readConventions(repoRoot: string): Promise<{
  text: string | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const sections: string[] = [];
  let total = 0;
  for (const rel of CONVENTION_FILES) {
    if (total >= CONVENTION_TOTAL_MAX_CHARS) break;
    const file = path.join(repoRoot, rel);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      const raw = await readFile(file, "utf8");
      const capped = raw.slice(0, CONVENTION_FILE_MAX_CHARS);
      total += capped.length;
      sections.push(`### ${rel}\n\n${capped}`);
    } catch {
      /* absent or unreadable — not a warning-worthy condition */
    }
  }
  if (sections.length === 0) return { text: null, warnings };
  if (total >= CONVENTION_TOTAL_MAX_CHARS) {
    warnings.push("repository conventions truncated at conventions budget");
  }
  return { text: sections.join("\n\n"), warnings };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface StatusSummary {
  repoRoot: string | null;
  branch: string | null;
  changes: { staged: number; unstaged: number; untracked: number; conflicted: number } | null;
}

async function collectStatus(
  root: string,
  pane: string,
  call: GitCallOptions,
): Promise<StatusSummary> {
  const payload = await gitCommand(root, ["status", pane], call);
  const repo =
    typeof payload.repo === "object" && payload.repo !== null
      ? (payload.repo as Record<string, unknown>)
      : {};
  const branch =
    typeof payload.branch === "object" && payload.branch !== null
      ? (payload.branch as Record<string, unknown>)
      : {};
  const changes =
    typeof payload.changes === "object" && payload.changes !== null
      ? (payload.changes as Record<string, unknown>)
      : {};
  const bare = repo.bare === true;
  if (bare) {
    throw new TextgenError("git_bare_repo", "git_error", "pane repository is bare");
  }
  return {
    repoRoot: str(repo.root),
    branch: str(branch.name),
    changes: {
      staged: num(changes.staged) ?? 0,
      unstaged: num(changes.unstaged) ?? 0,
      untracked: num(changes.untracked) ?? 0,
      conflicted: num(changes.conflicted) ?? 0,
    },
  };
}

function changesSummary(changes: StatusSummary["changes"]): string {
  if (changes === null) return "";
  const total = changes.staged + changes.unstaged + changes.untracked + changes.conflicted;
  return (
    `${total} changed file${total === 1 ? "" : "s"} ` +
    `(staged ${changes.staged}, unstaged ${changes.unstaged}, ` +
    `untracked ${changes.untracked}, conflicted ${changes.conflicted})`
  );
}

/**
 * Collect the task input fields for a git task from a pane's repository.
 * Read-only by construction: only git-v1 `status`/`files`/`diff`/`log`/
 * `compare`/`pr status` are invoked. Throws TextgenError on transport or
 * contract failures; per-source soft failures (e.g. `pr status` without
 * gh) become warnings so generation can still proceed.
 */
export async function collectGitContext(options: GitContextOptions): Promise<GitContextResult> {
  const { task, pane, gitRoot } = options;
  if (!isGitTask(task)) {
    throw new TextgenError(
      "git_task_unsupported",
      "bad_request",
      `task ${task} does not consume git context`,
      { git_tasks: [...GIT_TASKS].sort() },
    );
  }
  const call: GitCallOptions = {
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
  const sources: string[] = [];
  const warnings: string[] = [];
  const input: Record<string, string | number> = {};

  const status = await collectStatus(gitRoot, pane, call);
  sources.push("git-v1:status");
  const repoRoot = status.repoRoot;

  if (task === "branch_name") {
    const summary = changesSummary(status.changes);
    if (summary !== "") {
      input.change_summary = `Repository ${repoRoot ?? "?"} on branch ${status.branch ?? "?"}: ${summary}`;
    }
    const diff = await gitCommand(
      gitRoot,
      ["diff", pane, "--stat", "--max-bytes", String(options.diffMaxBytes ?? DIFF_MAX_BYTES)],
      call,
    );
    sources.push("git-v1:diff --stat");
    let text = str(diff.stat_output) ?? "";
    if (diff.truncated === true) text += "\n[diff truncated by --max-bytes]";
    if (text.trim() !== "") input.diff = text;
    return { input, sources, warnings, repoRoot, branch: status.branch };
  }

  if (task === "commit_message") {
    // Staged diff is the commit candidate's subject; fall back to the
    // unstaged worktree diff with an explicit scope note when nothing is
    // staged (never silently mix scopes).
    let diffPayload = await gitCommand(
      gitRoot,
      ["diff", pane, "--staged", "--max-bytes", String(options.diffMaxBytes ?? DIFF_MAX_BYTES)],
      call,
    );
    sources.push("git-v1:diff --staged");
    let patch = str(diffPayload.output) ?? "";
    if (patch.trim() === "") {
      diffPayload = await gitCommand(
        gitRoot,
        ["diff", pane, "--max-bytes", String(options.diffMaxBytes ?? DIFF_MAX_BYTES)],
        call,
      );
      sources.push("git-v1:diff (unstaged fallback)");
      patch = str(diffPayload.output) ?? "";
      if (patch.trim() !== "") {
        patch = `# scope: nothing staged; this is the unstaged worktree diff\n\n${patch}`;
      }
    }
    if (diffPayload.truncated === true) {
      patch += "\n[diff truncated by --max-bytes]";
    }
    if (patch.trim() !== "") input.diff = patch;

    if (repoRoot !== null) {
      const conventions = await readConventions(repoRoot);
      if (conventions.text !== null) {
        input.conventions = conventions.text;
        sources.push("repo:convention-files");
      }
      warnings.push(...conventions.warnings);
    }
    return { input, sources, warnings, repoRoot, branch: status.branch };
  }

  // pr_content
  let patch = "";
  let patchTruncated = false;
  try {
    const compare = await gitCommand(
      gitRoot,
      ["compare", pane, "--max-bytes", String(options.diffMaxBytes ?? DIFF_MAX_BYTES)],
      call,
    );
    sources.push("git-v1:compare");
    patch = str(compare.patch) ?? "";
    patchTruncated = compare.patch_truncated === true;
  } catch (err) {
    // No upstream/base is a legitimate repo state, not a generation
    // blocker: fall back to the worktree diff and say so.
    warnings.push(
      `compare unavailable (${err instanceof Error ? err.message : String(err)}); ` +
        "falling back to worktree diff",
    );
    const diff = await gitCommand(
      gitRoot,
      ["diff", pane, "--max-bytes", String(options.diffMaxBytes ?? DIFF_MAX_BYTES)],
      call,
    );
    sources.push("git-v1:diff (compare fallback)");
    patch = str(diff.output) ?? "";
    patchTruncated = diff.truncated === true;
    if (patch.trim() !== "") {
      patch = `# scope: worktree diff (no compare base available)\n\n${patch}`;
    }
  }
  if (patchTruncated) patch += "\n[patch truncated by --max-bytes]";
  if (patch.trim() !== "") input.diff = patch;

  const log = await gitCommand(gitRoot, ["log", pane, "--limit", "30"], call);
  sources.push("git-v1:log");
  const commits = Array.isArray(log.commits) ? log.commits : [];
  const commitLines = commits
    .map((c) => {
      if (typeof c !== "object" || c === null) return null;
      const rec = c as Record<string, unknown>;
      const sha = str(rec.sha);
      const subject = str(rec.subject);
      if (sha === null || subject === null) return null;
      return `${sha.slice(0, 10)} ${subject}`;
    })
    .filter((l): l is string => l !== null);
  if (commitLines.length > 0) input.commits = commitLines.join("\n");

  // Related issue/PR references mentioned in commit subjects and the
  // branch name (`#123`, `owner/repo#123`).
  const refs = new Set<string>();
  const refRe = /#(\d+)\b|([\w.-]+\/[\w.-]+)#(\d+)\b/g;
  const haystacks = [status.branch ?? "", ...commitLines];
  for (const text of haystacks) {
    for (const match of text.matchAll(refRe)) {
      refs.add(match[0]);
    }
  }
  if (refs.size > 0) input.issue_refs = [...refs].sort().join(", ");

  // Forge context: the open PR for this branch, when gh is available.
  // Soft-fail — a missing gh/auth must not block generation.
  try {
    const prStatus = await gitCommand(gitRoot, ["pr", "status", pane], call);
    sources.push("git-v1:pr status");
    const pr =
      typeof prStatus.pr === "object" && prStatus.pr !== null
        ? (prStatus.pr as Record<string, unknown>)
        : null;
    if (pr !== null) {
      const body = str(pr.body);
      input.pr_context = JSON.stringify({
        number: num(pr.number),
        title: str(pr.title),
        state: str(pr.state),
        isDraft: pr.isDraft === true,
        url: str(pr.url),
        headRefName: str(pr.headRefName),
        baseRefName: str(pr.baseRefName),
        ...(body !== null ? { body: body.slice(0, 4_000) } : {}),
      });
    }
  } catch (err) {
    warnings.push(`forge context unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { input, sources, warnings, repoRoot, branch: status.branch };
}
