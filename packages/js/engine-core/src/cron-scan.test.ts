import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_UNKNOWN_STREAK_LIMIT } from "./internal.ts";

import {
  disarmCron,
  disarmEventEffect,
  registerCronForFire,
  scanCronsEffect,
} from "./cron-scan.ts";
import { type CronLedger, type CronRow, emptyCronLedger } from "./internal.ts";
import type { DiscoverRow } from "./internal.ts";
import type { WfRow } from "./internal.ts";
import type { StoredWorkflow, WorkflowRequest, WorkflowStatus } from "./internal.ts";
import { CronStore, type CronStoreService } from "./internal.ts";
import { WfStore, type WfStoreService } from "./internal.ts";
import { WorkflowInvoker, type WorkflowInvokerService } from "./internal.ts";
import { WorkflowStore, type WorkflowStoreService } from "./internal.ts";

function memoryCronStore(): {
  service: CronStoreService;
  rows: Map<string, CronRow>;
  discoverRows: Map<string, DiscoverRow>;
  ledgers: Map<string, CronLedger>;
} {
  const rows = new Map<string, CronRow>();
  const discoverRows = new Map<string, DiscoverRow>();
  const ledgers = new Map<string, CronLedger>();
  const idOf = (r: CronRow) => `${r.repo}:${r.slug}:${r.workflow}`;
  return {
    rows,
    discoverRows,
    ledgers,
    service: {
      getRow: (id) => Effect.succeed(Option.fromNullable(rows.get(id))),
      listRows: () => Effect.succeed([...rows.values()]),
      saveRow: (row) => Effect.sync(() => void rows.set(idOf(row), row)),
      deleteRow: (id) => Effect.sync(() => void rows.delete(id)),
      getDiscoverRow: (id) => Effect.succeed(Option.fromNullable(discoverRows.get(id))),
      listDiscoverRows: () => Effect.succeed([...discoverRows.values()]),
      saveDiscoverRow: (row) =>
        Effect.sync(() => void discoverRows.set(`${row.repo}:${row.label}`, row)),
      deleteDiscoverRow: (id) => Effect.sync(() => void discoverRows.delete(id)),
      getSchedRow: () => Effect.succeed(Option.none()),
      listSchedRows: () => Effect.succeed([]),
      saveSchedRow: () => Effect.void,
      deleteSchedRow: () => Effect.void,
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

// A wf store whose target row reports `resolved` (the goal handshake) — or none.
const wfStore = (resolved?: boolean): WfStoreService => ({
  getRun: () =>
    resolved === undefined
      ? Effect.succeed(Option.none())
      : Effect.succeed(
          Option.some({
            status: "done",
            resolved,
            instanceId: "x",
            updatedAt: "t",
          } as WfRow),
        ),
  saveRow: () => Effect.void,
});

// A saved-workflow store: the saved-source fire resolves the key to steps via toRequest.
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

function env(
  cs: CronStoreService,
  invoker: WorkflowInvokerService,
  wf: WfStoreService = wfStore(),
  store: WorkflowStoreService = savedStore(),
) {
  return Layer.mergeAll(
    Layer.succeed(CronStore, cs),
    Layer.succeed(WorkflowInvoker, invoker),
    Layer.succeed(WfStore, wf),
    Layer.succeed(WorkflowStore, store),
  );
}

const identity = { repo: "stiproot/h", slug: "pi-agent", workflow: "revise-pr" };
// Every-minute cadence saved long ago → always due.
const DUE_CADENCE = "* * * * *";

// A pre-seeded active cron row (already fired once, its instance terminal → the next tick may fire).
const activeRow = (over: Partial<CronRow> = {}): CronRow => ({
  ...identity,
  status: "active",
  cadence: DUE_CADENCE,
  source: { mode: "saved", key: "revise-pr" },
  budget: { maxFires: 100 },
  instanceId: "revise-pi-agent",
  epoch: 1,
  fires: 1,
  currentInstanceId: "revise-pi-agent",
  lastRunAt: "2020-01-01T00:00:00Z",
  createdAt: "2020-01-01T00:00:00Z",
  updatedAt: "2020-01-01T00:00:00Z",
  ...over,
});

describe("registerCronForFire", () => {
  it("writes an active cron row; standalone (no initial run) starts fires 0, no current instance", async () => {
    const cs = memoryCronStore();
    const res = await Effect.runPromise(
      registerCronForFire({
        identity,
        cadence: DUE_CADENCE,
        source: { mode: "saved", key: "revise-pr" },
        instanceId: "revise-pi-agent",
      }).pipe(Effect.provide(env(cs.service, recordingInvoker().service))),
    );
    expect(res).toEqual({ cronId: "stiproot/h:pi-agent:revise-pr", active: true });
    const row = cs.rows.get("stiproot/h:pi-agent:revise-pr")!;
    expect(row.status).toBe("active");
    expect(row.epoch).toBe(1);
    expect(row.fires).toBe(0);
    expect(row.currentInstanceId).toBeUndefined();
    expect(cs.ledgers.get(new Date().toISOString().slice(0, 10))?.cronsRegistered).toBe(1);
  });

  it("counts the initial run (when --cron rides a fired run): fires 1, guards on that instance", async () => {
    const cs = memoryCronStore();
    await Effect.runPromise(
      registerCronForFire({
        identity,
        cadence: DUE_CADENCE,
        source: { mode: "saved", key: "revise-pr" },
        instanceId: "revise-pi-agent",
        initial: { firedAt: "2026-07-11T00:00:00Z" },
      }).pipe(Effect.provide(env(cs.service, recordingInvoker().service))),
    );
    const row = cs.rows.get("stiproot/h:pi-agent:revise-pr")!;
    expect(row.fires).toBe(1);
    expect(row.currentInstanceId).toBe("revise-pi-agent");
    expect(row.lastRunAt).toBe("2026-07-11T00:00:00Z");
  });

  it("is idempotent: re-registering an ACTIVE row is a no-op (fires/epoch preserved)", async () => {
    const cs = memoryCronStore();
    const reg = {
      identity,
      cadence: DUE_CADENCE,
      source: { mode: "saved", key: "revise-pr" } as const,
      instanceId: "revise-pi-agent",
    };
    await Effect.runPromise(
      registerCronForFire(reg).pipe(Effect.provide(env(cs.service, recordingInvoker().service))),
    );
    // Simulate the scan having advanced the row (fired twice, epoch bumped) before a re-run re-arms.
    const advanced = { ...cs.rows.get("stiproot/h:pi-agent:revise-pr")!, epoch: 5, fires: 2 };
    cs.rows.set("stiproot/h:pi-agent:revise-pr", advanced);
    await Effect.runPromise(
      registerCronForFire(reg).pipe(Effect.provide(env(cs.service, recordingInvoker().service))),
    );
    // Re-run safety: the active row is untouched — the budget isn't reset.
    const row = cs.rows.get("stiproot/h:pi-agent:revise-pr")!;
    expect(row.epoch).toBe(5);
    expect(row.fires).toBe(2);
  });

  it("re-arms a DEACTIVATED row (create again, epoch continuing from the prior)", async () => {
    const cs = memoryCronStore();
    cs.rows.set(
      "stiproot/h:pi-agent:revise-pr",
      activeRow({ status: "inactive", epoch: 3, fires: 9 }),
    );
    await Effect.runPromise(
      registerCronForFire({
        identity,
        cadence: DUE_CADENCE,
        source: { mode: "saved", key: "revise-pr" },
        instanceId: "revise-pi-agent",
      }).pipe(Effect.provide(env(cs.service, recordingInvoker().service))),
    );
    const row = cs.rows.get("stiproot/h:pi-agent:revise-pr")!;
    expect(row.status).toBe("active");
    expect(row.epoch).toBe(4); // continues from the deactivated prior
    expect(row.fires).toBe(0); // fresh budget
  });
});

describe("scanCronsEffect", () => {
  const scan = (cs: CronStoreService, inv: WorkflowInvokerService, wf?: WfStoreService) =>
    Effect.runPromise(scanCronsEffect(undefined).pipe(Effect.provide(env(cs, inv, wf))));

  it("fires a due, terminal, unresolved cron under its fixed instance, fresh, with the wf identity", async () => {
    const cs = memoryCronStore();
    cs.rows.set("stiproot/h:pi-agent:revise-pr", activeRow());
    const inv = recordingInvoker({
      "revise-pi-agent": { instanceId: "revise-pi-agent", runtimeStatus: "COMPLETED" },
    });
    const report = await scan(cs.service, inv.service);

    expect(report.fired).toEqual(["stiproot/h:pi-agent:revise-pr"]);
    expect(inv.invokes).toHaveLength(1);
    expect(inv.invokes[0]!.instanceId).toBe("revise-pi-agent");
    expect(inv.invokes[0]!.fresh).toBe(true);
    expect(inv.invokes[0]!.wf).toEqual(identity);
    expect(inv.invokes[0]!.steps).toEqual([{ activity: "run-revise-pr" }]);
    // mark-before-fire bumped fires + epoch.
    const row = cs.rows.get("stiproot/h:pi-agent:revise-pr")!;
    expect(row.fires).toBe(2);
    expect(row.epoch).toBe(2);
  });

  // A vanished instance reads UNKNOWN forever. Without an accumulating streak the cron would sit
  // in-flight for good; without PERSISTING it, every tick would restart the count at 1 and the
  // escape would never be reached.
  it("accumulates the UNKNOWN streak across ticks and eventually fires again", async () => {
    const cs = memoryCronStore();
    cs.rows.set("stiproot/h:pi-agent:revise-pr", activeRow());
    const inv = recordingInvoker({
      "revise-pi-agent": { instanceId: "revise-pi-agent", runtimeStatus: "UNKNOWN" },
    });
    const key = "stiproot/h:pi-agent:revise-pr";

    for (let tick = 1; tick < DEFAULT_UNKNOWN_STREAK_LIMIT; tick += 1) {
      const report = await scan(cs.service, inv.service);
      expect(report.fired).toEqual([]);
      expect(cs.rows.get(key)!.unknownStreak).toBe(tick);
    }

    // The tick that reaches the limit stops believing the instance is alive.
    const report = await scan(cs.service, inv.service);
    expect(report.fired).toEqual([key]);
    expect(inv.invokes).toHaveLength(1);
    // A fresh fire is a fresh instance to observe - the streak resets with it.
    expect(cs.rows.get(key)!.unknownStreak).toBe(0);
  });

  it("a real status clears an accumulated streak", async () => {
    const cs = memoryCronStore();
    cs.rows.set("stiproot/h:pi-agent:revise-pr", activeRow({ unknownStreak: 3 }));
    const inv = recordingInvoker({
      "revise-pi-agent": { instanceId: "revise-pi-agent", runtimeStatus: "RUNNING" },
    });
    const report = await scan(cs.service, inv.service);
    expect(report.fired).toEqual([]);
    expect(cs.rows.get("stiproot/h:pi-agent:revise-pr")!.unknownStreak).toBe(0);
  });

  it("deactivates 'resolved' when the target wf: row reports the goal met — no fire", async () => {
    const cs = memoryCronStore();
    cs.rows.set("stiproot/h:pi-agent:revise-pr", activeRow());
    const inv = recordingInvoker();
    const report = await scan(cs.service, inv.service, wfStore(true));
    expect(inv.invokes).toHaveLength(0);
    expect(report.deactivated).toEqual(["stiproot/h:pi-agent:revise-pr:resolved"]);
    expect(cs.rows.get("stiproot/h:pi-agent:revise-pr")!.status).toBe("inactive");
  });

  it("deactivates 'budget-exhausted' when fires reached maxFires — no fire", async () => {
    const cs = memoryCronStore();
    cs.rows.set("stiproot/h:pi-agent:revise-pr", activeRow({ fires: 100 }));
    const inv = recordingInvoker();
    const report = await scan(cs.service, inv.service);
    expect(inv.invokes).toHaveLength(0);
    expect(report.deactivated).toEqual(["stiproot/h:pi-agent:revise-pr:budget-exhausted"]);
  });

  it("waits (no fire) while the last instance is still running", async () => {
    const cs = memoryCronStore();
    cs.rows.set("stiproot/h:pi-agent:revise-pr", activeRow());
    const inv = recordingInvoker({
      "revise-pi-agent": { instanceId: "revise-pi-agent", runtimeStatus: "RUNNING" },
    });
    const report = await scan(cs.service, inv.service);
    expect(inv.invokes).toHaveLength(0);
    expect(report.fired).toEqual([]);
  });

  it("skips inactive rows entirely", async () => {
    const cs = memoryCronStore();
    cs.rows.set("stiproot/h:pi-agent:revise-pr", activeRow({ status: "inactive" }));
    const inv = recordingInvoker();
    const report = await scan(cs.service, inv.service);
    expect(report.scanned).toBe(0);
    expect(inv.invokes).toHaveLength(0);
  });

  it("fires an embedded-source cron with its own steps", async () => {
    const cs = memoryCronStore();
    cs.rows.set(
      "stiproot/h:pi-agent:revise-pr",
      activeRow({
        source: { mode: "embedded", steps: [{ activity: "run-claude", input: { task: "t" } }] },
      }),
    );
    const inv = recordingInvoker();
    await scan(cs.service, inv.service);
    expect(inv.invokes[0]!.steps).toEqual([{ activity: "run-claude", input: { task: "t" } }]);
    expect(inv.invokes[0]!.wf).toEqual(identity);
  });
});

describe("disarmCron", () => {
  const disarm = (cs: CronStoreService, id: string) =>
    Effect.runPromise(disarmCron(id).pipe(Effect.provide(Layer.succeed(CronStore, cs))));

  const disarmFail = (cs: CronStoreService, id: string) =>
    Effect.runPromise(
      disarmCron(id).pipe(Effect.flip, Effect.provide(Layer.succeed(CronStore, cs))),
    );

  it("disarms an active cron: sets inactive+disabled, bumps epoch, stamps note, bumps ledger", async () => {
    const cs = memoryCronStore();
    cs.rows.set("stiproot/h:pi-agent:revise-pr", activeRow({ epoch: 3, fires: 5 }));
    const result = await disarm(cs.service, "stiproot/h:pi-agent:revise-pr");
    expect(result.status).toBe("inactive");
    expect(result.outcome).toBe("disabled");
    expect(result.note).toBe("disarmed by operator");
    expect(result.epoch).toBe(4);
    expect(result.endedAt).toBeDefined();
    const row = cs.rows.get("stiproot/h:pi-agent:revise-pr")!;
    expect(row.status).toBe("inactive");
    expect(row.epoch).toBe(4);
    const today = new Date().toISOString().slice(0, 10);
    expect(cs.ledgers.get(today)?.cronsDeactivated).toBe(1);
  });

  it("disarming an already-inactive cron is idempotent: returns the row as-is, no ledger bump", async () => {
    const cs = memoryCronStore();
    cs.rows.set(
      "stiproot/h:pi-agent:revise-pr",
      activeRow({ status: "inactive", outcome: "disabled", epoch: 7, fires: 3 }),
    );
    const result = await disarm(cs.service, "stiproot/h:pi-agent:revise-pr");
    expect(result.status).toBe("inactive");
    expect(result.epoch).toBe(7);
    const today = new Date().toISOString().slice(0, 10);
    expect(cs.ledgers.get(today)?.cronsDeactivated).toBeUndefined();
  });

  it("fails with NotFound for an unknown cron id", async () => {
    const cs = memoryCronStore();
    const err = await disarmFail(cs.service, "no-such:cron:id");
    expect((err as { _tag: string })._tag).toBe("NotFound");
  });
});

describe("disarmEventEffect (cron-disarm pub/sub — D6 chain teardown)", () => {
  const runEvent = (cs: CronStoreService, body: unknown) =>
    Effect.runPromise(disarmEventEffect(body).pipe(Effect.provide(Layer.succeed(CronStore, cs))));

  it("disarms the named cron from a CloudEvents-wrapped identity payload", async () => {
    const cs = memoryCronStore();
    cs.rows.set("stiproot/h:pi-agent:revise-pr", activeRow({ epoch: 2 }));
    const res = await runEvent(cs.service, { data: identity });
    expect(res).toEqual({ disarmed: "stiproot/h:pi-agent:revise-pr" });
    expect(cs.rows.get("stiproot/h:pi-agent:revise-pr")?.status).toBe("inactive");
  });

  it("acks {skipped} for a missing cron — idempotent, no redelivery (disarm of a gone cron is a no-op)", async () => {
    const cs = memoryCronStore();
    const res = await runEvent(cs.service, { data: identity });
    expect(res).toEqual({ skipped: "no cron 'stiproot/h:pi-agent:revise-pr'" });
  });

  it("acks {skipped} for a payload lacking a cron identity", async () => {
    const cs = memoryCronStore();
    const res = await runEvent(cs.service, { data: { nope: 1 } });
    expect(res).toMatchObject({ skipped: expect.stringContaining("identity") });
  });

  it("tolerates a raw (un-enveloped) payload", async () => {
    const cs = memoryCronStore();
    cs.rows.set("stiproot/h:pi-agent:revise-pr", activeRow());
    expect(await runEvent(cs.service, identity)).toEqual({
      disarmed: "stiproot/h:pi-agent:revise-pr",
    });
  });
});
