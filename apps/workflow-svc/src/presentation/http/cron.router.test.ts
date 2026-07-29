import { WorkflowError } from "core";
import { DaprPublisherTag, type DaprPublisherService } from "core-dapr";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option, Ref } from "effect";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { type WatchRow, emptyLedger } from "../../domain/models/watch.model.ts";
import type { StoredWorkflow, WorkflowRequest } from "../../domain/models/workflow.model.ts";
import { emptyChainLedger } from "../../domain/models/chain.model.ts";
import { emptyCronLedger } from "../../domain/models/cron.model.ts";
import type { DiscoverRow } from "../../domain/models/discover.model.ts";
import { ChainStore, type ChainStoreService } from "../../domain/ports/IChainStore.ts";
import { CronStore, type CronStoreService } from "../../domain/ports/ICronStore.ts";
import { WatchStore, type WatchStoreService } from "../../domain/ports/IWatchStore.ts";
import {
  ExecPolicyStore,
  type ExecPolicyStoreService,
} from "../../domain/ports/IExecPolicyStore.ts";
import { WfStore, type WfStoreService } from "../../domain/ports/IWfStore.ts";
import { SourceReader, type SourceReaderService } from "../../domain/ports/ISourceReader.ts";
import {
  WorkflowInvoker,
  type WorkflowInvokerService,
} from "../../domain/ports/IWorkflowInvoker.ts";
import { WorkflowStore, type WorkflowStoreService } from "../../domain/ports/IWorkflowStore.ts";
import { registerCronRoutes, tickEffect } from "./cron.router.ts";

const stubExecPolicyStore: ExecPolicyStoreService = {
  get: () => Effect.succeed(Option.none()),
  save: () => Effect.void,
};

const stubInvoker = (overrides: Partial<WorkflowInvokerService> = {}): WorkflowInvokerService => ({
  invoke: () => Effect.succeed({ instanceId: "generated-id" }),
  getStatus: (instanceId) => Effect.succeed({ instanceId, runtimeStatus: "RUNNING" }),
  terminate: () => Effect.void,
  ...overrides,
});

const stubStore = (overrides: Partial<WorkflowStoreService> = {}): WorkflowStoreService => ({
  save: () => Effect.void,
  get: () => Effect.succeed(Option.none()),
  list: () => Effect.succeed([]),
  listScheduled: () => Effect.succeed([]),
  markRun: () => Effect.void,
  ...overrides,
});

function memoryWatchStore(): { service: WatchStoreService; rows: Map<string, WatchRow> } {
  const rows = new Map<string, WatchRow>();
  return {
    rows,
    service: {
      getRow: (id) => Effect.succeed(Option.fromNullable(rows.get(id))),
      listRows: () => Effect.succeed([...rows.values()]),
      saveRow: (row) => Effect.sync(() => void rows.set(row.instanceId, row)),
      deleteRow: (id) => Effect.sync(() => void rows.delete(id)),
      getConfig: () => Effect.succeed(Option.none()),
      getHeartbeat: () => Effect.succeed(Option.none()),
      heartbeat: () => Effect.void,
      getLedger: () => Effect.succeed(emptyLedger),
      bumpLedger: () => Effect.void,
      listRunKeys: () => Effect.succeed([]),
      getRunCost: () => Effect.succeed(null),
      getRunStopReason: () => Effect.succeed(null),
    },
  };
}

const stubPublisher: DaprPublisherService = { publish: () => Effect.void };
const stubSourceReader: SourceReaderService = { listOpenIssues: () => Effect.succeed([]) };

// An empty chain store: the cron tests exercise the schedule-fire + watch scan; the chain scan
// rides the same tick but finds no chains, so a no-rows stub keeps it a clean no-op.
const emptyChainStore: ChainStoreService = {
  getRow: () => Effect.succeed(Option.none()),
  listRows: () => Effect.succeed([]),
  saveRow: () => Effect.void,
  deleteRow: () => Effect.void,
  getConfig: () => Effect.succeed(Option.none()),
  getHeartbeat: () => Effect.succeed(Option.none()),
  heartbeat: () => Effect.void,
  getLedger: () => Effect.succeed(emptyChainLedger),
  bumpLedger: () => Effect.void,
  listRunKeys: () => Effect.succeed([]),
  getRunCost: () => Effect.succeed(null),
};

// Empty cron + wf stores: like the chain, the cron scan rides the same tick but finds no rows here, a
// clean no-op; the wf store backs the cron scan's goal-resolved read.
const emptyCronStore: CronStoreService = {
  getRow: () => Effect.succeed(Option.none()),
  listRows: () => Effect.succeed([]),
  saveRow: () => Effect.void,
  deleteRow: () => Effect.void,
  getDiscoverRow: () => Effect.succeed(Option.none()),
  listDiscoverRows: () => Effect.succeed([]),
  saveDiscoverRow: () => Effect.void,
  deleteDiscoverRow: () => Effect.void,
  getSchedRow: () => Effect.succeed(Option.none()),
  listSchedRows: () => Effect.succeed([]),
  saveSchedRow: () => Effect.void,
  deleteSchedRow: () => Effect.void,
  getConfig: () => Effect.succeed(Option.none()),
  getHeartbeat: () => Effect.succeed(Option.none()),
  heartbeat: () => Effect.void,
  getLedger: () => Effect.succeed(emptyCronLedger),
  bumpLedger: () => Effect.void,
};
const emptyWfStore: WfStoreService = {
  getRow: () => Effect.succeed(Option.none()),
  saveRow: () => Effect.void,
};

