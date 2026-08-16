import { WorkflowError } from "core";
import { DaprPublisherTag } from "core-dapr";
import { Effect, Option } from "effect";

import { decide, type MemberObservation } from "./chain-engine.ts";
import { type ChainData, ChainThreadError, contractFor, loopIsClean } from "workflow-core";
import {
  type ChainMember,
  type ChainOutcome,
  type ChainRow,
  type ChainStrategy,
  DEFAULT_CHAIN_UNKNOWN_STREAK_LIMIT,
  chainLedgerDate,
  membersInStage,
  stageOf,
  validateChain,
} from "engine-core";
import { CRON_DISARM_TOPIC } from "engine-core";
import { wfIdentityFrom } from "engine-core";
import { toRequest, type WorkflowRequest } from "engine-core";
import { ChainStore } from "engine-core";
import { WatchStore } from "engine-core";
import { WfStore } from "engine-core";
import { WorkflowInvoker } from "engine-core";
import { WorkflowStore } from "engine-core";
import { invokeWithWatch } from "./watch-scan.ts";

/**
 * The effectful half of the chain engine, sibling of watch-scan.ts: registration on the fire path,
 * and the per-tick scan that reads each active chain row, observes every member of the CURRENT STAGE
 *, asks the pure engine (chain-engine.ts) what to
 * do, and executes the closed vocabulary — wait, ADVANCE (capture every completed member's output
 * into the chain data, then fire the next stage's members), finalize (record + publish + cost tally),
 * budget-terminate. Where the watch engine RE-fires one instance, the chain FIRES THE NEXT STAGE (a
 * concurrent set of members, joined on all of them completing).
 *
 * Every row-mutating action is epoch-fenced: it re-reads the row and no-ops when the epoch moved
 * (a re-registration created a new incarnation and this decision is stale).
 */

const PUBSUB = "pubsub";
const EVENTS_TOPIC = "workflow-events";
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "TERMINATED"]);

// WatchStore rides along because member fires go through invokeWithWatch (the fire choke point):
// a member's embedded `watch` policy registers there, mark-before-fire, at its deferred fire moment.
export type ChainScanEnv =
  | ChainStore
  | WorkflowInvoker
  | WorkflowStore
  | WatchStore
  | WfStore
  | DaprPublisherTag;

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
  members: readonly ChainMember[],
  index: number,
): string {
  return members[index]?.instanceId ?? `${chainId}-w${index}`;
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
  readonly members: readonly ChainMember[];
  /** Initial chain data — the inputs the first stage reads (slug, spec, issueNumber?). */
  readonly data: ChainData;
  /** Low-priority defaults (issue #82): implicit --slug lands here so a parent seed wins over it. */
  readonly defaultData?: ChainData;
  readonly strategy?: ChainStrategy;
  /** For strategy "loop-until-clean": where the loop body starts (the review stage) + the cap. */
  readonly loop?: { readonly startCursor: number; readonly maxIterations: number };
  readonly budgetMs?: number;
  readonly meta?: ChainData;
  /** Activation gates (issue #78) — see chain.model.ts. */
  readonly after?: string;
  readonly notBefore?: string;
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
  _traceparent: string | undefined,
): Effect.Effect<{ chainId: string; firing: boolean }, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    const cs = yield* ChainStore;
    const invalid = validateChain(reg.members);
    if (invalid !== null)
      return yield* Effect.fail(
        new WorkflowError({ cause: `invalid chain stages: ${invalid}`, instanceId: reg.slug }),
      );
    const existing = yield* cs.getRow(reg.slug);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const data: ChainData = { ...reg.data };
    const stage0 = membersInStage(reg.members, 0);
    const primary = instanceIdAt(reg.slug, reg.members, stage0[0] ?? 0);
    const row: ChainRow = {
      chainId: reg.slug,
      epoch: (Option.getOrUndefined(existing)?.epoch ?? 0) + 1,
      slug: reg.slug,
      members: reg.members,
      strategy: reg.strategy ?? "sequential",
      ...(reg.loop ? { loop: { ...reg.loop, iterations: 0 } } : {}),
      ...(reg.budgetMs !== undefined ? { budgetMs: reg.budgetMs } : {}),
      cursor: 0,
      currentInstanceId: primary,
      data,
      status: "scheduling",
      lastStatus: "SCHEDULED",
      unknownStreak: 0,
      ...(reg.defaultData ? { defaultData: reg.defaultData } : {}),
      ...(reg.meta ? { meta: reg.meta } : {}),
      ...(reg.after ? { after: reg.after } : {}),
      ...(reg.notBefore ? { notBefore: reg.notBefore } : {}),
      startedAt: now,
      updatedAt: now,
    };
    yield* cs.saveRow(row);
    yield* cs.bumpLedger(chainLedgerDate(nowMs), { chainsRegistered: 1 });
    // Issue #79a: registration is persist-only — the SCAN fires stage 0 (activation branch in
    // processRow), so a slow/hung dispatch can never block this handler or strand an orphan when
    // the client disconnects. `firing` now means "armed to fire on the next tick".
    return { chainId: reg.slug, firing: true };
  });

