import { Effect, Layer, Option, Schema } from "effect";
import { connect } from "nats";

import type { EngineLease, LeasePort } from "../domain/engines.ts";
import { EventPublisher, EventPublishError } from "engine-core";
import { BUCKETS, type BucketName, type NatsKvService } from "./nats-kv.ts";

/**
 * Helpers over the `NatsKv` PORT — everything the registries share that does not touch a raw
 * JetStream handle.
 *
 * Separate from nats-kv.ts on purpose: that module is the chokepoint where raw handles live and
 * where every call must encode its key, and these take a BUCKET where a raw call takes a key. Kept
 * together they made `check-kv-keys` fire on the abstraction built to satisfy it; kept apart the
 * guard is an exact rule with no exception.
 */

/**
 * Read every row under an id PREFIX, decoding per row.
 *
 * Shared by the registries that hold several row families in one bucket (`cron:sub:` beside
 * `cron:sched:`), so the prefix — not the bucket — is what separates them. A leaked prefix would
 * put sched rows in a recur listing and the engine would try to fire one.
 *
 * A listing DEGRADES rather than aborts: one unreadable row shortens the answer instead of failing
 * a whole scan tick, and the engines are already built for a row to be absent (that is what the
 * unknown-streak machinery is for). Failing here would be strictly worse — it stops every OTHER
 * row from progressing too.
 */
export const listUnder = <A, I>(
  kv: NatsKvService,
  bucket: BucketName,
  prefix: string,
  schema: Schema.Schema<A, I>,
): Effect.Effect<readonly A[], never> =>
  kv.ids(bucket, prefix).pipe(
    Effect.flatMap((ids) =>
      Effect.forEach(ids, (id) => kv.get(bucket, id, schema), { concurrency: 8 }),
    ),
    Effect.map((rows) => rows.flatMap((row) => (Option.isSome(row) ? [row.value] : []))),
    Effect.orElseSucceed(() => [] as readonly A[]),
  );

/**
 * Apply a ledger delta: numeric fields ADD, everything else replaces. The Dapr stores' rule,
 * restated once over KV rather than per registry — a ledger that counted differently on the two
 * substrates would make their daily totals quietly incomparable.
 */
export const mergeCounters = <A extends object>(current: A, delta: Partial<A>): A => {
  const next: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const [field, value] of Object.entries(delta)) {
    const held = (current as Record<string, unknown>)[field];
    next[field] =
      typeof value === "number" && typeof held === "number" ? held + value : (value as unknown);
  }
  return next as A;
};

/**
 * The engine host's singleton lease over KV.
 *
 * Reads carry the REVISION so the caller can compare-and-set against it, which is what makes the
 * lease a real mutual exclusion rather than a polite convention. See `claimLease` for why this is
 * the one place in this substrate that uses `putFenced`.
 */
export const natsLease = (kv: NatsKvService, key: string): LeasePort => ({
  read: () =>
    kv.getVersioned(BUCKETS.engines, key, LeaseSchema).pipe(
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (held) => ({ lease: held.value, revision: held.revision }),
        }),
      ),
      Effect.mapError((error) => error as unknown as Error),
    ),
  write: (lease, revision) =>
    kv
      .putFenced(BUCKETS.engines, key, lease, revision)
      .pipe(Effect.mapError((error) => error as unknown as Error)),
});

const LeaseSchema = Schema.Struct({
  hostId: Schema.String,
  renewedAt: Schema.Number,
}) as unknown as Schema.Schema<EngineLease, unknown>;

/**
 * `EventPublisher` over the fabric — the local half of the port `engine-core`'s scans announce
 * through (the watcher's terminal `workflow-events`, a finalizing chain's `cron-disarm`).
 *
 * Subjects are `h.event.<topic>`, keeping engine announcements out of `h.task.>` (work) and
 * `h.result.>` (a loop's own terminals): three namespaces because a subscriber wanting one of them
 * should not have to filter the other two.
 *
 * JetStream would be the wrong choice here even though these are meaningful events — nothing
 * currently consumes them, and a durable stream nobody reads accumulates forever. Core NATS keeps
 * the announcement honest: it is an announcement, and the durable record is the row the scan just
 * wrote. A consumer that needs replay is the moment to give it a stream.
 */
export const natsEventPublisher = (
  url: string,
): { readonly publish: (topic: string, data: unknown) => Promise<void> } => ({
  publish: async (topic, data) => {
    const nc = await connect({ servers: url, timeout: 3000, maxReconnectAttempts: 2 });
    try {
      nc.publish(`h.event.${topic}`, new TextEncoder().encode(JSON.stringify(data)));
      await nc.flush();
    } finally {
      await nc.drain();
    }
  },
});

/** The port binding for the publisher above. */
export const NatsEventPublisherLive = (url: string): Layer.Layer<EventPublisher> => {
  const client = natsEventPublisher(url);
  return Layer.succeed(EventPublisher, {
    publish: (topic, data) =>
      Effect.tryPromise({
        try: () => client.publish(topic, data),
        catch: (cause) => new EventPublishError({ topic, cause }),
      }),
  });
};
