import { WorkflowRuntime } from "@dapr/dapr";
import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { DaprInvokerLive, DaprPublisherLive, waitForSidecarEffect } from "core-dapr";
import { Layer, ManagedRuntime } from "effect";
import Fastify from "fastify";
import { makeTracingLive } from "telemetry";

import { activities } from "./infrastructure/activity-registry.ts";
import { setActivityRuntime } from "./infrastructure/activity-runtime.ts";
import { ChainStoreLive } from "./infrastructure/dapr-chain-store.ts";
import { CronStoreLive } from "./infrastructure/dapr-cron-store.ts";
import { WatchStoreLive } from "./infrastructure/dapr-watch-store.ts";
import { WfStoreLive } from "./infrastructure/dapr-wf-store.ts";
import { WorkflowInvokerLive } from "./infrastructure/dapr-workflow-invoker.ts";
import { WorkflowStoreLive } from "./infrastructure/dapr-workflow-store.ts";
import { genericWorkflow } from "./infrastructure/workflows/generic.workflow.ts";
import { registerChainRoutes } from "./presentation/http/chain.router.ts";
import { registerCronRoutes } from "./presentation/http/cron.router.ts";
import { registerTriggerRoutes } from "./presentation/http/trigger.router.ts";
import { registerWatchRoutes } from "./presentation/http/watch.router.ts";
import { registerWorkflowRoutes } from "./presentation/http/workflow.router.ts";

const daprHttpPort = process.env.DAPR_HTTP_PORT ?? "3500";

// One shared ManagedRuntime, built once at startup and entered at exactly two edges: the
// Fastify route handlers (via runRoute) and the Dapr activity callbacks (via runActivity).
// The tracing layer is scoped — dispose() flushes and shuts the provider down, replacing
// the legacy initTracing process.once hooks. Adapter HttpClient requirements are discharged
// here so the merged layer is requirement-free; NodeHttpClient/NodeContext are ALSO merged
// in (not only provided) because the activity effects yield HttpClient and FileSystem
// directly. `Layer.orDie` turns any build failure into a defect that rejects the eager
// `runtime.runtime()` await and crashes startup — exactly like the legacy throws.
const appLayer = Layer.mergeAll(
  makeTracingLive("workflow-svc"),
  WorkflowInvokerLive.pipe(Layer.provide(NodeHttpClient.layer)),
  WorkflowStoreLive,
  WatchStoreLive,
  ChainStoreLive,
  CronStoreLive,
  WfStoreLive,
  DaprInvokerLive(`http://localhost:${daprHttpPort}`).pipe(Layer.provide(NodeHttpClient.layer)),
  DaprPublisherLive(`http://localhost:${daprHttpPort}`).pipe(Layer.provide(NodeHttpClient.layer)),
  NodeHttpClient.layer,
  NodeContext.layer,
).pipe(Layer.orDie);

const runtime = ManagedRuntime.make(appLayer);
// Eager build: tracing and the SDK clients come up now, before anything serves traffic.
await runtime.runtime();

// The activity callbacks run their Effect bodies through the same runtime (set once; the
// Dapr WorkflowRuntime invokes them outside Effect on its own schedule).
setActivityRuntime(runtime);

// The WorkflowRuntime lifecycle is deliberately hand-sequenced OUTSIDE the runtime's scope,
// like Fastify's own listener: it is not a scoped layer and its stop is not owned by
// runtime.dispose() (a scoped layer would double-invoke stop and acquire at layer build
// rather than after the sidecar is ready — see the refactor map's runtime composition).
const workflowRuntime = new WorkflowRuntime();
workflowRuntime.registerWorkflow(genericWorkflow);
for (const activity of activities) {
  workflowRuntime.registerActivity(activity);
}

const fastify = Fastify({ logger: true });
registerWorkflowRoutes(fastify, runtime);
registerCronRoutes(fastify, runtime);
registerTriggerRoutes(fastify, runtime);
registerWatchRoutes(fastify, runtime);
registerChainRoutes(fastify, runtime);

// The sidecar must be up (components loaded, placement connected) before the workflow
// worker connects to it.
await runtime.runPromise(waitForSidecarEffect(daprHttpPort));

workflowRuntime.start().catch((err: unknown) => {
  console.error("WorkflowRuntime error:", err);
  process.exit(1);
});

const port = Number(process.env.APP_PORT ?? 8000);
await fastify.listen({ port, host: "0.0.0.0" });

// Shutdown sequence: stop the workflow worker (waits for in-flight work items), stop
// accepting HTTP, then run the layer finalizers (DaprWorkflowClient.stop, DaprClient.stop,
// tracing flush) in reverse acquisition order.
const shutdown = async (): Promise<void> => {
  try {
    await workflowRuntime.stop();
  } catch {
    // the worker may never have started; shutdown proceeds regardless
  }
  await fastify.close();
  await runtime.dispose();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
