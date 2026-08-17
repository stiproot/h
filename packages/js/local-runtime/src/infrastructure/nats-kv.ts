import { WorkflowError } from "core";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { connect, type NatsConnection } from "nats";
import type { KV } from "nats";

import { kvId, kvKey } from "./kv-key.ts";

/**
 * The local substrate's registry storage: JetStream KV buckets, one per registry, behind the same
 * `engine-core` store ports the Dapr/Redis adapters implement.
 *
 * CONNECTION LIFETIME differs deliberately from `nats-journal.ts`, which connects per call. The
 * journal appends once per completed stage — minutes apart — so a held connection would be one more
 * thing to unwind on every exit path. A registry is read many times per engine tick, so this layer
 * holds ONE connection for its scope and closes it on release.
 *
 * Three things are simpler here than on the Redis side, and none of them is a shortcut:
 *
 *  - **No index keys.** `watch:index`, `cron:discover-index`, `__workflow_index__` and friends exist
 *    because Redis cannot enumerate a prefix cheaply. KV lists keys natively, so `listRows` reads
 *    the bucket — and a whole class of index/row drift stops being possible.
 *  - **Real compare-and-set.** The rows keep their `epoch` field (a domain concept both substrates
 *    compare), but Redis enforces it by read-then-write with a race in between. KV's `update(key,
 *    value, revision)` rejects a stale write outright, so the local fence is strictly stronger.
 *  - **No `run:` mirrors.** Those exist so workflow-svc can see the run ledger over Dapr. Here the
 *    ledger is on local disk; the cost tally reads it directly.
 *
 * Every key goes through `kvKey` — NATS rejects the `:` that every registry id is built from, and
 * an unencoded key fails as an ABSENT row rather than an error (`scripts/check-kv-keys.mjs`).
 */

