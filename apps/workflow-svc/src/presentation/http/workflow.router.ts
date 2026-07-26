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

import type { WorkflowError } from "core";
import type { DaprPublisherTag } from "core-dapr";

import { WatchPolicy } from "../../domain/models/watch.model.ts";
import {
  SaveWorkflowRequest,
  WorkflowParams,
  WorkflowRequest,
  toRequest,
} from "../../domain/models/workflow.model.ts";
import { CRON_DISARM_TOPIC, CronPolicy } from "../../domain/models/cron.model.ts";
import { wfIdentityFrom } from "../../domain/models/wf.model.ts";
import { assertValidCron, resolveFireAt } from "../../domain/scheduling.ts";
import { advanceSched, registerSchedForFire } from "../../domain/schedule-scan.ts";
import { ChainStore } from "../../domain/ports/IChainStore.ts";
import { CronStore } from "../../domain/ports/ICronStore.ts";
import { SourceReader } from "../../domain/ports/ISourceReader.ts";
import { WatchStore } from "../../domain/ports/IWatchStore.ts";
import { WfStore } from "../../domain/ports/IWfStore.ts";
import { WorkflowInvoker } from "../../domain/ports/IWorkflowInvoker.ts";
import { WorkflowStore } from "../../domain/ports/IWorkflowStore.ts";
import { invokeWithWatch } from "../../domain/watch-scan.ts";

/** Everything the workflow routes (and the cron tick's chain/watch scans) yield from the runtime. */
export type WorkflowRoutesEnv =
  | WorkflowInvoker
  | WorkflowStore
  | WatchStore
  | ChainStore
  | CronStore
  | WfStore
  | SourceReader
  | DaprPublisherTag;

export type WorkflowRoutesRuntime = ManagedRuntime.ManagedRuntime<WorkflowRoutesEnv, never>;

/** A saved workflow key that resolved to nothing — mapped to the legacy 404 body. */
class WorkflowNotFoundError extends Data.TaggedError("WorkflowNotFoundError") {}

/** A generic 404 with its own body text (used by the watch routes). */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string;
}> {}

/**
 * Optional body of POST /workflow/run/:key — fire-time params for the saved workflow, plus an
 * optional caller-chosen instanceId/workspaceId so a template run gets a readable, stable
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
  // Fire-time cron policy: recur this workflow on a cadence until its goal resolves or the budget is
  // spent. Registers a cron:sub row in this same handler (sibling of `watch`); needs the run to carry
  // a wf-identity (repo+slug) — the cron key mirrors the wf: coords.
  cron: Schema.optional(CronPolicy),
  // One-shot schedule: fire this saved workflow ONCE at an absolute time (`at`, ISO) or after a
  // relative delay (`in`, e.g. "2h"). When set, the handler ARMS a cron:sched row instead of
  // invoking now, and returns { scheduled, fireAt }. Exactly one of at/in; mutually exclusive with a
  // cron cadence (a schedule fires once, a cron recurs).
  at: Schema.optional(Schema.String),
  in: Schema.optional(Schema.String),
});

/**
 * Body of POST /workflow/pause/:instanceId — the saved workflow to resume (key + fire-time params),
 * when to resume (exactly one of at/in), and an optional workspace override (defaults to reusing the
 * paused instance's own id as the workspace key).
 */
const PauseBody = Schema.Struct({
  key: Schema.String,
  params: Schema.optional(WorkflowParams),
  at: Schema.optional(Schema.String),
  in: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
});

/** A `--at`/`--in` given alongside a `--cron` cadence — one-shot and recurring are mutually exclusive. */
class ScheduleConflictsCronError extends Data.TaggedError("ScheduleConflictsCronError") {}
/** A bad `at` instant / `in` duration on a scheduled run — mapped to 400. */
export class InvalidScheduleError extends Data.TaggedError("InvalidScheduleError")<{
  readonly message: string;
}> {}

/** An unparseable cron expression on save — mapped to the legacy 400 body. */
export class InvalidCronError extends Data.TaggedError("InvalidCronError")<{
  readonly schedule: string;
}> {}

