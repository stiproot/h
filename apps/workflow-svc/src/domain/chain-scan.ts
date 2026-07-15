import { WorkflowError } from "core";
import { DaprPublisherTag } from "core-dapr";
import { Effect, Option } from "effect";

import { decide } from "./chain-engine.ts";
import { type Blackboard, ChainThreadError, contractFor, loopIsClean } from "./chain-workflows.ts";
import {
  type ChainWorkflow,
  type ChainOutcome,
  type ChainRow,
  type ChainStrategy,
  chainLedgerDate,
} from "./models/chain.model.ts";
import { wfIdentityFrom } from "./models/wf.model.ts";
import { toRequest } from "./models/workflow.model.ts";
import { ChainStore } from "./ports/IChainStore.ts";
import { WorkflowInvoker } from "./ports/IWorkflowInvoker.ts";
import { WorkflowStore } from "./ports/IWorkflowStore.ts";

/**
 * The effectful half of the chain engine, sibling of watch-scan.ts: registration on the fire path,
 * and the per-tick scan that reads each active chain row, asks the pure engine (chain-engine.ts)
 * what to do, and executes the closed vocabulary — wait, ADVANCE (capture the completed workflow's
 * output into the blackboard, then fire the next workflow), finalize (record + publish + cost tally),
 * budget-terminate. Where the watch engine RE-fires one instance, the chain FIRES THE NEXT workflow.
 *
 * Every row-mutating action is epoch-fenced: it re-reads the row and no-ops when the epoch moved
 * (a re-registration created a new incarnation and this decision is stale).
 */

const PUBSUB = "pubsub";
const EVENTS_TOPIC = "workflow-events";
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "TERMINATED"]);

export type ChainScanEnv = ChainStore | WorkflowInvoker | WorkflowStore | DaprPublisherTag;

export type ChainScanReport = {
  scanned: number;
  advanced: string[];
  finalized: string[];
  terminated: string[];
  errors: string[];
  disabled?: boolean;
};

/** The instanceId a workflow runs under: explicit on the workflow, else derived from the chain + cursor. */
export function instanceIdAt(
  chainId: string,
  workflows: readonly ChainWorkflow[],
  cursor: number,
): string {
  return workflows[cursor]?.instanceId ?? `${chainId}-w${cursor}`;
}

// ---------------------------------------------------------------------------
// Registration (the fire choke point — marks the row, then fires workflow 0)
// ---------------------------------------------------------------------------

export type ChainRegistration = {
  readonly slug: string;
  readonly workflows: readonly ChainWorkflow[];
  /** Initial blackboard — the inputs the first workflow reads (slug, spec, issueNumber?). */
  readonly data: Blackboard;
  readonly strategy?: ChainStrategy;
  /** For strategy "loop-until-clean": where the loop body starts (the review workflow) + the cap. */
  readonly loop?: { readonly startCursor: number; readonly maxIterations: number };
  readonly budgetMs?: number;
  readonly meta?: Blackboard;
};

/**
 * Registers a chain (chainId = slug) and fires workflow 0. Mark-before-fire: the `scheduling` row lands
 * before the invoke, so a crash between the two leaves a row the scan heals (UNKNOWN → orphaned)
 * instead of a silently unsequenced chain. Re-registering a slug bumps the epoch (fences any
 * in-flight scan decision). A dispatch failure finalizes the chain failed, never a dangling row.
 */
export const registerChainForFire = (
  reg: ChainRegistration,
  traceparent: string | undefined,
): Effect.Effect<{ chainId: string; firing: boolean }, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    const cs = yield* ChainStore;
    const existing = yield* cs.getRow(reg.slug);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const data: Blackboard = { ...reg.data };
    const instanceId = instanceIdAt(reg.slug, reg.workflows, 0);
    const row: ChainRow = {
      chainId: reg.slug,
      epoch: (Option.getOrUndefined(existing)?.epoch ?? 0) + 1,
      slug: reg.slug,
      workflows: reg.workflows,
      strategy: reg.strategy ?? "sequential",
      ...(reg.loop ? { loop: { ...reg.loop, iterations: 0 } } : {}),
      ...(reg.budgetMs !== undefined ? { budgetMs: reg.budgetMs } : {}),
      cursor: 0,
      currentInstanceId: instanceId,
      data,
      status: "scheduling",
      lastStatus: "SCHEDULED",
      unknownStreak: 0,
      ...(reg.meta ? { meta: reg.meta } : {}),
      startedAt: now,
      updatedAt: now,
    };
    yield* cs.saveRow(row);
    yield* cs.bumpLedger(chainLedgerDate(nowMs), { chainsRegistered: 1 });
    yield* fireWorkflow(row, 0, traceparent).pipe(
      Effect.catchAll((err) =>
        finalizeFailed(row, `workflow 0 dispatch failed: ${messageOf(err)}`),
      ),
    );
    return { chainId: reg.slug, firing: true };
  });

