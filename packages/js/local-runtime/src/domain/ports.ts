import { Context, Data, type Effect } from "effect";

import type { AgentRunReport, AgentRunRequest, WorktreeSpec } from "./models.ts";

/**
 * Running one agent CLI to completion.
 *
 * No error channel by design: every outcome — a non-zero exit, a timeout, a CLI that is not
 * installed — comes back as a `failed` {@link AgentRunReport}. A roster must not lose three
 * answers because the fourth agent is missing, and the adapter has already written the run
 * ledger entry by the time it returns.
 */
export class AgentPort extends Context.Tag("local-runtime/AgentPort")<
  AgentPort,
  {
    readonly run: (request: AgentRunRequest) => Effect.Effect<AgentRunReport>;
  }
>() {}

/** Preparing an isolated checkout failed — unlike an agent run, this is fatal to the job. */
export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly worktreePath: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `could not prepare worktree ${this.worktreePath}: ${detail}`;
  }
}

/** One provisioning command of a `setup` step. */
export type SetupCommand = { readonly cmd: string; readonly validateCmd?: string };

/** Preparing the workspace a run works in: its checkout, and any provisioning it declares. */
export class WorkspacePort extends Context.Tag("local-runtime/WorkspacePort")<
  WorkspacePort,
  {
    /** Create (or reuse) the worktree and return its EFFECTIVE path. */
    readonly prepare: (spec: WorktreeSpec) => Effect.Effect<string, WorkspaceError>;
    /** Run a `setup` step's commands in `cwd`, in order; a non-zero exit fails the step. */
    readonly provision: (
      cwd: string,
      commands: ReadonlyArray<SetupCommand>,
    ) => Effect.Effect<void, WorkspaceError>;
  }
>() {}

/**
 * Human-readable progress, out of band from the result. The runner's stdout carries ONLY the
 * result envelope, so a caller can parse it without stripping chatter; progress goes to stderr.
 */
export class ProgressPort extends Context.Tag("local-runtime/ProgressPort")<
  ProgressPort,
  {
    readonly emit: (line: string) => Effect.Effect<void>;
  }
>() {}
