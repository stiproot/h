import { DaprPublisherTag } from "core-dapr";
import { Effect, Layer } from "effect";
import { EventPublisher, EventPublishError } from "engine-core";

/**
 * The service substrate's adapter for `engine-core`'s `EventPublisher` port: an engine names a
 * TOPIC, and this binds it to a Dapr pub/sub component.
 *
 * The component name is the whole reason this adapter exists. `"pubsub"` is a Dapr deployment
 * detail — the name of a `pubsub.redis` Component this cluster happens to have — and the engines
 * used to carry it as a literal at every publish site, which is what tied their sequencing logic to
 * this substrate. Now the host closes over it and the engines are free of it; a NATS host binds the
 * same topics to subjects instead.
 */
const PUBSUB = "pubsub";

export const DaprEventPublisherLive: Layer.Layer<EventPublisher, never, DaprPublisherTag> =
  Layer.effect(
    EventPublisher,
    Effect.gen(function* () {
      const publisher = yield* DaprPublisherTag;
      return {
        publish: (topic: string, data: unknown) =>
          publisher
            .publish(PUBSUB, topic, data)
            .pipe(Effect.mapError((cause) => new EventPublishError({ topic, cause }))),
      };
    }),
  );