/**
 * Fires the workflow at `cursor`: build its params from the blackboard (the engine-coded contract),
 * resolve its saved workflow, invoke under the workflow's instanceId, and bump the ledger. Fails with a
 * WorkflowError the caller turns into a failed-chain finalize. Assumes the row already reflects this
 * cursor (registration and advance both mark-before-fire).
 */
const fireWorkflow = (
  row: ChainRow,
  cursor: number,
  traceparent: string | undefined,
  forceFresh = false,
): Effect.Effect<void, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    const invoker = yield* WorkflowInvoker;
    const wfStore = yield* WorkflowStore;
    const workflow = row.workflows[cursor];
    if (!workflow) return;
    // A missing blackboard input (ChainThreadError) or any other build failure surfaces as a
    // WorkflowError the caller turns into a failed-chain finalize. The workflow's own params (fire-time
    // identity from the CLI) merge OVER the threading params — disjoint by convention, workflow wins.
    const params = yield* Effect.try({
      try: () => ({
        ...contractFor(workflow).buildParams(row.data),
        ...(workflow.params ?? {}),
      }),
      catch: (cause) => new WorkflowError({ cause, instanceId: row.chainId }),
    });
    const stored = yield* wfStore.get(workflow.key);
    if (Option.isNone(stored) || stored.value.disabled) {
      return yield* Effect.fail(
        new WorkflowError({
          cause: `chain workflow '${workflow.kind}' key '${workflow.key}' missing or disabled`,
          instanceId: row.chainId,
        }),
      );
    }
    const instanceId = instanceIdAt(row.chainId, row.workflows, cursor);
    // wf-registry identity: workflow name = the member's kind; slug = the chain's slug (authoritative);
    // repo = the chain-level target (blackboard `repo`). Opt-in — absent repo ⇒ no row (§3c).
    const wf = wfIdentityFrom({ repo: row.data.repo, slug: row.slug }, workflow.kind);
    yield* invoker.invoke({
      ...toRequest(stored.value, traceparent, params),
      instanceId,
      // Chain members are sequential work on ONE branch/PR, so they SHARE a workspace keyed by the
      // chain id (the reusable-workspace pattern): every member's worktree/workspace dir resolves to
      // the same path. Without this, member N's create-worktree cuts feature/<slug> at a
      // per-instanceId path and collides with an earlier member's worktree of the same branch
      // ("'feature/<slug>' is already used by worktree at …"). Idempotent: the first member creates
      // the worktree, later members reuse it.
      workspaceId: row.chainId,
      // A loop re-fire (forceFresh) must purge the terminal prior instance to re-run.
      fresh: forceFresh || (workflow.fresh ?? false),
      ...(wf ? { wf } : {}),
    });
    yield* (yield* ChainStore).bumpLedger(chainLedgerDate(Date.now()), { workflowsFired: 1 });
  });

// ---------------------------------------------------------------------------
// The scan (one per cron tick)
// ---------------------------------------------------------------------------

export const scanChainsEffect = (
  traceparent: string | undefined,
): Effect.Effect<ChainScanReport, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    const cs = yield* ChainStore;
    const nowMs = Date.now();
    const config = yield* cs.getConfig();
    const enabled = Option.isNone(config) || config.value.enabled !== false;
    yield* cs.heartbeat({ at: new Date(nowMs).toISOString(), enabled }).pipe(Effect.ignore);

    const report: ChainScanReport = {
      scanned: 0,
      advanced: [],
      finalized: [],
      terminated: [],
      errors: [],
    };
    if (!enabled) return { ...report, disabled: true };

    const rows = yield* cs.listRows();
    const active = rows.filter((row) => row.status !== "finalized");
    report.scanned = active.length;
    for (const row of active) {
      // One chain's failure never starves the rest.
      yield* processRow(row, nowMs, traceparent, report).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            report.errors.push(`${row.chainId}: ${messageOf(err)}`);
          }),
        ),
      );
    }
    return report;
  });

