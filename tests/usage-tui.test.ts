import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  divergenceItems,
  jsonLines,
  nextProvider,
  paneOpenArgs,
  providerArgs,
  providersInPayload,
  quotaItems,
  redactSecrets,
  windowArgs,
  windowLabel,
  wrapPlain,
} from "../plugins/usage/src/tui";
import { testEnv } from "./helpers/test-env";

const TUI = path.join(__dirname, "..", "plugins", "usage", "src", "tui.ts");

describe("paneOpenArgs", () => {
  test("opens the main entrypoint as a tab", () => {
    const args = paneOpenArgs();
    expect(args).toContain("rebuildup.usage");
    expect(args[args.indexOf("--entrypoint") + 1]).toBe("main");
    expect(args[args.indexOf("--placement") + 1]).toBe("tab");
  });
});

describe("window/provider args", () => {
  test("windowArgs maps presets to --from ISO bounds", () => {
    const now = Date.parse("2025-06-01T12:00:00Z");
    expect(windowArgs("all", now)).toEqual([]);
    expect(windowArgs("24h", now)).toEqual(["--from", new Date(now - 24 * 3600_000).toISOString()]);
    expect(windowArgs("7d", now)[1]).toBe(new Date(now - 7 * 24 * 3600_000).toISOString());
    expect(windowArgs("30d", now)).toHaveLength(2);
  });

  test("providerArgs omits flag for all", () => {
    expect(providerArgs("")).toEqual([]);
    expect(providerArgs("claude")).toEqual(["--provider", "claude"]);
  });

  test("windowLabel", () => {
    expect(windowLabel("all")).toBe("all time");
    expect(windowLabel("7d")).toBe("last 7d");
  });
});

describe("provider cycle", () => {
  test("providersInPayload collects ids from breakdowns/coverage/providers/comparisons", () => {
    const ids = providersInPayload({
      breakdowns: { by_provider: [{ key: "claude" }, { key: "codex" }] },
      coverage: { providers: [{ provider: "opencode" }] },
      providers: [{ provider: "claude" }],
      comparisons: [{ provider: "codex" }],
    });
    expect(ids).toEqual(["claude", "codex", "opencode"]);
  });

  test("nextProvider cycles all → ids → all", () => {
    const ids = ["claude", "codex"];
    expect(nextProvider("", ids)).toBe("claude");
    expect(nextProvider("claude", ids)).toBe("codex");
    expect(nextProvider("codex", ids)).toBe("");
    expect(nextProvider("claude", [])).toBe("");
  });
});

describe("redactSecrets", () => {
  test("drops credential-shaped keys recursively, keeps the rest", () => {
    const out = redactSecrets({
      provider: "claude",
      api_key: "sk-secret",
      nested: { access_token: "t", plan: "pro" },
      list: [{ password: "p", ok: 1 }],
    }) as Record<string, unknown>;
    expect(out.provider).toBe("claude");
    expect(out.api_key).toBeUndefined();
    const nested = out.nested as Record<string, unknown>;
    expect(nested.access_token).toBeUndefined();
    expect(nested.plan).toBe("pro");
    const list = out.list as Record<string, unknown>[];
    expect(list[0]?.password).toBeUndefined();
    expect(list[0]?.ok).toBe(1);
  });

  test("jsonLines applies redaction and bounds output", () => {
    const lines = jsonLines({ token: "x", keep: 1 });
    expect(lines.join("\n")).not.toContain('"token"');
    expect(lines.join("\n")).toContain('"keep": 1');
  });
});

describe("quotaItems", () => {
  test("maps providers and hub accounts with honest statuses", () => {
    const items = quotaItems({
      providers: [
        {
          provider: "claude",
          status: "ok",
          stale: true,
          detail: null,
          windows: [{ id: "five_hour", label: "5h", used_percent: 42.4 }],
        },
        { provider: "opencode", status: "unsupported", windows: [] },
      ],
      hubs: [
        {
          id: "hub1",
          accounts: [{ account: "a1", provider: "claude", status: "ok", windows: [] }],
        },
        { id: "hub2", accounts: [] },
      ],
    });
    expect(items).toHaveLength(4);
    expect(items[0]?.label).toBe("claude");
    expect(items[0]?.detail).toContain("42%");
    expect(items[0]?.detail).toContain("STALE");
    expect(items[1]?.detail).toContain("unsupported");
    expect(items[2]?.label).toBe("hub1 · a1");
    expect(items[3]?.label).toBe("hub2");
  });
});

describe("divergenceItems", () => {
  test("maps comparisons with verdict + both sides", () => {
    const items = divergenceItems({
      comparisons: [
        {
          provider: "claude",
          verdict: "different_units",
          detail: null,
          quota: { status: "ok" },
          measured: { total_tokens: 1234 },
        },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.provider).toBe("claude");
    expect(items[0]?.detail).toContain("different_units");
    expect(items[0]?.detail).toContain("total_tokens=1234");
  });
});

describe("wrapPlain", () => {
  test("wraps long lines and keeps short lines", () => {
    expect(wrapPlain("short", 20)).toEqual(["short"]);
    const wrapped = wrapPlain("aaa bbb ccc ddd eee fff ggg", 10);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const l of wrapped) expect(l.length).toBeLessThanOrEqual(10);
  });
});

describe("non-TTY entrypoint", () => {
  test("prints CLI fallback notice and exits 0 without a TTY", () => {
    const result = spawnSync(process.execPath, [TUI, "main"], {
      encoding: "utf8",
      env: testEnv(),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("requires an interactive terminal");
  });
});
