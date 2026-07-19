import { WorkflowError } from "core";
import { DaprPublisherTag } from "core-dapr";
import { Effect, Option } from "effect";

import { decide, type MemberObservation } from "./chain-engine.ts";
import { type Blackboard, ChainThreadError, contractFor, loopIsClean } from "./chain-workflows.ts";
import {
  type ChainWorkflow,
  type ChainOutcome,
  type ChainRow,
  type ChainStrategy,
  chainLedgerDate,
  membersInStage,
  stageOf,
  validateStages,
} from "./models/chain.model.ts";
import { wfIdentityFrom } from "./models/wf.model.ts";
import { toRequest } from "./models/workflow.model.ts";
import { ChainStore } from "./ports/IChainStore.ts";
import { WorkflowInvoker } from "./ports/IWorkflowInvoker.ts";
import { WorkflowStore } from "./ports/IWorkflowStore.ts";

/**
 * The effectful half of the chain engine, sibling of watch-scan.ts: registration on the fire path,
 * and the per-tick scan that reads each active chain row, observes every member of the CURRENT STAGE
 * (docs/plans/inline-chain-cron-composition.md D3), asks the pure engine (chain-engine.ts) what to
 * do, and executes the closed vocabulary — wait, ADVANCE (capture every completed member's output
 * into the blackboard, then fire the next stage's members), finalize (record + publish + cost tally),
 * budget-terminate. Where the watch engine RE-fires one instance, the chain FIRES THE NEXT STAGE (a
 * concurrent set of members, joined on all of them completing).
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

/** The instanceId a member runs under: explicit on the member, else derived from the chain + index. */
export function instanceIdAt(
  chainId: string,
  workflows: readonly ChainWorkflow[],
  index: number,
): string {
  return workflows[index]?.instanceId ?? `${chainId}-w${index}`;
}

/** One member of the current stage read from the invoker, with its completion predicate resolved. */
type MemberRead = {
  readonly index: number;
  readonly instanceId: string;
  readonly runtimeStatus: string;
  readonly output?: string;
  readonly done: boolean;
  readonly failed: boolean;
};

// ---------------------------------------------------------------------------
// Registration (the fire choke point — marks the row, then fires stage 0)
// ---------------------------------------------------------------------------

export type ChainRegistration = {
  readonly slug: string;
  readonly workflows: readonly ChainWorkflow[];
  /** Initial blackboard — the inputs the first stage reads (slug, spec, issueNumber?). */
  readonly data: Blackboard;
  readonly strategy?: ChainStrategy;
  /** For strategy "loop-until-clean": where the loop body starts (the review stage) + the cap. */
  readonly loop?: { readonly startCursor: number; readonly maxIterations: number };
  readonly budgetMs?: number;
  readonly meta?: Blackboard;
};

/**
 * Registers a chain (chainId = slug) and fires stage 0's members. Mark-before-fire: the `scheduling`
 * row lands before the invoke, so a crash between the two leaves a row the scan heals (UNKNOWN →
 * orphaned) instead of a silently unsequenced chain. Re-registering a slug bumps the epoch (fences any
 * in-flight scan decision). A dispatch failure finalizes the chain failed, never a dangling row. An
 * invalid stage layout (gap / mixed declared) fails registration loud — never arm a chain that can't
 * progress.
 */
export const registerChainForFire = (
  reg: ChainRegistration,
  traceparent: string | undefined,
): Effect.Effect<{ chainId: string; firing: boolean }, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    const cs = yield* ChainStore;
    const invalid = validateStages(reg.workflows);
    if (invalid !== null)
      return yield* Effect.fail(
        new WorkflowError({ cause: `invalid chain stages: ${invalid}`, instanceId: reg.slug }),
      );
    const existing = yield* cs.getRow(reg.slug);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const data: Blackboard = { ...reg.data };
    const stage0 = membersInStage(reg.workflows, 0);
    const primary = instanceIdAt(reg.slug, reg.workflows, stage0[0] ?? 0);
    const row: ChainRow = {
      chainId: reg.slug,
      epoch: (Option.getOrUndefined(existing)?.epoch ?? 0) + 1,
      slug: reg.slug,
      workflows: reg.workflows,
      strategy: reg.strategy ?? "sequential",
      ...(reg.loop ? { loop: { ...reg.loop, iterations: 0 } } : {}),
      ...(reg.budgetMs !== undefined ? { budgetMs: reg.budgetMs } : {}),
      cursor: 0,
      currentInstanceId: primary,
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
    yield* fireStage(row, 0, traceparent).pipe(
      Effect.catchAll((err) => finalizeFailed(row, `stage 0 dispatch failed: ${messageOf(err)}`)),
    );
    return { chainId: reg.slug, firing: true };
  });

