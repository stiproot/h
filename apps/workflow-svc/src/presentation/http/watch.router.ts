import { Effect, Option } from "effect";
import type { FastifyInstance } from "fastify";

import { WatchStore } from "../../domain/ports/IWatchStore.ts";
import { NotFoundError, runRoute, type WorkflowRoutesRuntime } from "./workflow.router.ts";

/**
 * Read/delete surface over the watch registry (docs/plans/watcher-primitive.md §2 item 10):
 * `h watch list|rm` and the agent services' watches passthrough read these. The list carries
 * the `watch:__tick__` heartbeat so consumers (the sweep's staleness guard) can tell a live
 * scan from a dead or disarmed one without a second call.
 */
export function registerWatchRoutes(
  fastify: FastifyInstance,
  runtime: WorkflowRoutesRuntime,
): void {
  fastify.get("/watch/list", (_request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const ws = yield* WatchStore;
        const heartbeat = yield* ws.getHeartbeat();
        const watches = yield* ws.listRows();
        return { heartbeat: Option.getOrNull(heartbeat), watches };
      }),
    ),
  );

  fastify.get<{ Params: { instanceId: string } }>("/watch/:instanceId", (request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const ws = yield* WatchStore;
        const row = yield* ws.getRow(request.params.instanceId);
        if (Option.isNone(row)) return yield* new NotFoundError({ message: "Watch not found" });
        return row.value;
      }),
    ),
  );

  fastify.delete<{ Params: { instanceId: string } }>("/watch/:instanceId", (request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const ws = yield* WatchStore;
        yield* ws.deleteRow(request.params.instanceId);
        return { deleted: request.params.instanceId };
      }),
    ),
  );
}
