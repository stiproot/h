import {
  Cause,
  Data,
  Effect,
  Exit,
  type ManagedRuntime,
  Option,
  ParseResult,
  Predicate,
  Schema,
} from "effect";
import type { FastifyInstance, FastifyReply } from "fastify";
import { activeTraceparent, withAmbientParent, withServerSpan } from "telemetry";

import type { DaprPublisherTag } from "core-dapr";

import { WatchPolicy } from "../../domain/models/watch.model.ts";
import {
  SaveWorkflowRequest,
  WorkflowParams,
  WorkflowRequest,
  toRequest,
} from "../../domain/models/workflow.model.ts";
import { assertValidCron } from "../../domain/scheduling.ts";
import { WatchStore } from "../../domain/ports/IWatchStore.ts";
import { WorkflowInvoker } from "../../domain/ports/IWorkflowInvoker.ts";
import { WorkflowStore } from "../../domain/ports/IWorkflowStore.ts";
import { invokeWithWatch } from "../../domain/watch-scan.ts";

/** Everything the workflow routes yield from the shared runtime. */
export type WorkflowRoutesEnv = WorkflowInvoker | WorkflowStore | WatchStore | DaprPublisherTag;

export type WorkflowRoutesRuntime = ManagedRuntime.ManagedRuntime<WorkflowRoutesEnv, never>;

/** A saved workflow key that resolved to nothing — mapped to the legacy 404 body. */
class WorkflowNotFoundError extends Data.TaggedError("WorkflowNotFoundError") {}

/** A generic 404 with its own body text (used by the watch routes). */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string;
}> {}

/**
 * Optional body of POST /workflow/run/:key — fire-time params for the saved workflow, plus an
 * optional caller-chosen instanceId/workspaceId so a family run gets a readable, stable
 * worktree/workspace key instead of a generated GUID.
 */
const RunSavedBody = Schema.Struct({
  params: Schema.optional(WorkflowParams),
  instanceId: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
  // Opt-in purge-and-rerun of a terminal instance under the given instanceId (default: attach).
  fresh: Schema.optional(Schema.Boolean),
  // Fire-time watch policy; overrides the saved workflow's stored watch policy wholesale.
  watch: Schema.optional(WatchPolicy),
  watchMeta: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

/** An unparseable cron expression on save — mapped to the legacy 400 body. */
class InvalidCronError extends Data.TaggedError("InvalidCronError")<{
  readonly schedule: string;
}> {}

/**
 * The local Fastify-to-Effect bridge (the agent-server `runHandler` pattern, with this
 * app's richer status logic). Each route builds ONE handler Effect — Schema decode
 * inside it, then yield the port tags — and the Exit maps onto the reply:
 *
 *   success              → options.successStatus ?? 200, value as the body
 *   WorkflowNotFoundError → 404 { error: "Workflow not found" }          (legacy body)
 *   InvalidCronError      → 400 { error: "Invalid cron expression: …" }  (legacy body)
 *   ParseError            → 400 { statusCode, error: "Bad Request", message }
 *   WorkflowError/defects → 500 { statusCode, error: "Internal Server Error", message }
 *
 * `withAmbientParent` is applied HERE, inline at the run edge — it captures the ambient
 * OTel span (the `withServerSpan` server span) synchronously at call time, so the fiber's
 * spans stay parented under the request's trace.
 */
export function runRoute<A, E>(
  runtime: WorkflowRoutesRuntime,
  reply: FastifyReply,
  effect: Effect.Effect<A, E, WorkflowRoutesEnv>,
  options?: { readonly successStatus?: number },
): Promise<void> {
  return runtime.runPromiseExit(withAmbientParent(effect)).then((exit) =>
    Exit.match(exit, {
      onSuccess: (value) => {
        void reply.status(options?.successStatus ?? 200).send(value);
      },
      onFailure: (cause) => {
        const { status, body } = replyFor(cause);
        void reply.status(status).send(body);
      },
    }),
  );
}

// Failures crossing Effect.withSpan arrive Proxy-wrapped, so classification goes by
// `_tag` (Predicate.isTagged / ParseResult.isParseError), never instance identity.
function replyFor(cause: Cause.Cause<unknown>): { status: number; body: unknown } {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    if (Predicate.isTagged(error, "WorkflowNotFoundError")) {
      return { status: 404, body: { error: "Workflow not found" } };
    }
    if (Predicate.isTagged(error, "NotFoundError")) {
      return { status: 404, body: { error: (error as unknown as NotFoundError).message } };
    }
    if (Predicate.isTagged(error, "InvalidCronError")) {
      const { schedule } = error as unknown as InvalidCronError;
      return { status: 400, body: { error: `Invalid cron expression: ${schedule}` } };
    }
    if (ParseResult.isParseError(error)) {
      return {
        status: 400,
        body: { statusCode: 400, error: "Bad Request", message: messageOf(error) },
      };
    }
  }
  return {
    status: 500,
    body: { statusCode: 500, error: "Internal Server Error", message: messageFor(cause) },
  };
}

function messageFor(cause: Cause.Cause<unknown>): string {
  const failure = Cause.failureOption(cause);
  return Option.isSome(failure) ? messageOf(failure.value) : messageOf(Cause.squash(cause));
}

// Tagged errors often carry the raw failure in `cause` rather than their own message;
// fall through to it so the reply body stays as informative as the pre-Effect throw.
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    if (error.message) return error.message;
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return String(error);
  }
  return String(error);
}

