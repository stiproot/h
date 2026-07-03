import type { WorkflowError } from "core";
import { Context, type Effect, type Option } from "effect";

import type { StoredWorkflow } from "../models/workflow.model.ts";

/**
 * The saved-workflow store port. A missing key is `Option.none`, not a failure — the
 * not-found path stays out of the error channel and maps to 404 at the HTTP boundary.
 * Failures are always `WorkflowError` (from `core`), carrying the workflow key in
 * `instanceId` and the raw SDK failure in `cause`.
 */
export interface WorkflowStoreService {
  readonly save: (key: string, workflow: StoredWorkflow) => Effect.Effect<void, WorkflowError>;
  readonly get: (key: string) => Effect.Effect<Option.Option<StoredWorkflow>, WorkflowError>;
  readonly list: () => Effect.Effect<readonly string[], WorkflowError>;
  /** Saved workflows that carry a schedule, paired with their key. */
  readonly listScheduled: () => Effect.Effect<
    ReadonlyArray<{ key: string; workflow: StoredWorkflow }>,
    WorkflowError
  >;
  /** Stamps a workflow's schedule with the time it was last triggered. */
  readonly markRun: (key: string, lastRunAt: string) => Effect.Effect<void, WorkflowError>;
}

/** Service tag for the store. Yield it to call: `const store = yield* WorkflowStore`. */
export class WorkflowStore extends Context.Tag("WorkflowStore")<
  WorkflowStore,
  WorkflowStoreService
>() {}
