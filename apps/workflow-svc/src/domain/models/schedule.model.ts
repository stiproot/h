import { Schema } from "effect";

import { CronSource } from "./cron.model.ts";
import { WatchPolicy } from "./watch.model.ts";
import { WfIdentity } from "./wf.model.ts";

/**
 * The SCHEDULED-FIRE cron's data shapes — the THIRD variant of
 * the cron siblings, sibling of the recur cron (cron.model.ts) and the discovery cron
 * (discover.model.ts). Where a recur cron RE-FIRES one workflow on a cadence until its goal resolves,
 * and a discovery cron FANS OUT one fire per newly-seen source item, a scheduled-fire row fires ONE
 * workflow exactly ONCE at an absolute time (`fireAt`), then it is done. It has no cadence, no
 * `maxFires` budget, no `resolved` handshake, and no in-flight guard — deliberately none of the
 * recurring row's machinery; the one essence is "fire this source under this instance once, when the
 * clock reaches fireAt."
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
 * The persisted scheduled-fire row (`cron:sched:<id>`), written ONLY by workflow-svc — its arm path
 * (the run route / the watcher's fallback action) and the scan engine. `epoch` fences overlapping
 * ticks (bumped on fire/disarm). The identity override for a fallback (a different agent/model) rides
 * as `source.params` (runActivity/agentId/model*), resolved by generic.workflow.ts exactly as a
 * normal run — no separate identity field.
 */
export const SchedRow = Schema.Struct({
  // Store id (index/key suffix); also the instance the fire runs under unless the caller pins one.
  id: Schema.String,
  status: SchedStatus,
  // Absolute ISO fire time — the engine fires once when now >= fireAt. The ONE structural difference
  // from the recur cron's cadence.
  fireAt: Schema.String,
  // Optional absolute deadline: if now passes notAfter before fireAt is reached, the row expires
  // WITHOUT firing (time-critical `--at`). Absent → a late fireAt still fires (self-healing).
  notAfter: Schema.optional(Schema.String),
  // What to fire (reuse the recur cron's saved|embedded union). `params` carries the fire-time
  // identity override + any continuation payload.
  source: CronSource,
  // The Dapr instance the fire runs under (a readable id; also the default workspace key).
  instanceId: Schema.String,
  // Optional workspace to REUSE on the fire (overrides the source-derived workspace). Set by
  // pause/resume and the usage-limit fallback so the continuation runs in the SAME worktree/state as
  // the paused/limited run (agents key their workspace on workspaceId ?? workflowInstanceId).
  workspaceId: Schema.optional(Schema.String),
  // Epoch fence — bumped on fire/disarm so a stale scan decision no-ops.
  epoch: Schema.Number,
  // Watch policy attached to the fired continuation (it lands a watch:sub row — every sched fire is
  // supervised). Optional — omit to fire unsupervised.
  watch: Schema.optional(WatchPolicy),
  // The wf-identity the fired run writes its own wf: row under (repo/slug/workflow). Optional.
  wf: Schema.optional(WfIdentity),
  // Why this row exists (observability): "at" | "pause" | "fallback:usage-limited".
  origin: Schema.optional(Schema.String),
  // Feature 1 fallback budget, carried across a fallback chain: a fallback continuation that also
  // limits arms another sched row with handoffsRemaining - 1; at 0 the chain stops (fail-closed).
  handoffsRemaining: Schema.optional(Schema.Number),
  // The instance the fire actually ran under (observability; equals instanceId unless the source pins
  // a different one). Absent before firing.
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
