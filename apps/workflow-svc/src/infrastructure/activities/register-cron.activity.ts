import type { WorkflowActivityContext } from "@dapr/dapr";

import { planCron, type RegisterCronInput, registerCronForFire } from "engine-core";

export type RegisterCronResult = { armed: true; cron: string } | { armed: false; reason: string };
import { runActivity } from "../activity-runtime.ts";

/**
 * Registers a RECUR cron from inside a workflow (the §10 arm-* pattern in CLAUDE.md — the
 * `arm-*` pattern). Sibling of `write-wf-row`: an activity on workflow-svc that writes registry state
 * a run PRODUCES, so a workflow arms its own follow-on recurrence as a step rather than the fire edge
 * doing it. The recurrence still lives in the cron engine (this only writes the row) — the workflow is
 * a CLIENT of the cron primitive, never the engine, so the "a workflow never recurs itself" invariant
 * holds. Single-writer intact: this runs on workflow-svc and calls the same epoch-fenced
 * `registerCronForFire` the edge used to.
 *
 * LOUD on failure (unlike best-effort `write-wf-row`): the cron IS the point of the step, so a
 * registration failure throws → generic.workflow's closing bracket records `wf:failed`. That is the
 * durable audit of "did this cron get armed?" (§10).
 *
 * The arm-at-birth guard: when `requirePrFrom` is set (create-pr's `{{create-pr.output}}`), only arm
 * if a PR actually opened — read the `pr` field of the step's structured output block (a skip or a
 * missing block → a valid no-op, NOT a failure), and thread that PR number into the fired
 * workflow's params.
 */
export async function registerCronActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<RegisterCronResult> {
  const parsed = input as RegisterCronInput;
  const plan = planCron(parsed);
  if (!plan.armed) return plan;
  // LOUD: no Effect.ignore — a registration failure rejects, the step throws, the run records wf:failed.
  await runActivity(registerCronForFire(plan.registration), parsed.traceparent);
  return { armed: true, cron: `${parsed.repo}:${parsed.slug}:${parsed.workflow}` };
}
