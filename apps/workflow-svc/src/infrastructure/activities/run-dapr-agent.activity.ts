import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect } from "effect";

import type { AgentResult } from "engine-core";
import { applyOutputContract } from "workflow-core";
import { invokeAgentMethod, runActivity } from "../activity-runtime.ts";

type Input = {
  task: string;
  workflowInstanceId: string;
  workspaceId?: string;
  // Structured-output contract: when set, the
  // agent's final output must end with a fenced json block matching it — validated here on
  // return; a missing or mismatching block FAILS THE STEP (rung 2, D3).
  outputContract?: Record<string, unknown>;
  traceparent?: string;
};

export async function runDaprAgentActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<AgentResult> {
  const { task, workflowInstanceId, workspaceId, outputContract, traceparent } = input as Input;
  const result = await runActivity(
    invokeAgentMethod({
      label: "run-dapr-agent",
      appId: "dapr-agent",
      method: "run",
      body: { input: task, workflowInstanceId, workspaceId },
      span: "none",
      parse: "json",
    }).pipe(
      Effect.map((json) => {
        const response = json as {
          sessionId: string | null;
          output: string;
          toolCalls?: number | null;
          workspacePath?: string;
        };
        return {
          sessionId: response.sessionId,
          output: response.output,
          toolCalls: response.toolCalls ?? null,
          workspacePath: response.workspacePath,
        };
      }),
    ),
    traceparent,
  );
  return applyOutputContract(result, outputContract);
}
