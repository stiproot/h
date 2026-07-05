import { HttpClient, HttpClientRequest } from "@effect/platform";
import { WorkflowError } from "core";
import { Duration, Effect, Layer, Option, Schema } from "effect";
import { injectTraceContext } from "telemetry";

import {
  WorkflowRequest,
  WorkflowService,
  WorkflowStatus,
} from "../domain/ports/IWorkflowService.ts";

const DAPR_BASE = `http://localhost:${process.env.DAPR_HTTP_PORT ?? "3500"}`;
const WORKFLOW_APP_ID = "workflow-svc";

// Every call here is fast — `run` only *schedules* the workflow (workflow-svc replies 202
// immediately), it never waits for the run itself — so a short deadline is safe. Well inside the
// 1h Dapr resiliency timeout. Override with WORKFLOW_INVOKE_TIMEOUT_MS.
const INVOKE_TIMEOUT_MS = Number(process.env.WORKFLOW_INVOKE_TIMEOUT_MS ?? 60_000);

const SaveResponse = Schema.Struct({ key: Schema.String });
const RunResponse = Schema.Struct({ instanceId: Schema.String });
const ListResponse = Schema.Struct({ keys: Schema.Array(Schema.String) });

/**
 * Live layer over the sidecar's invoke HTTP API to workflow-svc. The `HttpClient` requirement
 * is captured at layer build, so the port methods stay `R = never` — the composition root
 * provides `NodeHttpClient.layer` when building this layer.
 *
 * Each invoke runs under a CLIENT span (`Effect.withSpan`); the outgoing request carries the
 * W3C `traceparent` via `injectTraceContext`, read inside the fiber where
 * `@effect/opentelemetry`'s tracer bridges the Effect span into the ambient OTel context — so
 * workflow-svc continues this trace. Degrades to plain headers when tracing isn't initialised,
 * exactly like the legacy `withClientSpan` path.
 */
