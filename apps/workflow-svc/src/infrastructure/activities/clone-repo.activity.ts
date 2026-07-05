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
  // Git auth strategy NAME ("pat" | "ssh") forwarded to the agent's /clone; secrets stay
  // in the agent service's env.
  auth?: string;
  agentId?: string;
  traceparent?: string;
};

export async function cloneRepoActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<void> {
  const { workflowInstanceId, workspaceId, url, branch, depth, dir, auth, agentId, traceparent } =
    input as Input;
  const targetAgent = agentId ?? "claude-agent";
  await runActivity(
    invokeAgentMethod({
      label: "clone-repo",
      appId: targetAgent,
      method: "clone",
      body: { workflowInstanceId, workspaceId, url, branch, depth, dir, auth },
      span: "client",
      parse: "ignore",
    }).pipe(Effect.asVoid),
    traceparent,
  );
}
