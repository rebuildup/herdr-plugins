/**
 * TS↔Rust output-parity diff harness for rebuildup.machines (Issue #326).
 *
 * Modeled on scripts/diff-git.ts (#292) / diff-inbox.ts (#291). The
 * TypeScript implementation is reconstructed on the fly: `git archive`
 * extracts `plugins/machines` + `packages` at the pinned pre-removal
 * commit into a temp dir, then runs BOTH
 * `bun <tmp>/plugins/machines/src/cli.ts` (or `src/tui.ts` for the
 * non-TTY fallback step) and the shipped `plugins/machines/bin/machines`
 * against the SAME stub `herdr` executable (HERDR_BIN_PATH), with
 * per-side isolated HERDR_PLUGIN_STATE_DIR/CONFIG_DIR.
 *
 * The stub `herdr` is a POSIX shell script (harness runs on POSIX dev
 * machines / Linux CI — same constraint as diff-git's gh stub). It
 * serves `machine list --json`, `--machine <id> api snapshot`, and
 * `--machine <id> plugin list --json` from files under MACHINES_STUB_DIR,
 * covering ok / disabled / unreachable / unsupported_remote /
 * plugin-surface-unsupported / ambiguous-label / list-failure /
 * spawn-failure scenarios.
 *
 * Every command's stdout AND stderr (exit code included) is compared
 * after:
 *   - sorting object keys recursively (JSON key order is not contract),
 *   - normalizing volatile fields (generated_at, probed_at, ISO dates),
 *   - scrubbing tmp paths (stub dir, per-side state/config dirs, the
 *     extracted TS root, the Rust binary path).
 *
 * Documented intentional divergences (normalized on both sides):
 *   - `usage` strings name the invocation: TS prints
 *     `bun run src/cli.ts …`, the native binary prints `machines …`
 *     (scrubString maps the TS prefix to `machines`).
 *   - Non-TTY `tui` fallback hint: TS prints `CLI: bun run src/cli.ts
 *     <cmd>`; Rust prints `CLI: machines <cmd>` (same scrub).
 *
 * Usage:
 *   bun scripts/diff-machines.ts [--ts-commit <sha>] [--keep]
 *
 * Defaults: --ts-commit = parent of the commit that deleted
 * plugins/machines/src/cli.ts, falling back to HEAD while the TS
 * implementation still exists. Exits non-zero on any diff.
 * Documented in docs/research/machines-native-rust.md.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { machinesBinary } from "../tests/helpers/machines-bin";
import { testEnv } from "../tests/helpers/test-env";

const REPO_ROOT = path.join(import.meta.dir, "..");

// --- args -----------------------------------------------------------------

const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}
const keepTmp = args.includes("--keep");

// --- resolve TS commit ----------------------------------------------------

function git(...gitArgs: string[]): string {
  const out = spawnSync("git", gitArgs, { cwd: REPO_ROOT, encoding: "utf8" });
  if (out.status !== 0) {
    throw new Error(`git ${gitArgs.join(" ")} failed: ${out.stderr}`);
  }
  return (out.stdout ?? "").trim();
}

// The commit that deleted plugins/machines/src/cli.ts; its parent still
// has the full TS implementation. While the TS tree is still present
// (pre-removal), no deletion commit exists — fall back to HEAD.
const deletionCommit = git(
  "log",
  "--diff-filter=D",
  "--format=%H",
  "-1",
  "--",
  "plugins/machines/src/cli.ts",
);
const tsCommit =
  argValue("--ts-commit") ??
  (deletionCommit === "" ? git("rev-parse", "HEAD") : git("rev-parse", `${deletionCommit}~1`));

// --- extract TS snapshot --------------------------------------------------

const work = mkdtempSync(path.join(tmpdir(), "machines-diff-"));
const tsRoot = path.join(work, "ts");
mkdirSync(tsRoot, { recursive: true });
{
  // plugins/machines (TS sources) + packages/* (shared TS deps it
  // imports: herdr-client socket/target, tui components).
  const archive = spawnSync("git", ["archive", tsCommit, "plugins/machines", "packages"], {
    cwd: REPO_ROOT,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    throw new Error(`git archive ${tsCommit} failed: ${archive.stderr}`);
  }
  const tar = spawnSync("tar", ["-x", "-C", tsRoot], {
    input: archive.stdout as Buffer,
    encoding: null,
  });
  if (tar.status !== 0) throw new Error(`tar extract failed: ${tar.stderr}`);
}
const tsCli = path.join(tsRoot, "plugins/machines/src/cli.ts");
const tsTui = path.join(tsRoot, "plugins/machines/src/tui.ts");
const rustBin = machinesBinary();

// --- stub herdr -------------------------------------------------------------
//
// File-driven canned `herdr` CLI. Layout under $MACHINES_STUB_DIR:
//   machines.json                     — `machine list --json` payload
//   fail-list                         — presence: machine list exits 1
//   snapshot-<id>.json                — api snapshot `result` payload
//   snapshotbare-<id>.json            — api snapshot result WITHOUT the
//                                       `snapshot` wrapper (bare fields)
//   plugins-<id>.json                 — plugin list `result` payload
//   fail-snapshot-<id>                — api snapshot exits 3 (unreachable)
//   bridge-<id>                       — api snapshot emits an {error}
//                                       envelope (unsupported_remote)
//   fail-plugins-<id>                 — plugin list exits 1
//                                       (plugin_surface unsupported)
//   envdump                           — presence: stub appends its env
//                                       (HERDR_SOCKET_PATH/HERDR_SESSION)
//                                       to $MACHINES_STUB_DIR/env.log

const stubDir = path.join(work, "stub-herdr");
mkdirSync(stubDir, { recursive: true });
const stubBinDir = path.join(work, "stub-bin");
mkdirSync(stubBinDir, { recursive: true });

const HERDR_STUB = `#!/bin/sh
# herdr stub for diff-machines harness. File-driven canned responses.
D="$MACHINES_STUB_DIR"
if [ "$1" = "machine" ] && [ "$2" = "list" ]; then
  if [ -f "$D/envdump" ]; then
    { echo "SOCKET=\${HERDR_SOCKET_PATH:-}"; echo "SESSION=\${HERDR_SESSION:-}"; } >> "$D/env.log"
  fi
  if [ -f "$D/fail-list" ]; then echo "herdr: no saved machines backend" >&2; exit 1; fi
  cat "$D/machines.json"; exit 0
fi
if [ "$1" = "--machine" ]; then
  id="$2"; shift 2
  if [ -f "$D/envdump" ]; then
    { echo "SOCKET=\${HERDR_SOCKET_PATH:-}"; echo "SESSION=\${HERDR_SESSION:-}"; } >> "$D/env.log"
  fi
  # remaining argv: "api snapshot" | "plugin list --json"
  case "$1" in
    api)
      if [ -f "$D/fail-snapshot-$id" ]; then echo "ssh: connect to host failed" >&2; exit 3; fi
      if [ -f "$D/bridge-$id" ]; then
        printf '%s\\n' '{"id":"stub","error":{"code":"unsupported","message":"remote machine does not support machine API forwarding (remote-api-bridge)"}}'
        exit 0
      fi
      if [ -f "$D/snapshotbare-$id.json" ]; then
        printf '%s\\n' "{\\"id\\":\\"stub\\",\\"result\\":$(cat "$D/snapshotbare-$id.json")}"
      else
        printf '%s\\n' "{\\"id\\":\\"stub\\",\\"result\\":{\\"snapshot\\":$(cat "$D/snapshot-$id.json")}}"
      fi
      exit 0 ;;
    plugin)
      if [ -f "$D/fail-plugins-$id" ]; then echo "plugin list: method not found" >&2; exit 1; fi
      printf '%s\\n' "{\\"id\\":\\"stub\\",\\"result\\":{\\"plugins\\":$(cat "$D/plugins-$id.json")}}"
      exit 0 ;;
  esac
fi
echo "herdr stub: unsupported args: $*" >&2
exit 9
`;
{
  const stubPath = path.join(stubBinDir, "herdr");
  writeFileSync(stubPath, HERDR_STUB);
  chmodSync(stubPath, 0o755);
}

// --- fixture data ----------------------------------------------------------

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

/** Reset the stub dir to the full mixed-machine fixture. */
function resetStub(): void {
  for (const f of [
    "machines.json",
    "fail-list",
    "envdump",
    "env.log",
    "snapshot-m-ok.json",
    "snapshotbare-m-bare.json",
    "plugins-m-ok.json",
    "plugins-m-bare.json",
    "plugins-m-noplugin.json",
    "snapshot-m-bridge.json",
    "snapshot-m-dead.json",
    "snapshot-m-noplugin.json",
    "snapshot-m-twin-a.json",
    "snapshot-m-twin-b.json",
    "plugins-m-twin-a.json",
    "plugins-m-twin-b.json",
    "fail-snapshot-m-dead",
    "bridge-m-bridge",
    "fail-plugins-m-noplugin",
    "fail-list-nonjson",
  ]) {
    try {
      rmSync(path.join(stubDir, f), { force: true });
    } catch {
      /* ignore */
    }
  }
  writeJson(path.join(stubDir, "machines.json"), [
    {
      id: "m-ok",
      label: "Lab Box",
      target: "lab.example.com",
      session: "agents",
      enabled: true,
      selected: false,
    },
    {
      id: "m-bare",
      label: "Bare Snap",
      target: "bare.example.com",
      session: "default",
      enabled: true,
    },
    {
      id: "m-disabled",
      label: "Old Box",
      target: "old.example.com",
      session: "default",
      enabled: false,
      selected: true,
    },
    {
      id: "m-bridge",
      label: "Bridge Box",
      target: "bridge.example.com",
      session: "default",
      enabled: true,
    },
    {
      id: "m-dead",
      label: "Dead Box",
      target: "dead.example.com",
      session: "default",
      enabled: true,
    },
    {
      id: "m-noplugin",
      label: "NoPlugin Box",
      target: "noplugin.example.com",
      session: "default",
      enabled: true,
    },
    {
      id: "m-twin-a",
      label: "Twin",
      target: "twin-a.example.com",
      session: "default",
      enabled: true,
    },
    {
      id: "m-twin-b",
      label: "twin",
      target: "twin-b.example.com",
      session: "default",
      enabled: true,
    },
    // Malformed entries must be skipped by both implementations.
    { id: "m-no-target" },
    "not-an-object",
    null,
  ]);
  writeJson(path.join(stubDir, "snapshot-m-ok.json"), {
    version: "0.9.5",
    protocol: 22,
  });
  writeJson(path.join(stubDir, "snapshotbare-m-bare.json"), {
    version: "0.9.4",
    protocol: 21,
  });
  writeJson(path.join(stubDir, "plugins-m-ok.json"), [
    { plugin_id: "rebuildup.inbox", name: "Inbox", version: "0.7.0" },
    { id: "rebuildup.git", name: "Git" },
    { plugin_id: "rebuildup.malformed-no-name" },
    { no_id_field: true },
  ]);
  writeJson(path.join(stubDir, "plugins-m-bare.json"), []);
  writeJson(path.join(stubDir, "plugins-m-noplugin.json"), [
    { plugin_id: "rebuildup.usage", name: "Usage", version: "0.6.0" },
  ]);
  for (const id of ["m-bridge", "m-dead", "m-noplugin", "m-twin-a", "m-twin-b"]) {
    writeJson(path.join(stubDir, `snapshot-${id}.json`), {
      version: "0.9.5",
      protocol: 22,
    });
  }
  writeJson(path.join(stubDir, "plugins-m-twin-a.json"), [
    { plugin_id: "rebuildup.inbox", name: "Inbox", version: "0.7.0" },
  ]);
  writeJson(path.join(stubDir, "plugins-m-twin-b.json"), [
    { plugin_id: "rebuildup.git", name: "Git", version: "0.7.0" },
  ]);
}

