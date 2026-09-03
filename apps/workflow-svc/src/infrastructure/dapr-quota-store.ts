import { DaprClient } from "@dapr/dapr";
import { WorkflowError } from "core";
import { pathStateKey } from "core-dapr";
import { Effect, Layer, Option, Schema } from "effect";

import { QUOTA_PREFIX, QuotaRow, QuotaStore, quotaKey } from "engine-core";

const STORE = "statestore";
// The executor list, kept beside the rows because Redis exposes no prefix scan to the Dapr
// state API (the `__workflow_index__` pattern).
const INDEX_KEY = `${QUOTA_PREFIX}index`;

const decodeRow = Schema.decodeUnknown(QuotaRow, { onExcessProperty: "preserve" });

/**
 * Live layer over the Dapr state API (Redis) for the `quota:` registry — one row per executor
 * (`quota:<executor>`) plus an index of executors. An OBSERVATION registry, distinct from the
 * `exec:` policy beside it: what each executor's CLI last reported about the account's
 * rate-limit windows, written by the watcher at finalize (the single writer on this substrate)
 * and read by the activity gate before every `run-*` fire and by `h agents list`.
 */
export const QuotaStoreLive: Layer.Layer<QuotaStore> = Layer.scoped(
  QuotaStore,
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new DaprClient()),
      (c) => Effect.promise(() => c.stop()).pipe(Effect.ignore),
    );

    const tryState = <A>(key: string, f: () => Promise<A>): Effect.Effect<A, WorkflowError> =>
      Effect.tryPromise({
        try: f,
        catch: (cause) => new WorkflowError({ cause, instanceId: key }),
      });

    const get = (executor: string): Effect.Effect<Option.Option<QuotaRow>, WorkflowError> => {
      const key = quotaKey(executor);
      return tryState(key, () => client.state.get(STORE, pathStateKey(key))).pipe(
        Effect.flatMap((result) =>
          result == null || (result as unknown) === ""
            ? Effect.succeed(Option.none<QuotaRow>())
            : decodeRow(result).pipe(
                Effect.map(Option.some),
                Effect.mapError((cause) => new WorkflowError({ cause, instanceId: key })),
              ),
        ),
      );
    };

    const indexList = (): Effect.Effect<readonly string[], WorkflowError> =>
      tryState(INDEX_KEY, () => client.state.get(STORE, pathStateKey(INDEX_KEY))).pipe(
        Effect.map((result) => (Array.isArray(result) ? (result as string[]) : [])),
      );

    const list = (): Effect.Effect<readonly QuotaRow[], WorkflowError> =>
      indexList().pipe(
        Effect.flatMap((executors) => Effect.forEach(executors, get, { concurrency: 8 })),
        Effect.map((rows) => rows.flatMap((row) => (Option.isSome(row) ? [row.value] : []))),
      );

    const save = (row: QuotaRow): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        const key = quotaKey(row.executor);
        yield* tryState(key, () => client.state.save(STORE, [{ key, value: row }]));
        const executors = yield* indexList();
        if (!executors.includes(row.executor)) {
          yield* tryState(INDEX_KEY, () =>
            client.state.save(STORE, [{ key: INDEX_KEY, value: [...executors, row.executor] }]),
          );
        }
      });

    return { get, list, save };
  }),
);
