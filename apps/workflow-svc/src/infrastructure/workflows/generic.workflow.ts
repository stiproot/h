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
    // --cron closing bracket (docs/plans/workflow-watcher-registry.md §10): a run that carries an
    // armCron registers its OWN recurrence AFTER the work, via the register-cron activity (idempotent
    // ensure-exists, so a re-fired run's re-arm is a no-op). LOUD — a failed arm throws into the catch
    // below and records wf:failed. repo/slug come from the run's params; it recurs under THIS run's
    // instance so the cron reuses the workspace and the in-flight guard tracks it.
    if (input.armCron) {
      const params = (input.params ?? {}) as Record<string, unknown>;
      yield ctx.callActivity(getActivity("register-cron"), {
        workflow: input.armCron.workflow,
        repo: params.repo,
        slug: params.slug,
        cadence: input.armCron.cadence,
        ...(input.armCron.budget ? { maxFires: input.armCron.budget.maxFires } : {}),
        params: input.params,
        instanceId: workflowInstanceId,
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

/**
 * The goal handshake (docs/plans/workflow-watcher-registry.md §6): a wf-identified workflow may end an
 * agent step with a `===GOAL===` marker reporting whether its SUBJECT is resolved (e.g. the PR merged)
 * — distinct from run-status `done` (the steps finished). We scan the step outputs for
 * `===GOAL=== … RESOLVED` so write-wf-row records `resolved`, the flag the cron engine reads to stop
 * recurring. Pure string parsing — replay-safe. Absent marker ⇒ false (not resolved; keep recurring).
 */
function goalResolved(results: Record<string, unknown>): boolean {
  const MARK = "===GOAL===";
  for (const v of Object.values(results)) {
    const out = (v as { output?: unknown } | null | undefined)?.output;
    if (typeof out !== "string") continue;
    const idx = out.lastIndexOf(MARK);
    if (
      idx !== -1 &&
      out
        .slice(idx + MARK.length)
        .trim()
        .toUpperCase()
        .startsWith("RESOLVED")
    ) {
      return true;
    }
  }
  return false;
}
