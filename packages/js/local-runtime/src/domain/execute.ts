import { createHash } from "node:crypto";
import { join } from "node:path";

import { Cause, Clock, Effect, Either } from "effect";
import { applyOutputContract, resolveRefs, resolveTokenString } from "workflow-core";
import type { AgentResult, StepDefinition, WorkflowStep } from "workflow-core";

import { classifyActivity, RefusedActivityError } from "./activities.ts";
import { assertExecutorAllowed } from "./policy.ts";
import type { ExecPolicyStore, WfStatus } from "engine-core";
import {
  CronStore,
  goalResolved,
  planCron,
  registerCronForFire,
  WfStore,
  WorkflowStore,
} from "engine-core";
import type {
  CheckoutSpec,
  JournalRecord,
  WorkflowEnvelope,
  WorkflowJob,
  WorkflowRunRef,
} from "./models.ts";
import { AgentPort, JournalPort, ProgressPort, WorkspacePort } from "./ports.ts";

/** A step did not produce a result. Carries the step id so the envelope can name the failure. */
export class StepError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = "StepError";
  }
}

const str = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // Templates emit "" for a slot that was deliberately cleared (e.g. a baked model stripped when
  // the executor changed), so blank means UNSET here exactly as it does engine-side.
  return trimmed === "" ? undefined : value;
};

const stepId = (step: StepDefinition): string => step.id ?? step.activity;

/**
 * A `create-worktree` step's `checkout` input → the strategy to cut with. The in-process mirror of
 * the agent service's `/worktree` defaulting, so a definition means the same thing on both
 * substrates: absent = the bare branch strategy, and a branch strategy with no pinned `baseRef`
 * refreshes from `origin/main` (an explicit "" opts out and branches from local HEAD).
 */
const checkoutFromInput = (input: Record<string, unknown>): CheckoutSpec => {
  const raw = (input.checkout ?? {}) as Record<string, unknown>;
  if (raw.kind === "detached") {
    const fetch = raw.fetch as { remoteRef?: unknown; depth?: unknown } | undefined;
    const remoteRef = str(fetch?.remoteRef);
    return {
      kind: "detached",
      ref: str(raw.ref) ?? "HEAD",
      ...(remoteRef
        ? {
            fetch: {
              remoteRef,
              ...(typeof fetch?.depth === "number" ? { depth: fetch.depth } : {}),
            },
          }
        : {}),
    };
  }
  const baseRef = str(raw.baseRef);
  return {
    kind: "branch",
    branch: str(raw.branch),
    baseRef,
    remoteBase: baseRef
      ? undefined
      : typeof raw.remoteBase === "string"
        ? str(raw.remoteBase)
        : "main",
  };
};

/**
 * Execute a workflow definition in-process.
 *
 * A deliberate mirror of workflow-svc's `genericWorkflow`, reading its semantics from the same
 * `workflow-core` module rather than reimplementing them: params seeded under the reserved id
 * `params`, `{{token}}`/`$ref` resolution against the accumulated results, the activity NAME
 * itself resolvable (fire-time identity), parallel groups fanned out against pre-group results
 * and landing under branch ids plus a `{branchId: result}` map under the group id.
 *
 * What it does NOT mirror is the engine's brackets — the `write-wf-row` status row and the
 * `armCron` closing bracket. Those write registries this substrate does not have, and the
 * activities behind them are refused by name rather than quietly skipped.
 *
 * THE JOURNAL (step granularity): with `job.journal` set, every completed step — and every
 * completed BRANCH of a parallel group, individually, so a panel that dies mid-fan-out re-pays
 * only its unfinished branches — publishes its result to the fabric, and `resume` replays those
 * records to skip completed steps with their results reloaded. Appends from concurrent branches
 * are serialized behind one permit so seqs stay monotonic; the group's own map entry is
 * reconstructed from its branches rather than journaled. Only `completed` writes a terminal.
 */
export const runWorkflow = (
  job: WorkflowJob,
): Effect.Effect<
  WorkflowEnvelope,
  never,
  | AgentPort
  | WorkspacePort
  | ProgressPort
  | JournalPort
  | ExecPolicyStore
  | WfStore
  | CronStore
  | WorkflowStore
