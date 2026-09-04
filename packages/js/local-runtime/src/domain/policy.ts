import {
  activeDenial,
  decideQuota,
  deniedMessage,
  ExecPolicyStore,
  executorFromActivity,
  QuotaStore,
  quotaRefusalMessage,
} from "engine-core";
import type { QuotaDecision } from "engine-core";
import { Clock, Duration, Effect, Option } from "effect";

import type { LocalAgentType, QuotaGate } from "./models.ts";

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
    if (denial !== undefined)
      return yield* Effect.fail(new Error(deniedMessage(executor, denial, "local")));
  });

/**
 * The quota gate, local-substrate side: BEFORE a step is fired, read what the executor's CLI last
 * reported about the account's windows (`quota:<executor>`) and refuse a step that would not fit
 * — or, under `onQuota: "wait"`, sleep until the window resets and check again.
 *
 * The exec-policy fence above answers "has this executor been DENIED"; this answers "would this
 * step push it over". They are different questions with different sources (an operator's row vs
 * the CLI's own report), which is why the observation has its own registry rather than being
 * folded into the policy row. Same `decide` as the service gate, so the refusal wording and the
 * ceiling are one thing on both substrates.
 *
 * `onWait` is the caller's progress line — the decision is domain, the sleep is here, the
 * wording is the caller's. Sleeping loops because a second window may also be spent: each pass
 * re-reads the row, and a window whose reset has passed no longer counts. `ignore` skips the gate
 * entirely (the operator knows better), and an UNREADABLE row proceeds: this is an observation,
 * and no observation is the same answer as before the registry existed — unlike the policy row,
 * which is a decision someone made and so fails closed.
 */
export const awaitQuotaHeadroom = (
  agent: LocalAgentType,
  gate: QuotaGate | undefined,
  onWait: (decision: Extract<QuotaDecision, { action: "wait" }>) => Effect.Effect<void>,
): Effect.Effect<void, Error, QuotaStore> =>
  Effect.gen(function* () {
    if (gate?.ignore) return;
    const executor = executorFromActivity(`run-${agent}`) ?? agent;
    const store = yield* QuotaStore;
    for (;;) {
      // The Effect clock, not Date: the sleep below is on the same clock, so a test can drive both.
      const nowMs = yield* Clock.currentTimeMillis;
      const nowIso = new Date(nowMs).toISOString();
      const row = yield* store.get(executor).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      const decision = decideQuota(row, { nowIso, onQuota: gate?.onQuota ?? "fail" });
      if (decision.action === "proceed") return;
      if (decision.action === "refuse")
        return yield* Effect.fail(new Error(quotaRefusalMessage(decision)));
      yield* onWait(decision);
      const waitMs = new Date(decision.untilIso).getTime() - nowMs;
      if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs));
    }
  });
