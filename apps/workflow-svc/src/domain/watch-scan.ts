import type { WorkflowError } from "core";
import { DaprPublisherTag } from "core-dapr";
import { Effect, Option } from "effect";

import type { StepDefinition } from "./models/workflow.model.ts";
import type { SchedRow } from "./models/schedule.model.ts";
import {
  type WatchOutcome,
  type WatchPolicy,
  type WatchResubmit,
  type WatchRow,
  ledgerDate,
} from "./models/watch.model.ts";
import {
  type WorkflowStep,
  type WorkflowParams,
  type WorkflowRequest,
  toRequest,
} from "./models/workflow.model.ts";
import { executorFromAgentId, mergeAutoDeny } from "./exec-policy.ts";
import { CronStore } from "./ports/ICronStore.ts";
import { ExecPolicyStore } from "./ports/IExecPolicyStore.ts";
import { WatchStore } from "./ports/IWatchStore.ts";
import { WorkflowInvoker } from "./ports/IWorkflowInvoker.ts";
import { WorkflowStore } from "./ports/IWorkflowStore.ts";
import { decide, settle } from "./watch-engine.ts";

/**
 * The effectful half of the watch engine (docs/plans/impl/watcher-primitive.md §4): registration on
 * the fire paths, and the per-tick scan that reads every active row, asks the pure engine
 * (watch-engine.ts) what to do, and executes the closed action vocabulary — terminate (own
 * subject only), record (own watch:* row only), publish (workflow-events), retry (re-fire the
 * stored resubmit), escalate (fire a published template, budgeted and fail-closed gated).
 *
 * Every row-mutating action is epoch-fenced (ruling W5): it re-reads the row and no-ops when
 * the epoch moved — a re-fire created a new incarnation and this decision is stale.
 */

const PUBSUB = "pubsub";
const EVENTS_TOPIC = "workflow-events";
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "TERMINATED"]);

// CronStore is required because the usage-limit fallback arms a cron:sched row (a deferred
// continuation under a different agent) — the watcher never sleeps; the schedule engine fires it.
// ExecPolicyStore: the auto-deny — a usage-limited finalize fences the executor engine-wide
// (docs/plans/impl/usage-limit-auto-deny.md).
export type WatchScanEnv =
  | WatchStore
  | WorkflowInvoker
  | WorkflowStore
  | CronStore
  | ExecPolicyStore
  | DaprPublisherTag;

export type WatchScanReport = {
  scanned: number;
  finalized: string[];
  retried: string[];
  terminated: string[];
  escalated: string[];
  fallbacks: string[];
  autoDenied: string[];
  errors: string[];
  disabled?: boolean;
};

// ---------------------------------------------------------------------------
// Registration (called by every fire path, co-located with the schedule decision — ruling W6)
// ---------------------------------------------------------------------------

export type RegisterOptions = {
  readonly fresh?: boolean;
  readonly meta?: WorkflowParams;
  readonly resubmit?: WatchResubmit;
};

/**
 * Registers (or epoch-refreshes) the watch row for a fire of `instanceId`. Mark-before-fire:
 * call this BEFORE invoking when the id is caller-chosen, so a crash between the two leaves a
 * `scheduling` row the scan heals as orphaned instead of a silently unsupervised run.
 *
 * - `watch` set + no active row (or `fresh`): write a new incarnation (epoch+1, attempts+1).
 * - `watch` set + active row, not fresh: the invoker will reuse/attach — same incarnation,
 *   row left untouched.
 * - `watch` absent: nothing to register, but a `fresh` re-fire still refreshes an existing
 *   row's epoch and deadline base (ruling W5) so the stale watch cannot budget-terminate the
 *   new incarnation with the old startedAt.
 */
