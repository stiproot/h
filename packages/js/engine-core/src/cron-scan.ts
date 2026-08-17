import { WorkflowError } from "core";
import { Effect, Option, Schema } from "effect";

import { decideCron as decide, nextUnknownStreak } from "./internal.ts";
import {
  type CronBudget,
  type CronOutcome,
  type CronRow,
  type CronSource,
  cronId,
  cronLedgerDate,
} from "./internal.ts";
import type { WfIdentity } from "./internal.ts";
import { type WorkflowRequest, toRequest } from "./internal.ts";
import { CronStore } from "./internal.ts";
import { WfStore } from "./internal.ts";
import { WorkflowInvoker } from "./internal.ts";
import { WorkflowStore } from "./internal.ts";

export type DisarmCronError = { readonly _tag: "NotFound" } | WorkflowError;

/**
 * The effectful half of the cron engine, sibling of
 * chain-scan.ts / watch-scan.ts: registration on the fire path, and the per-tick scan that reads each
 * active cron row, asks the pure engine (cron-engine.ts) what to do, and executes the closed vocabulary
 * — wait, FIRE (re-invoke the workflow, fresh, under its fixed instance), deactivate (goal resolved or
 * budget exhausted). Where a watch RE-fires one instance on a failure policy and a chain FIRES THE NEXT
 * workflow on advance, a cron RE-FIRES the SAME workflow on a clock until the goal resolves.
 *
 * Every row-mutating action is epoch-fenced: it re-reads the row and no-ops when the epoch moved (a
 * re-registration created a new incarnation and this decision is stale). Single-writer: workflow-svc.
 */

const DEFAULT_MAX_FIRES = 100;

export type CronScanEnv = CronStore | WorkflowInvoker | WorkflowStore | WfStore;

export type CronScanReport = {
  scanned: number;
  fired: string[];
  deactivated: string[];
  errors: string[];
  disabled?: boolean;
};

// ---------------------------------------------------------------------------
// Registration (writes the cron:sub row; does NOT itself invoke)
// ---------------------------------------------------------------------------

export type CronRegistration = {
  readonly identity: WfIdentity;
  readonly cadence: string;
  readonly source: CronSource;
  readonly budget?: CronBudget;
  /** The fixed Dapr instance every fire recurs under (fresh re-run each tick). */
  readonly instanceId: string;
  /**
   * Present when `--cron` rides a run that ALREADY fired: count that run against the budget and guard
   * the first ticks on it (don't overlap). Absent for `h cron add` — the first due tick fires.
   */
  readonly initial?: { readonly firedAt: string };
};

/**
 * Registers a cron row — IDEMPOTENT ensure-exists. Does
 * NOT invoke — a cron only recurs on the tick; the initial run, when `--cron` rides one, has already
 * fired (its instanceId + firedAt come in as `initial`).
 *
 * Ensure-exists: when an ACTIVE row already covers this identity, it is a NO-OP — the existing row's
 * `fires`/epoch are left intact. This is the re-run-safety the `arm-*` pattern needs: runs get re-fired
 * (watch retries, `--cron` self-recur, a `feature-pr` re-run), and each re-run re-executes the arm-cron
 * step; if that reset `fires` the budget backstop would never trip. A row that is ABSENT (first arm) or
 * DEACTIVATED (resolved / budget-exhausted — a deliberate re-arm) is (re)created, epoch continuing from
 * the prior. The scan owns epoch bumps on fire; registration no longer bumps a live row's epoch.
 */
export const registerCronForFire = (
  reg: CronRegistration,
): Effect.Effect<{ cronId: string; active: boolean }, WorkflowError, CronScanEnv> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const id = cronId(reg.identity);
    const existing = yield* cs.getRow(id);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const prior = Option.getOrUndefined(existing);
    // Idempotent: an active row already recurs this identity — leave it untouched (re-run safety).
    if (prior && prior.status === "active") return { cronId: id, active: true };
    const row: CronRow = {
      repo: reg.identity.repo,
      slug: reg.identity.slug,
      workflow: reg.identity.workflow,
      status: "active",
      cadence: reg.cadence,
      source: reg.source,
      budget: reg.budget ?? { maxFires: DEFAULT_MAX_FIRES },
      instanceId: reg.instanceId,
      epoch: (prior?.epoch ?? 0) + 1,
      fires: reg.initial ? 1 : 0,
      ...(reg.initial ? { currentInstanceId: reg.instanceId, lastRunAt: reg.initial.firedAt } : {}),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    yield* cs.saveRow(row);
    yield* cs.bumpLedger(cronLedgerDate(nowMs), { cronsRegistered: 1 });
    return { cronId: id, active: true };
  });

// ---------------------------------------------------------------------------
// Operator disarm (POST /cron/disarm)
// ---------------------------------------------------------------------------

/**
 * Deactivates a recur cron row by operator request. Epoch-fenced (bumps epoch on write) so any
 * in-flight scan decision with the old epoch no-ops. Idempotent: an already-inactive row is
 * returned as-is with no ledger bump. Missing id → `{ _tag: "NotFound" }`.
 */
