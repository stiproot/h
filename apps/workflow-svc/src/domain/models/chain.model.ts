import { Schema } from "effect";

import { WorkflowStep } from "./workflow.model.ts";

/**
 * The chain primitive's data shapes (docs/plans/workflow-composition.md): a chain is a durable
 * registration — a `chain:sub:<chainId>` row — that the scan engine reads on the cron tick,
 * advancing the sequence when the current workflow reaches terminal. It mirrors the watcher primitive
 * exactly (watch.model.ts): a fixed-struct policy, every behavior in engine code, epoch-fenced,
 * single-writer (workflow-svc). Where a watch RE-fires one instance (retry), a chain FIRES THE
 * NEXT workflow (advance) — that is the only structural difference.
 *
 * Import-light by design, like watch.model.ts: the only import is `WorkflowStep` (an embedded
 * inline member stores its own hydrated steps, D1 — the same exception cron.model makes), nothing
 * else imports back from the request/store schemas. The row IS the chain's durable blackboard
 * (`data`) as well as its sequencing state, replacing Phase 1's best-effort `chain:<slug>` mirror.
 */

// Sequencing strategy. "sequential" runs the workflows once, front to back. "loop-until-clean" repeats a
// loop body (the review→revise segment) until the review workflow reports CLEAN or the iteration budget
// trips (see ChainLoop). A closed literal so an unknown strategy fails validation, never silently.
// ("parallel" fan-out is deferred until a multi-reviewer chain needs it.)
export const ChainStrategy = Schema.Literal("sequential", "loop-until-clean");
export type ChainStrategy = Schema.Schema.Type<typeof ChainStrategy>;

// loop-until-clean control: when the workflow at `startCursor` (the review workflow) completes CLEAN the chain
// finalizes; when the last workflow (revise) completes, the engine loops back to `startCursor` and bumps
// `iterations`, until `iterations` reaches `maxIterations` (the budget — an implementer/reviewer
// disagreement can't spin forever). Re-fires within the loop are always fresh (terminal instances).
export const ChainLoop = Schema.Struct({
  startCursor: Schema.Number,
  maxIterations: Schema.Number,
  iterations: Schema.Number,
});
export type ChainLoop = Schema.Schema.Type<typeof ChainLoop>;

export const ChainOutcome = Schema.Literal(
  "completed",
  "failed",
  "terminated",
  "budget-terminated",
  "orphaned",
);
export type ChainOutcome = Schema.Schema.Type<typeof ChainOutcome>;

// The workflow KIND selects the engine-coded port contract (chain-workflows.ts): how the workflow builds its
// fire-params from the blackboard and captures its output back into it. Threading is engine code,
// not a config DSL (mirrors the watcher's ruling W3) — a novel chain adds a kind here + in
// chain-workflows.ts. Closed literal so an unknown kind fails validation at registration.
export const ChainWorkflowKind = Schema.Literal("feature-pr", "pr-review", "revise", "answer");
export type ChainWorkflowKind = Schema.Schema.Type<typeof ChainWorkflowKind>;

/**
 * One workflow in the sequence: its kind (selecting the engine-coded threading logic) and which saved
 * workflow to fire, and how. The pure engine (chain-engine.ts) sequences on cursor + status alone
 * and reads none of these; the scan (chain-scan.ts) uses `kind` to pick the buildParams/capture
 * contract and `key`/`fresh`/`instanceId` to fire.
 */
