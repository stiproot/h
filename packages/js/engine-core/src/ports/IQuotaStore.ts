import { WorkflowError } from "core";
import { Context, type Effect, type Option } from "effect";

import type { QuotaRow } from "../models/quota.model.ts";

/**
 * The `quota:` registry store — one row per executor, `quota:<executor>`. Sibling of
 * IExecPolicyStore in shape. Read by the pre-fire gate on every `run-*` dispatch (both substrates)
 * and by `h agents list`; written by the substrate's HOST from what a run's ledger reported (the
 * watcher on the service side, the agent adapter on the local side).
 */
export interface QuotaStoreService {
  readonly get: (executor: string) => Effect.Effect<Option.Option<QuotaRow>, WorkflowError>;
  readonly list: () => Effect.Effect<readonly QuotaRow[], WorkflowError>;
  readonly save: (row: QuotaRow) => Effect.Effect<void, WorkflowError>;
}

export class QuotaStore extends Context.Tag("QuotaStore")<QuotaStore, QuotaStoreService>() {}
