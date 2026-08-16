import { WorkflowError } from "core";
import { Effect, Option } from "effect";

import { decideSchedule as decide } from "engine-core";
import { cronLedgerDate } from "engine-core";
import { type SchedOutcome, type SchedRow, schedId } from "engine-core";
import type { WfIdentity } from "engine-core";
import { type Trigger, type WorkflowRequest, toRequest } from "engine-core";
import { CronStore } from "engine-core";
import { WatchStore } from "engine-core";
import { WorkflowInvoker } from "engine-core";
import { WorkflowStore } from "engine-core";
import { invokeWithWatch } from "./watch-scan.ts";

export type DisarmSchedError = { readonly _tag: "NotFound" } | WorkflowError;

/**
 * The effectful half of the SCHEDULED-FIRE cron, the one-shot
 * sibling of cron-scan.ts / discover-scan.ts: the arm path (the run route's `--at`/`--in`, and the
 * watcher's fallback action), and the per-tick scan that reads each armed row, asks the pure engine
 * (schedule-engine.ts) whether to fire/expire/wait, and executes the closed vocabulary — FIRE (invoke
 * the source once, fresh, supervised via invokeWithWatch), expire (missed deadline), wait. Where a
 * recur cron RE-FIRES one workflow until its goal resolves and a discovery cron FANS OUT per source
 * item, a scheduled-fire row fires ONE workflow ONCE at an absolute time, then it is done.
 *
 * Every row-mutating action is epoch-fenced. Single-writer: workflow-svc.
 */

// WatchStore is required because the fire goes through invokeWithWatch — every scheduled fire lands a
// watch:sub row so the continuation is supervised.
export type SchedScanEnv = CronStore | WorkflowInvoker | WorkflowStore | WatchStore;

export type SchedScanReport = {
  scanned: number;
  fired: string[];
  expired: string[];
  errors: string[];
  disabled?: boolean;
};

// ---------------------------------------------------------------------------
// Arm (writes the cron:sched row; does NOT itself fire — the tick fires it at fireAt)
// ---------------------------------------------------------------------------

export type SchedRegistration = {
  /** Store id + default fire instance (a readable id; also the default workspace key). */
  readonly id: string;
  /** Absolute ISO fire time. */
  readonly fireAt: string;
  /** The fire descriptor the row embeds — what fires at fireAt (key|steps, params carrying any
   *  identity override + payload, the workspace to REUSE, the watch policy for the continuation).
   *  Its instanceId defaults to the row id when the caller pins none. */
  readonly trigger: Trigger;
  /** Optional absolute deadline — expire without firing if now passes it before fireAt. */
  readonly notAfter?: string;
  /** The wf-identity the fired run writes its own wf: row under. */
  readonly wf?: WfIdentity;
  /** Provenance: "at" | "pause" | "fallback:usage-limited". */
  readonly origin?: string;
  /** Feature 1 fallback budget carried across a fallback chain. */
  readonly handoffsRemaining?: number;
};

/**
 * Arms a scheduled-fire row — IDEMPOTENT ensure-exists (the arm-* pattern). An `armed` row already
 * covering this id is a NO-OP (re-run safety: a re-armed run must not reset a pending schedule). An
 * ABSENT or terminal (fired/expired/disarmed) row is (re)created, epoch continuing from the prior.
 * Does NOT fire — the scan fires at fireAt.
 */
export const registerSchedForFire = (
  reg: SchedRegistration,
): Effect.Effect<{ schedId: string; armed: boolean }, WorkflowError, CronStore> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const id = schedId(reg.id);
    const existing = yield* cs.getSchedRow(id);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const prior = Option.getOrUndefined(existing);
    // Idempotent: an already-armed row for this id is left untouched.
    if (prior && prior.status === "armed") return { schedId: id, armed: true };
    const row: SchedRow = {
      id,
      status: "armed",
      fireAt: reg.fireAt,
      ...(reg.notAfter ? { notAfter: reg.notAfter } : {}),
      // The embedded descriptor persists with a CONCRETE instance (required-or-derived resolves at
      // arm time for a sched row): the caller's pinned id wins, else the row id.
      trigger: { ...reg.trigger, instanceId: reg.trigger.instanceId ?? id },
      epoch: (prior?.epoch ?? 0) + 1,
      ...(reg.wf ? { wf: reg.wf } : {}),
      ...(reg.origin ? { origin: reg.origin } : {}),
      ...(reg.handoffsRemaining !== undefined ? { handoffsRemaining: reg.handoffsRemaining } : {}),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    yield* cs.saveSchedRow(row);
    return { schedId: id, armed: true };
  });

