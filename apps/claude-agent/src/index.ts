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

import { ClaudeRunnerLive } from "./infrastructure/claude-runner.ts";

const baseDir = process.env.AGENT_BASE_DIR ?? "/workspace/claude-agent";
// Shared run-ledger root, visible to every agent and the host (sibling of the per-agent base dir).
const runsDir = process.env.AGENT_RUNS_DIR ?? join(baseDir, "..", ".runs");

const resolveWorkspaceDir = (workspaceKey: string) => join(baseDir, "workspaces", workspaceKey);
// Shared, agent-neutral root (sibling of every agent's base dir) where the pre-cloned target repo
// and per-run worktrees live, so a worktree resolves to the same path in every agent container.
const sharedRoot = process.env.SHARED_WORKSPACE_ROOT ?? join(baseDir, "..");

// Lets the setup/clone/worktree routes record their outcomes into the run ledger, so a failed
// precondition is visible there and not only as a Zipkin span.
const ledger = { runsDir, agentId: "claude-agent", daprHttpPort: process.env.DAPR_HTTP_PORT };

// Platform capabilities (FileSystem + CommandExecutor via NodeContext, HttpClient for the
// invoker's LiteLLM check) — provided into the dependent layers below, and NodeContext is
// also merged at the top level because the shared routes (/setup, /clone, /worktree) yield
// FileSystem/CommandExecutor directly from the runtime.
const PlatformLive = Layer.mergeAll(NodeContext.layer, NodeHttpClient.layer);

// One requirement-free layer per concern (inter-layer deps discharged with Layer.provide,
// mergeAll combining only the requirement-free results), compiled once into a ManagedRuntime:
// tracing (scoped — its finalizer flushes spans on dispose, replacing initTracing's
// process.once hooks), the claude runner with its invoker/ledger/platform needs, the run
// ledger and git client for the shared routes, and the platform services themselves.
const AppLive = Layer.mergeAll(
  makeTracingLive("claude-agent"),
  ClaudeRunnerLive.pipe(
    Layer.provide(ClaudeInvokerLive),
    Layer.provide(RunLedgerLive),
    Layer.provide(PlatformLive),
  ),
  RunLedgerLive.pipe(Layer.provide(NodeContext.layer)),
  ExecGitClient.pipe(Layer.provide(NodeContext.layer)),
  NodeContext.layer,
);

const runtime = ManagedRuntime.make(AppLive);
// Build the layers now (not lazily on the first request) so the OTel provider is registered
// before the first request — the Fastify-edge withServerSpan relies on the global tracer.
await runtime.runtime();

const fastify = Fastify({ logger: true });
registerAgentRoutesEffect(fastify, { runtime, resolveWorkspaceDir, ledger });
registerCloneRouteEffect(fastify, { runtime, resolveWorkspaceDir, ledger });
registerWorktreeRouteEffect(fastify, { runtime, sharedRoot, ledger });
// The standard workflow endpoint: submit-and-babysit (non-blocking) — makes this agent
// service a workflow entry point on the same contract as every other agent service.
registerWorkflowRoute(
  fastify,
  new WorkflowBabysitter({
    agentId: "claude-agent",
    onLog: (msg) => fastify.log.warn(msg),
  }),
);

const port = Number(process.env.APP_PORT ?? 8000);
await fastify.listen({ port, host: "0.0.0.0" });

// Shutdown: close the listener first, then dispose the runtime (runs the tracing flush finalizer).
const shutdown = async (): Promise<void> => {
  await fastify.close();
  await runtime.dispose();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
