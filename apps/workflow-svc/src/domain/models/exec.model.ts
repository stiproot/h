import { Schema } from "effect";

/**
 * The executor policy row — the `exec:` registry's single row, `exec:config`
 * (docs/plans/live-state-containment.md §2.3). `denied` holds executor SHORTNAMES: the run
 * activity's name minus its `run-` prefix (`codex`, `claude`, `openhands`, `pi`,
 * `dapr-agent`, …). An absent row or an empty list allows everything — the row is an operator
 * instrument ("no codex tonight"), not a default gate. Only workflow-svc writes it
 * (POST /exec/policy), like every other registry.
 */
export const ExecPolicy = Schema.Struct({
  denied: Schema.Array(Schema.String),
  updatedAt: Schema.String,
});
export type ExecPolicy = Schema.Schema.Type<typeof ExecPolicy>;

/** The one statestore key of the `exec:` registry. */
export const EXEC_POLICY_KEY = "exec:config";