// --- runners ---------------------------------------------------------------

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Step {
  /** argv for the Rust binary */
  rs: string[];
  /** argv for `bun <tsScript> ...` (defaults to rs argv on cli.ts) */
  ts?: string[];
  /** TS entry script (default cli.ts; the non-TTY fallback uses tui.ts) */
  tsScript?: "cli" | "tui";
  /** stdin for both children (default "ignore" → non-TTY) */
  stdin?: "ignore" | "pipe";
}

function runTs(step: Step, env: Record<string, string>): Promise<RunResult> {
  const script = step.tsScript === "tui" ? tsTui : tsCli;
  const argv = step.ts ?? step.rs;
  return runProc(["bun", script, ...argv], env, step.stdin ?? "ignore");
}
function runRust(step: Step, env: Record<string, string>): Promise<RunResult> {
  return runProc([rustBin, ...step.rs], env, step.stdin ?? "ignore");
}
async function runProc(
  cmd: string[],
  env: Record<string, string>,
  stdinMode: "ignore" | "pipe",
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdinMode === "ignore" ? "ignore" : "pipe",
  });
  if (stdinMode === "pipe" && proc.stdin) proc.stdin.end();
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

interface Dirs {
  stateDir: string;
  configDir: string;
}
function freshDirs(tag: string): Dirs {
  const dir = mkdtempSync(path.join(tmpdir(), `machines-diff-${tag}-`));
  return { stateDir: path.join(dir, "state"), configDir: path.join(dir, "config") };
}

