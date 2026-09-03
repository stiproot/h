import type { Task, WorkflowContext } from "@dapr/dapr";

import type { WorkflowRequest } from "engine-core";
import { goalResolved } from "engine-core";
import { getActivity } from "../activity-registry.ts";
import { resolveRefs, resolveTokenString } from "workflow-core";

export async function* genericWorkflow(
  ctx: WorkflowContext,
  input: WorkflowRequest,
): AsyncGenerator<Task<unknown>, string, unknown> {
  // Seed named params under the reserved id `params`, so steps reference them exactly like
  // step results: {{params.x}} in strings, { "$ref": "params.x" } for any-typed values.
  const results: Record<string, unknown> = { params: input.params ?? {} };
  // The fire's quota gate rides every step input, where the activity-registry gate reads it for
  // the `run-*` activities (the others ignore the two keys). Fire-time wins over a step's own
  // input, the same wholesale-override rule `watch` follows.
  const quotaInput = input.quota
    ? { onQuota: input.quota.onQuota, ...(input.quota.ignore ? { ignoreQuota: true } : {}) }
    : {};
  const workflowInstanceId = ctx.getWorkflowInstanceId();

  // Registry self-reporting: when the run carries a
  // wf-identity, bracket its steps with the write-wf-row activity so it writes its OWN status row —
  // `running` before the steps, `done`/`failed` after. Deterministic in the generator (the row's
  // timestamp is stamped inside the non-deterministic activity); best-effort (the activity swallows
  // write errors, so a bracket never fails the run). A step-input token can never resolve to
  // write-wf-row (it's not a chart activity) — this is engine-driven, invisible to the definition.
  const wf = input.wf;
  const writeRow = (status: string, output?: string, resolved?: boolean): Task<unknown> =>
    ctx.callActivity(getActivity("write-wf-row"), {
      wf,
      status,
      instanceId: workflowInstanceId,
      subject: input.params,
      output,
      resolved,
      traceparent: input.traceparent,
    });

  if (wf) yield writeRow("running");

  try {
    for (const step of input.steps) {
      if ("parallel" in step) {
        // Parallel step group: every branch's input resolves
        // against the results map as it stood BEFORE the group — branches cannot reference each
        // other, which is what makes them parallelizable — then ONE whenAll fans out. A single
        // deterministic decision point in the generator, replay-safe; any branch failure fails
        // the group (and so the run), the same loud contract as sequential steps.
        const branches = step.parallel.map((branch) =>
          ctx.callActivity(
            getActivity(resolveTokenString(branch.activity, results)),
            resolveRefs(
              {
                ...branch.input,
                ...quotaInput,
                workflowInstanceId,
                workspaceId: input.workspaceId,
                traceparent: input.traceparent,
              },
              results,
            ),
          ),
        );
        const outs = (yield ctx.whenAll(branches)) as unknown[];
        step.parallel.forEach((branch, i) => {
          results[branch.id ?? branch.activity] = outs[i];
        });
        // A group id additionally records the {branchId: result} map, so a later step can take
        // the whole panel in one $ref.
        if (step.id) {
          results[step.id] = Object.fromEntries(
            step.parallel.map((branch, i) => [branch.id ?? branch.activity, outs[i]]),
          );
        }
        continue;
      }
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
          ...quotaInput,
          workflowInstanceId,
          workspaceId: input.workspaceId,
          traceparent: input.traceparent,
        },
        results,
      );
      const result = yield ctx.callActivity(activity, resolvedInput);
      results[step.id ?? step.activity] = result;
    }
    // --cron closing bracket: a run that carries an
    // armCron registers its OWN recurrence AFTER the work, via the register-cron activity (idempotent
    // ensure-exists, so a re-fired run's re-arm is a no-op). LOUD — a failed arm throws into the catch
    // below and records wf:failed. repo/slug come from the run's params; it recurs under THIS run's
    // instance so the cron reuses the workspace and the in-flight guard tracks it.
    if (input.armCron) {
      const params = (input.params ?? {}) as Record<string, unknown>;
      // Inline (embedded) recurrence recurs THIS run's own steps verbatim — nothing published to
      // re-hydrate by key.
      yield ctx.callActivity(getActivity("register-cron"), {
        workflow: input.armCron.workflow,
        repo: params.repo,
        slug: params.slug,
        cadence: input.armCron.cadence,
        ...(input.armCron.budget ? { maxFires: input.armCron.budget.maxFires } : {}),
        params: input.params,
        instanceId: workflowInstanceId,
        ...(input.armCron.inline
          ? { inline: true, steps: input.steps, workspaceId: input.workspaceId }
          : {}),
        traceparent: input.traceparent,
      });
    }
  } catch (err) {
    if (wf) yield writeRow("failed");
    throw err;
  }

  const output = JSON.stringify(results);
  if (wf) yield writeRow("done", output, goalResolved(results));
  return output;
}
