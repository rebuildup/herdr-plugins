import { describe, expect, test } from "bun:test";
import {
  CONTRACT,
  capabilityDocument,
  PLUGIN_ID,
  PLUGIN_VERSION,
} from "../plugins/automations/src/cli";

describe("automations capability (T1 scaffold, #137)", () => {
  test("declares the draft v1 contract identity", () => {
    const doc = capabilityDocument();
    expect(doc.contract).toBe("herdr-plugins.automations/v1");
    expect(doc.contract).toBe(CONTRACT);
    expect(doc.plugin).toBe("rebuildup.automations");
    expect(doc.plugin).toBe(PLUGIN_ID);
    expect(doc.version).toBe(PLUGIN_VERSION);
    expect(doc.contract_status).toBe("draft");
  });

  test("advertises only implemented commands, plans the rest", () => {
    const doc = capabilityDocument();
    expect(doc.commands).toEqual(["capability"]);
    for (const planned of ["create", "list", "fire", "tick", "watch", "schedule", "hook"]) {
      expect(doc.planned_commands).toContain(planned);
    }
  });

  test("v1 schedule scope: interval/fixed_time/once in, webhook/event reserved", () => {
    const doc = capabilityDocument();
    expect(doc.schedules).toEqual(["interval", "fixed_time", "once"]);
    expect(doc.reserved_schedules).toEqual(["webhook", "event"]);
    // Reserved types must never appear as accepted schedules.
    for (const reserved of doc.reserved_schedules) {
      expect(doc.schedules).not.toContain(reserved);
    }
  });
});