> =>
  Effect.gen(function* () {
    const progress = yield* ProgressPort;
    const journal = yield* JournalPort;
    const results: Record<string, unknown> = { params: job.params ?? {} };
    // Accumulated as steps run, so the envelope reports the runs of a FAILED job too — the
    // accounting must survive the failure that makes it most interesting.
    const runs: WorkflowRunRef[] = [];
    const jc = job.journal;
    const hash = jc ? definitionHash(job) : "";
    const journalKey = jc?.group ?? job.group;
    /** Journaled results by step id, restored on resume; consulted before every step/branch. */
    const done = new Map<string, unknown>();
    let alreadyTerminal = false;
    let note: string | undefined;

    // Concurrent branches complete in any order; the permit keeps seq assignment + publish
    // atomic, so the stream's `<group>:<seq>` identities stay monotonic and collision-free.
    const appendLock = yield* Effect.makeSemaphore(1);
    let seq = 1;
    const appendStep = (id: string, result: unknown) =>
      jc === undefined
        ? Effect.void
        : appendLock.withPermits(1)(
            Effect.gen(function* () {
              yield* journal.append(jc.url, journalKey, {
                seq,
                type: "step",
                stepId: id,
                result,
                ts: yield* Clock.currentTimeMillis,
              });
              seq += 1;
            }),
          );

    // A step already journaled replays its result; one that is not runs and then journals —
    // the append's ACK is the completion barrier, so its failure fails the step.
    const journaled = (
      step: StepDefinition,
      execute: Effect.Effect<unknown, StepError, AgentPort | WorkspacePort | ExecPolicyStore>,
    ): Effect.Effect<unknown, StepError, AgentPort | WorkspacePort | ExecPolicyStore> => {
      const id = stepId(step);
      if (done.has(id)) {
        return progress.emit(`↟ ${id}: from journal`).pipe(Effect.map(() => done.get(id)));
      }
      return execute.pipe(
        Effect.tap((result) =>
          appendStep(id, result).pipe(Effect.mapError((err) => new StepError(id, err.message))),
        ),
      );
    };

    const run = Effect.gen(function* () {
      if (jc?.resume) {
        const records = yield* journal
          .replay(jc.url, journalKey)
          .pipe(Effect.mapError((err) => new StepError("journal", err.message)));
        const meta = records.find((record) => record.type === "meta");
        if (!meta) {
          return yield* Effect.fail(
            new StepError(
              "journal",
              `no journal for group '${job.group}' — nothing to resume (was it run with ` +
                "--no-journal, or has the record aged out of the stream?)",
            ),
          );
        }
        if (meta.definitionHash !== hash) {
          return yield* Effect.fail(
            new StepError(
              "journal",
              "the composition differs from the journaled run — a changed workflow is a NEW " +
                "run, so re-fire without --resume",
            ),
          );
        }
        const steps = records.filter(
          (record): record is Extract<JournalRecord, { type: "step" }> => record.type === "step",
        );
        for (const record of steps) done.set(record.stepId, record.result);
        seq = (records.at(-1)?.seq ?? 0) + 1;
        if (records.some((record) => record.type === "terminal")) {
          alreadyTerminal = true;
          note = "journal shows this run already completed — nothing to resume";
        }
        yield* progress.emit(
          `↻ resuming '${job.group}': ${steps.length} step(s) journaled` +
            (alreadyTerminal ? " (already completed)" : ""),
        );
      } else if (jc) {
        yield* journal
          .append(jc.url, journalKey, {
            seq: 0,
            type: "meta",
            kind: "workflow",
            definitionHash: hash,
            group: job.group,
            ts: yield* Clock.currentTimeMillis,
          })
          .pipe(Effect.mapError((err) => new StepError("journal", err.message)));
      }

      // An ABSOLUTE deadline, stamped once before the first step. Clock rather than Date.now() so
      // a test can drive it.
      const deadline =
        job.budgetMs === undefined ? undefined : (yield* Clock.currentTimeMillis) + job.budgetMs;

      for (const step of job.steps) {
        // Checked BEFORE starting a step, never mid-step: the driver can decline to start more
        // work, but it cannot stop an agent already running (the per-step timeout bounds that).
        // So the note says which step it stopped SHORT OF rather than implying a kill.
        if (deadline !== undefined && (yield* Clock.currentTimeMillis) >= deadline) {
          const label = "parallel" in step ? (step.id ?? "parallel group") : stepId(step);
          note = `run budget ${job.budgetMs}ms exceeded — stopped before step '${label}'`;
          yield* progress.emit(`⏱ ${note}`);
          break;
        }
        if ("parallel" in step) {
          // Branches resolve against the results map as it stood BEFORE the group — which is what
          // makes them parallelizable — then all run at once. Any branch failing fails the group.
          // Journal-completed branches replay individually, so only the unfinished ones re-run.
          const before = { ...results };
          const outs = yield* Effect.all(
            step.parallel.map((branch) =>
              journaled(branch, runStep(branch, before, job, progress, runs)),
            ),
            { concurrency: "unbounded" },
          );
          step.parallel.forEach((branch, index) => {
            results[stepId(branch)] = outs[index];
          });
          if (step.id) {
            results[step.id] = Object.fromEntries(
              step.parallel.map((branch, index) => [stepId(branch), outs[index]]),
            );
          }
          continue;
        }
        results[stepId(step)] = yield* journaled(step, runStep(step, results, job, progress, runs));
      }
    });

    // The wf:run BRACKET — the local mirror of generic.workflow's. A run reports its own status,
    // `running` before its steps and `done`/`failed` after, so an ENGINE can ask what became of a
    // run it fired. On the service substrate that answer comes from Dapr; here the row IS the
    // answer, which is why the registry had to stop being artifact-keyed first.
    //
    // Best-effort in both directions, exactly like the activity it mirrors: a registry hiccup must
    // never fail a run that did its work. A missed write leaves the row stale, and staleness is a
    // READ concern — the invoker ages a `running` row into UNKNOWN so the engines' existing escape
    // owns it, rather than a lost write silently pinning a cron forever.
    yield* writeWfRow(job, "running", undefined, false).pipe(Effect.ignore);

    let envelope = yield* run.pipe(
      Effect.map(
        () =>
          ({
            ok: true,
            group: job.group,
            results,
            runs,
            ...(note ? { note } : {}),
          }) satisfies WorkflowEnvelope,
      ),
      // Every exit path answers with an envelope, so a caller never has to reconstruct what
      // happened from an exit code — and the results map up to the failure is preserved.
      Effect.catchAllCause((cause) => {
        const error = Cause.squash(cause);
        return Effect.succeed({
          ok: false,
          group: job.group,
          results,
          runs,
          ...(error instanceof StepError ? { failedStep: error.step } : {}),
          error: error instanceof Error ? error.message : String(error),
        } satisfies WorkflowEnvelope);
      }),
    );

    // §10 closing bracket: a run that carries an armCron registers its OWN recurrence AFTER the
    // work. LOUD, unlike the wf: row — the cron IS the point of the flag, so a failed arm must fail
    // the run rather than report a recurrence that was never armed. Skipped on a failed run: arming
    // a loop off work that did not succeed claims a recurrence with nothing to recur.
    // A failed arm turns the envelope FAILED rather than throwing: the run's work is already done
    // and its results are worth reporting, but a `--cron` that did not arm must not read as success.
    const arm = envelope.ok
      ? yield* armCron(job).pipe(Effect.either)
      : Either.right(undefined as string | undefined);
    if (Either.isRight(arm)) {
      if (arm.right !== undefined) yield* progress.emit(arm.right);
    } else {
      envelope = { ...envelope, ok: false, error: arm.left.message, failedStep: "arm-cron" };
      yield* progress.emit(`✗ cron not armed: ${arm.left.message}`);
    }

    yield* writeWfRow(
      job,
      envelope.ok ? "done" : "failed",
      JSON.stringify(envelope.results),
      // The goal handshake, from the SAME function the Dapr engine uses — a second copy would let
      // one substrate keep recurring while the other stopped.
      goalResolved(results),
    ).pipe(Effect.ignore);

    // Terminal record ONLY on success (and only once): a failed run is exactly the one --resume
    // exists for, so its journal stays open. A lost terminal costs a future resume its no-op
    // answer, not the completion — report and keep going.
    if (jc && envelope.ok && !alreadyTerminal) {
      yield* appendLock.withPermits(1)(
        journal
          .append(jc.url, journalKey, {
            seq,
            type: "terminal",
            status: "completed",
            ts: yield* Clock.currentTimeMillis,
          })
          .pipe(
            Effect.catchAll((error) =>
              progress.emit(`⚠ terminal journal record failed: ${error.message}`),
            ),
          ),
      );
    }
    return envelope;
  });