export const registerWatchForFire = (
  instanceId: string,
  watch: WatchPolicy | undefined,
  options: RegisterOptions = {},
): Effect.Effect<{ registered: boolean }, WorkflowError, WatchStore> =>
  Effect.gen(function* () {
    const ws = yield* WatchStore;
    const existing = yield* ws.getRow(instanceId);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    if (watch === undefined) {
      if (Option.isSome(existing) && options.fresh === true) {
        yield* ws.saveRow(
          newIncarnation(instanceId, existing.value, existing.value.policy, options, now),
        );
        yield* ws.bumpLedger(ledgerDate(nowMs), { runsFired: 1 });
        return { registered: true };
      }
      return { registered: false };
    }

    if (
      Option.isSome(existing) &&
      existing.value.status !== "finalized" &&
      options.fresh !== true
    ) {
      return { registered: true };
    }

    const prev = Option.getOrUndefined(existing);
    yield* ws.saveRow(newIncarnation(instanceId, prev, watch, options, now));
    yield* ws.bumpLedger(ledgerDate(nowMs), { runsFired: 1 });
    return { registered: true };
  });

function newIncarnation(
  instanceId: string,
  prev: WatchRow | undefined,
  policy: WatchPolicy,
  options: RegisterOptions,
  now: string,
): WatchRow {
  const resubmit = options.resubmit ?? prev?.resubmit;
  const meta = options.meta ?? prev?.meta;
  return {
    instanceId,
    epoch: (prev?.epoch ?? 0) + 1,
    attempts: (prev?.attempts ?? 0) + 1,
    startedAt: now,
    policy,
    ...(resubmit ? { resubmit } : {}),
    status: "scheduling",
    lastStatus: "SCHEDULED",
    unknownStreak: 0,
    ...(meta ? { meta } : {}),
    updatedAt: now,
  };
}

/**
 * The one choke point every fire path goes through (ruling W6): registration cannot silently
 * detach from invocation because both happen in the same handler. Caller-chosen ids register
 * mark-before-fire (a crash between the two leaves a `scheduling` row the scan heals);
 * generated ids register right after the schedule returns them. The `watch` field is stripped
 * off the request here — it is registry data, not workflow input.
 */
export const invokeWithWatch = (
  request: WorkflowRequest,
): Effect.Effect<
  { instanceId: string; watching: boolean },
  WorkflowError,
  WorkflowInvoker | WatchStore
> =>
  Effect.gen(function* () {
    const invoker = yield* WorkflowInvoker;
    const { watch, watchMeta, ...req } = request;
    const options: RegisterOptions = {
      ...(req.fresh !== undefined ? { fresh: req.fresh } : {}),
      ...(watchMeta ? { meta: watchMeta } : {}),
      ...(watch ? { resubmit: toResubmit(req) } : {}),
    };
    if (req.instanceId) {
      const { registered } = yield* registerWatchForFire(req.instanceId, watch, options);
      const { instanceId } = yield* invoker.invoke(req);
      return { instanceId, watching: registered };
    }
    const { instanceId } = yield* invoker.invoke(req);
    const { registered } = yield* registerWatchForFire(instanceId, watch, options);
    return { instanceId, watching: registered };
  });

// ---------------------------------------------------------------------------
// The scan (one per cron tick)
// ---------------------------------------------------------------------------

export const scanWatchesEffect = (
  traceparent: string | undefined,
): Effect.Effect<WatchScanReport, WorkflowError, WatchScanEnv> =>
  Effect.gen(function* () {
    const ws = yield* WatchStore;
    const nowMs = Date.now();
    const config = yield* ws.getConfig();
    // Absent config means ENABLED (see WatchConfig); disarm is explicit and loud — the
    // heartbeat records it, so a staleness check can tell "disarmed" from "dead".
    const enabled = Option.isNone(config) || config.value.enabled !== false;
    yield* ws.heartbeat({ at: new Date(nowMs).toISOString(), enabled }).pipe(Effect.ignore);

    const report: WatchScanReport = {
      scanned: 0,
      finalized: [],
      retried: [],
      terminated: [],
      escalated: [],
      fallbacks: [],
      autoDenied: [],
      errors: [],
    };
    if (!enabled) return { ...report, disabled: true };

    const rows = yield* ws.listRows();
    const active = rows.filter((row) => row.status !== "finalized");
    report.scanned = active.length;
    for (const row of active) {
      // One row's failure never starves the rest of the fleet.
      yield* processRow(row, nowMs, traceparent, report).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            report.errors.push(`${row.instanceId}: ${messageOf(err)}`);
          }),
        ),
      );
    }
    return report;
  });

