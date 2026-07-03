// Effect surface — tags, layers, and local error tags. DaprInvokeError (the invoker's
// failure) lives in `core` — it crosses the TS-to-TS Dapr-invoke boundary.
export { DaprInvokerLive, DaprInvokerTag } from "./invoker.ts";
export type { DaprInvokerService } from "./invoker.ts";
export { DaprPublisherLive, DaprPublisherTag, DaprPubSubError } from "./publisher.ts";
export type { DaprPublisherService } from "./publisher.ts";
export {
  DaprActorError,
  GenericActorClientLive,
  GenericActorClientTag,
} from "./actors/actor-client.ts";
export type { GenericActorClientService } from "./actors/actor-client.ts";
export { ActorHostLive, ActorHostTag } from "./actors/actor-host.ts";
export type { ActorHostService } from "./actors/actor-host.ts";
export {
  DaprSidecarError,
  retryUntilReady,
  waitForSidecarEffect,
} from "./actors/wait-for-sidecar.ts";

// The actor implementation stays a plain @dapr/dapr AbstractActor subclass — the SDK
// resolves actor callbacks by class name and property keys via reflection.
export { GenericActor } from "./actors/generic-actor.ts";
export type { ActorStateResult, IGenericActor } from "./actors/generic-actor.ts";
export { GenericActorClient } from "./actors/actor-client.ts";
export type { GenericActorClientOptions } from "./actors/actor-client.ts";
export type { ActorHostOptions } from "./actors/actor-host.ts";
