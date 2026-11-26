/**
 * Async task runner for `packages/tui` (contract items 7/10, ADR-0033 §3.7).
 *
 * Every long-running operation gets: a visible progress state, honest
 * cancel (AbortSignal + runner.cancel()), an optional timeout, and
 * partial-result labeling. The runner never fabricates success — a
 * cancelled/timed-out/failed task reports its real status.
 *
 * Usage:
 *   const result = await app.tasks.run(
 *     { label: "Fetching PRs", timeoutMs: 30_000 },
 *     async (signal, report) => {
 *       report({ done: 1, total: 3, message: "repo-a" });
 *       ...
 *       return data;
 *     },
 *   );
 *   // result.status: "ok" | "cancelled" | "timeout" | "error"
 */

export interface TaskProgress {
  done?: number;
  total?: number;
  /** Free-text progress message (already sanitized for display). */
  message?: string;
  /** Mark the eventual result as partial (e.g. best-effort collection). */
  partial?: boolean;
}

export type TaskStatus = "ok" | "cancelled" | "timeout" | "error";

export interface TaskResult<T> {
  status: TaskStatus;
  /** Present on "ok"; on "error" may carry a partial value if fn returned
   *  one via a thrown PartialResult — see below. */
  value?: T;
  /** Human-readable error/failure detail (never a stack by default). */
  error?: string;
  /** True when the result is incomplete: cancelled/timed-out mid-work or
   *  the task explicitly reported `partial: true`. Surfaces MUST label
   *  partial results as partial (contract item 7). */
  partial: boolean;
  elapsedMs: number;
}

export interface TaskSpec {
  /** Short label shown in the status line, e.g. "Fetching". */
  label: string;
  /** Hard timeout. Default: none. On expiry the task is aborted and the
   *  result status is "timeout". */
  timeoutMs?: number;
  /** Reported total for progress display (optional). */
  total?: number;
  /** Disable cancellation for this task (rare; default cancellable). */
  cancellable?: boolean;
}

export type TaskFn<T> = (signal: AbortSignal, report: (p: TaskProgress) => void) => Promise<T>;

export interface TaskRunnerOptions {
  /** Called whenever the active task's progress/status changes — used by
   *  the app to update the status line. */
  onChange?: (snapshot: TaskSnapshot | null) => void;
}

export interface TaskSnapshot {
  label: string;
  done?: number;
  total?: number;
  message?: string;
  state: "running" | "cancelling";
}

/**
 * Runs one task at a time. `cancel()` aborts the active task's signal;
 * well-behaved `fn`s reject/return promptly. If `fn` ignores the signal,
 * the runner still resolves via Promise.race — the task is reported as
 * cancelled even though the underlying work may continue briefly.
 */
export class TaskRunner {
  private active: {
    controller: AbortController;
    cancelRequested: boolean;
    timedOut: boolean;
    progress: TaskProgress;
    spec: TaskSpec;
  } | null = null;
  private readonly onChange: ((s: TaskSnapshot | null) => void) | undefined;

  constructor(opts: TaskRunnerOptions = {}) {
    this.onChange = opts.onChange;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  /** Snapshot for status-line rendering, or null when idle. */
  snapshot(): TaskSnapshot | null {
    if (!this.active) return null;
    const p = this.active.progress;
    return {
      label: this.active.spec.label,
      ...(p.done !== undefined ? { done: p.done } : {}),
      ...(p.total !== undefined || this.active.spec.total !== undefined
        ? { total: p.total ?? this.active.spec.total }
        : {}),
      ...(p.message !== undefined ? { message: p.message } : {}),
      state: this.active.cancelRequested ? "cancelling" : "running",
    };
  }

  /** Request cancellation of the active task. No-op when idle or the task
   *  opted out via `cancellable: false`. */
  cancel(): boolean {
    const a = this.active;
    if (!a) return false;
    if (a.spec.cancellable === false) return false;
    if (!a.cancelRequested) {
      a.cancelRequested = true;
      a.controller.abort();
      this.emit();
    }
    return true;
  }

  private emit(): void {
    this.onChange?.(this.snapshot());
  }

  async run<T>(spec: TaskSpec, fn: TaskFn<T>): Promise<TaskResult<T>> {
    if (this.active) {
      return {
        status: "error",
        error: "another task is already running",
        partial: false,
        elapsedMs: 0,
      };
    }
    const controller = new AbortController();
    const active = {
      controller,
      cancelRequested: false,
      timedOut: false,
      progress: {} as TaskProgress,
      spec,
    };
    this.active = active;
    this.emit();

    const started = Date.now();
    const timeoutMs = spec.timeoutMs;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        active.timedOut = true;
        controller.abort();
      }, timeoutMs);
      if (typeof timeoutTimer === "object" && timeoutTimer && "unref" in timeoutTimer) {
        (timeoutTimer as { unref: () => void }).unref();
      }
    }

    const report = (p: TaskProgress) => {
      active.progress = { ...active.progress, ...p };
      this.emit();
    };

    // Race fn against an abort promise so a signal-ignoring fn cannot hang
    // the runner forever.
    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          const err = new Error(active.timedOut ? "task timeout" : "task cancelled");
          err.name = active.timedOut ? "TimeoutError" : "AbortError";
          reject(err);
        },
        { once: true },
      );
    });

    let outcome: TaskResult<T>;
    try {
      const value = (await Promise.race([fn(controller.signal, report), abortPromise])) as T;
      outcome = {
        status: "ok",
        value,
        partial: active.progress.partial === true,
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      const isAbort =
        controller.signal.aborted ||
        (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
      if (active.timedOut || (isAbort && active.timedOut)) {
        outcome = {
          status: "timeout",
          error: `timed out after ${timeoutMs}ms`,
          partial: active.progress.partial === true || active.progress.done !== undefined,
          elapsedMs: Date.now() - started,
        };
      } else if (isAbort || active.cancelRequested) {
        outcome = {
          status: "cancelled",
          error: "cancelled",
          partial: active.progress.partial === true || active.progress.done !== undefined,
          elapsedMs: Date.now() - started,
        };
      } else {
        outcome = {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          partial: active.progress.partial === true,
          elapsedMs: Date.now() - started,
        };
      }
    } finally {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      this.active = null;
      this.emit();
    }
    return outcome;
  }
}

/** Format a task snapshot for a one-line status display. */
export function formatTaskSnapshot(s: TaskSnapshot): string {
  const parts: string[] = [s.state === "cancelling" ? "cancelling" : "…", s.label];
  if (s.done !== undefined && s.total !== undefined && s.total > 0) {
    parts.push(`${s.done}/${s.total}`);
  } else if (s.done !== undefined) {
    parts.push(String(s.done));
  }
  if (s.message) parts.push(`— ${s.message}`);
  return parts.join(" ");
}
