import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect } from "effect";

import { invokeAgentMethod, runActivity } from "../activity-runtime.ts";

type SetupItem = { cmd: string; validateCmd?: string };
type Input = {
  workflowInstanceId: string;
  workspaceId?: string;
  setup: SetupItem[];
  // Explicit working dir for the setup commands (e.g. a worktree); overrides the computed dir.
  cwd?: string;
  agentId?: string;
  traceparent?: string;
};

export async function setupActivity(_ctx: WorkflowActivityContext, input: unknown): Promise<void> {
  const { workflowInstanceId, workspaceId, setup, cwd, agentId, traceparent } = input as Input;
  const targetAgent = agentId ?? "claude-agent";
  await runActivity(
    invokeAgentMethod({
      label: "setup",
      appId: targetAgent,
      method: "setup",
      body: { workflowInstanceId, workspaceId, setup, cwd },
      span: "client",
      parse: "ignore",
    }).pipe(Effect.asVoid),
    traceparent,
  );
}
