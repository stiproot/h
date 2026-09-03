import { Schema } from "effect";

/**
 * The `quota:` registry — one row per EXECUTOR (`quota:claude`), holding the account's rate-limit
 * windows as LAST OBSERVED by a run of that executor. An OBSERVATION, deliberately distinct from
 * the `exec:` POLICY row: `exec:` says what may run (an operator's deny, a fence), `quota:` says
 * what the provider reported. The pre-fire gate reads both — the policy first, then this row to
 * refuse (or wait out) a fire that would die mid-step for want of headroom.
 *
 * The observation is parsed once, in agent-cli (`quota.ts`, off the CLI's `rate_limit_event`s),
 * and rides the run ledger (`summary.json`, the `run:` mirror) to whichever HOST writes this row:
 * the local runtime's agent adapter as the run goes (live, so a driver's `h agents list --local`
 * sees the window climb), and the watcher at finalization on the service substrate. The shapes
 * are structurally identical on purpose — agent-cli is a leaf package and cannot import this one,
 * so the seam that type-checks them against each other is the host that holds both.
 *
 * `history` is what the ESTIMATE feeds on: the last N runs' own consumption per window
 * (`spent` = last − first utilization of the run). A step "like the last ten" is the best guess
 * available for what the next one costs; with no history the gate assumes DEFAULT_STEP_SPEND.
 */
export const QUOTA_PREFIX = "quota:";
export const quotaKey = (executor: string): string => `${QUOTA_PREFIX}${executor}`;
export const QUOTA_HISTORY_LIMIT = 20;

export const QuotaWindowName = Schema.Literal("five_hour", "seven_day");
export type QuotaWindowName = Schema.Schema.Type<typeof QuotaWindowName>;
export const QUOTA_WINDOW_NAMES: readonly QuotaWindowName[] = ["five_hour", "seven_day"];

export const QuotaWindow = Schema.Struct({
  utilization: Schema.Number,
  resetsAt: Schema.String,
});
export type QuotaWindow = Schema.Schema.Type<typeof QuotaWindow>;

export const QuotaStatus = Schema.Literal("allowed", "allowed_warning", "rejected");
export type QuotaStatus = Schema.Schema.Type<typeof QuotaStatus>;

const Windows = Schema.Struct({
  five_hour: Schema.optional(QuotaWindow),
  seven_day: Schema.optional(QuotaWindow),
});
const Spent = Schema.Struct({
  five_hour: Schema.optional(Schema.Number),
  seven_day: Schema.optional(Schema.Number),
});

/** What one run reported — the ledger's `quota` field, agent-cli's `QuotaReport` by another name. */
export const QuotaReport = Schema.Struct({
  status: QuotaStatus,
  windows: Windows,
  observedAt: Schema.String,
  spent: Spent,
});
export type QuotaReport = Schema.Schema.Type<typeof QuotaReport>;

export const QuotaHistoryEntry = Schema.Struct({
  runId: Schema.String,
  observedAt: Schema.String,
  spent: Spent,
});
export type QuotaHistoryEntry = Schema.Schema.Type<typeof QuotaHistoryEntry>;

export const QuotaRow = Schema.Struct({
  executor: Schema.String,
  status: QuotaStatus,
  windows: Windows,
  observedAt: Schema.String,
  /** The run whose observation this is — the join key back to the ledger. */
  runId: Schema.String,
  history: Schema.Array(QuotaHistoryEntry),
  updatedAt: Schema.String,
});
export type QuotaRow = Schema.Schema.Type<typeof QuotaRow>;

/** What a step is assumed to spend of the five-hour window when the row has no history yet. */
export const DEFAULT_STEP_SPEND = 0.1;

/**
 * How a fire treats the executor's rate-limit headroom (`quota:<executor>`, what the CLI last
 * reported) BEFORE each agent step. `onQuota: "fail"` refuses a step that would not fit the
 * window; `"wait"` defers it past the window's reset instead (the local driver sleeps between
 * steps; the service watcher arms a same-identity continuation); `ignore` skips the gate for an
 * operator who knows better. Absent ⇒ fail. Rides the fire descriptor (`Trigger.quota`), so a
 * saved key, an inline body, a chain member and a sched continuation all carry it the same way.
 */
export const QuotaGate = Schema.Struct({
  onQuota: Schema.Literal("fail", "wait"),
  ignore: Schema.optional(Schema.Boolean),
});
export type QuotaGate = Schema.Schema.Type<typeof QuotaGate>;
