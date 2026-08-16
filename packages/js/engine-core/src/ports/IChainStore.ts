import type { WorkflowError } from "core";
import { Context, type Effect, type Option } from "effect";

import type { ChainConfig, ChainHeartbeat, ChainLedger, ChainRow } from "../models/chain.model.ts";
import type { RunMirrorMeta } from "../models/watch.model.ts";

/**
 * The chain-registry port, sibling of IWatchStore: `chain:sub:<chainId>` rows + `chain:index`, the
 * `chain:config` kill switch, the `chain:__tick__` heartbeat, the daily `chain:ledger:<date>`, and
 * read-only access to the `run:` mirrors for the cost tally (a chain's cost sums every workflow's runs).
 * A missing row/config is `Option.none`, not a failure. All writes to `chain:*` go through this port
 * and only workflow-svc holds it — single-writer per key is structural.
 */
export interface ChainStoreService {
  readonly getRow: (chainId: string) => Effect.Effect<Option.Option<ChainRow>, WorkflowError>;
  readonly listRows: () => Effect.Effect<readonly ChainRow[], WorkflowError>;
  readonly saveRow: (row: ChainRow) => Effect.Effect<void, WorkflowError>;
  readonly deleteRow: (chainId: string) => Effect.Effect<void, WorkflowError>;
  readonly getConfig: () => Effect.Effect<Option.Option<ChainConfig>, WorkflowError>;
  readonly getHeartbeat: () => Effect.Effect<Option.Option<ChainHeartbeat>, WorkflowError>;
  readonly heartbeat: (beat: ChainHeartbeat) => Effect.Effect<void, WorkflowError>;
  /** Zeroed ledger when the day has no entry yet. */
  readonly getLedger: (date: string) => Effect.Effect<ChainLedger, WorkflowError>;
  readonly bumpLedger: (
    date: string,
    delta: Partial<ChainLedger>,
  ) => Effect.Effect<void, WorkflowError>;
  /** All `run:` mirror keys from `runs:index` (for the prefix-match cost tally). */
  readonly listRunKeys: () => Effect.Effect<readonly string[], WorkflowError>;
  /** The cost-relevant slice of one `run:<runId>` mirror (see IWatchStore.getRunMeta). */
  readonly getRunMeta: (key: string) => Effect.Effect<RunMirrorMeta | null, WorkflowError>;
}

/** Service tag for the chain store. Yield it to call: `const cs = yield* ChainStore`. */
export class ChainStore extends Context.Tag("ChainStore")<ChainStore, ChainStoreService>() {}
