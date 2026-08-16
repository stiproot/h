/**
 * `engine-core` internals — the primitives half of the package: rows, ports, engines, the clock.
 *
 * A SEPARATE module from `index.ts` for one structural reason: the scan layer in this package
 * consumes these, and `index.ts` exports the scans. Importing the public barrel from inside would
 * make the package cyclic — legal in ESM, and exactly the shape `no-circular` exists to forbid. So
 * the scans import `./internal.ts` and the barrel re-exports both halves.
 *
 * h composes work one way and executes it two, and the two halves of that shared meaning live in
 * two packages. `workflow-core` owns what a DEFINITION means (token/`$ref` resolution, the output
 * contract, the step shapes). This package owns what an ENGINE acts on: the durable registry rows,
 * the ports an engine reaches its collaborators through, and the recurrence clock.
 *
 * Why it is a package and not part of workflow-svc: the five engines (watch, chain, cron, discover,
 * schedule) are pure `decide` functions over these rows. Nothing about them is Dapr, Redis, or
 * service-shaped — they were simply never lifted out of the one host that could reach them, so a
 * second execution substrate could not run them. Everything here is therefore host-agnostic by
 * construction: rows are data, ports are interfaces, and the concrete store/invoker/publisher
 * adapters live in whichever host is running.
 *
 * The parity guard (`scripts/check-runtime-parity.mjs`) fails the build if any of these symbols
 * grows a second definition elsewhere. Re-exporting is fine — a re-export cannot drift.
 */

// The registry rows: one module per registry prefix, each the shape its owning engine decides over.
export * from "./models/watch.model.ts"; // watch:  — supervision policy, rows, ledger
export * from "./models/chain.model.ts"; // chain:  — members, stages, strategy, threaded data
export * from "./models/cron.model.ts"; // cron:   — recurrence cadence, source, budget
export * from "./models/discover.model.ts"; // cron:discover: — source enumeration + fan-out gates
export * from "./models/schedule.model.ts"; // cron:sched:    — the one-shot scheduled fire
export * from "./models/wf.model.ts"; // wf:     — per-workflow status + the resolved goal flag
export * from "./models/exec.model.ts"; // exec:   — the executor policy (denies, budgets)

// The fire descriptor and the saved/stored workflow. These sit here rather than beside an HTTP
// router because an engine's whole action vocabulary is "fire this" — a Trigger is what a chain
// advance, a cron re-fire and a sched fire all produce. Re-exports `workflow-core`'s definition
// shapes so one import reaches every model an engine touches.
export * from "./models/workflow.model.ts";

// The ports: what an engine needs from its host. A host supplies one adapter set per port and the
// engines do not know which substrate they are on.
export * from "./ports/IWatchStore.ts";
export * from "./ports/IEventPublisher.ts";
export * from "./ports/IChainStore.ts";
export * from "./ports/ICronStore.ts";
export * from "./ports/IWfStore.ts";
export * from "./ports/IExecPolicyStore.ts";
export * from "./ports/ISourceReader.ts";
export * from "./ports/IWorkflowStore.ts";
export * from "./ports/IWorkflowInvoker.ts";

// The clock every recurrence primitive reads: is this cadence due, is this expression valid, when
// does this duration land.
export { assertValidCron, isDue, parseDurationMs, resolveFireAt } from "./scheduling.ts";

// The five ENGINES — one pure `decide` per primitive, each a per-tick state machine over its row:
// supervise (watch) · sequence (chain) · recur (cron) · fan out (discover) · fire once (sched).
// They are the reason this package exists. Each is named `decide` in its own module, so the barrel
// qualifies them by primitive; a host importing several would otherwise have five identical names.
export { decide as decideWatch, retryApplies, settle } from "./watch-engine.ts";
export type { WatchDecision } from "./watch-engine.ts";
export { decide as decideChain } from "./chain-engine.ts";
export type { ChainDecision, MemberObservation } from "./chain-engine.ts";
export { decide as decideCron, nextUnknownStreak } from "./cron-engine.ts";
export type { CronDecision } from "./cron-engine.ts";
export { decide as decideDiscover } from "./discover-engine.ts";
export type { DiscoverDecision } from "./discover-engine.ts";
export { decide as decideSchedule } from "./schedule-engine.ts";
export type { SchedDecision } from "./schedule-engine.ts";