const processRow = (
  row: ChainRow,
  nowMs: number,
  traceparent: string | undefined,
  report: ChainScanReport,
): Effect.Effect<void, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    const invoker = yield* WorkflowInvoker;
    const instanceId =
      row.currentInstanceId ?? instanceIdAt(row.chainId, row.workflows, row.cursor);
    // Transport failures read as UNKNOWN so the streak machinery owns them — sequencing must
    // outlive infra hiccups, exactly like the watch scan.
    const status = yield* invoker
      .getStatus(instanceId)
      .pipe(Effect.catchAll(() => Effect.succeed({ instanceId, runtimeStatus: "UNKNOWN" })));
    const decision = decide(row, status.runtimeStatus, nowMs);
    const output = (status as { output?: string }).output;
    // loop-until-clean reinterprets the linear advance/finalize the pure engine gives (the engine
    // stays strategy-agnostic; the predicate + loop-back need the output and the workflow kinds, which
    // live here). The review workflow completing CLEAN finalizes; the last workflow (revise) completing loops
    // back to re-review, until the iteration budget trips.
    const loop = row.strategy === "loop-until-clean" ? row.loop : undefined;
    switch (decision.kind) {
      case "wait": {
        if (decision.changed) yield* saveFenced(row.epoch, stamp(decision.row, nowMs));
        return;
      }
      case "advance": {
        // The just-completed member IS the loop-start (review) workflow here; its declared `until`
        // (structured) or the coded reviewIsClean marker sniff decides whether the loop stops.
        const loopMember = loop ? row.workflows[row.cursor] : undefined;
        if (
          loop &&
          loopMember &&
          row.cursor === loop.startCursor &&
          loopIsClean(loopMember, output)
        ) {
          const note = `clean after ${loop.iterations} revise iteration(s)`;
          return yield* executeFinalize({ ...row, note }, "completed", nowMs, report);
        }
        return yield* executeAdvance(
          row,
          output,
          decision.nextCursor,
          false,
          nowMs,
          traceparent,
          report,
        );
      }
      case "finalize": {
        if (loop && decision.outcome === "completed") {
          if (loop.iterations + 1 < loop.maxIterations) {
            // The revise workflow finished: loop back to the review workflow (fresh re-fire), bump the counter.
            return yield* executeAdvance(
              row,
              output,
              loop.startCursor,
              true,
              nowMs,
              traceparent,
              report,
            );
          }
          const note = `stopped after ${loop.maxIterations} iterations (findings may remain)`;
          return yield* executeFinalize({ ...decision.row, note }, "completed", nowMs, report);
        }
        return yield* executeFinalize(decision.row, decision.outcome, nowMs, report);
      }
      case "budget-terminate": {
        // Terminate the current workflow; the loser of a terminate race re-checks and treats an
        // already-terminal instance as success. Anything else waits for the next tick.
        const terminated = yield* invoker.terminate(instanceId).pipe(
          Effect.as(true),
          Effect.catchAll(() =>
            invoker.getStatus(instanceId).pipe(
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
        report.terminated.push(instanceId);
        return yield* executeFinalize(decision.row, "budget-terminated", nowMs, report);
      }
    }
  });

// ---------------------------------------------------------------------------
// Actions (each epoch-fenced)
// ---------------------------------------------------------------------------

/** Writes `next` only if the stored row still carries `expectEpoch`; false when stale. */
const saveFenced = (
  expectEpoch: number,
  next: ChainRow,
): Effect.Effect<boolean, WorkflowError, ChainStore> =>
  Effect.gen(function* () {
    const cs = yield* ChainStore;
    const current = yield* cs.getRow(next.chainId);
    if (Option.isNone(current) || current.value.epoch !== expectEpoch) return false;
    yield* cs.saveRow(next);
    return true;
  });

/**
 * The current workflow completed and a next workflow remains: capture the completed workflow's OUTPUT into the
 * blackboard (engine code, not an actor), build the next workflow's params, and fire it. Mark-before-fire
 * fenced on the OLD epoch; a build/dispatch failure finalizes the chain failed so it never loops.
 */
const executeAdvance = (
  row: ChainRow,
  completedOutput: string | undefined,
  nextCursor: number,
  loopBack: boolean,
  nowMs: number,
  traceparent: string | undefined,
  report: ChainScanReport,
): Effect.Effect<void, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    // Capture what the just-completed workflow produced into a fresh blackboard — its structured
    // output when the member declares captures, its ===PR===/===REVIEW=== markers otherwise.
    const data: Blackboard = { ...row.data };
    contractFor(row.workflows[row.cursor]).capture(completedOutput, data);

    const now = new Date(nowMs).toISOString();
    const instanceId = instanceIdAt(row.chainId, row.workflows, nextCursor);
    // A loop-back re-enters the loop body: bump the iteration counter and re-fire fresh (the target
    // instance is terminal from the prior pass).
    const loop =
      loopBack && row.loop ? { ...row.loop, iterations: row.loop.iterations + 1 } : row.loop;
    const next: ChainRow = {
      ...row,
      epoch: row.epoch + 1,
      cursor: nextCursor,
      currentInstanceId: instanceId,
      data,
      status: "scheduling",
      lastStatus: "SCHEDULED",
      unknownStreak: 0,
      ...(loop ? { loop } : {}),
      note: loopBack
        ? `loop back to workflow ${nextCursor} (${row.workflows[nextCursor].kind}), iteration ${loop?.iterations}`
        : `advanced to workflow ${nextCursor} (${row.workflows[nextCursor].kind})`,
      updatedAt: now,
    };
    // Mark-before-fire, fenced on the OLD epoch — a concurrent re-registration wins and this drops.
    const saved = yield* saveFenced(row.epoch, next);
    if (!saved) return;
    yield* fireWorkflow(next, nextCursor, traceparent, loopBack).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          report.advanced.push(`${row.chainId}:w${nextCursor}:${row.workflows[nextCursor].kind}`);
        }),
      ),
      // A failed advance finalizes the chain failed (fenced on the NEW epoch) — never loop.
      Effect.catchAll((err) =>
        saveFenced(next.epoch, {
          ...next,
          status: "finalized",
          outcome: "failed",
          note: `advance to workflow ${nextCursor} failed: ${messageOf(err)}`,
          lastStatus: "FAILED",
          endedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }).pipe(Effect.asVoid),
      ),
    );
  });

