import type { WorkflowActivityContext } from "@dapr/dapr";

import { type CronRegistration, registerCronForFire } from "../../domain/cron-scan.ts";
import { lastFencedJson } from "../../domain/structured-output.ts";
import { runActivity } from "../activity-runtime.ts";

/**
 * Registers a RECUR cron from inside a workflow (docs/plans/workflow-watcher-registry.md §10 — the
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
 * The arm-at-birth guard: when `requirePrFrom` is set (create-pr's `{{implement.output}}`), only arm
 * if a PR actually opened — read the `pr` field of the step's structured output block (a skip or a
 * missing block → a valid no-op, NOT a failure), and thread that PR number into the fired
 * workflow's params.
 */
export type RegisterCronInput = {
  /** The saved key to recur (e.g. "revise"). */
  workflow: string;
  repo: string;
  slug: string;
  cadence: string;
  maxFires?: number;
  /** Base params the recurred workflow fires with; `repo`/`slug`/`pr` are set/overridden here. */
  params?: Record<string, unknown>;
  /** When set, only arm if this output blob's structured json block carries a `pr`; the number → params.pr. */
  requirePrFrom?: string;
  /** The fixed instance the recur cron fires under; defaults to `<workflow>-<slug>`. */
  instanceId?: string;
  traceparent?: string;
};

export type RegisterCronResult = { armed: true; cron: string } | { armed: false; reason: string };

/** The plan: either a no-op (with a reason) or the registration to execute. */
export type CronPlan =
  | { armed: false; reason: string }
  | { armed: true; registration: CronRegistration };

// Parse a PR number out of a single step's RAW agent output (a `{{implement.output}}` string): the
// last fenced ```json block is the step's validated structured output (the rung-2 seam already
// enforced it against the declared contract — docs/plans/structured-workflow-outputs.md), and its
// `pr` field is the number. A skip (`skipped` instead of `pr`) or no block → undefined.
const prNumberFrom = (blob: string | undefined): string | undefined => {
  if (typeof blob !== "string") return undefined;
  const raw = lastFencedJson(blob);
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as { pr?: unknown };
    return typeof value?.pr === "number" || typeof value?.pr === "string"
      ? String(value.pr)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The pure decision (unit-tested): assemble the recur registration from the input, applying the
 * arm-at-birth guard. When `requirePrFrom` is set and its structured block carries no `pr` (a
 * create-pr skip, or no block), return a no-op — arming a revise loop for a PR that doesn't exist
 * is wrong, and it is a valid outcome, NOT a failure. Otherwise thread the PR number into the
 * fired params.
 */
export function planCron(input: RegisterCronInput): CronPlan {
  const fireParams: Record<string, unknown> = {
    ...input.params,
    repo: input.repo,
    slug: input.slug,
  };
  if (input.requirePrFrom !== undefined) {
    const pr = prNumberFrom(input.requirePrFrom);
    if (pr === undefined) return { armed: false, reason: "no PR opened — revise loop not armed" };
    fireParams.pr = pr;
  }
  return {
    armed: true,
    registration: {
      identity: { repo: input.repo, slug: input.slug, workflow: input.workflow },
      cadence: input.cadence,
      source: { mode: "saved", key: input.workflow, params: fireParams },
      ...(input.maxFires !== undefined ? { budget: { maxFires: input.maxFires } } : {}),
      instanceId: input.instanceId ?? `${input.workflow}-${input.slug}`,
    },
  };
}

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
