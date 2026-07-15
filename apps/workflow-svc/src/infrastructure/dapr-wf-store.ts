import { DaprClient } from "@dapr/dapr";
import { pathStateKey } from "core-dapr";
import { WorkflowError } from "core";
import { Effect, Layer, Option, Schema } from "effect";

import { WfRow, type WfIdentity, wfKey } from "../domain/models/wf.model.ts";
import { WfStore } from "../domain/ports/IWfStore.ts";

const STORE = "statestore";

const decodeRow = Schema.decodeUnknown(WfRow, { onExcessProperty: "preserve" });

/**
 * Live layer over the Dapr state API (Redis) for the `wf:` registry — the dapr-watch-store pattern,
 * minus the index: `wf:*` rows are read by EXACT key (enumeration is GitHub, §3), so no `wf:index`
 * and no read-modify-write. Each `wf:<repo>:<slug>:<workflow>` row has one writer (the workflow it
 * names), so plain last-write-wins is safe — single-writer is structural, not a lock.
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

    const getRow = (id: WfIdentity) => {
      const key = wfKey(id);
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
      const key = wfKey(row);
      return tryState(key, () => client.state.save(STORE, [{ key, value: row }]));
    };

    return { getRow, saveRow };
  }),
);
