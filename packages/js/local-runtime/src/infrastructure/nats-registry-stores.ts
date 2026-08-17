import {
  EXEC_POLICY_KEY,
  ExecPolicy,
  ExecPolicyStore,
  StoredWorkflow,
  WfRow,
  WfStore,
  WorkflowStore,
  wfRunKey,
} from "engine-core";
import { Effect, Layer, Option } from "effect";

import { BUCKETS, NatsKv } from "./nats-kv.ts";

/**
 * The local substrate's adapters for the three registry ports increment 1 of local-engine-parity
 * puts to work — the same `engine-core` ports the Dapr/Redis stores implement, over JetStream KV.
 *
 * They live together because they are the SIMPLE three: each key has exactly one writer by
 * construction, so none of them needs the compare-and-set fence. The watch/chain/cron stores do
 * (their rows are re-decided every tick), and they land with the engines that read them rather than
 * as dead code ahead of it.
 *
 *  - **WfStore** — `wf:<repo>:<slug>:<workflow>`, written only by the run it names. Un-refusing
 *    `write-wf-row` locally is what gives the cron engine its `goal: RESOLVED` handshake.
 *  - **WorkflowStore** — the saved-workflow store. Its arrival is what lets a local fire carry
 *    `{key, params}` instead of embedded steps: triggers-as-data, locally.
 *  - **ExecPolicyStore** — the single `exec:config` row, so `h agents deny` fences local runs.
 *    A usage-limited agent on a laptop is arguably more common than on a fleet.
 */

/**
 * `wf:` rows — one per RUN since the 2026-08-17 re-key, keyed `wf:run:<instanceId>`.
 *
 * There is no index and no read-modify-write, and now no last-write-wins either: a re-run writes
 * its OWN row rather than overwriting a predecessor's. That is what makes this registry usable as
 * the local substrate's status source, where the artifact-keyed version could not be — several runs
 * of one workflow on one slug shared a row.
 */
export const NatsWfStoreLive: Layer.Layer<WfStore, never, NatsKv> = Layer.effect(
  WfStore,
  Effect.gen(function* () {
    const kv = yield* NatsKv;
    return {
      getRun: (instanceId) => kv.get(BUCKETS.wf, wfRunKey(instanceId), WfRow),
      saveRow: (row) => kv.put(BUCKETS.wf, wfRunKey(row.instanceId), row),
    };
  }),
);

/** The executor policy: one row, read on every dispatch by the activity gate, written by operators. */
export const NatsExecPolicyStoreLive: Layer.Layer<ExecPolicyStore, never, NatsKv> = Layer.effect(
  ExecPolicyStore,
  Effect.gen(function* () {
    const kv = yield* NatsKv;
    return {
      get: () => kv.get(BUCKETS.exec, EXEC_POLICY_KEY, ExecPolicy),
      save: (policy) => kv.put(BUCKETS.exec, EXEC_POLICY_KEY, policy),
    };
  }),
);

/**
 * The saved-workflow store.
 *
 * `list` is where the substrates visibly differ: Redis cannot enumerate a prefix, so the service
 * side maintains `__workflow_index__` alongside the rows and every save must keep the two in step.
 * KV enumerates natively, so the index — and the possibility of it drifting from the rows it
 * describes — simply does not exist here.
 */
export const NatsWorkflowStoreLive: Layer.Layer<WorkflowStore, never, NatsKv> = Layer.effect(
  WorkflowStore,
  Effect.gen(function* () {
    const kv = yield* NatsKv;

    const get = (key: string) => kv.get(BUCKETS.workflows, key, StoredWorkflow);

    const listScheduled = () =>
      kv.ids(BUCKETS.workflows).pipe(
        Effect.flatMap((keys) =>
          Effect.forEach(keys, (key) => get(key).pipe(Effect.map((found) => ({ key, found }))), {
            concurrency: 8,
          }),
        ),
        Effect.map((entries) =>
          entries.flatMap(({ key, found }) =>
            Option.isSome(found) && found.value.schedule ? [{ key, workflow: found.value }] : [],
          ),
        ),
      );

    return {
      save: (key, workflow) => kv.put(BUCKETS.workflows, key, workflow),
      get,
      list: () => kv.ids(BUCKETS.workflows),
      listScheduled,
      // Stamp-forward, mirroring the Dapr store: a missing key is a no-op rather than an error,
      // because the only caller is the tick that just read this workflow from the same store.
      markRun: (key, lastRunAt) =>
        get(key).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (workflow) =>
                workflow.schedule === undefined
                  ? Effect.void
                  : kv.put(BUCKETS.workflows, key, {
                      ...workflow,
                      schedule: { ...workflow.schedule, lastRunAt },
                    }),
            }),
          ),
        ),
    };
  }),
);
