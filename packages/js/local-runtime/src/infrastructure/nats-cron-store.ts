import {
  type CronConfig,
  type CronHeartbeat,
  CronLedger,
  CronRow,
  CronStore,
  DiscoverRow,
  SchedRow,
  emptyCronLedger,
} from "engine-core";
import { Effect, Layer, Option, Schema } from "effect";

import { BUCKETS, NatsKv } from "./nats-kv.ts";

/**
 * The cron registry over JetStream KV — recur rows, the discovery/fan-out rows, and the one-shot
 * scheduled fires, plus the config/heartbeat/ledger the three share.
 *
 * The key SHAPES are the service substrate's, unchanged (`cron:sub:<id>`, `cron:discover:<id>`,
 * `cron:sched:<id>`, `cron:config`, `cron:__tick__`, `cron:ledger:<date>`). Keeping them identical
 * is what lets one `cronId` and one set of engines address either substrate; the codec turns them
 * into legal KV keys and back.
 *
 * The index keys have no counterpart here — `cron:index`, `cron:discover-index` and
 * `cron:sched-index` exist because Redis cannot enumerate a prefix, and every write has to keep
 * them in step with the rows. The bucket enumerates itself, so `listRows` filters by prefix and
 * index/row drift is not a state this substrate can reach.
 *
 * NOTE on fencing: rows are saved with a plain put, exactly like the Dapr store, because the epoch
 * fence lives in the SCAN (`saveFenced` re-reads and compares) and is therefore shared by both
 * substrates. `NatsKv.putFenced` is the stronger primitive this substrate could use, and it stays
 * unused until the shared scan grows a fenced-save port method — a one-substrate fence would be a
 * behaviour difference dressed as an improvement.
 */

const rowKey = (id: string) => `cron:sub:${id}`;
const discoverKey = (id: string) => `cron:discover:${id}`;
const schedKey = (id: string) => `cron:sched:${id}`;
const CONFIG_KEY = "cron:config";
const TICK_KEY = "cron:__tick__";
const ledgerKey = (date: string) => `cron:ledger:${date}`;

/** Read every row under a prefix. Decoding is per row so one corrupt row cannot blank a listing. */
const listUnder = <A, I>(
  kv: NatsKv["Type"],
  prefix: string,
  schema: Schema.Schema<A, I>,
): Effect.Effect<readonly A[], never> =>
  kv.ids(BUCKETS.cron, prefix).pipe(
    Effect.flatMap((ids) =>
      Effect.forEach(ids, (id) => kv.get(BUCKETS.cron, id, schema), { concurrency: 8 }),
    ),
    Effect.map((rows) => rows.flatMap((row) => (Option.isSome(row) ? [row.value] : []))),
    // A listing that FAILS stops a whole scan tick; a listing that is short by one unreadable row
    // lets the other rows progress. The engines are already built for a row to be absent (that is
    // what `unknownStreak` is for), so degrading is strictly safer than aborting here.
    Effect.orElseSucceed(() => [] as readonly A[]),
  );

export const NatsCronStoreLive: Layer.Layer<CronStore, never, NatsKv> = Layer.effect(
  CronStore,
  Effect.gen(function* () {
    const kv = yield* NatsKv;

    return {
      getRow: (cronId) => kv.get(BUCKETS.cron, rowKey(cronId), CronRow),
      listRows: () => listUnder(kv, "cron:sub:", CronRow),
      // The id is DERIVED from the row's coords, mirroring the Dapr store's `idOf` — the row does
      // not carry its own key, so the two substrates must derive it identically or the same cron
      // lands under two keys.
      saveRow: (row) =>
        kv.put(BUCKETS.cron, rowKey(`${row.repo}:${row.slug}:${row.workflow}`), row),
      deleteRow: (cronId) => kv.delete(BUCKETS.cron, rowKey(cronId)),

      getDiscoverRow: (id) => kv.get(BUCKETS.cron, discoverKey(id), DiscoverRow),
      listDiscoverRows: () => listUnder(kv, "cron:discover:", DiscoverRow),
      saveDiscoverRow: (row) => kv.put(BUCKETS.cron, discoverKey(`${row.repo}:${row.label}`), row),
      deleteDiscoverRow: (id) => kv.delete(BUCKETS.cron, discoverKey(id)),

      getSchedRow: (id) => kv.get(BUCKETS.cron, schedKey(id), SchedRow),
      listSchedRows: () => listUnder(kv, "cron:sched:", SchedRow),
      saveSchedRow: (row) => kv.put(BUCKETS.cron, schedKey(row.id), row),
      deleteSchedRow: (id) => kv.delete(BUCKETS.cron, schedKey(id)),

      getConfig: () => kv.get(BUCKETS.cron, CONFIG_KEY, ConfigSchema),
      getHeartbeat: () => kv.get(BUCKETS.cron, TICK_KEY, HeartbeatSchema),
      heartbeat: (beat) => kv.put(BUCKETS.cron, TICK_KEY, beat),

      // A day with no entry is a ZEROED ledger, not an absent one: every caller adds to it, and
      // "no runs today" and "no ledger today" are the same fact on the first tick after midnight.
      getLedger: (date) =>
        kv
          .get(BUCKETS.cron, ledgerKey(date), CronLedger)
          .pipe(Effect.map(Option.getOrElse(() => emptyCronLedger))),
      bumpLedger: (date, delta) =>
        kv.get(BUCKETS.cron, ledgerKey(date), CronLedger).pipe(
          Effect.map(Option.getOrElse(() => emptyCronLedger)),
          Effect.flatMap((current) => kv.put(BUCKETS.cron, ledgerKey(date), merge(current, delta))),
        ),
    };
  }),
);

/** Numeric fields add; everything else is replaced. The Dapr store's rule, restated over KV. */
const merge = (current: CronLedger, delta: Partial<CronLedger>): CronLedger => {
  const next: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(delta)) {
    const held = (current as Record<string, unknown>)[field];
    next[field] =
      typeof value === "number" && typeof held === "number" ? held + value : (value as unknown);
  }
  return next as CronLedger;
};

// The config and heartbeat rows are plain records on the wire; engine-core exposes them as types
// rather than schemas, so decoding is structural here.
const ConfigSchema = Schema.Any as unknown as Schema.Schema<CronConfig, unknown>;
const HeartbeatSchema = Schema.Any as unknown as Schema.Schema<CronHeartbeat, unknown>;
