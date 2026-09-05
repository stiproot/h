import { DaprClient } from "@dapr/dapr";
import { pathStateKey } from "core-dapr";
import { WorkflowError } from "core";
import { Effect, Layer, Option, Schema } from "effect";

import { ChainConfig, ChainHeartbeat, ChainLedger, ChainRow, emptyChainLedger } from "engine-core";
import { type RunMirrorMeta, runMirrorMetaFrom } from "engine-core";
import { ChainStore } from "engine-core";

const STORE = "statestore";
// The chain registry's claimed prefix in the flat keyspace, sibling of `watch:` — rows, index,
// config, heartbeat, and daily ledgers all under `chain:`. Only workflow-svc writes these keys.
// (Supersedes Phase 1's best-effort `chain:<slug>` mirror; the row IS the durable chain data now.)
const ROW_PREFIX = "chain:sub:";
const INDEX_KEY = "chain:index";
const CONFIG_KEY = "chain:config";
const TICK_KEY = "chain:__tick__";
const LEDGER_PREFIX = "chain:ledger:";

const decodeRow = Schema.decodeUnknown(ChainRow, { onExcessProperty: "preserve" });
const decodeConfig = Schema.decodeUnknown(ChainConfig, { onExcessProperty: "preserve" });
const decodeHeartbeat = Schema.decodeUnknown(ChainHeartbeat, { onExcessProperty: "preserve" });
const decodeLedger = Schema.decodeUnknown(ChainLedger, { onExcessProperty: "preserve" });

/**
 * Live layer over the Dapr state API (Redis), mirroring dapr-watch-store.ts: DaprClient bracketed
 * with acquireRelease, missing keys read as ""/null → Option.none, hand-rolled index key because
 * Redis exposes no enumeration through Dapr. `bumpLedger` is read-modify-write, safe because the
 * scan is single-flight (the cron tick's CAS) and registration writes come from this process.
 */
export const ChainStoreLive: Layer.Layer<ChainStore> = Layer.scoped(
  ChainStore,
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new DaprClient()),
      (c) =>
        Effect.tryPromise({ try: () => c.stop(), catch: (cause) => cause }).pipe(Effect.ignore),
    );

    const tryState = <A>(key: string, f: () => Promise<A>): Effect.Effect<A, WorkflowError> =>
      Effect.tryPromise({
        try: f,
        catch: (cause) => new WorkflowError({ cause, instanceId: key }),
      });

    const rawGet = (key: string): Effect.Effect<Option.Option<unknown>, WorkflowError> =>
      tryState(key, () => client.state.get(STORE, pathStateKey(key))).pipe(
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

    const getRow = (chainId: string) =>
      rawGet(ROW_PREFIX + chainId).pipe(
        Effect.flatMap((value) => decodeSome(ROW_PREFIX + chainId, decodeRow, value)),
      );

    const listRows = (): Effect.Effect<readonly ChainRow[], WorkflowError> =>
      Effect.gen(function* () {
        const ids = yield* indexList();
        const rows = yield* Effect.forEach(ids, getRow, { concurrency: "unbounded" });
        return rows.flatMap((row) => (Option.isSome(row) ? [row.value] : []));
      });

    const saveRow = (row: ChainRow): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        yield* tryState(ROW_PREFIX + row.chainId, () =>
          client.state.save(STORE, [{ key: ROW_PREFIX + row.chainId, value: row }]),
        );
        const ids = yield* indexList();
        if (!ids.includes(row.chainId)) {
          yield* tryState(INDEX_KEY, () =>
            client.state.save(STORE, [{ key: INDEX_KEY, value: [...ids, row.chainId] }]),
          );
        }
      });

    const deleteRow = (chainId: string): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        yield* tryState(ROW_PREFIX + chainId, () =>
          client.state.delete(STORE, pathStateKey(ROW_PREFIX + chainId)),
        );
        const ids = yield* indexList();
        if (ids.includes(chainId)) {
          yield* tryState(INDEX_KEY, () =>
            client.state.save(STORE, [
              { key: INDEX_KEY, value: ids.filter((id) => id !== chainId) },
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

    const heartbeat = (beat: ChainHeartbeat): Effect.Effect<void, WorkflowError> =>
      tryState(TICK_KEY, () => client.state.save(STORE, [{ key: TICK_KEY, value: beat }]));

    const getLedger = (date: string): Effect.Effect<ChainLedger, WorkflowError> =>
      rawGet(LEDGER_PREFIX + date).pipe(
        Effect.flatMap((value) => decodeSome(LEDGER_PREFIX + date, decodeLedger, value)),
        Effect.map(Option.getOrElse(() => emptyChainLedger)),
      );

    const bumpLedger = (
      date: string,
      delta: Partial<ChainLedger>,
    ): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        const current = yield* getLedger(date);
        // Per-agent subtotals merge key-by-key, mirroring the watch ledger (cost-containment B3).
        const costByAgent = { ...current.costByAgent };
        for (const [agent, usd] of Object.entries(delta.costByAgent ?? {})) {
          costByAgent[agent] = Math.round(((costByAgent[agent] ?? 0) + usd) * 10_000) / 10_000;
        }
        const next: ChainLedger = {
          chainsRegistered: current.chainsRegistered + (delta.chainsRegistered ?? 0),
          workflowsFired: current.workflowsFired + (delta.workflowsFired ?? 0),
          chainsFinalized: current.chainsFinalized + (delta.chainsFinalized ?? 0),
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
