import { type DiscoverRow } from "./models/discover.model.ts";
import { isDue } from "./scheduling.ts";

/**
 * The pure half of the DISCOVERY cron (docs/plans/impl/workflow-watcher-registry.md §9): given one
 * discovery row, the last-fired instance's observed runtime status, today's fan-out fire count, and
 * the clock, decide whether this tick should ENUMERATE the source. No I/O — the scan (discover-scan.ts)
 * reads the ledger + the live instance, executes the decision (read source → dedup vs `wf:*` → fire the
 * OLDEST eligible), and stamps the row. Pure so the gating is unit-testable without layers.
 *
 * Unlike the recur engine, a discovery cron never `deactivate`s from here — it has no `resolved`
 * handshake and no lifetime budget (the daily cap resets), so it runs until manually disarmed. The
 * decision is only wait vs discover.
 *
 * Precedence: in-flight → cadence → daily-cap.
 *  - in-flight guard IS the serialize bound (maxConcurrent = 1): never read/fire while the last-fired
 *    run is live, so at most one discovered run is in flight at a time — no `wf:*` enumeration needed.
 *  - cadence gates WHEN the source is read, which is also the GitHub read budget (once per cadence).
 *  - daily-cap is the runaway backstop for a busy label class.
 */

export type DiscoverDecision =
  /** Nothing to do this tick. */
  | { readonly kind: "wait" }
  /** Due, not in-flight, under the daily cap: read the source and fan out one fire. */
  | { readonly kind: "discover" };

// A run is "in flight" until its instance reaches one of these; anything else (incl. UNKNOWN) counts
// as still live, so a degraded status API never double-fires — the recur/watch engines' rule.
const TERMINAL = new Set(["COMPLETED", "FAILED", "TERMINATED"]);

export function decide(
  row: DiscoverRow,
  runtimeStatus: string | undefined,
  todayFires: number,
  nowMs: number,
): DiscoverDecision {
  if (row.status !== "active") return { kind: "wait" };
  // Serialize: never read/fire while the last-fired instance is live. A cron that has never fired
  // (no currentInstanceId) is not in flight.
  const inFlight = row.currentInstanceId !== undefined && !TERMINAL.has(runtimeStatus ?? "UNKNOWN");
  if (inFlight) return { kind: "wait" };
  // Cadence gate — reading the source only when due IS the read budget.
  const due = isDue(
    { cron: row.cadence, savedAt: row.createdAt, lastRunAt: row.lastRunAt },
    new Date(nowMs),
  );
  if (!due) return { kind: "wait" };
  // Daily backstop (resets each UTC day; tallied on cron:ledger:<date>.discoveryFires).
  if (todayFires >= row.gates.maxFiresPerDay) return { kind: "wait" };
  return { kind: "discover" };
}
