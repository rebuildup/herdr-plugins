import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { testEnv } from "./test-env";

/**
 * Locate a runnable rebuildup.machines native binary (Issue #326,
 * ADR-0035): the committed prebuilt `plugins/machines/bin/machines`
 * first, then cargo `target/debug`/`target/release` outputs, building
 * debug as a last resort. Shared by the native contract suite and the
 * diff-parity harness.
 */
export function machinesBinary(): string {
  const repoRoot = path.join(import.meta.dir, "..", "..");
  const candidates = [
    path.join(repoRoot, "plugins", "machines", "bin", "machines"),
    path.join(repoRoot, "target", "debug", "machines"),
    path.join(repoRoot, "target", "release", "machines"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["capability"], {
      encoding: "utf8",
      env: testEnv(),
      timeout: 15_000,
    });
    if (probe.status === 0) return candidate;
  }
  const build = spawnSync("cargo", ["build", "-p", "machines"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
  });
  const debugBin = path.join(repoRoot, "target", "debug", "machines");
  if (build.status === 0 && existsSync(debugBin)) return debugBin;
  throw new Error(
    `machines binary not runnable (bin/, target/debug, target/release all failed; ` +
      `cargo build -p machines exited ${build.status}): ${build.stderr?.slice(0, 400)}`,
  );
}
