import { join } from "node:path";

import { Cause, Effect } from "effect";
import { applyOutputContract, resolveRefs, resolveTokenString } from "workflow-core";
import type { AgentResult, StepDefinition, WorkflowStep } from "workflow-core";

import { classifyActivity, RefusedActivityError } from "./activities.ts";
import type { WorkflowEnvelope, WorkflowJob, WorkflowRunRef } from "./models.ts";
import { AgentPort, ProgressPort, WorkspacePort } from "./ports.ts";

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
 */
export const runWorkflow = (
  job: WorkflowJob,
): Effect.Effect<WorkflowEnvelope, never, AgentPort | WorkspacePort | ProgressPort> =>
  Effect.gen(function* () {
    const progress = yield* ProgressPort;
    const results: Record<string, unknown> = { params: job.params ?? {} };
    // Accumulated as steps run, so the envelope reports the runs of a FAILED job too — the
    // accounting must survive the failure that makes it most interesting.
    const runs: WorkflowRunRef[] = [];

    const run = Effect.gen(function* () {
      for (const step of job.steps) {
        if ("parallel" in step) {
          // Branches resolve against the results map as it stood BEFORE the group — which is what
          // makes them parallelizable — then all run at once. Any branch failing fails the group.
          const before = { ...results };
          const outs = yield* Effect.all(
            step.parallel.map((branch) => runStep(branch, before, job, progress, runs)),
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
        results[stepId(step)] = yield* runStep(step, results, job, progress, runs);
      }
    });

    return yield* run.pipe(
      Effect.map(() => ({ ok: true, group: job.group, results, runs }) satisfies WorkflowEnvelope),
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
  });

const runStep = (
  step: StepDefinition,
  results: Record<string, unknown>,
  job: WorkflowJob,
  progress: { readonly emit: (line: string) => Effect.Effect<void> },
  runs: WorkflowRunRef[],
): Effect.Effect<unknown, StepError, AgentPort | WorkspacePort> =>
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
        new StepError(id, new RefusedActivityError(activity, classified.reason).message),
      );
    }

    if (classified.kind === "builtin") {
      const workspace = yield* WorkspacePort;
      if (classified.name === "create-worktree") {
        const key = str(input.workspaceId) ?? str(input.workflowInstanceId) ?? job.group;
        const baseRef = str(input.baseRef);
        const worktreePath = yield* workspace
          .prepare({
            // A step's own clonePath wins (the multi-repo knob); otherwise the checkout the
            // operator invoked from — local execution has no pre-cloned shared workspace.
            repoPath: str(input.clonePath) ?? job.repoPath,
            worktreePath: join(job.worktreeRoot, key),
            branch: str(input.branch),
            baseRef,
            // Refresh from origin/main by default so the worktree starts at the remote tip; a
            // pinned baseRef wins, and an explicit "" opts out (branch from local HEAD).
            remoteBase: baseRef
              ? undefined
              : typeof input.remoteBase === "string"
                ? str(input.remoteBase)
                : "main",
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
