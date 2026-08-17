import { Schema } from "effect";

/**
 * The `wf:` registry — one status row per RUN. Key: `wf:run:<instanceId>`.
 *
 * It was keyed by the artifact until 2026-08-17 (`wf:<repo>:<slug>:<workflow>`), which made a
 * re-run of the same workflow on the same slug OVERWRITE its predecessor. That was deliberate —
 * the row answered "what is the state of this workflow's work on this artifact" — but it carried a
 * latent flaw: two members in one chain STAGE sharing a `kind` derive the same artifact key and
 * silently clobber each other. Harmless while the chain read run status from Dapr; load-bearing the
 * moment this registry became a status source (which the local substrate needs, having no Dapr).
 *
 * The artifact key looked unavoidable because discovery dedup asks "have I ever dispatched work for
 * issue #123?" with no instance id in hand. It is avoidable: `issueInstanceId(n)` is a pure function
 * of the issue number and `discoverTrigger` already fires with it. The asker's having forgotten the
 * run is irrelevant — the id does not need remembering, it needs DERIVING, and h guarantees that
 * everywhere: instance ids are required-or-derived, NEVER Dapr-minted (`issueInstanceId(n)`,
 * `instanceIdAt(chainId, i)` = `<chainId>-w<i>`, `deriveInstanceId(key, now)`, or the caller's own).
 *
 * So rows are per-run, never overwritten, and each is STAMPED with the id of the primitive that
 * caused it. The stamp is free at write time — the thing that fires already knows what it is — and
 * it is what lets a run be traced back to the chain, cron, schedule or discovery that produced it
 * without an index.
 *
 * Written by the run ITSELF via the `write-wf-row` bookending activity (running before its steps,
 * done/failed after). Read by the chain/cron/discover engines by derived key. There is no `wf:index`
 * and there is deliberately no artifact→run alias: the pointer already exists on the primitive rows
 * (`CronRow`/`ChainRow.currentInstanceId`), and a secondary index would reintroduce exactly the
 * drift class that removing `__workflow_index__` eliminated.
 */

export const WfStatus = Schema.Literal("running", "done", "failed", "orphaned");
export type WfStatus = Schema.Schema.Type<typeof WfStatus>;

/**
 * The parent primitive that caused this run, if any. At most one applies — a run is fired by one
 * thing — but they are separate optional fields rather than a tagged union so a reader can ask
 * `row.chainId` without narrowing, and so an unknown future parent adds a field rather than a case.
 *
 * The load-bearing case is the watcher's usage-limit FALLBACK: it arms a `cron:sched` continuation,
 * a registry it does not own, and that continuation must INHERIT these stamps — otherwise a retry
 * silently detaches from the chain that started it.
 */
export const WfParentageFields = {
  /** The chain whose member this run is, plus which member. */
  chainId: Schema.optional(Schema.String),
  memberIndex: Schema.optional(Schema.Number),
  /** The recur cron that fired this run, plus which fire in its budget. */
  cronId: Schema.optional(Schema.String),
  fireSeq: Schema.optional(Schema.Number),
  /** The one-shot schedule that fired this run. */
  schedId: Schema.optional(Schema.String),
  /** The discovery cron that fanned this run out, plus the issue it came from. */
  discoverId: Schema.optional(Schema.String),
  issueNumber: Schema.optional(Schema.Number),
} as const;

// Fields + derived struct + same-name type — the `TriggerFields` / `Trigger` pattern from
// workflow.model.ts, so the fields can be SPREAD into WfRow while the shape stays nameable on its
// own (the write-wf-row activity takes one, and a fallback continuation has to carry one).
export const WfParentage = Schema.Struct(WfParentageFields);
export type WfParentage = Schema.Schema.Type<typeof WfParentage>;

export const WfRow = Schema.Struct({
  /** The run this row IS — the key, and the one field every reader derives. */
  instanceId: Schema.String,
  status: WfStatus,
  // Goal handshake (see the Cron primitive's goal/resolved contract in CLAUDE.md): the SUBJECT is
  // resolved (e.g. the PR merged) — distinct from run-status `done` (the steps finished). The
  // workflow reports it via a `goal: "RESOLVED"` field in its validated structured output that
  // write-wf-row records here; the cron engine READS it to deactivate. Never written by an engine.
  resolved: Schema.optional(Schema.Boolean),
  // The subject this run acted on. Optional since the re-key: a run with no repo/slug still gets a
  // row (its key needs only an instanceId), where the artifact key could not have addressed one.
  repo: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  workflow: Schema.optional(Schema.String),
  ...WfParentageFields,
  // the fire-time params the workflow ran with — its subject (pr / issue / …).
  subject: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  // the workflow's serialized output (step results incl. validated structured blocks), stamped on
  // the terminal write. This is what makes the row a STATUS SOURCE and not just an audit trail —
  // `IWorkflowInvoker.getStatus` returns status AND output, and a substrate without Dapr reads both
  // from here.
  output: Schema.optional(Schema.String),
  // ISO timestamp of this write.
  updatedAt: Schema.String,
});
export type WfRow = Schema.Schema.Type<typeof WfRow>;

/**
 * The subject identity a run carries — repo/slug/workflow. No longer part of the KEY (the run's
 * instanceId is), but still stamped on the row so a run can be traced to what it acted on.
 */
export const WfIdentity = Schema.Struct({
  repo: Schema.String,
  slug: Schema.String,
  workflow: Schema.String,
});
export type WfIdentity = Schema.Schema.Type<typeof WfIdentity>;

/** The state-store key for a row: `wf:run:<instanceId>`. */
export const wfRunKey = (instanceId: string): string => `wf:run:${instanceId}`;

/**
 * Build a run's subject identity from its params + workflow name. Still OPT-IN on repo+slug — but
 * what it gates changed: it used to decide whether a row could be KEYED at all, and now only
 * decides whether the row carries a subject. Whether every run should write a row regardless is a
 * real question this re-key opens and does not answer.
 *
 * *Revisit when:* chains without a repo need run status (increment 3) — that is the first caller
 * for which "no subject ⇒ no row" costs something rather than merely being tidy.
 */
export const wfIdentityFrom = (
  params: Record<string, unknown> | undefined,
  workflow: string,
): WfIdentity | undefined => {
  const seg = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const repo = seg(params?.repo);
  const slug = seg(params?.slug);
  if (!repo || !slug || !workflow) return undefined;
  return { repo, slug, workflow };
};

/**
 * The goal handshake: did this run report its SUBJECT resolved (e.g. the PR merged)?
 *
 * Distinct from run-status `done` (the steps finished) — a run can complete without the thing it
 * was working on being finished, which is the whole reason a cron keeps recurring. A workflow says
 * so with a `goal: "RESOLVED"` field in its validated structured output; this scans the step
 * envelopes for it and `write-wf-row` records the answer as `resolved`.
 *
 * Lives here rather than beside either executor because BOTH have to answer it identically: the
 * Dapr engine brackets its runs with this, and so does the local executor. A second copy would let
 * one substrate keep recurring while the other stopped. Pure and replay-safe; absent ⇒ false
 * (not resolved, keep recurring), never a guess.
 */
export function goalResolved(results: Record<string, unknown>): boolean {
  for (const value of Object.values(results)) {
    const structured = (value as { structured?: unknown } | null | undefined)?.structured;
    if (typeof structured !== "object" || structured === null) continue;
    if ((structured as { goal?: unknown }).goal === "RESOLVED") return true;
  }
  return false;
}
