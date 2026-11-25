/**
 * Prompt construction for rebuildup.textgen. Prompts carry only the
 * validated task input — never ambient repository content, credentials,
 * or unrelated files (input boundary, Issue #107).
 */

import type { TaskKind, TaskSpec } from "./model";

export interface BuiltPrompt {
  system: string;
  user: string;
}

const SYSTEM_BASE =
  "You are a text generation backend inside the herdr-plugins.textgen " +
  "plugin. Produce exactly the requested artifact and nothing else: no " +
  "preamble, no explanation, no markdown commentary around the answer.";

const MARKER_OPEN = "<<<TEXTGEN_RESULT>>>";
const MARKER_CLOSE = "<<<TEXTGEN_END>>>";

export { MARKER_CLOSE, MARKER_OPEN };

function field(input: Record<string, string | number>, key: string): string | null {
  const value = input[key];
  if (value === undefined) return null;
  return String(value);
}

function section(title: string, body: string | null): string {
  return body === null ? "" : `\n\n## ${title}\n\n${body}`;
}

const TASK_INSTRUCTIONS: Record<TaskKind, (input: Record<string, string | number>) => string> = {
  thread_title: (input) =>
    "Generate a concise thread title (max 8 words, no trailing punctuation) " +
    "for the conversation context below." +
    section("Context", field(input, "context")) +
    section("Additional instruction", field(input, "instruction")),

  branch_name: (input) =>
    "Generate a git branch name slug (lowercase, hyphen-separated, no " +
    "slashes, max 60 chars) describing the intended change. Output only " +
    "the branch name." +
    section("Change summary", field(input, "change_summary")) +
    section("Diff", field(input, "diff")) +
    section("Additional instruction", field(input, "instruction")),

  commit_message: (input) => {
    const candidates = field(input, "candidates");
    const count = candidates === null ? 3 : Number(candidates);
    return (
      `Generate ${count} commit message candidate${count === 1 ? "" : "s"} in ` +
      "Conventional Commits format (type(scope): subject, optional body). " +
      `Separate candidates with a line containing only "---". Output only ` +
      "the candidates." +
      section("Staged diff", field(input, "diff")) +
      section("Repository conventions", field(input, "conventions")) +
      section("Additional instruction", field(input, "instruction"))
    );
  },

  pr_content: (input) =>
    "Generate a pull request title and body. Respond with a single JSON " +
    'object {"title": string, "body": string} and nothing else. The body ' +
    "is markdown: summarize the change, list notable behavior, and mention " +
    "test/verification notes when inferable." +
    section("Diff", field(input, "diff")) +
    section("Commits", field(input, "commits")) +
    section("Related issues/PRs", field(input, "issue_refs")) +
    section("Existing PR context (JSON)", field(input, "pr_context")) +
    section("Additional instruction", field(input, "instruction")),

  review_guide: (input) =>
    "You are a read-only code reviewer. Investigate the target (a diff, " +
    "pull request reference, or description) in the current working " +
    "directory using read-only inspection only — do not modify files, do " +
    "not run mutating commands. Produce a structured review guide: areas " +
    "to inspect, risks, and suggested checks, as markdown." +
    section("Target", field(input, "target")) +
    section("Working directory", field(input, "cwd")) +
    section("Additional instructions", field(input, "instructions")),

  next_prompt: (input) =>
    "Predict the single most likely next user prompt for the agent " +
    "conversation context below. Output only the predicted prompt text, " +
    "ready to submit to an empty composer — no quotes, no explanation." +
    section("Context", field(input, "context")) +
    section("Additional instruction", field(input, "instruction")),
};

/**
 * Build the system+user prompt pair for a task. The agent path wraps the
 * user prompt with explicit result markers so the executor can extract
 * the generated artifact from noisy terminal output.
 */
export function buildPrompt(
  spec: TaskSpec,
  input: Record<string, string | number>,
  options: { marked?: boolean } = {},
): BuiltPrompt {
  const marked = options.marked ?? false;
  const instruction = TASK_INSTRUCTIONS[spec.kind](input);
  const markerNote = marked
    ? `\n\nWrap your final answer between a line containing only ${MARKER_OPEN} ` +
      `and a line containing only ${MARKER_CLOSE}. Everything outside the ` +
      "marker lines is ignored; never mention the markers in your answer."
    : "";
  return {
    system: SYSTEM_BASE,
    user: `${instruction}${markerNote}`,
  };
}

/** Flatten a BuiltPrompt into one submission text for agent panes. */
export function promptToAgentText(prompt: BuiltPrompt): string {
  return `${prompt.system}\n\n---\n\n${prompt.user}`;
}
