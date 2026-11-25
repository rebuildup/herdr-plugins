/**
 * Launch-time controls for `rebuildup.controls` (Issue #100 / parent
 * #27 T2, ADR-0018).
 *
 * `agent.start` passes `args` verbatim to the provider CLI after the
 * kind's canonical executable; herdr shell-encodes the argv and rejects
 * control characters upstream. This module owns the plugin-side policy:
 *
 * - Structured options (`--model`, `--reasoning`, `--permission-mode`,
 *   `--resume`) map to provider CLI flags through an explicit per-kind
 *   table. Providers without a verified mapping report `unsupported` —
 *   the plugin never fabricates provider capabilities and never relies
 *   on implicit provider defaults.
 * - `--arg` passthrough is validated (no control characters, non-empty)
 *   and screened against a privilege-escalation denylist (bypass /
 *   never-ask / danger-full-access flags). `--unsafe-args` is the
 *   explicit opt-out, echoed in the result.
 * - Resume argv mirrors herdr's own `agent_resume.rs` launch-arg plan
 *   (the same mapping herdr uses for session restore), so `start
 *   --resume` produces exactly the argv herdr would reconstruct.
 *
 * Evidence: claude/codex/pi/opencode flags verified against installed
 * CLIs (claude 2.1.330, codex 0.171.0, opencode 2.3.2, pi 1.6.0);
 * gemini/cursor flags from official CLI references; resume argv from
 * herdr `src/agent_resume.rs` `plan()` (herdr 0.9.5+).
 */

import { ControlsError } from "./identity";

