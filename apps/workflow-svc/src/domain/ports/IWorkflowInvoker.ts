import type { WorkflowError } from "core";
import { Context, type Effect } from "effect";

import type { WorkflowRequest, WorkflowStatus } from "../models/workflow.model.ts";

/**
 * The workflow-invocation port. Failures are always `WorkflowError` (from `core`); the raw
 * SDK/HTTP failure rides in its `cause`.
 *
 * `getStatus` deliberately KEEPS the legacy silent fallback: a non-ok status response reads
 * as `runtimeStatus: "UNKNOWN"` in the success channel, never an error — `invoke`'s
 * reuse/purge decision and the status route both depend on that flag (see the Effect
 * refactor map, section 6). Only a transport/parse failure lands in the error channel.
 */
export interface WorkflowInvokerService {
  readonly invoke: (input: WorkflowRequest) => Effect.Effect<{ instanceId: string }, WorkflowError>;
  readonly getStatus: (instanceId: string) => Effect.Effect<WorkflowStatus, WorkflowError>;
}

/** Service tag for the invoker. Yield it to call: `const invoker = yield* WorkflowInvoker`. */
export class WorkflowInvoker extends Context.Tag("WorkflowInvoker")<
  WorkflowInvoker,
  WorkflowInvokerService
>() {}
