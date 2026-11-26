/**
 * Tests for the rebuildup.artifacts TUI surface (#247,
 * contract docs/contracts/tui-v1.md).
 *
 * Covers the pure helpers (context pinning, pane-open params, mutation
 * gating, payload formatting) and the view layer with a fake CLI/ui —
 * no real herdr session, no TTY required.
 */

import { describe, expect, test } from "bun:test";
import type {
  ConfirmOptions,
  SelectItem,
  SelectListOptions,
  TextInputOptions,
} from "../packages/tui/src/components";
import type { KeyEvent } from "../packages/tui/src/input";
import type { Line, ScreenView } from "../packages/tui/src/screen";
import { TaskRunner } from "../packages/tui/src/task";
import {
  ArtifactsCliError,
  type ArtifactView,
  artifactHeaderLines,
  artifactSelectItem,
  asArtifact,
  asArtifacts,
  buildPaneOpenParams,
  formatDeliverResult,
  formatGcPayload,
  formatIndexMeta,
  formatTargetLabel,
  formatVerifyPayload,
  mutationAllowed,
  parsePluginContext,
  resolvePinnedTarget,
} from "../plugins/artifacts/src/tui-support";
import {
  ArtifactDetailView,
  ArtifactListView,
  type ArtifactsTuiDeps,
  type ArtifactsTuiUi,
} from "../plugins/artifacts/src/tui-views";

// --- fixtures --------------------------------------------------------------------

const ARTIFACT_PAYLOAD = {
  contract: "herdr-plugins.artifacts/v1",
  artifact_id: "art-abc123",
  kind: "html",
  title: "Weekly report",
  host: "test-host",
  session: "default",
  owner: { pane_id: "w1:p9", agent_session: "sess-1", created_by: "cli" },
  storage: {
    mode: "state_copy",
    ref: "artifacts/art-abc123/report.html",
    resolved_path: "/state/artifacts/art-abc123/report.html",
  },
  size: 4096,
  mime: "text/html",
  sha256: "deadbeef",
  oversize: false,
  missing_ref: false,
  owner_stale: false,
  created_at: "2026-01-01T00:00:00.000Z",
  refs: ["handoff:h1"],
  warnings: [],
};

const ARTIFACT: ArtifactView = asArtifact(ARTIFACT_PAYLOAD) as ArtifactView;

const CAPABILITY = {
  read_only: false,
  mutation_commands: ["register", "delete", "deliver", "gc"],
};

const TARGET = {
  workspaceId: "w1",
  tabId: "w1:t1",
  originPaneId: "w1:p9",
  originCwd: "/repo",
  socketPath: "/tmp/herdr.sock",
  session: "default",
};

// --- fake ui / cli ---------------------------------------------------------------

interface FakeUi extends ArtifactsTuiUi {
  statuses: string[];
  confirms: ConfirmOptions[];
  prompts: Array<{ text: string; value: string | undefined }>;
  pushed: ScreenView[];
  confirmResults: boolean[];
  promptResults: Array<string | null>;
}

