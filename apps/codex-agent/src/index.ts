import { join } from "path";

import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { CodexInvokerLive } from "agent-cli";
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

import { DEFAULT_AGENT_BASE_DIR, CodexRunnerLive } from "./infrastructure/codex-runner.ts";

const baseDir = process.env.AGENT_BASE_DIR ?? DEFAULT_AGENT_BASE_DIR;
const runsDir = process.env.AGENT_RUNS_DIR ?? join(baseDir, "..", ".runs");
const sharedRoot = process.env.SHARED_WORKSPACE_ROOT ?? join(baseDir, "..");
const resolveWorkspaceDir = (workspaceKey: string): string => join(baseDir, workspaceKey);
const ledger = { runsDir, agentId: "codex-agent", daprHttpPort: process.env.DAPR_HTTP_PORT };

const PlatformLive = Layer.mergeAll(NodeContext.layer, NodeHttpClient.layer);
const LoggerLayer = LoggerLive("codex-agent", {
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  PRETTY_LOGS: process.env.PRETTY_LOGS,
  NODE_ENV: process.env.NODE_ENV,
});
const RunLedgerLayer = RunLedgerLive.pipe(Layer.provide(NodeContext.layer));

const RunnerLive = CodexRunnerLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      CodexInvokerLive.pipe(Layer.provide(PlatformLive)),
      RunLedgerLayer,
      LoggerLayer,
      NodeContext.layer,
    ),
  ),
);

const AppLive = Layer.mergeAll(
  makeTracingLive("codex-agent"),
  NodeContext.layer,
  RunLedgerLayer,
  ExecGitClient.pipe(Layer.provide(NodeContext.layer)),
  RunnerLive,
).pipe(Layer.orDie);

const runtime = ManagedRuntime.make(AppLive);
await runtime.runtime();

const fastify = Fastify({ logger: true });
registerAgentRoutesEffect(fastify, { runtime, resolveWorkspaceDir, ledger });
registerCloneRouteEffect(fastify, { runtime, resolveWorkspaceDir, ledger });
registerWorktreeRouteEffect(fastify, { runtime, sharedRoot, ledger });
registerWorkflowRoute(
  fastify,
  new WorkflowBabysitter({
    agentId: "codex-agent",
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
