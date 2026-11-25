/**
 * Capability matrix for `rebuildup.controls` (`herdr-plugins.controls/v1`).
 *
 * Every operation maps 1:1 onto a herdr `agent.*` socket method, so the
 * matrix is uniform across agent kinds: herdr resolves `target` (pane id
 * or agent name) and enforces agent-ness server-side. What differs per
 * kind is only what the *provider* does with the injected input — the
 * plugin cannot and does not verify provider semantics.
 *
 * Honest limits (see ADR-0017):
 * - `interrupt` is PTY-level key injection (`agent.send_keys`), not a
 *   structured interrupt API — upstream has none.
 * - `read` returns terminal scrollback, not structured conversation
 *   history; history consumers use `rebuildup.conversations` (#5).
 * - `send` to a `blocked` agent is rejected upstream (`agent_blocked`);
 *   the plugin surfaces that as `requires_interactive_input` and never
 *   reports success. Structured approval/question dialogs are an
 *   upstream gap (#27 research).
 * - queue/steer have no herdr session concept — upstream gap.
 */

export const CONTRACT = "herdr-plugins.controls/v1";

export const KNOWN_AGENT_KINDS = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "qwen",
  "letta",
  "maki",
  "muse",
] as const;

const OPERATION_NOTES: Record<string, string> = {
  send: "agent.prompt submits text via bracketed paste + Enter; a blocked agent is rejected before input is sent (surfaced as requires_interactive_input). Optional wait observes post-submit status only — it does not track turns.",
  wait: "agent.wait blocks server-side until agent_status matches until[] (default idle/done/blocked) or timeout_ms elapses (structured timeout error).",
  interrupt:
    "PTY-level only: agent.send_keys injects key names (default esc) into the terminal. No structured interrupt API exists upstream; effect depends on the provider's keybindings.",
  read: "agent.read returns bounded terminal scrollback (source visible|recent|recent_unwrapped|detection; format text|ansi). Not structured history — use rebuildup.conversations for conversation events.",
  rename: "agent.rename sets the display name; name=null clears it.",
};

export interface ProviderCapability {
  id: string;
  status: "supported";
  operations: string[];
  notes: string;
}

export function capabilityPayload(pluginVersion: string, generatedAt: string): unknown {
  return {
    contract: CONTRACT,
    command: "capability",
    plugin: "rebuildup.controls",
    version: pluginVersion,
    read_only: false,
    mutation_commands: ["send", "interrupt", "rename"],
    commands: ["capability", "send", "wait", "interrupt", "read", "rename"],
    operations: {
      send: { api: "agent.prompt", pty_level: false, note: OPERATION_NOTES.send },
      wait: { api: "agent.wait", pty_level: false, note: OPERATION_NOTES.wait },
      interrupt: { api: "agent.send_keys", pty_level: true, note: OPERATION_NOTES.interrupt },
      read: { api: "agent.read", pty_level: true, note: OPERATION_NOTES.read },
      rename: { api: "agent.rename", pty_level: false, note: OPERATION_NOTES.rename },
    },
    providers: KNOWN_AGENT_KINDS.map(
      (id): ProviderCapability => ({
        id,
        status: "supported",
        operations: ["send", "wait", "interrupt", "read", "rename"],
        notes:
          "Uniform agent.* surface; provider-specific behavior of injected input is not verified by this plugin.",
      }),
    ),
    upstream_gaps: [
      "structured interrupt API (interrupt is PTY-level key injection)",
      "queued message / steer session concept",
      "structured approval/question dialog events and responses (blocked agents reject agent.prompt)",
      "structured conversation history (agent.read is scrollback; see rebuildup.conversations)",
    ],
    notes: [
      "target accepts a herdr agent target (pane id or agent name); agent.get resolves and validates it before every operation.",
      "Optional --expect-pane/--expect-state-seq/--expect-agent-session guards reject stale generations before any mutation (stale_generation).",
      "Unknown agent kinds remain operable through the same surface; the providers list enumerates kinds from herdr 0.9.5 detection manifests.",
    ],
    generated_at: generatedAt,
  };
}
