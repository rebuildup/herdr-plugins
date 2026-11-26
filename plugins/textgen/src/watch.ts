/**
 * `watch-next-prompt` for rebuildup.textgen (Issue #109, T3).
 *
 * Subscribes to herdr's `pane.agent_status_changed` events over
 * `events.subscribe` and, on a `working → idle|done` transition of the
 * watched pane, generates one `next_prompt` candidate through the same
 * ADR-0017 agent-pane path as `generate` — dedicated workspace, prompt,
 * read, marker extraction, cleanup. The plugin's job ends at
 * generation + recording: the validated prompt is reported back as pane
 * metadata (`textgen_next_prompt`) and a JSONL event; presenting it in
 * an empty composer / notification UI is herdr-t3's side.
 *
 * Honesty rules:
 * - only a *observed* `working → idle|done` transition triggers — the
 *   watcher never guesses turn boundaries from pane text;
 * - per-trigger failures are emitted as `next_prompt.error` events and
 *   never kill the watch; transport/subscription failures end it;
 * - generations are sequential (one in-flight max) and debounced per
 *   pane, so a flapping status cannot spawn concurrent agent panes;
 * - interrupt (SIGINT/SIGTERM) closes the subscription; an in-flight
 *   generation is bounded by its own timeout and its workspace is
 *   always cleaned up by the agent executor.
 */

import type { AgentTransport } from "./agent";
import type { TextgenConfig } from "./config";
import type { GenerateOptions, GenerateSuccess } from "./generate";
import { taskSpec } from "./model";
import type { AgentManifestEntry } from "./providers";
import type { QuotaProbe } from "./quota";

/** Minimal event-source surface (herdr-client `Subscription`-shaped). */
export interface WatchEventSource {
  readonly started?: Promise<unknown> | undefined;
  readonly events: AsyncIterable<{ event: string; data: unknown }>;
  close(): void;
}

export interface WatchNextPromptDeps {
  /** herdr Socket transport (pane.read, session.snapshot seeding). */
  transport: AgentTransport;
  /** Bound generate pipeline (task is fixed to next_prompt internally). */
  generate: (options: GenerateOptions) => Promise<GenerateSuccess>;
  /** Report the generated prompt onto the watched pane (metadata token). */
  reportMetadata?:
    | ((paneId: string, tokens: Record<string, string | null>) => Promise<unknown>)
    | undefined;
  /** JSONL sink; defaults to stdout in the CLI wrapper. */
  emit?: ((line: Record<string, unknown>) => void) | undefined;
  /** Context reader override (tests); default = `pane.read` recent text. */
  readContext?: ((paneId: string, lines: number) => Promise<string>) | undefined;
  /** Clock override for debounce (tests). */
  now?: (() => number) | undefined;
}

export interface WatchNextPromptOptions {
  /** Pane whose agent_status transitions trigger generation. */
  paneId: string;
  config: TextgenConfig;
  provider?: string | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  manifests?: AgentManifestEntry[] | undefined;
  allowExpensive?: boolean | undefined;
  quotaProbe?: QuotaProbe | undefined;
  session?: string | undefined;
  socketPath?: string | undefined;
  cwd?: string | undefined;
  /**
   * Static task input (must contain `context`, optionally `instruction`).
   * When omitted, each trigger reads the pane's recent terminal text as
   * the context — the visible conversation the turn just finished.
   */
  input?: Record<string, unknown> | undefined;
  /** Lines of pane scrollback used as context (default: config.agent.readLines). */
  readLines?: number | undefined;
  /** Minimum ms between generations for this pane (default 5000). */
  debounceMs?: number | undefined;
  /** Stop after N handled triggers (default: unlimited). */
  maxTriggers?: number | undefined;
  /** Stop after the first handled trigger (testing/scripting). */
  once?: boolean | undefined;
}

export interface WatchSummary {
  pane_id: string;
  triggers: number;
  generated: number;
  errors: number;
  skipped: number;
  stopped: "signal" | "stream_end" | "max_triggers" | "once";
}

