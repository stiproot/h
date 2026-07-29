import { Schema } from "effect";

/**
 * The `wf:` registry — one per-workflow status row per (repo, slug, workflow).
 * Key: `wf:<repo>:<slug>:<workflow>` (docs/plans/impl/workflow-watcher-registry.md §3). The workflow
 * NAME is the leaf, and the workflow that names the row is its SOLE writer — single-writer is a
 * property of the key structure (no shared key ⇒ no lost-update race), which is what lets many
 * workflows track the same (repo, slug) target without an actor.
 *
 * Written by the workflow ITSELF via the `write-wf-row` bookending activity (running before its
 * steps, done/failed after) — the activity runs on workflow-svc, so an executor's MCP surface is
 * irrelevant. Read by the chain/cron engines by exact key. Enumeration is GitHub, not a shared
 * index, so there is no `wf:index`.
 */

export const WfStatus = Schema.Literal("running", "done", "failed", "orphaned");
export type WfStatus = Schema.Schema.Type<typeof WfStatus>;

export const WfRow = Schema.Struct({
  // owner/name — the target repo (multi-repo portability; part of the key).
  repo: Schema.String,
  // the artifact through-line: the feature/<slug> branch tying issue → branch → PR (part of the key).
  slug: Schema.String,
  // the workflow name (its saved key) — the leaf of the key and the row's SOLE writer.
  workflow: Schema.String,
  status: WfStatus,
  // Goal handshake (docs/plans/impl/workflow-watcher-registry.md §6, decision (b)): the SUBJECT is resolved
  // (e.g. the PR merged) — distinct from run-status `done` (the steps finished). The workflow reports
  // it via a `goal: "RESOLVED"` field in its validated structured output (structured-workflow-outputs)
  // that write-wf-row records here; the cron engine READS it to deactivate. Absent/false = not yet
  // resolved (keep recurring). Never written by any engine.
  resolved: Schema.optional(Schema.Boolean),
  // the Dapr workflow instance backing this run.
  instanceId: Schema.String,
  // the fire-time params the workflow ran with — its subject (pr / issue / …).
  subject: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  // the workflow's serialized output (step results incl. validated structured blocks), stamped on the terminal write.
  output: Schema.optional(Schema.String),
  // ISO timestamp of this write.
  updatedAt: Schema.String,
});
export type WfRow = Schema.Schema.Type<typeof WfRow>;

/** The wf-identity a run carries so it can write its own row: the three key segments. */
export const WfIdentity = Schema.Struct({
  repo: Schema.String,
  slug: Schema.String,
  workflow: Schema.String,
});
export type WfIdentity = Schema.Schema.Type<typeof WfIdentity>;

/** The state-store key for a row: `wf:<repo>:<slug>:<workflow>`. */
export const wfKey = (id: WfIdentity): string => `wf:${id.repo}:${id.slug}:${id.workflow}`;

/**
 * Build a run's wf-identity from its params + workflow name — workflow-svc owns key construction
 * (docs/plans/impl/workflow-watcher-registry.md §3c), so the two fire paths (run-route by saved key,
 * chain-scan by kind) share this one function. OPT-IN: returns undefined unless BOTH `repo`
 * (owner/name) and `slug` are present and non-empty, so a run with no identity writes no row.
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
