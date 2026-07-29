import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect, Option } from "effect";

import { deniedMessage, executorFromActivity, isExecutorDenied } from "../domain/exec-policy.ts";
import { ExecPolicyStore } from "../domain/ports/IExecPolicyStore.ts";
import { runActivity } from "./activity-runtime.ts";
import { cloneRepoActivity } from "./activities/clone-repo.activity.ts";
import { copySessionActivity } from "./activities/copy-session.activity.ts";
import { createWorktreeActivity } from "./activities/create-worktree.activity.ts";
import { registerCronActivity } from "./activities/register-cron.activity.ts";
import { registerDiscoverActivity } from "./activities/register-discover.activity.ts";
import { runClaudeActivity } from "./activities/run-claude.activity.ts";
import { runClaudeManagedActivity } from "./activities/run-claude-managed.activity.ts";
import { runCodexActivity } from "./activities/run-codex.activity.ts";
import { runDaprAgentActivity } from "./activities/run-dapr-agent.activity.ts";
import { runDaprClaudeLoopActivity } from "./activities/run-dapr-claude-loop.activity.ts";
import { runLanggraphActivity } from "./activities/run-langgraph.activity.ts";
import { runOpenhandsActivity } from "./activities/run-openhands.activity.ts";
import { runPiActivity } from "./activities/run-pi.activity.ts";
import { setupActivity } from "./activities/setup.activity.ts";
import { writeWfRowActivity } from "./activities/write-wf-row.activity.ts";

type ActivityFn = (ctx: WorkflowActivityContext, input: unknown) => Promise<unknown>;

/**
 * The executor-policy gate (docs/plans/live-state-containment.md §2.3): before a `run-*`
 * activity invokes its agent, read `exec:config` and REFUSE a denied executor loudly. This is
 * the one choke point every fire path shares — chains, crons, watcher re-fires, sched
 * continuations, the usage-limit fallback's agent switch, panel branches — because fire-time
 * identity means the executor is only final when the activity name has been resolved. The
 * refusal throws, so the step fails and the watcher/chain finalize it as `failed`: a denied
 * executor being named is a policy violation the operator must SEE, never a silent re-route.
 * A failed policy read also fails the step (fail-closed — a down statestore breaks everything
 * else anyway). Exported for the registry's tests.
 */
export function gatedExecutor(activityName: string, fn: ActivityFn): ActivityFn {
  const executor = executorFromActivity(activityName);
  if (executor === undefined) return fn;
  const wrapped: ActivityFn = async (ctx, input) => {
    const traceparent = (input as { traceparent?: string } | null)?.traceparent;
    await runActivity(
      Effect.gen(function* () {
        const store = yield* ExecPolicyStore;
        const policy = yield* store.get();
        if (isExecutorDenied(Option.getOrUndefined(policy), executor)) {
          return yield* Effect.fail(new Error(deniedMessage(executor)));
        }
      }),
      traceparent,
    );
    return fn(ctx, input);
  };
  // Dapr registers and dispatches activities by FUNCTION NAME — the wrapper must be
  // indistinguishable from the activity it gates.
  Object.defineProperty(wrapped, "name", { value: fn.name });
  return wrapped;
}

// The activity name → function map. Every `run-*` entry is wrapped by the executor-policy gate
// STRUCTURALLY (by name prefix, via gatedExecutor's own executorFromActivity check), so a new
// agent activity added here is gated automatically — the guard cannot be forgotten.
const registry: Record<string, ActivityFn> = Object.fromEntries(
  Object.entries({
    setup: setupActivity,
    "clone-repo": cloneRepoActivity,
    "create-worktree": createWorktreeActivity,
    "run-claude": runClaudeActivity,
    "run-claude-managed": runClaudeManagedActivity,
    "run-codex": runCodexActivity,
    "run-dapr-claude-loop": runDaprClaudeLoopActivity,
    "run-langgraph": runLanggraphActivity,
    "run-openhands": runOpenhandsActivity,
    "run-pi": runPiActivity,
    "run-dapr-agent": runDaprAgentActivity,
    "copy-session": copySessionActivity,
    "write-wf-row": writeWfRowActivity,
    "register-cron": registerCronActivity,
    "register-discover": registerDiscoverActivity,
  } satisfies Record<string, ActivityFn>).map(([name, fn]) => [name, gatedExecutor(name, fn)]),
);

export const activities = Object.values(registry);

export function getActivity(name: string) {
  const activity = registry[name];
  if (!activity) throw new Error(`Unknown activity: ${name}`);
  return activity;
}
