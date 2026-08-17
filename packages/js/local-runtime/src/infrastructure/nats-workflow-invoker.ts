import { WorkflowError } from "core";
import { WfStore, WorkflowInvoker, type WorkflowStatus } from "engine-core";
import { Effect, Layer, Option } from "effect";
import { connect } from "nats";

/**
 * The local substrate's `IWorkflowInvoker` — what an engine reaches the world through.
 *
 * The three methods split three ways, and the split says what this substrate is:
 *
 *  - **invoke** PUBLISHES a fire descriptor to `h.task.>`; the relay executes it. The engine host
 *    never runs work itself, mirroring workflow-svc firing at agent services rather than running
 *    agents in-process. The descriptor is pre-composed (`steps`, not `template`) because composing
 *    is the relay's job and deciding is the engine's.
 *  - **getStatus** READS `wf:run:<instanceId>` — the row the run wrote about itself. Dapr answers
 *    this on the service substrate; here the registry is the only thing that can, which is why it
 *    had to stop being artifact-keyed first.
 *  - **terminate** ASKS. The engine host owns no running process, so it publishes a control message
 *    to whichever relay holds the child — a genuinely different capability from Dapr terminating an
 *    instance it owns, and the asymmetry is documented on the method.
 */

/**
 * How long a `running` row is believed before it reads as UNKNOWN.
 *
 * This has no service-substrate counterpart and is the one behaviour that genuinely diverges, so
 * it is worth being precise about why. A `wf:` row is written BY THE RUN, so a run that dies —
 * killed, crashed, its relay SIGKILLed — leaves `running` behind forever and cannot correct it.
 * Dapr does not have this problem: it observes instances from outside and reports TERMINATED.
 *
 * Reporting a dead run as RUNNING would pin a cron permanently, and `running` is not `UNKNOWN`, so
 * the engines' unknown-streak escape would never fire. Aging it into UNKNOWN hands it to exactly
 * that escape, which then re-fires the cadence after its own limit — the behaviour a vanished
 * instance already gets on the service side.
 *
 * Deliberately generous relative to the 60s tick: an agent step can legitimately run for many
 * minutes without touching the row, and a false UNKNOWN costs a duplicate run.
 */
const RUNNING_STALE_AFTER_MS = 30 * 60_000;

/** wf: statuses → the runtime statuses the engines' TERMINAL set is written against. */
const RUNTIME_STATUS = {
  done: "COMPLETED",
  failed: "FAILED",
  // A row someone else marked abandoned. TERMINATED rather than FAILED: the run did not decide
  // its own outcome, which is the distinction the service substrate's terminate produces too.
  orphaned: "TERMINATED",
  running: "RUNNING",
} as const;

export interface FirePublisher {
  readonly publish: (descriptor: Record<string, unknown>) => Promise<void>;
  /** Fire-and-forget control: ask whichever relay owns this run to stop it. */
  readonly control: (subject: string, data: Record<string, unknown>) => Promise<void>;
}

/** Publishes a fire descriptor onto the task queue the relay consumes. */
export const natsFirePublisher = (url: string, queue: string): FirePublisher => ({
  publish: async (descriptor) => {
    const nc = await connect({ servers: url, timeout: 3000, maxReconnectAttempts: 2 });
    try {
      await nc
        .jetstream()
        .publish(`h.task.${queue}`, new TextEncoder().encode(JSON.stringify(descriptor)), {
          // The fire is idempotent by INSTANCE id: an engine that re-decides the same tick (a
          // retried scan, a redelivered message) must not queue the same run twice. The service
          // substrate gets this from mark-before-fire + instance reuse; here it is the stream's.
          msgID: String(descriptor.instanceId),
        });
    } finally {
      await nc.drain();
    }
  },
  control: async (subject, data) => {
    const nc = await connect({ servers: url, timeout: 3000, maxReconnectAttempts: 2 });
    try {
      // CORE nats, not JetStream: only a LIVE relay can act on a terminate, and a queued one for a
      // run that already finished is noise. The engine's durable record of the decision is the
      // watch row it just wrote, not this message.
      nc.publish(subject, new TextEncoder().encode(JSON.stringify(data)));
      await nc.flush();
    } finally {
      await nc.drain();
    }
  },
});

export const NatsWorkflowInvokerLive = (
  publisher: FirePublisher,
): Layer.Layer<WorkflowInvoker, never, WfStore> =>
  Layer.effect(
    WorkflowInvoker,
    Effect.gen(function* () {
      const wf = yield* WfStore;

      return {
        invoke: (input) =>
          Effect.tryPromise({
            try: async () => {
              await publisher.publish({
                v: 1,
                steps: input.steps,
                params: input.params ?? {},
                group: input.instanceId,
                instanceId: input.instanceId,
                queue: "default",
                step: 1,
                // An engine fire is ONE execution, not a loop: the step budget exists to bound a
                // self-amplifying hand-off chain, and an engine's recurrence is bounded by its own
                // row's budget instead.
                maxSteps: 1,
                ...(input.wf ? { wf: input.wf } : {}),
              });
              return { instanceId: input.instanceId ?? "" };
            },
            catch: (cause) =>
              new WorkflowError({ cause, instanceId: input.instanceId ?? "unknown" }),
          }),

        getStatus: (instanceId) =>
          wf.getRun(instanceId).pipe(
            Effect.map(
              Option.match({
                // No row: either the run has not started, or it never wrote one. UNKNOWN is the
                // honest answer and the engines already know what to do with it — never a guess
                // in either direction, since RUNNING would pin and COMPLETED would double-fire.
                onNone: (): WorkflowStatus => ({ instanceId, runtimeStatus: "UNKNOWN" }),
                onSome: (row): WorkflowStatus => ({
                  instanceId,
                  runtimeStatus: isStaleRunning(row.status, row.updatedAt)
                    ? "UNKNOWN"
                    : RUNTIME_STATUS[row.status],
                  ...(row.output === undefined ? {} : { output: row.output }),
                }),
              }),
            ),
            // The port's documented posture: a status READ never fails into the error channel,
            // because every caller's fallback is UNKNOWN anyway and a thrown read would fail a
            // whole scan tick over one unreadable row.
            Effect.catchAll(() => Effect.succeed({ instanceId, runtimeStatus: "UNKNOWN" })),
          ),

        /**
         * Ask the relay holding this run to kill it.
         *
         * Best-effort BY DESIGN, and the asymmetry with the service substrate is worth naming: Dapr
         * terminates an instance it owns, while here the engine host owns nothing — it asks the
         * process that does. A run executing in an operator's FOREGROUND shell is reachable by
         * nobody, which is why `--budget` on a foreground `--local` run is enforced by the driver
         * between steps instead (execute.ts) rather than by this.
         *
         * A publish that lands with no listener is therefore a valid outcome, not a failure: the
         * watch row already records the decision, and the scan's next tick observes whatever
         * actually happened rather than assuming this worked.
         */
        terminate: (instanceId) =>
          Effect.tryPromise({
            try: () =>
              publisher.control(`h.control.terminate.${instanceId}`, {
                instanceId,
                at: new Date().toISOString(),
              }),
            catch: (cause) => new WorkflowError({ cause, instanceId }),
          }),
      };
    }),
  );

/** A `running` row older than the staleness bound reads as UNKNOWN — see the constant's note. */
const isStaleRunning = (status: keyof typeof RUNTIME_STATUS, updatedAt: string): boolean => {
  if (status !== "running") return false;
  const age = Date.now() - Date.parse(updatedAt);
  return Number.isNaN(age) ? true : age > RUNNING_STALE_AFTER_MS;
};
