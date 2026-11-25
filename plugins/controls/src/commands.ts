/**
 * Provider slash-command passthrough for `rebuildup.controls`
 * (Issue #101 / parent #27 T3).
 *
 * Mechanism (verified against herdr 0.9.5 `src/app/api/agents.rs` +
 * `src/app/api_helpers.rs`): `agent.prompt` types `text` into the
 * agent pane as bracketed-paste bytes followed by an encoded Enter
 * key (`queue_user_input_submission`). There is no structured
 * "run command" API — a slash command is just prompt text that must
 * *start the message* for the provider TUI to interpret it (T3 Code
 * `docs/user/composer.md`: "Provider commands must start the
 * message to run"). `command` therefore builds `/name args...` text
 * and forwards it through the same `agent.prompt` path as `send`.
 *
 * Honesty constraints:
 * - Whether `/name` is a real provider command is provider-TUI
 *   business; herdr and this plugin cannot verify it. The per-provider
 *   table below is advisory, version-dependent, and explicitly
 *   unverified — `known_command: false` results are still forwarded.
 * - `send_keys` is NOT the mechanism: commands are text submissions,
 *   not key sequences.
 */

import { ControlsError } from "./identity";
import { canonicalKind } from "./launch";

/**
 * Advisory slash-command table per canonical herdr agent kind.
 * Entries record commands documented by the provider or by T3 Code's
 * provider docs (`docs/user/providers-*.md`, composer.md); they are a
 * hint for `capability`/result echo only — never a gate. Providers
 * absent from the table have no verified entries (`commands: []`).
 */
export const PROVIDER_COMMANDS: Record<string, readonly string[]> = {
  claude: [
    "model",
    "clear",
    "compact",
    "resume",
    "init",
    "review",
    "status",
    "doctor",
    "config",
    "agents",
    "mcp",
    "permissions",
    "cost",
    "goal",
  ],
  codex: [
    "model",
    "approvals",
    "review",
    "new",
    "init",
    "compact",
    "diff",
    "status",
    "mcp",
    "mention",
    "logout",
    "goal",
  ],
  gemini: [
    "model",
    "compress",
    "chat",
    "restore",
    "stats",
    "memory",
    "tools",
    "mcp",
    "extensions",
    "auth",
    "vim",
    "theme",
    "editor",
  ],
  opencode: ["model", "agent", "init", "compact", "themes", "editor"],
  agy: ["compact", "clear", "goal", "plan", "logout"],
  kiro: ["compact"],
};

export const COMMAND_TABLE_NOTE =
  "Advisory per-provider slash-command list from provider/T3 Code docs; provider-version dependent and unverified — the provider TUI decides whether a command exists.";

/** `/name` token: letter followed by letters/digits/_/- (provider commands are lowercase-ish but case is preserved verbatim). */
const COMMAND_NAME_PATTERN = /^\/[A-Za-z][A-Za-z0-9_-]*$/;

/** Control characters would let args inject extra PTY submissions; reject them. */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export interface CommandBuild {
  /** Canonical command name without the leading slash, e.g. `model`. */
  name: string;
  /** Full prompt text submitted via agent.prompt; always starts with `/`. */
  text: string;
}

/**
 * Validate `<slash-command>` + args and build the prompt text. The
 * command must start the message (T3 contract rule); args are joined
 * with single spaces exactly like `send` — no quoting layer exists.
 */
export function buildCommandText(slashCommand: string, args: string[]): CommandBuild {
  if (!COMMAND_NAME_PATTERN.test(slashCommand)) {
    throw new ControlsError(
      `command must be a slash command like /model, got: ${slashCommand}`,
      "usage",
    );
  }
  const name = slashCommand.slice(1);
  for (const arg of args) {
    if (arg === "" || hasControlChars(arg)) {
      throw new ControlsError(
        `command args must be non-empty and contain no control characters, got: ${JSON.stringify(arg)}`,
        "usage",
      );
    }
  }
  const text = args.length > 0 ? `${slashCommand} ${args.join(" ")}` : slashCommand;
  return { name, text };
}

export interface ProviderCommandInfo {
  /** Canonical kind the table was keyed on (null when unresolved). */
  kind: string | null;
  /** Advisory known commands; empty when the provider has no table entry. */
  commands: readonly string[];
  /** Whether `name` appears in the advisory table — a hint, not a gate. */
  known_command: boolean;
  note: string;
}

/** Look up the advisory command table for a resolved agent kind. */
export function commandInfoFor(
  agentKind: string | null | undefined,
  name: string,
): ProviderCommandInfo {
  const kind = agentKind ? canonicalKind(agentKind) : null;
  const commands = kind !== null ? (PROVIDER_COMMANDS[kind] ?? []) : [];
  return {
    kind,
    commands,
    known_command: commands.includes(name),
    note: COMMAND_TABLE_NOTE,
  };
}
