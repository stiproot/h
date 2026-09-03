import {
  CronStore,
  EventPublisher,
  ExecPolicyStore,
  QuotaStore,
  scanCronsEffect,
  scanDiscoverEffect,
  scanSchedEffect,
  scanWatchesEffect,
  SourceReader,
  WatchStore,
  WfStore,
  WorkflowInvoker,
  WorkflowStore,
} from "engine-core";
import { Clock, Effect, Schedule } from "effect";

import { ProgressPort } from "./ports.ts";

/**
 * The local substrate's ENGINE HOST — the counterpart of workflow-svc, and the last genuinely new
 * component this substrate needs.
 *
 * It holds the tick and runs the engines' `decide` against durable rows. It does NOT compose and it
 * does NOT execute: a fire is a descriptor published to `h.task.>` for the relay, exactly as
 * workflow-svc fires at agent services rather than running agents in-process. That separation is
 * the whole reason the engines could be extracted at all, so collapsing it here would undo the
 * plan it belongs to.
 *
 * A SINGLETON, and enforced by the fabric rather than by convention: two hosts ticking the same
 * rows would double-fire every cron. The lease below is the enforcement — see `claimLease`.
 */

/** Matches the Dapr cron binding's cadence, so `isDue` behaves identically on both substrates. */
export const TICK_MS = 60_000;

/** How long a lease is believed after its last renewal — two missed ticks, then it is up for grabs. */
const LEASE_TTL_MS = TICK_MS * 2.5;

export type EngineHostConfig = {
  /** Identifies this host in the lease, so a refusal can say WHO holds it. */
  readonly hostId: string;
  readonly tickMs?: number;
};

export type EngineLease = {
  readonly hostId: string;
  readonly renewedAt: number;
};

/** The lease store, kept as a port so the host is testable without a fabric. */
export interface LeasePort {
  readonly read: () => Effect.Effect<{ lease: EngineLease; revision: number } | null, Error>;
  /** CAS: writes only if the row still sits at `revision` (0 = must not exist). False ⇒ lost race. */
  readonly write: (lease: EngineLease, revision: number) => Effect.Effect<boolean, Error>;
}

export class EngineHostConflict extends Error {
  constructor(readonly holder: string) {
    super(
      `another engine host holds the lease (${holder}). Only one may tick, or every cron ` +
        "double-fires. Stop it first, or wait for its lease to lapse.",
    );
    this.name = "EngineHostConflict";
  }
}

/**
 * Take the singleton lease, or refuse loud.
 *
 * This is the one place `putFenced`'s compare-and-set earns its keep. Everywhere else the epoch
 * fence lives in the shared scan, so using KV's CAS would make one substrate behave differently
 * for no reason; a lease is local-only machinery with no service counterpart, and a lost race here
 * MUST be observed rather than papered over — two hosts that both believe they won is exactly the
 * double-firing this prevents.
 *
 * A lapsed lease (older than the TTL) is claimable: a host that was SIGKILLed cannot release its
 * own lease, and requiring an operator to clear one by hand would make a crash need a human.
 */
export const claimLease = (
  lease: LeasePort,
  config: EngineHostConfig,
): Effect.Effect<void, Error | EngineHostConflict, never> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const held = yield* lease.read();
    if (held !== null && held.lease.hostId !== config.hostId) {
      const age = now - held.lease.renewedAt;
      if (age < LEASE_TTL_MS) return yield* Effect.fail(new EngineHostConflict(held.lease.hostId));
    }
    const won = yield* lease.write({ hostId: config.hostId, renewedAt: now }, held?.revision ?? 0);
    // Losing the CAS means another host claimed between our read and our write. Refusing is the
    // only safe answer: the alternative is retrying into a race we just lost.
    if (!won) return yield* Effect.fail(new EngineHostConflict("another host (lost the race)"));
  });

export type TickReport = {
  readonly crons: number;
  readonly scheds: number;
  /** Runs the watcher FINALIZED this tick — budget-terminated, retried, or settled. */
  readonly watches: number;
  /** Issues the discovery cron fanned out this tick (one workflow each, serialized). */
  readonly discovered: number;
  readonly errors: readonly string[];
};