function cliEnv(dirs: Dirs, herdrBin: string): Record<string, string> {
  return testEnv({
    HERDR_BIN_PATH: herdrBin,
    HERDR_PLUGIN_STATE_DIR: dirs.stateDir,
    HERDR_PLUGIN_CONFIG_DIR: dirs.configDir,
    MACHINES_STUB_DIR: stubDir,
  });
}

// --- normalization ----------------------------------------------------------

const VOLATILE_KEYS = new Set(["generated_at", "probed_at"]);
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

let scrubPaths: string[] = [];
function scrubPathsInit(tsDirs: Dirs, rsDirs: Dirs, missingHerdr: string) {
  const candidates = [
    stubDir,
    stubBinDir,
    realpathSync(stubDir),
    realpathSync(stubBinDir),
    tsDirs.stateDir,
    tsDirs.configDir,
    rsDirs.stateDir,
    rsDirs.configDir,
    realpathSync(path.dirname(tsDirs.stateDir)),
    realpathSync(path.dirname(rsDirs.stateDir)),
    // stderr may embed the invoked binary/script paths (spawn errors,
    // bun diagnostics).
    rustBin,
    realpathSync(rustBin),
    tsRoot,
    realpathSync(tsRoot),
    missingHerdr,
  ];
  scrubPaths = [...new Set(candidates.filter(Boolean))].sort((a, b) => b.length - a.length);
}

