import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect } from "effect";

import { invokeAgentMethod, runActivity } from "../activity-runtime.ts";

type Input = {
  workflowInstanceId: string;
  workspaceId?: string;
  // Local path of the pre-cloned repo to cut the worktree from (NOT a GitHub owner/name).
  clonePath?: string;
  // WHAT to check out — git-core's GitCheckout strategy, forwarded verbatim to the agent's
  // /worktree, which owns the defaulting (absent = the bare branch strategy; a branch strategy
  // with no baseRef refreshes from origin/main).
  checkout?: {
    kind: "branch" | "detached";
    branch?: string;
    baseRef?: string;
    remoteBase?: string;
    ref?: string;
    fetch?: { remoteRef: string; depth?: number };
  };
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
  const { workflowInstanceId, workspaceId, clonePath, checkout, auth, agentId, traceparent } =
    input as Input;
  const targetAgent = agentId ?? "claude-agent";
  return runActivity(
    invokeAgentMethod({
      label: "create-worktree",
      appId: targetAgent,
      method: "worktree",
      body: { workflowInstanceId, workspaceId, clonePath, checkout, auth },
      span: "client",
      parse: "json",
    }).pipe(Effect.map((json) => json as { worktreePath: string })),
    traceparent,
  );
}
