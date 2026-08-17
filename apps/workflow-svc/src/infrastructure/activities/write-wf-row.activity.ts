import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect } from "effect";

import type { WfIdentity, WfParentage, WfStatus } from "engine-core";
import { WfStore } from "engine-core";
import { runActivity } from "../activity-runtime.ts";

type Input = {
  /** The subject this run acted on. Optional since the re-key — the row is keyed by the run. */
  wf?: WfIdentity;
  /** The primitive that caused this run: chainId / cronId / schedId / discoverId + their ordinals. */
  parent?: WfParentage;
  status: WfStatus;
  instanceId: string;
  subject?: Record<string, unknown>;
  output?: string;
  // The goal handshake (§6): the subject is resolved (e.g. the PR merged) — the cron engine reads it.
  resolved?: boolean;
  traceparent?: string;
};

/**
 * Writes the run's OWN `wf:run:<instanceId>` status row. generic.workflow calls this to bracket a
 * run — `running` before its steps, `done`/`failed` after — so the workflow self-reports its status
 * (via its own activity, which runs on workflow-svc, so an executor's MCP surface is irrelevant).
 *
 * Since the 2026-08-17 re-key the row is keyed by the RUN, so a re-run never overwrites its
 * predecessor and the subject (repo/slug/workflow) rides as fields rather than as the key. The
 * PARENT stamp is what lets a run be traced back to the chain/cron/schedule/discovery that caused
 * it without an index — and it must be inherited by a watcher fallback continuation, or a retry
 * silently detaches from the chain that started it.
 *
 * Best-effort: a state-write hiccup must NEVER fail the workflow (like the run ledger). The effect
 * is ignored, so a missed write leaves a stale row — a READ concern (the reader marks it orphaned),
 * not a run failure.
 */
export async function writeWfRowActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<void> {
  const { wf, parent, status, instanceId, subject, output, resolved, traceparent } = input as Input;
  await runActivity(
    Effect.gen(function* () {
      const store = yield* WfStore;
      yield* store.saveRow({
        ...wf,
        ...parent,
        status,
        instanceId,
        subject,
        output,
        ...(resolved !== undefined ? { resolved } : {}),
        updatedAt: new Date().toISOString(),
      });
    }).pipe(Effect.ignore),
    traceparent,
  );
}
