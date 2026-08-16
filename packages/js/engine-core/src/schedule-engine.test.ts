import { describe, expect, it } from "vitest";

import { decide } from "./schedule-engine.ts";
import type { SchedRow } from "./models/schedule.model.ts";

// A one-shot armed to fire at 01:00.
const base: SchedRow = {
  id: "sched-abc",
  status: "armed",
  fireAt: "2026-07-18T01:00:00Z",
  trigger: { key: "implement-pr", instanceId: "sched-abc" },
  epoch: 1,
  createdAt: "2026-07-18T00:00:00Z",
  updatedAt: "2026-07-18T00:00:00Z",
};
const at = (iso: string) => new Date(iso).getTime();
const BEFORE = at("2026-07-18T00:30:00Z");
const AT = at("2026-07-18T01:00:00Z");
const AFTER = at("2026-07-18T02:00:00Z");

describe("schedule-engine decide", () => {
  it("waits when not armed (fired/expired/disarmed)", () => {
    for (const status of ["fired", "expired", "disarmed"] as const) {
      expect(decide({ ...base, status }, AFTER)).toEqual({ kind: "wait" });
    }
  });

  it("waits when fireAt is in the future", () => {
    expect(decide(base, BEFORE)).toEqual({ kind: "wait" });
  });

  it("fires exactly at fireAt", () => {
    expect(decide(base, AT)).toEqual({ kind: "fire" });
  });

  it("fires late when fireAt is in the past (self-healing after an outage)", () => {
    expect(decide(base, AFTER)).toEqual({ kind: "fire" });
  });

  it("expires when notAfter has passed before firing", () => {
    const withDeadline: SchedRow = { ...base, notAfter: "2026-07-18T01:30:00Z" };
    expect(decide(withDeadline, at("2026-07-18T01:31:00Z"))).toEqual({ kind: "expire" });
  });

  it("expire wins over fire when a row is simultaneously due and past its deadline", () => {
    // fireAt and notAfter both passed → expire (never fire a stale schedule).
    const withDeadline: SchedRow = { ...base, notAfter: "2026-07-18T01:30:00Z" };
    expect(decide(withDeadline, AFTER)).toEqual({ kind: "expire" });
  });

  it("still fires when notAfter is set but not yet reached", () => {
    const withDeadline: SchedRow = { ...base, notAfter: "2026-07-18T03:00:00Z" };
    expect(decide(withDeadline, AT)).toEqual({ kind: "fire" });
  });
});
