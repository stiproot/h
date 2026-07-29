import { Effect, Option, Schema } from "effect";
import type { FastifyInstance } from "fastify";

import { ExecPolicyStore } from "../../domain/ports/IExecPolicyStore.ts";
import { runRoute, type WorkflowRoutesRuntime } from "./workflow.router.ts";

/** Body of POST /exec/policy — the full denied set (replace, not merge; the CLI merges). */
const SetPolicyBody = Schema.Struct({
  denied: Schema.Array(Schema.String),
});

/**
 * The executor-policy surface (docs/plans/live-state-containment.md §2.3): the single writer of
 * the `exec:` registry. GET returns the current row (absent ⇒ `{denied: []}` — allow-all);
 * POST replaces the denied set and stamps updatedAt. Enforcement lives in the activity-registry
 * gate, not here — these routes only maintain the row. CLI: `h agents deny|allow NAME…`.
 */
export function registerExecRoutes(fastify: FastifyInstance, runtime: WorkflowRoutesRuntime): void {
  fastify.get("/exec/policy", (_request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const store = yield* ExecPolicyStore;
        const policy = yield* store.get();
        return Option.getOrElse(policy, () => ({ denied: [], updatedAt: "" }));
      }),
    ),
  );

  fastify.post("/exec/policy", (request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const body = yield* Schema.decodeUnknown(SetPolicyBody)(request.body);
        const store = yield* ExecPolicyStore;
        const policy = { denied: [...body.denied], updatedAt: new Date().toISOString() };
        yield* store.save(policy);
        return policy;
      }),
    ),
  );
}
