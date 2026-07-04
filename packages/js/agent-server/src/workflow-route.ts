import type { FastifyInstance } from "fastify";

import type { WorkflowBabysitter, WorkflowSubmit } from "./workflow-babysitter.ts";

/**
 * The standard agent-service workflow endpoint: "invoke and babysit this workflow".
 * Non-blocking — replies 202 with the instanceId as soon as the run is scheduled; the
 * babysitter's background loop supervises it (see workflow-babysitter.ts). This is the shared
 * contract that makes any agent service a workflow entry point (workflow-agent is no longer
 * the exclusive one); the CLI's `--agent` flag and other agents target it uniformly.
 *
 * GET /workflow/watches exposes the in-process watch table for inspection.
 */
export function registerWorkflowRoute(
  fastify: FastifyInstance,
  babysitter: WorkflowBabysitter,
): void {
  fastify.post("/workflow", async (request, reply) => {
    const body = (request.body ?? {}) as WorkflowSubmit;
    if (!body.key && !Array.isArray(body.steps)) {
      return reply.status(400).send({ error: "body needs a saved-workflow key or inline steps" });
    }
    try {
      const { instanceId } = await babysitter.submit(body);
      return reply.status(202).send({ instanceId, watching: true });
    } catch (err) {
      return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get("/workflow/watches", async (_request, reply) => {
    return reply.send(babysitter.list());
  });
}
