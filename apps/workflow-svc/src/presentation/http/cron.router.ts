import type { WorkflowError } from "core";
import { Effect, Ref } from "effect";
import type { FastifyInstance } from "fastify";
import { activeTraceparent, withServerSpan } from "telemetry";

import { toRequest } from "../../domain/models/workflow.model.ts";
import { isDue } from "../../domain/scheduling.ts";
import { WorkflowInvoker } from "../../domain/ports/IWorkflowInvoker.ts";
import { WorkflowStore } from "../../domain/ports/IWorkflowStore.ts";
import { runRoute, type WorkflowRoutesEnv, type WorkflowRoutesRuntime } from "./workflow.router.ts";

// The cron binding (dapr/local/workflow-cron.yaml) is named workflow-cron-tick; a cron binding is
// delivered as POST /<binding-name>, so the route name must match.
const ROUTE = "/workflow-cron-tick";

/**
 * One cron tick: a compare-and-set on the `ticking` Ref decides whether this fiber owns
 * the scan. Ticks fire far more often than a scheduled workflow runs; an overlapping tick
 * replies `skipped` immediately rather than queueing behind the in-flight scan (which is
 * why this is a Ref CAS and deliberately NOT a Semaphore — a permit would queue the
 * second tick and produce exactly the catch-up scan the flag exists to avoid). The
 * winner's reset runs in `Effect.ensuring`, so the flag clears on failure too.
 *
 * Exported for the concurrency tests; the route handler below is its only production caller.
 */
export const tickEffect = (
  ticking: Ref.Ref<boolean>,
  traceparent: string | undefined,
): Effect.Effect<{ fired: string[] } | { skipped: string }, WorkflowError, WorkflowRoutesEnv> =>
  Effect.gen(function* () {
    // CAS: flip false→true and learn atomically whether this fiber won the slot.
    const won = yield* Ref.modify(ticking, (t) => [!t, true] as const);
    if (!won) return { skipped: "previous tick still processing" };
    return yield* scanAndFire(traceparent).pipe(Effect.ensuring(Ref.set(ticking, false)));
  });

const scanAndFire = (
  traceparent: string | undefined,
): Effect.Effect<{ fired: string[] }, WorkflowError, WorkflowRoutesEnv> =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const invoker = yield* WorkflowInvoker;
    const now = new Date();
    const fired: string[] = [];
    for (const { key, workflow } of yield* store.listScheduled()) {
      if (workflow.disabled || !workflow.schedule || !isDue(workflow.schedule, now)) continue;
      yield* invoker.invoke(toRequest(workflow, traceparent));
      yield* store.markRun(key, now.toISOString());
      fired.push(key);
    }
    return { fired };
  });

/**
 * Registers the cron-binding target that fires saved workflows on their schedule.
 *
 * Two Dapr-binding quirks shape this: (1) Dapr probes an input binding with an OPTIONS request at
 * startup and only delivers if the app does not 404 it, so the route answers both POST and OPTIONS
 * (Fastify 404s an unhandled method by default); (2) the probe and the tick both arrive with
 * content-type application/json and an empty body, which Fastify's default JSON parser rejects with
 * 400 — making Dapr think the app has not subscribed. The route never reads its body, so it is
 * registered in an encapsulated plugin scope whose content-type parsers are cleared and replaced
 * with a body-ignoring catch-all, leaving the JSON-parsing workflow routes untouched.
 */
export function registerCronRoutes(fastify: FastifyInstance, runtime: WorkflowRoutesRuntime): void {
  // Ticks fire far more often than a scheduled workflow runs; an overlapping tick is a no-op rather
  // than re-scanning while the previous scan is still firing workflows (see tickEffect).
  const ticking = Ref.unsafeMake(false);

  fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, _payload, done) => done(null, undefined));

    scope.route({
      method: ["POST", "OPTIONS"],
      url: ROUTE,
      handler: async (request, reply) => {
        if (request.method === "OPTIONS") return reply.status(200).send();
        return withServerSpan("POST /workflow-cron-tick", request.headers, () => {
          // Carry the tick's trace down into each fired workflow so its activities re-attach to
          // this trace (the cron binding roots it) instead of starting disconnected spans — the
          // same threading the HTTP /workflow/run path does with the inbound request's trace.
          // Captured at the edge, synchronously under the server span.
          const traceparent = activeTraceparent();
          return runRoute(runtime, reply, tickEffect(ticking, traceparent));
        });
      },
    });
  });
}