export const ChainWorkflow = Schema.Struct({
  // Selects the buildParams/capture contract in chain-workflows.ts. Distinct from `key`: e.g. the
  // `revise` kind fires the `feature-pr` key but threads reviewFindings into its spec.
  kind: ChainWorkflowKind,
  // Saved-workflow key this member fires (resolved via WorkflowStore.get + toRequest). Optional —
  // EXACTLY ONE of `key` / `steps` (validateChain enforces the XOR). A member is either a reference
  // to a saved definition (publish-default) or carries its own embedded steps (`--inline`, D1).
  key: Schema.optional(Schema.String),
  // Embedded (inline) definition this member fires verbatim (D1 inline storage): the composed steps
  // live IN the chain:sub row, nothing published to re-hydrate. The alternative to `key`. A cron
  // member MUST be inline — its self-armed recurrence has no key to reference, so it recurs these
  // very steps over an embedded source (validateChain enforces cron ⟹ steps).
  steps: Schema.optional(Schema.Array(WorkflowStep)),
  // Recur policy (D2): this member self-arms a recurrence via the §10 arm-* pattern — its own
  // generic.workflow closing bracket runs register-cron (the chain injects `armCron` into the ONE
  // fire, from this policy). The chain engine NEVER writes cron:sub and never re-fires; it only
  // OBSERVES `wf:<member>.resolved` to know the member is done (D4). Cadence + optional maxFires budget.
  cron: Schema.optional(
    Schema.Struct({ cadence: Schema.String, maxFires: Schema.optional(Schema.Number) }),
  ),
  // The member's blackboard NAMESPACE (docs/plans/inline-chain-cron-composition.md D5): declared
  // `captures` write under `data[id]` (namespace-implicit — a member writes under its own id, so
  // concurrent members of a stage never clobber), and a downstream member's dotted `inputs`
  // (`id.field`) read it back. Optional: absent ⇒ declared captures thread FLAT (the degenerate
  // one-member-per-stage case where nothing can clobber). The CLI defaults it to the `-t`/`-w` name.
  id: Schema.optional(Schema.String),
  // The concurrency STAGE this member runs in (docs/plans/inline-chain-cron-composition.md D3):
  // members sharing a stage run concurrently, and the chain advances stage-by-stage, joining on ALL
  // members of a stage completing before firing the next. `cursor` is the CURRENT stage index.
  // Optional for back-compat: absent ⇒ the member's own index, i.e. pure sequential, one member per
  // stage — the degenerate case where cursor stayed member-index-compatible ({A}→{B}→{C} = stages
  // 0,1,2). {A ∥ B} → C = stages [A:0, B:0, C:1]. Registration normalizes (all-or-none) + validates
  // contiguity via validateStages, so the cursor+1 progression never skips or stalls on a gap.
  stage: Schema.optional(Schema.Number),
  // Re-fire semantics: purge a terminal instance and re-run (a revise workflow re-runs its feature-pr
  // instance fresh). Default false — attach to a RUNNING/PENDING instance, no-op a terminal one.
  fresh: Schema.optional(Schema.Boolean),
  // Instance id for this workflow's run; when several workflows share one (feature + revise share the branch)
  // they name the same instanceId. Absent → the engine derives one from the chain + workflow index.
  instanceId: Schema.optional(Schema.String),
  // Per-workflow fire-time params (chain-composition-surface §1.9: identity like runActivity/agentId/
  // model*, mapped by the CLI from workflow flags). Merged OVER the kind contract's buildParams output
  // at fire time — the CLI never sets threading keys (slug/spec/pr), so the sets stay disjoint.
  params: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  // Declarative threading over STRUCTURED output (docs/plans/structured-workflow-outputs.md §4).
  // Each field, when present, replaces its half of the kind's coded contract; the DSL is
  // deliberately tiny (rename / require / equals) — anything needing a transform or a conditional
  // earns a coded kind instead. Assignment-ordered: destination ← source.
  // captures: blackboardKey ← structured-output field of THIS workflow's completed run.
  captures: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  // inputs: fire param ← blackboard key, built when THIS workflow fires.
  inputs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  // until: loop-until-clean predicate on THIS workflow's structured output (replaces the coded
  // reviewIsClean marker sniff when declared): satisfied when String(field at path) === equals.
  until: Schema.optional(Schema.Struct({ path: Schema.String, equals: Schema.String })),
});
export type ChainWorkflow = Schema.Schema.Type<typeof ChainWorkflow>;

export const ChainStatus = Schema.Literal("scheduling", "running", "finalized");
export type ChainStatus = Schema.Schema.Type<typeof ChainStatus>;

/**
 * The persisted chain row (`chain:sub:<chainId>`), written only by workflow-svc — its fire path
 * (registration, workflow advance) and the scan engine. Single-writer per key is structural, like
 * `watch:*`.
 *
 * `epoch` is the fence: bumped on every (re)schedule — registration and each workflow advance — so an
 * engine action computed against an older incarnation re-reads the row and no-ops when its in-hand
 * epoch is stale. `cursor` indexes the current STAGE (D3): the engine fires every member of the stage,
 * joins on all of them completing, then advances the cursor. For a one-member-per-stage chain this is
 * numerically the member index (back-compat); `currentInstanceId` tracks the stage's primary (first)
 * member — the engine derives each member's instance from chain+index.
 */
export const ChainRow = Schema.Struct({
  chainId: Schema.String,
  epoch: Schema.Number,
  // The branch token and blackboard identity (Phase 1's slug); workflows key their run off it.
  slug: Schema.String,
  // The members, in order. Grouped into STAGES by each member's `stage` (D3); `cursor` points at a
  // stage, not a single member. captures/inputs/until keep indexing this flat array.
  workflows: Schema.Array(ChainWorkflow),
  strategy: ChainStrategy,
  // Present iff strategy is "loop-until-clean" — the loop body + iteration budget/counter.
  loop: Schema.optional(ChainLoop),
  // Optional wall-clock budget for the whole chain; on breach the current workflow is terminated and the
  // chain finalizes budget-terminated. Absent → no chain-level budget (each workflow may carry its own watch).
  budgetMs: Schema.optional(Schema.Number),
  // Index of the STAGE currently running / just fired (D3). Starts at 0 when registration fires every
  // member of stage 0. For one-member-per-stage chains this equals the running member's index.
  cursor: Schema.Number,
  currentInstanceId: Schema.optional(Schema.String),
  // The shared-context blackboard threaded across workflows (Phase 1's {slug, data}.data). Each workflow reads
  // what it needs and writes what it produces; the engine captures workflow outputs into it on advance.
  data: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  status: ChainStatus,
  // Last observed runtimeStatus of the current workflow.
  lastStatus: Schema.String,
  unknownStreak: Schema.Number,
  outcome: Schema.optional(ChainOutcome),
  note: Schema.optional(Schema.String),
  meta: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  endedAt: Schema.optional(Schema.String),
});
export type ChainRow = Schema.Schema.Type<typeof ChainRow>;

