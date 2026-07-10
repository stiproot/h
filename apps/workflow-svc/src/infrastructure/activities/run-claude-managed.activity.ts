import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect } from "effect";

import type { AgentResult } from "../../domain/models/workflow.model.ts";
import { invokeAgentMethod, runActivity } from "../activity-runtime.ts";

type Input = {
  task: string;
  workflowInstanceId: string;
  workspaceId?: string;
  traceparent?: string;
};

export async function runClaudeManagedActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<AgentResult> {
  const { task, workflowInstanceId, workspaceId, traceparent } = input as Input;
  return runActivity(
    invokeAgentMethod({
      label: "run-claude-managed",
      appId: "claude-managed-agent",
      method: "run",
      body: { input: task, workflowInstanceId, workspaceId },
      span: "none",
      parse: "json",
    }).pipe(
      Effect.map((json) => {
        const data = json as { sessionId: string | null; output: string };
        return { sessionId: data.sessionId, output: data.output };
      }),
    ),
    traceparent,
  );
}
