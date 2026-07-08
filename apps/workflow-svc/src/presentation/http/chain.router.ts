import { Effect, Option, Schema } from "effect";
import type { FastifyInstance } from "fastify";
import { activeTraceparent, withServerSpan } from "telemetry";

import { registerChainForFire } from "../../domain/chain-scan.ts";
import { ChainHop, ChainStrategy } from "../../domain/models/chain.model.ts";
import { ChainStore } from "../../domain/ports/IChainStore.ts";
import { NotFoundError, runRoute, type WorkflowRoutesRuntime } from "./workflow.router.ts";

// POST /chain/run body: the chain to register (the CLI builds the hops + their instanceIds). The
// engine marks a row and fires hop 0, then the cron-tick scan sequences the rest — no blocking poll.
const ChainRunRequest = Schema.Struct({
  slug: Schema.String,
  hops: Schema.Array(ChainHop),
  data: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  strategy: Schema.optional(ChainStrategy),
  budgetMs: Schema.optional(Schema.Number),
  meta: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
const decodeRunRequest = Schema.decodeUnknown(ChainRunRequest);

/**
 * The chain registry's surface, sibling of watch.router.ts. `POST /chain/run` registers a chain and
 * returns immediately (202) — sequencing is the durable chain engine on the cron tick, not a blocking
 * poll (mirrors how `--watch` registers supervision). `GET /chain/list` carries the `chain:__tick__`
 * heartbeat so `h chain list` can tell a live scan from a dead or disarmed one in one call.
 */
export function registerChainRoutes(
  fastify: FastifyInstance,
  runtime: WorkflowRoutesRuntime,
): void {
  fastify.post("/chain/run", (request, reply) =>
    withServerSpan("POST /chain/run", request.headers, () => {
      const traceparent = activeTraceparent();
      return runRoute(
        runtime,
        reply,
        Effect.gen(function* () {
          const reg = yield* decodeRunRequest(request.body);
          return yield* registerChainForFire(reg, traceparent);
        }),
        { successStatus: 202 },
      );
    }),
  );

  fastify.get("/chain/list", (_request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const cs = yield* ChainStore;
        const heartbeat = yield* cs.getHeartbeat();
        const chains = yield* cs.listRows();
        return { heartbeat: Option.getOrNull(heartbeat), chains };
      }),
    ),
  );

  fastify.get<{ Params: { chainId: string } }>("/chain/:chainId", (request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const cs = yield* ChainStore;
        const row = yield* cs.getRow(request.params.chainId);
        if (Option.isNone(row)) return yield* new NotFoundError({ message: "Chain not found" });
        return row.value;
      }),
    ),
  );

  fastify.delete<{ Params: { chainId: string } }>("/chain/:chainId", (request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const cs = yield* ChainStore;
        yield* cs.deleteRow(request.params.chainId);
        return { deleted: request.params.chainId };
      }),
    ),
  );
}
