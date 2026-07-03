import { context, propagation } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";

type Carrier = Record<string, string>;
type InboundHeaders = Record<string, string | string[] | undefined>;

// Inject the active (or given) trace context into a header bag as a W3C `traceparent`.
export function injectTraceContext(
  headers: Carrier = {},
  ctx: Context = context.active(),
): Carrier {
  propagation.inject(ctx, headers);
  return headers;
}

// Continue a remote trace from inbound request headers.
export function extractContext(headers: InboundHeaders): Context {
  return propagation.extract(context.active(), headers);
}

// Rebuild a context from a bare `traceparent` string carried as data across an async boundary
// (e.g. through Dapr Workflow input, where in-process context can't survive replay).
export function contextFromTraceparent(traceparent?: string): Context {
  if (!traceparent) return context.active();
  return propagation.extract(context.active(), { traceparent });
}

// Read the active `traceparent` string so it can be carried as data (see contextFromTraceparent).
export function activeTraceparent(ctx: Context = context.active()): string | undefined {
  const carrier: Carrier = {};
  propagation.inject(ctx, carrier);
  return carrier.traceparent;
}