/**
 * Fires the member at `memberIndex`: build its params from the blackboard (the engine-coded
 * contract), resolve its saved workflow, invoke under the member's instanceId, and bump the ledger.
 * Fails with a WorkflowError the caller turns into a failed-chain finalize. Assumes the row already
 * reflects the member's stage (registration and advance both mark-before-fire).
 */
const fireWorkflow = (
  row: ChainRow,
  memberIndex: number,
  traceparent: string | undefined,
  forceFresh = false,
): Effect.Effect<void, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    const invoker = yield* WorkflowInvoker;
    const wfStore = yield* WorkflowStore;
    const workflow = row.workflows[memberIndex];
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
    const instanceId = instanceIdAt(row.chainId, row.workflows, memberIndex);
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

/** Fire every member of a stage (concurrent set); ledger bumps once per member inside fireWorkflow. */
const fireStage = (
  row: ChainRow,
  stage: number,
  traceparent: string | undefined,
  forceFresh = false,
): Effect.Effect<void, WorkflowError, ChainScanEnv> =>
  Effect.forEach(
    membersInStage(row.workflows, stage),
    (i) => fireWorkflow(row, i, traceparent, forceFresh),
    { discard: true },
  );

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

/** Read one member's status and reduce it to the completion predicate (D4). */
const observeMember = (
  row: ChainRow,
  index: number,
): Effect.Effect<MemberRead, WorkflowError, WorkflowInvoker> =>
  Effect.gen(function* () {
    const invoker = yield* WorkflowInvoker;
    const instanceId = instanceIdAt(row.chainId, row.workflows, index);
    // Transport failures read as UNKNOWN so the streak machinery owns them — sequencing must outlive
    // infra hiccups, exactly like the watch scan.
    const status = yield* invoker
      .getStatus(instanceId)
      .pipe(Effect.catchAll(() => Effect.succeed({ instanceId, runtimeStatus: "UNKNOWN" })));
    const runtimeStatus = status.runtimeStatus;
    const output = (status as { output?: string }).output;
    // Phase 2 completion predicate (D4): a plain member is `done` at terminal-success and `failed` at
    // terminal-failure. (A cron member reads `wf:resolved`; an `until` member reads its predicate —
    // later phases.)
    return {
      index,
      instanceId,
      runtimeStatus,
      output,
      done: runtimeStatus === "COMPLETED",
      failed: runtimeStatus === "FAILED" || runtimeStatus === "TERMINATED",
    };
  });

