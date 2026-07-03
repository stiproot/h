import * as OtelTracer from "@effect/opentelemetry/Tracer";
import { trace } from "@opentelemetry/api";
import type { SpanContext } from "@opentelemetry/api";
import { Effect } from "effect";

import { contextFromTraceparent } from "./context.ts";

function withExternalParent<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  spanContext: SpanContext | undefined,
): Effect.Effect<A, E, R> {
  if (!spanContext || !trace.isSpanContextValid(spanContext)) return effect;
  return Effect.withParentSpan(
    effect,
    OtelTracer.makeExternalSpan({
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      traceState: spanContext.traceState,
    }),
  );
}

// Fiber-entry trace handoff. The runtime.runPromise entry edges (Fastify handler → Effect
// fiber, Dapr activity callback → Effect fiber) are propagation boundaries: fiber
// continuations resume on Effect's scheduler outside the request's AsyncLocalStorage scope,
// so ambient OTel parenting is NOT guaranteed inside the fiber — without this bridge,
// Effect.withSpan spans can surface as disconnected root traces.
//
// Call it AT the edge, synchronously, while the ambient OTel span (e.g. the withServerSpan
// Fastify hook's server span) is still active: it captures that span's context immediately
// and parents the fiber under it via an external span. When no ambient span exists (tracing
// never initialised, or no active request), the effect is returned unchanged.
//
//   runtime.runPromise(withAmbientParent(handlerEffect))
export function withAmbientParent<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return withExternalParent(effect, trace.getActiveSpan()?.spanContext());
}

// The same handoff for the traceparent-as-data path: parent the fiber under a bare
// `traceparent` string carried across a boundary in-process context cannot survive (e.g.
// Dapr Workflow input replay — see contextFromTraceparent). Falls back to the ambient active
// span when the string is absent, and returns the effect unchanged when neither yields a
// valid span context.
export function withTraceparentParent<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  traceparent: string | undefined,
): Effect.Effect<A, E, R> {
  return withExternalParent(effect, trace.getSpanContext(contextFromTraceparent(traceparent)));
}
