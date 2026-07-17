import type { FastifyInstance } from "fastify";
import { Effect } from "effect";

import { ObservabilityService } from "../../domain/ports/IObservabilityService.ts";
import type { ObsMcpRuntime } from "./mcp.router.ts";

/**
 * Plain read-only JSON routes over the same observability port the MCP tools use — the run
 * ledger for HTTP consumers that can't speak MCP (docs/plans/workflow-viz.md increment 1:
 * the viz frontend reads runs through its dev-server proxy). No writes, no new port surface.
 */
export function registerApiRoutes(fastify: FastifyInstance, runtime: ObsMcpRuntime): void {
  fastify.get<{
    Querystring: { limit?: string; agentId?: string; status?: string; instanceId?: string };
  }>("/api/runs", async (req, reply) => {
    const { limit, agentId, status, instanceId } = req.query;
    const runs = await runtime.runPromise(
      Effect.flatMap(ObservabilityService, (obs) =>
        obs.runsList({
          limit: limit ? Number(limit) : undefined,
          agentId,
          status,
          instanceId,
        }),
      ),
    );
    return reply.send(runs);
  });

  fastify.get<{ Params: { runId: string } }>("/api/run/:runId", async (req, reply) => {
    const detail = await runtime.runPromise(
      Effect.flatMap(ObservabilityService, (obs) => obs.runGet(req.params.runId)),
    );
    return reply.send(detail);
  });
}
