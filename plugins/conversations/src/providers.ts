/**
 * Provider adapter registry for rebuildup.conversations.
 *
 * v1 ships the claude adapter (JSONL transcripts under the claude
 * config `projects/` dir). codex and opencode are declared so
 * `capability` can disclose them as `unsupported` with a reason —
 * adapters land in T2 (#87). An unlisted provider is reported as
 * `unknown_provider`, never silently indexed.
 */

export interface ProviderDescriptor {
  id: string;
  status: "supported" | "unsupported";
  /** Transcript formats the adapter reads, for capability disclosure. */
  formats: string[];
  /** Why the provider is unsupported (absent when supported). */
  reason?: string;
  /** Follow-up ticket that adds the adapter. */
  planned_in?: string;
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "claude",
    status: "supported",
    formats: ["claude-jsonl"],
  },
  {
    id: "codex",
    status: "unsupported",
    formats: [],
    reason: "codex rollout adapter lands in T2 (#87); declared for capability disclosure only",
    planned_in: "#87",
  },
  {
    id: "opencode",
    status: "unsupported",
    formats: [],
    reason: "opencode SQLite adapter lands in T2 (#87); declared for capability disclosure only",
    planned_in: "#87",
  },
];

export function providerDescriptor(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isSupported(id: string): boolean {
  return providerDescriptor(id)?.status === "supported";
}