function scrubString(s: string): string {
  let out = s;
  for (const p of scrubPaths) {
    if (p && out.includes(p)) out = out.split(p).join("<tmp>");
  }
  return (
    out
      // Non-TTY fallback hint + usage strings name the CLI invocation:
      // TS prints `bun run src/cli.ts …`, the shipped binary prints
      // `machines …`.
      .split("bun run src/cli.ts")
      .join("machines")
      // The missing-herdr spawn error embeds the (per-side identical)
      // nonexistent path; keep the shape, scrub the tail detail.
      .replace(/Error: spawn \S+ ENOENT/g, "Error: spawn <bin> ENOENT")
      .replace(/Error: spawn \S+ [^\s]+/g, "Error: spawn <bin> <err>")
  );
}

function normalize(value: unknown, key?: string, strip?: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    if (key !== undefined && VOLATILE_KEYS.has(key)) return "<volatile>";
    if (ISO_TS.test(value)) return "<volatile>";
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v, undefined, strip));
  }
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const keys = Object.keys(src).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (strip?.has(k)) continue;
      out[scrubString(k)] = normalize(src[k], k, strip);
    }
    return out;
  }
  return value;
}

function parseJsonOrText(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return scrubString(stdout);
  }
}

// stderr carries either nothing (success) or a single-line JSON error
// envelope `{contract, ok:false, error:{...}}`; fall back to per-line
// normalization for anything else.
function normalizeStderr(stderr: string): unknown {
  const trimmed = stderr.trim();
  if (trimmed === "") return "";
  try {
    return normalize(JSON.parse(trimmed));
  } catch {
    return trimmed.split("\n").map((line) => {
      const t = line.trim();
      if (t === "") return "";
      try {
        return normalize(JSON.parse(t));
      } catch {
        return scrubString(t);
      }
    });
  }
}

// --- scenarios ---------------------------------------------------------------

