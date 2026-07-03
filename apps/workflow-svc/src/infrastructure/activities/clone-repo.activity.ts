import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect } from "effect";

import { invokeAgentMethod, runActivity } from "../activity-registry.ts";

type Input = {
  workflowInstanceId: string;
  workspaceId?: string;
  url: string;
  branch?: string;
  depth?: number;
  dir?: string;
  agentId?: string;
  traceparent?: string;
};

export async function cloneRepoActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<void> {
  const { workflowInstanceId, workspaceId, url, branch, depth, dir, agentId, traceparent } =
    input as Input;
  const targetAgent = agentId ?? "claude-agent";
  await runActivity(
    invokeAgentMethod({
      label: "clone-repo",
      appId: targetAgent,
      method: "clone",
      body: { workflowInstanceId, workspaceId, url, branch, depth, dir },
      span: "client",
      parse: "ignore",
    }).pipe(Effect.asVoid),
    traceparent,
  );
}
