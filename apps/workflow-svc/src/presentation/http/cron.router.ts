import type { WorkflowError } from "core";
import { Effect, Option, Ref, Schema } from "effect";
import type { FastifyInstance } from "fastify";
import { activeTraceparent, withServerSpan } from "telemetry";

import { type ChainScanReport, scanChainsEffect } from "../../domain/chain-scan.ts";
import {
  type CronScanReport,
  disarmCron,
  disarmEventEffect,
  scanCronsEffect,
} from "../../domain/cron-scan.ts";
import { type DiscoverScanReport, scanDiscoverEffect } from "../../domain/discover-scan.ts";
import { type SchedScanReport, disarmSched, scanSchedEffect } from "../../domain/schedule-scan.ts";
import { cronId } from "../../domain/models/cron.model.ts";
import { toRequest } from "../../domain/models/workflow.model.ts";
import { isDue } from "../../domain/scheduling.ts";
import { CronStore } from "../../domain/ports/ICronStore.ts";
import { WorkflowStore } from "../../domain/ports/IWorkflowStore.ts";
import {
  type WatchScanReport,
  invokeWithWatch,
  scanWatchesEffect,
} from "../../domain/watch-scan.ts";
import {
  NotFoundError,
  runRoute,
  type WorkflowRoutesEnv,
  type WorkflowRoutesRuntime,
} from "./workflow.router.ts";

const DisarmBody = Schema.Struct({
  repo: Schema.String,
  slug: Schema.String,
  workflow: Schema.String,
});

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
): Effect.Effect<
  | {
      fired: string[];
      watch: WatchScanReport | { error: string };
      chain: ChainScanReport | { error: string };
      cron: CronScanReport | { error: string };
      discover: DiscoverScanReport | { error: string };
      sched: SchedScanReport | { error: string };
    }
  | { skipped: string },
  WorkflowError,
  WorkflowRoutesEnv
> =>
  Effect.gen(function* () {
    // CAS: flip false→true and learn atomically whether this fiber won the slot.
    const won = yield* Ref.modify(ticking, (t) => [!t, true] as const);
    if (!won) return { skipped: "previous tick still processing" };
    return yield* Effect.gen(function* () {
      const { fired } = yield* scanAndFire(traceparent);
      // The watch and chain scans ride the same tick (ruling W2), but neither's failure may fail
      // the tick — a broken scan reply would make Dapr treat the binding as unsubscribed.
      const watch = yield* scanWatchesEffect(traceparent).pipe(
        Effect.catchAll((err) => Effect.succeed({ error: scanErrorMessage(err) })),
      );
      const chain = yield* scanChainsEffect(traceparent).pipe(
        Effect.catchAll((err) => Effect.succeed({ error: scanErrorMessage(err) })),
      );
      // The recur-cron scan rides the same tick (§5), the third sibling; its failure never fails the
      // tick either (a broken scan reply would make Dapr treat the binding as unsubscribed).
      const cron = yield* scanCronsEffect(traceparent).pipe(
        Effect.catchAll((err) => Effect.succeed({ error: scanErrorMessage(err) })),
      );
      // The discovery-cron scan (§9) rides the same tick, the fan-out sibling of the recur cron; its
      // failure never fails the tick either.
      const discover = yield* scanDiscoverEffect(traceparent).pipe(
        Effect.catchAll((err) => Effect.succeed({ error: scanErrorMessage(err) })),
      );
      // The scheduled-fire scan (the one-shot variant) rides the same tick, the fifth sibling; its
      // failure never fails the tick either.
      const sched = yield* scanSchedEffect(traceparent).pipe(
        Effect.catchAll((err) => Effect.succeed({ error: scanErrorMessage(err) })),
      );
      return { fired, watch, chain, cron, discover, sched };
    }).pipe(Effect.ensuring(Ref.set(ticking, false)));
  });

// Tagged errors often carry the raw failure in `cause` rather than their own message.
function scanErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return String(err);
}

