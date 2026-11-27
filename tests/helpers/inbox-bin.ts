import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { testEnv } from "./test-env";

/**
 * Locate a runnable rebuildup.inbox native binary (Issue #291, ADR-0035):
 * the committed prebuilt `plugins/inbox/bin/inbox` first, then cargo
 * `target/debug`/`target/release` outputs, building debug as a last
 * resort. Shared by the native contract suite and cross-plugin tests
 * (herdr-target) that spawn the real binary.
 */
export function inboxBinary(): string {
  const repoRoot = path.join(import.meta.dir, "..", "..");
  const candidates = [
    path.join(repoRoot, "plugins", "inbox", "bin", "inbox"),
    path.join(repoRoot, "target", "debug", "inbox"),
    path.join(repoRoot, "target", "release", "inbox"),
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
  const build = spawnSync("cargo", ["build", "-p", "inbox"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
  });
  const debugBin = path.join(repoRoot, "target", "debug", "inbox");
  if (build.status === 0 && existsSync(debugBin)) return debugBin;
  throw new Error(
    `inbox binary not runnable (bin/, target/debug, target/release all failed; ` +
      `cargo build -p inbox exited ${build.status}): ${build.stderr?.slice(0, 400)}`,
  );
}
