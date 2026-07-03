import { DaprWorkflowClient } from "@dapr/dapr";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { WorkflowError } from "core";
import { Config, Effect, Layer } from "effect";

import type { WorkflowRequest, WorkflowStatus } from "../domain/models/workflow.model.ts";
import { WorkflowInvoker } from "../domain/ports/IWorkflowInvoker.ts";
import { genericWorkflow } from "./workflows/generic.workflow.ts";

/**
 * Live layer over the Dapr Workflow SDK plus the sidecar's raw workflow HTTP API. The
 * `HttpClient` requirement is captured at layer build, so the port methods stay
 * `R = never` — the composition root provides `NodeHttpClient.layer`.
 *
 * The `DaprWorkflowClient` is bracketed with `acquireRelease`: its documented
 * `stop(): Promise<void>` ("Closes the inner DurableTask client and shutdown the GRPC
 * channel", verified against @dapr/dapr 3.17.0) runs as the layer finalizer on
 * `runtime.dispose()`, `Effect.ignore`d so a shutdown hiccup never fails disposal.
 */
export const WorkflowInvokerLive: Layer.Layer<WorkflowInvoker, never, HttpClient.HttpClient> =
  Layer.scoped(
    WorkflowInvoker,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const daprPort = yield* Config.string("DAPR_HTTP_PORT").pipe(
        Config.withDefault("3500"),
        Effect.orDie,
      );
      const daprBase = `http://localhost:${daprPort}`;
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new DaprWorkflowClient()),
        (c) => Effect.promise(() => c.stop()).pipe(Effect.ignore),
      );

      const asWorkflowError =
        (instanceId: string) =>
        (cause: unknown): WorkflowError =>
          cause instanceof WorkflowError ? cause : new WorkflowError({ cause, instanceId });

      // Reads execution state from the sidecar's workflow API. The SDK's runtimeStatus enum
      // serialises to opaque numbers, so the raw HTTP endpoint is used to return the same
      // string statuses (RUNNING/COMPLETED/FAILED/TERMINATED) the test scripts observe.
      const getStatus = (instanceId: string): Effect.Effect<WorkflowStatus, WorkflowError> =>
        Effect.gen(function* () {
          const response = yield* httpClient.get(
            `${daprBase}/v1.0-beta1/workflows/dapr/${instanceId}`,
          );
          if (response.status < 200 || response.status >= 300) {
            // Silent legacy fallback (behaviour flag): a non-ok status reads as UNKNOWN,
            // never an error — see the port contract.
            return { instanceId, runtimeStatus: "UNKNOWN" };
          }
          const data = (yield* response.json) as {
            runtimeStatus?: string;
            properties?: Record<string, string>;
          };
          return {
            instanceId,
            runtimeStatus: data.runtimeStatus ?? "UNKNOWN",
            output: data.properties?.["dapr.workflow.output"],
          };
        }).pipe(Effect.mapError(asWorkflowError(instanceId)));

      // Removes a terminal workflow instance's state so its id can be reused by a fresh run.
      // The legacy call never checked the response status; only a transport failure surfaces.
      const purge = (instanceId: string): Effect.Effect<void, WorkflowError> =>
        httpClient
          .execute(
            HttpClientRequest.post(`${daprBase}/v1.0-beta1/workflows/dapr/${instanceId}/purge`),
          )
          .pipe(Effect.asVoid, Effect.mapError(asWorkflowError(instanceId)));

      const invoke = (
        input: WorkflowRequest,
      ): Effect.Effect<{ instanceId: string }, WorkflowError> =>
        Effect.gen(function* () {
          // When the caller supplies an instanceId, decide by the existing run's state:
          //  - RUNNING/PENDING: reuse it, so an in-flight retry doesn't start a duplicate.
          //  - terminal (COMPLETED/FAILED/TERMINATED): purge it, so re-invoking actually re-runs
          //    rather than returning the stale finished instance.
          //  - UNKNOWN: it never existed — schedule fresh.
          if (input.instanceId) {
            const { runtimeStatus } = yield* getStatus(input.instanceId);
            if (runtimeStatus === "RUNNING" || runtimeStatus === "PENDING") {
              return { instanceId: input.instanceId };
            }
            if (runtimeStatus !== "UNKNOWN") {
              yield* purge(input.instanceId);
            }
          }
          const instanceId = yield* Effect.tryPromise({
            try: () => client.scheduleNewWorkflow(genericWorkflow, input, input.instanceId),
            catch: (cause) => new WorkflowError({ cause, instanceId: input.instanceId ?? "" }),
          });
          return { instanceId };
        });

      return { invoke, getStatus };
    }),
  );