// chain:config — the kill switch, same semantics as watch:config: absent means ENABLED (arming must
// not require a seed key). `maxEngineFiresPerDay` caps the engine's workflow fires fail-closed (absent →
// uncapped, since a chain that can't advance is stuck, not dangerous, unlike an escalation).
export const ChainConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  maxEngineFiresPerDay: Schema.optional(Schema.Number),
});
export type ChainConfig = Schema.Schema.Type<typeof ChainConfig>;

// chain:ledger:<yyyy-mm-dd> — engine-written daily tallies. `workflowsFired` counts every workflow fired
// (registration's workflow 0 + each engine advance); `chainsFinalized` counts terminal chains; `costUsd`
// accumulates workflow costs at finalize.
export const ChainLedger = Schema.Struct({
  chainsRegistered: Schema.Number,
  workflowsFired: Schema.Number,
  chainsFinalized: Schema.Number,
  costUsd: Schema.Number,
});
export type ChainLedger = Schema.Schema.Type<typeof ChainLedger>;

export const emptyChainLedger: ChainLedger = {
  chainsRegistered: 0,
  workflowsFired: 0,
  chainsFinalized: 0,
  costUsd: 0,
};

// chain:__tick__ — the scan heartbeat. `enabled: false` distinguishes a deliberate disarm from a
// dead engine, exactly like watch:__tick__.
export const ChainHeartbeat = Schema.Struct({
  at: Schema.String,
  enabled: Schema.Boolean,
});
export type ChainHeartbeat = Schema.Schema.Type<typeof ChainHeartbeat>;

/** UTC day key for the ledger, e.g. "2026-07-08". */
export function chainLedgerDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export const DEFAULT_CHAIN_UNKNOWN_STREAK_LIMIT = 6;

// ---------------------------------------------------------------------------
// Stage helpers (D3) — pure functions the engine + scan share to map the flat
// `workflows` array onto its concurrency stages. Kept here beside the model so
// the "absent stage ⇒ member index" back-compat rule has ONE home.
// ---------------------------------------------------------------------------

/** A member's stage: explicit, else its index (back-compat — one member per stage = sequential). */
export function stageOf(workflows: readonly ChainWorkflow[], index: number): number {
  return workflows[index]?.stage ?? index;
}

/** The distinct stage indices present, ascending. */
export function stagesOf(workflows: readonly ChainWorkflow[]): number[] {
  const set = new Set<number>();
  for (let i = 0; i < workflows.length; i++) set.add(stageOf(workflows, i));
  return [...set].sort((a, b) => a - b);
}

/** The member indices in a stage, in workflow order. */
export function membersInStage(workflows: readonly ChainWorkflow[], stage: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < workflows.length; i++) if (stageOf(workflows, i) === stage) out.push(i);
  return out;
}

/** The highest stage index (the last stage the chain finalizes on). */
export function lastStage(workflows: readonly ChainWorkflow[]): number {
  return stagesOf(workflows).at(-1) ?? 0;
}

/**
 * Registration-time validation of a whole chain (stages + member shape). Returns an error message,
 * or null when valid. Called at registration so an unfireable chain fails loud, never arms.
 *
 * Stages must be 0-based and contiguous (0,1,…,N), each non-empty, and declared all-or-none — else
 * the cursor+1 progression would skip a stage or stall, or the `?? index` default would collide
 * explicit and implicit stages. Each member must carry EXACTLY ONE of `key` / `steps` (a reference
 * to a saved def, or embedded inline steps — D1). A cron member MUST be inline (`steps`): its
 * self-armed recurrence has no key to reference and recurs an embedded source (D1/D2).
 */
export function validateChain(workflows: readonly ChainWorkflow[]): string | null {
  if (workflows.length === 0) return "chain has no members";
  const declared = workflows.filter((w) => w.stage !== undefined).length;
  if (declared !== 0 && declared !== workflows.length)
    return "either all members declare a stage or none do";
  const stages = stagesOf(workflows);
  for (let s = 0; s < stages.length; s++)
    if (stages[s] !== s) return `stages must be contiguous from 0 (got ${stages.join(",")})`;
  for (let i = 0; i < workflows.length; i++) {
    const w = workflows[i];
    const hasKey = w.key !== undefined && w.key !== "";
    const hasSteps = w.steps !== undefined && w.steps.length > 0;
    if (hasKey === hasSteps)
      return `member ${i} (${w.kind}) must carry exactly one of key / steps`;
    if (w.cron && !hasSteps)
      return `cron member ${i} (${w.kind}) must be inline (steps) — its recurrence has no key to reference`;
  }
  return null;
}
