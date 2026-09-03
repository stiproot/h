import {
  DEFAULT_STEP_SPEND,
  QUOTA_HISTORY_LIMIT,
  QUOTA_WINDOW_NAMES,
  type QuotaHistoryEntry,
  type QuotaReport,
  type QuotaRow,
  type QuotaWindowName,
} from "./models/quota.model.ts";

/**
 * The quota gate's pure half — the one `decide` both substrates run before a `run-*` activity
 * fires, and the fold that turns a run's reported quota into the `quota:` row it reads.
 *
 * The question is not "is the executor rate-limited" (that is the `exec:` fence's, and it holds
 * AFTER a run has died of it). It is "will THIS step die of it": the window's utilization plus
 * what a step of this executor tends to cost, against a ceiling. Refuse-by-name is the answer
 * with `onQuota: "fail"` (the default — a driver decides what to do with the time); `"wait"`
 * turns it into a sleep until the window resets, when the wait is bounded (a five-hour window
 * always is; a seven-day one is a refusal with a date on it).
 *
 * Every number here is a guess about a provider's accounting, which is why the gate is a
 * threshold over an observation, not a model of the account: it is exactly as good as the last
 * run's report, and the row says when that was.
 */

export type OnQuota = "fail" | "wait";

/**
 * With `wait`, a fire is deferred past this much headroom being gone rather than past all of
 * it: waiting is cheap and a step that starts at 0.95 dies half-done, so the sleep starts early.
 * With `fail` the ceiling is the window itself — refusing is disruptive, and the operator asked
 * for a decision, not a margin.
 */
export const WAIT_CEILING = 0.9;
export const FAIL_CEILING = 1;
/** The longest `wait` sleeps: a five-hour window plus slack. Past this, a wait is a refusal. */
export const DEFAULT_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
/** Resume this long after `resetsAt` — the provider's clock and ours need not agree to the second. */
export const RESET_SLACK_MS = 60 * 1000;

export type QuotaDecision =
  | { readonly action: "proceed" }
  | {
      readonly action: "wait";
      readonly window: QuotaWindowName;
      readonly untilIso: string;
      readonly reason: string;
    }
  | {
      readonly action: "refuse";
      readonly window: QuotaWindowName;
      readonly resetsAt: string;
      readonly reason: string;
    };

export interface QuotaGateOptions {
  readonly nowIso: string;
  readonly onQuota?: OnQuota;
  /** Per-window step-cost override (a caller that knows better than the history). */
  readonly estimate?: Partial<Record<QuotaWindowName, number>>;
  readonly maxWaitMs?: number;
}

/**
 * What a step of this executor tends to spend of a window: the mean of the row's history, else
 * the default. A seven-day window is ~34 five-hour windows, so its default is scaled the same way.
 */
export function estimateStepSpend(row: QuotaRow | undefined, window: QuotaWindowName): number {
  const samples = (row?.history ?? []).flatMap((entry) => {
    const spent = entry.spent[window];
    return typeof spent === "number" ? [spent] : [];
  });
  if (samples.length === 0)
    return window === "five_hour" ? DEFAULT_STEP_SPEND : DEFAULT_STEP_SPEND / 34;
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

const pct = (value: number): string => `${Math.round(value * 100)}%`;
const WINDOW_LABEL: Record<QuotaWindowName, string> = { five_hour: "5h", seven_day: "7d" };

/** `decide`: proceed | wait until the window resets | refuse, from the row and the clock. */
export function decide(row: QuotaRow | undefined, options: QuotaGateOptions): QuotaDecision {
  if (!row) return { action: "proceed" };
  const onQuota = options.onQuota ?? "fail";
  const ceiling = onQuota === "wait" ? WAIT_CEILING : FAIL_CEILING;
  const nowMs = new Date(options.nowIso).getTime();
  for (const name of QUOTA_WINDOW_NAMES) {
    const window = row.windows[name];
    if (!window) continue;
    const resetMs = new Date(window.resetsAt).getTime();
    // The observation predates the window's reset: whatever it said is gone, and there is no
    // newer report. Proceed — the next run's first event rewrites the row.
    if (!(resetMs > nowMs)) continue;
    const estimate = options.estimate?.[name] ?? estimateStepSpend(row, name);
    const rejected = row.status === "rejected" && window.utilization >= 1;
    const projected = window.utilization + estimate;
    if (!rejected && projected <= ceiling) continue;
    const reason = rejected
      ? `${row.executor} is rate-limited (${WINDOW_LABEL[name]} window exhausted, observed ${row.observedAt} by ${row.runId}); resets ${window.resetsAt}`
      : `${row.executor}'s ${WINDOW_LABEL[name]} window is at ${pct(window.utilization)} and a step costs ~${pct(estimate)} (ceiling ${pct(ceiling)}, observed ${row.observedAt} by ${row.runId}); resets ${window.resetsAt}`;
    const waitMs = resetMs + RESET_SLACK_MS - nowMs;
    if (onQuota === "wait" && waitMs <= (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)) {
      return {
        action: "wait",
        window: name,
        untilIso: new Date(resetMs + RESET_SLACK_MS).toISOString(),
        reason,
      };
    }
    return { action: "refuse", window: name, resetsAt: window.resetsAt, reason };
  }
  return { action: "proceed" };
}

/** The refusal, worded for a terminal: the reason plus every way past it. */
export function quotaRefusalMessage(
  decision: Extract<QuotaDecision, { action: "refuse" }>,
): string {
  return (
    `quota: ${decision.reason} — ` +
    `wait for the reset (--on-quota wait, or --at ${decision.resetsAt}), fire another executor ` +
    `(--agent codex), or override with --ignore-quota`
  );
}

/**
 * Fold a run's report into the executor's row. The window state is REPLACED (the report is
 * newer, by construction), the history is UPSERTED by run id — a live write early in a run and
 * its final write are the same entry, so a long run never counts twice and a killed one keeps
 * what it actually spent — and capped at the newest QUOTA_HISTORY_LIMIT entries.
 */
export function foldQuotaRow(
  prev: QuotaRow | undefined,
  executor: string,
  report: QuotaReport,
  runId: string,
  nowIso: string,
): QuotaRow {
  const entry: QuotaHistoryEntry = { runId, observedAt: report.observedAt, spent: report.spent };
  const history = [...(prev?.history ?? []).filter((e) => e.runId !== runId), entry].slice(
    -QUOTA_HISTORY_LIMIT,
  );
  return {
    executor,
    status: report.status,
    windows: { ...(prev?.windows ?? {}), ...report.windows },
    observedAt: report.observedAt,
    runId,
    history,
    updatedAt: nowIso,
  };
}

/**
 * When a usage-limited run's fence should lift: the exhausted window's reset (plus slack), read
 * off the run's own report. `undefined` when the report names no future reset — the fence then
 * falls back to its fixed duration, as before quota was observed at all.
 */
export function fenceUntilFrom(
  report: QuotaReport | undefined,
  nowIso: string,
): string | undefined {
  if (!report) return undefined;
  const nowMs = new Date(nowIso).getTime();
  const candidates = QUOTA_WINDOW_NAMES.flatMap((name) => {
    const window = report.windows[name];
    if (!window) return [];
    const resetMs = new Date(window.resetsAt).getTime();
    // The exhausted window is the one to wait for; a merely-warm one says nothing about the limit.
    return window.utilization >= 1 && resetMs > nowMs ? [resetMs] : [];
  });
  if (candidates.length === 0) return undefined;
  return new Date(Math.min(...candidates) + RESET_SLACK_MS).toISOString();
}
