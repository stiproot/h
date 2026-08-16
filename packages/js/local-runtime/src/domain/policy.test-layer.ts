import { ExecPolicyStore } from "engine-core";
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