const TRIGGER_STATUSES = new Set(["idle", "done"]);
const WORKING_STATUS = "working";
const NEXT_PROMPT_METADATA_TOKEN = "textgen_next_prompt";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STATUS_CHANGED_EVENT = "pane.agent_status_changed";

/** herdr emits both dotted and snake_case event names on the wire. */
function isStatusChangedEvent(raw: string): boolean {
  return raw === STATUS_CHANGED_EVENT || raw === "pane_agent_status_changed";
}

/** Extract `{pane_id, agent_status}` from an event data payload. */
function statusChange(data: unknown): { paneId: string; status: string } | null {
  if (!isRecord(data)) return null;
  const paneId = typeof data.pane_id === "string" ? data.pane_id : null;
  const status =
    typeof data.agent_status === "string"
      ? data.agent_status
      : typeof data.status === "string"
        ? data.status
        : null;
  if (paneId === null || status === null) return null;
  return { paneId, status };
}

/**
 * Seed last-known statuses from `session.snapshot`. Tolerant of both
 * the normalized map shape and the raw array shape; failure → empty
 * seed (first observed transition still requires a prior `working`,
 * so a missed seed can only *delay* a trigger, never invent one).
 */
async function seedStatuses(transport: AgentTransport): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  try {
    const result = await transport.call("session.snapshot", {});
    const root = isRecord(result) ? result : {};
    const snapshot = isRecord(root.snapshot) ? root.snapshot : root;
    const agentsRaw = snapshot.agents;
    const entries: Array<[string, unknown]> = [];
    if (Array.isArray(agentsRaw)) {
      for (const a of agentsRaw) {
        if (isRecord(a) && typeof a.pane_id === "string") entries.push([a.pane_id, a]);
      }
    } else if (isRecord(agentsRaw)) {
      for (const [paneId, a] of Object.entries(agentsRaw)) entries.push([paneId, a]);
    }
    for (const [paneId, agent] of entries) {
      if (isRecord(agent) && typeof agent.agent_status === "string") {
        statuses.set(paneId, agent.agent_status);
      }
    }
  } catch {
    /* snapshot unavailable — watch proceeds unseeded */
  }
  return statuses;
}

async function defaultReadContext(
  transport: AgentTransport,
  paneId: string,
  lines: number,
): Promise<string> {
  const result = await transport.call("pane.read", {
    pane_id: paneId,
    source: "recent",
    lines,
    strip_ansi: true,
  });
  const root = isRecord(result) ? result : {};
  const read = isRecord(root.read) ? root.read : root;
  return typeof read.text === "string" ? read.text : "";
}

/**
 * Run the watch loop until the source ends, a stop condition hits, or
 * the caller closes the source. Returns a structured summary; per-event
 * payloads are emitted through `deps.emit` as JSONL lines.
 */
