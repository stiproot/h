// The Effect surface: ports as `Context.Tag`s, adapters as `Layer`s, wired at each service's
// composition root (ARCHITECTURE.md#boundaries-enforced).
export { registerAgentRoutesEffect, SetupBody, SetupError, SetupItem } from "./agent-routes.ts";
export type { AgentRoutesEffectConfig, AgentRoutesEffectEnv } from "./agent-routes.ts";
export { resolveGitAuth } from "./git-auth.ts";
export { registerCloneRouteEffect } from "./clone-route.ts";
export type { CloneRouteEffectConfig, CloneRouteEffectEnv } from "./clone-route.ts";
export { registerWorktreeRouteEffect } from "./worktree-route.ts";
export type { WorktreeRouteEffectConfig, WorktreeRouteEffectEnv } from "./worktree-route.ts";
export { registerGcRouteEffect } from "./gc-route.ts";
export type { GcRouteEffectConfig, GcRouteEffectEnv } from "./gc-route.ts";
// Re-exported for the apps that register the clone/worktree routes: their runtime must
// provide the `GitClient` those routes yield, and agent-server (not each agent app) owns
// the git-core dependency.
export { ExecGitClient, GitClient } from "git-core";
export { bodyFor, runHandler, statusFor } from "./run-handler.ts";
export type { HandlerReply, RunHandlerOptions } from "./run-handler.ts";
export { AgentRunner } from "./runner.ts";
export { WorkflowBabysitter } from "./workflow-babysitter.ts";
export type {
  BabysitPolicy,
  BabysitterConfig,
  Trigger,
  WatchPolicy,
  WorkflowSubmit,
} from "./workflow-babysitter.ts";
export { registerWorkflowRoute } from "./workflow-route.ts";
// Re-exported for the agent services, whose runtimes provide `RunLedgerLive` and whose runners
// yield the `RunLedger` tag: the ledger now lives in its own package (an agent host that is not
// an HTTP service — the direct runtime — needs it without fastify), and agent-server stays their
// single import surface.
export {
  recordActivityEffect,
  RunLedger,
  RunLedgerError,
  RunLedgerLive,
  startRunLedgerEffect,
} from "run-ledger";
export type {
  ActivityLedgerConfig,
  ActivityRecord,
  ActivitySummary,
  RunLedgerContext,
  RunLedgerHandle,
  RunOutcome,
  RunSummary,
} from "run-ledger";
