import { WorkflowError } from "core";
import { Context, Effect, Option } from "effect";

import type { CronConfig, CronHeartbeat, CronLedger, CronRow } from "../models/cron.model.ts";
import type { DiscoverRow } from "../models/discover.model.ts";
import type { SchedRow } from "../models/schedule.model.ts";

/**
 * The cron registry store (docs/plans/workflow-watcher-registry.md §5) — the recur primitive's rows
 * under `cron:sub:*`, plus the `cron:config` kill switch, the `cron:__tick__` heartbeat, and the daily
 * `cron:ledger:<date>`. Sibling of IChainStore/IWatchStore; only workflow-svc writes these keys.
 * `cronId` is the coord tuple `<repo>:<slug>:<workflow>` (see cron.model.ts). The engine reads the
 * TARGET wf: row (goal handshake) through WfStore and the live instance through WorkflowInvoker — not
 * here — so this port stays the registry surface alone.
 */
export interface CronStoreService {
  readonly getRow: (cronId: string) => Effect.Effect<Option.Option<CronRow>, WorkflowError>;
  readonly listRows: () => Effect.Effect<readonly CronRow[], WorkflowError>;
  readonly saveRow: (row: CronRow) => Effect.Effect<void, WorkflowError>;
  readonly deleteRow: (cronId: string) => Effect.Effect<void, WorkflowError>;
  // Discovery rows (`cron:discover:<repo>:<label>`) — the fan-out sibling under the same registry
  // group; share the config/heartbeat/ledger below with the recur rows above.
  readonly getDiscoverRow: (id: string) => Effect.Effect<Option.Option<DiscoverRow>, WorkflowError>;
  readonly listDiscoverRows: () => Effect.Effect<readonly DiscoverRow[], WorkflowError>;
  readonly saveDiscoverRow: (row: DiscoverRow) => Effect.Effect<void, WorkflowError>;
  readonly deleteDiscoverRow: (id: string) => Effect.Effect<void, WorkflowError>;
  // Scheduled-fire rows (`cron:sched:<id>`) — the one-shot sibling under the same registry group
  // (fire ONCE at an absolute time); share the config/heartbeat/ledger below with the recur rows.
  readonly getSchedRow: (id: string) => Effect.Effect<Option.Option<SchedRow>, WorkflowError>;
  readonly listSchedRows: () => Effect.Effect<readonly SchedRow[], WorkflowError>;
  readonly saveSchedRow: (row: SchedRow) => Effect.Effect<void, WorkflowError>;
  readonly deleteSchedRow: (id: string) => Effect.Effect<void, WorkflowError>;
  readonly getConfig: () => Effect.Effect<Option.Option<CronConfig>, WorkflowError>;
  readonly getHeartbeat: () => Effect.Effect<Option.Option<CronHeartbeat>, WorkflowError>;
  readonly heartbeat: (beat: CronHeartbeat) => Effect.Effect<void, WorkflowError>;
  readonly getLedger: (date: string) => Effect.Effect<CronLedger, WorkflowError>;
  readonly bumpLedger: (
    date: string,
    delta: Partial<CronLedger>,
  ) => Effect.Effect<void, WorkflowError>;
}

export class CronStore extends Context.Tag("CronStore")<CronStore, CronStoreService>() {}
