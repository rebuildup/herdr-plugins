/**
 * Tests for the rebuildup.checkpoints TUI surface (#242,
 * contract docs/contracts/tui-v1.md).
 *
 * Covers the pure helpers (context pinning, pane-open params, mutation
 * gating, payload formatting, --no-drain read args) and the view layer
 * with a fake CLI/ui — no real herdr session, no TTY required.
 */

import { describe, expect, test } from "bun:test";
import type {
  ConfirmOptions,
  SelectItem,
  SelectListOptions,
  TextInputOptions,
} from "../packages/tui/src/components";
import { DetailView } from "../packages/tui/src/components";
import { type KeyEvent, KeyParser } from "../packages/tui/src/input";
import type { Line, ScreenView } from "../packages/tui/src/screen";
import { TaskRunner } from "../packages/tui/src/task";
import type { CheckpointEntry } from "../plugins/checkpoints/src/state";
import {
  buildPaneOpenParams,
  checkpointKind,
  checkpointSelectItem,
  formatDiffPayload,
  formatGcPayload,
  formatPlanPayload,
  formatShowPayload,
  mutationAllowed,
  parsePluginContext,
  readArgs,
  resolvePinnedTarget,
  shortId,
} from "../plugins/checkpoints/src/tui-support";
import {
  CheckpointDetailView,
  CheckpointGroupDetailView,
  CheckpointGroupListView,
  CheckpointListView,
  CheckpointRetentionView,
  type CheckpointsTuiDeps,
  type CheckpointsTuiUi,
} from "../plugins/checkpoints/src/tui-views";

// --- fixtures --------------------------------------------------------------------

const NOW = "2026-01-01T00:00:00.000Z";

const ENTRY: CheckpointEntry = {
  id: "abc123def456-00000000",
  repo_root: "/repos/demo",
  repo_key: "deadbeefdeadbeef",
  ref: "refs/herdr-plugins/checkpoints/deadbeefdeadbeef/abc123def456-00000000",
  commit: "c0ffee1234567890abcdef1234567890abcdef12",
  head_sha: "feedface1234567890abcdef1234567890abcdef",
  branch: "main",
  created_at: NOW,
  label: "wip",
  kind: "manual",
};

const AUTO_ENTRY: CheckpointEntry = {
  ...ENTRY,
  id: "auto999888777-11111111",
  kind: "auto",
  group_id: "grp-1",
};

const CAPABILITY = {
  read_only: false,
  mutation_commands: ["create", "save", "delete", "restore", "restore-group", "gc", "prune"],
};

// --- fake ui / cli ---------------------------------------------------------------

interface FakeUi extends CheckpointsTuiUi {
  statuses: string[];
  confirms: ConfirmOptions[];
  prompts: string[];
  pushed: ScreenView[];
  popped: number;
  confirmResults: boolean[];
  promptResults: Array<string | null>;
  selectResult: SelectItem<unknown> | null;
}

function fakeUi(): FakeUi {
  const ui: FakeUi = {
    statuses: [],
    confirms: [],
    prompts: [],
    pushed: [],
    popped: 0,
    confirmResults: [],
    promptResults: [],
    selectResult: null,
    confirm(opts: ConfirmOptions) {
      ui.confirms.push(opts);
      return Promise.resolve(ui.confirmResults.shift() ?? true);
    },
    prompt(text: string, _opts?: TextInputOptions) {
      ui.prompts.push(text);
      return Promise.resolve(ui.promptResults.shift() ?? null);
    },
    select<T>(_opts: SelectListOptions<T>) {
      return Promise.resolve(ui.selectResult as SelectItem<T> | null);
    },
    setStatus(left: string) {
      ui.statuses.push(left);
    },
    push(view: ScreenView) {
      ui.pushed.push(view);
    },
    pop() {
      ui.popped += 1;
      return ui.pushed.pop();
    },
    tasks: new TaskRunner(),
    invalidate() {},
    close() {
      return Promise.resolve();
    },
  };
  return ui;
}

type CliHandler = (
  args: readonly string[],
) => Promise<Record<string, unknown>> | Record<string, unknown>;

function fakeCli(handler: CliHandler): {
  calls: string[][];
  fn: CheckpointsTuiDeps["cli"];
} {
  const calls: string[][] = [];
  return {
    calls,
    fn: (args) => {
      calls.push([...args]);
      return Promise.resolve(handler(args));
    },
  };
}

