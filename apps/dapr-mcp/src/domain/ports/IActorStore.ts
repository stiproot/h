import { Context } from "effect";
import type { GenericActorClientService } from "core-dapr";

/**
 * The actor port. dapr-mcp's actor surface is exactly core-dapr's GenericActorClient
 * service — the adapter delegates 1:1 — so the port reuses that method surface (invoke,
 * state get/set/remove/keys, reminder/timer register/unregister, listActiveActors) and
 * its `DaprActorError` failure tag rather than restating them.
 */
export class ActorStore extends Context.Tag("ActorStore")<
  ActorStore,
  GenericActorClientService
>() {}
