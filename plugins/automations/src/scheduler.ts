/**
 * OS scheduler adapters for `automations schedule install|uninstall|
 * status` (#145, ADR-0022 §3).
 *
 * ONE scheduler entry per plugin invokes `automations tick` — never
 * per-task entries. The plugin holds no clock; the OS supplies it.
 *
 * - macOS: launchd agent, `StartInterval` 60 s.
 * - Linux: systemd --user timer, `OnUnitActiveSec=1min`,
 *   `Persistent=true` (catch-up after downtime).
 * - Windows: schtasks `/sc minute /mo 1`.
 *
 * The entry command is `[bun, <abs cli.ts>, "tick", "--socket",
 * <abs socket path>]` — resolved at install time so the entry hits
 * the same session-namespaced registry the CLI targets. All side
 * effects go through an injectable `run`/fs layer so contract tests
 * drive a fake scheduler; real invocations use `execFile`.
 */

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AutomationsError } from "./model";
import { stateFilePath } from "./state";

const execFileAsync = promisify(execFile);

export const TICK_ENTRY_LABEL = "rebuildup.automations.tick";
export const TICK_INTERVAL_SECONDS = 60;

export interface TickCommand {
  /** Absolute bun executable (process.execPath at install time). */
  bun: string;
  /** Absolute path to plugins/automations/src/cli.ts. */
  cli: string;
  /** Absolute herdr socket path the tick targets. */
  socketPath: string;
}

export function tickArgv(cmd: TickCommand): string[] {
  return [cmd.cli, "tick", "--socket", cmd.socketPath];
}

// --- Injectable seams ---------------------------------------------------------

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

export interface SchedulerDeps {
  run: CommandRunner;
  homeDir: string;
  /** Plugin state dir — scheduler logs land here (never source tree). */
  stateDir: string;
  platform: string;
  exists?: ((p: string) => Promise<boolean>) | undefined;
}

async function defaultExists(p: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export const realCommandRunner: CommandRunner = async (file, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as {
      code?: number | string;
      stdout?: unknown;
      stderr?: unknown;
      message?: string;
    };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
    };
  }
};

// --- Adapter contract ---------------------------------------------------------

export type ScheduleStatus = "installed" | "missing" | "stale" | "error";

export interface AdapterResult {
  ok: boolean;
  detail: string;
}