function makeDeps(
  cli: CheckpointsTuiDeps["cli"],
  ui: FakeUi,
  capability: CheckpointsTuiDeps["capability"] = CAPABILITY,
): CheckpointsTuiDeps {
  return {
    cli,
    ui,
    capability,
    target: {
      workspaceId: "w1",
      tabId: "w1:t1",
      originPaneId: "w1:p9",
      originCwd: "/repos/demo",
      socketPath: "/tmp/herdr.sock",
      session: "default",
    },
  };
}

function feedKeys(view: ScreenView, ...feeds: string[]): void {
  const parser = new KeyParser();
  for (const feed of feeds) {
    for (const ev of parser.feed(feed)) {
      view.handleKey?.(ev);
    }
  }
}

function keyEvent(key: string, shift = false): KeyEvent {
  return { kind: "key", key, ctrl: false, shift, alt: false };
}

function linesText(lines: Line[]): string[] {
  return lines.map((l) => l.map((s) => s.text).join(""));
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// --- context pinning -------------------------------------------------------------

describe("parsePluginContext", () => {
  test("parses valid JSON", () => {
    const ctx = parsePluginContext('{"workspace_id":"w1","focused_pane_id":"w1:p1"}');
    expect(ctx.workspace_id).toBe("w1");
    expect(ctx.focused_pane_id).toBe("w1:p1");
  });
  test("invalid/empty input yields {}", () => {
    expect(parsePluginContext("not json")).toEqual({});
    expect(parsePluginContext("")).toEqual({});
    expect(parsePluginContext(undefined)).toEqual({});
    expect(parsePluginContext("null")).toEqual({});
    expect(parsePluginContext("[1]")).toEqual({});
  });
});

describe("resolvePinnedTarget", () => {
  test("HERDR_TUI_* pins win over context JSON", () => {
    const target = resolvePinnedTarget({
      HERDR_TUI_WORKSPACE_ID: "w-pin",
      HERDR_TUI_PANE_ID: "w-pin:p1",
      HERDR_TUI_CWD: "/pin/cwd",
      HERDR_PLUGIN_CONTEXT_JSON: '{"workspace_id":"w-ctx","focused_pane_id":"w-ctx:p2"}',
    } as NodeJS.ProcessEnv);
    expect(target.workspaceId).toBe("w-pin");
    expect(target.originPaneId).toBe("w-pin:p1");
    expect(target.originCwd).toBe("/pin/cwd");
  });
  test("falls back to context JSON fields", () => {
    const target = resolvePinnedTarget({
      HERDR_PLUGIN_CONTEXT_JSON:
        '{"workspace_id":"w9","tab_id":"w9:t2","focused_pane_id":"w9:p7","focused_pane":{"cwd":"/ctx/cwd"}}',
    } as NodeJS.ProcessEnv);
    expect(target.workspaceId).toBe("w9");
    expect(target.tabId).toBe("w9:t2");
    expect(target.originPaneId).toBe("w9:p7");
    expect(target.originCwd).toBe("/ctx/cwd");
  });
  test("HERDR_PANE_ID (UI pane) is never used as origin target", () => {
    const target = resolvePinnedTarget({
      HERDR_PANE_ID: "ui:pane",
      HERDR_PLUGIN_CONTEXT_JSON: "{}",
    } as NodeJS.ProcessEnv);
    expect(target.originPaneId).toBeNull();
  });
});

describe("buildPaneOpenParams", () => {
  test("tab placement + pinned env, workspace_id only when known", () => {
    const params = buildPaneOpenParams({
      workspaceId: "w1",
      tabId: "w1:t1",
      originPaneId: "w1:p9",
      originCwd: "/repos/demo",
      socketPath: "/s",
      session: "default",
    });
    expect(params.plugin_id).toBe("rebuildup.checkpoints");
    expect(params.entrypoint).toBe("main");
    expect(params.placement).toBe("tab");
    expect(params.workspace_id).toBe("w1");
    const env = params.env as Record<string, string>;
    expect(env.HERDR_TUI_WORKSPACE_ID).toBe("w1");
    expect(env.HERDR_TUI_PANE_ID).toBe("w1:p9");
    expect(env.HERDR_TUI_CWD).toBe("/repos/demo");
  });
  test("omits unset pins honestly", () => {
    const params = buildPaneOpenParams({
      workspaceId: null,
      tabId: null,
      originPaneId: null,
      originCwd: null,
      socketPath: null,
      session: null,
    });
    expect(params.workspace_id).toBeUndefined();
    expect(params.env).toEqual({});
    expect(params.placement).toBe("tab");
  });
});

describe("readArgs / --no-drain", () => {
  test("appends --no-drain to read commands", () => {
    expect(readArgs(["list", "--limit", "10"])).toEqual(["list", "--limit", "10", "--no-drain"]);
    expect(readArgs(["show", "abc"])).toEqual(["show", "abc", "--no-drain"]);
  });
});

// --- mutation gating ---------------------------------------------------------------

describe("mutationAllowed", () => {
  test("fails closed when capability is unavailable", () => {
    const gate = mutationAllowed(null, "restore");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("unavailable");
  });
  test("read_only capability disables everything", () => {
    const gate = mutationAllowed({ read_only: true, mutation_commands: ["restore"] }, "restore");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("read_only");
  });
  test("listed command allowed, unlisted denied with reason", () => {
    expect(mutationAllowed(CAPABILITY, "gc").allowed).toBe(true);
    const denied = mutationAllowed(CAPABILITY, "tick");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("tick");
  });
});

// --- payload formatting --------------------------------------------------------------

describe("checkpoint formatting", () => {
  test("checkpointKind defaults missing kind to manual", () => {
    expect(checkpointKind(ENTRY)).toBe("manual");
    expect(checkpointKind(AUTO_ENTRY)).toBe("auto");
    expect(checkpointKind({ ...ENTRY, kind: undefined })).toBe("manual");
  });
  test("checkpointSelectItem carries kind badge, repo and group", () => {
    const item = checkpointSelectItem(AUTO_ENTRY);
    expect(item.label).toContain("[auto]");
    expect(item.label).toContain("group:grp-1");
    expect(item.detail).toContain("/repos/demo");
    expect(item.detail).toContain("group: grp-1");
  });
  test("formatShowPayload renders ref status + summary honestly", () => {
    const lines = formatShowPayload({
      checkpoint: ENTRY,
      repo_root: "/repos/demo",
      ref: { name: ENTRY.ref, exists: true, oid: ENTRY.commit },
      summary: { output: "commit abc\n\n    wip", truncated: false, bytes: 20 },
    });
    const text = lines.join("\n");
    expect(text).toContain(ENTRY.id);
    expect(text).toContain("exists");
    expect(text).toContain("wip");

    const missing = formatShowPayload({
      checkpoint: ENTRY,
      ref: { name: ENTRY.ref, exists: false, oid: null },
      summary: null,
      summary_error: "git show failed",
    });
    expect(missing.join("\n")).toContain("MISSING");
    expect(missing.join("\n")).toContain("git show failed");
  });
  test("formatDiffPayload renders sides, truncation and patch", () => {
    const lines = formatDiffPayload({
      repo_root: "/repos/demo",
      a: { kind: "checkpoint", id: ENTRY.id, rev: ENTRY.ref },
      b: { kind: "head", rev: "HEAD" },
      patch: "diff --git a/x b/x\n+hi",
      truncated: true,
      bytes: 300_000,
    });
    const text = lines.join("\n");
    expect(text).toContain(shortId(ENTRY.id));
    expect(text).toContain("HEAD");
    expect(text).toContain("truncated");
    expect(text).toContain("+hi");
  });
  test("formatPlanPayload renders counts + warnings + advisory note", () => {
    const lines = formatPlanPayload({
      checkpoint: ENTRY,
      repo_root: "/repos/demo",
      commit: ENTRY.commit,
      ref: { name: ENTRY.ref, exists: true, oid: ENTRY.commit },
      plan: { files_to_change: 3, untracked_to_delete: 2, already_matches: false },
      warnings: ["submodule gitlinks recorded"],
    });
    const text = lines.join("\n");
    expect(text).toContain("files to change: 3");
    expect(text).toContain("untracked files to delete: 2");
    expect(text).toContain("submodule gitlinks");
    expect(text).toContain("advisory");
  });
  test("formatGcPayload dry-run vs applied + unreachable honesty", () => {
    const dry = formatGcPayload(
      {
        command: "gc",
        ok: true,
        dry_run: true,
        policy: { max_count: 50, max_age_days: 30, pre_restore_protect_days: 7 },
        repos: [
          {
            repo_root: "/repos/demo",
            evaluated: 5,
            would_delete: ["id1", "id2"],
            protected: ["pre1"],
            kept: 3,
          },
        ],
        unreachable: [{ repo_root: "/gone", kind: "not_a_repo", message: "no git" }],
        totals: { evaluated: 5, would_delete: 2, protected: 1, kept: 3, errors: 0 },
      },
      "gc",
    );
    const dryText = dry.join("\n");
    expect(dryText).toContain("gc dry-run");
    expect(dryText).toContain("would delete: 2");
    expect(dryText).toContain("protected");
    expect(dryText).toContain("unreachable: /gone");

    const applied = formatGcPayload(
      {
        command: "prune",
        ok: true,
        dry_run: false,
        repos: [{ repo_root: "/r", scanned: 4, orphans: ["refs/x"], deleted: ["refs/x"] }],
        unreachable: [],
        totals: { scanned: 4, orphans: 1, deleted: 1, errors: 0 },
      },
      "prune",
    );
    const appliedText = applied.join("\n");
    expect(appliedText).toContain("prune — ok: yes");
    expect(appliedText).toContain("orphan: refs/x");
    expect(appliedText).toContain("deleted: 1");
  });
});

// --- CheckpointListView -----------------------------------------------------------------

function listPayload(entries: CheckpointEntry[] = [ENTRY, AUTO_ENTRY]) {
  return { contract: "herdr-plugins.checkpoints/v1", command: "list", checkpoints: entries };
}

describe("CheckpointListView", () => {
  test("loads with --no-drain and renders kind badges", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(() => listPayload());
    const view = new CheckpointListView(makeDeps(fn, ui));
    await view.load();
    // Read-only open: every list call carries --no-drain.
    expect(calls.every((c) => c.includes("--no-drain"))).toBe(true);
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("[manual]");
    expect(text).toContain("[auto]");
    expect(text).toContain("group:grp-1");
  });

  test("empty index shows honest empty text", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => listPayload([]));
    const view = new CheckpointListView(makeDeps(fn, ui));
    await view.load();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("no checkpoints");
  });

  test("load failure renders the real error, not a fake list", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => {
      throw new Error("state lock timed out");
    });
    const view = new CheckpointListView(makeDeps(fn, ui));
    await view.load();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("failed to load checkpoints");
    expect(text).toContain("state lock timed out");
  });

  test("enter pushes CheckpointDetailView for the selected id", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => listPayload());
    const view = new CheckpointListView(makeDeps(fn, ui));
    await view.load();
    feedKeys(view, "\r");
    expect(ui.pushed.length).toBe(1);
    expect(ui.pushed[0]).toBeInstanceOf(CheckpointDetailView);
  });

  test("c captures the PINNED pane id — never HERDR_PANE_ID", async () => {
    const ui = fakeUi();
    ui.promptResults.push(""); // label prompt → empty → no --label
    const { calls, fn } = fakeCli((args) => {
      if (args[0] === "list") return listPayload();
      if (args[0] === "create") {
        return {
          command: "create",
          ok: true,
          pane_id: "w1:p9",
          repo_root: "/repos/demo",
          checkpoint: ENTRY,
        };
      }
      return {};
    });
    const view = new CheckpointListView(makeDeps(fn, ui));
    await view.load();
    feedKeys(view, "c");
    await flush(20);
    const createCall = calls.find((c) => c[0] === "create");
    expect(createCall).toBeDefined();
    // Explicit pane id argv — the UI pane's own HERDR_PANE_ID is never used.
    expect(createCall?.[1]).toBe("w1:p9");
    expect(ui.confirms.length).toBe(1);
    expect(ui.confirms[0]?.target?.join(" ")).toContain("w1:p9");
    expect(ui.confirms[0]?.target?.join(" ")).toContain("NOT the TUI pane");
  });

  test("w captures by explicit --repo path after prompts+confirm", async () => {
    const ui = fakeUi();
    ui.promptResults.push("/tmp/somerepo", "");
    const { calls, fn } = fakeCli((args) => {
      if (args[0] === "list") return listPayload();
      if (args[0] === "create") {
        return {
          command: "create",
          ok: true,
          pane_id: null,
          repo_root: "/tmp/somerepo",
          checkpoint: ENTRY,
        };
      }
      return {};
    });
    const view = new CheckpointListView(makeDeps(fn, ui));
    await view.load();
    feedKeys(view, "w");
    await flush(20);
    const createCall = calls.find((c) => c[0] === "create");
    expect(createCall).toEqual(["create", "--repo", "/tmp/somerepo"]);
  });

  test("mutations disabled when capability is null", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(() => listPayload());
    const deps = makeDeps(fn, ui, null);
    const view = new CheckpointListView(deps);
    await view.load();
    feedKeys(view, "c");
    await flush();
    expect(calls.some((c) => c[0] === "create")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });

  test("a drains pending captures WITHOUT --no-drain (explicit action)", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(() => ({
      ...listPayload(),
      auto_captures: { captured: ["x1"], skipped: [] },
    }));
    const view = new CheckpointListView(makeDeps(fn, ui));
    await view.load();
    feedKeys(view, "a");
    await flush(20);
    const drainCall = calls.find((c) => c[0] === "list" && !c.includes("--no-drain"));
    expect(drainCall).toBeDefined();
  });
});

