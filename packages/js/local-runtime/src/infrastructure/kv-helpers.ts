import { Effect, Option, Schema } from "effect";

import type { EngineLease, LeasePort } from "../domain/engines.ts";
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
