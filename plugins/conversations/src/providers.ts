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
  /**
   * Token-usage accounting the adapter surfaces on usage-carrying
   * events (additive capability detail, consumed by #92/#28 T3).
   * `cache_tokens: "reported"` means the adapter maps the provider's
   * cache read/write token fields into `usage.cache_*_input_tokens`;
   * `"unsupported"` means the provider has no cache-token accounting
   * to surface. Absent = capability not declared.
   */
  usage?: {
    cache_tokens: "reported" | "unsupported";
  };
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "claude",
    status: "supported",
    formats: ["claude-jsonl"],
    usage: { cache_tokens: "reported" },
  },
  {
    id: "codex",
    status: "supported",
    formats: ["codex-rollout-jsonl"],
    usage: { cache_tokens: "reported" },
  },
  {
    id: "opencode",
    status: "supported",
    formats: ["opencode-sqlite"],
    usage: { cache_tokens: "reported" },
  },
];

export function providerDescriptor(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isSupported(id: string): boolean {
  return providerDescriptor(id)?.status === "supported";
}
