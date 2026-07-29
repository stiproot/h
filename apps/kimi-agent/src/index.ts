import { join } from "path";

import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { ClaudeInvokerLive } from "agent-cli";
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
import { makeTracingLive } from "telemetry";

import { KimiRunnerLive } from "./infrastructure/kimi-runner.ts";

const baseDir = process.env.AGENT_BASE_DIR ?? "/workspace/kimi-agent";
const runsDir = process.env.AGENT_RUNS_DIR ?? join(baseDir, "..", ".runs");
const resolveWorkspaceDir = (workspaceKey: string) => join(baseDir, "workspaces", workspaceKey);
const sharedRoot = process.env.SHARED_WORKSPACE_ROOT ?? join(baseDir, "..");
const ledger = {
  runsDir,
  agentId: "kimi-agent",
  daprHttpPort: process.env.DAPR_HTTP_PORT,
};

const PlatformLive = Layer.mergeAll(NodeContext.layer, NodeHttpClient.layer);

const AppLive = Layer.mergeAll(
  makeTracingLive("kimi-agent"),
  KimiRunnerLive.pipe(
    Layer.provide(ClaudeInvokerLive),
    Layer.provide(RunLedgerLive),
    Layer.provide(PlatformLive),
  ),
  RunLedgerLive.pipe(Layer.provide(NodeContext.layer)),
  ExecGitClient.pipe(Layer.provide(NodeContext.layer)),
  NodeContext.layer,
);

const runtime = ManagedRuntime.make(AppLive);
await runtime.runtime();

const fastify = Fastify({ logger: true });
registerAgentRoutesEffect(fastify, { runtime, resolveWorkspaceDir, ledger });
registerCloneRouteEffect(fastify, { runtime, resolveWorkspaceDir, ledger });
registerWorktreeRouteEffect(fastify, { runtime, sharedRoot, ledger });
registerWorkflowRoute(
  fastify,
  new WorkflowBabysitter({
    agentId: "kimi-agent",
    onLog: (msg) => fastify.log.warn(msg),
  }),
);

const port = Number(process.env.APP_PORT ?? 8000);
await fastify.listen({ port, host: "0.0.0.0" });

const shutdown = async (): Promise<void> => {
  await fastify.close();
  await runtime.dispose();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
process.on("uncaughtException", (err) => {
  fastify.log.fatal({ err }, "kimi-agent | uncaught exception — exiting");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  fastify.log.fatal({ err: reason }, "kimi-agent | unhandled rejection — exiting");
  process.exit(1);
});