/**
 * Fires the member at `memberIndex`: build its params from the chain data (the engine-coded
 * contract), resolve its saved workflow, and pass the member's embedded fire descriptor through
 * the fire choke point (invokeWithWatch) under the member's instanceId, bumping the ledger.
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
    const wfStore = yield* WorkflowStore;
    const member = row.members[memberIndex];
    if (!member) return;
    // A missing chain data input (ChainThreadError) or any other build failure surfaces as a
    // WorkflowError the caller turns into a failed-chain finalize. THREADED params (the kind
    // contract / declared inputs reading the chain data) merge OVER the member's own params:
    // member.params carry fire-time identity (runActivity/agentId/model*) plus the template's
    // RENDERED DEFAULTS, and a rendered default (clonePath: "", verifyCmd: <repo default>) must
    // never clobber an explicitly threaded value (trxy trial run 1, 2026-07-25: the h-repo
    // default clonePath overrode -p clonePath=/workspace/trxy-v2 and the worktree cut from the
    // WRONG repo). Identity stays safe: no kind contract emits identity keys — disjoint.
    const params = yield* Effect.try({
      try: () => ({
        ...(member.params ?? {}),
        ...contractFor(member).buildParams(row.data),
      }),
      catch: (cause) => new WorkflowError({ cause, instanceId: row.chainId }),
    });
    // wf-registry identity: workflow name = the member's kind; slug = the chain's slug (authoritative);
    // repo = the chain-level target (chain data `repo`). Opt-in — absent repo ⇒ no row (§3c).
    const wf = wfIdentityFrom({ repo: row.data.repo, slug: row.slug }, member.kind);
    // A cron member self-arms its recurrence via §10 (its generic.workflow closing bracket runs
    // register-cron over an embedded source built from these very steps); the chain NEVER writes
    // cron:sub. It MUST carry a wf identity — both the cron engine's goal check and the chain's
    // completion predicate read `wf:<repo>:<slug>:<kind>.resolved` — so fail loud without one.
    if (member.cron && !wf) {
      return yield* Effect.fail(
        new WorkflowError({
          cause: `cron chain member '${member.kind}' needs a repo on the chain data (its recurrence + completion read wf:<repo>:<slug>:<${member.kind}>)`,
          instanceId: row.chainId,
        }),
      );
    }
    const armCron = member.cron
      ? {
          cadence: member.cron.cadence,
          workflow: member.kind,
          inline: true,
          ...(member.cron.maxFires !== undefined
            ? { budget: { maxFires: member.cron.maxFires } }
            : {}),
        }
      : undefined;
    // The base request: embedded steps (D1 inline storage) fired verbatim, or the saved key resolved
    // from the store. validateChain guarantees exactly one of the two.
    let base: WorkflowRequest;
    if (member.steps !== undefined) {
      base = { steps: member.steps, traceparent, params };
    } else {
      const stored = yield* wfStore.get(member.key ?? "");
      if (Option.isNone(stored) || stored.value.disabled) {
        return yield* Effect.fail(
          new WorkflowError({
            cause: `chain member '${member.kind}' key '${member.key}' missing or disabled`,
            instanceId: row.chainId,
          }),
        );
      }
      base = toRequest(stored.value, traceparent, params);
    }
    const instanceId = instanceIdAt(row.chainId, row.members, memberIndex);
    // The member IS a fire descriptor; its deferred fire moment is now, so it goes through the
    // same choke point as every other carrier — its embedded `watch` policy (if any) registers
    // there, mark-before-fire (member ids are deterministic).
    yield* invokeWithWatch({
      ...base,
      instanceId,
      // Chain members are sequential work on ONE branch/PR, so by default they SHARE a workspace
      // keyed by the chain id (the reusable-workspace pattern): every member's worktree/workspace
      // dir resolves to the same path. Without this, member N's create-worktree cuts feature/<slug>
      // at a per-instanceId path and collides with an earlier member's worktree of the same branch
      // ("'feature/<slug>' is already used by worktree at …"). Idempotent: the first member creates
      // the worktree, later members reuse it. A member's own workspaceId opts it out.
      workspaceId: member.workspaceId ?? row.chainId,
      // A loop re-fire (forceFresh) must purge the terminal prior instance to re-run.
      fresh: forceFresh || (member.fresh ?? false),
      ...(wf ? { wf } : {}),
      // A cron member arms its OWN recurrence in its closing bracket (register-cron reads input.steps
      // for the embedded source); the chain only observes it thereafter.
      ...(armCron ? { armCron } : {}),
      ...(member.watch
        ? {
            watch: member.watch,
            watchMeta: { owner: "chain", chainId: row.chainId, member: memberIndex },
          }
        : {}),
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
    membersInStage(row.members, stage),
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
): Effect.Effect<MemberRead, WorkflowError, WorkflowInvoker | WfStore> =>
  Effect.gen(function* () {
    const instanceId = instanceIdAt(row.chainId, row.members, index);
    const member = row.members[index];
    // Cron member (D2/D4): the chain OBSERVES `wf:<repo>:<slug>:<kind>` — it never fired the
    // recurrence (the member self-armed cron:sub via §10) and never reads the flaky instance status.
    // `done` ⟺ the goal handshake `resolved` flag is set (the cron engine reads the same flag to
    // deactivate); `output` is the resolved run's serialized output (stamped by write-wf-row on the
    // same terminal write, so capture threads off the RESOLVED run). Transient run failures NEVER
    // fail the chain — that is why it is a cron, it retries on its own clock.
    if (member?.cron) {
      const wfStore = yield* WfStore;
      const identity = wfIdentityFrom({ repo: row.data.repo, slug: row.slug }, member.kind);
      const wfRow = identity
        ? yield* wfStore.getRow(identity).pipe(Effect.catchAll(() => Effect.succeed(Option.none())))
        : Option.none();
      const resolved = Option.isSome(wfRow) && wfRow.value.resolved === true;
      return {
        index,
        instanceId,
        runtimeStatus: resolved ? "COMPLETED" : "RUNNING",
        output: Option.isSome(wfRow) ? wfRow.value.output : undefined,
        done: resolved,
        failed: false,
      };
    }
    // Plain member: read the instance. Transport failures read as UNKNOWN so the streak machinery
    // owns them — sequencing must outlive infra hiccups, exactly like the watch scan. `done` at
    // terminal-success, `failed` at terminal-failure.
    const invoker = yield* WorkflowInvoker;
    const status = yield* invoker
      .getStatus(instanceId)
      .pipe(Effect.catchAll(() => Effect.succeed({ instanceId, runtimeStatus: "UNKNOWN" })));
    const runtimeStatus = status.runtimeStatus;
    const output = (status as { output?: string }).output;
    return {
      index,
      instanceId,
      runtimeStatus,
      output,
      done: runtimeStatus === "COMPLETED",
      failed: runtimeStatus === "FAILED" || runtimeStatus === "TERMINATED",
    };
  });

/** Capture every DONE member's validated output into a fresh chain data (issue #77: run on
 *  advance AND on the terminal stage, so the finalized row carries the last stage's captures). */