// --- CheckpointDetailView ----------------------------------------------------------------

function detailPayload(overrides: Record<string, unknown> = {}) {
  return {
    contract: "herdr-plugins.checkpoints/v1",
    command: "show",
    checkpoint: ENTRY,
    repo_root: "/repos/demo",
    ref: { name: ENTRY.ref, exists: true, oid: ENTRY.commit },
    summary: { output: "commit abc\n\n    wip", truncated: false, bytes: 20 },
    ...overrides,
  };
}

function detailCli(opts: { checkpoint?: CheckpointEntry | null } = {}): CliHandler {
  return (args) => {
    const key = args.filter((a) => a !== "--no-drain").join(" ");
    if (key === "show abc123def456-00000000") {
      const entry = "checkpoint" in opts ? (opts.checkpoint as CheckpointEntry | null) : ENTRY;
      if (entry === null) {
        throw Object.assign(new Error("no checkpoint with id"), { kind: "unknown_checkpoint" });
      }
      return detailPayload({ checkpoint: entry });
    }
    if (args[0] === "restore") {
      return {
        command: "restore",
        ok: true,
        checkpoint: ENTRY,
        repo_root: "/repos/demo",
        restored_commit: ENTRY.commit,
        pre_restore: { id: "pre1", ref: "refs/x", commit: "c1", label: "pre-restore" },
        isolation: "single_pane",
        sharing_panes: [],
        clean_passes: 1,
        warnings: [],
      };
    }
    if (args[0] === "delete") {
      return { command: "delete", ok: true, id: ENTRY.id, ref_existed: true, warnings: [] };
    }
    if (args[0] === "plan") {
      return {
        command: "plan",
        checkpoint: ENTRY,
        repo_root: "/repos/demo",
        commit: ENTRY.commit,
        plan: { files_to_change: 1, untracked_to_delete: 0, already_matches: false },
        warnings: [],
      };
    }
    if (args[0] === "diff") {
      return {
        command: "diff",
        repo_root: "/repos/demo",
        a: { kind: "checkpoint", id: ENTRY.id },
        b: { kind: "head", rev: "HEAD" },
        patch: "diff --git a/x b/x",
        truncated: false,
        bytes: 100,
      };
    }
    return {};
  };
}

