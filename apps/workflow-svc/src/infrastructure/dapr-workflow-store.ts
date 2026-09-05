import { DaprClient } from "@dapr/dapr";
import { pathStateKey } from "core-dapr";
import { WorkflowError } from "core";
import { Effect, Layer, Option, Schema } from "effect";

import { StoredWorkflow } from "engine-core";
import { WorkflowStore } from "engine-core";

const STORE = "statestore";
// Redis exposes no key enumeration through Dapr, so saved workflow keys are tracked
// in this index entry and read back by list().
const INDEX_KEY = "__workflow_index__";

// Stored values are decoded with excess properties preserved: GET /workflow/get/:key has
// always passed a stored value through verbatim, so fields beyond the schema must survive.
const decodeStored = Schema.decodeUnknown(StoredWorkflow, { onExcessProperty: "preserve" });

/**
 * Live layer over the Dapr state API (Redis). The `DaprClient` is bracketed with
 * `acquireRelease`: its `stop(): Promise<void>` (verified present on @dapr/dapr 3.17.0 by
 * core-dapr) runs as the layer finalizer on `runtime.dispose()`, `Effect.ignore`d so a
 * shutdown hiccup never fails disposal.
 */
export const WorkflowStoreLive: Layer.Layer<WorkflowStore> = Layer.scoped(
  WorkflowStore,
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new DaprClient()),
      (c) =>
        Effect.tryPromise({ try: () => c.stop(), catch: (cause) => cause }).pipe(Effect.ignore),
    );

    const tryState = <A>(key: string, f: () => Promise<A>): Effect.Effect<A, WorkflowError> =>
      Effect.tryPromise({
        try: f,
        catch: (cause) => new WorkflowError({ cause, instanceId: key }),
      });

    const list = (): Effect.Effect<readonly string[], WorkflowError> =>
      // A missing key comes back as "" (not null) from the Dapr state SDK, so guard on the shape
      // rather than nullishness — otherwise an empty index yields a string where callers expect [].
      tryState(INDEX_KEY, () => client.state.get(STORE, pathStateKey(INDEX_KEY))).pipe(
        Effect.map((result) => (Array.isArray(result) ? (result as string[]) : [])),
      );

    const get = (key: string): Effect.Effect<Option.Option<StoredWorkflow>, WorkflowError> =>
      Effect.gen(function* () {
        const result = yield* tryState(key, () => client.state.get(STORE, pathStateKey(key)));
        // A missing key reads as "" (or null) from the SDK; both are Option.none.
        if (result == null || (result as unknown) === "") return Option.none();
        const workflow = yield* decodeStored(result).pipe(
          Effect.mapError((cause) => new WorkflowError({ cause, instanceId: key })),
        );
        return Option.some(workflow);
      });

    const save = (key: string, workflow: StoredWorkflow): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        yield* tryState(key, () => client.state.save(STORE, [{ key, value: workflow }]));
        const keys = yield* list();
        if (!keys.includes(key)) {
          yield* tryState(key, () =>
            client.state.save(STORE, [{ key: INDEX_KEY, value: [...keys, key] }]),
          );
        }
      });

    const listScheduled = (): Effect.Effect<
      Array<{ key: string; workflow: StoredWorkflow }>,
      WorkflowError
    > =>
      Effect.gen(function* () {
        const keys = yield* list();
        // Unbounded fan-out, matching the legacy Promise.all.
        const entries = yield* Effect.forEach(
          keys,
          (key) => get(key).pipe(Effect.map((workflow) => ({ key, workflow }))),
          { concurrency: "unbounded" },
        );
        return entries.flatMap(({ key, workflow }) =>
          Option.isSome(workflow) && workflow.value.schedule != null
            ? [{ key, workflow: workflow.value }]
            : [],
        );
      });

    const markRun = (key: string, lastRunAt: string): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        const found = yield* get(key);
        if (Option.isNone(found) || !found.value.schedule) return;
        const updated: StoredWorkflow = {
          ...found.value,
          schedule: { ...found.value.schedule, lastRunAt },
        };
        yield* tryState(key, () => client.state.save(STORE, [{ key, value: updated }]));
      });

    return { save, get, list, listScheduled, markRun };
  }),
);
