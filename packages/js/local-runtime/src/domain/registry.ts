import {
  CronStore,
  disarmSched,
  ExecPolicy,
  ExecPolicyStore,
  registerSchedForFire,
  resolveFireAt,
  type SchedRegistration,
  StoredWorkflow,
  WatchStore,
  WorkflowStore,
} from "engine-core";
import { Effect, Option, Schema } from "effect";

import type { RegistryEnvelope, RegistryJob } from "./models.ts";

/**
 * Serve one registry query or write against the local substrate's KV buckets.
 *
 * This is the CLI's read/write path for `--local` registry commands, and it exists as a job kind
 * rather than as Python talking to JetStream because the key codec must have exactly one
 * implementation — see `RegistryJob`'s own note.
 *
 * A failure is REPORTED in the envelope rather than thrown: the caller is a CLI rendering a table,
 * and "the fabric is not running" deserves a sentence, not a stack trace. The distinction that
 * matters is preserved though — `ok: false` is a failure to ANSWER, while a successful answer of
 * `null` means the registry genuinely holds nothing under that key.
 */
export const runRegistry = (
  job: RegistryJob,
): Effect.Effect<
  RegistryEnvelope,
  never,
  WorkflowStore | ExecPolicyStore | CronStore | WatchStore
> =>
  Effect.gen(function* () {
    const result = yield* serve(job);
    return { ok: true, op: job.op, result } satisfies RegistryEnvelope;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        ok: false,
        op: job.op,
        error: error instanceof Error ? error.message : String(error),
      } satisfies RegistryEnvelope),
    ),
  );

const serve = (
  job: RegistryJob,
): Effect.Effect<unknown, Error, WorkflowStore | ExecPolicyStore | CronStore | WatchStore> =>
  Effect.gen(function* () {
    switch (job.op) {
      case "workflows.list": {
        const store = yield* WorkflowStore;
        return yield* store.list();
      }
      case "workflows.get": {
        const store = yield* WorkflowStore;
        return Option.getOrNull(yield* store.get(job.key));
      }
      case "workflows.save": {
        const store = yield* WorkflowStore;
        // Decoded before it is stored, not after it is read back: a definition the CLI composed
        // wrongly must be refused at the moment someone publishes it, while they are looking at
        // the command that did it — not on some later run that reads the row.
        const workflow = yield* Schema.decodeUnknown(StoredWorkflow, {
          onExcessProperty: "preserve",
        })(job.workflow);
        yield* store.save(job.key, workflow);
        return { saved: job.key };
      }
      case "crons.list": {
        const store = yield* CronStore;
        return yield* store.listRows();
      }
      case "scheds.list": {
        const store = yield* CronStore;
        return yield* store.listSchedRows();
      }
      case "watches.list": {
        const store = yield* WatchStore;
        return yield* store.listRows();
      }
      case "sched.arm": {
        // engine-core's own seam, not a hand-written row: it owns idempotence (an already-armed id
        // is left untouched) and the row's shape. `resolveFireAt` is here for the same reason —
        // "in 2h" must mean the same instant on both substrates, and date math is exactly the kind
        // of thing two implementations quietly disagree about.
        const fireAt = yield* Effect.try({
          try: () =>
            resolveFireAt(
              { ...(job.at ? { at: job.at } : {}), ...(job.in ? { in: job.in } : {}) },
              Date.now(),
            ),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });
        return yield* registerSchedForFire({
          id: job.id,
          fireAt,
          trigger: job.trigger as SchedRegistration["trigger"],
          ...(job.wf ? { wf: job.wf as SchedRegistration["wf"] } : {}),
          origin: "at",
        });
      }
      case "sched.disarm": {
        return yield* disarmSched(job.key).pipe(
          Effect.mapError((error) =>
            typeof error === "object" && error !== null && "_tag" in error
              ? new Error(`no armed schedule '${job.key}'`)
              : (error as Error),
          ),
        );
      }
      case "exec.get": {
        const store = yield* ExecPolicyStore;
        return Option.getOrNull(yield* store.get());
      }
      case "exec.save": {
        const store = yield* ExecPolicyStore;
        const policy = yield* Schema.decodeUnknown(ExecPolicy, {
          onExcessProperty: "preserve",
        })(job.policy);
        yield* store.save(policy);
        return policy;
      }
    }
  }).pipe(
    // A store failure arrives as `WorkflowError`, whose own message is the tagged-error default
    // ("An error has occurred") — useless to a CLI user. What they need is the CAUSE, which for the
    // overwhelmingly common case is CONNECTION_REFUSED against a fabric that is not up.
    Effect.mapError((error) => new Error(describe(error))),
  );

const describe = (error: unknown): string => {
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null) {
    const message = (cause as { message?: unknown }).message;
    return typeof message === "string" && message.length > 0 ? message : String(cause);
  }
  if (error instanceof Error && error.message) return error.message;
  return String(error);
};
