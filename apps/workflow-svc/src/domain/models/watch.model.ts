import { Schema } from "effect";

/**
 * The watcher primitive's data shapes (docs/plans/watcher-primitive.md): a watch is a durable
 * registration — a `watch:sub:<instanceId>` row — that the scan engine reads on the cron tick,
 * interprets against the row's typed policy, and acts on through a closed vocabulary. This is
 * deliberately NOT a rules DSL (ruling W3): the policy is a fixed struct, and every behavior
 * (budget-terminate, retry, escalate, cost tally) is engine code, never config-expressed logic.
 *
 * This module is import-free by design: `workflow.model.ts` imports `WatchPolicy` for the
 * request/save/stored schemas, so nothing here may import back. The `resubmit` steps are
 * `Unknown` for the same reason — they were Schema-validated at original fire time and are
 * only ever round-tripped back into the invoker.
 */

export const WatchOutcome = Schema.Literal(
  "completed",
  "failed",
  "terminated",
  "budget-terminated",
  "orphaned",
);
export type WatchOutcome = Schema.Schema.Type<typeof WatchOutcome>;

// Generic retry, engine-owned (Decision 3): on a matching terminal outcome, re-fire the stored
// resubmit under the same instanceId. `fresh` defaults to true — a terminal instance must purge
// to re-run; attach would silently no-op the retry (h-builds-h Decision 1).
export const WatchRetryPolicy = Schema.Struct({
  maxAttempts: Schema.Number,
  fresh: Schema.optional(Schema.Boolean),
  // Outcomes that trigger a retry. Default: ["failed"].
  onOutcome: Schema.optional(Schema.Array(WatchOutcome)),
});
export type WatchRetryPolicy = Schema.Schema.Type<typeof WatchRetryPolicy>;

// The ONLY judgment hook (agreement 6): fire a published saved-workflow family with the
// watcher's facts merged into params. Gated fail-closed on the daily engine-fire cap (§6).
export const WatchEscalatePolicy = Schema.Struct({
  onOutcome: Schema.Array(WatchOutcome),
  key: Schema.String,
  params: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type WatchEscalatePolicy = Schema.Schema.Type<typeof WatchEscalatePolicy>;

export const WatchPolicy = Schema.Struct({
  // The only mandatory knob: wall-clock budget; on breach the instance is terminated.
  maxDurationMs: Schema.Number,
  // Ticks of consecutive UNKNOWN before the watch finalizes as orphaned. Default 6.
  unknownStreakLimit: Schema.optional(Schema.Number),
  retry: Schema.optional(WatchRetryPolicy),
  escalate: Schema.optional(WatchEscalatePolicy),
});
export type WatchPolicy = Schema.Schema.Type<typeof WatchPolicy>;

// What the engine re-fires on retry: the resolved run request minus identity/trace fields.
// Steps are Unknown here (validated at original fire time; see module doc).
export const WatchResubmit = Schema.Struct({
  steps: Schema.optional(Schema.Array(Schema.Unknown)),
  params: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  workspaceId: Schema.optional(Schema.String),
});
export type WatchResubmit = Schema.Schema.Type<typeof WatchResubmit>;

export const WatchStatus = Schema.Literal("scheduling", "watching", "finalized");
export type WatchStatus = Schema.Schema.Type<typeof WatchStatus>;

/**
 * The persisted watch row (`watch:sub:<instanceId>`), written only by workflow-svc — its fire
 * paths (registration, epoch bumps) and the scan engine. Single-writer per key is structural
 * (Decision 3): no other service ever writes `watch:*`.
 *
 * `epoch` is the W5 fence: bumped on every (re)schedule of this instanceId — including
 * `fresh` re-fires without a watch field — so an engine action computed against an older
 * incarnation re-reads the row and no-ops when its in-hand epoch is stale.
 */
export const WatchRow = Schema.Struct({
  instanceId: Schema.String,
  epoch: Schema.Number,
  // Engine-owned monotonic fire count for this row (initial fire = 1; each retry/re-fire +1).
  attempts: Schema.Number,
  // Absolute deadline base (agreement 3): budget breaches slept through an outage are enforced
  // on the first scan after recovery.
  startedAt: Schema.String,
  policy: WatchPolicy,
  resubmit: Schema.optional(WatchResubmit),
  status: WatchStatus,
  lastStatus: Schema.String,
  unknownStreak: Schema.Number,
  outcome: Schema.optional(WatchOutcome),
  // Summed from run:<instanceId>:* mirrors at finalize. Zero matching records is NEVER a
  // silent $0: costGap flags it (the sweep's LEDGER GAP semantics, now code).
  costUsd: Schema.optional(Schema.Number),
  costGap: Schema.optional(Schema.Boolean),
  // Short engine note for humans (e.g. why a retry was abandoned). Not config.
  note: Schema.optional(Schema.String),
  // Opaque caller passthrough for row consumers (e.g. the sweep's {owner: issue-sweep}).
  meta: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  updatedAt: Schema.String,
  endedAt: Schema.optional(Schema.String),
});
export type WatchRow = Schema.Schema.Type<typeof WatchRow>;

// watch:config — the layered kill switch's first layer. Absent config means ENABLED: the
// engine is core machinery, and requiring a seed key to arm supervision would be the silent
// disarm failure mode ruling W1 exists to kill. Disarm is an explicit {enabled: false}.
// `maxEngineFiresPerDay` gates ESCALATIONS fail-closed (absent → escalations never fire);
// retries are bounded by their own maxAttempts and are not gated on config.
export const WatchConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  maxEngineFiresPerDay: Schema.optional(Schema.Number),
});
export type WatchConfig = Schema.Schema.Type<typeof WatchConfig>;

// watch:ledger:<yyyy-mm-dd> — engine-written daily tallies. `runsFired` counts every watched
// incarnation fired (registration or engine re-fire); `engineFires` counts only fires the
// ENGINE initiated (retries + escalations); `costUsd` accumulates at finalize. The sweep's
// gate B reads this key instead of maintaining its own (Decision 3).
export const WatchLedger = Schema.Struct({
  runsFired: Schema.Number,
  runsFinalized: Schema.Number,
  engineFires: Schema.Number,
  costUsd: Schema.Number,
});
export type WatchLedger = Schema.Schema.Type<typeof WatchLedger>;

export const emptyLedger: WatchLedger = {
  runsFired: 0,
  runsFinalized: 0,
  engineFires: 0,
  costUsd: 0,
};

// watch:__tick__ — the scan heartbeat. `enabled: false` distinguishes a deliberate disarm
// from a dead engine, so a staleness check (the sweep's guard) can tell the two apart.
export const WatchHeartbeat = Schema.Struct({
  at: Schema.String,
  enabled: Schema.Boolean,
});
export type WatchHeartbeat = Schema.Schema.Type<typeof WatchHeartbeat>;

/** UTC day key for the ledger, e.g. "2026-07-05". */
export function ledgerDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export const DEFAULT_UNKNOWN_STREAK_LIMIT = 6;
