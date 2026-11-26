/**
 * Tests for the rebuildup.machines TUI surface (#247,
 * contract docs/contracts/tui-v1.md; read-only per ADR-0028).
 *
 * Covers the pure helpers (context pinning, pane-open params, payload
 * formatting, tolerant parsing) and the view layer with a fake
 * CLI/ui — no real herdr session, no TTY.
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
  asMachineItem,
  asMachineItems,
  buildPaneOpenParams,
  formatCapabilityPayload,
  formatProbePayload,
  formatTargetLabel,
  MachinesCliError,
  machineHeaderLines,
  machineSelectItem,
  parsePluginContext,
  probeSummary,
  resolvePinnedTarget,
} from "../plugins/machines/src/tui-support";
import {
  MachineDetailView,
  MachinesListView,
  type MachinesTuiDeps,
  type MachinesTuiUi,
} from "../plugins/machines/src/tui-views";

// --- fixtures --------------------------------------------------------------------

const MACHINE_PAYLOAD = {
  machine: {
    id: "devbox",
    label: "Dev Box",
    target: "devbox.tailnet.ts.net",
    session: "default",
    enabled: true,
    selected: false,
  },
  last_probe: {
    state: "ok",
    probed_at: "2026-01-01T00:00:00.000Z",
    reachable: true,
    server_version: "0.11.0",
    protocol: 3,
    plugin_surface: "supported",
    plugin_surface_error: null,
    error_kind: null,
    error: null,
    plugins: [{ id: "rebuildup.inbox", name: "inbox", version: "0.2.0" }],
  },
};

const CAPABILITY = {
  contract: "herdr-plugins.machines/v1",
  contract_status: "draft",
  plugin: "rebuildup.machines",
  version: "0.1.0",
  read_only: true,
  mutation_commands: [],
  probe_states: ["ok", "disabled", "unreachable", "unsupported_remote", "error"],
  plugin_surfaces: ["supported", "unsupported", "unknown"],
  transport: "ssh",
  notes: ["read-only inventory"],
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

interface FakeUi extends MachinesTuiUi {
  statuses: string[];
  pushed: ScreenView[];
}

function fakeUi(): FakeUi {
  const ui: FakeUi = {
    statuses: [],
    pushed: [],
    confirm(_opts: ConfirmOptions) {
      return Promise.resolve(true);
    },
    prompt(_text: string, _opts?: TextInputOptions) {
      return Promise.resolve(null);
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
  fn: MachinesTuiDeps["cli"];
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
  cli: MachinesTuiDeps["cli"],
  ui: FakeUi,
  capability: MachinesTuiDeps["capability"] = CAPABILITY,
): MachinesTuiDeps {
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
    expect(params.plugin_id).toBe("rebuildup.machines");
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

// --- view model --------------------------------------------------------------------

describe("asMachineItem / asMachineItems", () => {
  test("parses list item; malformed entries dropped", () => {
    const item = asMachineItem(MACHINE_PAYLOAD);
    expect(item?.machine.id).toBe("devbox");
    expect(item?.last_probe?.state).toBe("ok");
    expect(item?.last_probe?.plugins?.[0]?.id).toBe("rebuildup.inbox");
    expect(asMachineItem({ machine: { id: "" } })).toBeNull();
    expect(asMachineItem(null)).toBeNull();
    expect(asMachineItems([MACHINE_PAYLOAD, { bad: true }])).toHaveLength(1);
  });
  test("missing last_probe → null (never probed)", () => {
    const item = asMachineItem({ machine: { id: "m1" } });
    expect(item?.last_probe).toBeNull();
    expect(probeSummary(null)).toBe("never probed");
  });
});

describe("machine view formatting", () => {
  const ITEM = asMachineItem(MACHINE_PAYLOAD) as NonNullable<ReturnType<typeof asMachineItem>>;

  test("machineSelectItem flags disabled/non-ok probe honestly", () => {
    const item = machineSelectItem(ITEM);
    expect(item.label).toContain("Dev Box");
    expect(item.detail).toContain("devbox.tailnet.ts.net");
    const bad = machineSelectItem({
      machine: { ...ITEM.machine, enabled: false },
      last_probe: ITEM.last_probe === null ? null : { ...ITEM.last_probe, state: "unreachable" },
    });
    expect(bad.label).toContain("disabled");
    expect(bad.label).toContain("probe:unreachable");
  });

  test("machineHeaderLines renders probe taxonomy verbatim", () => {
    const text = machineHeaderLines(ITEM).join("\n");
    expect(text).toContain("machine Dev Box (devbox)");
    expect(text).toContain("state: ok");
    expect(text).toContain("plugin surface: supported");
    expect(text).toContain("rebuildup.inbox");
  });

  test("formatProbePayload renders per-machine results", () => {
    const lines = formatProbePayload({
      results: [
        {
          machine_id: "devbox",
          state: "ok",
          probed_at: "2026-01-01T00:00:00Z",
          reachable: true,
          server_version: "0.11.0",
          protocol: 3,
          plugin_surface: "supported",
          plugins: [{ id: "rebuildup.inbox", name: "inbox", version: "0.2.0" }],
        },
        {
          machine_id: "old",
          state: "disabled",
          probed_at: "2026-01-01T00:00:00Z",
          reachable: null,
          server_version: null,
          protocol: null,
          plugin_surface: "unknown",
          error_kind: "disabled",
        },
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("probe devbox — ok");
    expect(text).toContain("probe old — disabled");
    expect(text).toContain("error: disabled");
  });

  test("formatCapabilityPayload reports draft contract honestly", () => {
    const text = formatCapabilityPayload(CAPABILITY).join("\n");
    expect(text).toContain("draft");
    expect(text).toContain("read_only: yes");
    expect(text).toContain("ok, disabled, unreachable");
    expect(text).toContain("transport: ssh");
  });
});

// --- list view ------------------------------------------------------------------------

describe("MachinesListView", () => {
  test("load renders `list` output read-only", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => ({
      machines: [MACHINE_PAYLOAD],
      total: 1,
    }));
    const deps = makeDeps(cli.fn, ui);
    const view = new MachinesListView(deps, () => {});
    await view.load();
    await flush();
    expect(cli.calls).toEqual([["list"]]);
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("Dev Box");
    expect(text).toContain("devbox");
    expect(ui.statuses.join("\n")).toContain("1 machine(s)");
  });

  test("load error renders honestly", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => {
      throw new MachinesCliError("herdr machine list failed", "cli_error");
    });
    const deps = makeDeps(cli.fn, ui);
    const view = new MachinesListView(deps, () => {});
    await view.load();
    await flush();
    const text = linesText(view.render(100, 20)).join("\n");
    expect(text).toContain("failed to load machines");
    expect(text).toContain("cli_error");
  });

  test("empty inventory renders empty state", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => ({ machines: [], total: 0 }));
    const deps = makeDeps(cli.fn, ui);
    const view = new MachinesListView(deps, () => {});
    await view.load();
    await flush();
    expect(ui.statuses.join("\n")).toContain("no saved machines");
  });

  test("'a' probes all machines via task runner and pushes detail", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[0] === "list") return { machines: [MACHINE_PAYLOAD], total: 1 };
      if (args[0] === "probe") {
        return {
          results: [
            {
              machine_id: "devbox",
              state: "ok",
              probed_at: "2026-01-02T00:00:00Z",
              reachable: true,
              server_version: "0.11.0",
              protocol: 3,
              plugin_surface: "supported",
              plugins: [],
            },
          ],
        };
      }
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    const view = new MachinesListView(deps, () => {});
    await view.load();
    await flush();
    view.handleKey(keyEvent("a"));
    await flush(20);
    expect(cli.calls).toContainEqual(["probe", "--all"]);
    expect(ui.pushed).toHaveLength(1);
    const pushedText = linesText((ui.pushed[0] as ScreenView).render(100, 30)).join("\n");
    expect(pushedText).toContain("probe devbox — ok");
  });

  test("'p' with no selection reports honestly", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => ({ machines: [], total: 0 }));
    const deps = makeDeps(cli.fn, ui);
    const view = new MachinesListView(deps, () => {});
    await view.load();
    await flush();
    view.handleKey(keyEvent("p"));
    await flush();
    expect(ui.statuses.join("\n")).toContain("select a machine first");
    expect(cli.calls.filter((c) => c[0] === "probe")).toHaveLength(0);
  });

  test("'i' renders capability info from launch doc (no extra CLI call)", async () => {
    const ui = fakeUi();
    const cli = fakeCli(() => ({ machines: [MACHINE_PAYLOAD], total: 1 }));
    const deps = makeDeps(cli.fn, ui);
    const view = new MachinesListView(deps, () => {});
    await view.load();
    await flush();
    view.handleKey(keyEvent("i"));
    await flush();
    expect(cli.calls.filter((c) => c[0] === "capability")).toHaveLength(0);
    expect(ui.pushed).toHaveLength(1);
    const pushedText = linesText((ui.pushed[0] as ScreenView).render(100, 30)).join("\n");
    expect(pushedText).toContain("draft");
    expect(pushedText).toContain("read_only: yes");
  });
});

// --- detail view ------------------------------------------------------------------------

describe("MachineDetailView", () => {
  const ITEM = asMachineItem(MACHINE_PAYLOAD) as NonNullable<ReturnType<typeof asMachineItem>>;

  test("renders header lines", () => {
    const ui = fakeUi();
    const cli = fakeCli(() => ({}));
    const deps = makeDeps(cli.fn, ui);
    const view = new MachineDetailView(deps, ITEM);
    const text = linesText(view.render(110, 30)).join("\n");
    expect(text).toContain("machine Dev Box (devbox)");
    expect(text).toContain("state: ok");
    expect(text).toContain("plugin surface: supported");
  });

  test("'p' probes this machine and pushes result", async () => {
    const ui = fakeUi();
    const cli = fakeCli((args) => {
      if (args[0] === "probe") {
        return {
          results: [
            {
              machine_id: "devbox",
              state: "unreachable",
              probed_at: "2026-01-02T00:00:00Z",
              reachable: false,
              server_version: null,
              protocol: null,
              plugin_surface: "unknown",
              error_kind: "ssh_failed",
              error: "connection refused",
            },
          ],
        };
      }
      return {};
    });
    const deps = makeDeps(cli.fn, ui);
    const view = new MachineDetailView(deps, ITEM);
    view.handleKey(keyEvent("p"));
    await flush(20);
    expect(cli.calls).toEqual([["probe", "devbox"]]);
    expect(ui.pushed).toHaveLength(1);
    const pushedText = linesText((ui.pushed[0] as ScreenView).render(100, 30)).join("\n");
    expect(pushedText).toContain("unreachable");
    expect(pushedText).toContain("connection refused");
  });
});
