import { createHash } from "node:crypto";

import { Cause, Clock, Effect } from "effect";
import { contractFor, lastStage, loopIsClean, membersInStage } from "workflow-core";
import type { ChainData } from "workflow-core";

import { runWorkflow } from "./execute.ts";
import type {
  ChainEnvelope,
  ChainJob,
  ChainMemberRun,
  JournalRecord,
  LocalChainMember,
} from "./models.ts";
import { AgentPort, JournalPort, ProgressPort, WorkspacePort } from "./ports.ts";
import type { CronStore, ExecPolicyStore, QuotaStore, WfStore, WorkflowStore } from "engine-core";

/**
 * Run a chain in-process: ordered members, grouped into stages, threading state between them.
 *
 * The SEMANTICS are shared with the durable engine and imported, not reimplemented — how members
 * group into stages (`membersInStage`/`lastStage`), how a member's declared or coded contract
 * builds its params and captures its output (`contractFor`), and when a loop is clean
 * (`loopIsClean`). What is NOT shared is the engine: `chain-engine.ts`'s `decide` is a per-tick
 * state machine over a durable row, and most of it — epoch fences, unknown-status streaks, orphan
 * detection — exists because the runs it sequences outlive the process watching them. Here the
 * driver awaits the stage, so the loop below IS the engine.
 *
 * The WALL-CLOCK BUDGET is the exception, and is mirrored rather than dropped: it needs no
 * durability, only a deadline, and the driver being the supervisor is precisely what lets it own
 * one. The guarantee is weaker than the engine's by one step — the engine terminates a RUNNING
 * instance mid-flight, while here the deadline is checked BETWEEN stages, so an overrunning agent
 * is still bounded only by the per-step timeout. A budget that trips reports `exhausted`, the same
 * status the iteration budget uses: stopped early on purpose, not failed. (The per-MEMBER budget
 * is a different animal — a watch policy a separate engine services — and the CLI refuses it here
 * by name.)
 *
 * THE JOURNAL is what survives this process: with `job.journal` set, every completed stage
 * publishes its post-capture chain data to the fabric's `h-journal` stream (the append's ACK is
 * the completion barrier — a stage whose record cannot land durably fails the chain rather than
 * reporting resumable-from), and `resume` replays those records to continue a dead run at its
 * cursor instead of re-paying finished stages. Only `completed` writes a terminal record: a
 * failed or budget-exhausted run is precisely the one worth resuming.
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
): Effect.Effect<
  ChainEnvelope,
  never,
  | AgentPort
  | WorkspacePort
  | ProgressPort
  | JournalPort
  | ExecPolicyStore
  | QuotaStore
  | WfStore
  | CronStore
  | WorkflowStore
> =>
  Effect.gen(function* () {
    const progress = yield* ProgressPort;
    const journal = yield* JournalPort;
    const data: ChainData = { ...job.data };
    const runs: ChainMemberRun[] = [];
    const last = lastStage(job.members);
    const loop = job.strategy === "loop-until-clean" ? job.loop : undefined;
    let iterations = 0;
    let seq = 1;
    let alreadyTerminal = false;

    const jc = job.journal;
    const hash = jc ? definitionHash(job) : "";
    const journalKey = jc?.group ?? job.group;

    // An ABSOLUTE deadline, stamped once, so a loop-until-clean chain is bounded as a whole rather
    // than per iteration. Clock rather than Date.now() so a test can drive it. A RESUMED run
    // stamps its own — the budget bounds this process's work, not the group's lifetime spend.
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = job.budgetMs === undefined ? undefined : startedAt + job.budgetMs;

    const outcome = yield* Effect.gen(function* () {
      let cursor = 0;

      if (jc?.resume) {
        const records = yield* journal.replay(jc.url, journalKey);
        const meta = records.find((record) => record.type === "meta");
        if (!meta) {
          return yield* Effect.fail(
            new Error(
              `no journal for group '${job.group}' — nothing to resume (was it run with ` +
                "--no-journal, or has the record aged out of the stream?)",
            ),
          );
        }
        if (meta.definitionHash !== hash) {
          return yield* Effect.fail(
            new Error(
              "the composition differs from the journaled run — a changed chain is a NEW " +
                "run, so re-fire without --resume",
            ),
          );
        }
        const stages = records.filter(
          (record): record is Extract<JournalRecord, { type: "stage" }> => record.type === "stage",
        );
        seq = (records.at(-1)?.seq ?? 0) + 1;
        for (const stage of stages) runs.push(...stage.runs);
        const lastRecord = stages.at(-1);
        if (lastRecord) Object.assign(data, lastRecord.data);
        if (records.some((record) => record.type === "terminal")) {
          alreadyTerminal = true;
          return {
            status: "completed" as const,
            note: "journal shows this run already completed — nothing to resume",
          };
        }
        if (lastRecord) {
          if (loop && lastRecord.cursor === last) {
            if (lastRecord.iteration + 1 >= loop.maxIterations) {
              return {
                status: "exhausted" as const,
                note: `journal shows the iteration budget (${loop.maxIterations}) already spent`,
              };
            }
            iterations = lastRecord.iteration + 1;
            cursor = loop.startCursor;
          } else {
            iterations = lastRecord.iteration;
            cursor = lastRecord.cursor + 1;
          }
        }
        yield* progress.emit(
          `↻ resuming '${job.group}': ${stages.length} stage(s) journaled — continuing at ` +
            `stage ${cursor}${loop ? `, iteration ${iterations}` : ""}`,
        );
      } else if (jc) {
        yield* journal.append(jc.url, journalKey, {
          seq: 0,
          type: "meta",
          kind: "chain",
          definitionHash: hash,
          group: job.group,
          ts: yield* Clock.currentTimeMillis,
        });
      }

      while (cursor <= last) {
        // Checked BEFORE firing a stage, never mid-stage: the driver can decline to start more
        // work, but it cannot terminate an agent already running (that is the per-step timeout's
        // job). So a budget bounds what the chain STARTS, and the note says which stage it stopped
        // short of rather than implying the chain was killed at the deadline.
        if (deadline !== undefined && (yield* Clock.currentTimeMillis) >= deadline) {
          yield* progress.emit(`⏱ chain budget exceeded — stopping before stage ${cursor}`);
          return {
            status: "exhausted" as const,
            note: `chain budget ${job.budgetMs}ms exceeded — stopped before stage ${cursor} of ${last}`,
          };
        }

        const indices = membersInStage(job.members, cursor);
        yield* progress.emit(
          `▸ stage ${cursor}/${last}: ${indices.map((i) => label(job.members[i]!)).join(" ∥ ")}`,
        );

        const outputs = yield* Effect.all(
          indices.map((index) => runMember(job, index, data, iterations)),
          { concurrency: "unbounded" },
        );

        const stageRuns: ChainMemberRun[] = indices.map((index, slot) => ({
          member: label(job.members[index]!),
          stage: cursor,
          group: outputs[slot]!.group,
          iteration: iterations,
        }));
        runs.push(...stageRuns);

        // Capture every member of the stage before advancing, so a downstream member reads a
        // complete stage. A declared capture namespaces under the member's id (concurrent members
        // never clobber); an undeclared one uses its kind's coded contract.
        for (const [slot, index] of indices.entries()) {
          const member = job.members[index]!;
          contractFor(member).capture(outputs[slot]!.output, data);
        }

        // The stage is durable only once this ACKs — written after capture so the record carries
        // the complete post-capture data, and before the loop decisions so every continuation
        // path resumes from it. Death between capture and ack redoes exactly this stage.
        if (jc) {
          yield* journal.append(jc.url, journalKey, {
            seq,
            type: "stage",
            cursor,
            iteration: iterations,
            data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
            runs: stageRuns,
            ts: yield* Clock.currentTimeMillis,
          });
          seq += 1;
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

    // Terminal record ONLY on completed (and only once): failed and exhausted runs are exactly
    // the ones --resume exists for, so their journals stay open.
    if (jc && outcome.status === "completed" && !alreadyTerminal) {
      yield* journal
        .append(jc.url, journalKey, {
          seq,
          type: "terminal",
          status: "completed",
          ...(outcome.note ? { note: outcome.note } : {}),
          ts: yield* Clock.currentTimeMillis,
        })
        .pipe(
          // The chain IS complete; a lost terminal record only costs a future resume its no-op
          // answer. Report the miss, keep the completion.
          Effect.catchAll((error) =>
            progress.emit(`⚠ terminal journal record failed: ${error.message}`),
          ),
        );
    }

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
 * What identifies a composition for resume: the members (steps, params, threading), the strategy,
 * and the loop. Deliberately NOT the budget or timeouts — a resumed run may re-budget freely;
 * it may not quietly run different work under a journaled group's name.
 */
const definitionHash = (job: ChainJob): string =>
  createHash("sha256")
    .update(
      JSON.stringify({ members: job.members, strategy: job.strategy, loop: job.loop ?? null }),
    )
    .digest("hex");

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
  | AgentPort
  | WorkspacePort
  | ProgressPort
  | JournalPort
  | ExecPolicyStore
  | QuotaStore
  | WfStore
  | CronStore
  | WorkflowStore
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
      ...(job.quota ? { quota: job.quota } : {}),
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
