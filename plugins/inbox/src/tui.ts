/**
 * rebuildup.inbox TUI entrypoint — the interactive inbox surface
 * (contract `herdr-plugins.tui/v1`, ADR-0031/0032/0033, Issue #237).
 *
 * Modes:
 *   bun run src/tui.ts            interactive pane UI (manifest [[panes]])
 *   bun run src/tui.ts --open     `open` action helper: invokes
 *                                 `plugin.pane.open` via HERDR_BIN_PATH,
 *                                 pins the origin context, returns promptly
 *   (non-TTY stdin)               honest plain-text list, no fake TUI
 *
 * Design rules honored here:
 * - Read-only open: the first and every refresh run `cli.ts list` only.
 *   `reconcile` runs solely via the explicit `c` key + confirmation.
 * - Target identity: the origin `HERDR_PLUGIN_CONTEXT_JSON` (or the
 *   `HERDR_TUI_CONTEXT_JSON` forwarded by the open helper) is pinned at
 *   launch; the UI pane's own HERDR_PANE_ID is surface identity only and
 *   is stripped from CLI child environments so it can never become an
 *   ambient mutation target.
 * - Stale generation: before every mutation the item is re-read through
 *   `cli.ts list` and compared on agent_session + state_change_seq;
 *   mismatch ⇒ abort with a stale_* message and a refreshed list.
 * - All mutations are confirm-gated and executed through the existing
 *   CLI commands — the TUI never writes plugin state directly.
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import {
  DetailView,
  type KeyBinding,
  type KeyEvent,
  type Line,
  type ScreenView,
  TuiApp,
  text,
} from "../../../packages/tui/src/index";
import type { InboxItem as ModelInboxItem } from "./model";
import {
  cliErrorMessage,
  INBOX_TUI_KEYMAP,
  type InboxScope,
  itemBadges,
  itemDetailLines,
  itemTitle,
  type ListPayload,
  nextScope,
  orderMoveTarget,
  parseLinkSpec,
  parseListOutput,
  scopeLabel,
  staleCheck,
  validateSnoozeSpec,
  visibleItems,
} from "./tui-model";

const PLUGIN_ID = "rebuildup.inbox";
const ENTRYPOINT_ID = "main";
const CLI_TIMEOUT_MS = 30_000;

// --- pinned launch context ---------------------------------------------------------

interface PinnedContext {
  /** Raw origin context JSON (action invocation or pane-open origin). */
  originJson: string | null;
  workspaceId: string | null;
  focusedPaneId: string | null;
  /** HERDR_PANE_ID of the UI pane itself — surface identity only. */
  surfacePaneId: string | null;
  socketPath: string | null;
  session: string | null;
}

function captureContext(): PinnedContext {
  // The open helper forwards the action's origin context explicitly;
  // otherwise the pane-open context herdr generated is the origin.
  const originJson =
    process.env.HERDR_TUI_CONTEXT_JSON ?? process.env.HERDR_PLUGIN_CONTEXT_JSON ?? null;
  let workspaceId: string | null = null;
  let focusedPaneId: string | null = null;
  if (originJson) {
    try {
      const parsed = JSON.parse(originJson) as {
        workspace_id?: unknown;
        focused_pane_id?: unknown;
      };
      if (typeof parsed.workspace_id === "string") workspaceId = parsed.workspace_id;
      if (typeof parsed.focused_pane_id === "string") {
        focusedPaneId = parsed.focused_pane_id;
      }
    } catch {
      // malformed context — keep nulls; the UI still works session-wide
    }
  }
  return {
    originJson,
    workspaceId,
    focusedPaneId,
    surfacePaneId: process.env.HERDR_PANE_ID ?? null,
    socketPath: process.env.HERDR_SOCKET_PATH ?? null,
    session: process.env.HERDR_SESSION ?? null,
  };
}

function pluginRoot(): string {
  const envRoot = process.env.HERDR_PLUGIN_ROOT;
  if (envRoot && envRoot !== "") return envRoot;
  // src/tui.ts → plugins/inbox
  return path.resolve(import.meta.dir, "..");
}

