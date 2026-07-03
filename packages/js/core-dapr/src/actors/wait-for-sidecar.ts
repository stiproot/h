import { Data, Effect, Schedule } from "effect";

/** The Dapr sidecar did not become ready within the attempt budget. */
export class DaprSidecarError extends Data.TaggedError("DaprSidecarError")<{
  readonly cause: unknown;
  readonly port: string;
  readonly attempts: number;
}> {}

// One readiness probe. /v1.0/healthz/outbound becomes ready once the sidecar has loaded
// components and connected to placement — without waiting for the app to be listening.
// /v1.0/healthz would deadlock: it waits for the app, which waits for it.
const probe = (port: string): Effect.Effect<void, unknown> =>
  Effect.tryPromise(async () => {
    const res = await fetch(`http://localhost:${port}/v1.0/healthz/outbound`);
    if (!res.ok) throw new Error(`sidecar responded ${res.status}`);
  });

/**
 * Retry an arbitrary readiness probe on the sidecar's schedule: up to `maxAttempts`
 * probes, 1 second between attempts — the same budget as the legacy loop. Exported as
 * the test seam (a sync probe + TestClock exercises the schedule with no live sidecar).
 */
export const retryUntilReady = <E>(
  ready: Effect.Effect<void, E>,
  port: string,
  maxAttempts: number,
): Effect.Effect<void, DaprSidecarError> =>
  ready.pipe(
    Effect.retry(
      Schedule.spaced("1 second").pipe(Schedule.intersect(Schedule.recurs(maxAttempts - 1))),
    ),
    Effect.mapError((cause) => new DaprSidecarError({ cause, port, attempts: maxAttempts })),
  );

/** Effect-native sidecar readiness wait; fails with `DaprSidecarError` once the budget is spent. */
export const waitForSidecarEffect = (
  port: string,
  maxAttempts = 60,
): Effect.Effect<void, DaprSidecarError> => retryUntilReady(probe(port), port, maxAttempts);