export async function watchNextPrompt(
  source: WatchEventSource,
  options: WatchNextPromptOptions,
  deps: WatchNextPromptDeps,
): Promise<WatchSummary> {
  const emit = deps.emit ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const spec = taskSpec("next_prompt");
  const readLines = options.readLines ?? options.config.agent.readLines;
  const debounceMs = options.debounceMs ?? 5_000;
  const maxTriggers = options.maxTriggers ?? Number.POSITIVE_INFINITY;
  const readContext =
    deps.readContext ??
    ((paneId: string, lines: number) => defaultReadContext(deps.transport, paneId, lines));

  const summary: WatchSummary = {
    pane_id: options.paneId,
    triggers: 0,
    generated: 0,
    errors: 0,
    skipped: 0,
    stopped: "stream_end",
  };

  if (source.started !== undefined) {
    try {
      await source.started;
    } catch (err) {
      emit({
        contract: "herdr-plugins.textgen/v1",
        type: "watch.error",
        error: err instanceof Error ? err.message : String(err),
      });
      summary.stopped = "stream_end";
      return summary;
    }
  }

  const lastStatus = await seedStatuses(deps.transport);
  let lastFiredAt = Number.NEGATIVE_INFINITY;
  let stopRequested = false;

  const handleTrigger = async (): Promise<void> => {
    summary.triggers += 1;
    emit({
      contract: "herdr-plugins.textgen/v1",
      type: "next_prompt.triggered",
      pane_id: options.paneId,
      at: new Date(now()).toISOString(),
    });

    let input: Record<string, unknown>;
    if (options.input !== undefined) {
      input = options.input;
    } else {
      let context: string;
      try {
        context = await readContext(options.paneId, readLines);
      } catch (err) {
        summary.errors += 1;
        emit({
          contract: "herdr-plugins.textgen/v1",
          type: "next_prompt.error",
          pane_id: options.paneId,
          stage: "context",
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      // Bound the context to the input budget; the tail (most recent
      // turn) is what matters for prediction.
      const cap = options.config.limits.maxInputChars;
      if (context.length > cap) {
        context = `[earlier context truncated]\n${context.slice(context.length - cap + 30)}`;
      }
      input = { context };
    }

    try {
      const result = await deps.generate({
        task: spec.kind,
        input,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        config: options.config,
        ...(options.manifests !== undefined ? { manifests: options.manifests } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.allowExpensive !== undefined ? { allowExpensive: options.allowExpensive } : {}),
        ...(options.quotaProbe !== undefined ? { quotaProbe: options.quotaProbe } : {}),
        ...(options.session !== undefined ? { session: options.session } : {}),
        ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      });
      const promptText = typeof result.result === "string" ? result.result : "";
      if (deps.reportMetadata !== undefined && promptText !== "") {
        try {
          await deps.reportMetadata(options.paneId, {
            [NEXT_PROMPT_METADATA_TOKEN]: promptText,
          });
        } catch (err) {
          emit({
            contract: "herdr-plugins.textgen/v1",
            type: "next_prompt.warning",
            pane_id: options.paneId,
            stage: "metadata",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      summary.generated += 1;
      emit({
        contract: "herdr-plugins.textgen/v1",
        type: "next_prompt.generated",
        pane_id: options.paneId,
        result: promptText,
        provider: result.provider,
        path: result.path,
        elapsed_ms: result.elapsed_ms,
        warnings: result.warnings,
      });
    } catch (err) {
      summary.errors += 1;
      const textgen =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code: string; kind?: string; message: string; details?: unknown })
          : null;
      emit({
        contract: "herdr-plugins.textgen/v1",
        type: "next_prompt.error",
        pane_id: options.paneId,
        stage: "generate",
        error: textgen?.message ?? (err instanceof Error ? err.message : String(err)),
        ...(textgen !== null
          ? { code: textgen.code, kind: textgen.kind ?? null, details: textgen.details ?? null }
          : {}),
      });
    }
  };

  try {
    for await (const event of source.events) {
      if (stopRequested) break;
      if (!isStatusChangedEvent(event.event)) continue;
      const change = statusChange(event.data);
      if (change === null || change.paneId !== options.paneId) continue;

      const previous = lastStatus.get(change.paneId) ?? null;
      lastStatus.set(change.paneId, change.status);

      const isTrigger = TRIGGER_STATUSES.has(change.status) && previous === WORKING_STATUS;
      if (!isTrigger) continue;

      const elapsed = now() - lastFiredAt;
      if (elapsed < debounceMs) {
        summary.skipped += 1;
        emit({
          contract: "herdr-plugins.textgen/v1",
          type: "next_prompt.skipped",
          pane_id: options.paneId,
          reason: "debounce",
          debounce_ms: debounceMs,
        });
        continue;
      }
      if (summary.triggers >= maxTriggers) {
        summary.stopped = "max_triggers";
        stopRequested = true;
        break;
      }

      lastFiredAt = now();
      // Sequential: one generation in flight; the event queue buffers.
      await handleTrigger();
      if (options.once === true) {
        summary.stopped = "once";
        stopRequested = true;
        break;
      }
    }
  } finally {
    source.close();
  }

  return summary;
}
