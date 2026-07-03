import * as OtelResource from "@effect/opentelemetry/Resource";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import { context, trace } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { ZipkinExporter } from "@opentelemetry/exporter-zipkin";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Effect, Layer } from "effect";

let provider: NodeTracerProvider | undefined;

function resolveServiceName(serviceName?: string): string {
  return serviceName ?? process.env.OTEL_SERVICE_NAME ?? "unknown-service";
}

// Stand up the OTel SDK exporting to Zipkin, register it globally, and register the W3C
// tracecontext propagator (the same format Dapr's sidecars speak, so app spans and Dapr spans
// share one trace tree). Idempotent: a second call returns the existing provider. Until this
// runs, the @opentelemetry/api globals stay no-op, so the helpers in this package degrade
// gracefully in processes that never initialise tracing.
function acquireProvider(name: string): NodeTracerProvider {
  if (provider) return provider;

  const url = process.env.ZIPKIN_ENDPOINT ?? "http://localhost:9411/api/v2/spans";

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": name }),
    spanProcessors: [new BatchSpanProcessor(new ZipkinExporter({ url, serviceName: name }))],
  });

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  provider.register({ propagator: new W3CTraceContextPropagator() });

  return provider;
}

// Flush + shutdown, swallowing errors — observability must never break a shutdown path.
async function releaseProvider(p: NodeTracerProvider): Promise<void> {
  try {
    await p.forceFlush();
    await p.shutdown();
  } catch {
    // best-effort: buffered spans are lost, nothing else to do
  }
  if (provider === p) provider = undefined;
}

export function getTracer(): Tracer {
  return trace.getTracer("telemetry");
}

// Scoped Layer owning the OTel provider lifecycle for Effect-managed apps: acquires the
// globally-registered NodeTracerProvider (shared singleton, so the plain-function helpers in
// this package and Effect spans ride one provider), and registers flush + shutdown as a scope
// finalizer — ManagedRuntime.dispose() owns the flush-on-shutdown. It also installs
// @effect/opentelemetry's tracer, so Effect.withSpan spans export to the same Zipkin endpoint and
// parent/child-link with spans made via the OTel API.
export function makeTracingLive(serviceName?: string): Layer.Layer<OtelTracer.OtelTracer> {
  const providerLive = Layer.scoped(
    OtelTracer.OtelTracerProvider,
    Effect.acquireRelease(
      Effect.sync(() => acquireProvider(resolveServiceName(serviceName))),
      (p) => Effect.promise(() => releaseProvider(p)),
    ),
  );
  const resourceLive = Layer.sync(OtelResource.Resource, () =>
    resourceFromAttributes({ "service.name": resolveServiceName(serviceName) }),
  );
  return OtelTracer.layer.pipe(Layer.provide(providerLive), Layer.provide(resourceLive));
}

// Default layer: service name from OTEL_SERVICE_NAME.
export const TracingLive: Layer.Layer<OtelTracer.OtelTracer> = makeTracingLive();
