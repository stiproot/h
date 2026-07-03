import { Schema } from "effect";

/**
 * Wire contracts as Schema.Structs with same-name derived types (the `core` pattern).
 * Decode untrusted bodies with `Schema.decodeUnknown`; where the wire has always passed
 * extra fields through (a run request's payload, a stored workflow read back from the
 * state store), decode with `onExcessProperty: "preserve"` so nothing is stripped.
 */

export const StepDefinition = Schema.Struct({
  id: Schema.optional(Schema.String),
  activity: Schema.String,
  // Optional on the wire: a step with no input has always worked (the workflow spreads it).
  input: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type StepDefinition = Schema.Schema.Type<typeof StepDefinition>;

export const WorkflowRequest = Schema.Struct({
  steps: Schema.Array(StepDefinition),
  // Caller-chosen Dapr instance id. When set, the run uses it instead of a generated GUID, so the
  // instance id — and therefore the per-run worktree/workspace key — is stable and readable. Starting
  // a run with an id that already exists reuses that instance rather than creating a duplicate.
  instanceId: Schema.optional(Schema.String),
  // Stable workspace key. When set, every step targets the same reusable agent workspace dir
  // instead of one keyed on the per-run workflow instance id.
  workspaceId: Schema.optional(Schema.String),
  // W3C traceparent captured when the run was requested, carried as data so activities can
  // re-attach to the originating trace across the workflow's async/replay boundary.
  traceparent: Schema.optional(Schema.String),
});
export type WorkflowRequest = Schema.Schema.Type<typeof WorkflowRequest>;

export const SaveWorkflowRequest = Schema.Struct({
  key: Schema.String,
  steps: Schema.Array(StepDefinition),
  workspaceId: Schema.optional(Schema.String),
  // Standard cron expression. When set, workflow-svc fires this saved workflow on its schedule.
  schedule: Schema.optional(Schema.String),
  // When true, the scheduler skips this workflow — a way to pause a schedule without deleting it.
  disabled: Schema.optional(Schema.Boolean),
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
  steps: Schema.Array(StepDefinition),
  workspaceId: Schema.optional(Schema.String),
  schedule: Schema.optional(WorkflowSchedule),
  // When true, the scheduler skips this workflow — a way to pause a schedule without deleting it.
  disabled: Schema.optional(Schema.Boolean),
});
export type StoredWorkflow = Schema.Schema.Type<typeof StoredWorkflow>;

// Projects a stored workflow into the run-time request handed to the invoker.
export function toRequest(stored: StoredWorkflow, traceparent?: string): WorkflowRequest {
  return { steps: stored.steps, workspaceId: stored.workspaceId, traceparent };
}

export type AgentResult = {
  sessionId: string | null;
  output: string;
  workspacePath?: string;
};

export type WorkflowStatus = {
  instanceId: string;
  runtimeStatus: string;
  output?: string;
};

/** @deprecated use AgentResult */
export type ClaudeResult = AgentResult;
