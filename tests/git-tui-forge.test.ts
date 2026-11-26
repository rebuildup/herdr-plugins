/**
 * Tests for the rebuildup.git forge TUI surface (#239,
 * contract docs/contracts/tui-v1.md, ADR-0031/0032/0033).
 *
 * Covers the pure helpers (context pinning, pane-open params, mutation
 * gating, payload formatting) and the view layer with a fake CLI/ui —
 * no real herdr session, no gh, no TTY required.
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
  buildPaneOpenParams,
  forgeCliChildEnv,
  formatIssueView,
  formatPrChecksPayload,
  formatPrCommentsPayload,
  formatPrJobLogPayload,
  formatPrReviewsPayload,
  formatPrRunJobsPayload,
  formatPrRunsPayload,
  formatPrView,
  formatTargetLabel,
  GitCliError,
  issueSelectItem,
  mutationAllowed,
  parsePluginContext,
  prSelectItem,
  resolvePinnedTarget,
} from "../plugins/git/src/tui-forge-support";
import {
  ForgeHomeView,
  type ForgeTuiDeps,
  type ForgeTuiUi,
  IssueDetailView,
  IssueListView,
  PrBranchStatusView,
  PrDetailView,
  PrListView,
} from "../plugins/git/src/tui-forge-views";

// --- fixtures --------------------------------------------------------------------

const NOW = "2026-01-01T00:00:00.000Z";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_SHA_2 = "fedcba9876543210fedcba9876543210fedcba98";

const PR = {
  number: 42,
  title: "Add forge TUI",
  state: "OPEN",
  isDraft: false,
  author: { login: "octocat" },
  headRefName: "239",
  baseRefName: "release-0-11-0",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "REVIEW_REQUIRED",
  url: "https://github.com/example/repo/pull/42",
  body: "body text",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  createdAt: NOW,
  updatedAt: NOW,
};

const PR_REVIEWS = {
  number: 42,
  head: { ref: "239", sha: HEAD_SHA },
  base: { ref: "release-0-11-0", sha: "aaa" },
  review_requests: { users: ["reviewer1"], teams: [] },
  reviews: [{ author: "rev", state: "APPROVED", submitted_at: NOW, body: "lgtm" }],
};

const ISSUE = {
  number: 7,
  title: "Forge surface missing",
  state: "OPEN",
  stateReason: null,
  author: "octocat",
  labels: ["enhancement"],
  assignees: ["octocat"],
  createdAt: NOW,
  updatedAt: NOW,
  url: "https://github.com/example/repo/issues/7",
};

const ISSUE_VIEW = {
  number: 7,
  title: "Forge surface missing",
  state: "OPEN",
  state_reason: null,
  closed: false,
  author: "octocat",
  labels: ["enhancement"],
  assignees: ["octocat"],
  milestone: null,
  body: "please add it",
  comments: [{ id: 1, author: "bob", body: "agreed", created_at: NOW }],
  created_at: NOW,
  updated_at: NOW,
  url: "https://github.com/example/repo/issues/7",
};

const CAPABILITY = {
  read_only: false,
  mutation_commands: ["pr", "issue"],
};

// --- fake ui / cli ---------------------------------------------------------------

interface FakeUi extends ForgeTuiUi {
  statuses: string[];
  confirms: ConfirmOptions[];
  prompts: string[];
  pushed: ScreenView[];
  confirmResults: boolean[];
  promptResults: Array<string | null>;
  selectResults: Array<SelectItem<unknown> | null>;
  closed: number;
}

function fakeUi(): FakeUi {
  const ui: FakeUi = {
    statuses: [],
    confirms: [],
    prompts: [],
    pushed: [],
    confirmResults: [],
    promptResults: [],
    selectResults: [],
    closed: 0,
    confirm(opts: ConfirmOptions) {
      ui.confirms.push(opts);
      return Promise.resolve(ui.confirmResults.shift() ?? true);
    },
    prompt(text: string, _opts?: TextInputOptions) {
      ui.prompts.push(text);
      return Promise.resolve(ui.promptResults.shift() ?? null);
    },
    select<T>(_opts: SelectListOptions<T>) {
      return Promise.resolve((ui.selectResults.shift() ?? null) as SelectItem<T> | null);
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
      ui.closed += 1;
      return Promise.resolve();
    },
  };
  return ui;
}

type CliHandler = (
  args: readonly string[],
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<Record<string, unknown>> | Record<string, unknown>;

function fakeCli(handler: CliHandler): {
  calls: string[][];
  fn: ForgeTuiDeps["cli"];
} {
  const calls: string[][] = [];
  return {
    calls,
    fn: (args, options) => {
      calls.push([...args]);
      return Promise.resolve(handler(args, options));
    },
  };
}

function makeDeps(
  cli: ForgeTuiDeps["cli"],
  ui: FakeUi,
  capability: ForgeTuiDeps["capability"] = CAPABILITY,
): ForgeTuiDeps {
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
    forge: { paneId: "w1:p9", repoOverride: null },
  };
}

function keyEvent(key: string): KeyEvent {
  return { kind: "key", key, ctrl: false, shift: false, alt: false };
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
  test("parses valid JSON; invalid input yields {}", () => {
    expect(parsePluginContext('{"workspace_id":"w1"}').workspace_id).toBe("w1");
    expect(parsePluginContext("not json")).toEqual({});
    expect(parsePluginContext("")).toEqual({});
    expect(parsePluginContext(undefined)).toEqual({});
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

describe("forgeCliChildEnv", () => {
  test("drops UI-pane ambient identity, keeps targeting vars", () => {
    const env = forgeCliChildEnv({
      HERDR_PANE_ID: "w1:p9",
      HERDR_PLUGIN_CONTEXT_JSON: '{"focused_pane_id":"w1:p1"}',
      HERDR_SOCKET_PATH: "/tmp/s.sock",
      HERDR_SESSION: "verify234",
      HERDR_PLUGIN_CONFIG_DIR: "/cfg",
      HERDR_WORKSPACE_ID: "w1",
      PATH: "/bin",
      EMPTY: undefined,
    } as NodeJS.ProcessEnv);
    expect(env.HERDR_PANE_ID).toBeUndefined();
    expect(env.HERDR_PLUGIN_CONTEXT_JSON).toBeUndefined();
    expect(env.EMPTY).toBeUndefined();
    expect(env.HERDR_SOCKET_PATH).toBe("/tmp/s.sock");
    expect(env.HERDR_SESSION).toBe("verify234");
    expect(env.HERDR_PLUGIN_CONFIG_DIR).toBe("/cfg");
    expect(env.HERDR_WORKSPACE_ID).toBe("w1");
    expect(env.PATH).toBe("/bin");
  });
});

describe("buildPaneOpenParams", () => {
  test("tab placement, forge entrypoint, pinned env", () => {
    const params = buildPaneOpenParams({
      workspaceId: "w1",
      tabId: "w1:t1",
      originPaneId: "w1:p9",
      originCwd: "/repos/demo",
      socketPath: "/s",
      session: "default",
    });
    expect(params.plugin_id).toBe("rebuildup.git");
    expect(params.entrypoint).toBe("forge");
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

describe("formatTargetLabel", () => {
  test("renders pinned parts and honest empty state", () => {
    expect(
      formatTargetLabel({
        workspaceId: "w1",
        tabId: null,
        originPaneId: "w1:p9",
        originCwd: null,
        socketPath: null,
        session: null,
      }),
    ).toBe("ws w1 · pane w1:p9");
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

// --- mutation gating ---------------------------------------------------------------

describe("mutationAllowed", () => {
  test("fails closed when capability is unavailable", () => {
    const gate = mutationAllowed(null, "pr");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("unavailable");
  });
  test("read_only capability disables everything", () => {
    const gate = mutationAllowed({ read_only: true, mutation_commands: ["pr"] }, "pr");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("read_only");
  });
  test("listed pr/issue allowed, unlisted denied with reason", () => {
    expect(mutationAllowed(CAPABILITY, "pr").allowed).toBe(true);
    expect(mutationAllowed(CAPABILITY, "issue").allowed).toBe(true);
    const denied = mutationAllowed(CAPABILITY, "commit");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("commit");
  });
});

// --- payload formatting --------------------------------------------------------------

describe("payload formatting", () => {
  test("prSelectItem carries state/draft/head detail", () => {
    const item = prSelectItem({ ...PR, isDraft: true });
    expect(item.label).toContain("#42 Add forge TUI");
    expect(item.label).toContain("draft");
    expect(item.detail).toContain("head: 239 → base: release-0-11-0");
    expect(item.detail).toContain(`updated: ${NOW}`);
  });
  test("issueSelectItem carries labels and detail", () => {
    const item = issueSelectItem(ISSUE);
    expect(item.label).toContain("#7 Forge surface missing");
    expect(item.label).toContain("enhancement");
    expect(item.detail).toContain("state: open");
  });
  test("formatPrView renders header, checks, body", () => {
    const lines = formatPrView({
      ...PR,
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }],
    });
    const text = lines.join("\n");
    expect(text).toContain("#42 Add forge TUI");
    expect(text).toContain("mergeState: CLEAN");
    expect(text).toContain("checks: 1 reported, 1 failing");
    expect(text).toContain("body text");
  });
  test("formatIssueView renders snake_case fields honestly", () => {
    const lines = formatIssueView(ISSUE_VIEW);
    const text = lines.join("\n");
    expect(text).toContain("#7 Forge surface missing");
    expect(text).toContain("state: open");
    expect(text).toContain(`updated: ${NOW}`);
    expect(text).toContain("please add it");
    expect(text).toContain("agreed");
  });
  test("formatPrReviewsPayload / Comments / Checks / Runs / Jobs / JobLog", () => {
    expect(formatPrReviewsPayload(PR_REVIEWS).join("\n")).toContain("users: reviewer1");
    expect(formatPrReviewsPayload({}).join("\n")).toContain("(no submitted reviews)");

    const comments = formatPrCommentsPayload({
      number: 42,
      head: { ref: "239", sha: HEAD_SHA },
      issue_comments: [{ id: 1, author: "a", body: "hi", created_at: NOW }],
      line_comments: [
        {
          id: 9,
          author: "b",
          path: "src/x.ts",
          line: 3,
          side: "RIGHT",
          body: "nit",
          created_at: NOW,
        },
      ],
    });
    const cText = comments.join("\n");
    expect(cText).toContain("conversation:");
    expect(cText).toContain("src/x.ts:3");

    const checks = formatPrChecksPayload({
      number: 42,
      checks: [{ name: "ci", bucket: "fail", state: "COMPLETED" }],
    });
    expect(checks.join("\n")).toContain("ci — fail/COMPLETED");
    expect(formatPrChecksPayload({ checks: [] }).join("\n")).toContain("(no checks reported)");

    const runs = formatPrRunsPayload({
      number: 42,
      runs: [
        {
          id: 5,
          name: "CI",
          status: "completed",
          conclusion: "success",
          created_at: NOW,
          display_title: "t",
          url: "u",
        },
      ],
    });
    expect(runs.join("\n")).toContain("run #5 CI");
    expect(formatPrRunsPayload({ runs: [] }).join("\n")).toContain("(no workflow runs");

    const jobs = formatPrRunJobsPayload({
      run: { id: 5, name: "CI", status: "completed", conclusion: "success" },
      jobs: [{ id: 9, name: "test", status: "completed", conclusion: "success" }],
    });
    expect(jobs.join("\n")).toContain("job #9 test");

    const log = formatPrJobLogPayload({
      job_id: "9",
      lines_returned: 2,
      total_lines: 2,
      log: "line1\nline2",
      truncated: false,
    });
    expect(log.join("\n")).toContain("line1");
  });
});

// --- ForgeHomeView -----------------------------------------------------------------

describe("ForgeHomeView", () => {
  test("enter opens the selected forge surface", () => {
    const ui = fakeUi();
    const opened: string[] = [];
    const { fn } = fakeCli(() => ({}));
    const view = new ForgeHomeView(makeDeps(fn, ui), (t) => opened.push(t));
    view.handleKey?.(keyEvent("j")); // down to "issues"
    view.handleKey?.(keyEvent("enter"));
    expect(opened).toEqual(["issues"]);
  });
  test("esc closes the TUI", () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => ({}));
    const view = new ForgeHomeView(makeDeps(fn, ui), () => {});
    view.handleKey?.(keyEvent("q"));
    expect(ui.closed).toBe(1);
  });
});

// --- PrBranchStatusView --------------------------------------------------------------

describe("PrBranchStatusView", () => {
  test("renders PR for branch; honest no-PR state", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli((args) => {
      if (args.join(" ") === "pr status w1:p9") {
        return { pr: PR, branch: "239", repo: "example/repo" };
      }
      return {};
    });
    const view = new PrBranchStatusView(makeDeps(fn, ui));
    await flush();
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("#42 Add forge TUI");
    expect(calls[0]).toEqual(["pr", "status", "w1:p9"]);

    const ui2 = fakeUi();
    const { fn: fn2 } = fakeCli(() => ({ pr: null, branch: "main", repo: "example/repo" }));
    const none = new PrBranchStatusView(makeDeps(fn2, ui2));
    await flush();
    const noneText = linesText(none.render(100, 30)).join("\n");
    expect(noneText).toContain("no open PR");
  });

  test("gh_missing renders honest unsupported state", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => {
      throw new GitCliError("gh not found", "gh_missing");
    });
    const view = new PrBranchStatusView(makeDeps(fn, ui));
    await flush();
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("gh_missing");
    expect(text).toContain("gh");
  });
});

// --- PrListView ---------------------------------------------------------------------

function prListCli(overrides: Record<string, unknown> = {}): CliHandler {
  return (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return { repo: "example/repo", prs: [PR], ...overrides };
    }
    if (args[0] === "pr" && args[1] === "create") {
      return { ok: true, number: 43, url: "https://github.com/example/repo/pull/43" };
    }
    return {};
  };
}

describe("PrListView", () => {
  test("loads and renders open PRs; enter opens detail", async () => {
    const ui = fakeUi();
    const opened: number[] = [];
    const { calls, fn } = fakeCli(prListCli());
    const view = new PrListView(makeDeps(fn, ui), (n) => opened.push(n));
    await view.load();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("#42 Add forge TUI");
    expect(calls[0]).toEqual(["pr", "list", "w1:p9", "--state", "open", "--limit", "50"]);

    // enter selects first item → onOpenPr
    view.handleKey?.(keyEvent("enter"));
    expect(opened).toEqual([42]);
  });

  test("gh_missing error is honest, not a fake list", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(() => {
      throw new GitCliError("gh not found", "gh_missing");
    });
    const view = new PrListView(makeDeps(fn, ui), () => {});
    await view.load();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("failed to load pull requests");
    expect(text).toContain("gh_missing");
  });

  test("create flow: prompts → draft confirm → create confirm → CLI argv", async () => {
    const ui = fakeUi();
    ui.promptResults.push("New PR title", "body", "", "");
    ui.confirmResults.push(false, true); // draft? no → create? yes
    const opened: number[] = [];
    const { calls, fn } = fakeCli(prListCli());
    const view = new PrListView(makeDeps(fn, ui), (n) => opened.push(n));
    await view.load();
    view.handleKey?.(keyEvent("n"));
    await flush(20);
    const createCall = calls.find((c) => c[1] === "create");
    expect(createCall).toBeDefined();
    expect(createCall).toEqual([
      "pr",
      "create",
      "w1:p9",
      "--title",
      "New PR title",
      "--body",
      "body",
    ]);
    expect(ui.confirms.length).toBe(2);
    expect(ui.confirms[1]?.target?.join(" ")).toContain("New PR title");
    expect(opened).toEqual([43]);
  });

  test("create disabled when capability unavailable", async () => {
    const ui = fakeUi();
    ui.promptResults.push("title", "", "", "");
    const { calls, fn } = fakeCli(prListCli());
    const view = new PrListView(makeDeps(fn, ui, null), () => {});
    await view.load();
    view.handleKey?.(keyEvent("n"));
    await flush(20);
    expect(calls.some((c) => c[1] === "create")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });
});

// --- PrDetailView -------------------------------------------------------------------

function prDetailCli(
  overrides: {
    reviews?: Record<string, unknown> | null;
    view?: Record<string, unknown> | null;
    onReviews?: () => void;
  } = {},
): CliHandler {
  return (args) => {
    const key = args.join(" ");
    if (key === "pr view w1:p9 42") {
      if (overrides.view === null) {
        throw new GitCliError("pull request not found", "gh_error");
      }
      return { pr: overrides.view ?? PR };
    }
    if (key === "pr reviews w1:p9 42") {
      overrides.onReviews?.();
      if (overrides.reviews === null) {
        throw new GitCliError("reviews failed", "gh_error");
      }
      return overrides.reviews ?? PR_REVIEWS;
    }
    if (args[0] === "pr" && args[1] === "comment") {
      return { ok: true };
    }
    return {};
  };
}

describe("PrDetailView", () => {
  test("loads pr view + reviews and renders head sha", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli(prDetailCli());
    const view = new PrDetailView(makeDeps(fn, ui), 42);
    await flush(20);
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("#42 Add forge TUI");
    expect(text).toContain(HEAD_SHA);
    expect(calls.some((c) => c.join(" ") === "pr view w1:p9 42")).toBe(true);
    expect(calls.some((c) => c.join(" ") === "pr reviews w1:p9 42")).toBe(true);
  });

  test("comment flow: prompt → confirm → revalidate → --expect-head fresh sha", async () => {
    const ui = fakeUi();
    ui.promptResults.push("looks good");
    const { calls, fn } = fakeCli(prDetailCli());
    const view = new PrDetailView(makeDeps(fn, ui), 42);
    await flush(20);
    view.handleKey?.(keyEvent("m"));
    await flush(30);
    const comment = calls.find((c) => c[1] === "comment");
    expect(comment).toBeDefined();
    // fresh head from revalidation, not the opened one
    expect(comment).toEqual([
      "pr",
      "comment",
      "w1:p9",
      "42",
      "--body",
      "looks good",
      "--expect-head",
      HEAD_SHA,
    ]);
    expect(ui.confirms[0]?.title).toBe("Post PR comment?");
    expect(ui.confirms[0]?.target?.join(" ")).toContain("looks good");
  });

  test("confirm cancel aborts before any mutation", async () => {
    const ui = fakeUi();
    ui.promptResults.push("body");
    ui.confirmResults.push(false);
    const { calls, fn } = fakeCli(prDetailCli());
    const view = new PrDetailView(makeDeps(fn, ui), 42);
    await flush(20);
    view.handleKey?.(keyEvent("m"));
    await flush(20);
    expect(calls.some((c) => c[1] === "comment")).toBe(false);
  });

  test("drifted head asks again; cancel aborts mutation", async () => {
    const ui = fakeUi();
    ui.promptResults.push("body");
    ui.confirmResults.push(true, false); // post confirm yes, drift confirm no
    let reviewsCalls = 0;
    const { calls, fn } = fakeCli((args) => {
      const key = args.join(" ");
      if (key === "pr view w1:p9 42") return { pr: PR };
      if (key === "pr reviews w1:p9 42") {
        reviewsCalls += 1;
        // second read (revalidate) reports a moved head
        const sha = reviewsCalls === 1 ? HEAD_SHA : HEAD_SHA_2;
        return { ...PR_REVIEWS, head: { ref: "239", sha } };
      }
      return {};
    });
    const view = new PrDetailView(makeDeps(fn, ui), 42);
    await flush(20);
    view.handleKey?.(keyEvent("m"));
    await flush(30);
    expect(calls.some((c) => c[1] === "comment")).toBe(false);
    expect(ui.confirms.length).toBe(2);
    expect(ui.confirms[1]?.title).toContain("changed since this view opened");
  });

  test("missing head sha in revalidation aborts honestly", async () => {
    const ui = fakeUi();
    ui.promptResults.push("body");
    const { calls, fn } = fakeCli((args) => {
      const key = args.join(" ");
      if (key === "pr view w1:p9 42") return { pr: PR };
      if (key === "pr reviews w1:p9 42") {
        return { ...PR_REVIEWS, head: { ref: "239", sha: null } };
      }
      return {};
    });
    const view = new PrDetailView(makeDeps(fn, ui), 42);
    await flush(20);
    view.handleKey?.(keyEvent("m"));
    await flush(30);
    expect(calls.some((c) => c[1] === "comment")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("head sha unavailable");
  });

  test("mutations disabled when capability unavailable", async () => {
    const ui = fakeUi();
    ui.promptResults.push("body");
    const { calls, fn } = fakeCli(prDetailCli());
    const view = new PrDetailView(makeDeps(fn, ui, null), 42);
    await flush(20);
    view.handleKey?.(keyEvent("m"));
    await flush(20);
    expect(calls.some((c) => c[1] === "comment")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });

  test("merge flow sends method + --expect-head", async () => {
    const ui = fakeUi();
    ui.selectResults.push({ value: "squash", label: "Squash merge" });
    const { calls, fn } = fakeCli(prDetailCli());
    const view = new PrDetailView(makeDeps(fn, ui), 42);
    await flush(20);
    view.handleKey?.(keyEvent("g"));
    await flush(30);
    const merge = calls.find((c) => c[1] === "merge");
    expect(merge).toEqual(["pr", "merge", "w1:p9", "42", "--squash", "--expect-head", HEAD_SHA]);
    expect(ui.confirms[0]?.danger).toBe(true);
    expect(ui.confirms[0]?.consequence).toContain("MERGES");
  });

  test("missing PR renders honest error, not fake data", async () => {
    const ui = fakeUi();
    const { fn } = fakeCli(prDetailCli({ view: null }));
    const view = new PrDetailView(makeDeps(fn, ui), 42);
    await flush(20);
    const text = linesText(view.render(100, 30)).join("\n");
    expect(text).toContain("pull request not found");
  });
});

// --- IssueListView ------------------------------------------------------------------

function issueListCli(): CliHandler {
  return (args) => {
    if (args[0] === "issue" && args[1] === "list") {
      return { repo: "example/repo", issues: [ISSUE] };
    }
    if (args[0] === "issue" && args[1] === "create") {
      return { ok: true, number: 8, url: "https://github.com/example/repo/issues/8" };
    }
    return {};
  };
}

describe("IssueListView", () => {
  test("loads and renders issues; enter opens detail", async () => {
    const ui = fakeUi();
    const opened: number[] = [];
    const { calls, fn } = fakeCli(issueListCli());
    const view = new IssueListView(makeDeps(fn, ui), (n) => opened.push(n));
    await view.load();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("#7 Forge surface missing");
    expect(calls[0]).toEqual(["issue", "list", "w1:p9", "--state", "open", "--limit", "50"]);
    view.handleKey?.(keyEvent("enter"));
    expect(opened).toEqual([7]);
  });

  test("create flow posts issue create argv and opens the new issue", async () => {
    const ui = fakeUi();
    ui.promptResults.push("New issue", "body", "bug", "");
    const opened: number[] = [];
    const { calls, fn } = fakeCli(issueListCli());
    const view = new IssueListView(makeDeps(fn, ui), (n) => opened.push(n));
    await view.load();
    view.handleKey?.(keyEvent("n"));
    await flush(20);
    const create = calls.find((c) => c[1] === "create");
    expect(create).toEqual([
      "issue",
      "create",
      "w1:p9",
      "--title",
      "New issue",
      "--body",
      "body",
      "--label",
      "bug",
    ]);
    expect(opened).toEqual([8]);
  });

  test("create disabled when capability unavailable", async () => {
    const ui = fakeUi();
    ui.promptResults.push("title", "", "", "");
    const { calls, fn } = fakeCli(issueListCli());
    const view = new IssueListView(makeDeps(fn, ui, null), () => {});
    await view.load();
    view.handleKey?.(keyEvent("n"));
    await flush(20);
    expect(calls.some((c) => c[1] === "create")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });
});

// --- IssueDetailView ----------------------------------------------------------------

describe("IssueDetailView", () => {
  test("loads issue view and renders comments", async () => {
    const ui = fakeUi();
    const { calls, fn } = fakeCli((args) => {
      if (args.join(" ") === "issue view w1:p9 7") return { issue: ISSUE_VIEW };
      return {};
    });
    const view = new IssueDetailView(makeDeps(fn, ui), 7);
    await flush(20);
    const text = linesText(view.render(100, 40)).join("\n");
    expect(text).toContain("#7 Forge surface missing");
    expect(text).toContain("agreed");
    expect(calls[0]).toEqual(["issue", "view", "w1:p9", "7"]);
  });

  test("comment flow: prompt → confirm → revalidate → issue comment (no expect-head)", async () => {
    const ui = fakeUi();
    ui.promptResults.push("me too");
    let viewCalls = 0;
    const { calls, fn } = fakeCli((args) => {
      const key = args.join(" ");
      if (key === "issue view w1:p9 7") {
        viewCalls += 1;
        // second view (freshness re-read) bumps updated_at → drift confirm
        const issue =
          viewCalls === 1 ? ISSUE_VIEW : { ...ISSUE_VIEW, updated_at: "2026-01-02T00:00:00.000Z" };
        return { issue };
      }
      if (args[1] === "comment") return { ok: true };
      return {};
    });
    const view = new IssueDetailView(makeDeps(fn, ui), 7);
    await flush(20);
    view.handleKey?.(keyEvent("c"));
    await flush(30);
    const comment = calls.find((c) => c[1] === "comment");
    expect(comment).toEqual(["issue", "comment", "w1:p9", "7", "--body", "me too"]);
    // drift confirm was shown before the write
    expect(ui.confirms.length).toBe(2);
  });

  test("close flow: reason select → confirm → issue close --reason", async () => {
    const ui = fakeUi();
    ui.selectResults.push({ value: "completed", label: "Completed" });
    const { calls, fn } = fakeCli((args) => {
      if (args.join(" ") === "issue view w1:p9 7") return { issue: ISSUE_VIEW };
      return {};
    });
    const view = new IssueDetailView(makeDeps(fn, ui), 7);
    await flush(20);
    view.handleKey?.(keyEvent("x"));
    await flush(30);
    const close = calls.find((c) => c[1] === "close");
    expect(close).toEqual(["issue", "close", "w1:p9", "7", "--reason", "completed"]);
  });

  test("mutations disabled when capability unavailable", async () => {
    const ui = fakeUi();
    ui.promptResults.push("body");
    const { calls, fn } = fakeCli((args) => {
      if (args.join(" ") === "issue view w1:p9 7") return { issue: ISSUE_VIEW };
      return {};
    });
    const view = new IssueDetailView(makeDeps(fn, ui, null), 7);
    await flush(20);
    view.handleKey?.(keyEvent("c"));
    await flush(20);
    expect(calls.some((c) => c[1] === "comment")).toBe(false);
    expect(ui.statuses.join(" ")).toContain("disabled");
  });
});