// --- CLI invocation -----------------------------------------------------------------

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run one inbox CLI command. The child env inherits the plugin/herdr
 * targeting vars but NEVER the UI pane's own HERDR_PANE_ID or the origin
 * context JSON — pane-scoped commands always receive an explicit
 * positional pane id, so ambient identity must not leak through.
 */
function runCli(args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<CliResult> {
  const cliPath = path.join(pluginRoot(), "src", "cli.ts");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "HERDR_PANE_ID" || key === "HERDR_PLUGIN_CONTEXT_JSON") continue;
    env[key] = value;
  }
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [cliPath, ...args], {
        cwd: pluginRoot(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        status: -1,
        stdout: "",
        stderr: `spawn failed: ${String(err)}`,
        timedOut: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout, stderr: `${stderr}spawn error: ${String(err)}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

async function runList(): Promise<
  { ok: true; payload: ListPayload } | { ok: false; error: string }
> {
  const result = await runCli(["list"]);
  if (result.timedOut) return { ok: false, error: "list timed out" };
  if (result.status !== 0) {
    return { ok: false, error: cliErrorMessage(result.status, result.stdout, result.stderr) };
  }
  return parseListOutput(result.stdout);
}

// --- main list view -------------------------------------------------------------------

interface ViewState {
  kind: "loading" | "error" | "ready";
  message?: string;
}

/**
 * The inbox browser view. Renders header/scope/filter, the item rows, and
 * a key-hint footer; all verbs are delegated to the browser through
 * callbacks so mutations stay outside the renderer.
 */
export class InboxView implements ScreenView {
  allItems: ModelInboxItem[] = [];
  scope: InboxScope = "inbox";
  query = "";
  cursor = 0;
  scrollTop = 0;
  state: ViewState = { kind: "loading", message: "loading inbox…" };
  generatedAt: string | null = null;
  sessionLabel: string | null = null;

  filterMode = false;
  filterDraft = "";

  onMove?: (item: ModelInboxItem) => void;
  onVerb?: (key: string, item: ModelInboxItem | null) => void;
  onRefresh?: () => void;
  onFilterCommit?: (query: string) => void;

  private filteredItems(): ModelInboxItem[] {
    return visibleItems(this.allItems, this.scope, this.query);
  }

  private clampCursor(): void {
    const n = this.filteredItems().length;
    if (this.cursor >= n) this.cursor = Math.max(0, n - 1);
    if (this.scrollTop > Math.max(0, n - 1)) this.scrollTop = Math.max(0, n - 1);
  }

  current(): ModelInboxItem | null {
    return this.filteredItems()[this.cursor] ?? null;
  }

  setItems(items: ModelInboxItem[], generatedAt: string | null, sessionLabel: string | null): void {
    this.allItems = items;
    this.generatedAt = generatedAt;
    this.sessionLabel = sessionLabel;
    this.state = { kind: "ready" };
    this.clampCursor();
  }

  setError(message: string): void {
    this.state = { kind: "error", message };
  }

  handleKey(ev: KeyEvent): boolean {
    if (ev.kind === "paste") return false;

    if (this.filterMode) {
      if (ev.kind !== "key") return false;
      const t = !ev.ctrl && !ev.alt ? (ev.char ?? ev.key) : undefined;
      if (t !== undefined && ev.key.length === 1) {
        this.filterDraft += t;
        return true;
      }
      if (ev.kind === "key" && ev.key === "backspace") {
        this.filterDraft = [...this.filterDraft].slice(0, -1).join("");
        return true;
      }
      if (ev.kind === "key" && ev.key === "enter") {
        this.query = this.filterDraft;
        this.filterMode = false;
        this.clampCursor();
        this.onFilterCommit?.(this.query);
        return true;
      }
      if (ev.kind === "key" && ev.key === "escape") {
        this.filterMode = false;
        this.filterDraft = "";
        return true;
      }
      return true;
    }

    if (ev.kind !== "key") return false;

    const list = this.filteredItems();
    const move = (delta: number) => {
      if (list.length === 0) return;
      this.cursor = (this.cursor + delta + list.length) % list.length;
    };

    if (!ev.ctrl && !ev.alt) {
      if (ev.key === "up" || ev.key === "k") {
        move(-1);
        return true;
      }
      if (ev.key === "down" || ev.key === "j") {
        move(1);
        return true;
      }
    }
    if (ev.key === "pageup") {
      for (let i = 0; i < 10; i++) move(-1);
      return true;
    }
    if (ev.key === "pagedown") {
      for (let i = 0; i < 10; i++) move(1);
      return true;
    }
    if (ev.key === "home") {
      this.cursor = 0;
      return true;
    }
    if (ev.key === "end") {
      this.cursor = Math.max(0, list.length - 1);
      return true;
    }
    if (ev.key === "/") {
      this.filterMode = true;
      this.filterDraft = this.query;
      return true;
    }
    if (ev.key === "f") {
      this.scope = nextScope(this.scope);
      this.cursor = 0;
      this.scrollTop = 0;
      this.clampCursor();
      return true;
    }
    if (ev.key === "R") {
      this.onRefresh?.();
      return true;
    }
    if (ev.key === "enter") {
      const item = this.current();
      if (item) this.onMove?.(item);
      return true;
    }

    // Session-scoped read verbs work without a selection.
    if (this.state.kind === "ready" && !ev.ctrl && !ev.alt) {
      if (ev.key === "t") {
        this.onVerb?.("t", null);
        return true;
      }
      if (ev.key === "c") {
        this.onVerb?.("c", null);
        return true;
      }
    }

    // Pane-scoped verbs — only with a selection and a ready list.
    const item = this.current();
    if (item && this.state.kind === "ready" && !ev.ctrl && !ev.alt) {
      const verbs = ["s", "n", "r", "p", "a", "[", "]", "l", "u"];
      if (verbs.includes(ev.key)) {
        this.onVerb?.(ev.key, item);
        return true;
      }
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    const w = Math.max(20, width);

    // Header
    const sess = this.sessionLabel ?? "session ?";
    const counts =
      this.state.kind === "ready"
        ? `${visibleItems(this.allItems, this.scope, this.query).length}/${this.allItems.length}`
        : "";
    lines.push(
      text(
        ` Inbox — ${sess} · scope:${scopeLabel(this.scope)}${this.query ? ` · /${this.query}` : ""} ${counts}`.slice(
          0,
          w,
        ),
      ),
    );
    lines.push([{ text: "─".repeat(Math.min(w, 60)), style: { dim: true } }]);

    if (this.state.kind === "loading") {
      lines.push(text("  loading…"));
    } else if (this.state.kind === "error") {
      lines.push([{ text: "  error: ", style: { bold: true, fg: "red" } }]);
      lines.push(text(`  ${this.state.message ?? "unknown"}`));
      lines.push(text("  R — retry · q — quit · CLI: bun run src/cli.ts list"));
    } else {
      const list = this.visibleForRender();
      if (list.length === 0) {
        lines.push([{ text: "  (empty)", style: { dim: true } }]);
        lines.push(
          text(
            this.allItems.length === 0
              ? "  no agent panes in this session — open one, then R to refresh"
              : "  no items match the current scope/filter",
          ),
        );
      } else {
        // Scroll window
        const chrome = 3; // header + rule + footer
        const visible = Math.max(1, height - chrome - 1);
        if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
        if (this.cursor >= this.scrollTop + visible) {
          this.scrollTop = this.cursor - visible + 1;
        }
        this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, list.length - visible)));
        const windowItems = list.slice(this.scrollTop, this.scrollTop + visible);
        for (let i = 0; i < windowItems.length; i++) {
          const item = windowItems[i] as ModelInboxItem;
          const idx = this.scrollTop + i;
          const isSel = idx === this.cursor;
          const badges = itemBadges(item);
          const badgeText = badges === "" ? "" : `[${badges}] `;
          const title = itemTitle(item);
          const right = item.agent_status ? ` ${item.agent_status}` : "";
          const prefix = isSel ? "❯ " : "  ";
          const style = isSel ? { bold: true } : {};
          const line: Line = [
            { text: prefix, style },
            { text: badgeText, style: { dim: true } },
            { text: title, style },
          ];
          // right-align pane id + status when space allows
          const used = prefix.length + badgeText.length + title.length + right.length + 2;
          if (used < w) {
            line.push({ text: " ".repeat(w - used) });
            line.push({ text: `${item.pane_id}${right}`, style: { dim: true } });
          } else {
            line.push({ text: ` ${item.pane_id}`, style: { dim: true } });
          }
          lines.push(line);
        }
        if (list.length > visible) {
          lines.push([
            {
              text: `  ${this.cursor + 1}/${list.length}`,
              style: { dim: true },
            },
          ]);
        }
      }
    }

    // Footer hints (single line, truncated)
    const hint =
      " enter detail · s settle · n snooze · r restore · p pin · a archive · [ ] order · l link · u unlink · t log · c reconcile · R refresh · / filter · f scope · ? help";
    while (lines.length < height - 1) lines.push([]);
    lines.push([{ text: hint.slice(0, w), style: { dim: true } }]);
    return lines.slice(0, height);
  }

  private visibleForRender(): ModelInboxItem[] {
    return visibleItems(this.allItems, this.scope, this.query);
  }

  keymap(): KeyBinding[] {
    return INBOX_TUI_KEYMAP;
  }
}

// --- browser controller ----------------------------------------------------------------

class InboxBrowser {
  private readonly app: TuiApp;
  private readonly view = new InboxView();
  private readonly ctx: PinnedContext;
  private items: ModelInboxItem[] = [];
  private generatedAt: string | null = null;

  constructor(app: TuiApp, ctx: PinnedContext) {
    this.app = app;
    this.ctx = ctx;
    this.view.onMove = (item) => this.showDetail(item);
    this.view.onVerb = (key, item) => void this.handleVerb(key, item);
    this.view.onRefresh = () => void this.refresh();
    this.view.onFilterCommit = () => {
      this.view.cursor = 0;
      this.view.scrollTop = 0;
    };
  }

  async start(): Promise<void> {
    this.app.setView(this.view);
    this.updateStatus();
    await this.refresh();
  }

  private sessionLabel(): string {
    return this.ctx.session ?? this.ctx.socketPath ?? "unknown session";
  }

  private updateStatus(extra = ""): void {
    const left = `inbox · ${this.sessionLabel()}${extra ? ` · ${extra}` : ""}`;
    this.app.setStatus(left, "? — help");
  }

  /** Read-only refresh — the ONLY data path on open and on R. */
  async refresh(): Promise<void> {
    this.view.state = { kind: "loading", message: "loading…" };
    const result = await runList();
    if (!result.ok) {
      this.view.setError(result.error);
      this.updateStatus("list failed — R to retry");
      return;
    }
    this.items = result.payload.items ?? [];
    this.generatedAt = result.payload.generated_at ?? null;
    this.view.setItems(this.items, this.generatedAt, this.sessionLabel());
    const counts = result.payload.counts;
    const bits: string[] = [];
    if (counts) {
      bits.push(`${counts.inbox ?? 0} inbox`, `${counts.attention ?? 0} attention`);
    }
    this.updateStatus(bits.join(" · "));
  }

  private showDetail(item: ModelInboxItem): void {
    const lines = itemDetailLines(item, this.generatedAt ?? undefined);
    this.app.push(
      new DetailView({
        title: `Inbox item — ${item.pane_id}`,
        lines,
        onClose: () => this.app.pop(),
      }),
    );
  }

  private async handleVerb(key: string, item: ModelInboxItem | null): Promise<void> {
    // Session-scoped verbs carry no pane target.
    if (key === "t") return this.showTransitions();
    if (key === "c") return this.mutateReconcile();
    if (item === null) return;
    switch (key) {
      case "s":
        return this.mutateOrganize("settle", item, {
          title: "Settle pane?",
          consequence:
            "Hides the pane from the inbox until its agent state changes. Reversible via restore; attention signals are never hidden.",
        });
      case "n":
        return this.mutateSnooze(item);
      case "r":
        return this.mutateOrganize("restore", item, {
          title: "Restore pane?",
          consequence:
            "Clears all organize state (settled/snoozed/archived/pin/order) for this pane. Declared PR/Issue links are kept.",
        });
      case "p":
        return this.mutateOrganize(item.pinned ? "unpin" : "pin", item, {
          title: item.pinned ? "Unpin pane?" : "Pin pane?",
          consequence: item.pinned
            ? "Removes the pin; the pane returns to normal ordering."
            : "Pins the pane to the top of the inbox. Layout hint only — never hides the pane.",
        });
      case "a":
        return this.mutateOrganize(
          item.organize?.kind === "archived" ? "unarchive" : "archive",
          item,
          {
            title: item.organize?.kind === "archived" ? "Unarchive pane?" : "Archive pane?",
            consequence:
              "Archive hides the pane from the default inbox view (like settle) but is cleared by the same generation rules. It never stops or closes the agent.",
          },
        );
      case "[":
      case "]":
        return this.mutateOrder(key === "[" ? "up" : "down", item);
      case "l":
        return this.mutateLink(item);
      case "u":
        return this.mutateUnlink(item);
      default:
        return;
    }
  }

  /** Fresh read + stale check + confirm + CLI mutation + refresh. */
  private async mutate(
    item: ModelInboxItem,
    opts: {
      title: string;
      consequence: string;
      danger?: boolean;
      args: string[];
      okMessage: string;
    },
  ): Promise<void> {
    // 1. Re-read before mutating: stale generation ⇒ abort + refresh.
    const fresh = await runList();
    if (!fresh.ok) {
      this.updateStatus(`revalidate failed: ${fresh.error}`);
      return;
    }
    const after = (fresh.payload.items ?? []).find((i) => i.pane_id === item.pane_id);
    const verdict = staleCheck(item, after);
    if (verdict.kind !== "ok") {
      this.items = fresh.payload.items ?? [];
      this.view.setItems(this.items, fresh.payload.generated_at ?? null, this.sessionLabel());
      this.view.cursor = Math.max(
        0,
        this.items.findIndex((i) => i.pane_id === item.pane_id),
      );
      this.updateStatus(
        `${verdict.kind === "gone" ? "stale_pane" : "stale_generation"}: ${verdict.reason} — list refreshed`,
      );
      return;
    }

    // 2. Explicit confirmation with the exact target (contract item 5).
    const confirmed = await this.app.confirm({
      title: opts.title,
      target: [
        `pane: ${item.pane_id}`,
        item.title ? `title: ${item.title}` : "",
        item.cwd ? `cwd: ${item.cwd}` : "",
        `cli: ${["bun", "run", "src/cli.ts", ...opts.args].join(" ")}`,
      ].filter((l) => l !== ""),
      consequence: opts.consequence,
      confirmLabel: "Apply",
      cancelLabel: "Cancel",
      ...(opts.danger ? { danger: true } : {}),
    });
    if (!confirmed) {
      this.updateStatus("cancelled");
      return;
    }

    // 3. Run the CLI mutation.
    this.updateStatus(`running: ${opts.args[0] ?? "?"}…`);
    const result = await runCli(opts.args);
    if (result.timedOut) {
      this.updateStatus(`timeout: ${opts.args.join(" ")} exceeded ${CLI_TIMEOUT_MS}ms`);
      return;
    }
    if (result.status !== 0) {
      this.updateStatus(`error: ${cliErrorMessage(result.status, result.stdout, result.stderr)}`);
      return;
    }
    let warningNote = "";
    try {
      const doc = JSON.parse(result.stdout) as { warnings?: string[] };
      if (Array.isArray(doc.warnings) && doc.warnings.length > 0) {
        warningNote = ` (${doc.warnings.length} warning${doc.warnings.length === 1 ? "" : "s"})`;
      }
    } catch {
      // non-JSON success output — ignore
    }
    await this.refresh();
    this.updateStatus(`${opts.okMessage}${warningNote}`);
  }

  private async mutateOrganize(
    command: "settle" | "restore" | "pin" | "unpin" | "archive" | "unarchive",
    item: ModelInboxItem,
    copy: { title: string; consequence: string },
  ): Promise<void> {
    await this.mutate(item, {
      ...copy,
      args: [command, item.pane_id],
      okMessage: `${command} ${item.pane_id}`,
    });
  }

  private async mutateSnooze(item: ModelInboxItem): Promise<void> {
    const spec = await this.app.prompt("Snooze until — +30m / +2h / +1d or ISO-8601", {
      placeholder: "+30m",
    });
    if (spec === null) {
      this.updateStatus("cancelled");
      return;
    }
    const checked = validateSnoozeSpec(spec);
    if (!checked.ok) {
      this.updateStatus(`invalid snooze spec: ${checked.error}`);
      return;
    }
    await this.mutate(item, {
      title: "Snooze pane?",
      consequence: `Hides the pane until ${checked.spec}, then it returns automatically. Reversible via restore.`,
      args: ["snooze", item.pane_id, "--until", checked.spec],
      okMessage: `snoozed ${item.pane_id} until ${checked.spec}`,
    });
  }

  private async mutateOrder(dir: "up" | "down", item: ModelInboxItem): Promise<void> {
    // Order operates on the visible inbox group; compute the reference
    // pane from the CURRENT items (fresh read already happens in mutate,
    // but the placement must be computed on a consistent snapshot — use
    // the freshest list we have, then revalidate inside mutate).
    const fresh = await runList();
    if (!fresh.ok) {
      this.updateStatus(`revalidate failed: ${fresh.error}`);
      return;
    }
    const freshItems = fresh.payload.items ?? [];
    const target = orderMoveTarget(freshItems, item.pane_id, dir);
    if (!target.ok) {
      this.updateStatus(target.error);
      return;
    }
    const shown = freshItems.find((i) => i.pane_id === item.pane_id);
    if (!shown) {
      this.updateStatus(`stale_pane: ${item.pane_id} is no longer in the session`);
      return;
    }
    await this.mutate(shown, {
      title: dir === "up" ? "Move pane up?" : "Move pane down?",
      consequence: `Rewrites manual order ranks so ${item.pane_id} moves ${dir} within its pinned/attention group. Layout hint only.`,
      args: ["order", item.pane_id, target.flag, target.refPaneId],
      okMessage: `moved ${item.pane_id} ${dir}`,
    });
  }

  private async mutateLink(item: ModelInboxItem): Promise<void> {
    const input = await this.app.prompt(
      "Link tracker — pr <owner>/<repo>#<n>  or  issue <owner>/<repo>#<n>",
      { placeholder: "pr rebuildup/herdr-plugins#237" },
    );
    if (input === null) {
      this.updateStatus("cancelled");
      return;
    }
    const spec = parseLinkSpec(input);
    if (!spec.ok) {
      this.updateStatus(`invalid link: ${spec.error}`);
      return;
    }
    await this.mutate(item, {
      title: `Link ${spec.kind.toUpperCase()}?`,
      consequence: `Declares ${spec.ref} as a user-owned ${spec.kind} reference on ${item.pane_id}. Verified via gh when available; recorded either way.`,
      args: ["link", item.pane_id, spec.flag, spec.ref, "--verify"],
      okMessage: `linked ${spec.ref} → ${item.pane_id}`,
    });
  }

  private async mutateUnlink(item: ModelInboxItem): Promise<void> {
    if (item.links.length === 0) {
      this.updateStatus(`${item.pane_id} has no declared links`);
      return;
    }
    const hint = item.links.map((l) => l.ref).join(", ");
    const input = await this.app.prompt(`Unlink — ${hint}`, {
      placeholder: item.links[0]?.ref ?? "",
    });
    if (input === null) {
      this.updateStatus("cancelled");
      return;
    }
    // Accept a bare ref (kind inferred from existing links) or full spec.
    let spec = parseLinkSpec(input);
    if (!spec.ok) {
      const bare = input.trim();
      const existing = item.links.find((l) => l.ref === bare);
      if (existing) {
        spec = {
          ok: true,
          kind: existing.kind,
          flag: existing.kind === "pr" ? "--pr" : "--issue",
          ref: existing.ref,
        };
      }
    }
    if (!spec.ok) {
      this.updateStatus(`invalid unlink: ${spec.error}`);
      return;
    }
    await this.mutate(item, {
      title: "Remove link?",
      consequence: `Removes the declared ${spec.kind} link ${spec.ref} from ${item.pane_id}. The pane's organize state is unaffected.`,
      args: ["unlink", item.pane_id, spec.flag, spec.ref],
      okMessage: `unlinked ${spec.ref} from ${item.pane_id}`,
    });
  }

  private async showTransitions(): Promise<void> {
    this.updateStatus("reading transitions…");
    const result = await runCli(["transitions", "--limit", "50"]);
    if (result.timedOut || result.status !== 0) {
      this.updateStatus(
        `transitions failed: ${result.timedOut ? "timeout" : cliErrorMessage(result.status, result.stdout, result.stderr)}`,
      );
      return;
    }
    let lines: string[] = [];
    try {
      const doc = JSON.parse(result.stdout) as {
        head_seq?: number;
        oldest_seq?: number | null;
        dropped?: number;
        transitions?: Array<Record<string, unknown>>;
      };
      lines.push(
        `head_seq=${doc.head_seq ?? "?"} oldest=${doc.oldest_seq ?? "-"} dropped=${doc.dropped ?? 0}`,
        "",
      );
      const items = doc.transitions ?? [];
      if (items.length === 0) {
        lines.push("(no transitions recorded)");
      }
      for (const t of items) {
        lines.push(
          `#${t.seq ?? "?"} ${t.kind ?? "?"} ${t.pane_id ?? "?"} @ ${t.at ?? "?"}` +
            (t.cause ? ` (${t.cause})` : "") +
            (t.workspace_id ? ` ws=${t.workspace_id}` : ""),
        );
      }
    } catch {
      lines = ["could not parse transitions output"];
    }
    this.app.push(
      new DetailView({
        title: "Organize-transition log (read-only)",
        lines,
        onClose: () => this.app.pop(),
      }),
    );
    this.updateStatus("");
  }

  /** Explicit reconcile — the ONLY mutation that is not pane-scoped. */
  private async mutateReconcile(): Promise<void> {
    const confirmed = await this.app.confirm({
      title: "Run reconcile now?",
      target: [`session: ${this.sessionLabel()}`, "cli: bun run src/cli.ts reconcile"],
      consequence:
        "Resolves expired snoozes and stale generation marks, prunes absent-pane entries, and re-projects pane metadata tokens. This is an explicit mutation — it never runs on open.",
      confirmLabel: "Reconcile",
      cancelLabel: "Cancel",
    });
    if (!confirmed) {
      this.updateStatus("cancelled");
      return;
    }
    this.updateStatus("reconciling…");
    const result = await runCli(["reconcile"]);
    if (result.timedOut || result.status !== 0) {
      this.updateStatus(
        `reconcile failed: ${result.timedOut ? "timeout" : cliErrorMessage(result.status, result.stdout, result.stderr)}`,
      );
      return;
    }
    let summary = "reconcile done";
    try {
      const doc = JSON.parse(result.stdout) as {
        cleared?: string[];
        pruned?: string[];
        projected?: string[];
        warnings?: string[];
      };
      summary = `reconcile: cleared=${(doc.cleared ?? []).length} pruned=${(doc.pruned ?? []).length} projected=${(doc.projected ?? []).length}`;
    } catch {
      // keep default summary
    }
    await this.refresh();
    this.updateStatus(summary);
  }
}