function fakeUi(): FakeUi {
  const ui: FakeUi = {
    statuses: [],
    confirms: [],
    prompts: [],
    pushed: [],
    confirmResults: [],
    promptResults: [],
    confirm(opts: ConfirmOptions) {
      ui.confirms.push(opts);
      return Promise.resolve(ui.confirmResults.shift() ?? true);
    },
    prompt(text: string, opts?: TextInputOptions) {
      ui.prompts.push({ text, value: opts?.value });
      return Promise.resolve(ui.promptResults.shift() ?? null);
    },
    select<T>(_opts: SelectListOptions<T>) {
      return Promise.resolve(null as SelectItem<T> | null);
    },
    setStatus(left: string) {
      ui.statuses.push(left);
    },
    push(view: ScreenView) {
      ui.pushed.push(view);
    },
    pop() {
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
  fn: ArtifactsTuiDeps["cli"];
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
  cli: ArtifactsTuiDeps["cli"],
  ui: FakeUi,
  capability: ArtifactsTuiDeps["capability"] = CAPABILITY,
): ArtifactsTuiDeps {
  return { cli, ui, capability, target: TARGET };
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
  test("parses valid JSON, rejects garbage", () => {
    expect(parsePluginContext('{"workspace_id":"w1"}').workspace_id).toBe("w1");
    expect(parsePluginContext("not json")).toEqual({});
    expect(parsePluginContext("")).toEqual({});
    expect(parsePluginContext("[1]")).toEqual({});
  });
});

describe("resolvePinnedTarget", () => {
  test("HERDR_TUI_* pins win over context JSON", () => {
    const target = resolvePinnedTarget({
      HERDR_TUI_WORKSPACE_ID: "w-pin",
      HERDR_TUI_PANE_ID: "w-pin:p1",
      HERDR_PLUGIN_CONTEXT_JSON: '{"workspace_id":"w-ctx"}',
    } as NodeJS.ProcessEnv);
    expect(target.workspaceId).toBe("w-pin");
    expect(target.originPaneId).toBe("w-pin:p1");
  });
  test("HERDR_PANE_ID (UI pane) is never the origin target", () => {
    const target = resolvePinnedTarget({
      HERDR_PANE_ID: "ui:pane",
      HERDR_PLUGIN_CONTEXT_JSON: "{}",
    } as NodeJS.ProcessEnv);
    expect(target.originPaneId).toBeNull();
  });
});

describe("buildPaneOpenParams", () => {
  test("tab placement + pinned env + plugin id", () => {
    const params = buildPaneOpenParams(TARGET);
    expect(params.plugin_id).toBe("rebuildup.artifacts");
    expect(params.entrypoint).toBe("main");
    expect(params.placement).toBe("tab");
    expect(params.workspace_id).toBe("w1");
    const env = params.env as Record<string, string>;
    expect(env.HERDR_TUI_PANE_ID).toBe("w1:p9");
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
  });
});

describe("formatTargetLabel", () => {
  test("renders pinned parts and honest empty state", () => {
    expect(formatTargetLabel(TARGET)).toContain("ws w1");
    expect(formatTargetLabel(TARGET)).toContain("pane w1:p9");
    expect(
      formatTargetLabel({
        workspaceId: null,
        tabId: null,
        originPaneId: null,
        originCwd: null,
        socketPath: null,
        session: null,
      }),
    ).toBe("no pinned target");
  });
});

// --- gating + formatting ---------------------------------------------------------

describe("mutationAllowed", () => {
  test("fail closed on null capability", () => {
    expect(mutationAllowed(null, "delete").allowed).toBe(false);
  });
  test("allows listed commands, denies others", () => {
    expect(mutationAllowed(CAPABILITY, "delete").allowed).toBe(true);
    expect(mutationAllowed(CAPABILITY, "verify").allowed).toBe(false);
    expect(
      mutationAllowed({ read_only: true, mutation_commands: ["delete"] }, "delete").allowed,
    ).toBe(false);
  });
});

describe("artifact view model", () => {
  test("asArtifact parses annotated record; malformed → null", () => {
    expect(ARTIFACT?.artifact_id).toBe("art-abc123");
    expect(ARTIFACT?.missing_ref).toBe(false);
    expect(asArtifact({ artifact_id: "" })).toBeNull();
    expect(asArtifact(null)).toBeNull();
    expect(asArtifacts([ARTIFACT_PAYLOAD, { bad: true }])).toHaveLength(1);
  });
  test("artifactSelectItem surfaces warnings honestly", () => {
    const item = artifactSelectItem({ ...ARTIFACT, missing_ref: true });
    expect(item.label).toContain("missing");
    expect(item.detail).toContain("path:");
  });
  test("artifactHeaderLines: html gets external-open guidance, no payload", () => {
    const lines = artifactHeaderLines(ARTIFACT).join("\n");
    expect(lines).toContain("metadata only");
    expect(lines).toContain("isolated");
    expect(lines).toContain("/state/artifacts/art-abc123/report.html");
    expect(lines).not.toContain("<html");
  });
});

describe("payload formatters", () => {
  test("formatVerifyPayload renders summary + per-artifact status", () => {
    const lines = formatVerifyPayload({
      summary: { total: 2, ok: 1, corrupt: 1, missing: 0 },
      results: [
        { artifact_id: "art-a", status: "ok", issues: [], checks: {} },
        { artifact_id: "art-b", status: "corrupt", issues: ["sha256_mismatch"], checks: {} },
      ],
      orphans: [],
      corrupt: [],
    });
    const text = lines.join("\n");
    expect(text).toContain("total 2");
    expect(text).toContain("art-b — corrupt (sha256_mismatch)");
  });
  test("formatGcPayload dry-run vs applied labels", () => {
    const dry = formatGcPayload({
      policy: { older_than: "2026-01-01T00:00:00Z" },
      dry_run: true,
      evaluated: 3,
      expired: 2,
      totals: {
        deleted: 0,
        would_delete: 2,
        skipped_referenced: 0,
        skipped_other: 0,
        kept: 1,
        errors: 0,
      },
      entries: [{ artifact_id: "art-a", action: "would_delete", storage_mode: "state_copy" }],
    });
    expect(dry.join("\n")).toContain("dry-run");
    expect(dry.join("\n")).toContain("would_delete 2");
  });
  test("formatIndexMeta reports truncation + orphans honestly", () => {
    const lines = formatIndexMeta({
      total: 10,
      artifacts: [{}],
      orphans: ["art-x"],
      corrupt: [],
    });
    expect(lines.join("\n")).toContain("1 of 10");
    expect(lines.join("\n")).toContain("orphans: 1");
  });
  test("formatDeliverResult shows method + message", () => {
    const lines = formatDeliverResult({
      artifact_id: "art-a",
      target: { kind: "agent", pane_id: "w1:p9" },
      method: "agent.prompt",
      message: "[artifacts] art-a\npath: /x",
    });
    expect(lines.join("\n")).toContain("agent.prompt");
    expect(lines.join("\n")).toContain("path: /x");
  });
});

// --- list view ---------------------------------------------------------------------

describe("ArtifactListView", () => {
  test("load renders list items via `list --limit 0` (read-only)", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => ({
      artifacts: [ARTIFACT_PAYLOAD],
      total: 1,
      orphans: [],
      corrupt: [],
    }));
    const view = new ArtifactListView(makeDeps(cli.fn, ui), () => {});
    await view.load();
    await flush();
    expect(cli.calls).toEqual([["list", "--limit", "0"]]);
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("art-abc123");
    expect(text).toContain("Weekly report");
  });

  test("load error renders honestly", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => {
      throw new ArtifactsCliError("session unreachable", "session_unreachable");
    });
    const view = new ArtifactListView(makeDeps(cli.fn, ui), () => {});
    await view.load();
    await flush();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("failed to load artifacts");
    expect(text).toContain("session_unreachable");
  });

  test("register flow: gated, confirmed, argv correct", async () => {
    const ui = fakeUi();
    ui.promptResults = ["/tmp/report.html", "", "", ""]; // path, kind-select bypassed? see below
    // kind/storage use ui.select → our fake returns null → flow aborts.
    // Use a select fake that picks values.
    const cli = fakeCli((args) => {
      if (args[0] === "register") {
        return { artifact: ARTIFACT_PAYLOAD };
      }
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    // Custom select: kind=html, storage=state_copy
    let selectCount = 0;
    ui.select = <T>(_opts: SelectListOptions<T>): Promise<SelectItem<T> | null> => {
      selectCount += 1;
      const value = selectCount === 1 ? "html" : "state_copy";
      return Promise.resolve({ value, label: value } as SelectItem<T>);
    };
    const view = new ArtifactListView(deps, () => {});
    await view.load();
    // feed "n"
    view.handleKey({ kind: "key", key: "n", ctrl: false, shift: false, alt: false } as KeyEvent);
    await flush(30);
    // prompts: path, title, refs → we supplied 4 results; first is path.
    const registerCall = cli.calls.find((c) => c[0] === "register");
    expect(registerCall).toBeDefined();
    expect(registerCall).toContain("--path");
    expect(registerCall).toContain("/tmp/report.html");
    expect(registerCall).toContain("--kind");
    expect(registerCall).toContain("html");
    expect(registerCall).toContain("--storage");
    expect(registerCall).toContain("state_copy");
    expect(registerCall).toContain("--created-by");
    expect(ui.confirms.some((c) => c.title === "Register artifact?")).toBe(true);
  });

  test("register disabled when capability missing (fail closed)", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => ({}));
    const view = new ArtifactListView(makeDeps(cli.fn, ui, null), () => {});
    await view.load();
    view.handleKey({ kind: "key", key: "n", ctrl: false, shift: false, alt: false } as KeyEvent);
    await flush();
    expect(ui.statuses.join("\n")).toContain("mutations disabled");
    expect(cli.calls.filter((c) => c[0] === "register")).toHaveLength(0);
  });
});

