import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  advanceSched,
  disarmSched,
  registerSchedForFire,
  scanSchedEffect,
} from "./schedule-scan.ts";
import { type CronLedger, emptyCronLedger } from "./models/cron.model.ts";
import type { SchedRow } from "./models/schedule.model.ts";
import type { WatchLedger } from "./models/watch.model.ts";
import type { StoredWorkflow, WorkflowRequest, WorkflowStatus } from "./models/workflow.model.ts";
import { CronStore, type CronStoreService } from "./ports/ICronStore.ts";
import { WatchStore, type WatchStoreService } from "./ports/IWatchStore.ts";
import { WorkflowInvoker, type WorkflowInvokerService } from "./ports/IWorkflowInvoker.ts";
import { WorkflowStore, type WorkflowStoreService } from "./ports/IWorkflowStore.ts";

// A cron store with a map-backed sched-row group; the recur/discover surfaces are stubs (unused here).
function memoryCronStore(): {
  service: CronStoreService;
  sched: Map<string, SchedRow>;
  ledgers: Map<string, CronLedger>;
} {
  const sched = new Map<string, SchedRow>();
  const ledgers = new Map<string, CronLedger>();
  return {
    sched,
    ledgers,
    service: {
      getRow: () => Effect.succeed(Option.none()),
      listRows: () => Effect.succeed([]),
      saveRow: () => Effect.void,
      deleteRow: () => Effect.void,
      getDiscoverRow: () => Effect.succeed(Option.none()),
      listDiscoverRows: () => Effect.succeed([]),
      saveDiscoverRow: () => Effect.void,
      deleteDiscoverRow: () => Effect.void,
      getSchedRow: (id) => Effect.succeed(Option.fromNullable(sched.get(id))),
      listSchedRows: () => Effect.succeed([...sched.values()]),
      saveSchedRow: (row) => Effect.sync(() => void sched.set(row.id, row)),
      deleteSchedRow: (id) => Effect.sync(() => void sched.delete(id)),
      getConfig: () => Effect.succeed(Option.none()),
      getHeartbeat: () => Effect.succeed(Option.none()),
      heartbeat: () => Effect.void,
      getLedger: (date) => Effect.succeed(ledgers.get(date) ?? emptyCronLedger),
      bumpLedger: (date, delta) =>
        Effect.sync(() => {
          const cur = ledgers.get(date) ?? emptyCronLedger;
          ledgers.set(date, {
            cronsRegistered: cur.cronsRegistered + (delta.cronsRegistered ?? 0),
            firesTriggered: cur.firesTriggered + (delta.firesTriggered ?? 0),
            cronsDeactivated: cur.cronsDeactivated + (delta.cronsDeactivated ?? 0),
            discoveryFires: (cur.discoveryFires ?? 0) + (delta.discoveryFires ?? 0),
            scheduledFires: (cur.scheduledFires ?? 0) + (delta.scheduledFires ?? 0),
          });
        }),
    },
  };
}

function recordingInvoker(statuses: Record<string, WorkflowStatus> = {}): {
  service: WorkflowInvokerService;
  invokes: WorkflowRequest[];
} {
  const invokes: WorkflowRequest[] = [];
  return {
    invokes,
    service: {
      invoke: (req) =>
        Effect.sync(() => {
          invokes.push(req);
          return { instanceId: req.instanceId ?? "generated-id" };
        }),
      getStatus: (instanceId) =>
        Effect.succeed(statuses[instanceId] ?? { instanceId, runtimeStatus: "COMPLETED" }),
      terminate: () => Effect.void,
    },
  };
}

const savedStore = (overrides: Partial<WorkflowStoreService> = {}): WorkflowStoreService => ({
  save: () => Effect.void,
  get: (key) =>
    Effect.succeed(
      Option.some({ steps: [{ activity: `run-${key}` }] } as unknown as StoredWorkflow),
    ),
  list: () => Effect.succeed([]),
  listScheduled: () => Effect.succeed([]),
  markRun: () => Effect.void,
  ...overrides,
});

const emptyWatchLedger: WatchLedger = { runsFired: 0, runsFinalized: 0, engineFires: 0, costUsd: 0 };
const stubWatch: WatchStoreService = {
  getRow: () => Effect.succeed(Option.none()),
  listRows: () => Effect.succeed([]),
  saveRow: () => Effect.void,
  deleteRow: () => Effect.void,
  getConfig: () => Effect.succeed(Option.none()),
  getHeartbeat: () => Effect.succeed(Option.none()),
  heartbeat: () => Effect.void,
  getLedger: () => Effect.succeed(emptyWatchLedger),
  bumpLedger: () => Effect.void,
  listRunKeys: () => Effect.succeed([]),
  getRunCost: () => Effect.succeed(null),
  getRunStopReason: () => Effect.succeed(null),
};

function env(
  cs: CronStoreService,
  invoker: WorkflowInvokerService,
  store: WorkflowStoreService = savedStore(),
) {
  return Layer.mergeAll(
    Layer.succeed(CronStore, cs),
    Layer.succeed(WorkflowInvoker, invoker),
    Layer.succeed(WorkflowStore, store),
    Layer.succeed(WatchStore, stubWatch),
  );
}

