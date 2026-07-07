import { Schema } from "effect";

/**
 * Wire contract for `POST /run` on every agent service. The schema is the single
 * source of truth: decode untrusted bodies with `Schema.decodeUnknown(AgentRequest)`;
 * the derived type (same name) is what handlers and runners consume.
 */
export const AgentRequest = Schema.Struct({
  input: Schema.String,
  systemPrompt: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.NullOr(Schema.String)),
  workflowInstanceId: Schema.optional(Schema.String),
  /** Stable workspace key. When set, the workspace dir keys on it instead of workflowInstanceId. */
  workspaceId: Schema.optional(Schema.String),
  /** Explicit working dir for the run; overrides the computed workspace dir when set. */
  cwd: Schema.optional(Schema.String),
  /** Per-step LLM model override (claude-agent + openhands-agent); falls back to the service default. */
  model: Schema.optional(Schema.String),
  /** "plan" runs the claude CLI read-only (--permission-mode plan); omit for the default. claude-agent only. */
  permissionMode: Schema.optional(Schema.Literal("plan")),
});
export type AgentRequest = Schema.Schema.Type<typeof AgentRequest>;

/** Wire contract for an agent run's result — schema plus derived type, same name. */
export const AgentResponse = Schema.Struct({
  output: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  usage: Schema.Struct({ input: Schema.Number, output: Schema.Number }),
  model: Schema.String,
  turns: Schema.Number,
  workspacePath: Schema.optional(Schema.String),
  /** Total LLM cost for the run, in USD, when the agent reports it. */
  costUsd: Schema.optional(Schema.Number),
  /** Number of tool calls the agent made during the run (best-effort). */
  toolCalls: Schema.optional(Schema.Number),
  /** Identifier of the run-ledger record for this run (see the run ledger). */
  runId: Schema.optional(Schema.String),
});
export type AgentResponse = Schema.Schema.Type<typeof AgentResponse>;
