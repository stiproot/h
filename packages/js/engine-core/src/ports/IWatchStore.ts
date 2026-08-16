import type { WorkflowError } from "core";
import { Context, type Effect, type Option } from "effect";

import type {
  RunMirrorMeta,
  WatchConfig,
  WatchHeartbeat,
  WatchLedger,
  WatchRow,
} from "../models/watch.model.ts";

/**
 * The watch-registry port: `watch:sub:<instanceId>` rows + `watch:index`, the `watch:config`
 * kill switch, the `watch:__tick__` heartbeat, the daily `watch:ledger:<date>`, and read-only
 * access to the `run:` mirrors for the cost tally. A missing row/config is `Option.none`, not
 * a failure (the IWorkflowStore convention). All writes to `watch:*` go through this port and
 * only workflow-svc holds it — single-writer per key is structural (Decision 3).
 */
export interface WatchStoreService {
  readonly getRow: (instanceId: string) => Effect.Effect<Option.Option<WatchRow>, WorkflowError>;
  readonly listRows: () => Effect.Effect<readonly WatchRow[], WorkflowError>;
  readonly saveRow: (row: WatchRow) => Effect.Effect<void, WorkflowError>;
  readonly deleteRow: (instanceId: string) => Effect.Effect<void, WorkflowError>;
  readonly getConfig: () => Effect.Effect<Option.Option<WatchConfig>, WorkflowError>;
  readonly getHeartbeat: () => Effect.Effect<Option.Option<WatchHeartbeat>, WorkflowError>;
  readonly heartbeat: (beat: WatchHeartbeat) => Effect.Effect<void, WorkflowError>;
  /** Zeroed ledger when the day has no entry yet. */
  readonly getLedger: (date: string) => Effect.Effect<WatchLedger, WorkflowError>;
  readonly bumpLedger: (
    date: string,
    delta: Partial<WatchLedger>,
  ) => Effect.Effect<void, WorkflowError>;
  /** All `run:` mirror keys from `runs:index` (for the prefix-match cost tally). */
  readonly listRunKeys: () => Effect.Effect<readonly string[], WorkflowError>;
  /** The cost-relevant slice of one `run:<runId>` mirror (cost, stopReason, agentId, kind);
   *  null when the mirror is absent. One read serves the cost tally, the gap accounting, and
   *  the usage-limit refinement. */
  readonly getRunMeta: (key: string) => Effect.Effect<RunMirrorMeta | null, WorkflowError>;
}

/** Service tag for the watch store. Yield it to call: `const ws = yield* WatchStore`. */
export class WatchStore extends Context.Tag("WatchStore")<WatchStore, WatchStoreService>() {}
