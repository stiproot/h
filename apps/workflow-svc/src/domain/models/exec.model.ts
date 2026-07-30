import { Schema } from "effect";

/**
 * A denied-executor entry with PROVENANCE (docs/plans/impl/usage-limit-auto-deny.md): `operator`
 * entries come from `h agents deny` and never expire; `usage-limited` entries are written by
 * the watcher when a run finalizes usage-limited, carry an `until` expiry, and are the only
 * kind an automatic lift may touch — an auto action must never override an operator decision.
 * `cost-budget` entries (docs/plans/cost-containment.md A1) are the watcher's third kind:
 * written when an executor's tallied day spend crosses its `budgets` entry, expiring at the
 * next UTC midnight (when the day ledger the tally reads resets).
 */
export const DeniedEntry = Schema.Struct({
  name: Schema.String,
  reason: Schema.Literal("operator", "usage-limited", "cost-budget"),
  deniedAt: Schema.String,
  until: Schema.optional(Schema.String),
});
export type DeniedEntry = Schema.Schema.Type<typeof DeniedEntry>;

/**
 * The executor policy row — the `exec:` registry's single row, `exec:config`
 * (docs/plans/live-state-containment.md §2.3). `denied` holds entries (above) OR bare
 * executor SHORTNAMES — the run activity's name minus its `run-` prefix (`codex`, `claude`,
 * `kimi`, `dapr-agent`, …) — the pre-provenance shape, still accepted on read and normalized
 * to operator entries (exec-policy.ts `normalizeDenied`); writes always use entries. An
 * absent row or an empty list allows everything — the row is an operator instrument ("no
 * codex tonight") plus the watcher's automatic fence, not a default gate. Only workflow-svc
 * writes it (POST /exec/policy, the watcher's auto-deny), like every other registry.
 */
export const ExecPolicy = Schema.Struct({
  denied: Schema.Array(Schema.Union(Schema.String, DeniedEntry)),
  updatedAt: Schema.String,
  // Per-executor daily cost budgets in USD, keyed by SHORTNAME (docs/plans/cost-containment.md
  // A1): when the watcher's finalization tally for the day crosses one, it writes an expiring
  // `cost-budget` deny entry. Optional so pre-budget rows decode; absent ⇒ no budgets.
  budgets: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Number })),
});
export type ExecPolicy = Schema.Schema.Type<typeof ExecPolicy>;

/** The one statestore key of the `exec:` registry. */
export const EXEC_POLICY_KEY = "exec:config";
