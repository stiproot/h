import { join } from "path";

import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { OpenhandsInvokerLive } from "agent-cli";
import {
  ExecGitClient,
  registerAgentRoutesEffect,
  registerCloneRouteEffect,
  registerWorkflowRoute,
  registerWorktreeRouteEffect,
  RunLedgerLive,
  WorkflowBabysitter,
} from "agent-server";
import { Layer, ManagedRuntime } from "effect";
import Fastify from "fastify";
import { LoggerLive } from "logger";
import { makeTracingLive } from "telemetry";

import { DEFAULT_AGENT_BASE_DIR, OpenhandsRunnerLive } from "./infrastructure/openhands-runner.ts";

const baseDir = process.env.AGENT_BASE_DIR ?? DEFAULT_AGENT_BASE_DIR;
// Shared run-ledger root (sibling of the per-agent base dir), visible to every agent + the host.
const runsDir = process.env.AGENT_RUNS_DIR ?? join(baseDir, "..", ".runs");
// Agent-neutral shared root (sibling of every agent's base dir) where the pre-cloned target repo
// and per-run worktrees live — resolves to the same path in claude-agent and openhands-agent.
const sharedRoot = process.env.SHARED_WORKSPACE_ROOT ?? join(baseDir, "..");
const resolveWorkspaceDir = (workspaceKey: string): string => join(baseDir, workspaceKey);
// Lets /setup + /clone + /worktree record their outcomes into the run ledger.
const ledger = { runsDir, agentId: "openhands-agent", daprHttpPort: process.env.DAPR_HTTP_PORT };

// One layer per concern, wired with Layer.provide and compiled once into a ManagedRuntime.
// Shared layer constants are memoized by reference within the build, so the logger, ledger,
// and platform context are each built exactly once even though they feed several layers.
const PlatformLive = Layer.mergeAll(NodeContext.layer, NodeHttpClient.layer);
const LoggerLayer = LoggerLive("openhands-agent", {
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  PRETTY_LOGS: process.env.PRETTY_LOGS,
  NODE_ENV: process.env.NODE_ENV,
});
const RunLedgerLayer = RunLedgerLive.pipe(Layer.provide(NodeContext.layer));

const RunnerLive = OpenhandsRunnerLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      OpenhandsInvokerLive.pipe(Layer.provide(PlatformLive)),
      RunLedgerLayer,
      LoggerLayer,
      NodeContext.layer,
    ),
  ),
);

// The agent routes reach RunLedger + FileSystem + CommandExecutor directly (/setup and the
// run ledger), so those layers are exposed on the runtime alongside the runner — not only
// provided into it. A startup failure (missing LOG_LEVEL, malformed config) dies here, at
// the eager runtime build below, exactly as the legacy initLogger throw did.
const AppLive = Layer.mergeAll(
  makeTracingLive("openhands-agent"),
  NodeContext.layer,
  RunLedgerLayer,
  // Git client for the /clone + /worktree routes (shallow clone + worktree of the target repo).
  ExecGitClient.pipe(Layer.provide(NodeContext.layer)),
  RunnerLive,
).pipe(Layer.orDie);

const runtime = ManagedRuntime.make(AppLive);
// Build the layers now (not lazily on the first request) so misconfiguration fails at startup
// and the OTel provider is registered before the Fastify-edge withServerSpan needs it.
await runtime.runtime();

const fastify = Fastify({ logger: true });
registerAgentRoutesEffect(fastify, { runtime, resolveWorkspaceDir, ledger });
registerCloneRouteEffect(fastify, { runtime, resolveWorkspaceDir, ledger });
registerWorktreeRouteEffect(fastify, { runtime, sharedRoot, ledger });
// The standard workflow endpoint: submit-and-babysit (non-blocking) — makes this agent a
// workflow entry point on the same contract as every other agent service.
registerWorkflowRoute(
  fastify,
  new WorkflowBabysitter({
    agentId: "openhands-agent",
    onLog: (msg) => fastify.log.warn(msg),
  }),
);

const port = Number(process.env.APP_PORT ?? 8000);
await fastify.listen({ port, host: "0.0.0.0" });

// Shutdown: close the listener first, then dispose the runtime — its finalizers own the
// tracing flush and the Pino flush (replacing the legacy process.once hooks).
const shutdown = async (): Promise<void> => {
  await fastify.close();
  await runtime.dispose();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
