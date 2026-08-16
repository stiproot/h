import type { WorkflowActivityContext } from "@dapr/dapr";

import { registerDiscover } from "engine-core";
import type { WatchPolicy } from "engine-core";
import { runActivity } from "../activity-runtime.ts";

/**
 * Registers a DISCOVERY cron from inside a (provision) workflow — the `arm-*` pattern applied to the
 * standing patrol. A discovery cron has no natural host
 * run, so `h cron discover add` fires a one-step provision workflow whose sole step is this activity;
 * its `wf:` bracket audits whether the patrol was actually armed. Sibling of `register-cron` /
 * `write-wf-row`: runs on workflow-svc, calls the same `registerDiscover` the deleted `POST
 * /cron/discover` handler used — single-writer intact.
 *
 * LOUD on failure: the patrol IS the point of the run, so a registration failure throws → the closing
 * `wf:failed` bracket records it.
 */
type Input = {
  repo: string;
  label: string;
  /** The saved key fired per discovered issue (e.g. "implement-pr"). */
  workflow: string;
  cadence: string;
  maxFiresPerDay?: number;
  /** Extra params merged into every fired run (e.g. fire-time identity). */
  fireParams?: Record<string, unknown>;
  /** Watch policy attached to every fired run — the watcher supervises each feature-pr so a hung run
   * is terminated (and optionally retried) rather than stalling the discovery cron's serialize. */
  watch?: WatchPolicy;
  traceparent?: string;
};

export async function registerDiscoverActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<{ discoverId: string; active: boolean }> {
  const { repo, label, workflow, cadence, maxFiresPerDay, fireParams, watch, traceparent } =
    input as Input;
  return runActivity(
    registerDiscover({
      repo,
      label,
      cadence,
      ...(maxFiresPerDay !== undefined ? { gates: { maxFiresPerDay } } : {}),
      // The activity input is the CLI wire (h cron discover add); the row embeds it as its
      // fire-descriptor TEMPLATE: workflow → key, fireParams → params.
      trigger: {
        key: workflow,
        ...(fireParams ? { params: fireParams } : {}),
        ...(watch ? { watch } : {}),
      },
    }),
    traceparent,
  );
}
