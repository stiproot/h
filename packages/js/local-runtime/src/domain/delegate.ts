import { join } from "node:path";

import { Effect } from "effect";

import { resolveAgent, UnknownAgentError } from "./agents.ts";
import type {
  AgentRunReport,
  AgentRunRequest,
  DelegateEnvelope,
  DelegateJob,
  LocalAgentType,
} from "./models.ts";
import { AgentPort, ProgressPort, WorkspacePort, type WorkspaceError } from "./ports.ts";
import { assertExecutorAllowed, awaitQuotaHeadroom } from "./policy.ts";
import type { ExecPolicyStore, QuotaStore } from "engine-core";

/** An empty roster is a caller bug — never a job that trivially "succeeds" with no runs. */
export class EmptyRosterError extends Error {
  constructor() {
    super("a delegate job needs at least one agent");
    this.name = "EmptyRosterError";
  }
}

/**
 * Per-agent branch names for a roster.
 *
 * A branch is checked out in at most ONE worktree, so two agents on the same branch would be
 * handed the same directory and silently overwrite each other. Distinct names per roster slot —
 * including repeats of the same agent, which are independent samples and must not collide.
 */
export function branchNames(
  prefix: string,
  roster: ReadonlyArray<LocalAgentType>,
): ReadonlyArray<string> {
  if (roster.length === 1) return [prefix];
  const seen = new Map<LocalAgentType, number>();
  return roster.map((agent) => {
    const nth = (seen.get(agent) ?? 0) + 1;
    seen.set(agent, nth);
    return nth === 1 ? `${prefix}-${agent}` : `${prefix}-${agent}-${nth}`;
  });
}

/**
 * What a failed run's report cites as its reason. The preference order is the h#112 fix: the
 * terminal result event is the CLI's own account of the stop (claude emits the limit text there
 * even on exit 0), while stderr's HEAD is usually an incidental startup warning — so when stderr
 * is all we have, cite its TAIL, never its first line.
 */
export const failureDetail = (invoked: {
  resultEventText?: string;
  stderr?: string;
  exitCode?: number;
}): string => {
  const fromResult = invoked.resultEventText?.trim();
  if (fromResult) return fromResult;
  const lines = (invoked.stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > 0) return lines.slice(-3).join("\n");
  return `agent exited with code ${invoked.exitCode}`;
};

const summarise = (report: AgentRunReport): string => {
  const seconds = (report.durationMs / 1000).toFixed(1);
  const cost = report.costUsd === undefined ? "cost unknown" : `$${report.costUsd.toFixed(4)}`;
  const stopped =
    report.stopReason && report.stopReason !== "completed" ? ` [${report.stopReason}]` : "";
  return report.status === "completed"
    ? `✓ ${report.agent} completed in ${seconds}s (${cost})${stopped}`
    : `✗ ${report.agent} failed after ${seconds}s${stopped}: ${report.error ?? "no detail"}`;
};

/**
 * Run one task across a roster of agent CLIs and collect what each produced.
 *
 * Worktrees are cut SEQUENTIALLY (concurrent `git worktree add` on one checkout races on
 * index.lock), then the agents run CONCURRENTLY — the fan-out that makes a local panel worth
 * having. One agent's failure never cancels its siblings: `AgentPort.run` reports rather than
 * fails, so the envelope always accounts for every roster slot.
 */
export const runDelegate = (
  job: DelegateJob,
): Effect.Effect<
  DelegateEnvelope,
  UnknownAgentError | EmptyRosterError | WorkspaceError,
  AgentPort | WorkspacePort | ProgressPort | ExecPolicyStore | QuotaStore
> =>
  Effect.gen(function* () {
    const agent = yield* AgentPort;
    const progress = yield* ProgressPort;

    if (job.agents.length === 0) return yield* Effect.fail(new EmptyRosterError());
    const roster = yield* Effect.try({
      try: () => job.agents.map(resolveAgent),
      catch: (cause) => cause as UnknownAgentError,
    });

    const cwds = yield* prepareCwds(job, roster);

    const requests: AgentRunRequest[] = roster.map((name, index) => ({
      agent: name,
      task: job.task,
      cwd: cwds[index] ?? job.cwd,
      timeoutMs: job.timeoutMs,
      model: job.model,
      systemPrompt: job.systemPrompt,
      permissionMode: job.permissionMode,
      runsDir: job.runsDir,
      group: job.group,
    }));

    const runs = yield* Effect.all(
      requests.map((request) =>
        Effect.gen(function* () {
          // The policy fence, per agent rather than per roster: a denied executor must not cost
          // its siblings their answers, so a denial becomes THIS agent's failed REPORT — the same
          // shape `AgentPort.run` uses for a dead CLI — instead of failing the whole delegate.
          const denial = yield* awaitQuotaHeadroom(request.agent, job.quota, (decision) =>
            progress.emit(
              `⏳ ${request.agent}: ${decision.reason} — waiting until ${decision.untilIso}`,
            ),
          ).pipe(
            Effect.flatMap(() => assertExecutorAllowed(request.agent, new Date().toISOString())),
            Effect.map(() => undefined),
            Effect.catchAll((err: Error) => Effect.succeed(err.message)),
          );
          if (denial !== undefined) {
            yield* progress.emit(`⊘ ${request.agent}: ${denial}`);
            return {
              agent: request.agent,
              status: "failed" as const,
              cwd: request.cwd,
              error: denial,
              output: "",
              durationMs: 0,
            } satisfies AgentRunReport;
          }
          yield* progress.emit(`→ ${request.agent} started in ${request.cwd}`);
          const report = yield* agent.run(request);
          yield* progress.emit(summarise(report));
          return report;
        }),
      ),
      { concurrency: "unbounded" },
    );

    return {
      ok: runs.every((run) => run.status === "completed"),
      group: job.group,
      runs,
    } satisfies DelegateEnvelope;
  });

/** One cwd per roster slot: the job's own directory, or a freshly cut per-agent worktree. */
const prepareCwds = (
  job: DelegateJob,
  roster: ReadonlyArray<LocalAgentType>,
): Effect.Effect<ReadonlyArray<string>, WorkspaceError, WorkspacePort | ProgressPort> =>
  Effect.gen(function* () {
    const spec = job.worktree;
    if (!spec) return roster.map(() => job.cwd);

    const workspace = yield* WorkspacePort;
    const progress = yield* ProgressPort;
    const branches = branchNames(spec.branchPrefix, roster);
    const paths: string[] = [];
    for (const branch of branches) {
      const worktreePath = join(spec.root, branch.replaceAll("/", "-"));
      const { worktreePath: effective } = yield* workspace.prepare({
        repoPath: spec.repoPath,
        worktreePath,
        // Always the branch strategy: `--worktree` exists to isolate WRITE work, and write work
        // is what a branch is for. A read-only delegate simply runs in the job's cwd.
        checkout: { kind: "branch", branch, remoteBase: spec.remoteBase },
      });
      yield* progress.emit(`⎇ ${branch} → ${effective}`);
      paths.push(effective);
    }
    return paths;
  });
