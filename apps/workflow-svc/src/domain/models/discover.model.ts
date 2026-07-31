import { Schema } from "effect";

import { WatchPolicy } from "./watch.model.ts";
import { WorkflowParams, type Trigger } from "./workflow.model.ts";

/**
 * The DISCOVERY cron's data shapes — the fan-out sibling
 * of the recur cron (cron.model.ts). Where a recur cron RE-FIRES one workflow (fixed `wf:` identity)
 * until its goal resolves, a discovery cron ENUMERATES a source each due tick and fires ONE workflow
 * PER newly-discovered item, deduping against the `wf:*` keys. It has no single `wf:` identity and no
 * `resolved` handshake — it never resolves; it drains a label class, bounded by a daily fire cap, and
 * runs until manually disarmed. Same registry group (`cron:*`), same tick, same config/heartbeat/
 * ledger; a DISTINCT row shape under `cron:discover:<repo>:<label>`. Single-writer: workflow-svc.
 */

// active = discovering on the clock; inactive = disarmed. Closed literal so an unknown status fails.
export const DiscoverStatus = Schema.Literal("active", "inactive");
export type DiscoverStatus = Schema.Schema.Type<typeof DiscoverStatus>;

// Source mode: github-issues enumerates OPEN issues on `repo` carrying `label` (the row's coords). A
// single-variant union today — the union point for future enumerating sources (e.g. a project board).
export const DiscoverSource = Schema.Struct({
  mode: Schema.Literal("github-issues"),
});
export type DiscoverSource = Schema.Schema.Type<typeof DiscoverSource>;

// Gates on the fan-out. `maxFiresPerDay` is the runaway backstop for a busy label class (resets daily,
// tallied on `cron:ledger:<date>.discoveryFires`). Concurrency is fixed at 1 (serialize): the row's
// in-flight guard IS the bound, so a `maxConcurrent` field is deferred until a >1 use-case lands (it
// needs a `wf:*` live-count, which the exact-key-only registry doesn't support).
export const DiscoverGates = Schema.Struct({
  maxFiresPerDay: Schema.Number,
});
export type DiscoverGates = Schema.Schema.Type<typeof DiscoverGates>;

/**
 * The persisted discovery row (`cron:discover:<repo>:<label>`), written ONLY by workflow-svc — its
 * registration path and the scan engine. `epoch` fences overlapping ticks; `fires` is the lifetime
 * fan-out count (distinct from the daily-cap tally on the ledger). The engine reads the last-fired
 * instance's live status for the in-flight guard (serialize) and the fired workflow's own `wf:` row
 * for dedup; it never writes `wf:*`.
 */
export const DiscoverRow = Schema.Struct({
  // Coords + query: the GitHub repo (owner/name — also the fired runs' wf-identity repo) and the label.
  repo: Schema.String,
  label: Schema.String,
  // What to fire per discovered issue (a saved key, e.g. "implement-pr").
  workflow: Schema.String,
  status: DiscoverStatus,
  // 5-field cron expression (UTC): the source is read when isDue since lastRunAt (else createdAt).
  cadence: Schema.String,
  source: DiscoverSource,
  gates: DiscoverGates,
  // Extra params merged into every fire (e.g. fire-time identity: runActivity/agentId/model). `slug`,
  // `repo`, and `issueNumber` are supplied per-issue by the engine and win over these.
  fireParams: Schema.optional(WorkflowParams),
  // Watch policy attached to every fired run: supervises each
  // feature-pr so a hung run is terminated by the watcher engine rather than stalling the discovery
  // cron on its serialize (in-flight) guard forever. Optional — omit to fire unsupervised.
  watch: Schema.optional(WatchPolicy),
  // Epoch fence — bumped on every re-registration and every fire, so a stale scan decision no-ops.
  epoch: Schema.Number,
  // Lifetime fan-out count (observability; the daily cap lives on the ledger).
  fires: Schema.Number,
  // The instance the LAST fire ran under; the in-flight guard reads its live status (serialize = don't
  // fire while it is live). Absent before the first fire.
  currentInstanceId: Schema.optional(Schema.String),
  // The issue number the last fire targeted (observability).
  lastFiredIssue: Schema.optional(Schema.Number),
  lastRunAt: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  endedAt: Schema.optional(Schema.String),
});
export type DiscoverRow = Schema.Schema.Type<typeof DiscoverRow>;

// (A discovery cron is registered by the register-discover ACTIVITY inside a provision workflow — §10,
// crons via activities — so there is no HTTP request body schema here anymore.)

/** The store id (index/key suffix) for a discovery cron: `<repo>:<label>`. */
export const discoverId = (id: { repo: string; label: string }): string => `${id.repo}:${id.label}`;

/** Deterministic issue → slug (Decision §3): the `wf:` slug + fire params key an issue's run. */
export const issueSlug = (issueNumber: number): string => `issue-${issueNumber}`;

/** Deterministic fixed instance id for a discovered issue's run (matches the retired sweep's naming). */
export const issueInstanceId = (issueNumber: number): string => `feature-issue-${issueNumber}`;

/**
 * The row is a fire-descriptor TEMPLATE: instantiate the per-issue Trigger the scan hands to the
 * fire choke point — deterministic slug/instance per issue (the row's persisted names
 * `workflow`/`fireParams` predate the descriptor; this projection is where they become one).
 * The engine-supplied identity params (repo/slug/issueNumber) win over the row's fireParams.
 */
export function discoverTrigger(
  row: Pick<DiscoverRow, "repo" | "workflow" | "fireParams" | "watch">,
  issueNumber: number,
): Trigger & { readonly key: string; readonly instanceId: string; readonly workspaceId: string } {
  const instanceId = issueInstanceId(issueNumber);
  return {
    key: row.workflow,
    params: {
      ...row.fireParams,
      repo: row.repo,
      slug: issueSlug(issueNumber),
      issueNumber: String(issueNumber),
    },
    instanceId,
    workspaceId: instanceId,
    ...(row.watch ? { watch: row.watch } : {}),
  };
}
