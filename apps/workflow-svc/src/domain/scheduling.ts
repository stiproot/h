import { parseExpression } from "cron-parser";

import type { WorkflowSchedule } from "./models/workflow.model.ts";

/**
 * Whether a scheduled workflow is due to fire at `now`. The cron expression's next fire after the
 * baseline (the last run, or the save time if it has never run) must already have passed.
 *
 * Stamping the baseline forward to `now` on each fire makes missed fires self-healing: a daily job
 * that was idle for days fires once, then the next baseline is in the future and it is no longer due.
 * Cron expressions are evaluated in UTC.
 */
export function isDue(schedule: WorkflowSchedule, now: Date): boolean {
  const baseline = schedule.lastRunAt ?? schedule.savedAt;
  const next = parseExpression(schedule.cron, {
    currentDate: new Date(baseline),
    tz: "UTC",
  })
    .next()
    .getTime();
  return next <= now.getTime();
}

/** Validates a cron expression, throwing if it cannot be parsed. */
export function assertValidCron(cron: string): void {
  parseExpression(cron, { tz: "UTC" });
}
