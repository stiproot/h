import {
  emptyLedger,
  type RunMirrorMeta,
  type WatchConfig,
  type WatchHeartbeat,
  WatchLedger,
  WatchRow,
  WatchStore,
} from "engine-core";
import { Effect, Layer, Option, Schema } from "effect";

import { listUnder, mergeCounters } from "./kv-helpers.ts";
import { BUCKETS, NatsKv } from "./nats-kv.ts";

/**
 * The watch registry over JetStream KV. Key shapes are the service substrate's, unchanged.
 *
 * It lands with the CRON increment rather than the watcher's, because `schedule-scan` fires through
 * `invokeWithWatch` — the shared fire choke point — so a host that runs the sched scan needs this
 * port whether or not a watcher is scanning the rows yet. Rows are only WRITTEN when a fire carries
 * a `watch` policy, so until the watcher exists this mostly satisfies a requirement rather than
 * accumulating state.
 *
 * `listRunKeys`/`getRunMeta` are the exception, and they are deliberately EMPTY here. They read the
 * `run:` mirrors, which exist so workflow-svc can see the run ledger over Dapr; on this substrate
 * the ledger is on local disk and the cost tally reads it directly. Answering "no mirrors" is
 * truthful — there are none — and the callers (the watcher's cost tally) treat a miss as a cost GAP
 * rather than as zero, which is the honest reading.
 */

const rowKey = (instanceId: string) => `watch:sub:${instanceId}`;
const CONFIG_KEY = "watch:config";
const TICK_KEY = "watch:__tick__";
const ledgerKey = (date: string) => `watch:ledger:${date}`;

export const NatsWatchStoreLive: Layer.Layer<WatchStore, never, NatsKv> = Layer.effect(
  WatchStore,
  Effect.gen(function* () {
    const kv = yield* NatsKv;
    return {
      getRow: (instanceId) => kv.get(BUCKETS.watch, rowKey(instanceId), WatchRow),
      listRows: () => listUnder(kv, BUCKETS.watch, "watch:sub:", WatchRow),
      saveRow: (row) => kv.put(BUCKETS.watch, rowKey(row.instanceId), row),
      deleteRow: (instanceId) => kv.delete(BUCKETS.watch, rowKey(instanceId)),
      getConfig: () => kv.get(BUCKETS.watch, CONFIG_KEY, ConfigSchema),
      getHeartbeat: () => kv.get(BUCKETS.watch, TICK_KEY, HeartbeatSchema),
      heartbeat: (beat) => kv.put(BUCKETS.watch, TICK_KEY, beat),
      getLedger: (date) =>
        kv
          .get(BUCKETS.watch, ledgerKey(date), WatchLedger)
          .pipe(Effect.map(Option.getOrElse(() => emptyLedger))),
      bumpLedger: (date, delta) =>
        kv.get(BUCKETS.watch, ledgerKey(date), WatchLedger).pipe(
          Effect.map(Option.getOrElse(() => emptyLedger)),
          Effect.flatMap((current) =>
            kv.put(BUCKETS.watch, ledgerKey(date), mergeCounters(current, delta)),
          ),
        ),
      // See the header: there are no run: mirrors on this substrate, and saying so is truthful.
      listRunKeys: () => Effect.succeed([] as readonly string[]),
      getRunMeta: () => Effect.succeed(null as RunMirrorMeta | null),
    };
  }),
);

const ConfigSchema = Schema.Any as unknown as Schema.Schema<WatchConfig, unknown>;
const HeartbeatSchema = Schema.Any as unknown as Schema.Schema<WatchHeartbeat, unknown>;
