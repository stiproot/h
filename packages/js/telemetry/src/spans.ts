import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

import { extractContext } from "./context.ts";
import { getTracer } from "./tracing.ts";

type InboundHeaders = Record<string, string | string[] | undefined>;

function fail(span: ReturnType<Tracer["startSpan"]>, err: unknown): never {
  span.recordException(err as Error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: String((err as Error)?.message ?? err) });
  throw err;
}

type Tracer = ReturnType<typeof getTracer>;

// Continue a trace from inbound headers under a SERVER span, with that span active for the
// duration of `fn` (so any outbound call inside `fn` becomes its child via ambient context).
export async function withServerSpan<T>(
  name: string,
  headers: InboundHeaders,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = extractContext(headers);
  const span = getTracer().startSpan(name, { kind: SpanKind.SERVER }, parent);
  try {
    return await context.with(trace.setSpan(parent, span), fn);
  } catch (err) {
    return fail(span, err);
  } finally {
    span.end();
  }
}
