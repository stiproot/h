/**
 * The job/report shapes of the local execution substrate.
 *
 * h composes work the same way on both substrates — a template renders to a workflow definition,
 * and only the executor underneath differs. These are that executor's own wire shapes for its
 * smallest unit of work: delegate ONE task to a roster of agent CLIs, running as local child
 * processes. Deliberately independent of agent-cli's vocabulary so the domain stays free of the
 * subprocess layer; the adapter maps `InvocationResult` onto `AgentRunReport`.
 */

import { Schema } from "effect";
import { CHAIN_MEMBER_KINDS, WorkflowParams, WorkflowStep } from "workflow-core";

/** The agent CLIs this substrate can drive — the closed vocabulary behind `--agent`. */
export const LOCAL_AGENT_TYPES = ["claude", "codex", "openhands", "pi"] as const;

export type LocalAgentType = (typeof LOCAL_AGENT_TYPES)[number];

/** A worktree to cut before a run, so delegated write work never lands in the live checkout. */
export type WorktreeSpec = {
  /** An existing checkout whose object store the worktree shares. */
  repoPath: string;
  /** Absolute destination path for the new worktree. */
  worktreePath: string;
  branch?: string;
  /** Explicit start point for a new branch; wins over `remoteBase`. */
  baseRef?: string;
  /** Fetch this branch from origin and start from its tip, rather than the local checkout. */
  remoteBase?: string;
};

/** One agent's slice of a delegate job, after the roster has been resolved and cwds assigned. */
export type AgentRunRequest = {
  /** The canonical agent name (`claude`), which is also the ledger's agentId for this run. */
  agent: LocalAgentType;
  task: string;
  /** Where the CLI runs — the job's cwd, or this agent's own worktree. */
  cwd: string;
  timeoutMs: number;
  model?: string;
  systemPrompt?: string;
  /** "plan" runs the CLI read-only, where the agent supports it. */
  permissionMode?: "plan";
  /** Run-ledger root and grouping key, so local runs are readable by the same surfaces. */
  runsDir: string;
  group: string;
};

/**
 * What one agent did. A failure is a REPORT, never an error channel: a roster must not lose three
 * answers because the fourth agent is not installed, and the run ledger has already recorded the
 * outcome either way.
 */
export type AgentRunReport = {
  agent: LocalAgentType;
  status: "completed" | "failed";
  cwd: string;
  output: string;
  durationMs: number;
  error?: string;
  exitCode?: number;
  /** agent-cli's stop classification (e.g. "usage-limited") — orthogonal to `status`. */
  stopReason?: string;
  model?: string;
  costUsd?: number;
  /** True when usage was folded from a partial stream (timeout/kill), not a final accounting. */
  costPartial?: boolean;
  tokens?: { input: number; output: number };
  turns?: number;
  sessionId?: string;
  /** Run-ledger identity, so `h runs` / `h run <id>` / obs-mcp can pick the run up. */
  runId?: string;
  runDir?: string;
};

/**
 * Cut an isolated worktree per agent instead of running in the job's cwd. Per AGENT, not per job:
 * a branch lives in at most one worktree, and concurrent writers sharing one checkout corrupt each
 * other's work — the same reason panels are read/judge kinds on the service substrate.
 */
export const WorktreePlan = Schema.Struct({
  repoPath: Schema.String,
  /** Directory the per-agent worktrees are created under. */
  root: Schema.String,
  /** Branch prefix; each agent's branch is `<prefix>-<agent>` for a roster. */
  branchPrefix: Schema.String,
  remoteBase: Schema.optional(Schema.String),
});
export type WorktreePlan = Schema.Schema.Type<typeof WorktreePlan>;

/**
 * A delegate job: one task, a roster of one or more agents, each answering independently.
 * Schema plus derived type, same name — the wire contract with the CLI that spawns the runner,
 * decoded loudly so a malformed job is a named field error rather than an undefined at depth.
 */