// ---------------------------------------------------------------------------
// Operator/engine disarm
// ---------------------------------------------------------------------------

/**
 * Deactivates a scheduled-fire row. Epoch-fenced (bumps epoch on write) so an in-flight scan decision
 * with the old epoch no-ops. Idempotent: an already-terminal row is returned as-is. Missing id →
 * `{ _tag: "NotFound" }`.
 */
export const disarmSched = (id: string): Effect.Effect<SchedRow, DisarmSchedError, CronStore> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const now = new Date().toISOString();
    const existing = yield* cs.getSchedRow(id);
    if (Option.isNone(existing)) return yield* Effect.fail<DisarmSchedError>({ _tag: "NotFound" });
    const row = existing.value;
    if (row.status !== "armed") return row;
    const disarmed: SchedRow = {
      ...row,
      epoch: row.epoch + 1,
      status: "disarmed",
      outcome: "disarmed",
      note: "disarmed by operator",
      updatedAt: now,
    };
    const saved = yield* saveFenced(row.epoch, disarmed);
    if (!saved) {
      return yield* Effect.fail<DisarmSchedError>(
        new WorkflowError({ cause: "concurrent modification, retry", instanceId: id }),
      );
    }
    return disarmed;
  });

/**
 * Advances an armed scheduled fire to fire NOW (the `resume` operation): sets fireAt to the current
 * instant so the next tick fires it. Epoch-fenced. Idempotent-ish: an already-terminal row is
 * returned as-is (a fired schedule can't be resumed). Missing id → `{ _tag: "NotFound" }`.
 */
export const advanceSched = (id: string): Effect.Effect<SchedRow, DisarmSchedError, CronStore> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const now = new Date().toISOString();
    const existing = yield* cs.getSchedRow(id);
    if (Option.isNone(existing)) return yield* Effect.fail<DisarmSchedError>({ _tag: "NotFound" });
    const row = existing.value;
    if (row.status !== "armed") return row;
    const advanced: SchedRow = {
      ...row,
      epoch: row.epoch + 1,
      fireAt: now,
      note: "resumed (fire now)",
      updatedAt: now,
    };
    const saved = yield* saveFenced(row.epoch, advanced);
    if (!saved) {
      return yield* Effect.fail<DisarmSchedError>(
        new WorkflowError({ cause: "concurrent modification, retry", instanceId: id }),
      );
    }
    return advanced;
  });

// ---------------------------------------------------------------------------
// The scan (one per cron tick, beside the recur/discover/chain/watch scans)
// ---------------------------------------------------------------------------

export const scanSchedEffect = (
  traceparent: string | undefined,
): Effect.Effect<SchedScanReport, WorkflowError, SchedScanEnv> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const nowMs = Date.now();
    // Kill switch is shared across the cron siblings (cron:config); the heartbeat is beaten by the recur
    // scan (scanCronsEffect), which always runs on the same tick — no double-beat here.
    const config = yield* cs.getConfig();
    const enabled = Option.isNone(config) || config.value.enabled !== false;

    const report: SchedScanReport = { scanned: 0, fired: [], expired: [], errors: [] };
    if (!enabled) return { ...report, disabled: true };

    const rows = (yield* cs.listSchedRows()).filter((row) => row.status === "armed");
    report.scanned = rows.length;
    for (const row of rows) {
      // One scheduled fire's failure never starves the rest.
      yield* processRow(row, nowMs, traceparent, report).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            report.errors.push(`${row.id}: ${messageOf(err)}`);
          }),
        ),
      );
    }
    return report;
  });

const processRow = (
  row: SchedRow,
  nowMs: number,
  traceparent: string | undefined,
  report: SchedScanReport,
): Effect.Effect<void, WorkflowError, SchedScanEnv> =>
  Effect.gen(function* () {
    const decision = decide(row, nowMs);
    switch (decision.kind) {
      case "wait":
        return;
      case "expire":
        return yield* deactivate(row, "expired", nowMs, report);
      case "fire":
        return yield* executeFire(row, nowMs, traceparent, report);
    }
  });

// ---------------------------------------------------------------------------
// Actions (each epoch-fenced)
// ---------------------------------------------------------------------------

