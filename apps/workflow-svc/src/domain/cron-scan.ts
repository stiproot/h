import { WorkflowError } from "core";
import { Effect, Option } from "effect";

import { decide } from "./cron-engine.ts";
import {
  type CronBudget,
  type CronOutcome,
  type CronRow,
  type CronSource,
  cronId,
  cronLedgerDate,
} from "./models/cron.model.ts";
import type { WfIdentity } from "./models/wf.model.ts";
import { type WorkflowRequest, toRequest } from "./models/workflow.model.ts";
import { CronStore } from "./ports/ICronStore.ts";
import { WfStore } from "./ports/IWfStore.ts";
import { WorkflowInvoker } from "./ports/IWorkflowInvoker.ts";
import { WorkflowStore } from "./ports/IWorkflowStore.ts";

export type DisarmCronError = { readonly _tag: "NotFound" } | WorkflowError;

/**
 * The effectful half of the cron engine (docs/plans/workflow-watcher-registry.md §5), sibling of
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
 * Registers a cron row — IDEMPOTENT ensure-exists (docs/plans/workflow-watcher-registry.md §10). Does
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
export const disarmCron = (
  id: string,
): Effect.Effect<CronRow, DisarmCronError, CronStore> =>
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
    // Goal handshake: read the target wf: row's `resolved` flag.
    const targetRow = yield* wfStore
      .getRow({ repo: row.repo, slug: row.slug, workflow: row.workflow })
      .pipe(Effect.catchAll(() => Effect.succeed(Option.none())));
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
