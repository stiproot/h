import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect } from "effect";

import { invokeAgentMethod, runActivity } from "../activity-runtime.ts";

type Input = {
  workflowInstanceId: string;
  workspaceId?: string;
  sourceRepo?: string;
  branch?: string;
  baseRef?: string;
  // Branch to refresh from origin before cutting a new branch (defaults to "main" in the agent's
  // /worktree route). Pass an explicit "" to skip the refresh and branch from the local checkout.
  remoteBase?: string;
  // Git auth strategy NAME ("pat" | "ssh") forwarded to the agent's /worktree; secrets stay
  // in the agent service's env.
  auth?: string;
  agentId?: string;
  traceparent?: string;
};

// Invokes an agent's /worktree to add a run-specific git worktree of a pre-cloned source repo.
// Returns the worktree path so downstream run steps can target it via {{create-worktree.worktreePath}}.
export async function createWorktreeActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<{ worktreePath: string }> {
  const {
    workflowInstanceId,
    workspaceId,
    sourceRepo,
    branch,
    baseRef,
    remoteBase,
    auth,
    agentId,
    traceparent,
  } = input as Input;
  const targetAgent = agentId ?? "claude-agent";
  return runActivity(
    invokeAgentMethod({
      label: "create-worktree",
      appId: targetAgent,
      method: "worktree",
      body: { workflowInstanceId, workspaceId, sourceRepo, branch, baseRef, remoteBase, auth },
      span: "client",
      parse: "json",
    }).pipe(Effect.map((json) => json as { worktreePath: string })),
    traceparent,
  );
}
