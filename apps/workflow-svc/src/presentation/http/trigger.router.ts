import type { WorkflowError } from "core";
import { Effect, Option, Schema } from "effect";
import type { FastifyInstance } from "fastify";
import { activeTraceparent, withServerSpan } from "telemetry";

import { WorkflowParams, toRequest } from "../../domain/models/workflow.model.ts";
import { WorkflowStore } from "../../domain/ports/IWorkflowStore.ts";
import { invokeWithWatch } from "../../domain/watch-scan.ts";
import { runRoute, type WorkflowRoutesEnv, type WorkflowRoutesRuntime } from "./workflow.router.ts";

/**
 * The single well-known trigger topic (MVP of "triggers as data"): any event published to it
 * fires the saved workflow it names, with fire-time params — the pub/sub sibling of
 * `POST /workflow/run/:key`. One topic (not one per template) because Dapr subscriptions are
 * declared at sidecar startup; per-template topics would need a workflow-svc restart whenever a
 * template with a new topic is published. Event data: `{ key, params? }`.
 */
export const TRIGGER_TOPIC = "workflow-trigger";
const ROUTE = "/workflow-trigger";

/** The event payload inside the CloudEvents envelope. */
const TriggerEvent = Schema.Struct({
  key: Schema.String,
  params: Schema.optional(WorkflowParams),
});

/**
 * One trigger delivery: unwrap the CloudEvents envelope, resolve the saved workflow, fire it.
 * Payload problems (malformed data, unknown key, disabled template) resolve to `{ skipped }`
 * (2xx) — a non-2xx makes Dapr redeliver, and redelivery cannot fix a bad payload. Infra
 * failures (store or scheduler down) stay in the error channel → 500 → Dapr redelivers, which
 * is exactly what a transient outage wants. Exported for tests; the route handler below is
 * its only production caller.
 */
export const triggerEffect = (
  rawBody: unknown,
  traceparent: string | undefined,
): Effect.Effect<
  { fired: string; instanceId: string } | { skipped: string },
  WorkflowError,
  WorkflowRoutesEnv
> =>
  Effect.gen(function* () {
    // Dapr delivers a CloudEvents envelope with the published payload under `data`; tolerate a
    // raw payload (no envelope) and a JSON-string payload, like the workflow-agent handler this
    // replaces did.
    const envelope = rawBody as Record<string, unknown> | null;
    let data: unknown =
      envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : envelope;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return { skipped: "event data is not JSON" };
      }
    }
    const decoded = yield* Schema.decodeUnknown(TriggerEvent)(data).pipe(Effect.option);
    if (Option.isNone(decoded)) return { skipped: "event data lacks a workflow key" };
    const { key, params } = decoded.value;

    const store = yield* WorkflowStore;
    const workflow = yield* store.get(key);
    if (Option.isNone(workflow)) return { skipped: `no saved workflow '${key}'` };
    if (workflow.value.disabled) return { skipped: `workflow '${key}' is disabled` };

    // Same choke point as the HTTP/cron paths: a stored watch policy registers the row here
    // (agreement 9 — trigger-fired runs are supervised too).
    const { instanceId } = yield* invokeWithWatch({
      ...toRequest(workflow.value, traceparent, params),
      ...(workflow.value.watch ? { watch: workflow.value.watch, watchMeta: { owner: key } } : {}),
    });
    return { fired: key, instanceId };
  });

/**
 * Registers the workflow-trigger subscription target. Dapr delivers pub/sub events as POST
 * <route> with content-type `application/cloudevents+json`, which Fastify's default JSON
 * parser does not handle — so the route lives in an encapsulated plugin scope that adds a
 * JSON parser for that content type (regular application/json stays parsed for raw publishes).
 */
export function registerTriggerRoutes(
  fastify: FastifyInstance,
  runtime: WorkflowRoutesRuntime,
): void {
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

    scope.post(ROUTE, (request, reply) =>
      withServerSpan("POST /workflow-trigger", request.headers, () => {
        // Carry the event's trace into the fired workflow, like the cron tick does.
        const traceparent = activeTraceparent();
        return runRoute(runtime, reply, triggerEffect(request.body, traceparent));
      }),
    );
  });
}
