import { WorkflowError } from "core";
import { Context, type Effect, type Option } from "effect";

import type { ExecPolicy } from "../models/exec.model.ts";

/**
 * The executor-policy registry store (docs/plans/live-state-containment.md §2.3) — one row,
 * `exec:config`. Sibling of IWfStore in shape; only workflow-svc writes the key (the
 * POST /exec/policy route), everyone else reads. Read on every `run-*` activity dispatch by
 * the activity-registry gate; a failed read fails the activity (fail-closed — if the
 * statestore is down, nothing else works either).
 */
export interface ExecPolicyStoreService {
  readonly get: () => Effect.Effect<Option.Option<ExecPolicy>, WorkflowError>;
  readonly save: (policy: ExecPolicy) => Effect.Effect<void, WorkflowError>;
}

export class ExecPolicyStore extends Context.Tag("ExecPolicyStore")<
  ExecPolicyStore,
  ExecPolicyStoreService
>() {}
