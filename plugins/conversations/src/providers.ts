/**
 * Provider adapter registry for rebuildup.conversations.
 *
 * v1 ships claude (JSONL), codex (rollout JSONL), and opencode
 * (SQLite `opencode.db`) adapters — T2 (#87). An unlisted provider is
 * reported as `unknown_provider`, never silently indexed.
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
    status: "supported",
    formats: ["codex-rollout-jsonl"],
  },
  {
    id: "opencode",
    status: "supported",
    formats: ["opencode-sqlite"],
  },
];

export function providerDescriptor(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isSupported(id: string): boolean {
  return providerDescriptor(id)?.status === "supported";
}
