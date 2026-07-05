import type { FastifyInstance } from "fastify";

import type { WorkflowBabysitter, WorkflowSubmit } from "./workflow-babysitter.ts";

/**
 * The standard agent-service workflow endpoint: "invoke this workflow with a durable watch".
 * Non-blocking — replies 202 with the instanceId as soon as the run is scheduled; supervision
 * is the watcher engine's job inside workflow-svc (see workflow-babysitter.ts). This is the
 * shared contract that makes any agent service a workflow entry point; the CLI's `--agent`
 * flag and other agents target it uniformly.
 *
 * GET /workflow/watches proxies workflow-svc's durable watch registry — global truth that
 * survives restarts, unlike the in-process table it used to expose.
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
      const { instanceId, watching } = await babysitter.submit(body);
      return reply.status(202).send({ instanceId, watching });
    } catch (err) {
      return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get("/workflow/watches", async (_request, reply) => {
    try {
      return reply.send(await babysitter.list());
    } catch (err) {
      return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
