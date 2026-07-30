import { Effect, Option, Schema } from "effect";
import type { FastifyInstance } from "fastify";

import { executorFromAgentId, normalizeDenied } from "../../domain/exec-policy.ts";
import { DeniedEntry } from "../../domain/models/exec.model.ts";
import { ledgerDate } from "../../domain/models/watch.model.ts";
import { ExecPolicyStore } from "../../domain/ports/IExecPolicyStore.ts";
import { WatchStore } from "../../domain/ports/IWatchStore.ts";
import { runRoute, type WorkflowRoutesRuntime } from "./workflow.router.ts";

/** Body of POST /exec/policy — the full denied set (replace, not merge; the CLI merges). A
 * bare string is the pre-provenance shape and becomes an operator entry stamped now. */
const SetPolicyBody = Schema.Struct({
  denied: Schema.Array(Schema.Union(Schema.String, DeniedEntry)),
});

/** Body of POST /exec/budget — set (a number) or clear (null/absent) one executor's daily
 * budget. */
const SetBudgetBody = Schema.Struct({
  name: Schema.String,
  dailyBudgetUsd: Schema.optional(Schema.NullOr(Schema.Number)),
});

/**
 * The executor-policy surface (the exec: registry in CLAUDE.md + provenance/expiry
 * ): one of the exec: registry's two writers — the
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
        // Today's per-executor spend + gap count off the watch day ledger (B3's subtotals), so
        // `h agents list` shows budget vs actual in one call. Best-effort: a ledger read
        // failure must not break the policy read.
        const ws = yield* WatchStore;
        const ledger = yield* ws
          .getLedger(ledgerDate(Date.now()))
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
        const todaySpend: Record<string, number> = {};
        for (const [agentId, usd] of Object.entries(ledger?.costByAgent ?? {})) {
          const executor = executorFromAgentId(agentId);
          todaySpend[executor] = Math.round(((todaySpend[executor] ?? 0) + usd) * 10_000) / 10_000;
        }
        return {
          denied: normalizeDenied(policy),
          updatedAt: policy?.updatedAt ?? "",
          budgets: policy?.budgets ?? {},
          todaySpend,
          todayCostGapRuns: ledger?.costGapRuns ?? 0,
        };
      }),
    ),
  );

  // Set or clear one executor's daily cost budget (A1). Denied entries ride along untouched —
  // the budget table and the deny list are independent halves of the same row.
  fastify.post("/exec/budget", (request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const body = yield* Schema.decodeUnknown(SetBudgetBody)(request.body);
        const store = yield* ExecPolicyStore;
        const now = new Date().toISOString();
        const policy = Option.getOrUndefined(yield* store.get());
        const budgets = { ...(policy?.budgets ?? {}) };
        if (body.dailyBudgetUsd === undefined || body.dailyBudgetUsd === null) {
          delete budgets[body.name];
        } else {
          budgets[body.name] = body.dailyBudgetUsd;
        }
        const next = {
          denied: policy?.denied ?? [],
          updatedAt: now,
          ...(Object.keys(budgets).length > 0 ? { budgets } : {}),
        };
        yield* store.save(next);
        return { budgets, updatedAt: now };
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
        // Budgets ride along untouched — deny/allow must never drop the budget table (A1).
        const prior = Option.getOrUndefined(yield* store.get());
        const policy = {
          denied,
          updatedAt: now,
          ...(prior?.budgets ? { budgets: prior.budgets } : {}),
        };
        yield* store.save(policy);
        return policy;
      }),
    ),
  );
}