/** Writes `next` only if the stored row still carries `expectEpoch`; false when stale. */
const saveFenced = (
  expectEpoch: number,
  next: SchedRow,
): Effect.Effect<boolean, WorkflowError, CronStore> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const current = yield* cs.getSchedRow(next.id);
    if (Option.isNone(current) || current.value.epoch !== expectEpoch) return false;
    yield* cs.saveSchedRow(next);
    return true;
  });

/**
 * Fire the source ONCE: mark-before-fire (bump epoch, set status "fired", stamp firedInstanceId,
 * fenced on the OLD epoch) so a crashed fire still burns the one-shot and it can't loop. Then build
 * the request from the source and invoke fresh via invokeWithWatch (so the continuation is
 * supervised). A fire failure is recorded, not fatal — the row is already `fired`, so a broken
 * schedule self-limits instead of retrying forever.
 */
const executeFire = (
  row: SchedRow,
  nowMs: number,
  traceparent: string | undefined,
  report: SchedScanReport,
): Effect.Effect<void, WorkflowError, SchedScanEnv> =>
  Effect.gen(function* () {
    const now = new Date(nowMs).toISOString();
    const fired: SchedRow = {
      ...row,
      epoch: row.epoch + 1,
      status: "fired",
      outcome: "fired",
      firedInstanceId: row.trigger.instanceId,
      firedAt: now,
      note: `fired${row.origin ? ` (${row.origin})` : ""}`,
      updatedAt: now,
    };
    const saved = yield* saveFenced(row.epoch, fired);
    if (!saved) return;
    yield* fireSched(fired, traceparent).pipe(
      Effect.tap(() => Effect.sync(() => report.fired.push(row.id))),
      Effect.catchAll((err) =>
        Effect.sync(() => report.errors.push(`${row.id}: fire failed: ${messageOf(err)}`)),
      ),
    );
    yield* (yield* CronStore).bumpLedger(cronLedgerDate(nowMs), { scheduledFires: 1 });
  });

/** Resolve the row's embedded descriptor's key|steps and fire it through the choke point —
 *  fresh, supervised when the descriptor carries a watch. */
const fireSched = (
  row: SchedRow,
  traceparent: string | undefined,
): Effect.Effect<void, WorkflowError, SchedScanEnv> =>
  Effect.gen(function* () {
    const { trigger } = row;
    let req: WorkflowRequest;
    let workspaceId = trigger.workspaceId;
    if (trigger.key !== undefined) {
      const wfStore = yield* WorkflowStore;
      const stored = yield* wfStore.get(trigger.key);
      if (Option.isNone(stored) || stored.value.disabled) {
        return yield* Effect.fail(
          new WorkflowError({
            cause: `scheduled source key '${trigger.key}' missing or disabled`,
            instanceId: row.id,
          }),
        );
      }
      req = toRequest(stored.value, traceparent, trigger.params);
      // The descriptor's workspaceId (row-level override, else source-embedded) wins over the
      // saved definition's own.
      workspaceId = trigger.workspaceId ?? stored.value.workspaceId;
    } else {
      req = {
        steps: [...(trigger.steps ?? [])],
        ...(trigger.params ? { params: trigger.params } : {}),
        traceparent,
      };
    }
    yield* invokeWithWatch({
      ...req,
      instanceId: trigger.instanceId,
      ...(workspaceId ? { workspaceId } : {}),
      fresh: true,
      ...(row.wf ? { wf: row.wf } : {}),
      ...(trigger.watch
        ? {
            watch: trigger.watch,
            watchMeta: { owner: "schedule", origin: row.origin ?? "at", schedId: row.id },
          }
        : {}),
    });
  });

const deactivate = (
  row: SchedRow,
  outcome: SchedOutcome,
  nowMs: number,
  report: SchedScanReport,
): Effect.Effect<void, WorkflowError, CronStore> =>
  Effect.gen(function* () {
    const now = new Date(nowMs).toISOString();
    const final: SchedRow = {
      ...row,
      epoch: row.epoch + 1,
      status: outcome === "expired" ? "expired" : "disarmed",
      outcome,
      note: `deactivated: ${outcome}`,
      updatedAt: now,
    };
    const saved = yield* saveFenced(row.epoch, final);
    if (!saved) return;
    report.expired.push(`${row.id}:${outcome}`);
  });

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string") return cause;
  return String(err);
}
