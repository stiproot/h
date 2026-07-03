import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Context, Data, Effect, Layer } from "effect";
import { injectTraceContext } from "telemetry";

// Dapr publish metadata rides as metadata.<key> query params (e.g. metadata.ttlInSeconds,
// metadata.cloudevent.type to override a CloudEvents field).
function publishUrl(
  sidecarBase: string,
  pubsubName: string,
  topic: string,
  metadata?: Record<string, string>,
): string {
  const base = `${sidecarBase}/v1.0/publish/${encodeURIComponent(pubsubName)}/${encodeURIComponent(topic)}`;
  if (!metadata) return base;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(metadata)) qs.append(`metadata.${k}`, v);
  const query = qs.toString();
  return query ? `${base}?${query}` : base;
}

/** A Dapr pub/sub publish failed (network, non-ok status, unserialisable payload). */
export class DaprPubSubError extends Data.TaggedError("DaprPubSubError")<{
  readonly cause: unknown;
  readonly pubsubName: string;
  readonly topic: string;
}> {}

/** The Dapr pub/sub publish port. Publishing is fire-and-forget on the Dapr side. */
export interface DaprPublisherService {
  readonly publish: (
    pubsubName: string,
    topic: string,
    data: unknown,
    metadata?: Record<string, string>,
  ) => Effect.Effect<void, DaprPubSubError>;
}

/** Service tag for the publisher. Yield it to publish: `const pub = yield* DaprPublisherTag`. */
export class DaprPublisherTag extends Context.Tag("DaprPublisher")<
  DaprPublisherTag,
  DaprPublisherService
>() {}

/**
 * Live layer over the sidecar's publish HTTP API. The `HttpClient` requirement is captured
 * at layer build so the port method stays `R = never` — consumers provide
 * `NodeHttpClient.layer` when building this layer.
 *
 * Each publish runs under a CLIENT span; the injected `traceparent` header is what Dapr
 * copies into the CloudEvents traceid, so subscribers continue this trace. Degrades to
 * plain headers when tracing isn't initialised.
 */
export const DaprPublisherLive = (
  sidecarBase: string,
): Layer.Layer<DaprPublisherTag, never, HttpClient.HttpClient> =>
  Layer.effect(
    DaprPublisherTag,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return {
        publish: (pubsubName, topic, data, metadata) =>
          Effect.gen(function* () {
            // Read the traceparent inside the span region so the header carries the CLIENT span.
            const headers = yield* Effect.sync(() => injectTraceContext({}));
            const request = yield* HttpClientRequest.bodyJson(
              HttpClientRequest.post(publishUrl(sidecarBase, pubsubName, topic, metadata)).pipe(
                HttpClientRequest.setHeaders(headers),
              ),
              data,
            );
            const response = yield* client.execute(request);
            if (response.status < 200 || response.status >= 300) {
              const text = yield* response.text;
              return yield* new DaprPubSubError({
                cause: new Error(`Dapr publish failed: ${response.status} ${text}`),
                pubsubName,
                topic,
              });
            }
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof DaprPubSubError
                ? cause
                : new DaprPubSubError({ cause, pubsubName, topic }),
            ),
            Effect.asVoid,
            Effect.withSpan(`publish ${pubsubName}/${topic}`, {
              kind: "client",
              attributes: { "dapr.pubsub": pubsubName, "dapr.topic": topic },
            }),
          ),
      };
    }),
  );
