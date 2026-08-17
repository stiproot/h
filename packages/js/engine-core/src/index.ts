/**
 * `engine-core` — substrate-independent ENGINE semantics.
 *
 * h composes work one way and executes it two, and the two halves of that shared meaning live in
 * two packages. `workflow-core` owns what a DEFINITION means (token/`$ref` resolution, the output
 * contract, the step shapes). This package owns everything an ENGINE is: the durable registry rows,
 * the ports it reaches its collaborators through, the pure `decide` per primitive, and the per-tick
 * SCAN that walks a registry and turns decisions into effects.
 *
 * Why it is a package and not part of workflow-svc: none of it is Dapr-, Redis- or service-shaped.
 * Rows are data, ports are interfaces, `decide` is pure, and a scan reaches every collaborator
 * through a port — so the only thing that ever tied this to one process was its address. A HOST
 * supplies the adapter set (workflow-svc: Dapr + Redis) and runs the scans on a clock; the engines
 * never learn which substrate they are on.
 *
 * Two barrels, one package: `internal.ts` is the primitives half, imported by the scans here;
 * this file re-exports both. The split exists so the package is not cyclic.
 *
 * The parity guard (`scripts/check-runtime-parity.mjs`) fails the build if any of these symbols
 * grows a second definition elsewhere. Re-exporting is fine — a re-export cannot drift.
 */

// The primitives: rows, ports, the five `decide` functions, the recurrence clock.
export * from "./internal.ts";

// The SCANS — one per primitive. Each is the same shape: read the registry, ask `decide`, act
// through the closed vocabulary, record. They also own the REGISTRATION seams, because when a row
// is written is an ordering question the primitive owns (a watch registers BEFORE its run, since
// supervision must precede what it supervises; a cron arms AFTER, from the run's closing bracket).
export {
  type ChainRegistration,
  type ChainScanEnv,
  type ChainScanReport,
  disarmChain,
  type DisarmChainError,
  instanceIdAt,
  registerChainForFire,
  scanChainsEffect,
  tallyChainCost,
} from "./chain-scan.ts";
export {
  type CronRegistration,
  type CronScanEnv,
  type CronScanReport,
  disarmCron,
  type DisarmCronError,
  disarmEventEffect,
  planCron,
  registerCronForFire,
  scanCronsEffect,
} from "./cron-scan.ts";
export type { CronPlan, RegisterCronInput } from "./cron-scan.ts";
export {
  type DiscoverRegistration,
  type DiscoverScanEnv,
  type DiscoverScanReport,
  discoverRegistrationFrom,
  registerDiscover,
  scanDiscoverEffect,
} from "./discover-scan.ts";
export type { DiscoverArmInput } from "./discover-scan.ts";
export {
  advanceSched,
  disarmSched,
  type DisarmSchedError,
  registerSchedForFire,
  type SchedRegistration,
  type SchedScanEnv,
  type SchedScanReport,
  scanSchedEffect,
} from "./schedule-scan.ts";
export {
  type CostTally,
  invokeWithWatch,
  refineUsageLimited,
  type RegisterOptions,
  registerWatchForFire,
  scanWatchesEffect,
  tallyCost,
  toResubmit,
  type WatchScanEnv,
  type WatchScanReport,
} from "./watch-scan.ts";

// The executor policy: which agents are fenced right now, and why. Read by the activity-registry
// gate at every fire, written by the watcher's two auto-fences.
export {
  activeDenial,
  DEFAULT_AUTO_DENY_MS,
  deniedMessage,
  endOfUtcDayIso,
  executorFromActivity,
  executorFromAgentId,
  isExecutorDenied,
  mergeAutoDeny,
  mergeBudgetDeny,
  normalizeDenied,
} from "./exec-policy.ts";
