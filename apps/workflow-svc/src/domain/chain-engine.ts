import {
  type ChainOutcome,
  type ChainRow,
  DEFAULT_CHAIN_UNKNOWN_STREAK_LIMIT,
  lastStage,
} from "./models/chain.model.ts";

/**
 * The pure half of the chain engine: given one chain row, an observation of every member of the
 * CURRENT STAGE (docs/plans/inline-chain-cron-composition.md D3), and the clock, decide what to do.
 * No I/O — the scan (chain-scan.ts) reads each member's runtime status (and, for cron/`until`
 * members, its output/`wf:resolved`), reduces each to a `done`/`failed` observation, then executes
 * the decision against the ports (capture outputs, thread the chain data, fire the next stage).
 *
 * Pure so the whole sequencing surface is unit-testable without layers — the sibling of
 * watch-engine.ts, where the structural difference is that a chain ADVANCES to the next STAGE (a
 * concurrent set of members, joined) where a watch RETRIES the same instance.
 */

/**
 * One member of the current stage, reduced to a decision-relevant summary. `done` is the completion
 * predicate (D4) the scan computed — terminal-success for a plain member, `wf:resolved` for a cron
 * member, the `until` predicate for a loop member. `failed` is a terminal-failure that fails the
 * chain (a cron member's transient run failure is NOT `failed` — it retries on its own clock).
 */
export type MemberObservation = {
  readonly index: number;
  readonly runtimeStatus: string;
  readonly done: boolean;
  readonly failed: boolean;
};

export type ChainDecision =
  /** Nothing to do this tick; persist the row iff `changed`. */
  | { readonly kind: "wait"; readonly row: ChainRow; readonly changed: boolean }
  /** Every member of the stage is done and a next stage remains: fire the members of `nextStage`. */
  | { readonly kind: "advance"; readonly row: ChainRow; readonly nextStage: number }
  /** Stage/chain done, or a member failed/terminated/orphaned: record the outcome, publish, tally cost. */
  | { readonly kind: "finalize"; readonly row: ChainRow; readonly outcome: ChainOutcome }
  /** Chain wall-clock budget breached while a stage is non-terminal: terminate its members, finalize. */
  | { readonly kind: "budget-terminate"; readonly row: ChainRow };

/**
 * A representative status for the row's `lastStatus` (observability): UNKNOWN dominates (a degraded
 * read), else the first not-yet-done member's status, else COMPLETED. For a single-member stage this
 * is exactly that member's status — the back-compat case.
 */
function representativeStatus(stage: readonly MemberObservation[]): string {
  if (stage.some((m) => m.runtimeStatus === "UNKNOWN")) return "UNKNOWN";
  const pending = stage.find((m) => !m.done);
  return pending ? pending.runtimeStatus : "COMPLETED";
}

export function decide(
  row: ChainRow,
  stage: readonly MemberObservation[],
  nowMs: number,
): ChainDecision {
  if (row.status === "finalized") return { kind: "wait", row, changed: false };

  // Any non-cron member reaching terminal-failure fails the WHOLE chain — no advance past a failure
  // (D6; the active teardown of still-running siblings + minted crons is wired in a later phase, this
  // just records the outcome). Failure wins over an in-flight or done sibling.
  const failed = stage.find((m) => m.failed);
  if (failed !== undefined) {
    const outcome: ChainOutcome = failed.runtimeStatus === "TERMINATED" ? "terminated" : "failed";
    return { kind: "finalize", row, outcome };
  }

  // Join: every member of the stage satisfies its completion predicate → advance to the next stage,
  // or finalize completed when this was the last stage.
  if (stage.length > 0 && stage.every((m) => m.done)) {
    const nextStage = row.cursor + 1;
    if (nextStage <= lastStage(row.workflows)) return { kind: "advance", row, nextStage };
    return { kind: "finalize", row, outcome: "completed" };
  }

  // Not all done, none failed. A degraded status API (any member UNKNOWN) is conservative, exactly
  // like the watch engine: never advance or finalize on it; only a sustained streak finalizes, as
  // orphaned. This also heals the mark-before-fire crash window (a `scheduling` member never invoked).
  if (stage.some((m) => m.runtimeStatus === "UNKNOWN")) {
    const streak = row.unknownStreak + 1;
    const updated: ChainRow = { ...row, unknownStreak: streak, lastStatus: "UNKNOWN" };
    if (streak >= DEFAULT_CHAIN_UNKNOWN_STREAK_LIMIT)
      return { kind: "finalize", row: updated, outcome: "orphaned" };
    return { kind: "wait", row: updated, changed: true };
  }

  // Live (some member RUNNING/PENDING/…): absolute deadline off the persisted startedAt, so a budget
  // breach slept through an outage is enforced on the first scan after recovery.
  const lastStatus = representativeStatus(stage);
  const live: ChainRow = { ...row, status: "running", lastStatus, unknownStreak: 0 };
  if (row.budgetMs !== undefined && nowMs >= Date.parse(row.startedAt) + row.budgetMs)
    return { kind: "budget-terminate", row: live };
  const changed =
    live.status !== row.status || live.lastStatus !== row.lastStatus || row.unknownStreak !== 0;
  return { kind: "wait", row: live, changed };
}
