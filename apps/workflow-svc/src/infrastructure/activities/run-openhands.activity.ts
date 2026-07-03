import type { WorkflowActivityContext } from "@dapr/dapr";
import { DaprInvokerTag } from "core-dapr";
import { Effect } from "effect";

import type { AgentResult } from "../../domain/models/workflow.model.ts";
import { runActivity } from "../activity-registry.ts";

type Input = {
  task: string;
  workflowInstanceId: string;
  workspaceId?: string;
  traceparent?: string;
};

export async function runOpenhandsActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<AgentResult> {
  const { task, workflowInstanceId, workspaceId, traceparent } = input as Input;
  // The invoker opens the same CLIENT span as the legacy withClientSpan
  // ("invoke openhands-agent/run") and injects the traceparent into the outgoing headers.
  return runActivity(
    Effect.gen(function* () {
      const invoker = yield* DaprInvokerTag;
      const response = yield* invoker.invoke("openhands-agent", "run", {
        input: task,
        workflowInstanceId,
        workspaceId,
      });
      return {
        sessionId: response.sessionId,
        output: response.output,
        workspacePath: response.workspacePath,
      };
    }),
    traceparent,
  );
}