export const DelegateJob = Schema.Struct({
  kind: Schema.Literal("delegate"),
  task: Schema.String,
  /** User-facing agent names; resolved against the closed vocabulary, unknown names fail loud. */
  agents: Schema.Array(Schema.String),
  /** Working directory for every agent, unless `worktree` gives each its own. */
  cwd: Schema.String,
  timeoutMs: Schema.Number,
  runsDir: Schema.String,
  /** Ledger grouping key for this job — the local substrate's join key across its runs. */
  group: Schema.String,
  model: Schema.optional(Schema.String),
  systemPrompt: Schema.optional(Schema.String),
  permissionMode: Schema.optional(Schema.Literal("plan")),
  worktree: Schema.optional(WorktreePlan),
});
export type DelegateJob = Schema.Schema.Type<typeof DelegateJob>;

/** What the runner writes to stdout: every agent's report plus the job-level verdict. */
export type DelegateEnvelope = {
  /** True only when EVERY agent completed — a partial roster is not a success. */
  ok: boolean;
  group: string;
  runs: ReadonlyArray<AgentRunReport>;
};

/**
 * Execute a workflow DEFINITION — the same `{params, steps}` artifact `h` composes for the
 * service substrate, run in-process instead of fired at workflow-svc.
 *
 * There is no saved-workflow store to read from here (a registry is substrate machinery), so the
 * CLI renders the chart template and sends the definition itself. Everything about what the steps
 * MEAN — `{{token}}` / `$ref` resolution, the output contract, the step shapes — comes from
 * `workflow-core`, shared with the Dapr engine so the two cannot drift.
 */
export const WorkflowJob = Schema.Struct({
  kind: Schema.Literal("workflow"),
  steps: Schema.Array(WorkflowStep),
  params: Schema.optional(WorkflowParams),
  /** Names the run: the workspace key, the ledger group, and the worktree directory. */
  group: Schema.String,
  runsDir: Schema.String,
  /** Per-agent-step wall-clock budget. */
  timeoutMs: Schema.Number,
  /** Directory `create-worktree` places this run's worktree under. */
  worktreeRoot: Schema.String,
  /**
   * The checkout `create-worktree` cuts from when a step declares no `clonePath`. Local
   * execution's default is the checkout the operator is standing in — no pre-clone to provision.
   */
  repoPath: Schema.String,
  /**
   * Run `setup` steps instead of skipping them. Off by default: a template's setup installs h
   * skills into `~/.claude/`, which is the OPERATOR's own configuration on this substrate, not a
   * container's. Opting in is a deliberate act.
   */
  withSetup: Schema.optional(Schema.Boolean),
});
export type WorkflowJob = Schema.Schema.Type<typeof WorkflowJob>;

/**
 * One member of a chain on this substrate: an EMBEDDED definition plus its threading mappings.
 *
 * The durable carrier lets a member name a saved key OR embed steps; here there is no store to
 * resolve a key against, so the CLI renders each member's template and every member is embedded.
 * `cron` members are absent for the same reason recurrence is: they self-arm a registration this
 * substrate has no engine to service, so the CLI refuses them before anything runs.
 */
export const LocalChainMember = Schema.Struct({
  kind: Schema.Literal(...CHAIN_MEMBER_KINDS),
  steps: Schema.Array(WorkflowStep),
  params: Schema.optional(WorkflowParams),
  /** Concurrency stage; absent ⇒ member index (one per stage, i.e. sequential). */
  stage: Schema.optional(Schema.Number),
  /** Namespace for this member's declared captures, so concurrent members never clobber. */
  id: Schema.optional(Schema.String),
  captures: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  inputs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  until: Schema.optional(Schema.Struct({ path: Schema.String, equals: Schema.String })),
});
export type LocalChainMember = Schema.Schema.Type<typeof LocalChainMember>;

/**
 * Journal wiring for a run — where the fabric answers, and whether this fire CONTINUES a
 * journaled group instead of starting one. The driver's preflight owns the server lifecycle and
 * the stream; the executor owns every record, the way it owns the run ledger.
 */
export const JournalConfig = Schema.Struct({
  /** The fabric URL the executor publishes to (the driver has already ensured it answers). */
  url: Schema.String,
  /** Replay `h.journal.<group>` and continue after the last journaled stage. */
  resume: Schema.optional(Schema.Boolean),
});
export type JournalConfig = Schema.Schema.Type<typeof JournalConfig>;

