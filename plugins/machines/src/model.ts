/**
 * Contract model for `rebuildup.machines` — `herdr-plugins.machines/v1`
 * (issue #161, parent #34, boundary ADR-0028).
 *
 * Read-only inventory over herdr saved machines: enumeration comes from
 * `herdr machine list --json`; probing goes through the ADR-0020 path
 * (`herdr --machine <id> <cli>` → remote `SavedSshApiBridge`). The
 * plugin never mutates machine lifecycle (add/remove/enable/disable is
 * the herdr CLI's job) and never touches credentials — SSH auth is
 * OpenSSH-owned; target strings are passed to argv only.
 */

export const CONTRACT = "herdr-plugins.machines/v1";
export const CONTRACT_STATUS = "draft";
export const PLUGIN_ID = "rebuildup.machines";
export const PLUGIN_VERSION = "0.1.0";
export const STATE_SCHEMA_VERSION = 1;

/** Commands implemented by this plugin version. */
export const IMPLEMENTED_COMMANDS = ["capability", "list", "probe"] as const;

/**
 * Probe outcome taxonomy. Every value is honest — the plugin reports
 * what it observed, never a guessed success:
 *
 * - `ok` — remote `api snapshot` answered; version/protocol recorded.
 * - `disabled` — herdr reports the machine disabled; not probed (no SSH
 *   attempt). Enable via `herdr machine enable <id>`.
 * - `unreachable` — bridge/SSH/session failure before a remote answer.
 * - `unsupported_remote` — remote answered but lacks machine API
 *   forwarding (`remote-api-bridge`, per ADR-0020).
 * - `error` — anything else (malformed output, unexpected failure).
 */
export const PROBE_STATES = [
  "ok",
  "disabled",
  "unreachable",
  "unsupported_remote",
  "error",
] as const;
export type ProbeState = (typeof PROBE_STATES)[number];

/**
 * Remote plugin enumeration surface:
 *
 * - `supported` — `herdr --machine <id> plugin list --json` returned a
 *   `plugin_list` result envelope (API-backed; verified live on herdr
 *   0.9.5 / protocol 22 — see docs/research/machines-v1-live-verification.md).
 * - `unsupported` — the call failed or returned no usable result; the
 *   remote may predate the `plugin.list` API method.
 * - `unknown` — not probed (machine disabled/unreachable).
 */
export const PLUGIN_SURFACES = ["supported", "unsupported", "unknown"] as const;
export type PluginSurface = (typeof PLUGIN_SURFACES)[number];

/** One saved machine as reported by `herdr machine list --json`. */
export interface MachineEntry {
  id: string;
  label: string;
  /** SSH target (host alias / user@host) — passed to argv only. */
  target: string;
  /** Remote herdr session name bound to the profile. */
  session: string;
  enabled: boolean;
  /** herdr's own "selected" marker when present; null when absent. */
  selected: boolean | null;
}

/** A plugin entry from remote `plugin list` (fields tolerated loosely). */
export interface RemotePluginEntry {
  id: string;
  name: string | null;
  version: string | null;
}

/**
 * Result of probing one saved machine. Stored in plugin state as the
 * last-known probe metadata (timestamps, versions, reachability — never
 * credential-adjacent, ADR-0028 §3).
 */
export interface MachineProbe {
  contract: typeof CONTRACT;
  machine_id: string;
  state: ProbeState;
  probed_at: string;
  /** Null when the machine was not probed (disabled). */
  reachable: boolean | null;
  /** Remote `session.snapshot` version; null when unreachable. */
  server_version: string | null;
  /** Remote API protocol; null when unreachable. */
  protocol: number | null;
  plugin_surface: PluginSurface;
  /** Remote plugin entries; null when not enumerated. */
  plugins: RemotePluginEntry[] | null;
  /** Why plugin_surface is not "supported"; null otherwise. */
  plugin_surface_error: string | null;
  /** Coarse error kind when state != ok (e.g. remote_timeout). */
  error_kind: string | null;
  /** Human-readable error detail; null on success. */
  error: string | null;
}
