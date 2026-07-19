import { Schema } from "effect";

import { WorkflowParams, WorkflowStep } from "./workflow.model.ts";

/**
 * The cron primitive's data shapes (docs/plans/workflow-watcher-registry.md §5) — the THIRD sibling
 * of the watcher + chain build-pattern. A cron is a durable registration (`cron:sub:<repo>:<slug>:
 * <workflow>`) that the scan engine reads on the cron tick and, when due and its subject is neither
 * in-flight nor resolved, RE-INVOKES the workflow. Where a watch re-fires ONE instance on a failure
 * policy and a chain fires the NEXT workflow on advance, a cron RE-FIRES the SAME workflow on a clock
 * until the goal is met. Single-writer (workflow-svc), epoch-fenced — identical discipline to the
 * other two.
 *
 * The key coords mirror the `wf:` row this cron recurs: a cron on `revise` for stiproot/h·pi-agent is
 * `cron:sub:stiproot/h:pi-agent:revise`, recurring `wf:stiproot/h:pi-agent:revise` and reading THAT
 * row's `resolved` flag to know when to stop.
 */

// active = recurring on the clock; inactive = deactivated (goal resolved, budget exhausted, or disarmed).
// Closed literal so an unknown status fails validation.
export const CronStatus = Schema.Literal("active", "inactive");
export type CronStatus = Schema.Schema.Type<typeof CronStatus>;

// Why a cron deactivated (terminal note): resolved = the target wf: row reported goal-met;
// budget-exhausted = maxFires reached; disabled = kill switch / manual deactivation.
export const CronOutcome = Schema.Literal("resolved", "budget-exhausted", "disabled");
export type CronOutcome = Schema.Schema.Type<typeof CronOutcome>;

// Source mode 1 (§5): recur a PUBLISHED saved workflow by key with fixed params — many crons can share
// one definition, each with different params (no duplication).
export const CronSourceSaved = Schema.Struct({
  mode: Schema.Literal("saved"),
  key: Schema.String,
  params: Schema.optional(WorkflowParams),
});
export type CronSourceSaved = Schema.Schema.Type<typeof CronSourceSaved>;

// Source mode 2 (§5): recur an EMBEDDED hydrated definition as-is — no publish, no re-hydration. This is
// what lets an inline run (`h workflow run <template> -p … --inline --cron …`) recur with nothing saved
// separately (docs/plans/inline-chain-cron-composition.md D1). `steps` is the full WorkflowStep union
// (plain steps + parallel groups) so an inline-composed definition recurs verbatim.
export const CronSourceEmbedded = Schema.Struct({
  mode: Schema.Literal("embedded"),
  steps: Schema.Array(WorkflowStep),
  params: Schema.optional(WorkflowParams),
  workspaceId: Schema.optional(Schema.String),
});
export type CronSourceEmbedded = Schema.Schema.Type<typeof CronSourceEmbedded>;

// (Mode 3 "dynamic" — params derived fresh per tick from a param-source contract — is DEFERRED, so it
// is not in the union yet. Adding it is additive: a new struct + a scan branch, no shape churn here.)
export const CronSource = Schema.Union(CronSourceSaved, CronSourceEmbedded);
export type CronSource = Schema.Schema.Type<typeof CronSource>;

// Budget: a hard cap on the number of FIRES (invocations) — the runaway backstop AND the primary stop
// when a goal never resolves (e.g. a PR that is never merged). On reach → deactivate budget-exhausted.
export const CronBudget = Schema.Struct({
  maxFires: Schema.Number,
});
export type CronBudget = Schema.Schema.Type<typeof CronBudget>;

// The run-request shape that REGISTERS a cron (the `cron` field, sibling of `watch`): the cadence to
// recur on and an optional budget. workflow-svc turns it into a CronRow in the same handler that fires
// — the source (saved key or embedded steps) and identity come from the run itself, not from here.
export const CronPolicy = Schema.Struct({
  cadence: Schema.String,
  budget: Schema.optional(CronBudget),
});
export type CronPolicy = Schema.Schema.Type<typeof CronPolicy>;

