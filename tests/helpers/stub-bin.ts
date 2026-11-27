/**
 * Cross-platform fake-binary installer for the test suite (issue #225).
 *
 * Tests stub external CLIs (`gh`, `infisical`, `git`) by dropping an
 * executable into a temp `bin/` dir prepended to `PATH`. The historical
 * stubs were extensionless POSIX shell scripts — on Windows, argv-only
 * `spawn()` (no shell) resolves only `.com`/`.exe` through libuv's
 * `search_path`, and Bun's `child_process` layer rejects explicit
 * `.cmd`/`.bat` paths outright, so shell stubs can never run there.
 *
 * `installStub` therefore keeps the POSIX shell script on macOS/Linux and,
 * on Windows, compiles the provided TypeScript twin into a real `.exe`
 * via `bun build --compile` (the test runner *is* bun, so
 * `process.execPath` is always available). Compiled output is cached per
 * source hash under the OS temp dir, so the ~second-long compile happens
 * once per stub per machine, not per test.
 *
 * Stub sources are plain scripts: `process.argv.slice(2)` holds the CLI
 * args (identical layout to `bun run script.ts …` and to a compiled
 * bun binary), env vars carry all per-test configuration, and exit codes
 * map to `process.exitCode`.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface StubSpec {
  /** Executable basename, e.g. `"gh"`. */
  name: string;
  /** POSIX shell script written verbatim to `bin/<name>` (mode 0755). */
  posix: string;
  /**
   * TypeScript source compiled to `bin/<name>.exe` on Windows. Must be
   * self-contained (node:/bun: builtins only — it is bundled, not
   * resolved from node_modules).
   */
  windows: string;
}

const IS_WINDOWS = process.platform === "win32";

function cacheRoot(): string {
  return path.join(tmpdir(), "herdr-test-stub-exe");
}

/**
 * Compile `source` to a cached `<name>.exe`. Returns the executable path.
 * Throws with the compiler output when `bun build --compile` fails —
 * an honest failure beats silently falling back to the real binary.
 */
function ensureStubExe(name: string, source: string): string {
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const dir = path.join(cacheRoot(), hash);
  const exe = path.join(dir, `${name}.exe`);
  if (existsSync(exe)) return exe;
  mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `${name}.ts`);
  writeFileSync(src, source);
  // Compile to a pid-unique name then rename: two test workers compiling
  // the same stub concurrently must never observe a half-written exe.
  // The name must already end in `.exe`: on Windows `bun build --compile`
  // appends `.exe` to an outfile lacking the extension, so a `.tmp`
  // outfile would produce `<tmp>.exe` and the existsSync check below
  // would never see it (issue #266).
  const tmp = path.join(dir, `${name}.exe.${process.pid}.tmp.exe`);
  const result = spawnSync(process.execPath, ["build", "--compile", src, "--outfile", tmp], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0 || !existsSync(tmp)) {
    throw new Error(
      `bun build --compile failed for test stub "${name}":\n${result.stderr ?? ""}${result.stdout ?? ""}`,
    );
  }
  renameSync(tmp, exe);
  return exe;
}

/**
 * Install `spec` into `binDir` so `spawn(<name>, …)` resolves it:
 * - POSIX: writes the shell script as `bin/<name>` (chmod 0755).
 * - Windows: compiles the TS twin to `bin/<name>.exe`.
 */
export function installStub(binDir: string, spec: StubSpec): void {
  mkdirSync(binDir, { recursive: true });
  if (IS_WINDOWS) {
    copyFileSync(ensureStubExe(spec.name, spec.windows), path.join(binDir, `${spec.name}.exe`));
    return;
  }
  const file = path.join(binDir, spec.name);
  writeFileSync(file, spec.posix);
  chmodSync(file, 0o755);
}