/**
 * What identifies a workflow composition for resume: the steps alone. Params are fire-time data
 * (the chain-seed rule): a resumed run may re-parameterize its REMAINING steps deliberately —
 * completed steps' results come off the journal either way.
 */
const definitionHash = (job: WorkflowJob): string =>
  createHash("sha256")
    .update(JSON.stringify({ steps: job.steps }))
    .digest("hex");

const runStep = (
  step: StepDefinition,
  results: Record<string, unknown>,
  job: WorkflowJob,
  progress: { readonly emit: (line: string) => Effect.Effect<void> },
  runs: WorkflowRunRef[],
): Effect.Effect<unknown, StepError, AgentPort | WorkspacePort | ExecPolicyStore> =>
  Effect.gen(function* () {
    const id = stepId(step);
    // The activity NAME may itself be a token (`{{params.runActivity}}` — fire-time identity).
    // An unresolved one throws rather than collapsing to "", exactly as engine-side.
    const activity = resolveTokenString(step.activity, results);
    const input = resolveRefs(
      {
        ...step.input,
        workflowInstanceId: job.group,
        workspaceId: job.group,
      },
      results,
    );
    const classified = classifyActivity(activity);

    if (classified.kind === "refused") {
      return yield* Effect.fail(
        new StepError(
          id,
          new RefusedActivityError(activity, classified.reason, classified.why).message,
        ),
      );
    }

    if (classified.kind === "builtin") {
      const workspace = yield* WorkspacePort;
      if (classified.name === "create-worktree") {
        const key = str(input.workspaceId) ?? str(input.workflowInstanceId) ?? job.group;
        const worktreePath = yield* workspace
          .prepare({
            // A step's own clonePath wins (the multi-repo knob); otherwise the checkout the
            // operator invoked from — local execution has no pre-cloned shared workspace.
            repoPath: str(input.clonePath) ?? job.repoPath,
            worktreePath: join(job.worktreeRoot, key),
            checkout: checkoutFromInput(input),
          })
          .pipe(Effect.mapError((err) => new StepError(id, err.message)));
        yield* progress.emit(`⎇ ${id}: ${worktreePath}`);
        return { worktreePath };
      }

      // setup: skipped unless asked for. A template's setup installs h skills into ~/.claude,
      // which on this substrate is the OPERATOR's own configuration — see the plan's D4.
      const commands = Array.isArray(input.setup)
        ? (input.setup as ReadonlyArray<{ cmd: string; validateCmd?: string }>)
        : [];
      if (!job.withSetup) {
        yield* progress.emit(
          `⊘ ${id}: skipped ${commands.length} setup command(s) — they provision the operator's ` +
            "own HOME on this substrate. Pass --with-setup to run them.",
        );
        return { skipped: "setup is opt-in on the local substrate (--with-setup)" };
      }
      yield* workspace
        .provision(job.repoPath, commands)
        .pipe(Effect.mapError((err) => new StepError(id, err.message)));
      yield* progress.emit(`⚙ ${id}: ran ${commands.length} setup command(s)`);
      return { provisioned: commands.length };
    }

    // The executor-policy fence, before anything is spent. Same decision function as the service
    // substrate's activity gate, so `h agents deny` means one thing on both.
    yield* assertExecutorAllowed(classified.agent, new Date().toISOString()).pipe(
      Effect.mapError((err) => new StepError(id, err.message)),
    );

    const agent = yield* AgentPort;
    const cwd = str(input.cwd) ?? job.repoPath;
    yield* progress.emit(`→ ${id}: ${classified.agent} in ${cwd}`);
    const report = yield* agent.run({
      agent: classified.agent,
      task: typeof input.task === "string" ? input.task : "",
      cwd,
      timeoutMs: job.timeoutMs,
      model: str(input.model),
      permissionMode: input.permissionMode === "plan" ? "plan" : undefined,
      runsDir: job.runsDir,
      group: job.group,
    });
    // Recorded BEFORE the failure check: a failed run is exactly the one whose cost and runId a
    // caller most needs, and the ledger entry exists either way.
    runs.push({
      step: id,
      agent: classified.agent,
      ...(report.runId === undefined ? {} : { runId: report.runId }),
      ...(report.costUsd === undefined ? {} : { costUsd: report.costUsd }),
    });
    if (report.status === "failed") {
      yield* progress.emit(`✗ ${id}: ${report.error ?? "failed"}`);
      return yield* Effect.fail(new StepError(id, report.error ?? `${classified.agent} failed`));
    }
    const seconds = (report.durationMs / 1000).toFixed(1);
    const cost = report.costUsd === undefined ? "cost unknown" : `$${report.costUsd.toFixed(4)}`;
    yield* progress.emit(`✓ ${id}: ${classified.agent} in ${seconds}s (${cost})`);

    const result: AgentResult = { sessionId: report.sessionId ?? null, output: report.output };
    // The output contract is enforced HERE because AgentPort is contract-agnostic; engine-side the
    // run-* activity does it. Same `workflow-core` validator either way, and the same consequence:
    // a missing or mismatching fenced block FAILS THE STEP rather than passing prose downstream.
    return yield* Effect.try({
      try: () => applyOutputContract(result, input.outputContract),
      catch: (cause) => new StepError(id, cause instanceof Error ? cause.message : String(cause)),
    });
  }).pipe(
    Effect.catchAllDefect((defect) =>
      // resolveTokenString and classifyActivity throw (they are shared, dependency-free code);
      // a defect here is a definition problem, so it must read as this step's failure.
      Effect.fail(
        new StepError(stepId(step), defect instanceof Error ? defect.message : String(defect)),
      ),
    ),
  );

