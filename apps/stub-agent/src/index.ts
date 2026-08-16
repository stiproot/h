import { join } from "path";

import { NodeContext } from "@effect/platform-node";
import {
  registerAgentRoutesEffect,
  registerWorkflowRoute,
  RunLedgerLive,
  WorkflowBabysitter,
} from "agent-server";
import { Layer, ManagedRuntime } from "effect";
import Fastify from "fastify";
import { makeTracingLive } from "telemetry";

import { StubRunnerLive } from "./infrastructure/stub-runner.ts";

const baseDir = process.env.AGENT_BASE_DIR ?? "/workspace/stub-agent";
const runsDir = process.env.AGENT_RUNS_DIR ?? join(baseDir, "..", ".runs");
const resolveWorkspaceDir = (workspaceKey: string) => join(baseDir, "workspaces", workspaceKey);
const ledger = {
  runsDir,
  agentId: "stub-agent",
  daprHttpPort: process.env.DAPR_HTTP_PORT,
};

const AppLive = Layer.mergeAll(
  makeTracingLive("stub-agent"),
  StubRunnerLive.pipe(Layer.provide(RunLedgerLive), Layer.provide(NodeContext.layer)),
  RunLedgerLive.pipe(Layer.provide(NodeContext.layer)),
  NodeContext.layer,
);

const runtime = ManagedRuntime.make(AppLive);
await runtime.runtime();

const fastify = Fastify({ logger: true });
registerAgentRoutesEffect(fastify, { runtime, resolveWorkspaceDir, ledger });
registerWorkflowRoute(
  fastify,
  new WorkflowBabysitter({
    agentId: "stub-agent",
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
  fastify.log.fatal({ err }, "stub-agent | uncaught exception — exiting");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  fastify.log.fatal({ err: reason }, "stub-agent | unhandled rejection — exiting");
  process.exit(1);
});
