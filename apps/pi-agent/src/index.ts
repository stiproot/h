import { join } from "path";

import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { PiInvokerLive } from "agent-cli";
import {
  ExecGitClient,
  registerAgentRoutesEffect,
  registerCloneRouteEffect,
  registerWorkflowRoute,
  registerGcRouteEffect,
  registerWorktreeRouteEffect,
  RunLedgerLive,
  WorkflowBabysitter,
} from "agent-server";
import { Layer, ManagedRuntime } from "effect";
import Fastify from "fastify";
import { LoggerLive } from "logger";
import { makeTracingLive } from "telemetry";

import { DEFAULT_AGENT_BASE_DIR, PiRunnerLive } from "./infrastructure/pi-runner.ts";

const baseDir = process.env.AGENT_BASE_DIR ?? DEFAULT_AGENT_BASE_DIR;
// Shared run-ledger root (sibling of the per-agent base dir), visible to every agent + the host.
const runsDir = process.env.AGENT_RUNS_DIR ?? join(baseDir, "..", ".runs");
// Agent-neutral shared root (sibling of every agent's base dir) where the pre-cloned target repo
// and per-run worktrees live — resolves to the same path in claude-agent and pi-agent.
const sharedRoot = process.env.SHARED_WORKSPACE_ROOT ?? join(baseDir, "..");
const resolveWorkspaceDir = (workspaceKey: string): string => join(baseDir, workspaceKey);
// Lets /setup + /clone + /worktree record their outcomes into the run ledger.
const ledger = { runsDir, agentId: "pi-agent", daprHttpPort: process.env.DAPR_HTTP_PORT };

// One layer per concern, wired with Layer.provide and compiled once into a ManagedRuntime.
const PlatformLive = Layer.mergeAll(NodeContext.layer, NodeHttpClient.layer);
const LoggerLayer = LoggerLive("pi-agent", {
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  PRETTY_LOGS: process.env.PRETTY_LOGS,
  NODE_ENV: process.env.NODE_ENV,
});
const RunLedgerLayer = RunLedgerLive.pipe(Layer.provide(NodeContext.layer));

const RunnerLive = PiRunnerLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      PiInvokerLive.pipe(Layer.provide(PlatformLive)),
      RunLedgerLayer,
      LoggerLayer,
      NodeContext.layer,
    ),
  ),
);

const AppLive = Layer.mergeAll(
  makeTracingLive("pi-agent"),
  NodeContext.layer,
  RunLedgerLayer,
  // Git client for the /clone + /worktree routes (shallow clone + worktree of the target repo).
  ExecGitClient.pipe(Layer.provide(NodeContext.layer)),
  RunnerLive,
).pipe(Layer.orDie);

const runtime = ManagedRuntime.make(AppLive);
// Build the layers now (not lazily on the first request) so misconfiguration fails at startup.
await runtime.runtime();

const fastify = Fastify({ logger: true });
registerAgentRoutesEffect(fastify, { runtime, resolveWorkspaceDir, ledger });
registerCloneRouteEffect(fastify, { runtime, resolveWorkspaceDir, ledger });
registerWorktreeRouteEffect(fastify, { runtime, sharedRoot, ledger });
// Collecting those worktrees lives beside creating them: the shared workspace is on THIS
// service's filesystem, and workflow-svc — which owns the engines — mounts none of it.
registerGcRouteEffect(fastify, { runtime, sharedRoot, ledger });
// The standard workflow endpoint: submit-and-babysit (non-blocking).
registerWorkflowRoute(
  fastify,
  new WorkflowBabysitter({
    agentId: "pi-agent",
    onLog: (msg) => fastify.log.warn(msg),
  }),
);

const port = Number(process.env.APP_PORT ?? 8000);
await fastify.listen({ port, host: "0.0.0.0" });

// Shutdown: close the listener first, then dispose the runtime.
const shutdown = async (): Promise<void> => {
  await fastify.close();
  await runtime.dispose();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
