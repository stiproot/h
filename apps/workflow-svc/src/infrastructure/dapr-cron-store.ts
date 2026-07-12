import { DaprClient } from "@dapr/dapr";
import { WorkflowError } from "core";
import { Effect, Layer, Option, Schema } from "effect";

import {
  CronConfig,
  CronHeartbeat,
  CronLedger,
  CronRow,
  emptyCronLedger,
} from "../domain/models/cron.model.ts";
import { DiscoverRow } from "../domain/models/discover.model.ts";
import { CronStore } from "../domain/ports/ICronStore.ts";

const STORE = "statestore";
// The cron registry's claimed prefix in the flat keyspace, sibling of `watch:`/`chain:` — rows, index,
// config, heartbeat, and daily ledgers all under `cron:`. Only workflow-svc writes these keys. The
// discovery cron (§9) is the fan-out sibling: its own row prefix + index under the same family, sharing
// config/heartbeat/ledger with the recur rows.
const ROW_PREFIX = "cron:sub:";
const INDEX_KEY = "cron:index";
const DISCOVER_ROW_PREFIX = "cron:discover:";
const DISCOVER_INDEX_KEY = "cron:discover-index";
const CONFIG_KEY = "cron:config";
const TICK_KEY = "cron:__tick__";
const LEDGER_PREFIX = "cron:ledger:";

const decodeRow = Schema.decodeUnknown(CronRow, { onExcessProperty: "preserve" });
const decodeDiscoverRow = Schema.decodeUnknown(DiscoverRow, { onExcessProperty: "preserve" });
const decodeConfig = Schema.decodeUnknown(CronConfig, { onExcessProperty: "preserve" });
const decodeHeartbeat = Schema.decodeUnknown(CronHeartbeat, { onExcessProperty: "preserve" });
const decodeLedger = Schema.decodeUnknown(CronLedger, { onExcessProperty: "preserve" });

/**
 * Live layer over the Dapr state API (Redis), mirroring dapr-chain-store.ts: DaprClient bracketed with
 * acquireRelease, missing keys read as ""/null → Option.none, a hand-rolled index key (Redis exposes no
 * enumeration through Dapr). `bumpLedger` is read-modify-write, safe because the scan is single-flight
 * (the cron tick) and registration writes come from this process.
 */
