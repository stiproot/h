import { Context, Data } from "effect";
import type { Effect } from "effect";

/** A Dapr pub/sub publish failed (network, non-ok status, unserialisable payload). */
export class DaprPubSubError extends Data.TaggedError("DaprPubSubError")<{
  readonly cause: unknown;
  readonly pubsubName: string;
  readonly topic: string;
}> {}

/**
 * The pub/sub port. Publishing is fire-and-forget on the Dapr side.
 *
 * The shape matches core-dapr's `DaprPublisherService` exactly and is nonetheless RESTATED here,
 * like its sibling `IStateStore` — the domain declares what it needs, and `infrastructure/` binds
 * an adapter to it. Importing the adapter's own interface would invert that: `domain/` would
 * depend on an I/O package, which is the one thing the layering forbids (and, until the boundary
 * rule's path patterns were fixed on 2026-08-16, silently allowed).
 *
 * Restating costs nothing in drift risk, because `PubSubLive` delegates by identity: if core-dapr's
 * surface ever diverges from this one, that assignment stops compiling. The coupling is still
 * there — it is just checked now instead of assumed.
 */
export class PubSub extends Context.Tag("PubSub")<
  PubSub,
  {
    readonly publish: (
      pubsubName: string,
      topic: string,
      data: unknown,
      metadata?: Record<string, string>,
    ) => Effect.Effect<void, DaprPubSubError>;
  }
>() {}
