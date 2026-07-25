import { describe, expect, it } from "vitest";

import type { ChainRow, ChainMember } from "./models/chain.model.ts";
import { DEFAULT_CHAIN_UNKNOWN_STREAK_LIMIT, validateChain } from "./models/chain.model.ts";
import { decide, type MemberObservation } from "./chain-engine.ts";

const T0 = Date.parse("2026-07-08T09:00:00Z");

// A three-workflow chain (feature-pr → pr-review → revise), one member per stage by default; cursor
// on stage 0 (feature-pr) unless overridden.
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

// One member's observation, with the completion predicate derived from its runtime status exactly as
// the scan does for a plain (Phase 2) member: COMPLETED ⇒ done, FAILED/TERMINATED ⇒ failed.
function obs(runtimeStatus: string, index = 0): MemberObservation {
  return {
    index,
    runtimeStatus,
    done: runtimeStatus === "COMPLETED",
    failed: runtimeStatus === "FAILED" || runtimeStatus === "TERMINATED",
  };
}

/** A single-member stage observation (the common one-member-per-stage case). */
function stage(runtimeStatus: string, index = 0): MemberObservation[] {
  return [obs(runtimeStatus, index)];
}

describe("decide: current stage terminal", () => {
  it("advances to the next stage when the current one completes and more remain", () => {
    const d = decide(row({ cursor: 0 }), stage("COMPLETED"), T0 + 1000);
    expect(d.kind).toBe("advance");
    if (d.kind === "advance") expect(d.nextStage).toBe(1);
  });

  it("advances from the middle stage", () => {
    const d = decide(row({ cursor: 1 }), stage("COMPLETED", 1), T0 + 1000);
    expect(d.kind).toBe("advance");
    if (d.kind === "advance") expect(d.nextStage).toBe(2);
  });

  it("finalizes completed when the LAST stage completes", () => {
    const d = decide(row({ cursor: 2 }), stage("COMPLETED", 2), T0 + 1000);
    expect(d.kind).toBe("finalize");
    if (d.kind === "finalize") expect(d.outcome).toBe("completed");
  });

  it("finalizes failed when a member fails — no advance past a failure", () => {
    const d = decide(row({ cursor: 0 }), stage("FAILED"), T0 + 1000);
    expect(d.kind).toBe("finalize");
    if (d.kind === "finalize") expect(d.outcome).toBe("failed");
  });

  it("finalizes terminated when a member is terminated", () => {
    const d = decide(row({ cursor: 1 }), stage("TERMINATED", 1), T0 + 1000);
    expect(d.kind).toBe("finalize");
    if (d.kind === "finalize") expect(d.outcome).toBe("terminated");
  });
});

describe("decide: parallel stage (concurrent members, joined)", () => {
  // A two-member stage-0 chain: {A ∥ B} → C.
  function parRow(overrides: Partial<ChainRow> = {}): ChainRow {
    const workflows: ChainMember[] = [
      { kind: "feature-pr", key: "feature-pr", stage: 0 },
      { kind: "feature-pr", key: "feature-pr", stage: 0 },
      { kind: "pr-review", key: "pr-review", stage: 1 },
    ];
    return row({ workflows, cursor: 0, ...overrides });
  }

  it("waits while any member of the stage is still running (join barrier)", () => {
    const d = decide(parRow(), [obs("COMPLETED", 0), obs("RUNNING", 1)], T0 + 1000);
    expect(d.kind).toBe("wait");
  });

  it("advances only when EVERY member of the stage completes", () => {
    const d = decide(parRow(), [obs("COMPLETED", 0), obs("COMPLETED", 1)], T0 + 1000);
    expect(d.kind).toBe("advance");
    if (d.kind === "advance") expect(d.nextStage).toBe(1);
  });

  it("finalizes failed as soon as any member fails, even with a sibling still running", () => {
    const d = decide(parRow(), [obs("FAILED", 0), obs("RUNNING", 1)], T0 + 1000);
    expect(d.kind).toBe("finalize");
    if (d.kind === "finalize") expect(d.outcome).toBe("failed");
  });

  it("finalizes completed when the last (parallel) stage all completes", () => {
    // Both members share the final stage 1 of a two-stage chain.
    const workflows: ChainMember[] = [
      { kind: "feature-pr", key: "feature-pr", stage: 0 },
      { kind: "pr-review", key: "pr-review", stage: 1 },
      { kind: "pr-review", key: "pr-review", stage: 1 },
    ];
    const d = decide(row({ workflows, cursor: 1 }), [obs("COMPLETED", 1), obs("COMPLETED", 2)], T0);
    expect(d.kind).toBe("finalize");
    if (d.kind === "finalize") expect(d.outcome).toBe("completed");
  });
});