export const CronStoreLive: Layer.Layer<CronStore> = Layer.scoped(
  CronStore,
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new DaprClient()),
      (c) => Effect.promise(() => c.stop()).pipe(Effect.ignore),
    );

    const tryState = <A>(key: string, f: () => Promise<A>): Effect.Effect<A, WorkflowError> =>
      Effect.tryPromise({
        try: f,
        catch: (cause) => new WorkflowError({ cause, instanceId: key }),
      });

    const rawGet = (key: string): Effect.Effect<Option.Option<unknown>, WorkflowError> =>
      tryState(key, () => client.state.get(STORE, key)).pipe(
        Effect.map((result) =>
          result == null || (result as unknown) === "" ? Option.none() : Option.some(result),
        ),
      );

    const decodeSome = <A>(
      key: string,
      decoder: (value: unknown) => Effect.Effect<A, unknown>,
      value: Option.Option<unknown>,
    ): Effect.Effect<Option.Option<A>, WorkflowError> =>
      Option.isNone(value)
        ? Effect.succeed(Option.none())
        : decoder(value.value).pipe(
            Effect.map(Option.some),
            Effect.mapError((cause) => new WorkflowError({ cause, instanceId: key })),
          );

    // Index maintenance is identical for both row families (recur `cron:index`, discovery
    // `cron:discover-index`); parameterize by index key so the two share one implementation.
    const indexList = (indexKey: string): Effect.Effect<readonly string[], WorkflowError> =>
      tryState(indexKey, () => client.state.get(STORE, indexKey)).pipe(
        Effect.map((result) => (Array.isArray(result) ? (result as string[]) : [])),
      );

    const addToIndex = (indexKey: string, id: string): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        const ids = yield* indexList(indexKey);
        if (!ids.includes(id)) {
          yield* tryState(indexKey, () =>
            client.state.save(STORE, [{ key: indexKey, value: [...ids, id] }]),
          );
        }
      });

    const removeFromIndex = (indexKey: string, id: string): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        const ids = yield* indexList(indexKey);
        if (ids.includes(id)) {
          yield* tryState(indexKey, () =>
            client.state.save(STORE, [{ key: indexKey, value: ids.filter((x) => x !== id) }]),
          );
        }
      });

    const getRow = (id: string) =>
      rawGet(ROW_PREFIX + id).pipe(
        Effect.flatMap((value) => decodeSome(ROW_PREFIX + id, decodeRow, value)),
      );

    const listRows = (): Effect.Effect<readonly CronRow[], WorkflowError> =>
      Effect.gen(function* () {
        const ids = yield* indexList(INDEX_KEY);
        const rows = yield* Effect.forEach(ids, getRow, { concurrency: "unbounded" });
        return rows.flatMap((row) => (Option.isSome(row) ? [row.value] : []));
      });

    const idOf = (row: CronRow) => `${row.repo}:${row.slug}:${row.workflow}`;

    const saveRow = (row: CronRow): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        const id = idOf(row);
        yield* tryState(ROW_PREFIX + id, () =>
          client.state.save(STORE, [{ key: ROW_PREFIX + id, value: row }]),
        );
        yield* addToIndex(INDEX_KEY, id);
      });

    const deleteRow = (id: string): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        yield* tryState(ROW_PREFIX + id, () => client.state.delete(STORE, ROW_PREFIX + id));
        yield* removeFromIndex(INDEX_KEY, id);
      });

    // --- Discovery rows (cron:discover:*) — same shape of index-maintained CRUD as the recur rows. ---
    const getDiscoverRow = (id: string) =>
      rawGet(DISCOVER_ROW_PREFIX + id).pipe(
        Effect.flatMap((value) => decodeSome(DISCOVER_ROW_PREFIX + id, decodeDiscoverRow, value)),
      );

    const listDiscoverRows = (): Effect.Effect<readonly DiscoverRow[], WorkflowError> =>
      Effect.gen(function* () {
        const ids = yield* indexList(DISCOVER_INDEX_KEY);
        const rows = yield* Effect.forEach(ids, getDiscoverRow, { concurrency: "unbounded" });
        return rows.flatMap((row) => (Option.isSome(row) ? [row.value] : []));
      });

    const saveDiscoverRow = (row: DiscoverRow): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        const id = `${row.repo}:${row.label}`;
        yield* tryState(DISCOVER_ROW_PREFIX + id, () =>
          client.state.save(STORE, [{ key: DISCOVER_ROW_PREFIX + id, value: row }]),
        );
        yield* addToIndex(DISCOVER_INDEX_KEY, id);
      });

    const deleteDiscoverRow = (id: string): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        yield* tryState(DISCOVER_ROW_PREFIX + id, () =>
          client.state.delete(STORE, DISCOVER_ROW_PREFIX + id),
        );
        yield* removeFromIndex(DISCOVER_INDEX_KEY, id);
      });

    const getConfig = () =>
      rawGet(CONFIG_KEY).pipe(
        Effect.flatMap((value) => decodeSome(CONFIG_KEY, decodeConfig, value)),
      );

    const getHeartbeat = () =>
      rawGet(TICK_KEY).pipe(
        Effect.flatMap((value) => decodeSome(TICK_KEY, decodeHeartbeat, value)),
      );

    const heartbeat = (beat: CronHeartbeat): Effect.Effect<void, WorkflowError> =>
      tryState(TICK_KEY, () => client.state.save(STORE, [{ key: TICK_KEY, value: beat }]));

    const getLedger = (date: string): Effect.Effect<CronLedger, WorkflowError> =>
      rawGet(LEDGER_PREFIX + date).pipe(
        Effect.flatMap((value) => decodeSome(LEDGER_PREFIX + date, decodeLedger, value)),
        Effect.map(Option.getOrElse(() => emptyCronLedger)),
      );

    const bumpLedger = (
      date: string,
      delta: Partial<CronLedger>,
    ): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        const current = yield* getLedger(date);
        const next: CronLedger = {
          cronsRegistered: current.cronsRegistered + (delta.cronsRegistered ?? 0),
          firesTriggered: current.firesTriggered + (delta.firesTriggered ?? 0),
          cronsDeactivated: current.cronsDeactivated + (delta.cronsDeactivated ?? 0),
          discoveryFires: (current.discoveryFires ?? 0) + (delta.discoveryFires ?? 0),
        };
        yield* tryState(LEDGER_PREFIX + date, () =>
          client.state.save(STORE, [{ key: LEDGER_PREFIX + date, value: next }]),
        );
      });

    return {
      getRow,
      listRows,
      saveRow,
      deleteRow,
      getDiscoverRow,
      listDiscoverRows,
      saveDiscoverRow,
      deleteDiscoverRow,
      getConfig,
      getHeartbeat,
      heartbeat,
      getLedger,
      bumpLedger,
    };
  }),
);
