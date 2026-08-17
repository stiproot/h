import { CronStore, emptyCronLedger, ExecPolicyStore, WfStore, WorkflowStore } from "engine-core";
import type { WfRow } from "engine-core";
import { Effect, Layer, Option } from "effect";

/**
 * An executor policy that denies nothing — what every test that is not ABOUT the policy should
 * provide.
 *
 * It exists as a named layer rather than an inline stub so the default is stated once and reads as
 * a deliberate "no fence here", not as an oversight. A test that means to exercise the fence builds
 * its own row; a test that says nothing gets the permissive one explicitly.
 */
export const AllowAllExecPolicy = Layer.succeed(ExecPolicyStore, {
  get: () => Effect.succeed(Option.none()),
  save: () => Effect.void,
});

/**
 * A wf: registry that records what a run reported, for tests that assert on the bracket. Tests that
 * are not about it can provide this too — the bracket is best-effort, so a run works without one,
 * but providing it keeps the layer explicit rather than relying on the ignore.
 */
export const memoryWfStore = (rows: Map<string, WfRow> = new Map()) => ({
  rows,
  layer: Layer.succeed(WfStore, {
    getRun: (instanceId: string) => Effect.succeed(Option.fromNullable(rows.get(instanceId))),
    saveRow: (row: WfRow) => Effect.sync(() => void rows.set(row.instanceId, row)),
  }),
});

/**
 * The registries a run's CLOSING BRACKET touches — the cron it may arm, and the store that arming
 * reads. Inert unless a job carries `armCron`, but required by the type, so tests state it once
 * here rather than each stubbing seventeen methods.
 */
export const memoryArmStores = (armed: Map<string, unknown> = new Map()) => {
  const none = () => Effect.succeed(Option.none());
  return {
    armed,
    layer: Layer.mergeAll(
      Layer.succeed(CronStore, {
        getRow: (id: string) => Effect.succeed(Option.fromNullable(armed.get(id) as never)),
        listRows: () => Effect.succeed([]),
        saveRow: (row: { repo: string; slug: string; workflow: string }) =>
          Effect.sync(() => void armed.set(`${row.repo}:${row.slug}:${row.workflow}`, row)),
        deleteRow: () => Effect.void,
        getDiscoverRow: none,
        listDiscoverRows: () => Effect.succeed([]),
        saveDiscoverRow: () => Effect.void,
        deleteDiscoverRow: () => Effect.void,
        getSchedRow: none,
        listSchedRows: () => Effect.succeed([]),
        saveSchedRow: () => Effect.void,
        deleteSchedRow: () => Effect.void,
        getConfig: none,
        getHeartbeat: none,
        heartbeat: () => Effect.void,
        getLedger: () => Effect.succeed(emptyCronLedger),
        bumpLedger: () => Effect.void,
      } as never),
      Layer.succeed(WorkflowStore, {
        save: () => Effect.void,
        get: none,
        list: () => Effect.succeed([]),
        listScheduled: () => Effect.succeed([]),
        markRun: () => Effect.void,
      } as never),
    ),
  };
};
