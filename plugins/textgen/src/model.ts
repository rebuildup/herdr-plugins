/**
 * rebuildup.textgen contract model (`herdr-plugins.textgen/v1`, Issue #107 /
 * parent #29 T1).
 *
 * Six generation tasks ported from T3 Code `apps/server/src/textGeneration/`.
 * The plugin generates text only: adopting the result (git branch/commit,
 * forge PR create, composer insertion) is always the caller's job, and a
 * manual path must keep working when generation is unavailable.
 */

export const CONTRACT = "herdr-plugins.textgen/v1";
export const PLUGIN_ID = "rebuildup.textgen";
export const PLUGIN_VERSION = "0.6.0";

/** Execution paths a task/provider pair can use. `cli` is reserved (ADR-0017). */
export type GenerationPath = "agent" | "api" | "cli";

export type TaskKind =
  | "thread_title"
  | "branch_name"
  | "commit_message"
  | "pr_content"
  | "review_guide"
  | "next_prompt";

/** Shape the validated generation result takes on the wire. */
export type OutputShape = "text" | "text_list" | "pr_content";

export interface TaskSpec {
  kind: TaskKind;
  description: string;
  /** Execution paths allowed for this task. */
  paths: readonly GenerationPath[];
  /** Allowed top-level input keys (strict allowlist — see input.ts). */
  inputFields: readonly string[];
  /** Input keys that must be present and non-empty. */
  requiredInput: readonly string[];
  output: OutputShape;
  /** Hard cap on a single validated output string, in characters. */
  maxOutputChars: number;
  /** Cap on list outputs (text_list); ignored otherwise. */
  maxListItems: number;
  /** Per-task default timeout for provider execution, milliseconds. */
  defaultTimeoutMs: number;
  /**
   * When true, generation requires explicit opt-in
   * (`guards.expensiveTaskOptIn` config or `--allow-expensive`) because
   * the task's cost/profile is high (multi-step agent investigation).
   */
  requiresOptIn?: boolean;
}

const AGENT_AND_API = ["agent", "api"] as const;
const AGENT_ONLY = ["agent"] as const;

/**
 * Task registry. `review_guide` and `next_prompt` are agent-only, matching
 * upstream: review guide needs read-only multi-step repository
 * investigation, and next-prompt prediction runs against live agent
 * context — neither fits a single-shot text-generator API call.
 */
export const TASKS: readonly TaskSpec[] = [
  {
    kind: "thread_title",
    description: "Short title summarizing a conversation/thread context.",
    paths: AGENT_AND_API,
    inputFields: ["context", "instruction"],
    requiredInput: ["context"],
    output: "text",
    maxOutputChars: 200,
    maxListItems: 1,
    defaultTimeoutMs: 120_000,
  },
  {
    kind: "branch_name",
    description: "Slug-style git branch name for a change.",
    paths: AGENT_AND_API,
    inputFields: ["change_summary", "diff", "instruction"],
    requiredInput: [],
    output: "text",
    maxOutputChars: 100,
    maxListItems: 1,
    defaultTimeoutMs: 120_000,
  },
  {
    kind: "commit_message",
    description: "Conventional-commit-style message candidates for staged changes.",
    paths: AGENT_AND_API,
    inputFields: ["diff", "conventions", "instruction", "candidates"],
    requiredInput: ["diff"],
    output: "text_list",
    maxOutputChars: 2_000,
    maxListItems: 5,
    defaultTimeoutMs: 120_000,
  },
  {
    kind: "pr_content",
    description: "Pull request title + body for a set of changes.",
    paths: AGENT_AND_API,
    inputFields: ["diff", "commits", "issue_refs", "pr_context", "instruction"],
    requiredInput: [],
    output: "pr_content",
    maxOutputChars: 20_000,
    maxListItems: 1,
    defaultTimeoutMs: 180_000,
  },
  {
    kind: "review_guide",
    description: "Read-only multi-step review guide for a checkout/PR (agent providers only).",
    paths: AGENT_ONLY,
    inputFields: ["target", "instructions", "cwd"],
    requiredInput: ["target"],
    output: "text",
    maxOutputChars: 20_000,
    maxListItems: 1,
    defaultTimeoutMs: 600_000,
    requiresOptIn: true,
  },
  {
    kind: "next_prompt",
    description: "Predicted next user prompt for a finished agent turn (agent providers only).",
    paths: AGENT_ONLY,
    inputFields: ["context", "instruction"],
    requiredInput: ["context"],
    output: "text",
    maxOutputChars: 2_000,
    maxListItems: 1,
    defaultTimeoutMs: 120_000,
  },
];

const TASK_BY_KIND = new Map<TaskKind, TaskSpec>(TASKS.map((t) => [t.kind, t]));

export function isTaskKind(value: string): value is TaskKind {
  return TASK_BY_KIND.has(value as TaskKind);
}

export function taskSpec(kind: TaskKind): TaskSpec {
  const spec = TASK_BY_KIND.get(kind);
  if (!spec) throw new Error(`unknown task kind: ${kind}`);
  return spec;
}

/** Validated `pr_content` result shape. */
export interface PrContentResult {
  title: string;
  body: string;
}

/** Typed generation result per output shape. */
export type GenerationResult = string | string[] | PrContentResult;

/** Structured error thrown anywhere in the pipeline; mapped to CLI stderr. */
export class TextgenError extends Error {
  readonly code: string;
  readonly kind: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, kind: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TextgenError";
    this.code = code;
    this.kind = kind;
    this.details = details;
  }
}
