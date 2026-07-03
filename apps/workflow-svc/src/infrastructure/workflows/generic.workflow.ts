import type { Task, WorkflowContext } from "@dapr/dapr";

import type { WorkflowRequest } from "../../domain/models/workflow.model.ts";
import { getActivity } from "../activity-registry.ts";
import { resolveRefs } from "./resolve-refs.ts";

export async function* genericWorkflow(
  ctx: WorkflowContext,
  input: WorkflowRequest,
): AsyncGenerator<Task<unknown>, string, unknown> {
  const results: Record<string, unknown> = {};
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