interface Scenario {
  name: string;
  setup?: () => void;
  steps: Step[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "usage-errors",
    steps: [
      { rs: ["bogus"] },
      { rs: ["list", "--bogus"] },
      { rs: ["list", "extra"] },
      { rs: ["list", "--socket"] },
      { rs: ["probe"] },
      { rs: ["probe", "--socket", "/tmp/fake.sock"] },
      { rs: ["probe", "--all", "m-ok", "--session", "agents"] },
      { rs: ["capability", "extra"] },
      // TS entry is src/tui.ts itself: argv[2] is the subcommand.
      { rs: ["tui", "bogus"], tsScript: "tui", ts: ["bogus"] },
    ],
  },
  {
    name: "capability-help",
    steps: [{ rs: ["capability"] }, { rs: ["help"] }, { rs: ["--help"] }],
  },
  {
    name: "list-fresh",
    steps: [{ rs: ["list"] }, { rs: ["list", "--socket", "/tmp/x.sock", "--session", "agents"] }],
  },
  {
    name: "probe-single",
    steps: [
      { rs: ["probe", "m-ok"] },
      // Label resolution is case-insensitive; id wins over label.
      { rs: ["probe", "lab box"] },
      { rs: ["probe", "Bare Snap"] },
    ],
  },
  {
    name: "probe-states",
    steps: [
      { rs: ["probe", "m-disabled"] },
      { rs: ["probe", "m-dead"] },
      { rs: ["probe", "m-bridge"] },
      { rs: ["probe", "m-noplugin"] },
      // unknown + ambiguous selectors are usage errors (exit 2)
      { rs: ["probe", "no-such-machine"] },
      { rs: ["probe", "Twin"] },
    ],
  },
  {
    name: "probe-all",
    steps: [{ rs: ["probe", "--all"] }],
  },
  {
    name: "list-after-probe",
    // last_probe merges from plugin state; state_file paths are scrubbed.
    steps: [{ rs: ["list"] }],
  },
  {
    name: "tui-non-tty",
    // Piped stdin → honest plain-text list (no fake TUI).
    steps: [{ rs: ["tui"], tsScript: "tui", ts: [] }],
  },
  {
    name: "list-failure",
    setup: () => writeFileSync(path.join(stubDir, "fail-list"), ""),
    steps: [{ rs: ["list"] }, { rs: ["probe", "--all"] }],
  },
  {
    name: "list-non-json",
    setup: () => {
      rmSync(path.join(stubDir, "machines.json"), { force: true });
      writeFileSync(path.join(stubDir, "machines.json"), "this is not json\n");
    },
    steps: [{ rs: ["list"] }],
  },
  {
    name: "target-flags-env",
    // envdump makes the stub record HERDR_SOCKET_PATH/HERDR_SESSION;
    // --socket/--session must be forwarded as env (the herdr CLI has
    // no target flags). Verified via env.log afterwards.
    setup: () => writeFileSync(path.join(stubDir, "envdump"), ""),
    steps: [
      { rs: ["list", "--socket", "/tmp/diff.sock", "--session", "agents"] },
      { rs: ["probe", "m-ok", "--session", "agents"] },
      // No flags → ambient HERDR_* stripped, nothing re-injected.
      { rs: ["list"] },
    ],
  },
];

// --- runner -----------------------------------------------------------------

const tsState = freshDirs("ts");
const rsState = freshDirs("rs");
const missingHerdr = path.join(work, "no-such-herdr");
scrubPathsInit(tsState, rsState, missingHerdr);

let failures = 0;
let comparisons = 0;

async function runScenario(sc: Scenario): Promise<void> {
  resetStub();
  sc.setup?.();
  for (const [i, step] of sc.steps.entries()) {
    const tsEnv = cliEnv(tsState, path.join(stubBinDir, "herdr"));
    const rsEnv = cliEnv(rsState, path.join(stubBinDir, "herdr"));
    const [ts, rs] = await Promise.all([runTs(step, tsEnv), runRust(step, rsEnv)]);
    comparisons += 1;
    const label = `${sc.name}#${i + 1} ${step.rs.join(" ")}`;
    const tsNorm = {
      status: ts.status,
      stdout: normalize(parseJsonOrText(ts.stdout)),
      stderr: normalizeStderr(ts.stderr),
    };
    const rsNorm = {
      status: rs.status,
      stdout: normalize(parseJsonOrText(rs.stdout)),
      stderr: normalizeStderr(rs.stderr),
    };
    const tsJson = JSON.stringify(tsNorm, null, 2);
    const rsJson = JSON.stringify(rsNorm, null, 2);
    if (tsJson !== rsJson) {
      failures += 1;
      console.error(`DIFF ${label}`);
      console.error(`  ts:   ${tsJson.slice(0, 2000)}`);
      console.error(`  rust: ${rsJson.slice(0, 2000)}`);
    } else {
      console.log(`ok   ${label} (exit ${ts.status})`);
    }
  }
}