const envLayer = (
  invoker: WorkflowInvokerService,
  store: WorkflowStoreService,
  watch: WatchStoreService = memoryWatchStore().service,
  cron: CronStoreService = emptyCronStore,
) =>
  Layer.mergeAll(
    Layer.succeed(WorkflowInvoker, invoker),
    Layer.succeed(WorkflowStore, store),
    Layer.succeed(WatchStore, watch),
    Layer.succeed(ChainStore, emptyChainStore),
    Layer.succeed(CronStore, cron),
    Layer.succeed(WfStore, emptyWfStore),
    Layer.succeed(ExecPolicyStore, stubExecPolicyStore),
    Layer.succeed(DaprPublisherTag, stubPublisher),
    Layer.succeed(SourceReader, stubSourceReader),
  );

// A cron store that records the discovery rows it saves, for the /cron/discover route tests.
function recordingDiscoverStore(): {
  service: CronStoreService;
  discover: Map<string, DiscoverRow>;
} {
  const discover = new Map<string, DiscoverRow>();
  return {
    discover,
    service: {
      ...emptyCronStore,
      getDiscoverRow: (id) => Effect.succeed(Option.fromNullable(discover.get(id))),
      listDiscoverRows: () => Effect.succeed([...discover.values()]),
      saveDiscoverRow: (row) =>
        Effect.sync(() => void discover.set(`${row.repo}:${row.label}`, row)),
    },
  };
}

// A workflow whose every-minute schedule was saved long ago: always due.
const dueWorkflow: StoredWorkflow = {
  steps: [{ activity: "run-claude", input: { task: "t" } }],
  schedule: { cron: "* * * * *", savedAt: "2020-01-01T00:00:00Z" },
};

describe("tickEffect compare-and-set", () => {
  it("runs exactly one of two concurrent ticks; the loser is skipped immediately", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ticking = yield* Ref.make(false);
        const gate = yield* Deferred.make<void>();
        const scanning = yield* Deferred.make<void>();
        let scans = 0;
        const env = envLayer(
          stubInvoker(),
          stubStore({
            listScheduled: () =>
              Effect.gen(function* () {
                scans += 1;
                yield* Deferred.succeed(scanning, void 0);
                yield* Deferred.await(gate); // hold the winner mid-scan
                return [];
              }),
          }),
        );

        const winner = yield* Effect.fork(tickEffect(ticking, undefined).pipe(Effect.provide(env)));
        yield* Deferred.await(scanning); // the winner owns the flag and is mid-scan

        const loser = yield* tickEffect(ticking, undefined).pipe(Effect.provide(env));
        expect(loser).toEqual({ skipped: "previous tick still processing" });

        yield* Deferred.succeed(gate, void 0);
        const result = yield* Fiber.join(winner);
        expect(result).toMatchObject({ fired: [] });
        expect(scans).toBe(1); // the losing tick never scanned
        expect(yield* Ref.get(ticking)).toBe(false); // flag released for the next tick
      }),
    );
  });

  it("clears the flag when the scan fails (ensuring), so the next tick runs", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ticking = yield* Ref.make(false);
        let calls = 0;
        const env = envLayer(
          stubInvoker(),
          stubStore({
            listScheduled: () => {
              calls += 1;
              return calls === 1
                ? Effect.fail(new WorkflowError({ cause: new Error("redis down"), instanceId: "" }))
                : Effect.succeed([]);
            },
          }),
        );

        const failure = yield* tickEffect(ticking, undefined).pipe(
          Effect.provide(env),
          Effect.flip,
        );
        // Proxy-wrapped across spans in general: assert the tag, never instance identity.
        expect(failure._tag).toBe("WorkflowError");
        expect(yield* Ref.get(ticking)).toBe(false); // reset ran on the failure path

        const second = yield* tickEffect(ticking, undefined).pipe(Effect.provide(env));
        expect(second).toMatchObject({ fired: [] });
      }),
    );
  });

  it("fires due workflows, threads the tick's traceparent, and stamps markRun", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ticking = yield* Ref.make(false);
        const invoked: WorkflowRequest[] = [];
        const stamped: Array<{ key: string; lastRunAt: string }> = [];
        const notDue: StoredWorkflow = {
          steps: [],
          schedule: { cron: "* * * * *", savedAt: new Date(Date.now() + 60_000).toISOString() },
        };
        const paused: StoredWorkflow = { ...dueWorkflow, disabled: true };
        const env = envLayer(
          stubInvoker({
            invoke: (input) => {
              invoked.push(input);
              return Effect.succeed({ instanceId: "wf-1" });
            },
          }),
          stubStore({
            listScheduled: () =>
              Effect.succeed([
                { key: "due", workflow: dueWorkflow },
                { key: "future", workflow: notDue },
                { key: "paused", workflow: paused },
              ]),
            markRun: (key, lastRunAt) => {
              stamped.push({ key, lastRunAt });
              return Effect.void;
            },
          }),
        );

        const result = yield* tickEffect(ticking, "00-abc-def-01").pipe(Effect.provide(env));
        expect(result).toMatchObject({ fired: ["due"] });
        expect(invoked).toEqual([
          { steps: dueWorkflow.steps, workspaceId: undefined, traceparent: "00-abc-def-01" },
        ]);
        expect(stamped).toHaveLength(1);
        expect(stamped[0]!.key).toBe("due");
      }),
    );
  });

  it("a saved workflow's stored watch policy registers a row on the cron fire (agreement 9)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ticking = yield* Ref.make(false);
        const mem = memoryWatchStore();
        const watched: StoredWorkflow = {
          ...dueWorkflow,
          watch: { maxDurationMs: 60_000 },
        };
        const env = envLayer(
          stubInvoker(),
          stubStore({ listScheduled: () => Effect.succeed([{ key: "sweep", workflow: watched }]) }),
          mem.service,
        );
        const result = yield* tickEffect(ticking, undefined).pipe(Effect.provide(env));
        expect(result).toMatchObject({ fired: ["sweep"] });
        // The same tick's scan already saw the fresh row and promoted it to watching
        // (the stub invoker reports RUNNING) — registration and first observation ride
        // one tick.
        expect(mem.rows.get("generated-id")).toMatchObject({
          status: "watching",
          policy: { maxDurationMs: 60_000 },
          meta: { owner: "sweep" },
        });
      }),
    );
  });

  it("the tick carries the watch-scan report and survives a scan failure", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ticking = yield* Ref.make(false);
        const broken: WatchStoreService = {
          ...memoryWatchStore().service,
          listRows: () =>
            Effect.fail(new WorkflowError({ cause: new Error("redis down"), instanceId: "" })),
        };
        const env = envLayer(stubInvoker(), stubStore(), broken);
        const result = yield* tickEffect(ticking, undefined).pipe(Effect.provide(env));
        // The watch scan's failure lands in the report — never a failed tick (Dapr would
        // treat a non-2xx as "app has not subscribed").
        expect(result).toMatchObject({ fired: [], watch: { error: "redis down" } });
      }),
    );
  });
});

