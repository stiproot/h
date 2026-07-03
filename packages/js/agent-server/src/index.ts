// Effect surface (Phase 3 of the Effect migration — see plans/effect-refactor-map.md)
export { registerAgentRoutesEffect, SetupBody, SetupError, SetupItem } from "./agent-routes.ts";
export type { AgentRoutesEffectConfig, AgentRoutesEffectEnv } from "./agent-routes.ts";
export { registerCloneRouteEffect } from "./clone-route.ts";
export type { CloneRouteEffectConfig, CloneRouteEffectEnv } from "./clone-route.ts";
export { registerWorktreeRouteEffect } from "./worktree-route.ts";
export type { WorktreeRouteEffectConfig, WorktreeRouteEffectEnv } from "./worktree-route.ts";
// Re-exported for the apps that register the clone/worktree routes: their runtime must
// provide the `GitClient` those routes yield, and agent-server (not each agent app) owns
// the git-core dependency.
export { ExecGitClient, GitClient } from "git-core";
export { bodyFor, runHandler, statusFor } from "./run-handler.ts";
export type { HandlerReply, RunHandlerOptions } from "./run-handler.ts";
export { AgentRunner } from "./runner.ts";
export {
  recordActivityEffect,
  RunLedger,
  RunLedgerError,
  RunLedgerLive,
  startRunLedgerEffect,
} from "./run-ledger.ts";
export type {
  ActivityLedgerConfig,
  ActivityRecord,
  ActivitySummary,
  RunLedgerContext,
  RunLedgerHandle,
  RunOutcome,
  RunSummary,
} from "./run-ledger.ts";