const today = () => new Date().toISOString().slice(0, 10);
// A fireAt long in the past → always due; a fireAt long in the future → never due.
const PAST = "2020-01-01T00:00:00Z";
const FUTURE = "2999-01-01T00:00:00Z";

const armedRow = (over: Partial<SchedRow> = {}): SchedRow => ({
  id: "sched-abc",
  status: "armed",
  fireAt: PAST,
  source: { mode: "saved", key: "implement-pr" },
  instanceId: "sched-abc",
  epoch: 1,
  createdAt: "2020-01-01T00:00:00Z",
  updatedAt: "2020-01-01T00:00:00Z",
  ...over,
});

describe("registerSchedForFire", () => {
  const arm = (cs: CronStoreService, reg: Parameters<typeof registerSchedForFire>[0]) =>
    Effect.runPromise(registerSchedForFire(reg).pipe(Effect.provide(Layer.succeed(CronStore, cs))));

  it("writes an armed row (epoch 1) with fireAt and source", async () => {
    const cs = memoryCronStore();
    const res = await arm(cs.service, {
      id: "sched-abc",
      fireAt: FUTURE,
      source: { mode: "saved", key: "implement-pr" },
      origin: "at",
    });
    expect(res).toEqual({ schedId: "sched-abc", armed: true });
    const row = cs.sched.get("sched-abc")!;
    expect(row.status).toBe("armed");
    expect(row.epoch).toBe(1);
    expect(row.fireAt).toBe(FUTURE);
    expect(row.origin).toBe("at");
  });

  it("is idempotent: re-arming an ARMED row is a no-op (epoch preserved)", async () => {
    const cs = memoryCronStore();
    cs.sched.set("sched-abc", armedRow({ epoch: 4, fireAt: FUTURE }));
    await arm(cs.service, {
      id: "sched-abc",
      fireAt: FUTURE,
      source: { mode: "saved", key: "implement-pr" },
    });
    expect(cs.sched.get("sched-abc")!.epoch).toBe(4);
  });

  it("re-arms a terminal (fired) row: create again, epoch continuing from the prior", async () => {
    const cs = memoryCronStore();
    cs.sched.set("sched-abc", armedRow({ status: "fired", epoch: 3 }));
    await arm(cs.service, {
      id: "sched-abc",
      fireAt: FUTURE,
      source: { mode: "saved", key: "implement-pr" },
    });
    const row = cs.sched.get("sched-abc")!;
    expect(row.status).toBe("armed");
    expect(row.epoch).toBe(4);
  });
});

describe("scanSchedEffect", () => {
  const scan = (cs: CronStoreService, inv: WorkflowInvokerService, store?: WorkflowStoreService) =>
    Effect.runPromise(scanSchedEffect(undefined).pipe(Effect.provide(env(cs, inv, store))));

  it("fires a due armed row once, fresh, under its instance; marks it fired + bumps epoch + ledger", async () => {
    const cs = memoryCronStore();
    cs.sched.set("sched-abc", armedRow());
    const inv = recordingInvoker();
    const report = await scan(cs.service, inv.service);

    expect(report.fired).toEqual(["sched-abc"]);
    expect(inv.invokes).toHaveLength(1);
    expect(inv.invokes[0].instanceId).toBe("sched-abc");
    expect(inv.invokes[0].fresh).toBe(true);
    expect(inv.invokes[0].steps).toEqual([{ activity: "run-implement-pr" }]);
    const row = cs.sched.get("sched-abc")!;
    expect(row.status).toBe("fired");
    expect(row.outcome).toBe("fired");
    expect(row.epoch).toBe(2);
    expect(row.firedInstanceId).toBe("sched-abc");
    expect(cs.ledgers.get(today())?.scheduledFires).toBe(1);
  });

  it("waits (no fire) when fireAt is in the future", async () => {
    const cs = memoryCronStore();
    cs.sched.set("sched-abc", armedRow({ fireAt: FUTURE }));
    const inv = recordingInvoker();
    const report = await scan(cs.service, inv.service);
    expect(inv.invokes).toHaveLength(0);
    expect(report.fired).toEqual([]);
    expect(cs.sched.get("sched-abc")!.status).toBe("armed");
  });

  it("expires a past-deadline row without firing", async () => {
    const cs = memoryCronStore();
    cs.sched.set("sched-abc", armedRow({ notAfter: "2020-06-01T00:00:00Z" }));
    const inv = recordingInvoker();
    const report = await scan(cs.service, inv.service);
    expect(inv.invokes).toHaveLength(0);
    expect(report.expired).toEqual(["sched-abc:expired"]);
    expect(cs.sched.get("sched-abc")!.status).toBe("expired");
  });

  it("fires an embedded source with its own steps + workspaceId reuse (pause/fallback path)", async () => {
    const cs = memoryCronStore();
    cs.sched.set(
      "sched-abc",
      armedRow({
        source: {
          mode: "embedded",
          steps: [{ activity: "run-openhands", input: { task: "continue" } }],
          workspaceId: "orig-workspace",
        },
        origin: "fallback:usage-limited",
      }),
    );
    const inv = recordingInvoker();
    await scan(cs.service, inv.service);
    expect(inv.invokes[0].steps).toEqual([
      { activity: "run-openhands", input: { task: "continue" } },
    ]);
    expect(inv.invokes[0].workspaceId).toBe("orig-workspace");
  });

  it("a row-level workspaceId overrides the source-derived one (pause reuse of a saved run)", async () => {
    const cs = memoryCronStore();
    cs.sched.set("wf-9--resume", armedRow({ id: "wf-9--resume", workspaceId: "wf-9" }));
    const inv = recordingInvoker();
    await scan(cs.service, inv.service);
    // saved source → the resumed run reuses the paused instance's workspace, not the stored default.
    expect(inv.invokes[0].workspaceId).toBe("wf-9");
  });

  it("skips non-armed rows entirely", async () => {
    const cs = memoryCronStore();
    cs.sched.set("sched-abc", armedRow({ status: "fired" }));
    const inv = recordingInvoker();
    const report = await scan(cs.service, inv.service);
    expect(report.scanned).toBe(0);
    expect(inv.invokes).toHaveLength(0);
  });

  it("records a fire failure (missing saved source) but still burns the one-shot (self-limiting)", async () => {
    const cs = memoryCronStore();
    cs.sched.set("sched-abc", armedRow());
    const inv = recordingInvoker();
    // The saved key resolves to nothing → fireSched fails; executeFire records it, no throw.
    const store = savedStore({ get: () => Effect.succeed(Option.none()) });
    const report = await scan(cs.service, inv.service, store);
    expect(inv.invokes).toHaveLength(0);
    expect(report.fired).toEqual([]);
    expect(report.errors.some((e) => e.startsWith("sched-abc: fire failed"))).toBe(true);
    // Mark-before-fire already burned the one-shot, so the next tick won't retry it forever.
    expect(cs.sched.get("sched-abc")!.status).toBe("fired");
  });
});

