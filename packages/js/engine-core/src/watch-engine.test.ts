import { describe, expect, it } from "vitest";

import type { WatchRow } from "./models/watch.model.ts";
import { decide, retryApplies, settle } from "./watch-engine.ts";

const T0 = Date.parse("2026-07-05T09:00:00Z");

function row(overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    instanceId: "feature-issue-12",
    epoch: 1,
    attempts: 1,
    startedAt: new Date(T0).toISOString(),
    policy: { maxDurationMs: 45 * 60_000 },
    status: "watching",
    lastStatus: "RUNNING",
    unknownStreak: 0,
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

describe("decide: live subject", () => {
  it("waits inside the budget, promoting scheduling → watching", () => {
    const d = decide(row({ status: "scheduling", lastStatus: "SCHEDULED" }), "RUNNING", T0 + 1000);
    expect(d).toMatchObject({ kind: "wait", changed: true });
    if (d.kind === "wait") {
      expect(d.row.status).toBe("watching");
      expect(d.row.lastStatus).toBe("RUNNING");
    }
  });

  it("reports no change when nothing moved", () => {
    const d = decide(row(), "RUNNING", T0 + 1000);
    expect(d).toMatchObject({ kind: "wait", changed: false });
  });

  it("resets the unknown streak on a live status", () => {
    const d = decide(row({ unknownStreak: 3 }), "RUNNING", T0 + 1000);
    expect(d).toMatchObject({ kind: "wait", changed: true });
    if (d.kind === "wait") expect(d.row.unknownStreak).toBe(0);
  });

  it("budget-terminates at the absolute deadline — startedAt-based, not tick-counted", () => {
    // A breach slept through an outage is enforced on the first scan after recovery
    // (agreement 3): the deadline base is the persisted startedAt.
    const d = decide(row(), "RUNNING", T0 + 45 * 60_000);
    expect(d.kind).toBe("budget-terminate");
  });

  it("does not terminate one tick before the deadline", () => {
    expect(decide(row(), "RUNNING", T0 + 45 * 60_000 - 1).kind).toBe("wait");
  });
});

describe("decide: terminal subject", () => {
  it("finalizes completed", () => {
    expect(decide(row(), "COMPLETED", T0)).toMatchObject({
      kind: "finalize",
      outcome: "completed",
    });
  });

  it("finalizes an externally terminated run as terminated, not budget-terminated", () => {
    expect(decide(row(), "TERMINATED", T0)).toMatchObject({
      kind: "finalize",
      outcome: "terminated",
    });
  });

  it("retries a failure with attempts to spare", () => {
    const r = row({
      policy: { maxDurationMs: 1000, retry: { maxAttempts: 2 } },
      resubmit: { steps: [] },
    });
    expect(decide(r, "FAILED", T0)).toMatchObject({ kind: "retry", outcome: "failed" });
  });

  it("finalizes a failure at the attempt cap", () => {
    const r = row({
      attempts: 2,
      policy: { maxDurationMs: 1000, retry: { maxAttempts: 2 } },
      resubmit: { steps: [] },
    });
    expect(decide(r, "FAILED", T0)).toMatchObject({ kind: "finalize", outcome: "failed" });
  });

  it("never retries without a stored resubmit", () => {
    const r = row({ policy: { maxDurationMs: 1000, retry: { maxAttempts: 5 } } });
    expect(decide(r, "FAILED", T0).kind).toBe("finalize");
  });

  it("retry triggers default to failed only — completed never retries", () => {
    const r = row({
      policy: { maxDurationMs: 1000, retry: { maxAttempts: 2 } },
      resubmit: { steps: [] },
    });
    expect(decide(r, "COMPLETED", T0).kind).toBe("finalize");
    expect(retryApplies(r, "budget-terminated")).toBe(false);
  });

  it("onOutcome extends retry to budget-terminated when asked", () => {
    const r = row({
      policy: {
        maxDurationMs: 1000,
        retry: { maxAttempts: 2, onOutcome: ["failed", "budget-terminated"] },
      },
      resubmit: { steps: [] },
    });
    expect(settle(r, "budget-terminated")).toMatchObject({ kind: "retry" });
  });
});

describe("decide: UNKNOWN is conservative (agreement 8)", () => {
  it("increments the streak and waits below the limit", () => {
    const d = decide(row(), "UNKNOWN", T0);
    expect(d).toMatchObject({ kind: "wait", changed: true });
    if (d.kind === "wait") expect(d.row.unknownStreak).toBe(1);
  });

  it("never terminates on UNKNOWN, even past the budget", () => {
    // A degraded status API must not trigger a kill; the streak machinery owns UNKNOWN.
    const d = decide(row(), "UNKNOWN", T0 + 10 * 60 * 60_000);
    expect(d.kind).not.toBe("budget-terminate");
  });

  it("finalizes as orphaned when the streak exhausts (default 6)", () => {
    const d = decide(row({ unknownStreak: 5 }), "UNKNOWN", T0);
    expect(d).toMatchObject({ kind: "finalize", outcome: "orphaned" });
  });

  it("honours a custom streak limit", () => {
    const r = row({ policy: { maxDurationMs: 1000, unknownStreakLimit: 2 }, unknownStreak: 1 });
    expect(decide(r, "UNKNOWN", T0)).toMatchObject({ kind: "finalize", outcome: "orphaned" });
  });
});

describe("decide: finalized rows are inert", () => {
  it("waits unchanged regardless of observed status", () => {
    const r = row({ status: "finalized", outcome: "completed" });
    expect(decide(r, "RUNNING", T0)).toMatchObject({ kind: "wait", changed: false });
    expect(decide(r, "FAILED", T0)).toMatchObject({ kind: "wait", changed: false });
  });
});
