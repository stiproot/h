import { Data } from "effect";

/**
 * The cross-service tagged-error family (see the Effect refactor map, section 3).
 * These are the tags that cross a TS-to-TS Dapr-invoke boundary; adapters
 * `mapError` raw SDK failures into them, and inbound handlers map the tags to
 * HTTP statuses. Fields are deliberately lean — `cause` carries the raw failure,
 * the rest identify where it happened. Tags local to one unit stay in that unit.
 */

/** A Dapr service-invocation call failed (network, non-ok status, bad payload). */
export class DaprInvokeError extends Data.TaggedError("DaprInvokeError")<{
  readonly cause: unknown;
  readonly appId: string;
  readonly method: string;
}> {}

/** An agent run failed (spawn, CLI exit, runner failure). */
export class AgentRunError extends Data.TaggedError("AgentRunError")<{
  readonly cause: unknown;
  readonly agentId: string;
}> {}

/** A repository clone (or worktree provisioning off a clone) failed. */
export class CloneError extends Data.TaggedError("CloneError")<{
  readonly cause: unknown;
  readonly url: string;
  readonly dir: string;
}> {}

/** A workflow operation (schedule, status, raise-event) failed. */
export class WorkflowError extends Data.TaggedError("WorkflowError")<{
  readonly cause: unknown;
  readonly instanceId: string;
}> {}
