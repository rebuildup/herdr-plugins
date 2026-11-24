import { describe, expect, test } from "bun:test";
import { parseUntilSpec } from "../plugins/inbox/src/cli";

const NOW = new Date("2026-01-10T12:00:00Z");

describe("parseUntilSpec", () => {
  test("duration specs", () => {
    expect(parseUntilSpec("+30m", NOW).toISOString()).toBe("2026-01-10T12:30:00.000Z");
    expect(parseUntilSpec("+2h", NOW).toISOString()).toBe("2026-01-10T14:00:00.000Z");
    expect(parseUntilSpec("+1d", NOW).toISOString()).toBe("2026-01-11T12:00:00.000Z");
    expect(parseUntilSpec("45m", NOW).toISOString()).toBe("2026-01-10T12:45:00.000Z");
  });

  test("ISO 8601 specs", () => {
    expect(parseUntilSpec("2026-01-10T18:30:00Z", NOW).toISOString()).toBe(
      "2026-01-10T18:30:00.000Z",
    );
    expect(parseUntilSpec("2026-01-10T18:30:00+09:00", NOW).toISOString()).toBe(
      "2026-01-10T09:30:00.000Z",
    );
  });
});