describe("CheckpointDetailView", () => {
  test("loads show --no-drain and renders header + summary", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(detailCli());
    const view = new CheckpointDetailView(makeDeps(fn, ui), ENTRY.id);
    await flush(20);
    const showCalls = calls.filter((c) => c[0] === "show");
    expect(showCalls.length).toBeGreaterThanOrEqual(1);
    expect(showCalls[0]).toContain("--no-drain");
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain(ENTRY.id);
    expect(text).toContain("/repos/demo");
    expect(text).toContain("wip");
  });

  test("missing checkpoint renders honest missing state", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(detailCli({ checkpoint: null }));
    const view = new CheckpointDetailView(makeDeps(fn, ui), ENTRY.id);
    await flush(20);
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("checkpoint not found");
  });

  test("plan preview is read-only (--no-drain) and pushes DetailView", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(detailCli());
    const view = new CheckpointDetailView(makeDeps(fn, ui), ENTRY.id);
    await flush(20);
    view.handleKey?.(keyEvent("p"));
    await flush(20);
    const planCall = calls.find((c) => c[0] === "plan");
    expect(planCall).toContain("--no-drain");
    expect(planCall).toContain(ENTRY.id);
    expect(ui.pushed.length).toBe(1);
  });

  test("diff vs HEAD is read-only and pushes diff viewer", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(detailCli());
    const view = new CheckpointDetailView(makeDeps(fn, ui), ENTRY.id);
    await flush(20);
    view.handleKey?.(keyEvent("d"));
    await flush(20);
    const diffCall = calls.find((c) => c[0] === "diff");
    expect(diffCall).toEqual(["diff", ENTRY.id, "HEAD", "--no-drain"]);
    expect(ui.pushed.length).toBe(1);
  });

  test("restore: gate → revalidate → danger confirm → cli restore → result", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true);
    const { calls, fn } = fakeCli(detailCli());
    const view = new CheckpointDetailView(makeDeps(fn, ui), ENTRY.id);
    await flush(20);
    view.handleKey?.(keyEvent("r"));
    await flush(30);
    const restoreCall = calls.find((c) => c[0] === "restore");
    expect(restoreCall).toEqual(["restore", ENTRY.id]);
    // Mutation keeps normal drain semantics — NO --no-drain.
    expect(restoreCall).not.toContain("--no-drain");
    const confirm = ui.confirms[0];
    expect(confirm?.danger).toBe(true);
    expect(confirm?.target?.join(" ")).toContain(ENTRY.id);
    expect(confirm?.consequence).toContain("pre-restore");
    // result detail view pushed
    expect(ui.pushed.length).toBe(1);
    expect(ui.pushed[0]).toBeInstanceOf(DetailView);
  });

  test("stale checkpoint aborts restore with honest status", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true);
    let showCalls = 0;
    const { calls, fn } = fakeCli((args) => {
      const key = args.filter((a) => a !== "--no-drain").join(" ");
      if (key === `show ${ENTRY.id}`) {
        showCalls += 1;
        if (showCalls === 1) return detailPayload();
        throw Object.assign(new Error("no checkpoint with id"), { kind: "unknown_checkpoint" });
      }
      if (args[0] === "repos list") return {};
      return detailCli()(args);
    });
    const view = new CheckpointDetailView(makeDeps(fn, ui), ENTRY.id);
    await flush(20);
    view.handleKey?.(keyEvent("r"));
    await flush(30);
    expect(calls.some((c) => c[0] === "restore")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("stale");
  });

  test("restore confirm cancel aborts before any mutation", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(false);
    const { calls, fn } = fakeCli(detailCli());
    const view = new CheckpointDetailView(makeDeps(fn, ui), ENTRY.id);
    await flush(20);
    view.handleKey?.(keyEvent("r"));
    await flush(30);
    expect(calls.some((c) => c[0] === "restore")).toBe(false);
  });

  test("delete: confirm → cli delete → pops back", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true);
    const { calls, fn } = fakeCli(detailCli());
    const view = new CheckpointDetailView(makeDeps(fn, ui), ENTRY.id);
    await flush(20);
    view.handleKey?.(keyEvent("x"));
    await flush(30);
    expect(calls.some((c) => c[0] === "delete" && c[1] === ENTRY.id)).toBe(true);
    expect(ui.popped).toBeGreaterThanOrEqual(1);
  });
});

