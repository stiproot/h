import type { Task, WorkflowContext } from "@dapr/dapr";

import type { WorkflowRequest } from "../../domain/models/workflow.model.ts";
import { getActivity } from "../activity-registry.ts";
import { resolveRefs } from "./resolve-refs.ts";

export async function* genericWorkflow(
  ctx: WorkflowContext,
  input: WorkflowRequest,
): AsyncGenerator<Task<unknown>, string, unknown> {
  // Seed named params under the reserved id `params`, so steps reference them exactly like
  // step results: {{params.x}} in strings, { "$ref": "params.x" } for any-typed values.
  const results: Record<string, unknown> = { params: input.params ?? {} };
  const workflowInstanceId = ctx.getWorkflowInstanceId();

  for (const step of input.steps) {
    const activity = getActivity(step.activity);
    // Pass the originating traceparent alongside the instance id so each activity can re-attach
    // its outbound calls to the trace that requested the run.
    const resolvedInput = resolveRefs(
      {
        ...step.input,
        workflowInstanceId,
        workspaceId: input.workspaceId,
        traceparent: input.traceparent,
      },
      results,
    );
    const result = yield ctx.callActivity(activity, resolvedInput);
    results[step.id ?? step.activity] = result;
  }

  return JSON.stringify(results);
}