describe("decide: live stage", () => {
  it("waits inside a budget, promoting scheduling → running", () => {
    const d = decide(
      row({ status: "scheduling", lastStatus: "SCHEDULED", budgetMs: 45 * 60_000 }),
      stage("RUNNING"),
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
    const d = decide(
      row({ status: "running", lastStatus: "RUNNING" }),
      stage("RUNNING"),
      T0 + 1000,
    );
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") expect(d.changed).toBe(false);
  });

  it("budget-terminates when the chain wall-clock budget is breached", () => {
    const d = decide(row({ budgetMs: 60_000 }), stage("RUNNING"), T0 + 61_000);
    expect(d.kind).toBe("budget-terminate");
  });

  it("never budget-terminates without a chain budget (workflows carry their own)", () => {
    const d = decide(row({ budgetMs: undefined }), stage("RUNNING"), T0 + 10 * 60 * 60_000);
    expect(d.kind).toBe("wait");
  });

  it("enforces an absolute deadline off startedAt, not wall-clock-since-scan", () => {
    // startedAt is 2h ago; a 45m budget is long breached even on the first scan after an outage.
    const started = new Date(T0 - 2 * 60 * 60_000).toISOString();
    const d = decide(row({ startedAt: started, budgetMs: 45 * 60_000 }), stage("RUNNING"), T0);
    expect(d.kind).toBe("budget-terminate");
  });
});

describe("decide: UNKNOWN is conservative", () => {
  it("waits and bumps the streak on a single UNKNOWN", () => {
    const d = decide(row({ unknownStreak: 0 }), stage("UNKNOWN"), T0 + 1000);
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") {
      expect(d.changed).toBe(true);
      expect(d.row.unknownStreak).toBe(1);
    }
  });

  it("treats a stage as UNKNOWN when any member's status is degraded", () => {
    // One member COMPLETED, the other UNKNOWN — not all done, so the streak (not an advance) owns it.
    const workflows: ChainMember[] = [
      { kind: "feature-pr", key: "feature-pr", stage: 0 },
      { kind: "feature-pr", key: "feature-pr", stage: 0 },
    ];
    const d = decide(row({ workflows, cursor: 0 }), [obs("COMPLETED", 0), obs("UNKNOWN", 1)], T0);
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") expect(d.row.unknownStreak).toBe(1);
  });

  it("finalizes orphaned only once the streak limit is reached", () => {
    const d = decide(
      row({ unknownStreak: DEFAULT_CHAIN_UNKNOWN_STREAK_LIMIT - 1 }),
      stage("UNKNOWN"),
      T0,
    );
    expect(d.kind).toBe("finalize");
    if (d.kind === "finalize") expect(d.outcome).toBe("orphaned");
  });

  it("resets the streak once a live status returns", () => {
    const d = decide(row({ unknownStreak: 3 }), stage("RUNNING"), T0 + 1000);
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") expect(d.row.unknownStreak).toBe(0);
  });
});

describe("decide: finalized rows are inert", () => {
  it("waits unchanged regardless of observed status", () => {
    const d = decide(row({ status: "finalized" }), stage("COMPLETED"), T0 + 1000);
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") expect(d.changed).toBe(false);
  });
});

describe("validateChain (registration-time member + stage shape)", () => {
  const m = (over: Partial<ChainMember> = {}): ChainMember => ({
    kind: "feature-pr",
    key: "feature-pr",
    ...over,
  });

  it("accepts a plain sequential chain", () => {
    expect(validateChain([m(), m()])).toBeNull();
  });

  it("rejects a member carrying BOTH key and steps (must be exactly one)", () => {
    expect(validateChain([m({ steps: [{ activity: "x" }] })])).toMatch(/exactly one of key/);
  });

  it("rejects a member carrying NEITHER key nor steps", () => {
    expect(validateChain([m({ key: undefined })])).toMatch(/exactly one of key/);
  });

  it("rejects a cron member that is not inline (has a key, no steps)", () => {
    expect(validateChain([m({ cron: { cadence: "* * * * *" } })])).toMatch(/must be inline/);
  });

  it("accepts an inline cron member (steps + cron, no key)", () => {
    expect(
      validateChain([
        { kind: "feature-pr", steps: [{ activity: "x" }], cron: { cadence: "* * * * *" } },
      ]),
    ).toBeNull();
  });

  it("rejects a non-contiguous stage set", () => {
    expect(validateChain([m({ stage: 0 }), m({ stage: 2 })])).toMatch(/contiguous/);
  });

  it("rejects mixed declared/undeclared stages", () => {
    expect(validateChain([m({ stage: 0 }), m()])).toMatch(/all members declare a stage or none/);
  });

  it("rejects an empty chain", () => {
    expect(validateChain([])).toMatch(/no members/);
  });
});