export const PERMISSION_MODES = ["supervised", "auto-accept-edits", "auto", "full-access"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Session-ref kinds herdr reports (`AgentSessionRefKind`). */
export type ResumeSessionKind = "id" | "path";

export interface ProviderLaunchSpec {
  /** `--model` mapping; absent = unsupported. */
  readonly model?: ((value: string) => string[]) | undefined;
  /** `--reasoning` mapping; absent = unsupported. */
  readonly reasoning?: ((value: string) => string[]) | undefined;
  /** Supported permission modes → argv (executable excluded). */
  readonly permissionModes?: Partial<Record<PermissionMode, readonly string[]>> | undefined;
  /**
   * `--resume` mapping; absent = unsupported. `sessionKind` is the
   * reported `agent_session.kind` (null for a raw `--resume` value).
   */
  readonly resume?:
    | ((value: string, sessionKind: ResumeSessionKind | null) => string[] | undefined)
    | undefined;
  /** Session kinds `resume` accepts; default ["id"]. */
  readonly resumeSessionKinds?: readonly ResumeSessionKind[] | undefined;
  readonly notes?: string | undefined;
}

const byFlag =
  (flag: string) =>
  (value: string): string[] => [flag, value];
const byInline =
  (flag: string) =>
  (value: string): string[] => [`${flag}=${value}`];

/**
 * Canonical kind labels → launch spec. `canonicalKind` maps herdr's
 * accepted aliases (mirroring `parse_agent_label`/`lookup_agent` in
 * herdr `src/detect/mod.rs`) onto the canonical label so `claude-code`
 * gets the same launch table as `claude`.
 */
const KIND_ALIASES: Record<string, string> = {
  "claude-code": "claude",
  "cursor-agent": "cursor",
  antigravity: "agy",
  "antigravity-cli": "agy",
  ".cline": "cline",
  "devin-cli": "devin",
  "devin cli": "devin",
  "github-copilot": "copilot",
  ghcs: "copilot",
  "kimi-code": "kimi",
  "kimi code": "kimi",
  "kiro-cli": "kiro",
  "amp-local": "amp",
  "grok-build": "grok",
  "hermes-agent": "hermes",
  "kilo-code": "kilo",
  "kilo code": "kilo",
  qoder: "qodercli",
  qodercn: "qodercli",
  qoderclicn: "qodercli",
  "qwen-code": "qwen",
  "qwen code": "qwen",
  "letta-code": "letta",
  "letta code": "letta",
  "muse-code": "muse",
  "muse-cli": "muse",
  "mastra-code": "mastracode",
  "mastra code": "mastracode",
  opencode2: "opencode",
  "open-code": "opencode",
};

export function canonicalKind(kind: string): string {
  const lower = kind.toLowerCase();
  return KIND_ALIASES[lower] ?? (lower in LAUNCH_SPECS ? lower : kind);
}

/**
 * Per-kind launch table. Resume argv mirrors herdr
 * `src/agent_resume.rs::plan()` — the canonical upstream mapping —
 * minus the leading executable (herdr prepends it for `agent.start`).
 * Providers absent from the resume plan upstream (gemini, cline, kiro,
 * amp, maki, muse) are honestly `unsupported`.
 */
export const LAUNCH_SPECS: Record<string, ProviderLaunchSpec> = {
  claude: {
    model: byFlag("--model"),
    reasoning: byFlag("--effort"),
    permissionModes: {
      // `manual` is the documented alias of claude's `default` mode.
      supervised: ["--permission-mode", "manual"],
      "auto-accept-edits": ["--permission-mode", "acceptEdits"],
      auto: ["--permission-mode", "auto"],
      "full-access": ["--permission-mode", "bypassPermissions"],
    },
    resume: byFlag("--resume"),
    resumeSessionKinds: ["id"],
    notes:
      "bypassPermissions may still require the provider's own enablement; --resume also accepts a session name upstream.",
  },
  codex: {
    model: byFlag("--model"),
    reasoning: (value) => ["-c", `model_reasoning_effort=${value}`],
    permissionModes: {
      // T3 supervised ≈ approval on-request + read-only sandbox.
      supervised: ["--ask-for-approval", "on-request", "--sandbox", "read-only"],
      "auto-accept-edits": ["--ask-for-approval", "on-request", "--sandbox", "workspace-write"],
      // --approve-for-me routes approvals through automatic review on
      // the workspace-write sandbox (no per-action human prompt).
      auto: ["--approve-for-me"],
      "full-access": ["--dangerously-bypass-approvals-and-sandbox"],
    },
    // `codex resume <id>` — herdr detects exactly this argv shape as a
    // persisted launch session (agent_resume.rs).
    resume: (value) => ["resume", value],
    resumeSessionKinds: ["id"],
    notes:
      "full-access emits the provider's bypass flag by design; raw --arg passthrough of it is denylisted (ADR-0018).",
  },
  gemini: {
    model: byFlag("--model"),
    permissionModes: {
      supervised: ["--approval-mode", "default"],
      "auto-accept-edits": ["--approval-mode", "auto_edit"],
      // No classifier-review equivalent upstream → auto unsupported.
      "full-access": ["--approval-mode", "yolo"],
    },
    notes: "auto mode unsupported: gemini has no automatic-review approval mode.",
  },
  cursor: {
    model: byFlag("--model"),
    permissionModes: {
      // cursor-agent has no supervised/auto-edit/auto launch flag;
      // default prompting stays the implicit supervised behavior and
      // is therefore not claimed as a supported mapping.
      "full-access": ["--force"],
    },
    resume: byFlag("--resume"),
    resumeSessionKinds: ["id"],
    notes: "only full-access is mapped (--force); other modes unsupported.",
  },
  pi: {
    model: byFlag("--model"),
    reasoning: byFlag("--thinking"),
    resume: byFlag("--session"),
    resumeSessionKinds: ["id", "path"],
    notes:
      "no permission-mode launch flag upstream (project trust is --approve/--no-approve, a different concept).",
  },
  opencode: {
    permissionModes: {
      // --auto approves permissions not explicitly denied; deny rules
      // still apply, so it is mapped to full-access with that caveat.
      "full-access": ["--auto"],
    },
    resume: byFlag("--session"),
    resumeSessionKinds: ["id"],
    notes:
      "interactive opencode has no --model flag (model is config/agent-scoped); only full-access maps (--auto still honors deny rules).",
  },
  omp: {
    resume: byInline("--resume"),
    resumeSessionKinds: ["id", "path"],
  },
  mastracode: {
    resume: byFlag("--thread"),
    resumeSessionKinds: ["id"],
  },
  copilot: {
    resume: byInline("--resume"),
    resumeSessionKinds: ["id"],
  },
  devin: {
    resume: byFlag("--resume"),
    resumeSessionKinds: ["id"],
  },
  droid: {
    resume: byFlag("--resume"),
    resumeSessionKinds: ["id"],
  },
  kimi: {
    resume: byFlag("--session"),
    resumeSessionKinds: ["id"],
  },
  hermes: {
    resume: byFlag("--resume"),
    resumeSessionKinds: ["id"],
  },
  qodercli: {
    resume: byFlag("--resume"),
    resumeSessionKinds: ["id"],
  },
  qwen: {
    resume: byFlag("--resume"),
    resumeSessionKinds: ["id"],
  },
  kilo: {
    resume: byFlag("--session"),
    resumeSessionKinds: ["id"],
  },
  agy: {
    resume: byFlag("--conversation"),
    resumeSessionKinds: ["id"],
  },
  grok: {
    resume: byFlag("--resume"),
    resumeSessionKinds: ["id"],
  },
  letta: {
    resume: (value) => {
      // herdr plan(): `default:<agent_id>` selects the default
      // conversation's agent; anything else is a conversation id.
      const agentId = value.startsWith("default:") ? value.slice("default:".length) : null;
      if (agentId !== null) {
        if (agentId === "") return undefined;
        return ["--conversation", "default", "--agent", agentId];
      }
      return ["--conversation", value];
    },
    resumeSessionKinds: ["id"],
  },
};

// --- Validation ---------------------------------------------------------------

const CONTROL_CHARS = /\p{Cc}/u;
const MAX_VALUE_LENGTH = 1024;

function assertCleanValue(value: string, flag: string): void {
  if (value === "") {
    throw new ControlsError(`${flag} requires a non-empty value`, "usage");
  }
  if (value.length > MAX_VALUE_LENGTH) {
    throw new ControlsError(`${flag} value exceeds ${MAX_VALUE_LENGTH} characters`, "usage");
  }
  if (CONTROL_CHARS.test(value)) {
    throw new ControlsError(`${flag} value contains control characters`, "usage");
  }
  if (value.startsWith("-")) {
    // A leading dash would be parsed as a flag by the provider CLI —
    // values must never smuggle in extra options.
    throw new ControlsError(`${flag} value must not start with '-'`, "usage");
  }
}

function assertCleanArg(arg: string): void {
  if (arg === "") {
    throw new ControlsError("--arg requires a non-empty value", "usage");
  }
  if (arg.length > MAX_VALUE_LENGTH) {
    throw new ControlsError(`--arg value exceeds ${MAX_VALUE_LENGTH} characters`, "usage");
  }
  if (CONTROL_CHARS.test(arg)) {
    throw new ControlsError("--arg value contains control characters", "usage");
  }
}

/**
 * Privilege-escalation denylist for `--arg` passthrough (ADR-0018).
 * `values` rules inspect the flag's value — inline (`--flag=value`)
 * or the following argv element. Provider scoping keeps generic flags
 * like `-a`/`-s`/`-f` from being denied for providers where they mean
 * something else.
 */
interface DenyRule {
  flag: string;
  values?: readonly string[];
  providers?: readonly string[];
  reason: string;
}

const DENY_RULES: readonly DenyRule[] = [
  { flag: "--dangerously-skip-permissions", reason: "bypasses all claude permission checks" },
  {
    flag: "--allow-dangerously-skip-permissions",
    reason: "enables claude bypass-permissions as an option",
  },
  {
    flag: "--dangerously-bypass-approvals-and-sandbox",
    reason: "codex: skips all confirmations and sandboxing",
  },
  { flag: "--dangerously-bypass-hook-trust", reason: "codex: runs untrusted hooks" },
  { flag: "--yolo", reason: "auto-approve-all alias (gemini/cursor)" },
  { flag: "--force", providers: ["cursor"], reason: "cursor-agent: force-allow commands" },
  { flag: "-f", providers: ["cursor"], reason: "cursor-agent: force-allow commands" },
  { flag: "-y", providers: ["gemini"], reason: "gemini: deprecated --yolo alias" },
  { flag: "--auto", providers: ["opencode"], reason: "opencode: auto-approve permissions" },
  {
    flag: "--permission-mode",
    values: ["bypassPermissions"],
    reason: "claude bypassPermissions mode",
  },
  {
    flag: "--approval-mode",
    values: ["yolo"],
    reason: "gemini yolo approval mode",
  },
  {
    flag: "--ask-for-approval",
    values: ["never"],
    reason: "codex: never ask for approval",
  },
  { flag: "-a", values: ["never"], providers: ["codex"], reason: "codex: never ask" },
  {
    flag: "--sandbox",
    values: ["danger-full-access"],
    reason: "codex: danger-full-access sandbox",
  },
  {
    flag: "-s",
    values: ["danger-full-access"],
    providers: ["codex"],
    reason: "codex: danger-full-access sandbox",
  },
];

function deniedArgReason(args: string[], kind: string): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const eq = arg.indexOf("=");
    const flagPart = eq > 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq > 0 ? arg.slice(eq + 1) : undefined;
    for (const rule of DENY_RULES) {
      if (rule.flag !== flagPart) continue;
      if (rule.providers !== undefined && !rule.providers.includes(kind)) continue;
      if (rule.values === undefined) {
        return `--arg ${arg} is denied: ${rule.reason} (use the structured option or --unsafe-args)`;
      }
      const value = inlineValue ?? args[i + 1];
      if (value !== undefined && rule.values.includes(value)) {
        return `--arg ${arg}${inlineValue === undefined ? ` ${value}` : ""} is denied: ${rule.reason} (use the structured option or --unsafe-args)`;
      }
    }
  }
  return null;
}

