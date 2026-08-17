import type { WorkflowError } from "core";
import { Context, type Effect, type Option } from "effect";

import type { WfRow } from "../models/wf.model.ts";

/**
 * The `wf:` registry port — one status row per RUN, keyed `wf:run:<instanceId>`.
 *
 * Read by DERIVED key, never enumerated: every caller can compute the instance id it wants
 * (`issueInstanceId(n)`, `<chainId>-w<i>`, a cron row's `currentInstanceId`), which is what let the
 * registry drop its artifact key on 2026-08-17. There is no `list` and no artifact→run alias — see
 * wf.model.ts for why the pointer on the primitive rows is enough.
 *
 * A missing row is `Option.none`, never a failure: "this run wrote nothing yet" is an ordinary
 * answer that a substrate without Dapr has to be able to give.
 */
export interface WfStoreService {
  readonly getRun: (instanceId: string) => Effect.Effect<Option.Option<WfRow>, WorkflowError>;
  readonly saveRow: (row: WfRow) => Effect.Effect<void, WorkflowError>;
}

export class WfStore extends Context.Tag("WfStore")<WfStore, WfStoreService>() {}