describe("disarmSched", () => {
  const disarm = (cs: CronStoreService, id: string) =>
    Effect.runPromise(disarmSched(id).pipe(Effect.provide(Layer.succeed(CronStore, cs))));
  const disarmFail = (cs: CronStoreService, id: string) =>
    Effect.runPromise(
      disarmSched(id).pipe(Effect.flip, Effect.provide(Layer.succeed(CronStore, cs))),
    );

  it("disarms an armed row: sets disarmed, bumps epoch, stamps note", async () => {
    const cs = memoryCronStore();
    cs.sched.set("sched-abc", armedRow({ epoch: 3 }));
    const result = await disarm(cs.service, "sched-abc");
    expect(result.status).toBe("disarmed");
    expect(result.outcome).toBe("disarmed");
    expect(result.epoch).toBe(4);
    expect(cs.sched.get("sched-abc")!.status).toBe("disarmed");
  });

  it("disarming a terminal row is idempotent (returned as-is)", async () => {
    const cs = memoryCronStore();
    cs.sched.set("sched-abc", armedRow({ status: "fired", epoch: 7 }));
    const result = await disarm(cs.service, "sched-abc");
    expect(result.status).toBe("fired");
    expect(result.epoch).toBe(7);
  });

  it("fails with NotFound for an unknown id", async () => {
    const cs = memoryCronStore();
    const err = await disarmFail(cs.service, "nope");
    expect((err as { _tag: string })._tag).toBe("NotFound");
  });
});

describe("advanceSched (resume)", () => {
  const advance = (cs: CronStoreService, id: string) =>
    Effect.runPromise(advanceSched(id).pipe(Effect.provide(Layer.succeed(CronStore, cs))));

  it("advances an armed row's fireAt to now and bumps epoch so the next tick fires it", async () => {
    const cs = memoryCronStore();
    cs.sched.set("sched-abc", armedRow({ fireAt: FUTURE, epoch: 2 }));
    const result = await advance(cs.service, "sched-abc");
    expect(result.epoch).toBe(3);
    expect(Date.parse(result.fireAt)).toBeLessThanOrEqual(Date.now());
    expect(cs.sched.get("sched-abc")!.status).toBe("armed"); // still armed — the tick fires it
  });

  it("is a no-op on a terminal row (a fired schedule can't be resumed)", async () => {
    const cs = memoryCronStore();
    cs.sched.set("sched-abc", armedRow({ status: "fired", epoch: 5 }));
    const result = await advance(cs.service, "sched-abc");
    expect(result.status).toBe("fired");
    expect(result.epoch).toBe(5);
  });

  it("fails with NotFound for an unknown id", async () => {
    const cs = memoryCronStore();
    const err = await Effect.runPromise(
      advanceSched("nope").pipe(Effect.flip, Effect.provide(Layer.succeed(CronStore, cs.service))),
    );
    expect((err as { _tag: string })._tag).toBe("NotFound");
  });
});