export interface SchedulerAdapter {
  readonly platform: string;
  install(cmd: TickCommand): Promise<AdapterResult>;
  uninstall(): Promise<AdapterResult>;
  status(): Promise<{ state: ScheduleStatus; detail: string }>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// --- macOS launchd ------------------------------------------------------------

function launchdAdapter(deps: SchedulerDeps): SchedulerAdapter {
  const exists = deps.exists ?? defaultExists;
  const agentsDir = path.join(deps.homeDir, "Library", "LaunchAgents");
  const plistPath = path.join(agentsDir, `${TICK_ENTRY_LABEL}.plist`);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const logDir = deps.stateDir;

  const plistXml = (cmd: TickCommand): string => {
    const args = [cmd.bun, ...tickArgv(cmd)]
      .map((a) => `    <string>${xmlEscape(a)}</string>`)
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${TICK_ENTRY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key><integer>${TICK_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(logDir, "tick.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(logDir, "tick.err.log"))}</string>
</dict>
</plist>
`;
  };

  const loaded = async (): Promise<boolean> => {
    const res = await deps.run("launchctl", ["print", `${domain}/${TICK_ENTRY_LABEL}`]);
    return res.code === 0;
  };

  return {
    platform: "darwin",
    async install(cmd) {
      await mkdir(agentsDir, { recursive: true });
      await mkdir(logDir, { recursive: true });
      await writeFile(plistPath, plistXml(cmd));
      // Modern bootstrap first; `launchctl load` is the legacy fallback.
      let res = await deps.run("launchctl", ["bootstrap", domain, plistPath]);
      if (res.code !== 0) {
        res = await deps.run("launchctl", ["load", "-w", plistPath]);
      }
      if (res.code !== 0) {
        return {
          ok: false,
          detail: `launchctl failed (code ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 300)}`,
        };
      }
      return { ok: true, detail: `launchd agent '${TICK_ENTRY_LABEL}' installed (${plistPath})` };
    },
    async uninstall() {
      // bootout ignores "not loaded"; unload covers legacy loads.
      await deps.run("launchctl", ["bootout", `${domain}/${TICK_ENTRY_LABEL}`]);
      await deps.run("launchctl", ["unload", "-w", plistPath]);
      await rm(plistPath, { force: true });
      return { ok: true, detail: `launchd agent '${TICK_ENTRY_LABEL}' removed` };
    },
    async status() {
      const plistExists = await exists(plistPath);
      const isLoaded = await loaded();
      if (isLoaded) {
        return { state: "installed", detail: `launchd agent '${TICK_ENTRY_LABEL}' loaded` };
      }
      if (plistExists) {
        return {
          state: "stale",
          detail: `plist exists at ${plistPath} but the agent is not loaded`,
        };
      }
      return { state: "missing", detail: "no launchd entry installed" };
    },
  };
}

// --- Linux systemd --user -------------------------------------------------------

function systemdAdapter(deps: SchedulerDeps): SchedulerAdapter {
  const exists = deps.exists ?? defaultExists;
  const unitDir = path.join(deps.homeDir, ".config", "systemd", "user");
  const serviceName = `${TICK_ENTRY_LABEL}.service`;
  const timerName = `${TICK_ENTRY_LABEL}.timer`;
  const servicePath = path.join(unitDir, serviceName);
  const timerPath = path.join(unitDir, timerName);

  const unitFiles = (cmd: TickCommand): { service: string; timer: string } => {
    const exec = [cmd.bun, ...tickArgv(cmd)].map(shellQuote).join(" ");
    return {
      service: `[Unit]
Description=herdr-plugins automations tick (rebuildup.automations)

[Service]
Type=oneshot
ExecStart=${exec}
`,
      timer: `[Unit]
Description=herdr-plugins automations tick timer

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
Persistent=true
Unit=${serviceName}

[Install]
WantedBy=timers.target
`,
    };
  };

  const query = async (verb: string): Promise<string> => {
    const res = await deps.run("systemctl", ["--user", verb, `${TICK_ENTRY_LABEL}.timer`]);
    return (res.stdout || res.stderr).trim();
  };

  return {
    platform: "linux",
    async install(cmd) {
      const files = unitFiles(cmd);
      await mkdir(unitDir, { recursive: true });
      await writeFile(servicePath, files.service);
      await writeFile(timerPath, files.timer);
      let res = await deps.run("systemctl", ["--user", "daemon-reload"]);
      if (res.code !== 0) {
        return {
          ok: false,
          detail: `systemctl daemon-reload failed: ${res.stderr.trim().slice(0, 300)}`,
        };
      }
      res = await deps.run("systemctl", ["--user", "enable", "--now", `${TICK_ENTRY_LABEL}.timer`]);
      if (res.code !== 0) {
        return { ok: false, detail: `systemctl enable failed: ${res.stderr.trim().slice(0, 300)}` };
      }
      return { ok: true, detail: `systemd --user timer '${TICK_ENTRY_LABEL}' installed` };
    },
    async uninstall() {
      await deps.run("systemctl", ["--user", "disable", "--now", `${TICK_ENTRY_LABEL}.timer`]);
      await deps.run("systemctl", ["--user", "daemon-reload"]);
      await rm(servicePath, { force: true });
      await rm(timerPath, { force: true });
      return { ok: true, detail: `systemd --user timer '${TICK_ENTRY_LABEL}' removed` };
    },
    async status() {
      const filesExist = (await exists(timerPath)) && (await exists(servicePath));
      if (!filesExist) {
        const enabled = await query("is-enabled");
        if (enabled === "enabled" || enabled === "enabled-runtime") {
          return {
            state: "stale",
            detail: "systemd reports the timer enabled but unit files are missing",
          };
        }
        return { state: "missing", detail: "no systemd user timer installed" };
      }
      const [enabled, active] = await Promise.all([query("is-enabled"), query("is-active")]);
      if (enabled === "enabled" && active === "active") {
        return { state: "installed", detail: "systemd --user timer active" };
      }
      return {
        state: "stale",
        detail: `unit files present but timer is-enabled='${enabled}' is-active='${active}'`,
      };
    },
  };
}

// --- Windows schtasks ------------------------------------------------------------

function schtasksAdapter(deps: SchedulerDeps): SchedulerAdapter {
  const taskName = TICK_ENTRY_LABEL;
  const quoted = (cmd: TickCommand): string =>
    `"${cmd.bun}" ${tickArgv(cmd)
      .map((a) => `"${a}"`)
      .join(" ")}`;

  return {
    platform: "win32",
    async install(cmd) {
      const res = await deps.run("schtasks", [
        "/create",
        "/tn",
        taskName,
        "/sc",
        "minute",
        "/mo",
        "1",
        "/tr",
        quoted(cmd),
        "/f",
      ]);
      if (res.code !== 0) {
        return {
          ok: false,
          detail: `schtasks /create failed: ${(res.stderr || res.stdout).trim().slice(0, 300)}`,
        };
      }
      return { ok: true, detail: `schtasks entry '${taskName}' installed` };
    },
    async uninstall() {
      const res = await deps.run("schtasks", ["/delete", "/tn", taskName, "/f"]);
      if (
        res.code !== 0 &&
        !/cannot find|ERROR: The system cannot find/i.test(res.stderr + res.stdout)
      ) {
        return {
          ok: false,
          detail: `schtasks /delete failed: ${(res.stderr || res.stdout).trim().slice(0, 300)}`,
        };
      }
      return { ok: true, detail: `schtasks entry '${taskName}' removed` };
    },
    async status() {
      const res = await deps.run("schtasks", ["/query", "/tn", taskName]);
      if (res.code === 0) {
        return { state: "installed", detail: `schtasks entry '${taskName}' present` };
      }
      return { state: "missing", detail: "no schtasks entry installed" };
    },
  };
}

/**
 * Pick the adapter for the host platform. Unsupported platforms get an
 * honest error — `schedule status` still reports `none`-equivalent
 * (`error` detail) rather than pretending coverage.
 */
export function schedulerAdapterFor(
  platform: string,
  deps: Omit<SchedulerDeps, "platform">,
): SchedulerAdapter {
  const full: SchedulerDeps = { ...deps, platform };
  if (platform === "darwin") return launchdAdapter(full);
  if (platform === "linux") return systemdAdapter(full);
  if (platform === "win32") return schtasksAdapter(full);
  return {
    platform,
    async install() {
      throw new AutomationsError(
        "unsupported_platform",
        `no OS scheduler adapter for platform '${platform}' (supported: darwin/linux/win32)`,
      );
    },
    async uninstall() {
      throw new AutomationsError(
        "unsupported_platform",
        `no OS scheduler adapter for platform '${platform}'`,
      );
    },
    async status() {
      return {
        state: "error",
        detail: `no OS scheduler adapter for platform '${platform}' — use opt-in \`watch\` instead`,
      };
    },
  };
}

/** Production deps: real execFile, real HOME, real fs. */
export function productionSchedulerDeps(): Omit<SchedulerDeps, "platform"> {
  return {
    run: realCommandRunner,
    homeDir: os.homedir(),
    stateDir: path.dirname(stateFilePath()),
  };
}
