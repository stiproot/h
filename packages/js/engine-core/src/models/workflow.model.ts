import { Schema } from "effect";
import { WorkflowParams, WorkflowStep } from "workflow-core";

import { WatchPolicy } from "./watch.model.ts";
import { QuotaGate } from "./quota.model.ts";
import { WfIdentity } from "./wf.model.ts";

/**
 * Wire contracts as Schema.Structs with same-name derived types (the `core` pattern).
 * Decode untrusted bodies with `Schema.decodeUnknown`; where the wire has always passed
 * extra fields through (a run request's payload, a stored workflow read back from the
 * state store), decode with `onExcessProperty: "preserve"` so nothing is stripped.
 *
 * The DEFINITION shapes (params, steps, parallel groups, the agent result) live in
 * `workflow-core`, shared with the direct execution substrate so a definition composed by `h`
 * means the same thing to both executors. What stays here is substrate machinery: the fire
 * descriptor, the run request, the saved/stored workflow and its schedule — all of which only
 * mean something where there is a durable engine to fire into. Re-exported below so this module
 * remains workflow-svc's single model surface.
 */
export { ParallelGroup, StepDefinition, WorkflowParams, WorkflowStep } from "workflow-core";
export type { AgentResult } from "workflow-core";

/**
 * The fire descriptor — a trigger's PAYLOAD ("triggers are data", the glossary's Trigger grown to
 * its data half): ONE shape for "fire this workflow, supervised like this", embedded identically by
 * every fire carrier. The run request (standalone fires) and the chain member (fire deferred to
 * stage advance) EMBED these fields; the discovery cron's row (per discovered issue) and the sched
 * row's resubmit (at fireAt) PROJECT one per fire. Carriers add their own decorations — sequencing
 * on a member, fire-time mechanics on a request — the core stays this.
 */
export const TriggerFields = {
  // What to fire — a saved-workflow key the carrier's fire path resolves… (exactly one of
  // key/steps; each carrier enforces the XOR where it registers/decodes)
  key: Schema.optional(Schema.String),
  // …or embedded steps fired verbatim.
  steps: Schema.optional(Schema.Array(WorkflowStep)),
  // Named parameters resolved into step inputs as {{params.x}} / {"$ref": "params.x"}.
  params: Schema.optional(WorkflowParams),
  // The Dapr instance id — required-or-DERIVED, never Dapr-minted: the caller's id wins; absent,
  // the fire choke point derives a readable `<key>-<yymmdd>-<hhmmss>` (loud `-N` collision
  // suffix), so mark-before-fire holds universally and every run is human-addressable (workspace
  // dir, run ledger, traces). Firing an id that already exists reuses that instance.
  instanceId: Schema.optional(Schema.String),
  // Stable workspace key. When set, every step targets the same reusable agent workspace dir
  // instead of one keyed on the per-run workflow instance id.
  workspaceId: Schema.optional(Schema.String),
  // Watcher registration: when set, the fire path writes a
  // durable watch:sub:<instanceId> row in the same handler that schedules — supervision is
  // decoupled from the caller, never from the invocation. Whoever fires, carries: the policy
  // rides the carrier and is stripped at the choke point, never workflow input.
  watch: Schema.optional(WatchPolicy),
  // The quota gate for this fire (see QuotaGate): the generic workflow stamps it onto every
  // `run-*` step's input, where the activity-registry gate reads it. Absent ⇒ fail-on-hot.
  quota: Schema.optional(QuotaGate),
} as const;
export const Trigger = Schema.Struct(TriggerFields);
export type Trigger = Schema.Schema.Type<typeof Trigger>;

