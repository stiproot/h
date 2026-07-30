import type { WorkflowActivityContext } from "@dapr/dapr";
import { DaprInvokerTag } from "core-dapr";
import { Effect } from "effect";

import type { ClaudeResult } from "../../domain/models/workflow.model.ts";
import { applyOutputContract } from "../../domain/structured-output.ts";
import { runActivity } from "../activity-runtime.ts";

type Input = {
  task: string;
  workflowInstanceId: string;
  workspaceId?: string;
  // Explicit working dir (e.g. a shared worktree path); overrides the agent's computed workspace dir.
  cwd?: string;
  // Per-step LLM model override (e.g. Sonnet for a plan step, Haiku for an implement step).
  model?: string;
  // "plan" runs the claude CLI read-only (--permission-mode plan).
  permissionMode?: "plan";
  // Structured-output contract: when set, the
  // agent's final output must end with a fenced json block matching it — validated here on
  // return; a missing or mismatching block FAILS THE STEP (rung 2, D3).
  outputContract?: Record<string, unknown>;
  traceparent?: string;
};

export async function runClaudeActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<ClaudeResult> {
  const {
    task,
    workflowInstanceId,
    workspaceId,
    cwd,
    model,
    permissionMode,
    outputContract,
    traceparent,
  } = input as Input;
  // The fiber is re-attached to the originating trace at the runActivity edge; the invoker's
  // CLIENT span (and the injected traceparent) then chain back to the request that started
  // the run, under the same "activity run-claude" span as before.
  const result = await runActivity(
    Effect.gen(function* () {
      const invoker = yield* DaprInvokerTag;
      const response = yield* invoker.invoke("claude-agent", "run", {
        input: task,
        workflowInstanceId,
        workspaceId,
        cwd,
        model,
        permissionMode,
      });
      return { sessionId: response.sessionId, output: response.output };
    }).pipe(
      Effect.withSpan("activity run-claude", {
        attributes: { "workflow.instance_id": workflowInstanceId },
      }),
    ),
    traceparent,
  );
  return applyOutputContract(result, outputContract);
}