for (const sc of SCENARIOS) {
  await runScenario(sc);
}

// Missing-herdr spawn failure parity (both must fail machine_list_failed).
{
  const tsEnv = cliEnv(tsState, missingHerdr);
  const rsEnv = cliEnv(rsState, missingHerdr);
  const [ts, rs] = await Promise.all([
    runTs({ rs: ["list"] }, tsEnv),
    runRust({ rs: ["list"] }, rsEnv),
  ]);
  comparisons += 1;
  const tsNorm = {
    status: ts.status,
    stdout: normalize(parseJsonOrText(ts.stdout)),
    stderr: normalizeStderr(ts.stderr),
  };
  const rsNorm = {
    status: rs.status,
    stdout: normalize(parseJsonOrText(rs.stdout)),
    stderr: normalizeStderr(rs.stderr),
  };
  // Documented divergence: the spawn-failure message text is
  // runtime-specific (Bun reports "Error: ENOENT: no such file or
  // directory, posix_spawn '<path>'"; Rust reports its own io error).
  // The contract surface — exit code, error.code, error.kind — is what
  // parity covers here.
  for (const side of [tsNorm, rsNorm]) {
    const err = (side.stderr as { error?: { message?: string } }).error;
    if (err?.message?.includes("herdr machine list failed:")) {
      err.message = "herdr machine list failed: <spawn-error>";
    }
  }
  if (JSON.stringify(tsNorm) === JSON.stringify(rsNorm)) {
    console.log(`ok   missing-herdr list (exit ${ts.status})`);
  } else {
    failures += 1;
    console.error("DIFF missing-herdr list");
    console.error(`  ts:   ${JSON.stringify(tsNorm).slice(0, 1200)}`);
    console.error(`  rust: ${JSON.stringify(rsNorm).slice(0, 1200)}`);
  }
}

// target-flags-env: verify the stub observed the forwarded env vars.
// Recorded invocations per side: list(--socket+--session) ×1,
// probe m-ok --session agents → machine list + api snapshot + plugin
// list ×3, bare list ×1 = 5 stub calls. BOTH implementations log into
// the same env.log (they run concurrently), so expect double counts:
// SOCKET=/tmp/diff.sock ×2, SESSION=agents ×8, empty SESSION ×2.
{
  const envLog = path.join(stubDir, "env.log");
  const log = readFileSync(envLog, "utf8");
  const sockets = log.match(/SOCKET=[^\n]*/g) ?? [];
  const sessions = log.match(/SESSION=[^\n]*/g) ?? [];
  const ok =
    sockets.filter((s) => s === "SOCKET=/tmp/diff.sock").length === 2 &&
    sessions.filter((s) => s === "SESSION=agents").length === 8 &&
    sessions.filter((s) => s === "SESSION=").length === 2;
  comparisons += 1;
  if (ok) {
    console.log("ok   target-flags env forwarding");
  } else {
    failures += 1;
    console.error(`DIFF target-flags env forwarding\n${log}`);
  }
}

// State-file sanity: both sides must have recorded probes under their
// own state dirs (normalized compare of the probes key set).
{
  const tsStateFile = path.join(tsState.stateDir, "state.json");
  const rsStateFile = path.join(rsState.stateDir, "state.json");
  const keysOf = (f: string): string[] => {
    try {
      const doc = JSON.parse(readFileSync(f, "utf8")) as {
        version?: number;
        probes?: Record<string, { state?: string }>;
      };
      return Object.entries(doc.probes ?? {})
        .map(([id, p]) => `${id}:${p.state ?? "?"}`)
        .sort();
    } catch {
      return [];
    }
  };
  const tsKeys = keysOf(tsStateFile);
  const rsKeys = keysOf(rsStateFile);
  comparisons += 1;
  if (JSON.stringify(tsKeys) === JSON.stringify(rsKeys) && tsKeys.length > 0) {
    console.log(`ok   state probes parity (${tsKeys.length} machines)`);
  } else {
    failures += 1;
    console.error(`DIFF state probes parity\n  ts:  ${tsKeys}\n  rs:  ${rsKeys}`);
  }
}

console.log(`\n${comparisons - failures}/${comparisons} comparisons identical`);
if (keepTmp) {
  console.log(`kept ${work}`);
} else {
  rmSync(work, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`${failures} diff(s) found`);
  process.exit(1);
}
