import { type SchedRow } from "./models/schedule.model.ts";

/**
 * The pure half of the SCHEDULED-FIRE cron (docs/plans/schedule-and-fallback.md) — the third variant
 * of the cron siblings, sibling of cron-engine.ts (recur) and discover-engine.ts (fan-out). Given one
 * scheduled-fire row and the clock, decide whether this tick fires it once, expires it, or waits. No
 * I/O — the scan (schedule-scan.ts) executes the decision (fire the source through invokeWithWatch,
 * or deactivate) and stamps the row. Pure so the gating is unit-testable without layers.
 *
 * Unlike the recur engine there is no `resolved` handshake, no `maxFires` budget, and no in-flight
 * guard: a one-shot fires exactly once and is done. The only shape is time.
 *
 * Precedence: not-armed → notAfter deadline → fireAt. A fireAt already in the past fires LATE (a tick
 * slept through an outage still fires on recovery — self-healing, matching isDue's stamp-forward);
 * `notAfter` is the opt-in guard for a time-critical schedule that must NOT fire if the window passed.
 */

export type SchedDecision =
  /** Nothing to do this tick (not armed, or fireAt not yet reached). */
  | { readonly kind: "wait" }
  /** fireAt reached (and no expired deadline): fire the source once. */
  | { readonly kind: "fire" }
  /** notAfter passed before fireAt was reached: deactivate without firing. */
  | { readonly kind: "expire" };

export function decide(row: SchedRow, nowMs: number): SchedDecision {
  if (row.status !== "armed") return { kind: "wait" };
  // Missed-window guard: an armed row whose notAfter has passed expires without firing. Checked before
  // fireAt so a row that is simultaneously due and past-deadline expires rather than fires.
  if (row.notAfter !== undefined && Date.parse(row.notAfter) < nowMs) return { kind: "expire" };
  // Fire once when the clock reaches fireAt; a fireAt in the past fires late (self-healing).
  if (Date.parse(row.fireAt) <= nowMs) return { kind: "fire" };
  return { kind: "wait" };
}
