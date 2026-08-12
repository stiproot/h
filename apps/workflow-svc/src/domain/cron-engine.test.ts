import { describe, expect, it } from "vitest";

import { decide, nextUnknownStreak } from "./cron-engine.ts";
import type { CronRow } from "./models/cron.model.ts";
import { DEFAULT_UNKNOWN_STREAK_LIMIT } from "./models/watch.model.ts";

// A cron that fires every 30 min, last fired at 00:00 — so due at 00:31, not due at 00:15.
const base: CronRow = {
  repo: "stiproot/h",
  slug: "pi-agent",
  workflow: "revise-pr",
  status: "active",
  cadence: "*/30 * * * *",
  source: { mode: "saved", key: "revise-pr" },
  budget: { maxFires: 100 },
  instanceId: "revise-pi-agent",
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

  // The liveness hole: an instance that is GONE (purged, history lost) reads UNKNOWN on every
  // tick, so the in-flight guard above would pin the cron forever and silently end the recurrence.
  it("escapes the in-flight guard once UNKNOWN has persisted past the streak limit", () => {
    const nearly = { ...base, unknownStreak: DEFAULT_UNKNOWN_STREAK_LIMIT - 2 };
    expect(decide(nearly, false, "UNKNOWN", DUE)).toEqual({ kind: "wait" });
    const exhausted = { ...base, unknownStreak: DEFAULT_UNKNOWN_STREAK_LIMIT - 1 };
    expect(decide(exhausted, false, "UNKNOWN", DUE)).toEqual({ kind: "fire" });
  });

  // The escape frees the guard; it does not override the gates that come before it.
  it("a spent streak still respects cadence, budget, and the goal handshake", () => {
    const exhausted = { ...base, unknownStreak: DEFAULT_UNKNOWN_STREAK_LIMIT };
    expect(decide(exhausted, false, "UNKNOWN", NOT_DUE)).toEqual({ kind: "wait" });
    expect(decide({ ...exhausted, fires: 100 }, false, "UNKNOWN", DUE)).toEqual({
      kind: "deactivate",
      outcome: "budget-exhausted",
    });
    expect(decide(exhausted, true, "UNKNOWN", DUE)).toEqual({
      kind: "deactivate",
      outcome: "resolved",
    });
  });

  it("counts consecutive UNKNOWNs and resets on any real status", () => {
    expect(nextUnknownStreak(base, "UNKNOWN")).toBe(1);
    expect(nextUnknownStreak({ ...base, unknownStreak: 3 }, "UNKNOWN")).toBe(4);
    expect(nextUnknownStreak({ ...base, unknownStreak: 3 }, "RUNNING")).toBe(0);
    expect(nextUnknownStreak({ ...base, unknownStreak: 3 }, "COMPLETED")).toBe(0);
    // A cron that has never fired has no instance to be unknown ABOUT.
    expect(nextUnknownStreak({ ...base, currentInstanceId: undefined }, undefined)).toBe(0);
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
