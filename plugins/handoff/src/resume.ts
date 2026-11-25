/**
 * Provider native-resume capability table for `rebuildup.handoff` (#104).
 *
 * This is the handoff-side seed of the provider capability surface that
 * `rebuildup.controls` T2 (#100) is expected to own long-term
 * (model/permission-mode args + resume). Until #100 lands, handoff keeps
 * its own minimal, honest table: an entry asserts ONLY what the provider
 * CLI documents; everything unlisted reports `unknown` and execute falls
 * back to `portable_context` — never a guessed resume.
 *
 * `resume_args_template` uses `{session_id}` as the placeholder; the
 * session id comes from `transfer.agent_session.value` (the fingerprint
 * herdr reports). Providers whose resume needs a session *path* rather
 * than an id are marked `session_id_source: "agent_session_path"` — a
 * known upstream gap (#5 survey, #89) — and are treated as not
 * resumable until that path is publicly reported.
 */

export type NativeResumeStatus = "supported" | "unsupported" | "unknown";

export interface ProviderResumeInfo {
  /** herdr agent kind / provider hint stem (e.g. "claude"). */
  kind: string;
  native_resume: NativeResumeStatus;
  /** Where the resume session id is read from; null when not resumable. */
  session_id_source: "agent_session.value" | "agent_session_path" | null;
  /** argv template for `agent.start args`; `{session_id}` is substituted. */
  resume_args_template: string[] | null;
  /** Provider flag used for `--model` mapping; null = no known flag. */
  model_flag: string | null;
  notes: string;
}

const RESUME_PROVIDERS: ProviderResumeInfo[] = [
  {
    kind: "claude",
    native_resume: "supported",
    session_id_source: "agent_session.value",
    resume_args_template: ["--resume", "{session_id}"],
    model_flag: "--model",
    notes:
      "claude CLI accepts `--resume <session-id>`; the id is the agent_session.value herdr reports. `--continue` is the no-id variant and is intentionally not used (it resumes the *latest* session, which could cross generations).",
  },
  {
    kind: "codex",
    native_resume: "supported",
    session_id_source: "agent_session.value",
    resume_args_template: ["resume", "{session_id}"],
    model_flag: "--model",
    notes:
      "codex CLI `resume <SESSION_ID>` subcommand (recent versions). Resume support depends on the installed codex version; failure surfaces as agent.start/prompt failure, never as fabricated resume.",
  },
];

const BY_KIND = new Map(RESUME_PROVIDERS.map((p) => [p.kind, p]));

/**
 * Look up resume capability for a provider kind. Unlisted kinds return
 * `unknown` — honest non-support, not an error.
 */
export function resumeInfo(kind: string | null | undefined): ProviderResumeInfo {
  if (kind !== null && kind !== undefined && kind !== "") {
    const hit = BY_KIND.get(kind);
    if (hit !== undefined) return hit;
  }
  return {
    kind: kind ?? "",
    native_resume: "unknown",
    session_id_source: null,
    resume_args_template: null,
    model_flag: null,
    notes: "provider not in the handoff resume table; treated as not resumable",
  };
}

export function listResumeProviders(): ProviderResumeInfo[] {
  return RESUME_PROVIDERS.map((p) => ({ ...p }));
}

/** Substitute `{session_id}` in a resume argv template. */
export function buildResumeArgs(template: string[], sessionId: string): string[] {
  return template.map((arg) => arg.replaceAll("{session_id}", sessionId));
}
