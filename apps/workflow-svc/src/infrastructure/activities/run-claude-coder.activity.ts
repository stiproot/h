import type { WorkflowActivityContext } from "@dapr/dapr";
import { DaprInvokerTag } from "core-dapr";
import { Effect } from "effect";

import type { ClaudeResult } from "../../domain/models/workflow.model.ts";
import { runActivity } from "../activity-registry.ts";

type Input = {
  task: string;
  workflowInstanceId: string;
  workspaceId?: string;
  cwd?: string;
  model?: string;
  permissionMode?: "plan";
  traceparent?: string;
};

export async function runClaudeCoderActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<ClaudeResult> {
  const { task, workflowInstanceId, workspaceId, cwd, model, permissionMode, traceparent } =
    input as Input;
  return runActivity(
    Effect.gen(function* () {
      const invoker = yield* DaprInvokerTag;
      const response = yield* invoker.invoke("claude-coder", "run", {
        input: task,
        workflowInstanceId,
        workspaceId,
        cwd,
        model,
        permissionMode,
      });
      return { sessionId: response.sessionId, output: response.output };
    }).pipe(
      Effect.withSpan("activity run-claude-coder", {
        attributes: { "workflow.instance_id": workflowInstanceId },
      }),
    ),
    traceparent,
  );
}