const processRow = (
  row: WatchRow,
  nowMs: number,
  traceparent: string | undefined,
  report: WatchScanReport,
): Effect.Effect<void, WorkflowError, WatchScanEnv> =>
  Effect.gen(function* () {
    const invoker = yield* WorkflowInvoker;
    // Transport failures read as UNKNOWN and the streak machinery owns them — supervision
    // must outlive the infra hiccups it exists to catch (the babysitter's rule, kept).
    const status = yield* invoker
      .getStatus(row.instanceId)
      .pipe(
        Effect.catchAll(() =>
          Effect.succeed({ instanceId: row.instanceId, runtimeStatus: "UNKNOWN" }),
        ),
      );
    const decision = decide(row, status.runtimeStatus, nowMs);
    switch (decision.kind) {
      case "wait": {
        if (decision.changed) yield* saveFenced(row.epoch, stamp(decision.row, nowMs));
        return;
      }
      case "budget-terminate": {
        // W8: terminate surfaces rejection as an error; the loser of a terminate race
        // re-checks status and treats already-terminal as success. Anything else waits for
        // the next tick — never finalize a run that is still actually running.
        const terminated = yield* invoker.terminate(row.instanceId).pipe(
          Effect.as(true),
          Effect.catchAll(() =>
            invoker.getStatus(row.instanceId).pipe(
              Effect.map((s) => TERMINAL_STATUSES.has(s.runtimeStatus)),
              Effect.catchAll(() => Effect.succeed(false)),
            ),
          ),
        );
        if (!terminated) {
          yield* saveFenced(
            row.epoch,
            stamp({ ...decision.row, note: "terminate rejected; retrying next tick" }, nowMs),
          );
          return;
        }
        report.terminated.push(row.instanceId);
        const settled = settle(decision.row, "budget-terminated");
        if (settled.kind === "retry") {
          return yield* executeRetry(decision.row, "budget-terminated", nowMs, traceparent, report);
        }
        return yield* executeFinalize(
          decision.row,
          "budget-terminated",
          nowMs,
          traceparent,
          report,
        );
      }
      case "finalize":
        return yield* executeFinalize(decision.row, decision.outcome, nowMs, traceparent, report);
      case "retry":
        return yield* executeRetry(decision.row, decision.outcome, nowMs, traceparent, report);
    }
  });

// ---------------------------------------------------------------------------
// Actions (each epoch-fenced)
// ---------------------------------------------------------------------------

/** Writes `next` only if the stored row still carries `expectEpoch`; false when stale (W5). */
const saveFenced = (
  expectEpoch: number,
  next: WatchRow,
): Effect.Effect<boolean, WorkflowError, WatchStore> =>
  Effect.gen(function* () {
    const ws = yield* WatchStore;
    const current = yield* ws.getRow(next.instanceId);
    if (Option.isNone(current) || current.value.epoch !== expectEpoch) return false;
    yield* ws.saveRow(next);
    return true;
  });

/**
 * The auto-deny (docs/plans/impl/usage-limit-auto-deny.md): a usage-limited finalize fences the
 * limited EXECUTOR engine-wide by merging a usage-limited entry into `exec:config`, so the
 * whole fleet stops trying that provider instead of every chain discovering the limit
 * independently. The executor is read off the run key that carried the usage-limited stop
 * reason (`run:<instanceId>:<agentId>:<ts>` — the ledger's key shape). mergeAutoDeny is
 * where the safety lives: it never downgrades an operator entry and is idempotent across
 * scan ticks. Best-effort by design — a failed policy write must not fail the finalize —
 * but never silent: failures land in report.errors.
 */
