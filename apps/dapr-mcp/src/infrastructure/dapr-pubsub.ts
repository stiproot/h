import { DaprPublisherTag } from "core-dapr";
import { Layer } from "effect";

import { PubSub } from "../domain/ports/IPubSub.ts";

/**
 * Live layer for the pub/sub port: a pure delegation to core-dapr's DaprPublisher service
 * (which POSTs to the local sidecar's publish API — same host/port as the other adapters).
 * The composition root discharges the requirement with `DaprPublisherLive(sidecarBase)`.
 */
export const PubSubLive: Layer.Layer<PubSub, never, DaprPublisherTag> = Layer.effect(
  PubSub,
  DaprPublisherTag,
);
