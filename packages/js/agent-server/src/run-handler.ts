import { Cause, Effect, Exit, type ManagedRuntime, Option, ParseResult } from "effect";
import { withAmbientParent } from "telemetry";

/**
 * The Fastify-to-Effect bridge (plans/effect-refactor-map.md §2): the ONLY place
 * `runtime.runPromise*` touches an inbound request. A route handler builds one handler
 * Effect (Schema decode INSIDE the Effect, then yield the port tags) and hands it here;
 * the Exit is mapped onto the reply, so a `ParseError` becomes a real 400 and tagged
 * domain errors (AgentRunError, CloneError, SetupError, …) and defects become the 500
 * the pre-Effect handlers produced by throwing into Fastify's default error handler.
 * The error body mirrors Fastify's default `{ statusCode, error, message }` shape.
 */

/** The slice of FastifyReply the bridge needs — structural, so tests can pass a stub. */
export interface HandlerReply {
  status(statusCode: number): unknown;
  send(payload?: unknown): unknown;
}

export interface RunHandlerOptions {
  /** HTTP status for the success reply; defaults to 200 (e.g. 204 for the no-body routes). */
  readonly successStatus?: number;
}

/** Maps a failure Cause to an HTTP status: ParseError (malformed body) → 400, all else → 500. */
export function statusFor(cause: Cause.Cause<unknown>): number {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure) && ParseResult.isParseError(failure.value)) return 400;
  return 500;
}

/** Builds the error reply body, mirroring Fastify's default error shape. */
export function bodyFor(cause: Cause.Cause<unknown>): {
  statusCode: number;
  error: string;
  message: string;
} {
  const statusCode = statusFor(cause);
  return {
    statusCode,
    error: statusCode === 400 ? "Bad Request" : "Internal Server Error",
    message: messageFor(cause),
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

/**
 * Runs a handler Effect through the shared per-process runtime and maps its Exit onto
 * the reply. `withAmbientParent` is applied HERE, inline at the run edge — it captures
 * the ambient OTel span (the Fastify `withServerSpan` server span) synchronously at
 * call time, so the fiber's spans stay parented under the request's trace; applying it
 * at composition time would silently lose the parent.
 */
export function runHandler<A, E, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  reply: HandlerReply,
  effect: Effect.Effect<A, E, R>,
  options?: RunHandlerOptions,
): Promise<void> {
  return runtime.runPromiseExit(withAmbientParent(effect)).then((exit) =>
    Exit.match(exit, {
      onSuccess: (value) => {
        reply.status(options?.successStatus ?? 200);
        reply.send(value);
      },
      onFailure: (cause) => {
        reply.status(statusFor(cause));
        reply.send(bodyFor(cause));
      },
    }),
  );
}
