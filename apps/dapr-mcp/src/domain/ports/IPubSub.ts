import { Context } from "effect";
import type { DaprPublisherService } from "core-dapr";

/**
 * The pub/sub port. dapr-mcp's publish surface is exactly core-dapr's DaprPublisher
 * service — the adapter delegates 1:1 — so the port reuses that method surface
 * (`publish(pubsubName, topic, data, metadata?)`) and its `DaprPubSubError` failure tag.
 */
export class PubSub extends Context.Tag("PubSub")<PubSub, DaprPublisherService>() {}
