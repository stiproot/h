import { describe, expect, it } from "vitest";

import type { ChainRow } from "./models/chain.model.ts";
import { DEFAULT_CHAIN_UNKNOWN_STREAK_LIMIT } from "./models/chain.model.ts";
import { decide } from "./chain-engine.ts";

const T0 = Date.parse("2026-07-08T09:00:00Z");

// A three-workflow chain (feature-pr → pr-review → revise), cursor on the first workflow by default.
function row(overrides: Partial<ChainRow> = {}): ChainRow {
  return {
    chainId: "dark-mode",
    epoch: 1,
    slug: "dark-mode",
    workflows: [
      { kind: "feature-pr", key: "feature-pr" },
      { kind: "pr-review", key: "pr-review" },
      { kind: "revise", key: "feature-pr" },
    ],
    strategy: "sequential",
    cursor: 0,
    currentInstanceId: "feature-dark-mode",
    data: { slug: "dark-mode" },
    status: "running",
    lastStatus: "RUNNING",
    unknownStreak: 0,
    startedAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

describe("decide: current workflow terminal", () => {
  it("advances to the next workflow when the current one completes and more remain", () => {
    const d = decide(row({ cursor: 0 }), "COMPLETED", T0 + 1000);
    expect(d.kind).toBe("advance");
    if (d.kind === "advance") expect(d.nextCursor).toBe(1);
  });

  it("advances from the middle workflow", () => {
    const d = decide(row({ cursor: 1 }), "COMPLETED", T0 + 1000);
    expect(d.kind).toBe("advance");
    if (d.kind === "advance") expect(d.nextCursor).toBe(2);
  });

  it("finalizes completed when the LAST workflow completes", () => {
    const d = decide(row({ cursor: 2 }), "COMPLETED", T0 + 1000);
    expect(d.kind).toBe("finalize");
    if (d.kind === "finalize") expect(d.outcome).toBe("completed");
  });

  it("finalizes failed when any workflow fails — no advance past a failure", () => {
    const d = decide(row({ cursor: 0 }), "FAILED", T0 + 1000);
    expect(d.kind).toBe("finalize");
    if (d.kind === "finalize") expect(d.outcome).toBe("failed");
  });

  it("finalizes terminated when a workflow is terminated", () => {
    const d = decide(row({ cursor: 1 }), "TERMINATED", T0 + 1000);
    expect(d.kind).toBe("finalize");
    if (d.kind === "finalize") expect(d.outcome).toBe("terminated");
  });
});

describe("decide: live workflow", () => {
  it("waits inside a budget, promoting scheduling → running", () => {
    const d = decide(
      row({ status: "scheduling", lastStatus: "SCHEDULED", budgetMs: 45 * 60_000 }),
      "RUNNING",
      T0 + 1000,
    );
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") {
      expect(d.changed).toBe(true);
      expect(d.row.status).toBe("running");
      expect(d.row.lastStatus).toBe("RUNNING");
    }
  });

  it("waits unchanged when nothing moved", () => {
    const d = decide(row({ status: "running", lastStatus: "RUNNING" }), "RUNNING", T0 + 1000);
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") expect(d.changed).toBe(false);
  });

  it("budget-terminates when the chain wall-clock budget is breached", () => {
    const d = decide(row({ budgetMs: 60_000 }), "RUNNING", T0 + 61_000);
    expect(d.kind).toBe("budget-terminate");
  });

  it("never budget-terminates without a chain budget (workflows carry their own)", () => {
    const d = decide(row({ budgetMs: undefined }), "RUNNING", T0 + 10 * 60 * 60_000);
    expect(d.kind).toBe("wait");
  });

  it("enforces an absolute deadline off startedAt, not wall-clock-since-scan", () => {
    // startedAt is 2h ago; a 45m budget is long breached even on the first scan after an outage.
    const started = new Date(T0 - 2 * 60 * 60_000).toISOString();
    const d = decide(row({ startedAt: started, budgetMs: 45 * 60_000 }), "RUNNING", T0);
    expect(d.kind).toBe("budget-terminate");
  });
});

describe("decide: UNKNOWN is conservative", () => {
  it("waits and bumps the streak on a single UNKNOWN", () => {
    const d = decide(row({ unknownStreak: 0 }), "UNKNOWN", T0 + 1000);
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") {
      expect(d.changed).toBe(true);
      expect(d.row.unknownStreak).toBe(1);
    }
  });

  it("finalizes orphaned only once the streak limit is reached", () => {
    const d = decide(row({ unknownStreak: DEFAULT_CHAIN_UNKNOWN_STREAK_LIMIT - 1 }), "UNKNOWN", T0);
    expect(d.kind).toBe("finalize");
    if (d.kind === "finalize") expect(d.outcome).toBe("orphaned");
  });

  it("resets the streak once a live status returns", () => {
    const d = decide(row({ unknownStreak: 3 }), "RUNNING", T0 + 1000);
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") expect(d.row.unknownStreak).toBe(0);
  });
});

describe("decide: finalized rows are inert", () => {
  it("waits unchanged regardless of observed status", () => {
    const d = decide(row({ status: "finalized" }), "COMPLETED", T0 + 1000);
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") expect(d.changed).toBe(false);
  });
});