// --- groups -------------------------------------------------------------------------

describe("CheckpointGroupListView", () => {
  test("groups checkpoints by group_id from a --no-drain list", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(() => listPayload([ENTRY, AUTO_ENTRY]));
    const view = new CheckpointGroupListView(makeDeps(fn, ui));
    await flush(20);
    expect(calls[0]).toContain("--no-drain");
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("grp-1");
    expect(text).toContain("1 checkpoint(s)");
  });

  test("empty groups renders honest empty text", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => listPayload([ENTRY]));
    const view = new CheckpointGroupListView(makeDeps(fn, ui));
    await flush(20);
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("no checkpoint groups");
  });
});

describe("CheckpointGroupDetailView", () => {
  test("lists members via list --group --no-drain", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli((args) => {
      const key = args.filter((a) => a !== "--no-drain").join(" ");
      if (key.startsWith("list --group")) return listPayload([AUTO_ENTRY]);
      return {};
    });
    const view = new CheckpointGroupDetailView(makeDeps(fn, ui), "grp-1");
    await flush(20);
    const listCall = calls.find((c) => c[0] === "list");
    expect(listCall).toContain("--group");
    expect(listCall).toContain("--no-drain");
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("grp-1");
    expect(text).toContain("[auto]");
  });

  test("r restore-group: danger confirm → cli restore-group", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true);
    const { calls, fn } = fakeCli((args) => {
      const key = args.filter((a) => a !== "--no-drain").join(" ");
      if (key.startsWith("list --group")) return listPayload([AUTO_ENTRY]);
      if (args[0] === "restore-group") {
        return {
          command: "restore-group",
          ok: true,
          group: "grp-1",
          total: 1,
          succeeded: 1,
          failed: 0,
          results: [
            { id: AUTO_ENTRY.id, repo_root: "/repos/demo", ok: true, restored_commit: "c" },
          ],
        };
      }
      return {};
    });
    const view = new CheckpointGroupDetailView(makeDeps(fn, ui), "grp-1");
    await flush(20);
    view.handleKey?.(keyEvent("r"));
    await flush(30);
    const rgCall = calls.find((c) => c[0] === "restore-group");
    expect(rgCall).toEqual(["restore-group", "grp-1"]);
    expect(ui.confirms[0]?.danger).toBe(true);
    expect(ui.confirms[0]?.target?.join(" ")).toContain("grp-1");
  });
});