// --- Public API ---------------------------------------------------------------

export interface LaunchRequest {
  kind: string;
  model?: string | undefined;
  reasoning?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  /** Raw resume value (`--resume`) — already validated. */
  resumeValue?: string | undefined;
  /** Reported session kind when the value came from `--resume-from`. */
  resumeSessionKind?: ResumeSessionKind | null | undefined;
  /** Validated `--arg` passthrough values. */
  extraArgs: string[];
  /** Explicit opt-out of the privilege-escalation denylist. */
  unsafeArgs: boolean;
}

export interface BuiltLaunch {
  /** argv appended after the executable, in launch order. */
  args: string[];
  /** Which structured options produced args (for the result echo). */
  applied: {
    model?: string[];
    reasoning?: string[];
    permission_mode?: string[];
    resume?: string[];
    extra_args: string[];
    unsafe_args: boolean;
  };
}

function unsupported(option: string, kind: string, spec: ProviderLaunchSpec | undefined): never {
  const supported = spec?.permissionModes ? Object.keys(spec.permissionModes) : [];
  throw new ControlsError(
    `${option} is not supported for agent kind '${kind}'` +
      (option === "permission-mode" && supported.length > 0
        ? `; supported modes: ${supported.join(", ")}`
        : ""),
    "unsupported_launch_option",
    {
      option,
      provider: kind,
      ...(option === "permission-mode" ? { supported_modes: supported } : {}),
      ...(spec?.notes ? { provider_notes: spec.notes } : {}),
    },
  );
}