/**
 * One tick: renew the lease, then run each scan.
 *
 * Each scan's failure is CAUGHT and reported rather than propagated, mirroring the service
 * substrate's tick route ("each scan's failure never fails the tick"). One engine having a bad
 * minute must not stop the others — a cron that cannot read its rows should not also stop every
 * scheduled fire.
 */
export const tick = (
  lease: LeasePort,
  config: EngineHostConfig,
): Effect.Effect<
  TickReport,
  Error | EngineHostConflict,
  | CronStore
  | WorkflowInvoker
  | WorkflowStore
  | WfStore
  | WatchStore
  | ExecPolicyStore
  | QuotaStore
  | EventPublisher
  | SourceReader
  | ProgressPort
> =>
  Effect.gen(function* () {
    // Renewed BEFORE the work, not after: a scan can take longer than the TTL, and a lease that
    // lapses mid-tick would invite a second host in while this one is still firing.
    yield* claimLease(lease, config);

    const errors: string[] = [];
    const crons = yield* scanCronsEffect(undefined).pipe(
      Effect.map((report) => report.fired.length),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          errors.push(`cron: ${error instanceof Error ? error.message : String(error)}`);
          return 0;
        }),
      ),
    );
    const watches = yield* scanWatchesEffect(undefined).pipe(
      Effect.map((report) => report.finalized.length),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          errors.push(`watch: ${error instanceof Error ? error.message : String(error)}`);
          return 0;
        }),
      ),
    );
    const discovered = yield* scanDiscoverEffect(undefined).pipe(
      Effect.map((report) => report.fired.length),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          errors.push(`discover: ${error instanceof Error ? error.message : String(error)}`);
          return 0;
        }),
      ),
    );
    const scheds = yield* scanSchedEffect(undefined).pipe(
      Effect.map((report) => report.fired.length),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          errors.push(`sched: ${error instanceof Error ? error.message : String(error)}`);
          return 0;
        }),
      ),
    );
    return { crons, scheds, watches, discovered, errors };
  });

/**
 * Run until interrupted. The lease is claimed ONCE up front so a conflicting host is refused at
 * startup — the operator sees it immediately rather than discovering later that two hosts have
 * been double-firing.
 */
export const runEngineHost = (
  lease: LeasePort,
  config: EngineHostConfig,
): Effect.Effect<
  never,
  Error | EngineHostConflict,
  | CronStore
  | WorkflowInvoker
  | WorkflowStore
  | WfStore
  | WatchStore
  | ExecPolicyStore
  | QuotaStore
  | EventPublisher
  | SourceReader
  | ProgressPort
> =>
  Effect.gen(function* () {
    const progress = yield* ProgressPort;
    yield* claimLease(lease, config);
    yield* progress.emit(
      `⚙ engine host ${config.hostId}: lease held, ticking every ${
        (config.tickMs ?? TICK_MS) / 1000
      }s`,
    );

    return yield* Effect.repeat(
      Effect.gen(function* () {
        const report = yield* tick(lease, config);
        if (
          report.crons > 0 ||
          report.scheds > 0 ||
          report.watches > 0 ||
          report.discovered > 0 ||
          report.errors.length > 0
        ) {
          yield* progress.emit(
            `tick: ${report.crons} cron fire(s), ${report.scheds} scheduled fire(s), ` +
              `${report.watches} watch finalize(s), ${report.discovered} discovered` +
              (report.errors.length > 0 ? ` — ${report.errors.join("; ")}` : ""),
          );
        }
      }),
      Schedule.spaced(config.tickMs ?? TICK_MS),
    ) as Effect.Effect<
      never,
      Error | EngineHostConflict,
      | CronStore
      | WorkflowInvoker
      | WorkflowStore
      | WfStore
      | WatchStore
      | ExecPolicyStore
      | QuotaStore
      | EventPublisher
      | ProgressPort
    >;
  });
