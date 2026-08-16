import {
  DEFAULT_UNKNOWN_STREAK_LIMIT,
  type WatchOutcome,
  type WatchRow,
} from "./models/watch.model.ts";

/**
 * The pure half of the watch engine: given one row, the subject's observed runtime status,
 * and the clock, decide what to do. No I/O — the scan (watch-scan.ts) executes decisions
 * against the ports. Pure so the whole policy surface is unit-testable without layers.
 */

export type WatchDecision =
  /** Nothing to do this tick; persist the row iff `changed`. */
  | { readonly kind: "wait"; readonly row: WatchRow; readonly changed: boolean }
  /** Wall-clock budget breached while non-terminal: terminate, then finalize/retry as budget-terminated. */
  | { readonly kind: "budget-terminate"; readonly row: WatchRow }
  /** Terminal (or unknown-streak exhausted): record the outcome, publish, tally cost. */
  | { readonly kind: "finalize"; readonly row: WatchRow; readonly outcome: WatchOutcome }
  /** Terminal with a matching retry policy and attempts to spare: re-fire the resubmit. */
  | { readonly kind: "retry"; readonly row: WatchRow; readonly outcome: WatchOutcome };

const TERMINAL: Record<string, WatchOutcome> = {
  COMPLETED: "completed",
  FAILED: "failed",
  TERMINATED: "terminated",
};

/** Whether the row's retry policy fires for this outcome (default trigger: failed only). */
export function retryApplies(row: WatchRow, outcome: WatchOutcome): boolean {
  const retry = row.policy.retry;
  if (!retry || row.resubmit === undefined) return false;
  const triggers = retry.onOutcome ?? ["failed"];
  return triggers.includes(outcome) && row.attempts < retry.maxAttempts;
}

/** Terminal outcome → finalize or retry; shared by the observed-terminal and budget paths. */
export function settle(row: WatchRow, outcome: WatchOutcome): WatchDecision {
  return retryApplies(row, outcome)
    ? { kind: "retry", row, outcome }
    : { kind: "finalize", row, outcome };
}

export function decide(row: WatchRow, runtimeStatus: string, nowMs: number): WatchDecision {
  if (row.status === "finalized") return { kind: "wait", row, changed: false };

  const terminal = TERMINAL[runtimeStatus];
  if (terminal !== undefined) return settle(row, terminal);

  if (runtimeStatus === "UNKNOWN") {
    // UNKNOWN is conservative (agreement 8): a degraded status API never triggers terminate;
    // only a sustained streak finalizes, as orphaned — an event, never a kill. It also covers
    // the mark-before-fire crash window: a `scheduling` row whose invoke never landed heals
    // here instead of hanging forever.
    const streak = row.unknownStreak + 1;
    const limit = row.policy.unknownStreakLimit ?? DEFAULT_UNKNOWN_STREAK_LIMIT;
    const updated: WatchRow = { ...row, unknownStreak: streak, lastStatus: "UNKNOWN" };
    if (streak >= limit) return { kind: "finalize", row: updated, outcome: "orphaned" };
    return { kind: "wait", row: updated, changed: true };
  }

  // Live (RUNNING/PENDING/…): absolute deadline off the persisted startedAt (agreement 3),
  // so a breach slept through an outage is enforced on the first scan after recovery.
  const live: WatchRow = {
    ...row,
    status: "watching",
    lastStatus: runtimeStatus,
    unknownStreak: 0,
  };
  if (nowMs >= Date.parse(row.startedAt) + row.policy.maxDurationMs) {
    return { kind: "budget-terminate", row: live };
  }
  const changed =
    live.status !== row.status || live.lastStatus !== row.lastStatus || row.unknownStreak !== 0;
  return { kind: "wait", row: live, changed };
}