/**
 * The persisted cron row (`cron:sub:<repo>:<slug>:<workflow>`), written ONLY by workflow-svc — its
 * registration fire path and the scan engine. `epoch` is the fence (bumped on every re-registration);
 * `fires` counts invocations against `budget.maxFires`. The engine reads the target `wf:` row's
 * `resolved` flag (goal handshake) and the live Dapr instance status (in-flight guard); it never
 * writes `wf:*`.
 */
export const CronRow = Schema.Struct({
  // Key coords — mirror the wf: row this cron recurs.
  repo: Schema.String,
  slug: Schema.String,
  workflow: Schema.String,
  status: CronStatus,
  // 5-field cron expression (UTC): a fire is due when isDue since lastRunAt (else createdAt).
  cadence: Schema.String,
  // What to re-fire each due tick.
  source: CronSource,
  // The runaway backstop / no-resolution stop.
  budget: CronBudget,
  // The FIXED Dapr instance id every fire recurs under (fresh re-run each tick) — set at registration.
  // Distinct from currentInstanceId: this is the target, that is the last one actually fired.
  instanceId: Schema.String,
  // Epoch fence — a re-registration bumps it so a stale scan decision no-ops.
  epoch: Schema.Number,
  // Fire counter (against budget.maxFires).
  fires: Schema.Number,
  // The instance the LAST fire ran under; the in-flight guard reads its live status. Absent before the
  // first fire (a never-fired cron is not in flight, so the first due tick fires).
  currentInstanceId: Schema.optional(Schema.String),
  lastRunAt: Schema.optional(Schema.String),
  lastStatus: Schema.optional(Schema.String),
  outcome: Schema.optional(CronOutcome),
  note: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  endedAt: Schema.optional(Schema.String),
});
export type CronRow = Schema.Schema.Type<typeof CronRow>;

/** The store id (index/key suffix) for a cron: the coord tuple, mirroring the wf: coords. */
export const cronId = (id: { repo: string; slug: string; workflow: string }): string =>
  `${id.repo}:${id.slug}:${id.workflow}`;

// The pub/sub topic a finalizing chain publishes disarm requests to (docs/plans/
// inline-chain-cron-composition.md D6): payload is the recur cron's identity `{repo, slug, workflow}`.
// A LOOSE edge — the chain never writes cron:sub (D2); the subscriber (cron-scan's disarmEventEffect,
// wired in cron.router) stays the single writer, exactly like POST /cron/disarm.
export const CRON_DISARM_TOPIC = "cron-disarm";

// cron:config — the kill switch, same semantics as chain:config/watch:config: absent means ENABLED
// (arming must not require a seed key). `maxEngineFiresPerDay` caps the engine's fires fail-closed.
export const CronConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  maxEngineFiresPerDay: Schema.optional(Schema.Number),
});
export type CronConfig = Schema.Schema.Type<typeof CronConfig>;

// cron:__tick__ — the scan heartbeat; `enabled: false` distinguishes a deliberate disarm from a dead
// engine, exactly like chain:__tick__/watch:__tick__.
export const CronHeartbeat = Schema.Struct({
  at: Schema.String,
  enabled: Schema.Boolean,
});
export type CronHeartbeat = Schema.Schema.Type<typeof CronHeartbeat>;

// cron:ledger:<yyyy-mm-dd> — engine-written daily tallies (shared across the cron family: recur +
// discovery + scheduled-fire). `discoveryFires` is the fan-out cron's daily count (the backstop the
// `maxFiresPerDay` gate reads); `scheduledFires` is the one-shot `cron:sched:*` variant's daily count
// (observability + the fail-closed budget the watcher's fallback reads via maxEngineFiresPerDay).
export const CronLedger = Schema.Struct({
  cronsRegistered: Schema.Number,
  firesTriggered: Schema.Number,
  cronsDeactivated: Schema.Number,
  discoveryFires: Schema.optional(Schema.Number),
  scheduledFires: Schema.optional(Schema.Number),
});
export type CronLedger = Schema.Schema.Type<typeof CronLedger>;

export const emptyCronLedger: CronLedger = {
  cronsRegistered: 0,
  firesTriggered: 0,
  cronsDeactivated: 0,
  discoveryFires: 0,
  scheduledFires: 0,
};

/** UTC day key for the ledger, e.g. "2026-07-11". */
export function cronLedgerDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
