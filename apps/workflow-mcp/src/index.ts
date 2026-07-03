import { NodeHttpClient } from "@effect/platform-node";
import { Layer, ManagedRuntime } from "effect";
import Fastify from "fastify";
import { makeTracingLive } from "telemetry";

import { WorkflowServiceLive } from "./infrastructure/dapr-workflow-service.ts";
import { registerMcpRoutes } from "./presentation/http/mcp.router.ts";
import type { McpToolRuntime } from "./presentation/http/mcp.router.ts";

// One shared ManagedRuntime, built once at startup: every MCP tool call runs through it (see
// mcp.router.ts). The tracing layer is scoped — dispose() flushes and shuts the provider down,
// replacing the legacy initTracing process.once hooks. WorkflowServiceLive's HttpClient
// requirement is discharged here so the merged layer is requirement-free.
const appLayer = Layer.mergeAll(
  makeTracingLive("workflow-mcp"),
  WorkflowServiceLive.pipe(Layer.provide(NodeHttpClient.layer)),
);
const runtime: McpToolRuntime = ManagedRuntime.make(appLayer);

const fastify = Fastify({ logger: true });
await registerMcpRoutes(fastify, runtime);

const port = Number(process.env.APP_PORT ?? 8000);
await fastify.listen({ port, host: "0.0.0.0" });

// Fastify owns the listener; the runtime owns the scoped layers. Sequence the two lifecycles by
// hand: stop accepting requests, then run the layer finalizers (tracing flush).
async function shutdown(): Promise<void> {
  await fastify.close();
  await runtime.dispose();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