describe("the cron route's Fastify plugin scope", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function makeApp(store: WorkflowStoreService, cron?: CronStoreService) {
    const runtime = ManagedRuntime.make(
      envLayer(stubInvoker(), store, memoryWatchStore().service, cron),
    );
    const app = Fastify();
    registerCronRoutes(app, runtime);
    await app.ready();
    cleanups.push(
      () => app.close(),
      () => runtime.dispose(),
    );
    return app;
  }

  it("answers the Dapr OPTIONS probe with 200", async () => {
    const app = await makeApp(stubStore());
    const res = await app.inject({ method: "OPTIONS", url: "/workflow-cron-tick" });
    expect(res.statusCode).toBe(200);
  });

  it("accepts the empty-body application/json tick (cleared content-type parsers)", async () => {
    const app = await makeApp(stubStore());
    const res = await app.inject({
      method: "POST",
      url: "/workflow-cron-tick",
      headers: { "content-type": "application/json" },
      // no payload: Dapr's tick arrives with an empty JSON body
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fired: [] });
  });

  it("500s in the Fastify default error shape when the scan fails", async () => {
    const app = await makeApp(
      stubStore({
        listScheduled: () =>
          Effect.fail(new WorkflowError({ cause: new Error("redis down"), instanceId: "" })),
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow-cron-tick",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ statusCode: 500, error: "Internal Server Error" });
  });
});

describe("GET /cron/list — discovery rows", () => {
  // §10: discovery crons are registered by the register-discover ACTIVITY (a provision workflow), not
  // a route — there is no POST /cron/discover. The cron router only READS them here.
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it("surfaces cron:discover rows under `discover`, alongside recur crons", async () => {
    const cron = recordingDiscoverStore();
    await Effect.runPromise(
      cron.service.saveDiscoverRow({
        repo: "stiproot/h",
        label: "agent-approved",
        workflow: "implement-pr",
        status: "active",
        cadence: "0 * * * *",
        source: { mode: "github-issues" },
        gates: { maxFiresPerDay: 5 },
        epoch: 1,
        fires: 0,
        createdAt: "t",
        updatedAt: "t",
      }),
    );
    const runtime = ManagedRuntime.make(
      envLayer(stubInvoker(), stubStore(), memoryWatchStore().service, cron.service),
    );
    const app = Fastify();
    registerCronRoutes(app, runtime);
    await app.ready();
    cleanups.push(
      () => app.close(),
      () => runtime.dispose(),
    );

    const res = await app.inject({ method: "GET", url: "/cron/list" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { discover: Array<{ repo: string; label: string }> };
    expect(body.discover).toHaveLength(1);
    expect(body.discover[0]).toMatchObject({ repo: "stiproot/h", label: "agent-approved" });
  });
});
