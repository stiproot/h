import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect } from "effect";

import type { AgentResult } from "../../domain/models/workflow.model.ts";
import { invokeAgentMethod, runActivity } from "../activity-registry.ts";

type Input = {
  task: string;
  graph?: Record<string, unknown>;
  preset?: string;
  workflowInstanceId: string;
  workspaceId?: string;
  traceparent?: string;
};

export async function runLanggraphActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<AgentResult> {
  const { task, graph, preset, workflowInstanceId, workspaceId, traceparent } = input as Input;
  return runActivity(
    invokeAgentMethod({
      label: "run-langgraph",
      appId: "langgraph-agent",
      method: "run",
      body: { input: task, graph, preset, workflowInstanceId, workspaceId },
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
