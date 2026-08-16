import { Schema } from "effect";

import { WfIdentity } from "./wf.model.ts";
import { TriggerFields } from "./workflow.model.ts";

/**
 * The SCHEDULED-FIRE cron's data shapes — the THIRD variant of
 * the cron siblings, sibling of the recur cron (cron.model.ts) and the discovery cron
 * (discover.model.ts). Where a recur cron RE-FIRES one workflow on a cadence until its goal resolves,
 * and a discovery cron FANS OUT one fire per newly-seen source item, a scheduled-fire row fires ONE
 * workflow exactly ONCE at an absolute time (`fireAt`), then it is done. It has no cadence, no
 * `maxFires` budget, no `resolved` handshake, and no in-flight guard — deliberately none of the
 * recurring row's machinery; the one essence is "fire this trigger once, when the clock reaches
 * fireAt."
 *
 * Same registry group (`cron:*`), same tick, same config/heartbeat/ledger; a DISTINCT row shape under
 * `cron:sched:<id>`. Single-writer: workflow-svc. It is the shared spine for three consumers —
 * schedule-at-a-time (Feature 3, `origin:"at"`), pause/resume (Feature 2, `origin:"pause"`), and the
 * usage-limit fallback (Feature 1, `origin:"fallback:usage-limited"`).
 */

// armed = waiting for fireAt; the three terminal states name WHY it stopped arming.
export const SchedStatus = Schema.Literal("armed", "fired", "expired", "disarmed");
export type SchedStatus = Schema.Schema.Type<typeof SchedStatus>;

// fired = the one-shot fired; expired = notAfter passed before fireAt was reached (never fired);
// disarmed = operator/engine cancellation. Closed literal so an unknown outcome fails validation.
export const SchedOutcome = Schema.Literal("fired", "expired", "disarmed");
export type SchedOutcome = Schema.Schema.Type<typeof SchedOutcome>;

/**
 * The fire descriptor a sched row carries — its resubmit IS a Trigger, with the instance REQUIRED:
 * a row persists post-derivation, so the fire moment never derives an id. `key`|`steps` selects a
 * saved definition or the embedded continuation steps; `params` carries the fire-time identity
 * override (runActivity/agentId/model*, resolved by generic.workflow.ts exactly as a normal run) +
 * any continuation payload; `workspaceId` is the workspace to REUSE (pause/resume + the usage-limit
 * fallback run in the SAME worktree/state as the paused/limited run); `watch` supervises the fired
 * continuation.
 */
export const SchedTrigger = Schema.Struct({ ...TriggerFields, instanceId: Schema.String });
export type SchedTrigger = Schema.Schema.Type<typeof SchedTrigger>;

/**
 * The persisted scheduled-fire row (`cron:sched:<id>`), written ONLY by workflow-svc — its arm path
 * (the run route / the watcher's fallback action) and the scan engine. `epoch` fences overlapping
 * ticks (bumped on fire/disarm). The row is scheduling coordinates (when) around an embedded fire
 * descriptor (what).
 */
export const SchedRow = Schema.Struct({
  // Store id (index/key suffix); also the default fire instance (see SchedTrigger).
  id: Schema.String,
  status: SchedStatus,
  // Absolute ISO fire time — the engine fires once when now >= fireAt. The ONE structural difference
  // from the recur cron's cadence.
  fireAt: Schema.String,
  // Optional absolute deadline: if now passes notAfter before fireAt is reached, the row expires
  // WITHOUT firing (time-critical `--at`). Absent → a late fireAt still fires (self-healing).
  notAfter: Schema.optional(Schema.String),
  // The embedded fire descriptor — what fires at fireAt.
  trigger: SchedTrigger,
  // Epoch fence — bumped on fire/disarm so a stale scan decision no-ops.
  epoch: Schema.Number,
  // The wf-identity the fired run writes its own wf: row under (repo/slug/workflow). Optional.
  wf: Schema.optional(WfIdentity),
  // Why this row exists (observability): "at" | "pause" | "fallback:usage-limited".
  origin: Schema.optional(Schema.String),
  // Feature 1 fallback budget, carried across a fallback chain: a fallback continuation that also
  // limits arms another sched row with handoffsRemaining - 1; at 0 the chain stops (fail-closed).
  handoffsRemaining: Schema.optional(Schema.Number),
  // The instance the fire actually ran under (observability). Absent before firing.
  firedInstanceId: Schema.optional(Schema.String),
  outcome: Schema.optional(SchedOutcome),
  note: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  firedAt: Schema.optional(Schema.String),
});
export type SchedRow = Schema.Schema.Type<typeof SchedRow>;

/** The store id (index/key suffix) for a scheduled-fire row — the row carries its own `id`. */
export const schedId = (id: string): string => id;
