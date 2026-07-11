import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect } from "effect";

import type { WfIdentity, WfStatus } from "../../domain/models/wf.model.ts";
import { WfStore } from "../../domain/ports/IWfStore.ts";
import { runActivity } from "../activity-runtime.ts";

type Input = {
  wf: WfIdentity;
  status: WfStatus;
  instanceId: string;
  subject?: Record<string, unknown>;
  output?: string;
  traceparent?: string;
};

/**
 * Writes the run's OWN `wf:<repo>:<slug>:<workflow>` status row
 * (docs/plans/workflow-watcher-registry.md §3). generic.workflow calls this to bracket a
 * wf-identified run — `running` before its steps, `done`/`failed` after — so the workflow
 * self-reports its status (via its own activity, which runs on workflow-svc, so an executor's MCP
 * surface is irrelevant).
 *
 * Best-effort: a state-write hiccup must NEVER fail the workflow (like the run ledger). The effect
 * is ignored, so a missed write leaves a stale row — a READ concern (the reader marks it orphaned),
 * not a run failure.
 */
export async function writeWfRowActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<void> {
  const { wf, status, instanceId, subject, output, traceparent } = input as Input;
  await runActivity(
    Effect.gen(function* () {
      const store = yield* WfStore;
      yield* store.saveRow({
        ...wf,
        status,
        instanceId,
        subject,
        output,
        updatedAt: new Date().toISOString(),
      });
    }).pipe(Effect.ignore),
    traceparent,
  );
}
