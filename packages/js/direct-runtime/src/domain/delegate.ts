import { join } from "node:path";

import { Effect } from "effect";

import { resolveAgent, UnknownAgentError } from "./agents.ts";
import type {
  AgentRunReport,
  AgentRunRequest,
  DelegateEnvelope,
  DelegateJob,
  DirectAgentType,
} from "./models.ts";
import { AgentPort, ProgressPort, WorkspacePort, type WorkspaceError } from "./ports.ts";

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
  roster: ReadonlyArray<DirectAgentType>,
): ReadonlyArray<string> {
  if (roster.length === 1) return [prefix];
  const seen = new Map<DirectAgentType, number>();
  return roster.map((agent) => {
    const nth = (seen.get(agent) ?? 0) + 1;
    seen.set(agent, nth);
    return nth === 1 ? `${prefix}-${agent}` : `${prefix}-${agent}-${nth}`;
  });
}

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
  AgentPort | WorkspacePort | ProgressPort
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
  roster: ReadonlyArray<DirectAgentType>,
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
      const effective = yield* workspace.prepare({
        repoPath: spec.repoPath,
        worktreePath,
        branch,
        remoteBase: spec.remoteBase,
      });
      yield* progress.emit(`⎇ ${branch} → ${effective}`);
      paths.push(effective);
    }
    return paths;
  });
