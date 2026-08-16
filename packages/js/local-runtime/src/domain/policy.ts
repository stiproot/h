import { activeDenial, deniedMessage, ExecPolicyStore, executorFromActivity } from "engine-core";
import { Effect, Option } from "effect";

import type { LocalAgentType } from "./models.ts";

/**
 * The executor-policy gate, local-substrate side — the counterpart of workflow-svc's
 * `gatedExecutor`, and deliberately the SAME decision function (`activeDenial`) over the SAME
 * `exec:config` row shape, so `h agents deny codex` means one thing on both substrates.
 *
 * Why it matters more here, not less: a denial's commonest cause is a usage limit, and the
 * operator's own CLI credentials are exactly what a local run spends. A fence that only held on
 * the fleet would leave the machine most likely to hit the limit unprotected.
 *
 * Fail-closed, mirroring the service gate: an unreadable policy FAILS the run rather than assuming
 * permission. On this substrate the fabric is a hard dependency anyway, so a policy read that
 * cannot complete means something is broken that local execution needs regardless.
 *
 * The shortname is derived through `executorFromActivity` rather than assumed equal to the agent
 * name. They coincide today (`claude` ⇄ `run-claude`), and encoding that coincidence here would be
 * a second mapping to keep in step with the one the service side already owns.
 */
export const assertExecutorAllowed = (
  agent: LocalAgentType,
  nowIso: string,
): Effect.Effect<void, Error, ExecPolicyStore> =>
  Effect.gen(function* () {
    const executor = executorFromActivity(`run-${agent}`);
    if (executor === undefined) return;
    const store = yield* ExecPolicyStore;
    const policy = yield* store
      .get()
      .pipe(
        Effect.mapError(
          (cause) =>
            new Error(
              `could not read the executor policy (exec:config): ${cause.message ?? cause}`,
            ),
        ),
      );
    const denial = activeDenial(Option.getOrUndefined(policy), executor, nowIso);
    // Loud, never a silent re-route to a different agent: a denied executor being NAMED is a
    // decision the operator made, and quietly substituting one would hide both the denial and the
    // fact that the run did not do what was asked.
    if (denial !== undefined) return yield* Effect.fail(new Error(deniedMessage(executor, denial)));
  });
