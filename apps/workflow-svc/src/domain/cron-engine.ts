import { type CronOutcome, type CronRow } from "./models/cron.model.ts";
import { isDue } from "./scheduling.ts";

/**
 * The pure half of the cron engine: given one cron row, whether its target `wf:` row reports the goal
 * resolved, the last fired instance's observed runtime status, and the clock, decide what to do. No
 * I/O — the scan (cron-scan.ts) reads the target `wf:` row + the live instance and executes the
 * decision (fire the workflow / deactivate). Pure so the whole recur surface is unit-testable without
 * layers — the sibling of watch-engine.ts / chain-engine.ts, where the only structural difference is
 * that a cron RE-FIRES the same workflow on a clock where a watch retries and a chain advances.
 *
 * Precedence (§6, decision (b)): resolved → budget → in-flight → cadence. The goal handshake wins over
 * everything (a resolved subject stops immediately, even mid-flight); the budget is the backstop for a
 * goal that never resolves; the in-flight guard never lets two runs overlap; cadence gates the rest.
 */

export type CronDecision =
  /** Nothing to do this tick. */
  | { readonly kind: "wait" }
  /** Due, not in-flight, not resolved, under budget: re-invoke the workflow. */
  | { readonly kind: "fire" }
  /** Terminal: deactivate the cron (goal met or budget exhausted). */
  | { readonly kind: "deactivate"; readonly outcome: CronOutcome };

// A run is "in flight" until its instance reaches one of these; anything else (incl. UNKNOWN) counts
// as still live, so a degraded status API never double-fires — the watch engine's conservative rule.
const TERMINAL = new Set(["COMPLETED", "FAILED", "TERMINATED"]);

export function decide(
  row: CronRow,
  resolved: boolean,
  runtimeStatus: string | undefined,
  nowMs: number,
): CronDecision {
  if (row.status !== "active") return { kind: "wait" };
  // Goal handshake: the target wf: row reports the SUBJECT resolved (e.g. the PR merged) → stop.
  if (resolved) return { kind: "deactivate", outcome: "resolved" };
  // Budget: a goal that never resolves still stops, bounded.
  if (row.fires >= row.budget.maxFires) return { kind: "deactivate", outcome: "budget-exhausted" };
  // In-flight guard: never re-fire while the last instance is live. A cron that has never fired
  // (no currentInstanceId) is not in flight.
  const inFlight = row.currentInstanceId !== undefined && !TERMINAL.has(runtimeStatus ?? "UNKNOWN");
  if (inFlight) return { kind: "wait" };
  // Due on the cadence since the last fire (else creation)?
  const due = isDue(
    { cron: row.cadence, savedAt: row.createdAt, lastRunAt: row.lastRunAt },
    new Date(nowMs),
  );
  return due ? { kind: "fire" } : { kind: "wait" };
}