/**
 * One journal record — the resume state of a run, published per completed unit with a
 * `<group>:<seq>` dedup identity so a crashed writer's retry can never fork a journal.
 *
 * `stage` snapshots the FULL post-capture chain data (structured fields, never transcripts), so
 * stage-level resume reads one record. `terminal` exists ONLY for `completed`: a failed or
 * budget-exhausted run stays resumable — resuming a completed one must be a loud no-op instead
 * of a silent re-run.
 */
export type JournalRecord =
  | {
      seq: number;
      type: "meta";
      kind: "chain";
      /** Hash of {members, strategy, loop}: resuming a changed composition refuses loud. */
      definitionHash: string;
      group: string;
      ts: number;
    }
  | {
      seq: number;
      type: "stage";
      /** The stage that COMPLETED (not the next one). */
      cursor: number;
      iteration: number;
      data: Record<string, unknown>;
      runs: ChainMemberRun[];
      ts: number;
    }
  | { seq: number; type: "terminal"; status: "completed"; note?: string; ts: number };

/** Sequence several workflow definitions in-process, threading state between them. */
export const ChainJob = Schema.Struct({
  kind: Schema.Literal("chain"),
  members: Schema.Array(LocalChainMember),
  /** Seed values (`-p k=v`) the first members read their inputs from. */
  data: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  strategy: Schema.Literal("sequential", "loop-until-clean"),
  /** loop-until-clean: the review STAGE to loop back to, and the iteration budget. */
  loop: Schema.optional(
    Schema.Struct({ startCursor: Schema.Number, maxIterations: Schema.Number }),
  ),
  group: Schema.String,
  runsDir: Schema.String,
  timeoutMs: Schema.Number,
  /**
   * Whole-chain wall clock (the PREFIX `--budget`), mirroring the chain row's `budgetMs`. Checked
   * between stages, so it bounds what the chain STARTS — an agent already running is bounded by
   * `timeoutMs` instead. The per-MEMBER budget is a watch policy and is refused on this substrate.
   */
  budgetMs: Schema.optional(Schema.Number),
  worktreeRoot: Schema.String,
  repoPath: Schema.String,
  withSetup: Schema.optional(Schema.Boolean),
  /** Present ⇒ journal every stage to the fabric (absent under `--no-journal`). */
  journal: Schema.optional(JournalConfig),
});
export type ChainJob = Schema.Schema.Type<typeof ChainJob>;

/** One member execution — several per member when a loop re-runs it. */
export type ChainMemberRun = {
  member: string;
  stage: number;
  /** The run group, so its steps' ledger entries are findable. */
  group: string;
  iteration: number;
};

export type ChainEnvelope = {
  ok: boolean;
  chain: string;
  /** `exhausted` is a loop that hit its budget with findings outstanding — not a failure. */
  status: "completed" | "failed" | "exhausted";
  note?: string;
  /** The threaded chain data as it stands at the end — what each member captured. */
  data: Record<string, unknown>;
  runs: ReadonlyArray<ChainMemberRun>;
};

/** Every job the runner accepts, discriminated on `kind`. */
export const LocalJob = Schema.Union(DelegateJob, WorkflowJob, ChainJob);
export type LocalJob = Schema.Schema.Type<typeof LocalJob>;

/** What a workflow job writes to stdout: the step results map, exactly as the engine returns it. */
export type WorkflowEnvelope = {
  ok: boolean;
  group: string;
  /** Step id → that step's result, the same map `{{stepId.field}}` resolves against. */
  results: Record<string, unknown>;
  /**
   * What each agent step actually cost and where to read it — the accounting the `results` map
   * deliberately omits (it carries only what downstream steps resolve against). There is no
   * watcher on this substrate, so this plus the ledger is the whole story; a caller that never
   * sees the terminal (the event fabric's relay reports to a stream, not to the seeder) can
   * still say what a run spent and hand back a runId to read the output by.
   */
  runs?: ReadonlyArray<WorkflowRunRef>;
  /** Present when a step failed: which one, and why. */
  failedStep?: string;
  error?: string;
};

/** One agent run inside a workflow job: which step, which agent, what it cost, where it landed. */
export type WorkflowRunRef = {
  step: string;
  agent: string;
  runId?: string;
  costUsd?: number;
};