// --- retention (gc / prune) -----------------------------------------------------------

describe("CheckpointRetentionView", () => {
  const gcDryPayload = {
    command: "gc",
    ok: true,
    dry_run: true,
    policy: { max_count: 50, max_age_days: 30, pre_restore_protect_days: 7 },
    repos: [
      { repo_root: "/repos/demo", evaluated: 3, would_delete: ["old1"], protected: [], kept: 2 },
    ],
    unreachable: [],
    totals: { evaluated: 3, would_delete: 1, protected: 0, kept: 2, errors: 0 },
  };

  test("gc opens with dry-run (--no-drain) before anything else", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli((args) => {
      if (args[0] === "gc") return gcDryPayload;
      return {};
    });
    const view = new CheckpointRetentionView(makeDeps(fn, ui), "gc");
    await flush(20);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(["gc", "--dry-run", "--no-drain"]);
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("gc dry-run");
    expect(text).toContain("would delete: 1");
  });

  test("a applies gc only after gate + confirm; apply has no --dry-run", async () => {
    const ui = fakeUi();
    ui.confirmResults.push(true);
    const { calls, fn } = fakeCli((args) => {
      if (args[0] === "gc" && args.includes("--dry-run")) return gcDryPayload;
      if (args[0] === "gc") {
        return { ...gcDryPayload, dry_run: false, totals: { deleted: 1 } };
      }
      return {};
    });
    const view = new CheckpointRetentionView(makeDeps(fn, ui), "gc");
    await flush(20);
    view.handleKey?.(keyEvent("a"));
    await flush(30);
    const applyCall = calls.find((c) => c[0] === "gc" && !c.includes("--dry-run"));
    expect(applyCall).toEqual(["gc"]);
    expect(ui.confirms[0]?.danger).toBe(true);
    expect(ui.confirms[0]?.target?.join(" ")).toContain("would delete: 1");
  });

  test("apply blocked when capability is null (fail closed)", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(() => gcDryPayload);
    const view = new CheckpointRetentionView(makeDeps(fn, ui, null), "gc");
    await flush(20);
    view.handleKey?.(keyEvent("a"));
    await flush(10);
    expect(calls.filter((c) => c[0] === "gc" && !c.includes("--dry-run")).length).toBe(0);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });

  test("prune uses the same dry-run-first flow", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli((args) => {
      if (args[0] === "prune") {
        return {
          command: "prune",
          ok: true,
          dry_run: true,
          repos: [{ repo_root: "/r", scanned: 4, orphans: ["refs/orphan1"] }],
          unreachable: [],
          totals: { scanned: 4, orphans: 1, would_delete: 1, errors: 0 },
        };
      }
      return {};
    });
    const view = new CheckpointRetentionView(makeDeps(fn, ui), "prune");
    await flush(20);
    expect(calls[0]).toEqual(["prune", "--dry-run", "--no-drain"]);
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("prune dry-run");
    expect(text).toContain("orphan: refs/orphan1");
  });
});
