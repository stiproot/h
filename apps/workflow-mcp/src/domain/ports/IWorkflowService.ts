import type { WorkflowError } from "core";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";
import { WorkflowParams, WorkflowStep } from "workflow-core";

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
// The definition shapes come from `workflow-core`, the one home every executor reads them from —
// the same reasoning `WatchPolicyInput` below states for the watch policy, applied to the shapes
// this wire is actually made of. They had drifted while duplicated here: `input` was REQUIRED
// (so a step without one was rejected by these tools but accepted by workflow-svc), and `steps`
// admitted only plain steps, which silently made every PARALLEL GROUP — i.e. every panel —
// unsaveable and unrunnable through this MCP.
export { StepDefinition, WorkflowParams, WorkflowStep } from "workflow-core";

const paramsAnnotation = {
  description:
    'Named parameters resolved into step inputs: reference them as {{params.x}} inside a string, or {"$ref": "params.x"} for a whole value.',
};

const watchAnnotation = {
  description:
    'Optional watcher policy: workflow-svc registers a durable watch on the run (budget-terminate, retry, terminal workflow-events). Shape: {"maxDurationMs": number, "retry": {"maxAttempts": number, "fresh": boolean}}. A saved workflow may carry a stored policy; this overrides it.',
};

// Loosely typed on this wire (a record, not a struct): workflow-svc Schema-validates the
// policy at its own boundary, and duplicating the full WatchPolicy struct here would drift.
export const WatchPolicyInput = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export type WatchPolicyInput = Schema.Schema.Type<typeof WatchPolicyInput>;

export const WorkflowRequest = Schema.Struct({
  steps: Schema.Array(WorkflowStep).annotations({
    description:
      "Ordered list of steps. A step is {id?, activity, input?}; a PARALLEL GROUP is " +
      "{id?, parallel: [step, …]}, whose branches run concurrently and cannot reference each other.",
  }),
  // Optional caller-chosen workflow instance id. When set, it becomes the Dapr instance id (and so
  // the per-run workspace/worktree key), giving the run a stable, readable name instead of a GUID.
  instanceId: Schema.optional(
    Schema.String.annotations({
      description:
        "Optional stable, readable workflow instance id (e.g. 'triage-ABC-123'). It becomes the run's worktree/workspace name. Re-running with the same id attaches to the existing instance (running or finished) instead of starting a new one; pass fresh=true to purge a finished instance and re-run.",
    }),
  ),
  params: Schema.optional(WorkflowParams.annotations(paramsAnnotation)),
  fresh: Schema.optional(
    Schema.Boolean.annotations({
      description:
        "Opt-in re-run: purge a FINISHED instance under the given instanceId and run it again. Default (false) attaches to the existing instance without re-running.",
    }),
  ),
  watch: Schema.optional(WatchPolicyInput.annotations(watchAnnotation)),
});
export type WorkflowRequest = Schema.Schema.Type<typeof WorkflowRequest>;

export const SaveWorkflowRequest = Schema.Struct({
  key: Schema.String.annotations({ description: "Unique identifier for the workflow" }),
  steps: Schema.Array(WorkflowStep).annotations({
    description:
      "Ordered list of steps. A step is {id?, activity, input?}; a PARALLEL GROUP is " +
      "{id?, parallel: [step, …]}, whose branches run concurrently and cannot reference each other.",
  }),
  params: Schema.optional(
    WorkflowParams.annotations({
      description:
        "Default parameter values for this saved workflow; run_saved_workflow params override them key-by-key.",
    }),
  ),
  outputs: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }).annotations({
      description:
        "Declared output schema (JSON-Schema subset) — the workflow's typed output signature; its agent step must carry a matching outputContract input, and chain registration validates capture mappings against it.",
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
      overrides?: {
        instanceId?: string;
        workspaceId?: string;
        fresh?: boolean;
        watch?: WatchPolicyInput;
      },
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