const captureCompleted = (row: ChainRow, reads: readonly MemberRead[]): ChainData => {
  const data: ChainData = { ...row.data };
  for (const r of reads) if (r.done) contractFor(row.members[r.index]).capture(r.output, data);
  return data;
};

/** Activation verdict for a `scheduling` row (issues #78/#79a): fire now (optionally seeded from
 *  the finished parent's data), hold for a gate, or abort because the parent failed. */
type Activation =
  | { readonly kind: "hold"; readonly parentAbsent: boolean }
  | { readonly kind: "fire"; readonly seed?: ChainData }
  | { readonly kind: "abort"; readonly note: string };

const decideActivation = (
  row: ChainRow,
  nowMs: number,
): Effect.Effect<Activation, WorkflowError, ChainStore> =>
  Effect.gen(function* () {
    if (row.notBefore !== undefined && nowMs < Date.parse(row.notBefore))
      return { kind: "hold", parentAbsent: false } as const;
    if (row.after !== undefined) {
      const cs = yield* ChainStore;
      const parent = yield* cs.getRow(row.after);
      if (Option.isNone(parent)) return { kind: "hold", parentAbsent: true } as const;
      const p = parent.value;
      if (p.status !== "finalized") return { kind: "hold", parentAbsent: false } as const;
      if (p.outcome !== "completed")
        return {
          kind: "abort",
          note: `after-chain '${row.after}' finalized ${p.outcome} — not activating`,
        } as const;
      // Parent completed: its finalized data (incl. terminal captures, #77) seeds this chain's
      // data where absent — the child's own -p values win on conflicts.
      return { kind: "fire", seed: p.data } as const;
    }
    return { kind: "fire" } as const;
  });

