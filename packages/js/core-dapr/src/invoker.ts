import { HttpClient, HttpClientRequest } from "@effect/platform";
import { AgentRequest, AgentResponse, DaprInvokeError } from "core";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import { injectTraceContext } from "telemetry";

// An agent CLI can run for many minutes before its HTTP response is sent. The runtime's default
// fetch timeout is far shorter — Bun aborts a response-less request after ~255s — which surfaced as a
// false "operation timed out" while the agent had actually completed. Set an explicit deadline above
// the 30-min agent run cap (AGENT_RUN_TIMEOUT_MS) and under the 1h Dapr resiliency timeout, so the
// agent's own timeout returns a clean result before the invoke aborts. Override with DAPR_INVOKE_TIMEOUT_MS.
const INVOKE_TIMEOUT_MS = Number(process.env.DAPR_INVOKE_TIMEOUT_MS ?? 3_300_000);

/**
 * The Dapr service-invocation port. Failures are always `DaprInvokeError` (from `core` —
 * it crosses the TS-to-TS Dapr-invoke boundary); the raw HTTP/decode failure rides in
 * its `cause`.
 */
export interface DaprInvokerService {
  readonly invoke: (
    appId: string,
    method: string,
    body: AgentRequest,
  ) => Effect.Effect<AgentResponse, DaprInvokeError>;
}

/** Service tag for the invoker. Yield it to call: `const invoker = yield* DaprInvokerTag`. */
export class DaprInvokerTag extends Context.Tag("DaprInvoker")<
  DaprInvokerTag,
  DaprInvokerService
>() {}

/**
 * Live layer over the sidecar's invoke HTTP API. The `HttpClient` requirement is captured
 * at layer build, so the port methods stay `R = never` — consumers provide
 * `NodeHttpClient.layer` (from `@effect/platform-node`) when building this layer.
 *
 * Each invoke runs under a CLIENT span (`Effect.withSpan`); the outgoing request carries
 * the W3C `traceparent` via `injectTraceContext`, read inside the fiber where
 * `@effect/opentelemetry`'s tracer bridges the Effect span into the ambient OTel context —
 * so the callee continues this trace. Degrades to plain headers when tracing isn't
 * initialised, exactly like the legacy `withClientSpan` path.
 */
export const DaprInvokerLive = (
  sidecarBase: string,
  opts: { readonly timeoutMs?: number } = {},
): Layer.Layer<DaprInvokerTag, never, HttpClient.HttpClient> =>
  Layer.effect(
    DaprInvokerTag,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const timeoutMs = opts.timeoutMs ?? INVOKE_TIMEOUT_MS;
      return {
        invoke: (appId, method, body) => {
          const asInvokeError = (cause: unknown): DaprInvokeError =>
            cause instanceof DaprInvokeError
              ? cause
              : new DaprInvokeError({ cause, appId, method });
          return Effect.gen(function* () {
            // Read the traceparent inside the span region so the header carries the CLIENT span.
            const headers = yield* Effect.sync(() => injectTraceContext({}));
            const request = yield* HttpClientRequest.bodyJson(
              HttpClientRequest.post(`${sidecarBase}/v1.0/invoke/${appId}/method/${method}`).pipe(
                HttpClientRequest.setHeaders(headers),
              ),
              body,
            );
            const response = yield* client.execute(request);
            if (response.status < 200 || response.status >= 300) {
              const text = yield* response.text;
              return yield* new DaprInvokeError({
                cause: new Error(`Dapr invoke failed: ${response.status} ${text}`),
                appId,
                method,
              });
            }
            const json = yield* response.json;
            return yield* Schema.decodeUnknown(AgentResponse)(json);
          }).pipe(
            Effect.timeoutFail({
              duration: Duration.millis(timeoutMs),
              onTimeout: () =>
                new DaprInvokeError({
                  cause: new Error(`Dapr invoke timed out after ${timeoutMs}ms`),
                  appId,
                  method,
                }),
            }),
            Effect.mapError(asInvokeError),
            Effect.withSpan(`invoke ${appId}/${method}`, {
              kind: "client",
              attributes: { "dapr.app_id": appId, "dapr.method": method },
            }),
          );
        },
      };
    }),
  );