/**
 * Build the provider argv for `agent.start`. Throws `ControlsError`
 * (`usage` / `unsupported_launch_option` / `unsafe_agent_argument`)
 * before any RPC is made.
 */
export function buildLaunchArgs(request: LaunchRequest): BuiltLaunch {
  const spec = LAUNCH_SPECS[request.kind];
  const args: string[] = [];
  const applied: BuiltLaunch["applied"] = {
    extra_args: request.extraArgs,
    unsafe_args: request.unsafeArgs,
  };

  // 1. Passthrough args are validated first so a denied flag fails
  //    before any structured mapping is even considered.
  for (const arg of request.extraArgs) assertCleanArg(arg);
  if (!request.unsafeArgs) {
    const reason = deniedArgReason(request.extraArgs, request.kind);
    if (reason !== null) {
      throw new ControlsError(reason, "unsafe_agent_argument");
    }
  }

  // 2. Resume first: subcommand-style argv (codex `resume <id>`) must
  //    lead the argument list.
  if (request.resumeValue !== undefined) {
    assertCleanValue(request.resumeValue, "--resume");
    if (spec?.resume === undefined) unsupported("resume", request.kind, spec);
    const sessionKind = request.resumeSessionKind ?? null;
    const kinds = spec.resumeSessionKinds ?? ["id"];
    if (sessionKind !== null && !kinds.includes(sessionKind)) {
      throw new ControlsError(
        `resume session kind '${sessionKind}' is not supported for agent kind '${request.kind}' (accepts: ${kinds.join(", ")})`,
        "unsupported_launch_option",
        { option: "resume", provider: request.kind, session_kind: sessionKind },
      );
    }
    const resumeArgs = spec.resume(request.resumeValue, sessionKind);
    if (resumeArgs === undefined) {
      unsupported("resume", request.kind, spec);
    }
    args.push(...resumeArgs);
    applied.resume = [...resumeArgs];
  }

  // 3. Structured options in fixed order: model, reasoning,
  //    permission-mode.
  if (request.model !== undefined) {
    assertCleanValue(request.model, "--model");
    if (spec?.model === undefined) unsupported("model", request.kind, spec);
    const modelArgs = spec.model(request.model);
    args.push(...modelArgs);
    applied.model = modelArgs;
  }
  if (request.reasoning !== undefined) {
    assertCleanValue(request.reasoning, "--reasoning");
    if (spec?.reasoning === undefined) unsupported("reasoning", request.kind, spec);
    const reasoningArgs = spec.reasoning(request.reasoning);
    args.push(...reasoningArgs);
    applied.reasoning = reasoningArgs;
  }
  if (request.permissionMode !== undefined) {
    const modeArgs = spec?.permissionModes?.[request.permissionMode];
    if (modeArgs === undefined) unsupported("permission-mode", request.kind, spec);
    args.push(...modeArgs);
    applied.permission_mode = [...modeArgs];
  }

  // 4. Caller passthrough last so explicit --arg wins on conflicts
  //    (provider CLIs typically take the last occurrence).
  args.push(...request.extraArgs);

  return { args, applied };
}

/** Launch-option summary for the capability payload. */
export function launchCapability(kind: string): Record<string, unknown> {
  const spec = LAUNCH_SPECS[kind];
  return {
    model: spec?.model !== undefined,
    reasoning: spec?.reasoning !== undefined,
    permission_modes: spec?.permissionModes
      ? Object.fromEntries(
          Object.entries(spec.permissionModes).map(([mode, argv]) => [mode, [...argv]]),
        )
      : {},
    resume:
      spec?.resume === undefined
        ? "unsupported"
        : `argv template; session kinds: ${(spec.resumeSessionKinds ?? ["id"]).join("|")}`,
    ...(spec?.notes ? { notes: spec.notes } : {}),
  };
}
