import { Context, Data, type Effect } from "effect";

/**
 * The one EFFECT an engine has that is neither a store write nor a fire: announcing something on a
 * named topic. Two engines use it — the watcher publishes a run's terminal outcome, and a
 * finalizing chain publishes `cron-disarm` for every member-armed cron (the loose pub/sub edge that
 * keeps cron:sub's single-writer invariant intact).
 *
 * It exists as a port because it was the LAST concrete dependency in the scan layer: both call
 * sites reached for `core-dapr`'s `DaprPublisherTag` directly, which pinned the sequencing logic to
 * one substrate and — as it turned out — slipped past the `domain-no-io-libs` boundary rule, whose
 * path pattern only matched IO packages resolved through `node_modules`.
 *
 * Deliberately NARROWER than the Dapr publisher it replaces: no `pubsubName`. A component name is a
 * Dapr concept, so the host binds it (workflow-svc's adapter closes over `"pubsub"`; a NATS host
 * maps the topic to a subject). The engine names the topic and nothing else.
 *
 * Publishing is FIRE-AND-FORGET and every current call site `Effect.ignore`s the result: an
 * announcement that does not land must never fail the scan that made it. The error channel stays
 * typed anyway so an adapter can report and a future consumer can choose to care — a port that
 * cannot express failure removes that choice for everyone.
 */

/** A publish did not land (transport, encoding, or a rejecting broker). */
export class EventPublishError extends Data.TaggedError("EventPublishError")<{
  readonly topic: string;
  readonly cause?: unknown;
}> {}

export interface EventPublisherService {
  readonly publish: (topic: string, data: unknown) => Effect.Effect<void, EventPublishError>;
}

/** Service tag for the publisher. Yield it to publish: `const pub = yield* EventPublisher`. */
export class EventPublisher extends Context.Tag("EventPublisher")<
  EventPublisher,
  EventPublisherService
>() {}
