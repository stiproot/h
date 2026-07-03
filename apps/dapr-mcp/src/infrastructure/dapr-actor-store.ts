import { GenericActorClientTag } from "core-dapr";
import { Layer } from "effect";

import { ActorStore } from "../domain/ports/IActorStore.ts";

/**
 * Live layer for the actor port: a pure delegation to core-dapr's GenericActorClient
 * service (which talks to the local sidecar — same host/port as StateStoreLive). The
 * composition root discharges the requirement with `GenericActorClientLive(...)`, whose
 * scoped layer owns the underlying DaprClient and stops it on runtime dispose.
 */
export const ActorStoreLive: Layer.Layer<ActorStore, never, GenericActorClientTag> = Layer.effect(
  ActorStore,
  GenericActorClientTag,
);