export function registerWorkflowRoutes(
  fastify: FastifyInstance,
  runtime: WorkflowRoutesRuntime,
): void {
  fastify.post("/workflow/run", (request, reply) =>
    withServerSpan("POST /workflow/run", request.headers, () => {
      // Captured at the edge, synchronously under the server span — ambient OTel context
      // is not guaranteed inside the fiber.
      const traceparent = activeTraceparent();
      return runRoute(
        runtime,
        reply,
        Effect.gen(function* () {
          // Excess properties are preserved: a run request's payload has always passed
          // through to the workflow input verbatim.
          const body = yield* Schema.decodeUnknown(WorkflowRequest, {
            onExcessProperty: "preserve",
          })(request.body);
          // Registration and invocation share one handler (ruling W6); a `watch` field on the
          // body writes the durable watch:sub:<instanceId> row.
          return yield* invokeWithWatch({ ...body, traceparent });
        }),
        { successStatus: 202 },
      );
    }),
  );

  fastify.post("/workflow/save", (request, reply) =>
    withServerSpan("POST /workflow/save", request.headers, () =>
      runRoute(
        runtime,
        reply,
        Effect.gen(function* () {
          const { key, steps, workspaceId, schedule, disabled, params, watch } =
            yield* Schema.decodeUnknown(SaveWorkflowRequest)(request.body);
          if (schedule !== undefined) {
            yield* Effect.try({
              try: () => assertValidCron(schedule),
              catch: () => new InvalidCronError({ schedule }),
            });
          }
          const store = yield* WorkflowStore;
          yield* store.save(key, {
            steps,
            workspaceId,
            schedule: schedule ? { cron: schedule, savedAt: new Date().toISOString() } : undefined,
            disabled,
            params,
            watch,
          });
          return { key };
        }),
        { successStatus: 201 },
      ),
    ),
  );

  fastify.post<{ Params: { key: string } }>("/workflow/run/:key", (request, reply) =>
    withServerSpan("POST /workflow/run/:key", request.headers, () => {
      const traceparent = activeTraceparent();
      return runRoute(
        runtime,
        reply,
        Effect.gen(function* () {
          // Optional body: fire-time params override the stored defaults key-by-key; a
          // fire-time instanceId/workspaceId overrides the projection (readable run keys).
          // An absent/empty body keeps the pre-params behaviour.
          const { params, instanceId, workspaceId, fresh, watch, watchMeta } =
            yield* Schema.decodeUnknown(RunSavedBody)(request.body ?? {});
          const store = yield* WorkflowStore;
          const workflow = yield* store.get(request.params.key);
          if (Option.isNone(workflow)) return yield* new WorkflowNotFoundError();
          const req = toRequest(workflow.value, traceparent, params);
          // Fire-time watch overrides the stored policy wholesale; either way the row is
          // written here, in the same handler that schedules (ruling W6) — this is how
          // trigger- and cron-fired saved workflows carry supervision too (agreement 9).
          return yield* invokeWithWatch({
            ...req,
            ...(instanceId ? { instanceId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(fresh !== undefined ? { fresh } : {}),
            ...((watch ?? workflow.value.watch) ? { watch: watch ?? workflow.value.watch } : {}),
            ...(watchMeta ? { watchMeta } : { watchMeta: { owner: request.params.key } }),
          });
        }),
        { successStatus: 202 },
      );
    }),
  );

  fastify.post<{ Params: { instanceId: string } }>(
    "/workflow/terminate/:instanceId",
    (request, reply) =>
      withServerSpan("POST /workflow/terminate/:instanceId", request.headers, () =>
        runRoute(
          runtime,
          reply,
          Effect.gen(function* () {
            const invoker = yield* WorkflowInvoker;
            yield* invoker.terminate(request.params.instanceId);
            return { instanceId: request.params.instanceId };
          }),
          { successStatus: 202 },
        ),
      ),
  );

  fastify.get("/workflow/list", (_request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const store = yield* WorkflowStore;
        return { keys: yield* store.list() };
      }),
    ),
  );

  fastify.get<{ Params: { key: string } }>("/workflow/get/:key", (request, reply) =>
    runRoute(
      runtime,
      reply,
      Effect.gen(function* () {
        const store = yield* WorkflowStore;
        const workflow = yield* store.get(request.params.key);
        if (Option.isNone(workflow)) return yield* new WorkflowNotFoundError();
        return workflow.value;
      }),
    ),
  );

  fastify.get<{ Params: { instanceId: string } }>(
    "/workflow/status/:instanceId",
    (request, reply) =>
      runRoute(
        runtime,
        reply,
        Effect.gen(function* () {
          const invoker = yield* WorkflowInvoker;
          return yield* invoker.getStatus(request.params.instanceId);
        }),
      ),
  );

  fastify.get("/dapr/subscribe", async (_request, reply) => {
    // The single well-known trigger topic (see trigger.router.ts): events carrying
    // { key, params } fire the named saved workflow — the pub/sub sibling of /workflow/run/:key.
    return reply.send([
      { pubsubname: "pubsub", topic: "workflow-trigger", route: "workflow-trigger" },
    ]);
  });
}