const processRow = (
  row: ChainRow,
  nowMs: number,
  traceparent: string | undefined,
  report: ChainScanReport,
): Effect.Effect<void, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    // Observe every member of the current stage. Sequential reads keep the scan deterministic (tests
    // assert on fire order) — a stage is a handful of members.
    const members = membersInStage(row.workflows, row.cursor);
    const reads = yield* Effect.forEach(members, (i) => observeMember(row, i));
    const observations: MemberObservation[] = reads.map((r) => ({
      index: r.index,
      runtimeStatus: r.runtimeStatus,
      done: r.done,
      failed: r.failed,
    }));
    const decision = decide(row, observations, nowMs);
    // loop-until-clean reinterprets the linear advance/finalize the pure engine gives (the engine
    // stays strategy-agnostic; the predicate + loop-back need the output and the workflow kinds, which
    // live here). Loop stages are single-member (the review / the revise), so the stage's sole read
    // carries the predicate output.
    const loop = row.strategy === "loop-until-clean" ? row.loop : undefined;
    switch (decision.kind) {
      case "wait": {
        if (decision.changed) yield* saveFenced(row.epoch, stamp(decision.row, nowMs));
        return;
      }
      case "advance": {
        // The just-completed stage IS the loop-start (review) stage here; its declared `until`
        // (structured) or the kind's coded reviewIsClean verdict check decides whether the loop stops.
        if (loop && row.cursor === loop.startCursor) {
          const loopMember = row.workflows[members[0]];
          if (loopMember && loopIsClean(loopMember, reads[0]?.output)) {
            const note = `clean after ${loop.iterations} revise iteration(s)`;
            return yield* executeFinalize({ ...row, note }, "completed", nowMs, report);
          }
        }
        return yield* executeAdvance(
          row,
          reads,
          decision.nextStage,
          false,
          nowMs,
          traceparent,
          report,
        );
      }
      case "finalize": {
        if (loop && decision.outcome === "completed") {
          if (loop.iterations + 1 < loop.maxIterations) {
            // The revise stage finished: loop back to the review stage (fresh re-fire), bump the counter.
            return yield* executeAdvance(
              row,
              reads,
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
        return yield* terminateStageAndFinalize(decision.row, reads, nowMs, report);
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
 * The current stage's members all completed and a next stage remains: capture EACH completed member's
 * OUTPUT into the blackboard (engine code, not an actor), then fire every member of the next stage.
 * Mark-before-fire fenced on the OLD epoch; a build/dispatch failure finalizes the chain failed so it
 * never loops.
 */
const executeAdvance = (
  row: ChainRow,
  completed: readonly MemberRead[],
  nextStage: number,
  loopBack: boolean,
  nowMs: number,
  traceparent: string | undefined,
  report: ChainScanReport,
): Effect.Effect<void, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    // Capture what every member of the just-completed stage produced into a fresh blackboard — its
    // validated structured output (explicit captures mapping, else the kind contract).
    const data: Blackboard = { ...row.data };
    for (const r of completed) contractFor(row.workflows[r.index]).capture(r.output, data);

    const now = new Date(nowMs).toISOString();
    const nextMembers = membersInStage(row.workflows, nextStage);
    const primary = instanceIdAt(row.chainId, row.workflows, nextMembers[0] ?? nextStage);
    // A loop-back re-enters the loop body: bump the iteration counter and re-fire fresh (the target
    // instances are terminal from the prior pass).
    const loop =
      loopBack && row.loop ? { ...row.loop, iterations: row.loop.iterations + 1 } : row.loop;
    const kinds = nextMembers.map((i) => row.workflows[i].kind).join(", ");
    const next: ChainRow = {
      ...row,
      epoch: row.epoch + 1,
      cursor: nextStage,
      currentInstanceId: primary,
      data,
      status: "scheduling",
      lastStatus: "SCHEDULED",
      unknownStreak: 0,
      ...(loop ? { loop } : {}),
      note: loopBack
        ? `loop back to stage ${nextStage} (${kinds}), iteration ${loop?.iterations}`
        : `advanced to stage ${nextStage} (${kinds})`,
      updatedAt: now,
    };
    // Mark-before-fire, fenced on the OLD epoch — a concurrent re-registration wins and this drops.
    const saved = yield* saveFenced(row.epoch, next);
    if (!saved) return;
    yield* fireStage(next, nextStage, traceparent, loopBack).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          for (const i of nextMembers)
            report.advanced.push(`${row.chainId}:w${i}:${row.workflows[i].kind}`);
        }),
      ),
      // A failed advance finalizes the chain failed (fenced on the NEW epoch) — never loop.
      Effect.catchAll((err) =>
        saveFenced(next.epoch, {
          ...next,
          status: "finalized",
          outcome: "failed",
          note: `advance to stage ${nextStage} failed: ${messageOf(err)}`,
          lastStatus: "FAILED",
          endedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }).pipe(Effect.asVoid),
      ),
    );
  });

/**
 * Budget breach: terminate every still-running member of the live stage, then finalize
 * budget-terminated. The loser of a terminate race re-checks and treats an already-terminal instance
 * as down; any member not down defers the finalize to the next tick.
 */
const terminateStageAndFinalize = (
  row: ChainRow,
  reads: readonly MemberRead[],
  nowMs: number,
  report: ChainScanReport,
): Effect.Effect<void, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    const invoker = yield* WorkflowInvoker;
    let allDown = true;
    for (const r of reads) {
      const down = yield* invoker.terminate(r.instanceId).pipe(
        Effect.as(true),
        Effect.catchAll(() =>
          invoker.getStatus(r.instanceId).pipe(
            Effect.map((s) => TERMINAL_STATUSES.has(s.runtimeStatus)),
            Effect.catchAll(() => Effect.succeed(false)),
          ),
        ),
      );
      if (down) report.terminated.push(r.instanceId);
      else allDown = false;
    }
    if (!allDown) {
      yield* saveFenced(
        row.epoch,
        stamp({ ...row, note: "terminate rejected; retrying next tick" }, nowMs),
      );
      return;
    }
    return yield* executeFinalize(row, "budget-terminated", nowMs, report);
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
 * A chain's cost is every member's cost: sum costUsd over run mirrors grouping under any instanceId of
 * a member whose stage the chain has reached (stage ≤ cursor; a shared instanceId, e.g. feature+revise,
 * is counted once via the set). Zero matching records is a LEDGER GAP — flagged, never a silent $0
 * (the watch tally's rule).
 */
export const tallyChainCost = (
  row: ChainRow,
): Effect.Effect<{ costUsd: number; costGap: boolean }, WorkflowError, ChainStore> =>
  Effect.gen(function* () {
    const cs = yield* ChainStore;
    const ran = new Set<string>();
    for (let i = 0; i < row.workflows.length; i++) {
      if (stageOf(row.workflows, i) <= row.cursor)
        ran.add(instanceIdAt(row.chainId, row.workflows, i));
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
