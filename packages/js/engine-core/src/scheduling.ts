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

/**
 * Parses a relative duration like "45s", "30m", "2h", "1d" into milliseconds. Whole numbers only,
 * one unit suffix (s/m/h/d). Throws on anything else — the one-shot scheduled-fire path fails fast on
 * a bad `--in` before arming. This is the server-authoritative parser; the CLI forwards raw strings.
 */
export function parseDurationMs(duration: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(duration.trim());
  if (!match) {
    throw new Error(`invalid duration '${duration}' — expected e.g. 45s, 30m, 2h, 1d`);
  }
  // The regex above guarantees both groups, and its unit alternation is exactly this table's keys —
  // so the cast is the narrowing the pattern already performed, not an assumption about the input.
  const [, value, unit] = match as unknown as [string, string, "s" | "m" | "h" | "d"];
  return Number(value) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
}

/**
 * Resolves a scheduled-fire time from EITHER an absolute ISO instant (`at`) OR a relative duration
 * (`in`, from now), returning an absolute ISO string. Throws if neither or both are given, or if the
 * value is unparseable — so the run route fails fast (400) before arming a `cron:sched:` row.
 */
export function resolveFireAt(opts: { at?: string; in?: string }, nowMs: number): string {
  const hasAt = opts.at !== undefined;
  const hasIn = opts.in !== undefined;
  if (hasAt === hasIn) {
    throw new Error("provide exactly one of `at` (absolute ISO) or `in` (relative duration)");
  }
  if (hasAt) {
    const ms = Date.parse(opts.at!);
    if (Number.isNaN(ms)) {
      throw new Error(`invalid 'at' instant '${opts.at}' — expected an ISO 8601 timestamp`);
    }
    return new Date(ms).toISOString();
  }
  return new Date(nowMs + parseDurationMs(opts.in!)).toISOString();
}