// --- non-TTY fallback -------------------------------------------------------------------

/** Honest plain-text rendering when there is no TTY (pipes, CI, --json-ish). */
export function plainList(payload: ListPayload): string[] {
  const counts = payload.counts ?? {};
  const lines: string[] = [];
  lines.push(
    `inbox — session=${payload.session?.name ?? payload.session?.socket ?? "?"} ` +
      `total=${counts.total ?? 0} inbox=${counts.inbox ?? 0} attention=${counts.attention ?? 0} ` +
      `organized=${counts.organized ?? 0} pinned=${counts.pinned ?? 0} archived=${counts.archived ?? 0}`,
  );
  for (const item of payload.items ?? []) {
    const badges = itemBadges(item);
    const status = item.agent_status ? ` [${item.agent_status}]` : "";
    const hidden = item.in_inbox ? "" : " (hidden)";
    lines.push(
      `  ${item.pane_id}${status}${hidden} ${item.title ?? ""}` +
        `${badges ? ` <${badges}>` : ""}` +
        `${item.links.length > 0 ? ` links=${item.links.map((l) => l.ref).join(",")}` : ""}`,
    );
  }
  lines.push("interactive UI requires a TTY; use the CLI for scripting.");
  return lines;
}

async function plainMode(): Promise<number> {
  const result = await runList();
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: result.error })}\n`);
    return 1;
  }
  for (const line of plainList(result.payload)) {
    process.stdout.write(`${line}\n`);
  }
  return 0;
}

// --- `open` action helper -----------------------------------------------------------------

/**
 * `open` action: capture the invocation origin once, then ask herdr to
 * open the `main` pane entrypoint as a tab and return promptly. The
 * origin context JSON is forwarded via --env so the pane pins the
 * ACTION's target, not whatever happens to be focused later.
 */
async function runOpenAction(): Promise<number> {
  const bin = process.env.HERDR_BIN_PATH?.trim() || "herdr";
  const originJson = process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "";
  let workspaceId: string | null = null;
  try {
    const parsed = JSON.parse(originJson) as { workspace_id?: unknown };
    if (typeof parsed.workspace_id === "string") workspaceId = parsed.workspace_id;
  } catch {
    // no usable context — open in the active workspace
  }

  const argv = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    PLUGIN_ID,
    "--entrypoint",
    ENTRYPOINT_ID,
    "--placement",
    "tab",
  ];
  if (workspaceId) argv.push("--workspace", workspaceId);
  if (originJson !== "") argv.push("--env", `HERDR_TUI_CONTEXT_JSON=${originJson}`);

  const result = await new Promise<{ status: number; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      child.on("error", (err) => resolve({ status: -1, stdout, stderr: String(err) }));
      child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
    },
  );
  if (result.stdout.trim() !== "") process.stdout.write(result.stdout);
  if (result.status !== 0) {
    process.stderr.write(
      result.stderr.trim() !== ""
        ? `${result.stderr}\n`
        : `plugin pane open failed (${result.status})\n`,
    );
    return result.status === -1 ? 1 : result.status;
  }
  return 0;
}

// --- entry ------------------------------------------------------------------------------

const USAGE = `rebuildup.inbox TUI (herdr-plugins.tui/v1)

Usage:
  bun run src/tui.ts          interactive inbox browser (pane entrypoint)
  bun run src/tui.ts --open   open action helper (plugin.pane.open)

Keys: see '?' inside the UI. Non-interactive fallback prints a plain list.
`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--open")) return runOpenAction();
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  const ctx = captureContext();

  if (!process.stdin.isTTY) {
    return plainMode();
  }

  const app = await TuiApp.create({
    title: `Inbox — ${ctx.session ?? ctx.socketPath ?? "rebuildup.inbox"}`,
    alternateScreen: true,
    keymap: INBOX_TUI_KEYMAP,
    farewell: ["inbox TUI closed"],
  });
  const browser = new InboxBrowser(app, ctx);
  await browser.start();
  await app.closed;
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`inbox tui failed: ${String(err)}\n`);
      process.exitCode = 1;
    });
}