const processRow = (
  row: ChainRow,
  nowMs: number,
  traceparent: string | undefined,
  report: ChainScanReport,
): Effect.Effect<void, WorkflowError, ChainScanEnv> =>
  Effect.gen(function* () {
    // Activation branch (issues #78/#79a): a `scheduling` row means its current stage has not been
    // successfully dispatched — registration no longer fires stage 0 in the request path, and the
    // `after`/`notBefore` gates hold the fire until satisfied. Fire-then-mark: dispatch (a re-fire
    // of an already-started instance ATTACHES, so a crash between fire and mark self-heals by
    // re-entering here), then flip to `running` so observation owns the row from the next tick.
    if (row.status === "scheduling") {
      const activation = yield* decideActivation(row, nowMs);
      if (activation.kind === "hold") {
        if (!activation.parentAbsent) return; // gate legitimately pending — no streak, no budget
        // A missing parent is an operator error (typo'd --after / purged row): streak → orphaned.
        const streak = row.unknownStreak + 1;
        if (streak >= DEFAULT_CHAIN_UNKNOWN_STREAK_LIMIT) {
          yield* executeFinalize(
            { ...row, note: `after-chain '${row.after}' not found` },
            "orphaned",
            nowMs,
            report,
          );
          return;
        }
        yield* saveFenced(row.epoch, stamp({ ...row, unknownStreak: streak }, nowMs));
        return;
      }
      if (activation.kind === "abort") {
        yield* executeFinalize({ ...row, note: activation.note }, "terminated", nowMs, report);
        return;
      }
      // Activation IS the chain's real start (batch finding, 2026-07-25): the wall-clock
      // budget must not count the gate-hold — a --in 1h chain with a 45m budget otherwise
      // budget-terminates the instant it fires. Re-stamp startedAt at activation.
      // Precedence (issue #82): defaultData (implicit --slug) < parent seed < explicit data (-p slug=...).
      const activatedAt = new Date(nowMs).toISOString();
      const defaults = row.defaultData ?? {};
      const seeded: ChainRow = activation.seed
        ? {
            ...row,
            data: { ...defaults, ...activation.seed, ...row.data },
            unknownStreak: 0,
            startedAt: activatedAt,
          }
        : { ...row, data: { ...defaults, ...row.data }, unknownStreak: 0, startedAt: activatedAt };
      // Issue #91: for --after chains, pre-flight stage 0's required inputs against the seeded data.
      // A missing required input means the parent completed without producing what this child needs
      // (e.g. an implement chain skipped opening a PR). Finalize unfulfilled instead of firing into
      // certain failure — the distinct outcome tells the operator what actually happened.
      if (row.after !== undefined) {
        const missing = checkStage0Inputs(seeded);
        if (missing.length > 0) {
          const skippedReason =
            typeof seeded.data.skipped === "string" ? seeded.data.skipped : undefined;
          const noteParts = [
            `stage 0 required inputs not produced by parent '${row.after}': ${missing.join("; ")}`,
          ];
          if (skippedReason) noteParts.push(`parent skipped: ${skippedReason}`);
          yield* executeFinalize(
            { ...seeded, note: noteParts.join(" — ") },
            "unfulfilled",
            nowMs,
            report,
          );
          return;
        }
      }
      yield* fireStage(seeded, seeded.cursor, traceparent).pipe(
        Effect.matchEffect({
          onFailure: (err) =>
            finalizeFailed(seeded, `stage ${seeded.cursor} dispatch failed: ${messageOf(err)}`),
          onSuccess: () =>
            saveFenced(
              seeded.epoch,
              stamp(
                { ...seeded, status: "running", lastStatus: "SCHEDULED", note: undefined },
                nowMs,
              ),
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  for (const i of membersInStage(seeded.members, seeded.cursor))
                    report.advanced.push(`${seeded.chainId}:w${i}:${seeded.members[i].kind}:fired`);
                }),
              ),
              Effect.asVoid,
            ),
        }),
      );
      return;
    }
    // Observe every member of the current stage. Sequential reads keep the scan deterministic (tests
    // assert on fire order) — a stage is a handful of members.
    const members = membersInStage(row.members, row.cursor);
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
          const loopMember = row.members[members[0]];
          if (loopMember && loopIsClean(loopMember, reads[0]?.output)) {
            const note = `clean after ${loop.iterations} revise iteration(s)`;
            // Issue #77: the terminal (review) stage's captures land on the finalized row too.
            const data = yield* Effect.try(() => captureCompleted(row, reads)).pipe(
              Effect.orElseSucceed(() => row.data),
            );
            return yield* executeFinalize({ ...row, data, note }, "completed", nowMs, report);
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
        // D6 atomic teardown: a non-completed finalize reaps what the live stage minted before the
        // chain records failed/terminated/orphaned. A completed chain has nothing to reap (every
        // member done, crons already resolved→deactivated). A failure/terminate also TERMINATES the
        // still-running siblings (a chain fails as a unit); orphaned only disarms (its members' status
        // is unreadable, so termination is left to the instance's own budget/watch).
        if (decision.outcome !== "completed") {
          if (decision.outcome === "failed" || decision.outcome === "terminated") {
            const killed = yield* terminateRunningMembers(reads);
            for (const id of killed) report.terminated.push(id);
          }
          yield* disarmStageCrons(row, row.cursor);
          return yield* executeFinalize(decision.row, decision.outcome, nowMs, report);
        }
        // Issue #77: a COMPLETED finalize captures the terminal stage's outputs into the row's
        // data first — the finalized row is the chain's durable result surface (an `--after`
        // child seeds from it). A capture error must not un-complete the chain: fall back to
        // the uncaptured data with a note.
        const captured = yield* Effect.try(() => captureCompleted(row, reads)).pipe(
          Effect.match({
            onFailure: (err) => ({
              data: row.data,
              note: `terminal capture failed: ${messageOf(err)}`,
            }),
            onSuccess: (data) => ({ data, note: decision.row.note }),
          }),
        );
        return yield* executeFinalize(
          {
            ...decision.row,
            data: captured.data,
            ...(captured.note ? { note: captured.note } : {}),
          },
          decision.outcome,
          nowMs,
          report,
        );
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
 * OUTPUT into the chain data (engine code, not an actor), then fire every member of the next stage.
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
    // Capture what every member of the just-completed stage produced into a fresh chain data — its
    // validated structured output (explicit captures mapping, else the kind contract).
    const data = captureCompleted(row, completed);

    const now = new Date(nowMs).toISOString();
    const nextMembers = membersInStage(row.members, nextStage);
    const primary = instanceIdAt(row.chainId, row.members, nextMembers[0] ?? nextStage);
    // A loop-back re-enters the loop body: bump the iteration counter and re-fire fresh (the target
    // instances are terminal from the prior pass).
    const loop =
      loopBack && row.loop ? { ...row.loop, iterations: row.loop.iterations + 1 } : row.loop;
    const kinds = nextMembers.map((i) => row.members[i].kind).join(", ");
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
      // Fire-then-mark to `running` (issue #79a symmetry): a crash between fire and this mark
      // re-enters the activation branch next tick, whose re-fire ATTACHES — idempotent.
      Effect.tap(() => saveFenced(next.epoch, stamp({ ...next, status: "running" }, Date.now()))),
      Effect.tap(() =>
        Effect.sync(() => {
          for (const i of nextMembers)
            report.advanced.push(`${row.chainId}:w${i}:${row.members[i].kind}`);
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

// ---------------------------------------------------------------------------
// Atomic-failure teardown (D6) — a chain fails as a unit
// ---------------------------------------------------------------------------

/**
 * Publish a disarm for every cron member of a stage (D6 step 2). A LOOSE pub/sub edge: the
 * cron-disarm subscriber (cron-scan's disarmEventEffect) stays the single writer of cron:sub — the
 * chain NEVER writes it (D2). Fire-and-forget; disarming a cron that already resolved→deactivated is
 * a no-op. Needs a repo (the cron identity's leaf) — without one no cron member could have armed.
 */
const disarmStageCrons = (
  row: ChainRow,
  stage: number,
): Effect.Effect<void, never, DaprPublisherTag> =>
  Effect.gen(function* () {
    const publisher = yield* DaprPublisherTag;
    const repo = typeof row.data.repo === "string" ? row.data.repo : undefined;
    if (!repo) return;
    for (const i of membersInStage(row.members, stage)) {
      const w = row.members[i];
      if (!w.cron) continue;
      yield* publisher
        .publish(PUBSUB, CRON_DISARM_TOPIC, { repo, slug: row.slug, workflow: w.kind })
        .pipe(Effect.ignore);
    }
  });

/**
 * Terminate every still-running member of a stage (D6 step 1) — the failed member is already terminal
 * (skipped), a `done` member has nothing to reap. Best-effort (a terminate that errors is dropped):
 * teardown must never itself fail the finalize. Returns the instanceIds it brought down for the report.
 */
const terminateRunningMembers = (
  reads: readonly MemberRead[],
): Effect.Effect<string[], never, WorkflowInvoker> =>
  Effect.gen(function* () {
    const invoker = yield* WorkflowInvoker;
    const killed: string[] = [];
    for (const r of reads) {
      if (r.done || r.failed) continue;
      const down = yield* invoker.terminate(r.instanceId).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      if (down) killed.push(r.instanceId);
    }
    return killed;
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
    // The stage's members are down; disarm any member-armed cron before finalizing (D6).
    yield* disarmStageCrons(row, row.cursor);
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
    const { costUsd, costGap, gapRuns, costByAgent } = yield* tallyChainCost(row);
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
    yield* cs.bumpLedger(chainLedgerDate(nowMs), {
      chainsFinalized: 1,
      costUsd,
      costByAgent,
      costGapRuns: gapRuns,
    });
    yield* publisher
      .publish(PUBSUB, EVENTS_TOPIC, {
        instanceId: row.chainId,
        chain: true,
        outcome,
        runtimeStatus: final.lastStatus,
        watcher: "workflow-svc",
        slug: row.slug,
        members: row.members.length,
        reachedCursor: row.cursor,
        startedAt: row.startedAt,
        endedAt,
        costUsd,
        costGap,
      })
      .pipe(Effect.ignore);
  });

/** Finalize a chain as failed with a note, fenced on the current epoch (registration/advance path).
 *  Disarms any cron a member armed before the dispatch failed (D6) — the same reap the scan path does. */
const finalizeFailed = (
  row: ChainRow,
  note: string,
): Effect.Effect<void, WorkflowError, ChainStore | DaprPublisherTag> =>
  Effect.gen(function* () {
    const saved = yield* saveFenced(row.epoch, {
      ...row,
      status: "finalized",
      outcome: "failed",
      lastStatus: "FAILED",
      note,
      endedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (saved) yield* disarmStageCrons(row, row.cursor);
  });

// ---------------------------------------------------------------------------
// Cost tally — sum over the run mirrors of every workflow instance the chain ran
// ---------------------------------------------------------------------------

/**
 * A chain's cost is every member's cost: sum costUsd over run mirrors grouping under any instanceId of
 * a member whose stage the chain has reached (stage ≤ cursor; a shared instanceId, e.g. feature+revise,
 * is counted once via the set). Zero matching records is a LEDGER GAP — flagged, never a silent $0
 * (the watch tally's rule). Since cost-containment B3 the gap is also PER-RUN (an agent-run mirror
 * with costUsd 0/null counts as a gap; `kind: "activity"` records excluded), and per-agent
 * subtotals feed the chain ledger — mirroring watch-scan's tallyCost.
 */
export const tallyChainCost = (
  row: ChainRow,
): Effect.Effect<
  { costUsd: number; costGap: boolean; gapRuns: number; costByAgent: Record<string, number> },
  WorkflowError,
  ChainStore
> =>
  Effect.gen(function* () {
    const cs = yield* ChainStore;
    const ran = new Set<string>();
    for (let i = 0; i < row.members.length; i++) {
      if (stageOf(row.members, i) <= row.cursor) ran.add(instanceIdAt(row.chainId, row.members, i));
    }
    const keys = yield* cs.listRunKeys();
    const mine = keys.filter((key) => [...ran].some((id) => key.startsWith(`run:${id}:`)));
    if (mine.length === 0) return { costUsd: 0, costGap: true, gapRuns: 0, costByAgent: {} };
    let cost = 0;
    let gapRuns = 0;
    const costByAgent: Record<string, number> = {};
    for (const key of mine) {
      const meta = yield* cs.getRunMeta(key);
      if (meta === null || meta.kind === "activity") continue;
      if (typeof meta.costUsd === "number" && meta.costUsd > 0) {
        cost += meta.costUsd;
        const agent = meta.agentId ?? "(unknown)";
        costByAgent[agent] =
          Math.round(((costByAgent[agent] ?? 0) + meta.costUsd) * 10_000) / 10_000;
      } else {
        gapRuns += 1;
      }
    }
    return {
      costUsd: Math.round(cost * 10_000) / 10_000,
      costGap: gapRuns > 0,
      gapRuns,
      costByAgent,
    };
  });

// ---------------------------------------------------------------------------
// Disarm (operator-initiated deactivation — mirrors disarmCron in cron-scan.ts)
// ---------------------------------------------------------------------------

export type DisarmChainError = { readonly _tag: "NotFound" } | WorkflowError;

export const disarmChain = (
  chainId: string,
): Effect.Effect<ChainRow, DisarmChainError, ChainStore> =>
  Effect.gen(function* () {
    const cs = yield* ChainStore;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const existing = yield* cs.getRow(chainId);
    if (Option.isNone(existing)) return yield* Effect.fail<DisarmChainError>({ _tag: "NotFound" });
    const row = existing.value;
    // idempotent: any terminal chain state — mirrors disarmCron's status check
    if (row.status === "finalized") return row;
    const disarmed: ChainRow = {
      ...row,
      epoch: row.epoch + 1,
      status: "finalized",
      outcome: "disarmed",
      note: "disarmed by operator",
      endedAt: now,
      updatedAt: now,
    };
    const saved = yield* saveFenced(row.epoch, disarmed);
    if (!saved)
      return yield* Effect.fail<DisarmChainError>(
        new WorkflowError({ cause: "concurrent modification, retry", instanceId: chainId }),
      );
    yield* cs.bumpLedger(chainLedgerDate(nowMs), { chainsFinalized: 1 });
    return disarmed;
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
    case "unfulfilled":
      return "UNFULFILLED";
    case "terminated":
    case "budget-terminated":
      return "TERMINATED";
    case "orphaned":
      return "UNKNOWN";
    case "disarmed":
      return "DISARMED";
  }
}

/** Issue #91: check stage 0's required inputs against the chain data before firing.
 *  Returns one error message per member that throws ChainThreadError from buildParams.
 *  Propagates all other exceptions (real programming/runtime errors). */
function checkStage0Inputs(row: ChainRow): string[] {
  const messages: string[] = [];
  for (const i of membersInStage(row.members, 0)) {
    const member = row.members[i];
    if (!member) continue;
    try {
      contractFor(member).buildParams(row.data);
    } catch (err) {
      if (err instanceof ChainThreadError) {
        messages.push(err.message);
      } else {
        throw err;
      }
    }
  }
  return messages;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string") return cause;
  return String(err);
}
