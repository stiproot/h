import type { WorkflowActivityContext } from "@dapr/dapr";
import { DaprInvokerTag } from "core-dapr";
import { Effect } from "effect";

import type { AgentResult } from "../../domain/models/workflow.model.ts";
import { applyOutputContract } from "workflow-core";
import { runActivity } from "../activity-runtime.ts";

type Input = {
  task: string;
  workflowInstanceId: string;
  workspaceId?: string;
  cwd?: string;
  model?: string;
  outputContract?: Record<string, unknown>;
  traceparent?: string;
};

export async function runCodexActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<AgentResult> {
  const { task, workflowInstanceId, workspaceId, cwd, model, outputContract, traceparent } =
    input as Input;
  const result = await runActivity(
    Effect.gen(function* () {
      const invoker = yield* DaprInvokerTag;
      const response = yield* invoker.invoke("codex-agent", "run", {
        input: task,
        workflowInstanceId,
        workspaceId,
        cwd,
        model,
      });
      return {
        sessionId: response.sessionId,
        output: response.output,
        workspacePath: response.workspacePath,
      };
    }),
    traceparent,
  );
  return applyOutputContract(result, outputContract);
}
