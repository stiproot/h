import { DaprClient } from "@dapr/dapr";
import { pathStateKey } from "core-dapr";
import { WorkflowError } from "core";
import { Effect, Layer, Option, Schema } from "effect";

import {
  type RunMirrorMeta,
  WatchConfig,
  WatchHeartbeat,
  WatchLedger,
  WatchRow,
  emptyLedger,
  runMirrorMetaFrom,
} from "../domain/models/watch.model.ts";
import { WatchStore } from "../domain/ports/IWatchStore.ts";

const STORE = "statestore";
// The watch registry's claimed prefix in the flat keyspace (CLAUDE.md keyspace conventions):
// rows, index, config, heartbeat, and daily ledgers all live under `watch:`. Only workflow-svc
// writes these keys — single-writer per key is structural (Decision 3).
const ROW_PREFIX = "watch:sub:";
const INDEX_KEY = "watch:index";
const CONFIG_KEY = "watch:config";
const TICK_KEY = "watch:__tick__";
const LEDGER_PREFIX = "watch:ledger:";

const decodeRow = Schema.decodeUnknown(WatchRow, { onExcessProperty: "preserve" });
const decodeConfig = Schema.decodeUnknown(WatchConfig, { onExcessProperty: "preserve" });
const decodeHeartbeat = Schema.decodeUnknown(WatchHeartbeat, { onExcessProperty: "preserve" });
const decodeLedger = Schema.decodeUnknown(WatchLedger, { onExcessProperty: "preserve" });

/**
 * Live layer over the Dapr state API (Redis), the dapr-workflow-store pattern: DaprClient
 * bracketed with acquireRelease, missing keys read as ""/null → Option.none, hand-rolled
 * index key because Redis exposes no enumeration through Dapr.
 *
 * `bumpLedger` is read-modify-write, not atomic — safe because the scan is single-flight
 * (the cron tick's CAS) and registration writes come from this same process's route handlers;
 * cross-process contention on `watch:*` cannot exist while workflow-svc is the only writer.
 */
export const WatchStoreLive: Layer.Layer<WatchStore> = Layer.scoped(
  WatchStore,
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
      tryState(key, () => client.state.get(STORE, pathStateKey(key))).pipe(
        // A missing key reads as "" (or null) from the SDK; both are Option.none.
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

    const indexList = (): Effect.Effect<readonly string[], WorkflowError> =>
      tryState(INDEX_KEY, () => client.state.get(STORE, pathStateKey(INDEX_KEY))).pipe(
        Effect.map((result) => (Array.isArray(result) ? (result as string[]) : [])),
      );

    const getRow = (instanceId: string) =>
      rawGet(ROW_PREFIX + instanceId).pipe(
        Effect.flatMap((value) => decodeSome(ROW_PREFIX + instanceId, decodeRow, value)),
      );

    const listRows = (): Effect.Effect<readonly WatchRow[], WorkflowError> =>
      Effect.gen(function* () {
        const ids = yield* indexList();
        const rows = yield* Effect.forEach(ids, getRow, { concurrency: "unbounded" });
        return rows.flatMap((row) => (Option.isSome(row) ? [row.value] : []));
      });

    const saveRow = (row: WatchRow): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        yield* tryState(ROW_PREFIX + row.instanceId, () =>
          client.state.save(STORE, [{ key: ROW_PREFIX + row.instanceId, value: row }]),
        );
        const ids = yield* indexList();
        if (!ids.includes(row.instanceId)) {
          yield* tryState(INDEX_KEY, () =>
            client.state.save(STORE, [{ key: INDEX_KEY, value: [...ids, row.instanceId] }]),
          );
        }
      });

    const deleteRow = (instanceId: string): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        yield* tryState(ROW_PREFIX + instanceId, () =>
          client.state.delete(STORE, pathStateKey(ROW_PREFIX + instanceId)),
        );
        const ids = yield* indexList();
        if (ids.includes(instanceId)) {
          yield* tryState(INDEX_KEY, () =>
            client.state.save(STORE, [
              { key: INDEX_KEY, value: ids.filter((id) => id !== instanceId) },
            ]),
          );
        }
      });

    const getConfig = () =>
      rawGet(CONFIG_KEY).pipe(
        Effect.flatMap((value) => decodeSome(CONFIG_KEY, decodeConfig, value)),
      );

    const getHeartbeat = () =>
      rawGet(TICK_KEY).pipe(
        Effect.flatMap((value) => decodeSome(TICK_KEY, decodeHeartbeat, value)),
      );

    const heartbeat = (beat: WatchHeartbeat): Effect.Effect<void, WorkflowError> =>
      tryState(TICK_KEY, () => client.state.save(STORE, [{ key: TICK_KEY, value: beat }]));

    const getLedger = (date: string): Effect.Effect<WatchLedger, WorkflowError> =>
      rawGet(LEDGER_PREFIX + date).pipe(
        Effect.flatMap((value) => decodeSome(LEDGER_PREFIX + date, decodeLedger, value)),
        Effect.map(Option.getOrElse(() => emptyLedger)),
      );

    const bumpLedger = (
      date: string,
      delta: Partial<WatchLedger>,
    ): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        const current = yield* getLedger(date);
        // Per-agent subtotals merge key-by-key (cost-containment B3): a delta's agent adds to
        // the day's running subtotal for that agent.
        const costByAgent = { ...(current.costByAgent ?? {}) };
        for (const [agent, usd] of Object.entries(delta.costByAgent ?? {})) {
          costByAgent[agent] = Math.round(((costByAgent[agent] ?? 0) + usd) * 10_000) / 10_000;
        }
        const next: WatchLedger = {
          runsFired: current.runsFired + (delta.runsFired ?? 0),
          runsFinalized: current.runsFinalized + (delta.runsFinalized ?? 0),
          engineFires: current.engineFires + (delta.engineFires ?? 0),
          costUsd: Math.round((current.costUsd + (delta.costUsd ?? 0)) * 10_000) / 10_000,
          costByAgent,
          costGapRuns: (current.costGapRuns ?? 0) + (delta.costGapRuns ?? 0),
        };
        yield* tryState(LEDGER_PREFIX + date, () =>
          client.state.save(STORE, [{ key: LEDGER_PREFIX + date, value: next }]),
        );
      });

    const listRunKeys = (): Effect.Effect<readonly string[], WorkflowError> =>
      tryState("runs:index", () => client.state.get(STORE, pathStateKey("runs:index"))).pipe(
        Effect.map((result) => (Array.isArray(result) ? (result as string[]) : [])),
      );

    const getRunMeta = (key: string): Effect.Effect<RunMirrorMeta | null, WorkflowError> =>
      rawGet(key).pipe(
        Effect.map((value) => (Option.isNone(value) ? null : runMirrorMetaFrom(value.value))),
      );

    return {
      getRow,
      listRows,
      saveRow,
      deleteRow,
      getConfig,
      getHeartbeat,
      heartbeat,
      getLedger,
      bumpLedger,
      listRunKeys,
      getRunMeta,
    };
  }),
);