const scanAndFire = (
  traceparent: string | undefined,
): Effect.Effect<{ fired: string[] }, WorkflowError, WorkflowRoutesEnv> =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const now = new Date();
    const fired: string[] = [];
    for (const { key, workflow } of yield* store.listScheduled()) {
      if (workflow.disabled || !workflow.schedule || !isDue(workflow.schedule, now)) continue;
      // Same choke point as the HTTP paths: a stored watch policy registers the row here
      // (agreement 9 — cron-fired runs are supervised too).
      yield* invokeWithWatch({
        ...toRequest(workflow, traceparent),
        ...(workflow.watch ? { watch: workflow.watch, watchMeta: { owner: key } } : {}),
      });
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
  // The cron REGISTRY's read surface (sibling of /watch/list, /chain/list): the scan heartbeat +
  // every cron:sub row, so `h cron list` can tell a live scan from a dead/disarmed one in one call.
  fastify.get("/cron/list", (_request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const cs = yield* CronStore;
        const heartbeat = yield* cs.getHeartbeat();
        const crons = yield* cs.listRows();
        // The fan-out sibling (§9) shares the registry group, so one list surfaces both — a recur cron
        // and a discovery cron are both "crons" to `h cron list`.
        const discover = yield* cs.listDiscoverRows();
        // The one-shot scheduled-fire variant (cron:sched:*) also shares the group — surfaced here so
        // `h cron list` sees every time-driven fire, and `h schedule list` is a thin view over these.
        const sched = yield* cs.listSchedRows();
        return { heartbeat: Option.getOrNull(heartbeat), crons, discover, sched };
      }),
    ),
  );

  fastify.post("/cron/disarm", (request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const body = yield* Schema.decodeUnknown(DisarmBody)(request.body);
        const id = cronId(body);
        const row = yield* disarmCron(id).pipe(
          Effect.mapError((e) =>
            "_tag" in e && e._tag === "NotFound"
              ? new NotFoundError({ message: `cron not found: ${id}` })
              : (e as WorkflowError),
          ),
        );
        return { disarmed: id, status: row.status, outcome: row.outcome };
      }),
    ),
  );

  // Disarm a one-shot scheduled-fire row by id (the `h schedule rm` target). Sibling of /cron/disarm
  // but keyed by the row's own id (a sched row has no repo/slug/workflow coords).
  fastify.post("/cron/sched/disarm", (request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const { id } = yield* Schema.decodeUnknown(Schema.Struct({ id: Schema.String }))(
          request.body,
        );
        const row = yield* disarmSched(id).pipe(
          Effect.mapError((e) =>
            "_tag" in e && e._tag === "NotFound"
              ? new NotFoundError({ message: `schedule not found: ${id}` })
              : (e as WorkflowError),
          ),
        );
        return { disarmed: id, status: row.status, outcome: row.outcome };
      }),
    ),
  );

  // The cron-disarm pub/sub target (docs/plans/inline-chain-cron-composition.md D6): a finalizing
  // chain publishes `{repo, slug, workflow}` here to deactivate a member-armed cron WITHOUT writing
  // cron:sub itself (D2) — this handler is the single writer, reusing disarmCron. Dapr delivers
  // pub/sub events as `application/cloudevents+json`, which Fastify's default JSON parser does not
  // handle, so the route lives in an encapsulated scope that adds a parser for that content type
  // (mirrors trigger.router). A missing cron / bad payload acks as {skipped}; infra failure → 500.
  fastify.register(async (scope) => {
    scope.addContentTypeParser(
      "application/cloudevents+json",
      { parseAs: "string" },
      (_req, body, done) => {
        try {
          done(null, JSON.parse(body as string));
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );
    scope.post("/cron-disarm", (request, reply) =>
      withServerSpan("POST /cron-disarm", request.headers, () =>
        runRoute(runtime, reply, disarmEventEffect(request.body)),
      ),
    );
  });

  // NOTE: a discovery cron is registered by the `register-discover` ACTIVITY inside a one-step
  // provision workflow (`h cron discover add` fires it), NOT by a handler here (§10 — crons via
  // activities). There is deliberately no `POST /cron/discover`; the cron router only READS the
  // registry (/cron/list) and hosts the tick.

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
