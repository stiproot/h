import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { Layer, ManagedRuntime } from "effect";
import Fastify from "fastify";
import { makeTracingLive } from "telemetry";

import { ObservabilityServiceLive } from "./infrastructure/observability-service.ts";
import { registerMcpRoutes } from "./presentation/http/mcp.router.ts";

// One requirement-free layer per concern, merged and compiled once: tracing (scoped — its
// finalizer flushes spans on dispose, replacing initTracing's process.once hooks) and the
// observability port with its platform needs (HttpClient for Zipkin/Loki, FileSystem for the
// run ledger) discharged at build.
const AppLive = Layer.mergeAll(
  makeTracingLive("obs-mcp"),
  ObservabilityServiceLive.pipe(
    Layer.provide(Layer.mergeAll(NodeHttpClient.layer, NodeContext.layer)),
  ),
);

const runtime = ManagedRuntime.make(AppLive);
// Build the layers now (not lazily on the first tool call) so the OTel provider is registered
// before the first request — the Fastify-edge withServerSpan relies on the global tracer.
await runtime.runtime();

const fastify = Fastify({ logger: true });
await registerMcpRoutes(fastify, runtime);

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