const executeAutoDeny = (
  instanceId: string,
  nowIso: string,
  report: WatchScanReport,
): Effect.Effect<void, never, WatchStore | ExecPolicyStore> =>
  Effect.gen(function* () {
    const ws = yield* WatchStore;
    const keys = yield* ws.listRunKeys();
    const mine = keys.filter((key) => key.startsWith(`run:${instanceId}:`));
    for (const key of mine) {
      const reason = yield* ws.getRunStopReason(key);
      if (reason !== "usage-limited") continue;
      const agentId = key.slice(`run:${instanceId}:`.length).split(":")[0];
      if (!agentId) return;
      const executor = executorFromAgentId(agentId);
      const store = yield* ExecPolicyStore;
      const policy = yield* store.get();
      const next = mergeAutoDeny(Option.getOrUndefined(policy), executor, nowIso);
      if (next === null) return; // operator-denied or already fenced — nothing to write
      yield* store.save(next);
      report.autoDenied.push(executor);
      return;
    }
  }).pipe(
    Effect.catchAll((err) =>
      Effect.sync(() => {
        report.errors.push(`${instanceId}: auto-deny skipped — ${String(err)}`);
      }),
    ),
  );

const executeFinalize = (
  row: WatchRow,
  observedOutcome: WatchOutcome,
  nowMs: number,
  traceparent: string | undefined,
  report: WatchScanReport,
): Effect.Effect<void, WorkflowError, WatchScanEnv> =>
  Effect.gen(function* () {
    const ws = yield* WatchStore;
    const publisher = yield* DaprPublisherTag;
    // The outcome inversion: upgrade completed/failed → usage-limited off the run: ledger before
    // recording, so the row/event/escalate/fallback all see the refined outcome.
    const outcome = yield* refineUsageLimited(row.instanceId, observedOutcome);
    const { costUsd, costGap } = yield* tallyCost(row.instanceId);
    const endedAt = new Date().toISOString();
    const final: WatchRow = {
      ...row,
      status: "finalized",
      outcome,
      lastStatus: runtimeStatusOf(outcome),
      costUsd,
      ...(costGap ? { costGap: true } : {}),
      endedAt,
      updatedAt: endedAt,
    };
    const saved = yield* saveFenced(row.epoch, final);
    // Stale epoch: a re-fire created a new incarnation mid-decision; its lifecycle owns the row.
    if (!saved) return;
    report.finalized.push(`${row.instanceId}:${outcome}`);
    yield* ws.bumpLedger(ledgerDate(nowMs), { runsFinalized: 1, costUsd });
    // Terminal event: best-effort observability, never fails the scan (the babysitter's policy).
    yield* publisher
      .publish(PUBSUB, EVENTS_TOPIC, {
        instanceId: row.instanceId,
        outcome,
        runtimeStatus: final.lastStatus,
        watcher: "workflow-svc",
        startedAt: row.startedAt,
        endedAt,
        attempts: row.attempts,
        costUsd,
        costGap,
      })
      .pipe(Effect.ignore);
    if (outcome === "usage-limited") {
      yield* executeAutoDeny(row.instanceId, endedAt, report);
    }
    if (row.policy.escalate?.onOutcome.includes(outcome)) {
      yield* executeEscalate(row, outcome, costUsd, nowMs, traceparent, report);
    }
    if (row.policy.fallback?.onOutcome.includes(outcome)) {
      yield* executeFallback(row, outcome, nowMs, report);
    }
  });

