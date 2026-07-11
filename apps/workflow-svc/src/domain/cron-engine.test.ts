import { describe, expect, it } from "vitest";

import { decide } from "./cron-engine.ts";
import type { CronRow } from "./models/cron.model.ts";

// A cron that fires every 30 min, last fired at 00:00 — so due at 00:31, not due at 00:15.
const base: CronRow = {
  repo: "stiproot/h",
  slug: "pi-agent",
  workflow: "revise",
  status: "active",
  cadence: "*/30 * * * *",
  source: { mode: "saved", key: "revise" },
  budget: { maxFires: 100 },
  epoch: 1,
  fires: 1,
  currentInstanceId: "revise-pi-agent",
  lastRunAt: "2026-07-11T00:00:00Z",
  createdAt: "2026-07-11T00:00:00Z",
  updatedAt: "2026-07-11T00:00:00Z",
};
const at = (iso: string) => new Date(iso).getTime();
const DUE = at("2026-07-11T00:31:00Z");
const NOT_DUE = at("2026-07-11T00:15:00Z");

describe("cron-engine decide", () => {
  it("waits when inactive", () => {
    expect(decide({ ...base, status: "inactive" }, false, "COMPLETED", DUE)).toEqual({
      kind: "wait",
    });
  });

  it("deactivates resolved when the target wf: row reports the goal met — even mid-flight", () => {
    // resolved wins over the in-flight guard and the budget.
    expect(decide(base, true, "RUNNING", DUE)).toEqual({ kind: "deactivate", outcome: "resolved" });
  });

  it("deactivates budget-exhausted when fires reached maxFires", () => {
    expect(decide({ ...base, fires: 100 }, false, "COMPLETED", DUE)).toEqual({
      kind: "deactivate",
      outcome: "budget-exhausted",
    });
  });

  it("waits while the last instance is in flight (non-terminal)", () => {
    expect(decide(base, false, "RUNNING", DUE)).toEqual({ kind: "wait" });
    // UNKNOWN counts as live — a degraded status API must not double-fire.
    expect(decide(base, false, "UNKNOWN", DUE)).toEqual({ kind: "wait" });
    expect(decide(base, false, undefined, DUE)).toEqual({ kind: "wait" });
  });

  it("fires when terminal, due, not resolved, under budget", () => {
    expect(decide(base, false, "COMPLETED", DUE)).toEqual({ kind: "fire" });
    expect(decide(base, false, "FAILED", DUE)).toEqual({ kind: "fire" });
  });

  it("waits when terminal but not yet due", () => {
    expect(decide(base, false, "COMPLETED", NOT_DUE)).toEqual({ kind: "wait" });
  });

  it("fires on the first tick when never fired before (no instance) and due", () => {
    const fresh: CronRow = {
      ...base,
      fires: 0,
      currentInstanceId: undefined,
      lastRunAt: undefined,
    };
    expect(decide(fresh, false, undefined, DUE)).toEqual({ kind: "fire" });
  });
});
