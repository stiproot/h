import { Schema } from "effect";

/**
 * The chain primitive's data shapes (docs/plans/workflow-composition.md): a chain is a durable
 * registration — a `chain:sub:<chainId>` row — that the scan engine reads on the cron tick,
 * advancing the sequence when the current hop reaches terminal. It mirrors the watcher primitive
 * exactly (watch.model.ts): a fixed-struct policy, every behavior in engine code, epoch-fenced,
 * single-writer (workflow-svc). Where a watch RE-fires one instance (retry), a chain FIRES THE
 * NEXT hop (advance) — that is the only structural difference.
 *
 * Import-free by design, like watch.model.ts: nothing here imports back from the request/store
 * schemas. The row IS the chain's durable blackboard (`data`) as well as its sequencing state,
 * replacing Phase 1's best-effort `chain:<slug>` mirror.
 */

// Sequencing strategy. "sequential" runs the hops once, front to back. "loop-until-clean" repeats a
// loop body (the review→revise segment) until the review hop reports CLEAN or the iteration budget
// trips (see ChainLoop). A closed literal so an unknown strategy fails validation, never silently.
// ("parallel" fan-out is deferred until a multi-reviewer chain needs it.)
export const ChainStrategy = Schema.Literal("sequential", "loop-until-clean");
export type ChainStrategy = Schema.Schema.Type<typeof ChainStrategy>;

// loop-until-clean control: when the hop at `startCursor` (the review hop) completes CLEAN the chain
// finalizes; when the last hop (revise) completes, the engine loops back to `startCursor` and bumps
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

// The hop KIND selects the engine-coded port contract (chain-hops.ts): how the hop builds its
// fire-params from the blackboard and captures its output back into it. Threading is engine code,
// not a config DSL (mirrors the watcher's ruling W3) — a novel chain adds a kind here + in
// chain-hops.ts. Closed literal so an unknown kind fails validation at registration.
export const ChainHopKind = Schema.Literal("feature-pr", "pr-review", "revise");
export type ChainHopKind = Schema.Schema.Type<typeof ChainHopKind>;

/**
 * One hop in the sequence: its kind (selecting the engine-coded threading logic) and which saved
 * workflow to fire, and how. The pure engine (chain-engine.ts) sequences on cursor + status alone
 * and reads none of these; the scan (chain-scan.ts) uses `kind` to pick the buildParams/capture
 * contract and `key`/`fresh`/`instanceId` to fire.
 */
export const ChainHop = Schema.Struct({
  // Selects the buildParams/capture contract in chain-hops.ts. Distinct from `key`: e.g. the
  // `revise` kind fires the `feature-pr` key but threads reviewFindings into its spec.
  kind: ChainHopKind,
  // Saved-workflow key this hop fires (resolved via WorkflowStore.get + toRequest).
  key: Schema.String,
  // Re-fire semantics: purge a terminal instance and re-run (a revise hop re-runs its feature-pr
  // instance fresh). Default false — attach to a RUNNING/PENDING instance, no-op a terminal one.
  fresh: Schema.optional(Schema.Boolean),
  // Instance id for this hop's run; when several hops share one (feature + revise share the branch)
  // they name the same instanceId. Absent → the engine derives one from the chain + hop index.
  instanceId: Schema.optional(Schema.String),
});
export type ChainHop = Schema.Schema.Type<typeof ChainHop>;

export const ChainStatus = Schema.Literal("scheduling", "running", "finalized");
export type ChainStatus = Schema.Schema.Type<typeof ChainStatus>;

/**
 * The persisted chain row (`chain:sub:<chainId>`), written only by workflow-svc — its fire path
 * (registration, hop advance) and the scan engine. Single-writer per key is structural, like
 * `watch:*`.
 *
 * `epoch` is the fence: bumped on every (re)schedule — registration and each hop advance — so an
 * engine action computed against an older incarnation re-reads the row and no-ops when its in-hand
 * epoch is stale. `cursor` indexes the hop currently running (its instance is `currentInstanceId`).
 */
export const ChainRow = Schema.Struct({
  chainId: Schema.String,
  epoch: Schema.Number,
  // The branch token and blackboard identity (Phase 1's slug); hops key their run off it.
  slug: Schema.String,
  // The sequence to run, in order. `cursor` points into it.
  hops: Schema.Array(ChainHop),
  strategy: ChainStrategy,
  // Present iff strategy is "loop-until-clean" — the loop body + iteration budget/counter.
  loop: Schema.optional(ChainLoop),
  // Optional wall-clock budget for the whole chain; on breach the current hop is terminated and the
  // chain finalizes budget-terminated. Absent → no chain-level budget (each hop may carry its own watch).
  budgetMs: Schema.optional(Schema.Number),
  // Index of the hop currently running / just fired. Starts at 0 when registration fires hop 0.
  cursor: Schema.Number,
  currentInstanceId: Schema.optional(Schema.String),
  // The shared-context blackboard threaded across hops (Phase 1's {slug, data}.data). Each hop reads
  // what it needs and writes what it produces; the engine captures hop outputs into it on advance.
  data: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  status: ChainStatus,
  // Last observed runtimeStatus of the current hop.
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
// not require a seed key). `maxEngineFiresPerDay` caps the engine's hop fires fail-closed (absent →
// uncapped, since a chain that can't advance is stuck, not dangerous, unlike an escalation).
export const ChainConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  maxEngineFiresPerDay: Schema.optional(Schema.Number),
});
export type ChainConfig = Schema.Schema.Type<typeof ChainConfig>;

// chain:ledger:<yyyy-mm-dd> — engine-written daily tallies. `hopsFired` counts every hop fired
// (registration's hop 0 + each engine advance); `chainsFinalized` counts terminal chains; `costUsd`
// accumulates hop costs at finalize.
export const ChainLedger = Schema.Struct({
  chainsRegistered: Schema.Number,
  hopsFired: Schema.Number,
  chainsFinalized: Schema.Number,
  costUsd: Schema.Number,
});
export type ChainLedger = Schema.Schema.Type<typeof ChainLedger>;

export const emptyChainLedger: ChainLedger = {
  chainsRegistered: 0,
  hopsFired: 0,
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