const executeRetry = (
  row: WatchRow,
  outcome: WatchOutcome,
  nowMs: number,
  traceparent: string | undefined,
  report: WatchScanReport,
): Effect.Effect<void, WorkflowError, WatchScanEnv> =>
  Effect.gen(function* () {
    const ws = yield* WatchStore;
    const invoker = yield* WorkflowInvoker;
    const retry = row.policy.retry;
    if (!retry || !row.resubmit) return;
    const now = new Date(nowMs).toISOString();
    const next: WatchRow = {
      instanceId: row.instanceId,
      epoch: row.epoch + 1,
      attempts: row.attempts + 1,
      startedAt: now,
      policy: row.policy,
      resubmit: row.resubmit,
      status: "scheduling",
      lastStatus: "SCHEDULED",
      unknownStreak: 0,
      note: `retry after ${outcome} (attempt ${row.attempts + 1}/${retry.maxAttempts})`,
      ...(row.meta ? { meta: row.meta } : {}),
      updatedAt: now,
    };
    // Mark-before-fire, fenced on the OLD epoch — a concurrent re-fire wins and this retry drops.
    const saved = yield* saveFenced(row.epoch, next);
    if (!saved) return;
    yield* invoker
      .invoke({
        // Validated at original fire time (see WatchResubmit); only ever round-tripped here.
        steps: (row.resubmit.steps ?? []) as readonly WorkflowStep[],
        ...(row.resubmit.params ? { params: row.resubmit.params } : {}),
        ...(row.resubmit.workspaceId ? { workspaceId: row.resubmit.workspaceId } : {}),
        instanceId: row.instanceId,
        // A terminal instance must purge to re-run (h-builds-h Decision 1).
        fresh: retry.fresh ?? true,
        ...(traceparent ? { traceparent } : {}),
      })
      .pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            report.retried.push(row.instanceId);
            yield* ws.bumpLedger(ledgerDate(nowMs), { runsFired: 1, engineFires: 1 });
          }),
        ),
        // A failed re-fire finalizes with the ORIGINAL outcome — otherwise the next tick
        // observes the same terminal instance and loops the retry forever.
        Effect.catchAll((err) =>
          saveFenced(next.epoch, {
            ...next,
            status: "finalized",
            outcome,
            note: `retry dispatch failed: ${messageOf(err)}`,
            endedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }).pipe(Effect.asVoid),
        ),
      );
  });

