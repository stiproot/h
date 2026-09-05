import { DaprClient } from "@dapr/dapr";
import { WorkflowError } from "core";
import { pathStateKey } from "core-dapr";
import { Effect, Layer, Option, Schema } from "effect";

import { EXEC_POLICY_KEY, ExecPolicy } from "engine-core";
import { ExecPolicyStore } from "engine-core";

const STORE = "statestore";

const decodePolicy = Schema.decodeUnknown(ExecPolicy, { onExcessProperty: "preserve" });

/**
 * Live layer over the Dapr state API (Redis) for the `exec:` registry — the dapr-wf-store
 * pattern at its smallest: one exact key (`exec:config`), no index, single-writer structural
 * (only the POST /exec/policy route saves).
 */
export const ExecPolicyStoreLive: Layer.Layer<ExecPolicyStore> = Layer.scoped(
  ExecPolicyStore,
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new DaprClient()),
      (c) =>
        Effect.tryPromise({ try: () => c.stop(), catch: (cause) => cause }).pipe(Effect.ignore),
    );

    const tryState = <A>(f: () => Promise<A>): Effect.Effect<A, WorkflowError> =>
      Effect.tryPromise({
        try: f,
        catch: (cause) => new WorkflowError({ cause, instanceId: EXEC_POLICY_KEY }),
      });

    const get = () =>
      tryState(() => client.state.get(STORE, pathStateKey(EXEC_POLICY_KEY))).pipe(
        Effect.flatMap((result) =>
          result == null || (result as unknown) === ""
            ? Effect.succeed(Option.none<ExecPolicy>())
            : decodePolicy(result).pipe(
                Effect.map(Option.some),
                Effect.mapError(
                  (cause) => new WorkflowError({ cause, instanceId: EXEC_POLICY_KEY }),
                ),
              ),
        ),
      );

    const save = (policy: ExecPolicy): Effect.Effect<void, WorkflowError> =>
      tryState(() => client.state.save(STORE, [{ key: EXEC_POLICY_KEY, value: policy }]));

    return { get, save };
  }),
);