export const WorkflowServiceLive: Layer.Layer<WorkflowService, never, HttpClient.HttpClient> =
  Layer.effect(
    WorkflowService,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const asWorkflowError =
        (instanceId: string) =>
        (cause: unknown): WorkflowError =>
          cause instanceof WorkflowError ? cause : new WorkflowError({ cause, instanceId });

      // Timeout → WorkflowError, raw HTTP/body failures → WorkflowError, all under one CLIENT
      // span named exactly like the legacy withClientSpan (`invoke workflow-svc/<method>`).
      const withInvokePolicy =
        (method: string, instanceId: string) =>
        <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, WorkflowError> =>
          effect.pipe(
            Effect.timeoutFail({
              duration: Duration.millis(INVOKE_TIMEOUT_MS),
              onTimeout: () =>
                new WorkflowError({
                  cause: new Error(
                    `Workflow service invoke ${method} timed out after ${INVOKE_TIMEOUT_MS}ms`,
                  ),
                  instanceId,
                }),
            }),
            Effect.mapError(asWorkflowError(instanceId)),
            Effect.withSpan(`invoke ${WORKFLOW_APP_ID}/${method}`, {
              kind: "client",
              attributes: { "dapr.app_id": WORKFLOW_APP_ID, "dapr.method": method },
            }),
          );

      // POST to workflow-svc; non-2xx → WorkflowError with the legacy message text.
      const invokePost = (
        method: string,
        body: unknown,
        instanceId: string,
      ): Effect.Effect<unknown, WorkflowError> =>
        Effect.gen(function* () {
          // Read the traceparent inside the span region so the header carries the CLIENT span.
          const headers = yield* Effect.sync(() => injectTraceContext({}));
          const request = yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(
              `${DAPR_BASE}/v1.0/invoke/${WORKFLOW_APP_ID}/method/${method}`,
            ).pipe(HttpClientRequest.setHeaders(headers)),
            body,
          );
          const response = yield* client.execute(request);
          if (response.status < 200 || response.status >= 300) {
            const text = yield* response.text;
            return yield* new WorkflowError({
              cause: new Error(`Workflow service error ${response.status}: ${text}`),
              instanceId,
            });
          }
          return yield* response.json;
        }).pipe(withInvokePolicy(method, instanceId));

      // GET from workflow-svc; 404 → Option.none (the not-found contract), non-ok → WorkflowError.
      const invokeGet = (
        method: string,
        instanceId: string,
      ): Effect.Effect<Option.Option<unknown>, WorkflowError> =>
        Effect.gen(function* () {
          const headers = yield* Effect.sync(() => injectTraceContext({}));
          const response = yield* client.execute(
            HttpClientRequest.get(
              `${DAPR_BASE}/v1.0/invoke/${WORKFLOW_APP_ID}/method/${method}`,
            ).pipe(HttpClientRequest.setHeaders(headers)),
          );
          if (response.status === 404) return Option.none();
          if (response.status < 200 || response.status >= 300) {
            const text = yield* response.text;
            return yield* new WorkflowError({
              cause: new Error(`Workflow service error ${response.status}: ${text}`),
              instanceId,
            });
          }
          return Option.some(yield* response.json);
        }).pipe(withInvokePolicy(method, instanceId));

      // Decode with excess properties preserved: workflow-svc's payloads carry fields beyond the
      // wire types (schedule/workspaceId/disabled on a stored workflow) and this service has
      // always passed them through to the tool result — a strict decode would strip them.
      const decodePreserving =
        <A, I>(schema: Schema.Schema<A, I>, instanceId: string) =>
        (json: unknown): Effect.Effect<A, WorkflowError> =>
          Schema.decodeUnknown(schema, { onExcessProperty: "preserve" })(json).pipe(
            Effect.mapError(asWorkflowError(instanceId)),
          );

      return {
        save: (req) =>
          invokePost("workflow/save", req, req.key).pipe(
            Effect.flatMap(decodePreserving(SaveResponse, req.key)),
          ),

        run: (req) =>
          invokePost("workflow/run", req, req.instanceId ?? "").pipe(
            Effect.flatMap(decodePreserving(RunResponse, req.instanceId ?? "")),
          ),

        runByKey: (key, params, overrides) =>
          invokePost(
            `workflow/run/${encodeURIComponent(key)}`,
            {
              ...(params ? { params } : {}),
              ...(overrides?.instanceId ? { instanceId: overrides.instanceId } : {}),
              ...(overrides?.workspaceId ? { workspaceId: overrides.workspaceId } : {}),
              ...(overrides?.fresh !== undefined ? { fresh: overrides.fresh } : {}),
              ...(overrides?.watch ? { watch: overrides.watch } : {}),
            },
            key,
          ).pipe(Effect.flatMap(decodePreserving(RunResponse, key))),

        list: () =>
          invokeGet("workflow/list", "").pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed({ keys: [] as readonly string[] }),
                onSome: decodePreserving(ListResponse, ""),
              }),
            ),
          ),

        getByKey: (key) =>
          invokeGet(`workflow/get/${encodeURIComponent(key)}`, key).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedNone,
                onSome: (json) =>
                  decodePreserving(WorkflowRequest, key)(json).pipe(Effect.map(Option.some)),
              }),
            ),
          ),

        terminate: (instanceId) =>
          invokePost(`workflow/terminate/${encodeURIComponent(instanceId)}`, {}, instanceId).pipe(
            Effect.flatMap(
              decodePreserving(Schema.Struct({ instanceId: Schema.String }), instanceId),
            ),
          ),

        getStatus: (instanceId) =>
          invokeGet(`workflow/status/${encodeURIComponent(instanceId)}`, instanceId).pipe(
            Effect.flatMap(
              Option.match({
                // Legacy fallback: an unknown instance reads as UNKNOWN, not an error.
                onNone: () => Effect.succeed({ instanceId, runtimeStatus: "UNKNOWN" }),
                onSome: decodePreserving(WorkflowStatus, instanceId),
              }),
            ),
          ),
      };
    }),
  );
