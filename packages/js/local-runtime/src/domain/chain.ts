import { Cause, Effect } from "effect";
import { contractFor, lastStage, loopIsClean, membersInStage } from "workflow-core";
import type { ChainData } from "workflow-core";

import { runWorkflow } from "./execute.ts";
import type { ChainEnvelope, ChainJob, ChainMemberRun, LocalChainMember } from "./models.ts";
import { AgentPort, ProgressPort, WorkspacePort } from "./ports.ts";

/**
 * Run a chain in-process: ordered members, grouped into stages, threading state between them.
 *
 * The SEMANTICS are shared with the durable engine and imported, not reimplemented — how members
 * group into stages (`membersInStage`/`lastStage`), how a member's declared or coded contract
 * builds its params and captures its output (`contractFor`), and when a loop is clean
 * (`loopIsClean`). What is NOT shared is the engine: `chain-engine.ts`'s `decide` is a per-tick
 * state machine over a durable row, and every part of it — epoch fences, unknown-status streaks,
 * orphan detection, wall-clock budgets — exists because the runs it sequences outlive the process
 * watching them. Here the driver awaits the stage, so the loop below IS the engine.
 *
 * Two consequences worth naming rather than hiding:
 *  - **Atomic failure comes free.** A stage runs under one `Effect.all`, so a member failing
 *    interrupts its still-running siblings — the durable engine's D6 teardown, without the
 *    teardown, because there is nothing to leave behind.
 *  - **A member is an embedded definition.** There is no saved-workflow store on this substrate,
 *    so the CLI renders each member's template and sends its steps; `cron` members have no
 *    meaning here at all and the CLI refuses them before anything runs.
 */
export const runChain = (
  job: ChainJob,
): Effect.Effect<ChainEnvelope, never, AgentPort | WorkspacePort | ProgressPort> =>
  Effect.gen(function* () {
    const progress = yield* ProgressPort;
    const data: ChainData = { ...job.data };
    const runs: ChainMemberRun[] = [];
    const last = lastStage(job.members);
    const loop = job.strategy === "loop-until-clean" ? job.loop : undefined;
    let iterations = 0;

    const outcome = yield* Effect.gen(function* () {
      let cursor = 0;
      while (cursor <= last) {
        const indices = membersInStage(job.members, cursor);
        yield* progress.emit(
          `▸ stage ${cursor}/${last}: ${indices.map((i) => label(job.members[i]!)).join(" ∥ ")}`,
        );

        const outputs = yield* Effect.all(
          indices.map((index) => runMember(job, index, data, iterations)),
          { concurrency: "unbounded" },
        );

        indices.forEach((index, slot) => {
          runs.push({
            member: label(job.members[index]!),
            stage: cursor,
            group: outputs[slot]!.group,
            iteration: iterations,
          });
        });

        // Capture every member of the stage before advancing, so a downstream member reads a
        // complete stage. A declared capture namespaces under the member's id (concurrent members
        // never clobber); an undeclared one uses its kind's coded contract.
        for (const [slot, index] of indices.entries()) {
          const member = job.members[index]!;
          contractFor(member).capture(outputs[slot]!.output, data);
        }

        // loop-until-clean: the stage at `startCursor` is the review. Clean ⇒ the chain is done.
        if (loop && cursor === loop.startCursor) {
          const member = job.members[indices[0]!]!;
          if (loopIsClean(member, outputs[0]!.output)) {
            yield* progress.emit(`✓ clean after ${iterations} revise iteration(s)`);
            return { status: "completed" as const, note: `clean after ${iterations} iteration(s)` };
          }
        }

        // End of the chain. Without a loop that is completion; with one, the revise stage just
        // finished, so go back to the review stage until the iteration budget trips.
        if (cursor === last && loop) {
          if (iterations + 1 >= loop.maxIterations) {
            return {
              status: "exhausted" as const,
              note: `stopped after ${loop.maxIterations} iteration(s) (findings may remain)`,
            };
          }
          iterations += 1;
          yield* progress.emit(`↺ loop back to stage ${loop.startCursor}, iteration ${iterations}`);
          cursor = loop.startCursor;
          continue;
        }
        cursor += 1;
      }
      return { status: "completed" as const };
    }).pipe(
      Effect.catchAllCause((cause) => {
        const error = Cause.squash(cause);
        return Effect.succeed({
          status: "failed" as const,
          note: error instanceof Error ? error.message : String(error),
        });
      }),
    );

    return {
      ok: outcome.status === "completed",
      chain: job.group,
      status: outcome.status,
      ...(outcome.note ? { note: outcome.note } : {}),
      data,
      runs,
    } satisfies ChainEnvelope;
  });

const label = (member: LocalChainMember): string => member.id ?? member.kind;

/**
 * One member: build its params from the chain data through its contract, run its embedded
 * definition, and hand back the results as the JSON string the capture side expects.
 *
 * That string is deliberate: `stepStructured` unwraps the workflow OUTPUT the durable engine
 * produces (`JSON.stringify(results)`, re-encoded by Dapr), so serialising the results map here
 * feeds the SAME parser rather than a local-only shortcut around it.
 */
const runMember = (
  job: ChainJob,
  index: number,
  data: ChainData,
  iteration: number,
): Effect.Effect<
  { group: string; output: string },
  Error,
  AgentPort | WorkspacePort | ProgressPort
> =>
  Effect.gen(function* () {
    const member = job.members[index]!;
    // A missing required input throws ChainThreadError — a misconfigured chain must fail loud
    // rather than fire a member on a guess (e.g. reviewing a PR that was never opened).
    const params = yield* Effect.try({
      try: () => contractFor(member).buildParams(data),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });

    // Each member is its own run: its own ledger group and its own worktree slot. The iteration
    // suffix keeps a loop's re-runs distinct instead of overwriting the previous attempt's ledger.
    const suffix = iteration > 0 ? `-i${iteration}` : "";
    const group = `${job.group}-${label(member)}${suffix}`;
    const envelope = yield* runWorkflow({
      kind: "workflow",
      steps: member.steps,
      params: { ...member.params, ...params },
      group,
      runsDir: job.runsDir,
      timeoutMs: job.timeoutMs,
      worktreeRoot: job.worktreeRoot,
      repoPath: job.repoPath,
      ...(job.withSetup ? { withSetup: true } : {}),
    });
    if (!envelope.ok) {
      return yield* Effect.fail(
        new Error(
          `member '${label(member)}' failed` +
            (envelope.failedStep ? ` at step '${envelope.failedStep}'` : "") +
            `: ${envelope.error ?? "no detail"}`,
        ),
      );
    }
    return { group, output: JSON.stringify(envelope.results) };
  });
