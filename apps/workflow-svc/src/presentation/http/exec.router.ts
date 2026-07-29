import { Effect, Option, Schema } from "effect";
import type { FastifyInstance } from "fastify";

import { normalizeDenied } from "../../domain/exec-policy.ts";
import { DeniedEntry } from "../../domain/models/exec.model.ts";
import { ExecPolicyStore } from "../../domain/ports/IExecPolicyStore.ts";
import { runRoute, type WorkflowRoutesRuntime } from "./workflow.router.ts";

/** Body of POST /exec/policy — the full denied set (replace, not merge; the CLI merges). A
 * bare string is the pre-provenance shape and becomes an operator entry stamped now. */
const SetPolicyBody = Schema.Struct({
  denied: Schema.Array(Schema.Union(Schema.String, DeniedEntry)),
});

/**
 * The executor-policy surface (docs/plans/live-state-containment.md §2.3 + provenance/expiry
 * per docs/plans/impl/usage-limit-auto-deny.md): one of the exec: registry's two writers — the
 * other is the watcher's auto-deny (both live in workflow-svc; the single-writer COMPONENT
 * invariant holds). GET returns the row normalized to entries (absent ⇒ allow-all); POST
 * replaces the denied set and stamps updatedAt. Enforcement lives in the activity-registry
 * gate, not here. CLI: `h agents list|deny|allow`.
 */
export function registerExecRoutes(fastify: FastifyInstance, runtime: WorkflowRoutesRuntime): void {
  fastify.get("/exec/policy", (_request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const store = yield* ExecPolicyStore;
        const policy = Option.getOrUndefined(yield* store.get());
        return {
          denied: normalizeDenied(policy),
          updatedAt: policy?.updatedAt ?? "",
        };
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
        const now = new Date().toISOString();
        const denied = body.denied.map((d) =>
          typeof d === "string" ? { name: d, reason: "operator" as const, deniedAt: now } : d,
        );
        const policy = { denied, updatedAt: now };
        yield* store.save(policy);
        return policy;
      }),
    ),
  );
}