/** Re-exported so `WorkflowStep` consumers do not need a second import of workflow-core. */
export type { WorkflowStep };

/**
 * One end of the `wf:run:<instanceId>` bracket. The run's instanceId is its GROUP — the same key
 * that names its workspace, its ledger entry and its worktree — so an engine that fired under a
 * chosen id can read back what happened without any further mapping.
 *
 * Writes nothing when the job carries no `wf` block: a plain `h workflow run --local` has no engine
 * waiting on it, and a row nobody reads is just growth.
 */
const writeWfRow = (
  job: WorkflowJob,
  status: WfStatus,
  output: string | undefined,
  resolved: boolean,
): Effect.Effect<void, unknown, WfStore> =>
  job.wf === undefined
    ? Effect.void
    : Effect.gen(function* () {
        const store = yield* WfStore;
        yield* store.saveRow({
          instanceId: job.group,
          status,
          ...job.wf,
          ...job.parent,
          ...(job.params ? { subject: job.params } : {}),
          ...(output === undefined ? {} : { output }),
          ...(resolved ? { resolved } : {}),
          updatedAt: new Date().toISOString(),
        });
      });

/**
 * Arm this run's follow-on recurrence, mirroring generic.workflow's closing bracket.
 *
 * The DECISION is `engine-core`'s `planCron` — shared with the Dapr engine, so the arm-at-birth
 * guard (only arm a revise-pr loop if a PR actually opened) answers identically on both substrates.
 * A no-op plan is a valid outcome, not a failure: "no PR opened" is a reason, not an error.
 *
 * Returns the progress line, or undefined when there is nothing to arm.
 */
const armCron = (
  job: WorkflowJob,
): Effect.Effect<string | undefined, StepError, CronStore | WorkflowStore> =>
  job.armCron === undefined
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        const params = (job.params ?? {}) as Record<string, unknown>;
        const plan = planCron({
          workflow: job.armCron!.workflow,
          repo: String(params.repo ?? ""),
          slug: String(params.slug ?? ""),
          cadence: job.armCron!.cadence,
          ...(job.armCron!.maxFires === undefined ? {} : { maxFires: job.armCron!.maxFires }),
          params,
          instanceId: job.group,
          ...(job.armCron!.inline ? { inline: true, steps: job.steps } : {}),
          workspaceId: job.group,
        });
        if (!plan.armed) return `⊘ cron not armed: ${plan.reason}`;
        const result = yield* registerCronForFire(plan.registration).pipe(
          Effect.mapError((error) => new StepError("arm-cron", error.message ?? String(error))),
        );
        return `⟳ cron armed: ${result.cronId} (${job.armCron!.cadence})`;
      });
