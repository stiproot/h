import type { ExecPolicy } from "./models/exec.model.ts";

/**
 * The executor-policy decision (docs/plans/live-state-containment.md §2.3) — the pure half of
 * the activity-registry gate, in the decide-on-a-row shape the engines use. The gate wraps
 * every `run-*` activity: nothing reaches a model without passing through one, so a denial
 * here is enforcement, not convention.
 */

const RUN_PREFIX = "run-";

/**
 * The executor shortname a run activity invokes: the activity name minus `run-`
 * (`run-codex` → `codex`, `run-dapr-agent` → `dapr-agent`). Undefined for a non-run activity —
 * provisioning activities (setup, clone-repo, register-*) carry no executor and are never gated.
 */
export function executorFromActivity(activityName: string): string | undefined {
  return activityName.startsWith(RUN_PREFIX) ? activityName.slice(RUN_PREFIX.length) : undefined;
}

/**
 * True when the policy denies this executor. An absent policy (no `exec:config` row yet) or an
 * empty denied list allows everything — deny is explicit, allow is the default.
 */
export function isExecutorDenied(policy: ExecPolicy | undefined, executor: string): boolean {
  return policy !== undefined && policy.denied.includes(executor);
}

/** The refusal text a gated activity throws — names the executor and the way back out. */
export function deniedMessage(executor: string): string {
  return `executor '${executor}' is denied by the exec:config policy — re-enable with: h agents allow ${executor}`;
}
