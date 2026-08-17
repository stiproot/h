import { ExecPolicyStore, WfStore } from "engine-core";
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