// --- detail view --------------------------------------------------------------------

describe("ArtifactDetailView", () => {
  test("loads via `get` and renders metadata + preview guidance", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[0] === "get") return { artifact: ARTIFACT_PAYLOAD };
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    const view = new ArtifactDetailView(deps, "art-abc123");
    await flush(20);
    const text = linesText(view.render(110, 30)).join("\n");
    expect(text).toContain("art-abc123");
    expect(text).toContain("metadata only");
    expect(text).toContain("open externally");
  });

  test("missing artifact renders honest missing state", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => {
      throw new ArtifactsCliError("not found", "artifact_not_found");
    });
    const deps = makeDeps(cli.fn, ui);
    const view = new ArtifactDetailView(deps, "art-gone");
    await flush(20);
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("artifact not found");
  });

  test("delete: confirm → revalidate(get) → delete; success reloads", async () => {
    const ui = fakeUi();
    const calls: string[][] = [];
    const cli = fakeCli((args) => {
      calls.push([...args]);
      if (args[0] === "get") return { artifact: ARTIFACT_PAYLOAD };
      if (args[0] === "delete")
        return { artifact_id: "art-abc123", storage_mode: "state_copy", removed_payload: true };
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    const view = new ArtifactDetailView(deps, "art-abc123");
    await flush(20);
    view.handleKey({ kind: "key", key: "d", ctrl: false, shift: false, alt: false } as KeyEvent);
    await flush(30);
    expect(ui.confirms.some((c) => c.title === "Delete artifact?")).toBe(true);
    const del = calls.find((c) => c[0] === "delete");
    expect(del).toEqual(["delete", "art-abc123"]);
    expect(ui.statuses.join("\n")).toContain("deleted art-abc123");
  });

  test("delete of referenced artifact: first refusal → second force confirm → --force", async () => {
    const ui = fakeUi();
    ui.confirmResults = [true, true, true]; // delete? + stale? no + force?
    const calls: string[][] = [];
    let deleteAttempts = 0;
    const cli = fakeCli((args) => {
      calls.push([...args]);
      if (args[0] === "get") return { artifact: ARTIFACT_PAYLOAD };
      if (args[0] === "delete") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          throw new ArtifactsCliError("referenced", "referenced", { refs: ["handoff:h1"] });
        }
        return { artifact_id: "art-abc123", storage_mode: "state_copy", removed_payload: true };
      }
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    const view = new ArtifactDetailView(deps, "art-abc123");
    await flush(20);
    view.handleKey({ kind: "key", key: "d", ctrl: false, shift: false, alt: false } as KeyEvent);
    await flush(40);
    const forceConfirm = ui.confirms.find((c) => c.title.includes("force delete"));
    expect(forceConfirm).toBeDefined();
    expect(forceConfirm?.danger).toBe(true);
    const forced = calls.find((c) => c.includes("--force"));
    expect(forced).toEqual(["delete", "art-abc123", "--force"]);
    expect(ui.statuses.join("\n")).toContain("forced");
  });

  test("delete cancelled at confirm performs no mutation", async () => {
    const ui = fakeUi();
    ui.confirmResults = [false];
    const calls: string[][] = [];
    const cli = fakeCli((args) => {
      calls.push([...args]);
      if (args[0] === "get") return { artifact: ARTIFACT_PAYLOAD };
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    const view = new ArtifactDetailView(deps, "art-abc123");
    await flush(20);
    view.handleKey({ kind: "key", key: "d", ctrl: false, shift: false, alt: false } as KeyEvent);
    await flush(20);
    expect(calls.filter((c) => c[0] === "delete")).toHaveLength(0);
  });

  test("deliver flow confirms exact target then runs deliver argv", async () => {
    const ui = fakeUi();
    // select: kind=agent; confirm pinned pane=yes; note prompt; final confirm
    ui.promptResults = ["a note"];
    let selects = 0;
    ui.select = <T>(_opts: SelectListOptions<T>) => {
      selects += 1;
      const value = selects === 1 ? "agent" : "right";
      return Promise.resolve({ value, label: value } as SelectItem<T>);
    };
    const calls: string[][] = [];
    const cli = fakeCli((args) => {
      calls.push([...args]);
      if (args[0] === "get") return { artifact: ARTIFACT_PAYLOAD };
      if (args[0] === "deliver") {
        return {
          artifact_id: "art-abc123",
          target: { kind: "agent", pane_id: "w1:p9" },
          method: "agent.prompt",
          message: "[artifacts] art-abc123",
        };
      }
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    const view = new ArtifactDetailView(deps, "art-abc123");
    await flush(20);
    view.handleKey({ kind: "key", key: "l", ctrl: false, shift: false, alt: false } as KeyEvent);
    await flush(40);
    const deliver = calls.find((c) => c[0] === "deliver");
    expect(deliver).toEqual(["deliver", "art-abc123", "--agent", "w1:p9", "--note", "a note"]);
    expect(ui.confirms.some((c) => c.title === "Deliver artifact reference?")).toBe(true);
  });

  test("open externally uses injected opener with resolved_path only", async () => {
    const ui = fakeUi();
    const opened: string[] = [];
    const cli = fakeCli((args) => {
      if (args[0] === "get") return { artifact: ARTIFACT_PAYLOAD };
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    deps.openPath = (target: string) => {
      opened.push(target);
      return Promise.resolve({ ok: true });
    };
    const view = new ArtifactDetailView(deps, "art-abc123");
    await flush(20);
    view.handleKey({ kind: "key", key: "o", ctrl: false, shift: false, alt: false } as KeyEvent);
    await flush(10);
    expect(opened).toEqual(["/state/artifacts/art-abc123/report.html"]);
    expect(ui.statuses.join("\n")).toContain("opened externally");
  });
});

// --- gc flow -------------------------------------------------------------------------

describe("gc flow (list view)", () => {
  test("dry-run preview first, then explicit confirm before real gc", async () => {
    const ui = fakeUi();
    ui.promptResults = ["2026-01-01T00:00:00Z"];
    const calls: string[][] = [];
    const cli = fakeCli((args) => {
      calls.push([...args]);
      if (args[0] === "list") {
        return { artifacts: [ARTIFACT_PAYLOAD], total: 1, orphans: [], corrupt: [] };
      }
      if (args[0] === "gc" && args.includes("--dry-run")) {
        return {
          policy: { older_than: "2026-01-01T00:00:00Z" },
          dry_run: true,
          evaluated: 1,
          expired: 1,
          totals: {
            deleted: 0,
            would_delete: 1,
            skipped_referenced: 0,
            skipped_other: 0,
            kept: 0,
            errors: 0,
          },
          entries: [
            { artifact_id: "art-abc123", action: "would_delete", storage_mode: "state_copy" },
          ],
        };
      }
      if (args[0] === "gc") {
        return {
          policy: { older_than: "2026-01-01T00:00:00Z" },
          dry_run: false,
          evaluated: 1,
          expired: 1,
          totals: {
            deleted: 1,
            would_delete: 0,
            skipped_referenced: 0,
            skipped_other: 0,
            kept: 0,
            errors: 0,
          },
          entries: [{ artifact_id: "art-abc123", action: "deleted", storage_mode: "state_copy" }],
        };
      }
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    const view = new ArtifactListView(deps, () => {});
    await view.load();
    view.handleKey({ kind: "key", key: "g", ctrl: false, shift: false, alt: false } as KeyEvent);
    await flush(40);
    const gcCalls = calls.filter((c) => c[0] === "gc");
    expect(gcCalls[0]).toEqual(["gc", "--older-than", "2026-01-01T00:00:00Z", "--dry-run"]);
    expect(gcCalls[1]).toEqual(["gc", "--older-than", "2026-01-01T00:00:00Z"]);
    expect(ui.confirms.some((c) => c.title === "Collect expired artifacts?")).toBe(true);
  });

  test("gc with nothing to collect never runs the real gc", async () => {
    const ui = fakeUi();
    ui.promptResults = ["2026-01-01T00:00:00Z"];
    const calls: string[][] = [];
    const cli = fakeCli((args) => {
      calls.push([...args]);
      if (args[0] === "list") {
        return { artifacts: [], total: 0, orphans: [], corrupt: [] };
      }
      if (args[0] === "gc") {
        return {
          policy: { older_than: "2026-01-01T00:00:00Z" },
          dry_run: true,
          evaluated: 0,
          expired: 0,
          totals: {
            deleted: 0,
            would_delete: 0,
            skipped_referenced: 0,
            skipped_other: 0,
            kept: 0,
            errors: 0,
          },
          entries: [],
        };
      }
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    const view = new ArtifactListView(deps, () => {});
    await view.load();
    view.handleKey({ kind: "key", key: "g", ctrl: false, shift: false, alt: false } as KeyEvent);
    await flush(30);
    const gcCalls = calls.filter((c) => c[0] === "gc");
    expect(gcCalls).toHaveLength(1);
    expect(gcCalls[0]).toContain("--dry-run");
    expect(ui.statuses.join("\n")).toContain("nothing to collect");
  });
});