export const disarmCron = (id: string): Effect.Effect<CronRow, DisarmCronError, CronStore> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const existing = yield* cs.getRow(id);
    if (Option.isNone(existing)) return yield* Effect.fail<DisarmCronError>({ _tag: "NotFound" });
    const row = existing.value;
    if (row.status === "inactive") return row;
    const disarmed: CronRow = {
      ...row,
      epoch: row.epoch + 1,
      status: "inactive",
      outcome: "disabled",
      note: "disarmed by operator",
      endedAt: now,
      updatedAt: now,
    };
    const saved = yield* saveFenced(row.epoch, disarmed);
    if (!saved) {
      return yield* Effect.fail<DisarmCronError>(
        new WorkflowError({ cause: "concurrent modification, retry", instanceId: id }),
      );
    }
    yield* cs.bumpLedger(cronLedgerDate(nowMs), { cronsDeactivated: 1 });
    return disarmed;
  });

// ---------------------------------------------------------------------------
// Pub/sub disarm (the cron-disarm topic — a finalizing chain's teardown, D6)
// ---------------------------------------------------------------------------

/** The disarm-event payload a finalizing chain publishes (D6): the recur cron's identity tuple. */
const DisarmEvent = Schema.Struct({
  repo: Schema.String,
  slug: Schema.String,
  workflow: Schema.String,
});

/**
 * One cron-disarm delivery — the pub/sub sibling of POST /cron/disarm. A chain publishes these on
 * atomic failure (D6) so it never writes cron:sub itself (D2); THIS handler stays the single writer,
 * reusing `disarmCron`. Payload problems and a missing cron ack as `{ skipped }` (redelivery cannot
 * fix a bad payload, and disarming an already-gone cron is a no-op); infra failures stay in the error
 * channel → 500 → Dapr redelivers. Mirrors trigger.router's `triggerEffect` envelope handling.
 */
export const disarmEventEffect = (
  rawBody: unknown,
): Effect.Effect<{ disarmed: string } | { skipped: string }, WorkflowError, CronStore> =>
  Effect.gen(function* () {
    const envelope = rawBody as Record<string, unknown> | null;
    let data: unknown =
      envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : envelope;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return { skipped: "event data is not JSON" };
      }
    }
    const decoded = yield* Schema.decodeUnknown(DisarmEvent)(data).pipe(Effect.option);
    if (Option.isNone(decoded)) return { skipped: "event lacks a cron identity" };
    const id = cronId(decoded.value);
    return yield* disarmCron(id).pipe(
      Effect.as({ disarmed: id }),
      Effect.catchAll((e) =>
        "_tag" in e && e._tag === "NotFound"
          ? Effect.succeed({ skipped: `no cron '${id}'` })
          : Effect.fail(e as WorkflowError),
      ),
    );
  });

// ---------------------------------------------------------------------------
// The scan (one per cron tick)
// ---------------------------------------------------------------------------

export const scanCronsEffect = (
  traceparent: string | undefined,
): Effect.Effect<CronScanReport, WorkflowError, CronScanEnv> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const nowMs = Date.now();
    const config = yield* cs.getConfig();
    const enabled = Option.isNone(config) || config.value.enabled !== false;
    yield* cs.heartbeat({ at: new Date(nowMs).toISOString(), enabled }).pipe(Effect.ignore);

    const report: CronScanReport = { scanned: 0, fired: [], deactivated: [], errors: [] };
    if (!enabled) return { ...report, disabled: true };

    const rows = yield* cs.listRows();
    const active = rows.filter((row) => row.status === "active");
    report.scanned = active.length;
    for (const row of active) {
      // One cron's failure never starves the rest.
      yield* processRow(row, nowMs, traceparent, report).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            report.errors.push(`${cronId(row)}: ${messageOf(err)}`);
          }),
        ),
      );
    }
    return report;
  });

const processRow = (
  row: CronRow,
  nowMs: number,
  traceparent: string | undefined,
  report: CronScanReport,
): Effect.Effect<void, WorkflowError, CronScanEnv> =>
  Effect.gen(function* () {
    const invoker = yield* WorkflowInvoker;
    const wfStore = yield* WfStore;
    // Goal handshake: read the LAST FIRED RUN's row and take its `resolved` flag. Since the
    // 2026-08-17 re-key the row is per-run (`wf:run:<instanceId>`), so this asks about the run this
    // cron actually fired rather than about an artifact row several runs shared and overwrote.
    const targetRow = row.currentInstanceId
      ? yield* wfStore
          .getRun(row.currentInstanceId)
          .pipe(Effect.catchAll(() => Effect.succeed(Option.none())))
      : Option.none();
    const resolved = Option.isSome(targetRow) && targetRow.value.resolved === true;
    // In-flight guard: the last fired instance's live status (UNKNOWN on transport failure — the engine
    // treats that as still-live, never double-firing).
    const runtimeStatus = row.currentInstanceId
      ? yield* invoker.getStatus(row.currentInstanceId).pipe(
          Effect.map((s) => s.runtimeStatus),
          Effect.catchAll(() => Effect.succeed("UNKNOWN")),
        )
      : undefined;

    const decision = decide(row, resolved, runtimeStatus, nowMs);
    // Persist the streak the decision was made against, so consecutive UNKNOWN ticks accumulate
    // toward the escape instead of each tick starting from zero. Best-effort and epoch-fenced: this
    // is bookkeeping, so a lost write only delays the escape by a tick, and it must never fail the
    // scan. A `fire` skips it — executeFire rewrites the row (bumping the epoch) and stamps a fresh
    // instance, which resets the streak anyway.
    const streak = nextUnknownStreak(row, runtimeStatus);
    if (decision.kind !== "fire" && streak !== (row.unknownStreak ?? 0)) {
      yield* saveFenced(row.epoch, { ...row, unknownStreak: streak }).pipe(
        Effect.catchAll(() => Effect.succeed(false)),
      );
    }
    switch (decision.kind) {
      case "wait":
        return;
      case "deactivate":
        return yield* deactivate(row, decision.outcome, nowMs, report);
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
  next: CronRow,
): Effect.Effect<boolean, WorkflowError, CronStore> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const current = yield* cs.getRow(cronId(next));
    if (Option.isNone(current) || current.value.epoch !== expectEpoch) return false;
    yield* cs.saveRow(next);
    return true;
  });

