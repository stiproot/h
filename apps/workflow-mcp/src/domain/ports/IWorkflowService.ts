import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";
import type { WorkflowError } from "core";

/**
 * Wire shapes as Schema.Struct values whose derived types share the same name (the `core`
 * agent.ts pattern): decode untrusted tool args with `Schema.decodeUnknown(...)`, consume the
 * derived type everywhere else. `SaveWorkflowRequest` and `WorkflowRequest` double as the
 * `save_workflow` / `run_workflow` MCP tool inputs, so their field annotations carry the exact
 * descriptions the server publishes (a wire artifact the model reads — see mcp.router.ts).
 *
 * Decodes run with `onExcessProperty: "preserve"`: workflow-svc accepts fields beyond these
 * shapes (e.g. `workspaceId`/`schedule`/`disabled` on save, `workspaceId` on run) and this
 * service has always passed them through verbatim — a strict decode would silently strip them.
 */
export const StepDefinition = Schema.Struct({
  id: Schema.optional(Schema.String),
  activity: Schema.String,
  input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});
export type StepDefinition = Schema.Schema.Type<typeof StepDefinition>;

// Named workflow parameters, resolved into step inputs by workflow-svc's generic workflow as
// {{params.x}} placeholders / { "$ref": "params.x" } objects.
export const WorkflowParams = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export type WorkflowParams = Schema.Schema.Type<typeof WorkflowParams>;

const paramsAnnotation = {
  description:
    'Named parameters resolved into step inputs: reference them as {{params.x}} inside a string, or {"$ref": "params.x"} for a whole value.',
};

export const WorkflowRequest = Schema.Struct({
  steps: Schema.Array(StepDefinition).annotations({
    description: "Ordered list of step definitions",
  }),
  // Optional caller-chosen workflow instance id. When set, it becomes the Dapr instance id (and so
  // the per-run workspace/worktree key), giving the run a stable, readable name instead of a GUID.
  instanceId: Schema.optional(
    Schema.String.annotations({
      description:
        "Optional stable, readable workflow instance id (e.g. 'triage-ABC-123'). It becomes the run's worktree/workspace name. Re-running with the same id reuses the existing instance instead of starting a new one.",
    }),
  ),
  params: Schema.optional(WorkflowParams.annotations(paramsAnnotation)),
});
export type WorkflowRequest = Schema.Schema.Type<typeof WorkflowRequest>;

export const SaveWorkflowRequest = Schema.Struct({
  key: Schema.String.annotations({ description: "Unique identifier for the workflow" }),
  steps: Schema.Array(StepDefinition).annotations({
    description: "Ordered list of step definitions",
  }),
  params: Schema.optional(
    WorkflowParams.annotations({
      description:
        "Default parameter values for this saved workflow; run_saved_workflow params override them key-by-key.",
    }),
  ),
});
export type SaveWorkflowRequest = Schema.Schema.Type<typeof SaveWorkflowRequest>;

export const WorkflowStatus = Schema.Struct({
  instanceId: Schema.String,
  runtimeStatus: Schema.String,
  output: Schema.optional(Schema.String),
});
export type WorkflowStatus = Schema.Schema.Type<typeof WorkflowStatus>;

/**
 * The workflow-svc port. Failures are always `WorkflowError` (from `core` — it crosses the
 * TS-to-TS Dapr-invoke boundary); the raw HTTP/decode failure rides in its `cause`. Get-style
 * lookups that can miss return `Option` (404 → `Option.none`), keeping not-found out of the
 * error channel; `getStatus` keeps the legacy `runtimeStatus: "UNKNOWN"` fallback instead.
 */
export class WorkflowService extends Context.Tag("WorkflowService")<
  WorkflowService,
  {
    readonly save: (req: SaveWorkflowRequest) => Effect.Effect<{ key: string }, WorkflowError>;
    readonly run: (req: WorkflowRequest) => Effect.Effect<{ instanceId: string }, WorkflowError>;
    readonly runByKey: (
      key: string,
      params?: WorkflowParams,
      overrides?: { instanceId?: string; workspaceId?: string },
    ) => Effect.Effect<{ instanceId: string }, WorkflowError>;
    readonly list: () => Effect.Effect<{ keys: readonly string[] }, WorkflowError>;
    readonly getByKey: (
      key: string,
    ) => Effect.Effect<Option.Option<WorkflowRequest>, WorkflowError>;
    readonly getStatus: (instanceId: string) => Effect.Effect<WorkflowStatus, WorkflowError>;
    /** Requests termination of a running instance (maps to POST /workflow/terminate/:id). */
    readonly terminate: (
      instanceId: string,
    ) => Effect.Effect<{ instanceId: string }, WorkflowError>;
  }
>() {}