const executeFinalize = (
  row: ChainRow,
  outcome: ChainOutcome,
  nowMs: number,
  report: ChainScanReport,
): Effect.Effect<void, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    const cs = yield* ChainStore;
    const publisher = yield* DaprPublisherTag;
    const { costUsd, costGap } = yield* tallyChainCost(row);
    const endedAt = new Date().toISOString();
    const final: ChainRow = {
      ...row,
      status: "finalized",
      outcome,
      lastStatus: runtimeStatusOf(outcome),
      endedAt,
      updatedAt: endedAt,
    };
    const saved = yield* saveFenced(row.epoch, final);
    if (!saved) return;
    report.finalized.push(`${row.chainId}:${outcome}`);
    yield* cs.bumpLedger(chainLedgerDate(nowMs), { chainsFinalized: 1, costUsd });
    yield* publisher
      .publish(PUBSUB, EVENTS_TOPIC, {
        instanceId: row.chainId,
        chain: true,
        outcome,
        runtimeStatus: final.lastStatus,
        watcher: "workflow-svc",
        slug: row.slug,
        workflows: row.workflows.length,
        reachedCursor: row.cursor,
        startedAt: row.startedAt,
        endedAt,
        costUsd,
        costGap,
      })
      .pipe(Effect.ignore);
  });

/** Finalize a chain as failed with a note, fenced on the current epoch (registration/advance path). */
const finalizeFailed = (
  row: ChainRow,
  note: string,
): Effect.Effect<void, WorkflowError, ChainStore> =>
  saveFenced(row.epoch, {
    ...row,
    status: "finalized",
    outcome: "failed",
    lastStatus: "FAILED",
    note,
    endedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).pipe(Effect.asVoid);

// ---------------------------------------------------------------------------
// Cost tally — sum over the run mirrors of every workflow instance the chain ran
// ---------------------------------------------------------------------------

/**
 * A chain's cost is every workflow's cost: sum costUsd over run mirrors grouping under any instanceId the
 * chain ran (workflows 0..cursor; a shared instanceId, e.g. feature+revise, is counted once via the set).
 * Zero matching records is a LEDGER GAP — flagged, never a silent $0 (the watch tally's rule).
 */
export const tallyChainCost = (
  row: ChainRow,
): Effect.Effect<{ costUsd: number; costGap: boolean }, WorkflowError, ChainStore> =>
  Effect.gen(function* () {
    const cs = yield* ChainStore;
    const ran = new Set<string>();
    for (let c = 0; c <= row.cursor && c < row.workflows.length; c++) {
      ran.add(instanceIdAt(row.chainId, row.workflows, c));
    }
    const keys = yield* cs.listRunKeys();
    const mine = keys.filter((key) => [...ran].some((id) => key.startsWith(`run:${id}:`)));
    if (mine.length === 0) return { costUsd: 0, costGap: true };
    let cost = 0;
    for (const key of mine) {
      const usd = yield* cs.getRunCost(key);
      if (typeof usd === "number") cost += usd;
    }
    return { costUsd: Math.round(cost * 10_000) / 10_000, costGap: false };
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stamp(row: ChainRow, nowMs: number): ChainRow {
  return { ...row, updatedAt: new Date(nowMs).toISOString() };
}

function runtimeStatusOf(outcome: ChainOutcome): string {
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
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string") return cause;
  return String(err);
}
