import { DaprClient } from "@dapr/dapr";
import { pathStateKey } from "core-dapr";
import { WorkflowError } from "core";
import { Effect, Layer, Option, Schema } from "effect";

import { WfRow, wfRunKey } from "engine-core";
import { WfStore } from "engine-core";

const STORE = "statestore";

const decodeRow = Schema.decodeUnknown(WfRow, { onExcessProperty: "preserve" });

/**
 * Live layer over the Dapr state API (Redis) for the `wf:` registry — the dapr-watch-store pattern,
 * minus the index: `wf:run:*` rows are read by DERIVED key, so no `wf:index` and no
 * read-modify-write. Since the 2026-08-17 re-key each row belongs to ONE run, so there is no
 * last-write-wins at all: a re-run writes its own row rather than overwriting a predecessor's.
 */
export const WfStoreLive: Layer.Layer<WfStore> = Layer.scoped(
  WfStore,
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

    const getRun = (instanceId: string) => {
      const key = wfRunKey(instanceId);
      return tryState(key, () => client.state.get(STORE, pathStateKey(key))).pipe(
        // A missing key reads as "" (or null) from the SDK; both are Option.none.
        Effect.flatMap((result) =>
          result == null || (result as unknown) === ""
            ? Effect.succeed(Option.none<WfRow>())
            : decodeRow(result).pipe(
                Effect.map(Option.some),
                Effect.mapError((cause) => new WorkflowError({ cause, instanceId: key })),
              ),
        ),
      );
    };

    const saveRow = (row: WfRow): Effect.Effect<void, WorkflowError> => {
      const key = wfRunKey(row.instanceId);
      return tryState(key, () => client.state.save(STORE, [{ key, value: row }]));
    };

    return { getRun, saveRow };
  }),
);