/** A `cron` field on a run that carries no wf-identity (repo+slug) — mapped to 400. */
class CronNeedsIdentityError extends Data.TaggedError("CronNeedsIdentityError") {}

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
    if (Predicate.isTagged(error, "CronNeedsIdentityError")) {
      return {
        status: 400,
        body: { error: "cron requires a wf-identity — pass repo and slug params" },
      };
    }
    if (Predicate.isTagged(error, "ScheduleConflictsCronError")) {
      return {
        status: 400,
        body: { error: "at/in (one-shot schedule) cannot be combined with cron (recurring)" },
      };
    }
    if (Predicate.isTagged(error, "InvalidScheduleError")) {
      return {
        status: 400,
        body: { error: (error as unknown as InvalidScheduleError).message },
      };
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
          // A cron recurs under the wf: coords, so an armCron (inline embedded recurrence, D1) needs
          // the identity — same rule the saved run route enforces via CronNeedsIdentityError.
          if (body.armCron && !body.wf) return yield* new CronNeedsIdentityError();
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
          const { key, steps, workspaceId, schedule, disabled, params, watch, outputs } =
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
            outputs,
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
          const {
            params,
            instanceId,
            workspaceId,
            fresh,
            watch,
            watchMeta,
            cron,
            at,
            in: inDur,
          } = yield* Schema.decodeUnknown(RunSavedBody)(request.body ?? {});
          const scheduled = at !== undefined || inDur !== undefined;
          // One-shot schedule and recurring cron are mutually exclusive.
          if (scheduled && cron) return yield* new ScheduleConflictsCronError();
          // Fail fast on a bad cadence before firing anything.
          if (cron) {
            yield* Effect.try({
              try: () => assertValidCron(cron.cadence),
              catch: () => new InvalidCronError({ schedule: cron.cadence }),
            });
          }
          const store = yield* WorkflowStore;
          const workflow = yield* store.get(request.params.key);
          if (Option.isNone(workflow)) return yield* new WorkflowNotFoundError();
          const req = toRequest(workflow.value, traceparent, params);
          // wf-registry identity: the saved KEY is the workflow name; repo+slug come from the
          // merged params (fire-time over stored). Opt-in — absent repo/slug ⇒ no row (§3c).
          const wf = wfIdentityFrom(req.params, request.params.key);
          // A cron recurs the workflow — its key mirrors the wf: coords, so it needs the identity.
          if (cron && !wf) return yield* new CronNeedsIdentityError();
          // ---- One-shot schedule: ARM a cron:sched row instead of invoking now. ----
          if (scheduled) {
            const fireAt = yield* Effect.try({
              try: () => resolveFireAt({ at, in: inDur }, Date.now()),
              catch: (e) => new InvalidScheduleError({ message: messageOf(e) }),
            });
            // A readable, stable id: the caller's instanceId, else key + fire instant.
            const schedRowId = instanceId ?? `${request.params.key}--at-${Date.parse(fireAt)}`;
            const armed = yield* registerSchedForFire({
              id: schedRowId,
              fireAt,
              source: {
                mode: "saved",
                key: request.params.key,
                ...(req.params ? { params: req.params } : {}),
              },
              ...(wf ? { wf } : {}),
              ...((watch ?? workflow.value.watch) ? { watch: watch ?? workflow.value.watch } : {}),
              origin: "at",
            });
            return { scheduled: armed.schedId, fireAt };
          }
          // Watch stays handler-side (§10: before-work, mark-before-fire): persist-then-invoke via
          // invokeWithWatch. The --cron recurrence, by contrast, is armed by the RUN's own closing
          // bracket (register-cron activity) — the route passes it through as `armCron`; it does NOT
          // register the cron itself (§10: crons via activities, idempotent so re-fires don't reset it).
          const result = yield* invokeWithWatch({
            ...req,
            ...(wf ? { wf } : {}),
            ...(instanceId ? { instanceId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(fresh !== undefined ? { fresh } : {}),
            ...((watch ?? workflow.value.watch) ? { watch: watch ?? workflow.value.watch } : {}),
            ...(watchMeta ? { watchMeta } : { watchMeta: { owner: request.params.key } }),
            ...(cron && wf
              ? {
                  armCron: {
                    cadence: cron.cadence,
                    workflow: request.params.key,
                    ...(cron.budget ? { budget: cron.budget } : {}),
                  },
                }
              : {}),
          });
          return result;
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

  // Pause a running workflow and resume it later (stop-and-continue, docs/plans/schedule-and-fallback):
  // terminate the instance NOW, and arm a cron:sched row that re-fires the saved workflow after the
  // delay, REUSING the paused run's workspace (worktree/state carry over). The continuation re-enters
  // the workflow from the top; progress rides the persisted worktree + the agent's session resume.
  fastify.post<{ Params: { instanceId: string } }>(
    "/workflow/pause/:instanceId",
    (request, reply) =>
      withServerSpan("POST /workflow/pause/:instanceId", request.headers, () => {
        const traceparent = activeTraceparent();
        return runRoute(
          runtime,
          reply,
          Effect.gen(function* () {
            const {
              key,
              params,
              at,
              in: inDur,
              workspaceId,
            } = yield* Schema.decodeUnknown(PauseBody)(request.body ?? {});
            const fireAt = yield* Effect.try({
              try: () => resolveFireAt({ at, in: inDur }, Date.now()),
              catch: (e) => new InvalidScheduleError({ message: messageOf(e) }),
            });
            const paused = request.params.instanceId;
            // Terminate the running instance (best-effort: a terminal instance is fine to pause).
            const invoker = yield* WorkflowInvoker;
            yield* invoker.terminate(paused).pipe(Effect.ignore);
            const store = yield* WorkflowStore;
            const stored = yield* store.get(key);
            if (Option.isNone(stored)) return yield* new WorkflowNotFoundError();
            const merged = toRequest(stored.value, traceparent, params).params;
            const wf = wfIdentityFrom(merged, key);
            const armed = yield* registerSchedForFire({
              // A distinct id so the resume runs under its own instance while reusing the workspace.
              id: `${paused}--resume`,
              fireAt,
              source: { mode: "saved", key, ...(merged ? { params: merged } : {}) },
              // Reuse the paused run's workspace (default: its own instance id was the workspace key).
              workspaceId: workspaceId ?? paused,
              ...(wf ? { wf } : {}),
              ...(stored.value.watch ? { watch: stored.value.watch } : {}),
              origin: "pause",
            });
            return { paused, scheduled: armed.schedId, fireAt };
          }),
          { successStatus: 202 },
        );
      }),
  );

  // Resume a paused workflow NOW (before its scheduled time): advance the cron:sched row's fireAt to
  // now so the next tick fires the continuation.
  fastify.post<{ Params: { schedId: string } }>("/workflow/resume/:schedId", (request, reply) =>
    withServerSpan("POST /workflow/resume/:schedId", request.headers, () =>
      runRoute(
        runtime,
        reply,
        Effect.gen(function* () {
          const row = yield* advanceSched(request.params.schedId).pipe(
            Effect.mapError((e) =>
              "_tag" in e && e._tag === "NotFound"
                ? new NotFoundError({
                    message: `paused schedule not found: ${request.params.schedId}`,
                  })
                : (e as WorkflowError),
            ),
          );
          return { resumed: request.params.schedId, status: row.status, fireAt: row.fireAt };
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
    // Two well-known topics: workflow-trigger (trigger.router — events carrying { key, params } fire
    // the named saved workflow, the pub/sub sibling of /workflow/run/:key) and cron-disarm
    // (cron.router — a finalizing chain deactivates a member-armed cron without writing cron:sub, D6).
    return reply.send([
      { pubsubname: "pubsub", topic: "workflow-trigger", route: "workflow-trigger" },
      { pubsubname: "pubsub", topic: CRON_DISARM_TOPIC, route: "cron-disarm" },
    ]);
  });
}
