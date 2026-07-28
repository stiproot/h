import type { WorkflowActivityContext } from "@dapr/dapr";
import { DaprInvokerTag } from "core-dapr";
import { Effect } from "effect";

import type { AgentResult } from "../../domain/models/workflow.model.ts";
import { applyOutputContract } from "../../domain/structured-output.ts";
import { runActivity } from "../activity-runtime.ts";

type Input = {
  task: string;
  workflowInstanceId: string;
  workspaceId?: string;
  cwd?: string;
  model?: string;
  // "plan" runs the kimi CLI read-only (--permission-mode plan).
  permissionMode?: "plan";
  outputContract?: Record<string, unknown>;
  traceparent?: string;
};

export async function runKimiActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<AgentResult> {
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
  const result = await runActivity(
    Effect.gen(function* () {
      const invoker = yield* DaprInvokerTag;
      const response = yield* invoker.invoke("kimi-agent", "run", {
        input: task,
        workflowInstanceId,
        workspaceId,
        cwd,
        model,
        permissionMode,
      });
      return {
        sessionId: response.sessionId,
        output: response.output,
        workspacePath: response.workspacePath,
      };
    }).pipe(
      Effect.withSpan("activity run-kimi", {
        attributes: { "workflow.instance_id": workflowInstanceId },
      }),
    ),
    traceparent,
  );
  return applyOutputContract(result, outputContract);
}
