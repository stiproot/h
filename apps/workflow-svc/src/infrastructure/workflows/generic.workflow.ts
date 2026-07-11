import type { Task, WorkflowContext } from "@dapr/dapr";

import type { WorkflowRequest } from "../../domain/models/workflow.model.ts";
import { getActivity } from "../activity-registry.ts";
import { resolveRefs, resolveTokenString } from "./resolve-refs.ts";

export async function* genericWorkflow(
  ctx: WorkflowContext,
  input: WorkflowRequest,
): AsyncGenerator<Task<unknown>, string, unknown> {
  // Seed named params under the reserved id `params`, so steps reference them exactly like
  // step results: {{params.x}} in strings, { "$ref": "params.x" } for any-typed values.
  const results: Record<string, unknown> = { params: input.params ?? {} };
  const workflowInstanceId = ctx.getWorkflowInstanceId();

  // Registry self-reporting (docs/plans/workflow-watcher-registry.md §3): when the run carries a
  // wf-identity, bracket its steps with the write-wf-row activity so it writes its OWN status row —
  // `running` before the steps, `done`/`failed` after. Deterministic in the generator (the row's
  // timestamp is stamped inside the non-deterministic activity); best-effort (the activity swallows
  // write errors, so a bracket never fails the run). A step-input token can never resolve to
  // write-wf-row (it's not a chart activity) — this is engine-driven, invisible to the definition.
  const wf = input.wf;
  const writeRow = (status: string, output?: string): Task<unknown> =>
    ctx.callActivity(getActivity("write-wf-row"), {
      wf,
      status,
      instanceId: workflowInstanceId,
      subject: input.params,
      output,
      traceparent: input.traceparent,
    });

  if (wf) yield writeRow("running");

  try {
    for (const step of input.steps) {
      // Fire-time identity (chain-composition-surface §1.9): the activity NAME may carry a
      // {{params.*}} token (e.g. "{{params.runActivity}}"), resolved against the same results map
      // as step inputs. An unresolved token or unknown resulting activity throws — never a silent
      // fallback to a default agent.
      const activity = getActivity(resolveTokenString(step.activity, results));
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
  } catch (err) {
    if (wf) yield writeRow("failed");
    throw err;
  }

  const output = JSON.stringify(results);
  if (wf) yield writeRow("done", output);
  return output;
}