/**
 * Fire the workflow: mark-before-fire (bump fires + epoch, stamp the instance, fenced on the OLD epoch)
 * so even a failed invoke counts against the budget — a permanently-broken source can't retry forever.
 * Then build the request from the source and invoke fresh under the fixed instance, stamping the
 * wf-identity so the fired workflow writes its own `wf:` row.
 */
const executeFire = (
  row: CronRow,
  nowMs: number,
  traceparent: string | undefined,
  report: CronScanReport,
): Effect.Effect<void, WorkflowError, CronScanEnv> =>
  Effect.gen(function* () {
    const now = new Date(nowMs).toISOString();
    const next: CronRow = {
      ...row,
      epoch: row.epoch + 1,
      fires: row.fires + 1,
      currentInstanceId: row.instanceId,
      lastRunAt: now,
      lastStatus: "SCHEDULED",
      // A fresh fire is a fresh instance to observe — carrying the previous one's UNKNOWN streak
      // over would let one vanished instance shorten the escape for every fire after it.
      unknownStreak: 0,
      note: `fire ${row.fires + 1}/${row.budget.maxFires}`,
      updatedAt: now,
    };
    const saved = yield* saveFenced(row.epoch, next);
    if (!saved) return;
    yield* fireCron(next, traceparent).pipe(
      Effect.tap(() => Effect.sync(() => report.fired.push(cronId(row)))),
      // A fire failure (missing source, transport) is recorded, not fatal — the budget still advanced,
      // so a broken cron self-limits instead of looping forever.
      Effect.catchAll((err) =>
        Effect.sync(() => report.errors.push(`${cronId(row)}: fire failed: ${messageOf(err)}`)),
      ),
    );
    yield* (yield* CronStore).bumpLedger(cronLedgerDate(nowMs), { firesTriggered: 1 });
  });

/** Build the fire request from the cron's source, stamp identity + fixed instance, invoke fresh. */
const fireCron = (
  row: CronRow,
  traceparent: string | undefined,
): Effect.Effect<void, WorkflowError, CronScanEnv> =>
  Effect.gen(function* () {
    const invoker = yield* WorkflowInvoker;
    let req: WorkflowRequest;
    if (row.source.mode === "saved") {
      const wfStore = yield* WorkflowStore;
      const stored = yield* wfStore.get(row.source.key);
      if (Option.isNone(stored) || stored.value.disabled) {
        return yield* Effect.fail(
          new WorkflowError({
            cause: `cron source key '${row.source.key}' missing or disabled`,
            instanceId: cronId(row),
          }),
        );
      }
      req = toRequest(stored.value, traceparent, row.source.params);
    } else {
      req = {
        steps: [...row.source.steps],
        ...(row.source.params ? { params: row.source.params } : {}),
        ...(row.source.workspaceId ? { workspaceId: row.source.workspaceId } : {}),
        traceparent,
      };
    }
    const wf: WfIdentity = { repo: row.repo, slug: row.slug, workflow: row.workflow };
    yield* invoker.invoke({ ...req, instanceId: row.instanceId, fresh: true, wf });
  });

const deactivate = (
  row: CronRow,
  outcome: CronOutcome,
  nowMs: number,
  report: CronScanReport,
): Effect.Effect<void, WorkflowError, CronStore> =>
  Effect.gen(function* () {
    const cs = yield* CronStore;
    const now = new Date(nowMs).toISOString();
    const final: CronRow = {
      ...row,
      status: "inactive",
      outcome,
      note: `deactivated: ${outcome}`,
      endedAt: now,
      updatedAt: now,
    };
    const saved = yield* saveFenced(row.epoch, final);
    if (!saved) return;
    report.deactivated.push(`${cronId(row)}:${outcome}`);
    yield* cs.bumpLedger(cronLedgerDate(nowMs), { cronsDeactivated: 1 });
  });

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string") return cause;
  return String(err);
}