export const WorkflowRequest = Schema.Struct({
  // The embedded fire descriptor. This is the post-resolution carrier — the run routes resolve a
  // saved key to its steps before invoking — so `steps` narrows to REQUIRED here and `key` rides
  // only as provenance (the derivation base for a derived instanceId; stripped at the fire choke
  // point, never handed to the workflow runtime).
  ...TriggerFields,
  steps: Schema.Array(WorkflowStep),
  // W3C traceparent captured when the run was requested, carried as data so activities can
  // re-attach to the originating trace across the workflow's async/replay boundary.
  traceparent: Schema.optional(Schema.String),
  // Opt-in re-run of a TERMINAL instance under the same instanceId: purge its state, then
  // schedule fresh. Default (absent/false) is attach — an existing terminal instance is
  // returned as-is (Dapr durability is the standard; purge-and-rerun was a test-flow
  // convenience and must be asked for). RUNNING/PENDING instances are always reused.
  fresh: Schema.optional(Schema.Boolean),
  // Opaque passthrough stamped onto the watch row for row consumers (e.g. {owner: "discover"}).
  watchMeta: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  // Registry identity: when set, generic.workflow
  // brackets its steps with the write-wf-row activity so the run writes its OWN status row at
  // `wf:<repo>:<slug>:<workflow>` (running before, done/failed after). Opt-in — absent means no row.
  wf: Schema.optional(WfIdentity),
  // --cron recur registration (§10): when set, generic.workflow arms a recur cron in its CLOSING
  // bracket (after the work) via the register-cron activity — the run registers its OWN recurrence,
  // idempotently, instead of the fire handler doing it. `workflow` is the saved key to re-fire; repo/
  // slug/params/instanceId come from the run's own input at arm time. (ArmCron's `budget` is inlined
  // rather than reusing cron.model's CronBudget to avoid a cron.model↔workflow.model import cycle.)
  //
  // `inline`: recur an EMBEDDED source built from the
  // run's OWN steps instead of the saved `workflow` key — for an inline-composed run with nothing
  // published to re-hydrate. generic.workflow forwards `input.steps` + `workspaceId` to register-cron,
  // which builds a `{mode:"embedded"}` source. `workflow` stays the wf-identity workflow name (the cron
  // key coord), it is just not used as a store key.
  armCron: Schema.optional(
    Schema.Struct({
      cadence: Schema.String,
      workflow: Schema.String,
      budget: Schema.optional(Schema.Struct({ maxFires: Schema.Number })),
      inline: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type WorkflowRequest = Schema.Schema.Type<typeof WorkflowRequest>;

export const SaveWorkflowRequest = Schema.Struct({
  key: Schema.String,
  steps: Schema.Array(WorkflowStep),
  workspaceId: Schema.optional(Schema.String),
  // Standard cron expression. When set, workflow-svc fires this saved workflow on its schedule.
  schedule: Schema.optional(Schema.String),
  // When true, the scheduler skips this workflow — a way to pause a schedule without deleting it.
  disabled: Schema.optional(Schema.Boolean),
  // Default parameter values for this saved workflow (a "template"); fire-time params override
  // these key-by-key.
  params: Schema.optional(WorkflowParams),
  // Stored watch policy: every fire of this saved workflow (HTTP, trigger event, cron tick)
  // registers a watch row — how trigger- and cron-fired runs gain supervision (agreement 9).
  watch: Schema.optional(WatchPolicy),
  // Declared output schema: the structured
  // summary this workflow promises — the workflow's typed output signature. Top-level so chain
  // registration can validate capture/input mappings against it via get. Enforcement happens at
  // the step that carries the matching outputContract input, not here.
  outputs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type SaveWorkflowRequest = Schema.Schema.Type<typeof SaveWorkflowRequest>;

export const WorkflowSchedule = Schema.Struct({
  // Standard 5-field cron expression (evaluated in UTC).
  cron: Schema.String,
  // ISO timestamp the schedule was last saved; the baseline for the first fire before any run.
  savedAt: Schema.String,
  // ISO timestamp of the last tick that triggered this workflow.
  lastRunAt: Schema.optional(Schema.String),
});
export type WorkflowSchedule = Schema.Schema.Type<typeof WorkflowSchedule>;

// The persisted representation of a saved workflow: its definition plus optional schedule state.
// Distinct from WorkflowRequest, which is the shape handed to the workflow runtime on invoke.
export const StoredWorkflow = Schema.Struct({
  steps: Schema.Array(WorkflowStep),
  workspaceId: Schema.optional(Schema.String),
  schedule: Schema.optional(WorkflowSchedule),
  // When true, the scheduler skips this workflow — a way to pause a schedule without deleting it.
  disabled: Schema.optional(Schema.Boolean),
  // Default parameter values; fire-time params override key-by-key (see toRequest).
  params: Schema.optional(WorkflowParams),
  // Stored watch policy applied on every fire path (see SaveWorkflowRequest.watch).
  watch: Schema.optional(WatchPolicy),
  // Declared output schema — the saved workflow's typed output signature (see SaveWorkflowRequest.outputs).
  outputs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type StoredWorkflow = Schema.Schema.Type<typeof StoredWorkflow>;

// Projects a stored workflow into the run-time request handed to the invoker. Fire-time params
// merge over the stored defaults key-by-key, so a template can ship defaults and a caller can
// override just the slots it cares about.
export function toRequest(
  stored: StoredWorkflow,
  traceparent?: string,
  params?: WorkflowParams,
): WorkflowRequest {
  const merged = stored.params || params ? { ...stored.params, ...params } : undefined;
  return { steps: stored.steps, workspaceId: stored.workspaceId, traceparent, params: merged };
}

/**
 * The derived instance id for a fire whose caller chose none: `<base>-<yymmdd>-<hhmmss>` (UTC),
 * base = the saved key (else the wf-identity workflow name, else "run"), sanitized to id-safe
 * chars. Readable and collision-poor by construction; the fire choke point resolves an actual
 * collision with a loud `-N` suffix rather than falling back to a Dapr-minted UUID — that weak
 * form (invoke first, register the watch after) is dead: mark-before-fire holds universally.
 */
export function deriveInstanceId(base: string, nowMs: number): string {
  const safe = (base || "run").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  const iso = new Date(nowMs).toISOString(); // 2026-07-31T09:05:42.123Z
  const stamp = `${iso.slice(2, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
  return `${safe}-${stamp}`;
}

export type WorkflowStatus = {
  instanceId: string;
  runtimeStatus: string;
  output?: string;
};
