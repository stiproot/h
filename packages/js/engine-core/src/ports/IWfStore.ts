import type { WorkflowError } from "core";
import { Context, type Effect, type Option } from "effect";

import type { WfIdentity, WfRow } from "../models/wf.model.ts";

/**
 * The `wf:` registry port — per-workflow status rows keyed `wf:<repo>:<slug>:<workflow>`. Read by
 * exact key (enumeration is GitHub, not a shared index, so there is no `list`); each row is written
 * ONLY by the workflow it names. A missing row is `Option.none`; failures are `WorkflowError`.
 */
export interface WfStoreService {
  readonly getRow: (id: WfIdentity) => Effect.Effect<Option.Option<WfRow>, WorkflowError>;
  readonly saveRow: (row: WfRow) => Effect.Effect<void, WorkflowError>;
}

export class WfStore extends Context.Tag("WfStore")<WfStore, WfStoreService>() {}
