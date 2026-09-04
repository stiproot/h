import { Schema } from "effect";

/**
 * The workflow DEFINITION shapes — what an executor needs to run a workflow, and nothing about
 * how or where it is executed.
 *
 * These live in a package rather than in workflow-svc because h has two execution substrates: the
 * durable Dapr engine and the direct in-process runner. A definition composed by `h` must mean the
 * same thing to both, so the shapes (and the semantics beside them in resolve-refs.ts and
 * structured-output.ts) have exactly one implementation that both import.
 *
 * What deliberately does NOT live here: the fire descriptor, the run request, the stored/saved
 * workflow, and the registry models. Those are substrate machinery — instance ids, watch policies,
 * cron arming — meaningful only where there is a durable engine to fire into.
 */

// Named workflow parameters. Steps reference them like step results — `{{params.x}}` inside a
// string or `{ "$ref": "params.x" }` — resolved by the executor, which seeds them into the results
// map under the reserved id `params` (a step must not use that id).
export const WorkflowParams = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export type WorkflowParams = Schema.Schema.Type<typeof WorkflowParams>;

export const StepDefinition = Schema.Struct({
  id: Schema.optional(Schema.String),
  activity: Schema.String,
  // Optional on the wire: a step with no input has always worked (the executor spreads it).
  input: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type StepDefinition = Schema.Schema.Type<typeof StepDefinition>;

// A parallel step group: branches are plain steps run
// concurrently by the executor through ONE join — groups do not nest, and branches cannot
// reference each other (inputs resolve against the results map as it stood before the group).
// Results land under each branch's id exactly like sequential steps; a group id additionally
// records a {branchId: result} map. Decode is unambiguous against StepDefinition: a group has
// `parallel` and no `activity`.
export const ParallelGroup = Schema.Struct({
  id: Schema.optional(Schema.String),
  parallel: Schema.Array(StepDefinition),
});
export type ParallelGroup = Schema.Schema.Type<typeof ParallelGroup>;

// What a workflow definition's `steps` array holds: a plain step or a parallel group.
export const WorkflowStep = Schema.Union(StepDefinition, ParallelGroup);
export type WorkflowStep = Schema.Schema.Type<typeof WorkflowStep>;

export type AgentResult = {
  sessionId: string | null;
  output: string;
  // null means this agent's stream cannot be tallied; zero is a measured zero.
  toolCalls: number | null;
  workspacePath?: string;
  // The validated structured-output block: present iff the step carried an outputContract —
  // code-guaranteed by the contract seam (structured-output.ts), never raw prose.
  structured?: unknown;
};
