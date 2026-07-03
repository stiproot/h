import { NodeHttpClient } from "@effect/platform-node";
import { ActorHostLive, DaprPublisherLive, GenericActorClientLive } from "core-dapr";
import { Layer, ManagedRuntime } from "effect";
import Fastify from "fastify";

import { ActorStoreLive } from "./infrastructure/dapr-actor-store.ts";
import { PubSubLive } from "./infrastructure/dapr-pubsub.ts";
import { StateStoreLive } from "./infrastructure/dapr-state-store.ts";
import { registerMcpRoutes } from "./presentation/http/mcp.router.ts";
import type { DaprMcpRuntime } from "./presentation/http/mcp.router.ts";

const daprHttpPort = process.env.DAPR_HTTP_PORT ?? "3500";

// One shared ManagedRuntime, built once at startup: every MCP tool call runs through it (see
// mcp.router.ts). Alongside the three tool ports it hosts the GenericActor runtime as a scoped
// layer — its own port (ACTOR_APP_PORT) is the Dapr --app-port, since the sidecar calls actor
// callbacks there; MCP-SSE stays on APP_PORT (Fastify) below. `Layer.orDie` turns any build
// failure (config, sidecar unreachable, actor host startup) into a defect that rejects the
// eager `runtime.runtime()` await and crashes startup — exactly like the legacy
// `await host.start()` throw.
const appLayer = Layer.mergeAll(
  StateStoreLive.pipe(Layer.provide(NodeHttpClient.layer)),
  ActorStoreLive.pipe(Layer.provide(GenericActorClientLive({ daprPort: daprHttpPort }))),
  PubSubLive.pipe(
    Layer.provide(DaprPublisherLive(`http://localhost:${daprHttpPort}`)),
    Layer.provide(NodeHttpClient.layer),
  ),
  ActorHostLive({
    actorPort: process.env.ACTOR_APP_PORT ?? "8010",
    daprHttpPort,
  }),
).pipe(Layer.orDie);

const runtime: DaprMcpRuntime = ManagedRuntime.make(appLayer);

// Build the layers NOW, before Fastify listens: acquiring ActorHostLive runs the legacy actor
// startup sequence (registerActor → waitForSidecar → DaprServer.start → actor.init) on the
// actor port, preserving the load-bearing order — actor runtime up first, MCP listener second.
await runtime.runtime();

const fastify = Fastify({ logger: true });
await registerMcpRoutes(fastify, runtime);

const port = Number(process.env.APP_PORT ?? 8000);
await fastify.listen({ port, host: "0.0.0.0" });

// Fastify owns the MCP listener; the runtime owns the scoped layers. Sequence the two by hand:
// stop accepting MCP requests, then run the layer finalizers (DaprServer.stop for the actor
// host, DaprClient.stop for the actor client) in reverse acquisition order.
const shutdown = async (): Promise<void> => {
  await fastify.close();
  await runtime.dispose();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
