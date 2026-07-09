import {
  type ChainOutcome,
  type ChainRow,
  DEFAULT_CHAIN_UNKNOWN_STREAK_LIMIT,
} from "./models/chain.model.ts";

/**
 * The pure half of the chain engine: given one chain row, the current workflow's observed runtime
 * status, and the clock, decide what to do. No I/O — the scan (chain-scan.ts) executes decisions
 * against the ports (read the completed workflow's output, thread the blackboard, fire the next workflow).
 * Pure so the whole sequencing surface is unit-testable without layers — the sibling of
 * watch-engine.ts, where the only structural difference is that a chain ADVANCES to the next workflow
 * where a watch RETRIES the same instance.
 */

export type ChainDecision =
  /** Nothing to do this tick; persist the row iff `changed`. */
  | { readonly kind: "wait"; readonly row: ChainRow; readonly changed: boolean }
  /** Current workflow completed and a next workflow remains: fire workflows[nextCursor]. */
  | { readonly kind: "advance"; readonly row: ChainRow; readonly nextCursor: number }
  /** Sequence done, or a workflow failed/terminated/orphaned: record the outcome, publish, tally cost. */
  | { readonly kind: "finalize"; readonly row: ChainRow; readonly outcome: ChainOutcome }
  /** Chain wall-clock budget breached while the current workflow is non-terminal: terminate it, finalize. */
  | { readonly kind: "budget-terminate"; readonly row: ChainRow };

const TERMINAL: Record<string, ChainOutcome> = {
  COMPLETED: "completed",
  FAILED: "failed",
  TERMINATED: "terminated",
};

export function decide(row: ChainRow, workflowStatus: string, nowMs: number): ChainDecision {
  if (row.status === "finalized") return { kind: "wait", row, changed: false };

  const terminal = TERMINAL[workflowStatus];
  if (terminal !== undefined) {
    // The current workflow reached terminal. A clean COMPLETED with more workflows to go advances the
    // sequence; the last workflow's COMPLETED (or any FAILED/TERMINATED) finalizes the whole chain.
    if (terminal === "completed") {
      const nextCursor = row.cursor + 1;
      if (nextCursor < row.workflows.length) return { kind: "advance", row, nextCursor };
      return { kind: "finalize", row, outcome: "completed" };
    }
    return { kind: "finalize", row, outcome: terminal };
  }

  if (workflowStatus === "UNKNOWN") {
    // Conservative, exactly like the watch engine: a degraded status API never advances or
    // terminates; only a sustained streak finalizes, as orphaned. This also heals the
    // mark-before-fire crash window — a `scheduling` workflow whose invoke never landed.
    const streak = row.unknownStreak + 1;
    const updated: ChainRow = { ...row, unknownStreak: streak, lastStatus: "UNKNOWN" };
    if (streak >= DEFAULT_CHAIN_UNKNOWN_STREAK_LIMIT) {
      return { kind: "finalize", row: updated, outcome: "orphaned" };
    }
    return { kind: "wait", row: updated, changed: true };
  }

  // Live (RUNNING/PENDING/…): absolute deadline off the persisted startedAt, so a budget breach
  // slept through an outage is enforced on the first scan after recovery.
  const live: ChainRow = {
    ...row,
    status: "running",
    lastStatus: workflowStatus,
    unknownStreak: 0,
  };
  if (row.budgetMs !== undefined && nowMs >= Date.parse(row.startedAt) + row.budgetMs) {
    return { kind: "budget-terminate", row: live };
  }
  const changed =
    live.status !== row.status || live.lastStatus !== row.lastStatus || row.unknownStreak !== 0;
  return { kind: "wait", row: live, changed };
}
