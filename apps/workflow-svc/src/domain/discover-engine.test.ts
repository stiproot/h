import { describe, expect, it } from "vitest";

import { decide } from "./discover-engine.ts";
import type { DiscoverRow } from "engine-core";

// A discovery cron scanning every 30 min, last scanned at 00:00 — due at 00:31, not at 00:15. It has
// fired once (an instance is recorded), so the in-flight guard is exercised.
const base: DiscoverRow = {
  repo: "stiproot/h",
  label: "agent-approved",
  trigger: { key: "implement-pr" },
  status: "active",
  cadence: "*/30 * * * *",
  source: { mode: "github-issues" },
  gates: { maxFiresPerDay: 5 },
  epoch: 1,
  fires: 1,
  currentInstanceId: "feature-issue-42",
  lastFiredIssue: 42,
  lastRunAt: "2026-07-12T00:00:00Z",
  createdAt: "2026-07-12T00:00:00Z",
  updatedAt: "2026-07-12T00:00:00Z",
};
const at = (iso: string) => new Date(iso).getTime();
const DUE = at("2026-07-12T00:31:00Z");
const NOT_DUE = at("2026-07-12T00:15:00Z");

describe("discover-engine decide", () => {
  it("waits when inactive", () => {
    expect(decide({ ...base, status: "inactive" }, "COMPLETED", 0, DUE)).toEqual({ kind: "wait" });
  });

  it("waits while the last-fired instance is in flight (serialize)", () => {
    expect(decide(base, "RUNNING", 0, DUE)).toEqual({ kind: "wait" });
    // UNKNOWN counts as live — a degraded status API must not double-fire.
    expect(decide(base, "UNKNOWN", 0, DUE)).toEqual({ kind: "wait" });
    expect(decide(base, undefined, 0, DUE)).toEqual({ kind: "wait" });
  });

  it("discovers when the last run is terminal, due, and under the daily cap", () => {
    expect(decide(base, "COMPLETED", 0, DUE)).toEqual({ kind: "discover" });
    expect(decide(base, "FAILED", 4, DUE)).toEqual({ kind: "discover" });
  });

  it("waits when terminal but not yet due (the read budget)", () => {
    expect(decide(base, "COMPLETED", 0, NOT_DUE)).toEqual({ kind: "wait" });
  });

  it("waits when due but the daily cap is reached", () => {
    expect(decide(base, "COMPLETED", 5, DUE)).toEqual({ kind: "wait" });
  });

  it("discovers on the first tick when never fired before (no instance) and due", () => {
    const fresh: DiscoverRow = {
      ...base,
      fires: 0,
      currentInstanceId: undefined,
      lastRunAt: undefined,
    };
    expect(decide(fresh, undefined, 0, DUE)).toEqual({ kind: "discover" });
  });
});