/** One bucket per registry, so single-writer ownership is a bucket-level fact. */
export const BUCKETS = {
  /** The engine host's own bucket — currently just its singleton lease. */
  engines: "h-engines",
  watch: "h-watch",
  chain: "h-chain",
  cron: "h-cron",
  wf: "h-wf",
  exec: "h-exec",
  workflows: "h-workflows",
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

/** A row read back with the revision it was read AT — the token a fenced write must present. */
export type Versioned<A> = { readonly value: A; readonly revision: number };

export interface NatsKvService {
  /** Decode one row; a missing key is `Option.none`, never a failure (the store-port convention). */
  readonly get: <A, I>(
    bucket: BucketName,
    id: string,
    schema: Schema.Schema<A, I>,
  ) => Effect.Effect<Option.Option<A>, WorkflowError>;
  /** As `get`, plus the revision — for a caller that will write back under a fence. */
  readonly getVersioned: <A, I>(
    bucket: BucketName,
    id: string,
    schema: Schema.Schema<A, I>,
  ) => Effect.Effect<Option.Option<Versioned<A>>, WorkflowError>;
  /** Last-write-wins. Correct where a key has ONE writer by construction (a `wf:` row, a save). */
  readonly put: (
    bucket: BucketName,
    id: string,
    value: unknown,
  ) => Effect.Effect<void, WorkflowError>;
  /**
   * Compare-and-set against a revision from `getVersioned`. Resolves `false` when the row moved
   * underneath — the caller's decision is stale and must be dropped, which is exactly what the
   * engines' epoch fence already means. `revision: 0` means "must not exist yet".
   */
  readonly putFenced: (
    bucket: BucketName,
    id: string,
    value: unknown,
    revision: number,
  ) => Effect.Effect<boolean, WorkflowError>;
  readonly delete: (bucket: BucketName, id: string) => Effect.Effect<void, WorkflowError>;
  /** Every id in a bucket, optionally narrowed to those starting with `prefix` (a raw registry id). */
  readonly ids: (
    bucket: BucketName,
    prefix?: string,
  ) => Effect.Effect<readonly string[], WorkflowError>;
}

export class NatsKv extends Context.Tag("local-runtime/NatsKv")<NatsKv, NatsKvService>() {}

const fail = (id: string) => (cause: unknown) => new WorkflowError({ cause, instanceId: id });

/**
 * Opens the connection and ensures every bucket exists. Ensuring is idempotent and cheap, and it
 * happens HERE rather than in the CLI preflight because a bucket is this adapter's own storage —
 * the preflight's job is the server and the streams the protocol shares with Python.
 */
export const NatsKvLive = (url: string): Layer.Layer<NatsKv> =>
  Layer.scoped(
    NatsKv,
    Effect.gen(function* () {
      // LAZY on purpose. Building this layer must not open a socket, because it is built for every
      // local job — including an `h delegate` that reads no registry at all. Connecting eagerly
      // would turn a stopped fabric into a failure for work that never needed it, and would do it
      // with a raw transport error instead of the CLI's preflight message. So: nothing happens
      // until the first registry read, and the finalizer only drains a connection that was made.
      let connection: Promise<NatsConnection> | undefined;
      yield* Effect.addFinalizer(() =>
        connection === undefined
          ? Effect.void
          : // `.catch` on the PROMISE, not just Effect.ignore on the effect. If connecting failed,
            // this finalizer is a SECOND consumer of the same rejected promise, and `Effect.promise`
            // has no error channel — the rejection becomes a defect and the runner dies printing a
            // NatsError stack instead of letting the CLI say "is the local fabric up?".
            Effect.promise(() => connection!.then((nc) => nc.drain()).catch(() => undefined)).pipe(
              Effect.ignore,
            ),
      );
      const connectOnce = (): Promise<NatsConnection> => {
        connection ??= connect({ servers: url, timeout: 3000, maxReconnectAttempts: 2 });
        return connection;
      };

      const handles = new Map<BucketName, KV>();

      const bucketOf = (bucket: BucketName): Effect.Effect<KV, WorkflowError> => {
        const held = handles.get(bucket);
        if (held) return Effect.succeed(held);
        return Effect.tryPromise({
          try: async () => {
            const nc = await connectOnce();
            const kv = await nc.jetstream().views.kv(bucket, { history: 1 });
            handles.set(bucket, kv);
            return kv;
          },
          catch: fail(bucket),
        });
      };

      const readEntry = (bucket: BucketName, id: string) =>
        bucketOf(bucket).pipe(
          Effect.flatMap((kv) =>
            Effect.tryPromise({ try: () => kv.get(kvKey(id)), catch: fail(id) }),
          ),
        );

      // Decode through the row's Schema rather than casting: a row written by an older build (or
      // by hand) must fail loudly here, not surface as a half-populated object three layers away.
      const decodeEntry = <A, I>(id: string, schema: Schema.Schema<A, I>, raw: Uint8Array) =>
        Effect.try({
          try: () => JSON.parse(new TextDecoder().decode(raw)) as unknown,
          catch: fail(id),
        }).pipe(
          Effect.flatMap((parsed) =>
            Schema.decodeUnknown(schema, { onExcessProperty: "preserve" })(parsed).pipe(
              Effect.mapError(fail(id)),
            ),
          ),
        );

      const getVersioned = <A, I>(bucket: BucketName, id: string, schema: Schema.Schema<A, I>) =>
        readEntry(bucket, id).pipe(
          Effect.flatMap((entry) =>
            entry == null
              ? Effect.succeed(Option.none<Versioned<A>>())
              : decodeEntry(id, schema, entry.value).pipe(
                  Effect.map((value) => Option.some({ value, revision: entry.revision })),
                ),
          ),
        );

      const get = <A, I>(bucket: BucketName, id: string, schema: Schema.Schema<A, I>) =>
        getVersioned(bucket, id, schema).pipe(
          Effect.map(Option.map((versioned) => versioned.value)),
        );

      const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

      const put = (bucket: BucketName, id: string, value: unknown) =>
        bucketOf(bucket).pipe(
          Effect.flatMap((kv) =>
            Effect.tryPromise({ try: () => kv.put(kvKey(id), encode(value)), catch: fail(id) }),
          ),
          Effect.asVoid,
        );

      const putFenced = (bucket: BucketName, id: string, value: unknown, revision: number) =>
        bucketOf(bucket).pipe(
          Effect.flatMap((kv) =>
            Effect.tryPromise({
              try: async () => {
                await (revision === 0
                  ? kv.create(kvKey(id), encode(value))
                  : kv.update(kvKey(id), encode(value), revision));
                return true;
              },
              // A rejected CAS is not a fault: the row moved, so this decision is stale. Any other
              // failure still surfaces — a swallowed transport error would look like staleness and
              // silently drop a write forever.
              catch: (cause) => (isWrongLastSequence(cause) ? null : fail(id)(cause)),
            }),
          ),
          Effect.catchAll((error) => (error === null ? Effect.succeed(false) : Effect.fail(error))),
        );

      const remove = (bucket: BucketName, id: string) =>
        bucketOf(bucket).pipe(
          Effect.flatMap((kv) =>
            Effect.tryPromise({ try: () => kv.purge(kvKey(id)), catch: fail(id) }),
          ),
          Effect.asVoid,
        );

      const ids = (bucket: BucketName, prefix?: string) =>
        bucketOf(bucket).pipe(
          Effect.flatMap((kv) =>
            Effect.tryPromise({
              try: async () => {
                const out: string[] = [];
                for await (const key of await kv.keys()) out.push(kvId(key));
                return out;
              },
              catch: fail(bucket),
            }),
          ),
          Effect.map((all) => (prefix ? all.filter((id) => id.startsWith(prefix)) : all)),
        );

      return { get, getVersioned, put, putFenced, delete: remove, ids } satisfies NatsKvService;
    }),
  );

/** JetStream's CAS rejection. Anything else from a put is a real fault and must not be swallowed. */
const isWrongLastSequence = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  /wrong last sequence|key exists/i.test(String((cause as { message?: unknown }).message ?? cause));

// Helpers built on the NatsKv PORT — `listUnder`, `mergeCounters`, `natsLease` — deliberately live
// in kv-helpers.ts rather than here. This module is the chokepoint for RAW handle access
// (`check-kv-keys` rule 2 requires every call in it to encode its key), and a port-level helper
// takes a bucket where a raw call takes a key. Keeping the two apart lets the guard stay an exact
// rule instead of one with an exception, which is what it needed when they shared a file.