const executeEscalate = (
  row: WatchRow,
  outcome: WatchOutcome,
  costUsd: number,
  nowMs: number,
  traceparent: string | undefined,
  report: WatchScanReport,
): Effect.Effect<void, WorkflowError, WatchScanEnv> =>
  Effect.gen(function* () {
    const ws = yield* WatchStore;
    const wfStore = yield* WorkflowStore;
    const invoker = yield* WorkflowInvoker;
    const escalate = row.policy.escalate;
    if (!escalate) return;

    // Fail-closed daily gate (§6): no configured cap → escalations never fire.
    const config = yield* ws.getConfig();
    const cap = Option.isSome(config) ? config.value.maxEngineFiresPerDay : undefined;
    const date = ledgerDate(nowMs);
    if (cap === undefined) {
      report.errors.push(
        `${row.instanceId}: escalation skipped — no maxEngineFiresPerDay configured (fail-closed)`,
      );
      return;
    }
    const ledger = yield* ws.getLedger(date);
    if (ledger.engineFires >= cap) {
      report.errors.push(
        `${row.instanceId}: escalation skipped — daily engine-fire cap ${cap} reached`,
      );
      return;
    }
    const stored = yield* wfStore.get(escalate.key);
    if (Option.isNone(stored) || stored.value.disabled) {
      report.errors.push(
        `${row.instanceId}: escalation skipped — '${escalate.key}' missing or disabled`,
      );
      return;
    }

    // The escalated run is itself watched and budgeted (agreement 7): its watch row lands
    // before the fire, inheriting the parent's budget unless the template stores its own policy.
    const childId = `esc-${row.instanceId}-e${row.epoch}`;
    const facts = {
      watchedInstanceId: row.instanceId,
      outcome,
      attempts: row.attempts,
      costUsd,
    };
    const params: WorkflowParams = { ...escalate.params, ...facts };
    const childPolicy = stored.value.watch ?? { maxDurationMs: row.policy.maxDurationMs };
    yield* registerWatchForFire(childId, childPolicy, {
      meta: { escalatedFrom: row.instanceId },
      resubmit: toResubmit(toRequest(stored.value, traceparent, params)),
    });
    yield* ws.bumpLedger(date, { engineFires: 1 });
    yield* invoker
      .invoke({ ...toRequest(stored.value, traceparent, params), instanceId: childId })
      .pipe(
        Effect.tap(() => Effect.sync(() => report.escalated.push(childId))),
        Effect.catchAll((err) =>
          Effect.gen(function* () {
            const child = yield* ws.getRow(childId);
            if (Option.isSome(child)) {
              yield* ws.saveRow({
                ...child.value,
                status: "finalized",
                outcome: "orphaned",
                note: `escalation dispatch failed: ${messageOf(err)}`,
                endedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
            }
          }),
        ),
      );
  });

/**
 * The usage-limit fallback: on a matching outcome (typically "usage-limited"), arm a cron:sched row
 * that re-fires the SAME steps after `after` ms under a DIFFERENT agent/model, reusing the workspace.
 * The watcher does NOT sleep or invoke — it hands off to the schedule engine (docs/plans/
 * schedule-and-fallback.md). Fail-closed twice: no `maxEngineFiresPerDay` → no fallback (same gate as
 * escalate), and `maxHandoffs <= 0` → the chain stops. The continuation's own watch policy carries a
 * decremented `maxHandoffs`, so a fallback agent that ALSO limits eventually stops.
 */
const executeFallback = (
  row: WatchRow,
  outcome: WatchOutcome,
  nowMs: number,
  report: WatchScanReport,
): Effect.Effect<void, WorkflowError, WatchScanEnv> =>
  Effect.gen(function* () {
    const ws = yield* WatchStore;
    const cs = yield* CronStore;
    const fb = row.policy.fallback;
    if (!fb) return;
    if (!row.resubmit?.steps) {
      report.errors.push(`${row.instanceId}: fallback skipped — no stored steps to continue`);
      return;
    }
    // Fail-closed handoff budget: at 0 the chain stops so two limited agents can't ping-pong.
    if (fb.maxHandoffs <= 0) {
      report.errors.push(`${row.instanceId}: fallback skipped — handoff budget exhausted`);
      return;
    }
    // Fail-closed daily gate (same as escalate): no configured cap → fallbacks never fire.
    const config = yield* ws.getConfig();
    const cap = Option.isSome(config) ? config.value.maxEngineFiresPerDay : undefined;
    const date = ledgerDate(nowMs);
    if (cap === undefined) {
      report.errors.push(
        `${row.instanceId}: fallback skipped — no maxEngineFiresPerDay configured (fail-closed)`,
      );
      return;
    }
    if ((yield* ws.getLedger(date)).engineFires >= cap) {
      report.errors.push(
        `${row.instanceId}: fallback skipped — daily engine-fire cap ${cap} reached`,
      );
      return;
    }

    const schedRowId = `fb-${row.instanceId}-e${row.epoch}`;
    const now = new Date(nowMs).toISOString();
    // The continuation is supervised with a decremented handoff budget, so a fallback agent that
    // also limits can fall back again until the budget runs out — never forever.
    const childFallback = { ...fb, maxHandoffs: fb.maxHandoffs - 1 };
    const childPolicy: WatchPolicy = { ...row.policy, fallback: childFallback };
    const schedRow: SchedRow = {
      id: schedRowId,
      status: "armed",
      fireAt: new Date(nowMs + (fb.after ?? 0)).toISOString(),
      source: {
        mode: "embedded",
        // Identity override (runActivity/agentId/model*) wins over the resubmit's params → the
        // continuation runs on a different agent while re-entering the SAME steps.
        steps: (row.resubmit.steps ?? []) as readonly StepDefinition[],
        params: { ...(row.resubmit.params ?? {}), ...fb.identity } as WorkflowParams,
      },
      instanceId: schedRowId,
      ...(row.resubmit.workspaceId ? { workspaceId: row.resubmit.workspaceId } : {}),
      epoch: 1,
      watch: childPolicy,
      origin: "fallback:usage-limited",
      handoffsRemaining: childFallback.maxHandoffs,
      note: `fallback from ${row.instanceId} after ${outcome}`,
      createdAt: now,
      updatedAt: now,
    };
    yield* cs.saveSchedRow(schedRow);
    yield* ws.bumpLedger(date, { engineFires: 1 });
    report.fallbacks.push(schedRowId);
  });

// ---------------------------------------------------------------------------
// Cost tally (the sweep's prose, now code — issue #10's prefix-match included)
// ---------------------------------------------------------------------------

/**
 * Sums costUsd over the run mirrors whose runId groups under this instance
 * (`run:<instanceId>:<agentId>:<ts>`). Zero matching records is a LEDGER GAP — flagged,
 * never a silent $0 (the prose rule that caught the original undercount, preserved).
 */
export const tallyCost = (
  instanceId: string,
): Effect.Effect<{ costUsd: number; costGap: boolean }, WorkflowError, WatchStore> =>
  Effect.gen(function* () {
    const ws = yield* WatchStore;
    const keys = yield* ws.listRunKeys();
    const mine = keys.filter((key) => key.startsWith(`run:${instanceId}:`));
    if (mine.length === 0) return { costUsd: 0, costGap: true };
    let cost = 0;
    for (const key of mine) {
      const usd = yield* ws.getRunCost(key);
      if (typeof usd === "number") cost += usd;
    }
    return { costUsd: Math.round(cost * 10_000) / 10_000, costGap: false };
  });

/**
 * Refines a terminal outcome to "usage-limited" when a run mirror under this instance reports
 * stopReason "usage-limited" (agent-cli classify-stop). THE OUTCOME INVERSION (docs/plans/
 * schedule-and-fallback.md): a usage-limited run can be COMPLETED at the Dapr level (Claude exits 0),
 * so this reads the run:<id> LEDGER, deliberately out of band of decide() — do NOT fold it back into
 * decide(), whose axis is run status. Only completed/failed are refined; budget-terminated/
 * terminated/orphaned are never usage limits.
 */
export const refineUsageLimited = (
  instanceId: string,
  outcome: WatchOutcome,
): Effect.Effect<WatchOutcome, WorkflowError, WatchStore> =>
  Effect.gen(function* () {
    if (outcome !== "completed" && outcome !== "failed") return outcome;
    const ws = yield* WatchStore;
    const keys = yield* ws.listRunKeys();
    const mine = keys.filter((key) => key.startsWith(`run:${instanceId}:`));
    for (const key of mine) {
      const reason = yield* ws.getRunStopReason(key);
      if (reason === "usage-limited") return "usage-limited";
    }
    return outcome;
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Projects a run request into the row's stored resubmit (identity/trace fields dropped). */
export function toResubmit(req: {
  steps: readonly WorkflowStep[];
  params?: WorkflowParams;
  workspaceId?: string;
}): WatchResubmit {
  return {
    steps: req.steps as readonly unknown[],
    ...(req.params ? { params: req.params } : {}),
    ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}),
  };
}

function stamp(row: WatchRow, nowMs: number): WatchRow {
  return { ...row, updatedAt: new Date(nowMs).toISOString() };
}

function runtimeStatusOf(outcome: WatchOutcome): string {
  switch (outcome) {
    case "completed":
      return "COMPLETED";
    case "failed":
      return "FAILED";
    case "terminated":
    case "budget-terminated":
      return "TERMINATED";
    case "orphaned":
      return "UNKNOWN";
    // A usage-limited run typically completed at the Dapr level (Claude exits 0); the distinction
    // lives in the outcome, not the run status.
    case "usage-limited":
      return "COMPLETED";
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return String(err);
}
