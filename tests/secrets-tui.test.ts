/**
 * Tests for the rebuildup.secrets TUI surface (#247,
 * contract docs/contracts/tui-v1.md + ADR-0027 secret non-display).
 *
 * Covers the pure helpers (context pinning, pane-open params, mutation
 * gating, binding parsing, payload formatting) and the view layer with
 * a fake CLI/ui — no real herdr session, no TTY, and NO secret values
 * anywhere in the fixtures.
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
  type BindingView,
  bindingSelectItem,
  buildPaneOpenParams,
  formatCapabilityPayload,
  formatInjectResult,
  formatResolvePayload,
  formatTargetLabel,
  mutationAllowed,
  parseBindings,
  parsePluginContext,
  resolvePinnedTarget,
  SecretsCliError,
  splitCommandLine,
} from "../plugins/secrets/src/tui-support";
import {
  configInitFlow,
  injectFlow,
  resolveFlow,
  runFlow,
  SecretsListView,
  type SecretsTuiDeps,
  type SecretsTuiUi,
} from "../plugins/secrets/src/tui-views";

// --- fixtures --------------------------------------------------------------------

const BINDING: BindingView = {
  name: "github-token",
  env: "GITHUB_TOKEN",
  ref: "prod/GITHUB_TOKEN",
  projectId: "proj-1",
  invalidReason: null,
};

const CAPABILITY = {
  contract: "herdr-plugins.secrets/v1",
  plugin: "rebuildup.secrets",
  version: "0.1.0",
  read_only: false,
  mutation_commands: ["run", "inject", "config"],
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

interface FakeUi extends SecretsTuiUi {
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
  fn: SecretsTuiDeps["cli"];
} {
  const calls: string[][] = [];
  return {
    calls,
    fn: (args) => {
      calls.push([...args]);
      try {
        return Promise.resolve(handler(args));
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
}

function makeDeps(
  cli: SecretsTuiDeps["cli"],
  ui: FakeUi,
  overrides: Partial<SecretsTuiDeps> = {},
): SecretsTuiDeps {
  return {
    cli,
    ui,
    capability: CAPABILITY,
    target: TARGET,
    bindings: [BINDING],
    runExternal: () => Promise.resolve(0),
    ...overrides,
  };
}

function linesText(lines: Line[]): string[] {
  return lines.map((l) => l.map((s) => s.text).join(""));
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function keyEvent(key: string): KeyEvent {
  return { kind: "key", key, ctrl: false, shift: false, alt: false };
}

// --- context pinning -------------------------------------------------------------

describe("parsePluginContext / resolvePinnedTarget", () => {
  test("parses valid JSON, rejects garbage", () => {
    expect(parsePluginContext('{"workspace_id":"w1"}').workspace_id).toBe("w1");
    expect(parsePluginContext("not json")).toEqual({});
    expect(parsePluginContext("")).toEqual({});
    expect(parsePluginContext("[1]")).toEqual({});
  });
  test("HERDR_TUI_* pins win; HERDR_PANE_ID is never a target", () => {
    const target = resolvePinnedTarget({
      HERDR_TUI_WORKSPACE_ID: "w-pin",
      HERDR_TUI_PANE_ID: "w-pin:p1",
      HERDR_PANE_ID: "ui:pane",
      HERDR_PLUGIN_CONTEXT_JSON: '{"workspace_id":"w-ctx"}',
    } as NodeJS.ProcessEnv);
    expect(target.workspaceId).toBe("w-pin");
    expect(target.originPaneId).toBe("w-pin:p1");
  });
});

describe("buildPaneOpenParams / formatTargetLabel", () => {
  test("tab placement + env pins + plugin id", () => {
    const params = buildPaneOpenParams(TARGET);
    expect(params.plugin_id).toBe("rebuildup.secrets");
    expect(params.entrypoint).toBe("main");
    expect(params.placement).toBe("tab");
    const env = params.env as Record<string, string>;
    expect(env.HERDR_TUI_PANE_ID).toBe("w1:p9");
  });
  test("formatTargetLabel honest empty state", () => {
    expect(formatTargetLabel(TARGET)).toContain("ws w1");
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

// --- command splitting + gating ---------------------------------------------------

describe("splitCommandLine", () => {
  test("quotes, escapes, whitespace", () => {
    expect(splitCommandLine("echo \"a b\" 'c d' e\\ f")).toEqual({
      ok: true,
      argv: ["echo", "a b", "c d", "e f"],
    });
    expect(splitCommandLine("  ")).toEqual({ ok: true, argv: [] });
    expect(splitCommandLine('echo "unterminated')).toEqual({
      ok: false,
      error: 'unterminated " quote',
    });
  });
});

describe("mutationAllowed", () => {
  test("fail closed on null capability", () => {
    expect(mutationAllowed(null, "run").allowed).toBe(false);
  });
  test("listed commands allowed; reads ungated by design", () => {
    expect(mutationAllowed(CAPABILITY, "run").allowed).toBe(true);
    expect(mutationAllowed(CAPABILITY, "inject").allowed).toBe(true);
    expect(mutationAllowed(CAPABILITY, "resolve").allowed).toBe(false);
    expect(mutationAllowed({ read_only: true, mutation_commands: ["run"] }, "run").allowed).toBe(
      false,
    );
  });
});

// --- binding view model -------------------------------------------------------------

describe("parseBindings / bindingSelectItem", () => {
  test("whitelists fields; invalid bindings marked disabled", () => {
    const views = parseBindings(
      [
        { name: "b1", env: "E1", ref: "r1", projectId: "p1", value: "SHOULD-NOT-PROPAGATE" },
        { name: "b2", env: "E2", ref: "r2" },
      ],
      [{ name: "b2", error: "bad ref" }],
    );
    expect(views).toHaveLength(2);
    const b1 = views.find((b) => b.name === "b1");
    expect(b1).toBeDefined();
    // ADR-0027: the view model has no value-shaped field at all.
    expect(Object.keys(b1 as object)).not.toContain("value");
    const b2 = views.find((b) => b.name === "b2");
    expect(b2?.invalidReason).toBe("bad ref");
    const item = bindingSelectItem(b2 as BindingView);
    expect(item.disabled).toBe(true);
    expect(item.disabledReason).toBe("bad ref");
  });
  test("invalid declarations without usable bindings still surface", () => {
    const views = parseBindings([], [{ name: "ghost", error: "missing env" }]);
    expect(views).toHaveLength(1);
    expect(views[0]?.invalidReason).toBe("missing env");
  });
});

// --- ADR-0027: secret values can never reach the view model -------------------------

describe("ADR-0027 secret non-display", () => {
  test("formatResolvePayload drops value-shaped keys entirely", () => {
    const lines = formatResolvePayload({
      ok: true,
      bindings: [
        {
          name: "github-token",
          env: "GITHUB_TOKEN",
          ref: "prod/GITHUB_TOKEN",
          status: "resolved",
          detail: "ok",
          // hostile/accidental value-shaped fields — must never render
          value: "ghp_SECRETVALUE123",
          secret: "ghp_SECRETVALUE123",
          resolved_value: "ghp_SECRETVALUE123",
          env_value: "ghp_SECRETVALUE123",
        },
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("github-token");
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).not.toContain("ghp_SECRETVALUE123");
    expect(text).not.toContain("resolved_value");
  });

  test("formatInjectResult renders env NAMES only", () => {
    const lines = formatInjectResult({
      injected: {
        surface: "pane",
        pane_id: "w1:p10",
        env_names: ["GITHUB_TOKEN"],
        // a leaked value-shaped field must not be rendered
        values: { GITHUB_TOKEN: "ghp_LEAKED" },
      },
    });
    const text = lines.join("\n");
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).not.toContain("ghp_LEAKED");
  });

  test("runFlow passes binding NAMES only to runExternal — never values", async () => {
    const ui = fakeUi();
    ui.promptResults = ["echo hello"];
    const externalCalls: string[][] = [];
    const deps = makeDeps(fakeCli(() => ({})).fn, ui, {
      runExternal: (args) => {
        externalCalls.push([...args]);
        return Promise.resolve(0);
      },
    });
    await runFlow(deps, ["github-token"]);
    await flush();
    expect(externalCalls).toHaveLength(1);
    const argv = externalCalls[0] as string[];
    expect(argv).toEqual(["run", "--binding", "github-token", "--", "echo", "hello"]);
    // No resolved value can appear: only names/command cross the boundary.
    expect(argv.join(" ")).not.toContain("ghp_");
    expect(ui.confirms.some((c) => c.title === "Run command with injected secrets?")).toBe(true);
  });

  test("runFlow cancelled at confirm performs no hand-off", async () => {
    const ui = fakeUi();
    ui.promptResults = ["echo hello"];
    ui.confirmResults = [false];
    const externalCalls: string[][] = [];
    const deps = makeDeps(fakeCli(() => ({})).fn, ui, {
      runExternal: (args) => {
        externalCalls.push([...args]);
        return Promise.resolve(0);
      },
    });
    await runFlow(deps, ["github-token"]);
    await flush();
    expect(externalCalls).toHaveLength(0);
  });

  test("runFlow gated off when capability missing", async () => {
    const ui = fakeUi();
    const externalCalls: string[][] = [];
    const deps = makeDeps(fakeCli(() => ({})).fn, ui, {
      capability: null,
      runExternal: (args) => {
        externalCalls.push([...args]);
        return Promise.resolve(0);
      },
    });
    await runFlow(deps, ["github-token"]);
    await flush();
    expect(externalCalls).toHaveLength(0);
    expect(ui.statuses.join("\n")).toContain("mutations disabled");
  });

  test("resolveFlow renders whitelisted metadata via DetailView", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[0] === "resolve") {
        return {
          ok: true,
          bindings: [
            {
              name: "github-token",
              env: "GITHUB_TOKEN",
              ref: "prod/GITHUB_TOKEN",
              status: "resolved",
              detail: "ok",
              value: "ghp_NEVER",
            },
          ],
        };
      }
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    await resolveFlow(deps, ["github-token"]);
    await flush();
    expect(cli.calls).toEqual([["resolve", "--binding", "github-token"]]);
    expect(ui.pushed).toHaveLength(1);
    const pushedText = linesText((ui.pushed[0] as ScreenView).render(100, 30)).join("\n");
    expect(pushedText).toContain("github-token");
    expect(pushedText).not.toContain("ghp_NEVER");
  });
});

// --- inject / config flows ------------------------------------------------------------

describe("injectFlow / configInitFlow", () => {
  test("inject workspace surface: argv + confirm, env names only", async () => {
    const ui = fakeUi();
    ui.promptResults = ["/work/dir"]; // cwd prompt
    let selects = 0;
    ui.select = <T>(_opts: SelectListOptions<T>): Promise<SelectItem<T> | null> => {
      selects += 1;
      const value = selects === 1 ? "workspace" : "unused";
      return Promise.resolve({ value, label: value } as SelectItem<T>);
    };
    const calls: string[][] = [];
    const cli = fakeCli((args) => {
      calls.push([...args]);
      if (args[0] === "inject") {
        return {
          injected: {
            surface: "workspace",
            workspace_id: "w-new",
            env_names: ["GITHUB_TOKEN"],
          },
        };
      }
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    await injectFlow(deps, ["github-token"]);
    await flush(20);
    const inject = calls.find((c) => c[0] === "inject");
    // `--workspace` is only forwarded for the tab surface (a workspace
    // create has no parent workspace to name).
    expect(inject).toEqual([
      "inject",
      "--binding",
      "github-token",
      "--surface",
      "workspace",
      "--cwd",
      "/work/dir",
    ]);
    expect(ui.confirms.some((c) => c.title === "Inject secrets into a new workspace?")).toBe(true);
  });

  test("inject pane surface uses pinned pane after confirm", async () => {
    const ui = fakeUi();
    ui.promptResults = [""]; // cwd prompt → none
    let selects = 0;
    ui.select = <T>(_opts: SelectListOptions<T>): Promise<SelectItem<T> | null> => {
      selects += 1;
      const value = selects === 1 ? "pane" : "right";
      return Promise.resolve({ value, label: value } as SelectItem<T>);
    };
    // confirms: "Split the pinned origin pane?" → true, "Inject...?" → true
    const calls: string[][] = [];
    const cli = fakeCli((args) => {
      calls.push([...args]);
      if (args[0] === "inject") {
        return { injected: { surface: "pane", pane_id: "w1:p10", env_names: [] } };
      }
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    await injectFlow(deps, ["github-token"]);
    await flush(20);
    const inject = calls.find((c) => c[0] === "inject");
    expect(inject).toContain("--direction");
    expect(inject).toContain("right");
    expect(inject).toEqual([
      "inject",
      "--binding",
      "github-token",
      "--surface",
      "pane",
      "--direction",
      "right",
      "--target-pane",
      "w1:p9",
    ]);
  });

  test("configInitFlow writes starter config after confirm", async () => {
    const ui = fakeUi();
    const calls: string[][] = [];
    const cli = fakeCli((args) => {
      calls.push([...args]);
      if (args[0] === "config" && args.includes("--init")) {
        return { file: "/cfg/config.json", note: "edit bindings" };
      }
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    await configInitFlow(deps);
    await flush();
    expect(calls).toEqual([["config", "--init"]]);
    expect(ui.statuses.join("\n")).toContain("/cfg/config.json");
  });
});

// --- list view ------------------------------------------------------------------------

describe("SecretsListView", () => {
  const CONFIG_PAYLOAD = {
    file: "/cfg/config.json",
    config: {
      bindings: [
        { name: "github-token", env: "GITHUB_TOKEN", ref: "prod/GITHUB_TOKEN", projectId: "p1" },
      ],
    },
    invalid_bindings: [],
    warnings: [],
  };

  test("load renders bindings from `config` + `capability` (read-only)", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[0] === "config") return CONFIG_PAYLOAD;
      if (args[0] === "capability") return CAPABILITY;
      return {};
    });
    const deps = makeDeps(cli.fn, ui, { bindings: [] });
    const view = new SecretsListView(deps, () => {});
    await view.load();
    await flush();
    expect(cli.calls).toContainEqual(["config"]);
    expect(cli.calls).toContainEqual(["capability"]);
    expect(deps.bindings).toHaveLength(1);
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("github-token");
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).not.toContain("ghp_");
  });

  test("load error renders honestly", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => {
      throw new SecretsCliError("config unreadable", "config_error");
    });
    const deps = makeDeps(cli.fn, ui);
    const view = new SecretsListView(deps, () => {});
    await view.load();
    await flush();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("failed to load secrets config");
    expect(text).toContain("config_error");
  });

  test("capability failure is soft — list still renders", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[0] === "config") return CONFIG_PAYLOAD;
      if (args[0] === "capability") throw new SecretsCliError("down", "unreachable");
      return {};
    });
    const deps = makeDeps(cli.fn, ui, { bindings: [], capability: null });
    const view = new SecretsListView(deps, () => {});
    await view.load();
    await flush();
    expect(deps.capability).toBeNull();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("github-token");
  });

  test("run key gated when capability null", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[0] === "config") return CONFIG_PAYLOAD;
      return {};
    });
    const deps = makeDeps(cli.fn, ui, { bindings: [], capability: null });
    const view = new SecretsListView(deps, () => {});
    await view.load();
    await flush();
    view.handleKey(keyEvent("n"));
    await flush();
    expect(ui.statuses.join("\n")).toContain("mutations disabled");
  });
});

// --- payload formatters ---------------------------------------------------------------

describe("payload formatters", () => {
  test("formatCapabilityPayload renders contract/provider/mutations", () => {
    const lines = formatCapabilityPayload({
      contract: "herdr-plugins.secrets/v1",
      plugin: "rebuildup.secrets",
      version: "0.1.0",
      provider: {
        name: "infisical",
        domain: "app.infisical.com",
        cli: { bin: "infisical", available: true, version: "0.43" },
        reachability: { status: "ok" },
      },
      mutation_commands: ["run", "inject", "config"],
      warnings: ["w1"],
    });
    const text = lines.join("\n");
    expect(text).toContain("herdr-plugins.secrets/v1");
    expect(text).toContain("infisical");
    expect(text).toContain("run, inject, config");
  });
});
