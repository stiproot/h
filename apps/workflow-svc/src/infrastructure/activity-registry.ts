import { cloneRepoActivity } from "./activities/clone-repo.activity.ts";
import { copySessionActivity } from "./activities/copy-session.activity.ts";
import { createWorktreeActivity } from "./activities/create-worktree.activity.ts";
import { runClaudeActivity } from "./activities/run-claude.activity.ts";
import { runClaudeCoderActivity } from "./activities/run-claude-coder.activity.ts";
import { runClaudeManagedActivity } from "./activities/run-claude-managed.activity.ts";
import { runDaprAgentActivity } from "./activities/run-dapr-agent.activity.ts";
import { runDaprClaudeLoopActivity } from "./activities/run-dapr-claude-loop.activity.ts";
import { runLanggraphActivity } from "./activities/run-langgraph.activity.ts";
import { runOpenhandsActivity } from "./activities/run-openhands.activity.ts";
import { registerCronActivity } from "./activities/register-cron.activity.ts";
import { registerDiscoverActivity } from "./activities/register-discover.activity.ts";
import { setupActivity } from "./activities/setup.activity.ts";
import { writeWfRowActivity } from "./activities/write-wf-row.activity.ts";

export const activities = [
  setupActivity,
  cloneRepoActivity,
  createWorktreeActivity,
  runClaudeActivity,
  runClaudeCoderActivity,
  runClaudeManagedActivity,
  runDaprClaudeLoopActivity,
  runLanggraphActivity,
  runOpenhandsActivity,
  runDaprAgentActivity,
  copySessionActivity,
  writeWfRowActivity,
  registerCronActivity,
  registerDiscoverActivity,
];

export function getActivity(name: string) {
  switch (name) {
    case "setup":
      return setupActivity;
    case "clone-repo":
      return cloneRepoActivity;
    case "create-worktree":
      return createWorktreeActivity;
    case "run-claude":
      return runClaudeActivity;
    case "run-claude-coder":
      return runClaudeCoderActivity;
    case "run-claude-managed":
      return runClaudeManagedActivity;
    case "run-dapr-claude-loop":
      return runDaprClaudeLoopActivity;
    case "run-langgraph":
      return runLanggraphActivity;
    case "run-openhands":
      return runOpenhandsActivity;
    case "run-dapr-agent":
      return runDaprAgentActivity;
    case "copy-session":
      return copySessionActivity;
    case "write-wf-row":
      return writeWfRowActivity;
    case "register-cron":
      return registerCronActivity;
    case "register-discover":
      return registerDiscoverActivity;
    default:
      throw new Error(`Unknown activity: ${name}`);
  }
}
