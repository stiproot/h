import { WorkflowError } from "core";
import { EventPublisher, type EventPublisherService } from "./internal.ts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { emptyCronLedger } from "./internal.ts";
import type { SchedRow } from "./internal.ts";
import type { WatchConfig, WatchHeartbeat, WatchLedger, WatchRow } from "./internal.ts";
import { emptyLedger } from "./internal.ts";
import type { StoredWorkflow, WorkflowRequest } from "./internal.ts";
import { CronStore, type CronStoreService } from "./internal.ts";
import { ExecPolicyStore, type ExecPolicyStoreService } from "./internal.ts";
import { QuotaStore, type QuotaStoreService } from "./internal.ts";
import type { QuotaReport, QuotaRow } from "./internal.ts";
import type { ExecPolicy } from "./internal.ts";
import { WatchStore, type WatchStoreService } from "./internal.ts";
import { WorkflowInvoker, type WorkflowInvokerService } from "./internal.ts";
import { WorkflowStore, type WorkflowStoreService } from "./internal.ts";
import {
  invokeWithWatch,
  registerWatchForFire,
  scanWatchesEffect,
  tallyCost,
} from "./watch-scan.ts";

// ---------------------------------------------------------------------------
// In-memory fixtures
// ---------------------------------------------------------------------------

type MemoryWatchStore = {
  service: WatchStoreService;
  rows: Map<string, WatchRow>;
  ledgers: Map<string, WatchLedger>;
  heartbeats: WatchHeartbeat[];
  runRecords: Map<string, number | null>;
  runStopReasons: Map<string, string>;
  runKinds: Map<string, string>;
  runQuota: Map<string, QuotaReport>;
};

function memoryWatchStore(config?: WatchConfig): MemoryWatchStore {
  const rows = new Map<string, WatchRow>();
  const ledgers = new Map<string, WatchLedger>();
  const heartbeats: WatchHeartbeat[] = [];
  const runRecords = new Map<string, number | null>();
  const runStopReasons = new Map<string, string>();
  const runKinds = new Map<string, string>();
  const runQuota = new Map<string, QuotaReport>();
  const service: WatchStoreService = {
    getRow: (id) => Effect.succeed(Option.fromNullable(rows.get(id))),
    listRows: () => Effect.succeed([...rows.values()]),
    saveRow: (row) => Effect.sync(() => void rows.set(row.instanceId, row)),
    deleteRow: (id) => Effect.sync(() => void rows.delete(id)),
    getConfig: () => Effect.succeed(Option.fromNullable(config)),
    getHeartbeat: () => Effect.succeed(Option.fromNullable(heartbeats.at(-1))),
    heartbeat: (beat) => Effect.sync(() => void heartbeats.push(beat)),
    getLedger: (date) => Effect.succeed(ledgers.get(date) ?? emptyLedger),
    bumpLedger: (date, delta) =>
      Effect.sync(() => {
        const current = ledgers.get(date) ?? emptyLedger;
        const costByAgent = { ...current.costByAgent };
        for (const [agent, usd] of Object.entries(delta.costByAgent ?? {})) {
          costByAgent[agent] = (costByAgent[agent] ?? 0) + usd;
        }
        ledgers.set(date, {
          runsFired: current.runsFired + (delta.runsFired ?? 0),
          runsFinalized: current.runsFinalized + (delta.runsFinalized ?? 0),
          engineFires: current.engineFires + (delta.engineFires ?? 0),
          costUsd: current.costUsd + (delta.costUsd ?? 0),
          costByAgent,
          costGapRuns: (current.costGapRuns ?? 0) + (delta.costGapRuns ?? 0),
        });
      }),
    listRunKeys: () => Effect.succeed([...runRecords.keys()]),
    // Meta derived from the two seed maps; agentId parsed off the ledger key shape
    // (`run:<instanceId>:<agentId>:<ts>`), kind null (an agent run, not an activity).
    getRunMeta: (key) =>
      Effect.succeed(
        runRecords.has(key) || runStopReasons.has(key)
          ? {
              costUsd: runRecords.get(key) ?? null,
              costPartial: false,
              stopReason: runStopReasons.get(key) ?? null,
              agentId: key.split(":").at(-2) ?? null,
              kind: runKinds.get(key) ?? null,
              quota: runQuota.get(key) ?? null,
            }
          : null,
      ),
  };
  return { service, rows, ledgers, heartbeats, runRecords, runStopReasons, runKinds, runQuota };
}

const stubInvoker = (overrides: Partial<WorkflowInvokerService> = {}): WorkflowInvokerService => ({
  invoke: () => Effect.succeed({ instanceId: "generated-id" }),
  getStatus: (instanceId) => Effect.succeed({ instanceId, runtimeStatus: "RUNNING" }),
  terminate: () => Effect.void,
  ...overrides,
});

const stubWorkflowStore = (
  overrides: Partial<WorkflowStoreService> = {},
): WorkflowStoreService => ({
  save: () => Effect.void,
  get: () => Effect.succeed(Option.none()),
  list: () => Effect.succeed([]),
  listScheduled: () => Effect.succeed([]),
  markRun: () => Effect.void,
  ...overrides,
});

function capturingPublisher(): { service: EventPublisherService; events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    service: {
      publish: (_topic, data) => Effect.sync(() => void events.push(data)),
    },
  };
}

// A cron store that records the sched rows the fallback arms; the rest is inert (fallback only
// writes sched rows + reads nothing from cron).
function memorySchedStore(): { service: CronStoreService; sched: Map<string, SchedRow> } {
  const sched = new Map<string, SchedRow>();
  return {
    sched,
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
      getLedger: () => Effect.succeed(emptyCronLedger),
      bumpLedger: () => Effect.void,
    },
  };
}

// In-memory exec-policy store so the auto-deny's writes are observable.
function memoryExecPolicyStore(): {
  service: ExecPolicyStoreService;
  saved: ExecPolicy[];
  current: () => ExecPolicy | undefined;
} {
  const saved: ExecPolicy[] = [];
  return {
    saved,
    current: () => saved[saved.length - 1],
    service: {
      get: () => Effect.succeed(Option.fromNullable(saved[saved.length - 1])),
      save: (policy) => Effect.sync(() => void saved.push(policy)),
    },
  };
}

// In-memory quota store so the finalize's `quota:` writes are observable.
function memoryQuotaStore(): { service: QuotaStoreService; rows: Map<string, QuotaRow> } {
  const rows = new Map<string, QuotaRow>();
  return {
    rows,
    service: {
      get: (executor) => Effect.succeed(Option.fromNullable(rows.get(executor))),
      list: () => Effect.succeed([...rows.values()]),
      save: (row) => Effect.sync(() => void rows.set(row.executor, row)),
    },
  };
}

function env(
  ws: WatchStoreService,
  invoker: WorkflowInvokerService,
  wfStore: WorkflowStoreService = stubWorkflowStore(),
  publisher: EventPublisherService = capturingPublisher().service,
  cron: CronStoreService = memorySchedStore().service,
  execPolicy: ExecPolicyStoreService = memoryExecPolicyStore().service,
  quota: QuotaStoreService = memoryQuotaStore().service,
) {
  return Layer.mergeAll(
    Layer.succeed(QuotaStore, quota),
    Layer.succeed(WatchStore, ws),
    Layer.succeed(WorkflowInvoker, invoker),
    Layer.succeed(WorkflowStore, wfStore),
    Layer.succeed(EventPublisher, publisher),
    Layer.succeed(CronStore, cron),
    Layer.succeed(ExecPolicyStore, execPolicy),
  );
}

function activeRow(overrides: Partial<WatchRow> = {}): WatchRow {
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  return {
    instanceId: "feature-issue-12",
    epoch: 1,
    attempts: 1,
    startedAt,
    policy: { maxDurationMs: 45 * 60_000 },
    status: "watching",
    lastStatus: "RUNNING",
    unknownStreak: 0,
    updatedAt: startedAt,
    ...overrides,
  };
}

const today = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// registerWatchForFire
// ---------------------------------------------------------------------------

describe("registerWatchForFire", () => {
  it("writes a scheduling row with epoch 1 / attempts 1 and counts the fire", async () => {
    const mem = memoryWatchStore();
    await Effect.runPromise(
      registerWatchForFire(
        "wf-1",
        { maxDurationMs: 1000 },
        { resubmit: { steps: [] }, meta: { owner: "discover" } },
      ).pipe(Effect.provide(Layer.succeed(WatchStore, mem.service))),
    );
    const row = mem.rows.get("wf-1")!;
    expect(row).toMatchObject({
      epoch: 1,
      attempts: 1,
      status: "scheduling",
      meta: { owner: "discover" },
    });
    expect(mem.ledgers.get(today())).toMatchObject({ runsFired: 1 });
  });

  it("leaves an active row untouched on a non-fresh re-fire (same incarnation)", async () => {
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1", epoch: 3 }));
    await Effect.runPromise(
      registerWatchForFire("wf-1", { maxDurationMs: 1 }).pipe(
        Effect.provide(Layer.succeed(WatchStore, mem.service)),
      ),
    );
    expect(mem.rows.get("wf-1")!.epoch).toBe(3);
    expect(mem.ledgers.size).toBe(0);
  });

  it("bumps epoch/attempts and resets the deadline base on a fresh re-fire", async () => {
    const mem = memoryWatchStore();
    const old = activeRow({ instanceId: "wf-1", epoch: 2, attempts: 1, status: "finalized" });
    mem.rows.set("wf-1", old);
    await Effect.runPromise(
      registerWatchForFire("wf-1", { maxDurationMs: 1000 }, { fresh: true }).pipe(
        Effect.provide(Layer.succeed(WatchStore, mem.service)),
      ),
    );
    const row = mem.rows.get("wf-1")!;
    expect(row.epoch).toBe(3);
    expect(row.attempts).toBe(2);
    expect(row.status).toBe("scheduling");
    expect(Date.parse(row.startedAt)).toBeGreaterThan(Date.parse(old.startedAt));
  });

  it("W5: a fresh re-fire WITHOUT a watch field still refreshes an existing row's epoch", async () => {
    // Otherwise the stale watch budget-terminates the new incarnation with the old startedAt.
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1", epoch: 4 }));
    await Effect.runPromise(
      registerWatchForFire("wf-1", undefined, { fresh: true }).pipe(
        Effect.provide(Layer.succeed(WatchStore, mem.service)),
      ),
    );
    expect(mem.rows.get("wf-1")!.epoch).toBe(5);
  });

  it("does nothing for an unwatched, non-fresh fire", async () => {
    const mem = memoryWatchStore();
    const result = await Effect.runPromise(
      registerWatchForFire("wf-1", undefined).pipe(
        Effect.provide(Layer.succeed(WatchStore, mem.service)),
      ),
    );
    expect(result).toEqual({ registered: false });
    expect(mem.rows.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// invokeWithWatch (the fire choke point: required-or-derived id, mark-before-fire)
// ---------------------------------------------------------------------------

describe("invokeWithWatch", () => {
  // Echoes the scheduled id and reads unscheduled instances as UNKNOWN — the real invoker's
  // contract, which the derived-id free-slot check rides on.
  function echoInvoker(taken: string[] = []): {
    service: WorkflowInvokerService;
    invokes: WorkflowRequest[];
  } {
    const invokes: WorkflowRequest[] = [];
    const live = new Set(taken);
    return {
      invokes,
      service: {
        invoke: (req) =>
          Effect.sync(() => {
            invokes.push(req);
            return { instanceId: req.instanceId! };
          }),
        getStatus: (instanceId) =>
          Effect.succeed({
            instanceId,
            runtimeStatus: live.has(instanceId) ? "RUNNING" : "UNKNOWN",
          }),
        terminate: () => Effect.void,
      },
    };
  }
  const chokeEnv = (ws: WatchStoreService, invoker: WorkflowInvokerService) =>
    Layer.mergeAll(Layer.succeed(WatchStore, ws), Layer.succeed(WorkflowInvoker, invoker));

  it("derives a readable id from the descriptor's key, registers mark-before-fire, strips descriptor fields", async () => {
    const mem = memoryWatchStore();
    const inv = echoInvoker();
    const result = await Effect.runPromise(
      invokeWithWatch({
        key: "feature-pr",
        steps: [{ activity: "run-claude" }],
        watch: { maxDurationMs: 1000 },
        watchMeta: { owner: "test" },
      }).pipe(Effect.provide(chokeEnv(mem.service, inv.service))),
    );
    expect(result.instanceId).toMatch(/^feature-pr-\d{6}-\d{6}$/);
    expect(result.watching).toBe(true);
    // The watch row landed under the derived id (mark-before-fire, no weak form left).
    expect(mem.rows.get(result.instanceId)).toMatchObject({ status: "scheduling" });
    // The invoke saw the derived id but none of the registry/provenance fields.
    expect(inv.invokes[0]!.instanceId).toBe(result.instanceId);
    expect(inv.invokes[0]).not.toHaveProperty("key");
    expect(inv.invokes[0]).not.toHaveProperty("watch");
    expect(inv.invokes[0]).not.toHaveProperty("watchMeta");
  });

  it("falls back to the wf-identity workflow name, then 'run', as the derivation base", async () => {
    const mem = memoryWatchStore();
    const inv = echoInvoker();
    const provided = chokeEnv(mem.service, inv.service);
    const viaWf = await Effect.runPromise(
      invokeWithWatch({
        steps: [],
        wf: { repo: "o/r", slug: "s", workflow: "revise-pr" },
      }).pipe(Effect.provide(provided)),
    );
    expect(viaWf.instanceId).toMatch(/^revise-pr-\d{6}-\d{6}$/);
    const bare = await Effect.runPromise(
      invokeWithWatch({ steps: [] }).pipe(Effect.provide(provided)),
    );
    expect(bare.instanceId).toMatch(/^run-\d{6}-\d{6}$/);
  });

  it("suffixes -2 loudly when the derived id already names an instance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T09:05:42Z"));
    try {
      const mem = memoryWatchStore();
      // The same-second candidate is already claimed — the fire steps to a visible -2.
      const collided = echoInvoker(["nightly-260731-090542"]);
      const result = await Effect.runPromise(
        invokeWithWatch({ key: "nightly", steps: [] }).pipe(
          Effect.provide(chokeEnv(mem.service, collided.service)),
        ),
      );
      expect(result.instanceId).toBe("nightly-260731-090542-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a caller-chosen instanceId always wins over derivation", async () => {
    const mem = memoryWatchStore();
    const inv = echoInvoker();
    const result = await Effect.runPromise(
      invokeWithWatch({ key: "feature-pr", steps: [], instanceId: "feature-x" }).pipe(
        Effect.provide(chokeEnv(mem.service, inv.service)),
      ),
    );
    expect(result.instanceId).toBe("feature-x");
  });
});

// ---------------------------------------------------------------------------
// scanWatchesEffect
// ---------------------------------------------------------------------------

describe("scanWatchesEffect", () => {
  it("heartbeats and skips the scan when watch:config disables the engine", async () => {
    const mem = memoryWatchStore({ enabled: false });
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1" }));
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(Effect.provide(env(mem.service, stubInvoker()))),
    );
    expect(report.disabled).toBe(true);
    expect(report.scanned).toBe(0);
    // Disarmed is a recorded, distinguishable state — not a dead heartbeat.
    expect(mem.heartbeats.at(-1)).toMatchObject({ enabled: false });
  });

  it("treats absent config as enabled (no silent disarm by missing bootstrap)", async () => {
    const mem = memoryWatchStore();
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(Effect.provide(env(mem.service, stubInvoker()))),
    );
    expect(report.disabled).toBeUndefined();
    expect(mem.heartbeats.at(-1)).toMatchObject({ enabled: true });
  });

  it("finalizes a completed run: row, ledger, terminal event, cost tally", async () => {
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1" }));
    mem.runRecords.set("run:wf-1:claude-agent:123", 1.25);
    mem.runRecords.set("run:wf-1:claude-agent:456", 0.5);
    mem.runRecords.set("run:other:claude-agent:789", 99); // different instance — excluded
    const pub = capturingPublisher();
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "COMPLETED" }),
            }),
            stubWorkflowStore(),
            pub.service,
          ),
        ),
      ),
    );
    expect(report.finalized).toEqual(["wf-1:completed"]);
    const row = mem.rows.get("wf-1")!;
    expect(row).toMatchObject({ status: "finalized", outcome: "completed", costUsd: 1.75 });
    expect(row.costGap).toBeUndefined();
    expect(mem.ledgers.get(today())).toMatchObject({ runsFinalized: 1, costUsd: 1.75 });
    expect(pub.events[0]).toMatchObject({
      instanceId: "wf-1",
      outcome: "completed",
      watcher: "workflow-svc",
      costUsd: 1.75,
    });
  });

  it("refines a COMPLETED run to usage-limited when a run mirror reports stopReason usage-limited", async () => {
    // The outcome inversion: a limited Claude run exits 0 → Dapr COMPLETED, but the mirror carries
    // stopReason "usage-limited", so the finalized outcome is upgraded off the ledger.
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1" }));
    mem.runRecords.set("run:wf-1:claude-agent:123", 0.5);
    mem.runStopReasons.set("run:wf-1:claude-agent:123", "usage-limited");
    const pub = capturingPublisher();
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "COMPLETED" }),
            }),
            stubWorkflowStore(),
            pub.service,
          ),
        ),
      ),
    );
    expect(report.finalized).toEqual(["wf-1:usage-limited"]);
    expect(mem.rows.get("wf-1")).toMatchObject({ status: "finalized", outcome: "usage-limited" });
    expect(pub.events[0]).toMatchObject({ outcome: "usage-limited" });
  });

  it("auto-denies the limited executor on a usage-limited finalize", async () => {
    // The fleet fence: the run key carries the agentId (claude-agent), so the finalize writes a
    // usage-limited exec:config entry for `claude` — every subsequent fire on any path is refused
    // at the activity gate until the entry expires or the operator lifts it.
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1" }));
    mem.runRecords.set("run:wf-1:claude-agent:123", 0.5);
    mem.runStopReasons.set("run:wf-1:claude-agent:123", "usage-limited");
    const exec = memoryExecPolicyStore();
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "COMPLETED" }),
            }),
            stubWorkflowStore(),
            capturingPublisher().service,
            memorySchedStore().service,
            exec.service,
          ),
        ),
      ),
    );
    expect(report.autoDenied).toEqual(["claude"]);
    const entry = exec.current()!.denied[0]!;
    expect(entry).toMatchObject({ name: "claude", reason: "usage-limited" });
    expect((entry as { until?: string }).until).toBeDefined();
  });

  it("auto-deny never downgrades an operator entry (already denied — nothing written)", async () => {
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1" }));
    mem.runStopReasons.set("run:wf-1:claude-agent:123", "usage-limited");
    const exec = memoryExecPolicyStore();
    exec.saved.push({ denied: ["claude"], updatedAt: "2026-07-29T00:00:00Z" }); // operator shape
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "COMPLETED" }),
            }),
            stubWorkflowStore(),
            capturingPublisher().service,
            memorySchedStore().service,
            exec.service,
          ),
        ),
      ),
    );
    expect(report.autoDenied).toEqual([]);
    expect(exec.saved).toHaveLength(1); // the operator row is untouched
  });

  it("does NOT refine a budget-terminated outcome even if a mirror says usage-limited", async () => {
    // Only completed/failed are refined; a budget kill is not a usage limit.
    const mem = memoryWatchStore();
    mem.runStopReasons.set("run:wf-1:claude-agent:123", "usage-limited");
    mem.runRecords.set("run:wf-1:claude-agent:123", 0.5);
    // Deadline already passed → budget-terminate → finalize budget-terminated.
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1", startedAt: "2000-01-01T00:00:00Z" }));
    await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "RUNNING" }),
              terminate: () => Effect.void,
            }),
          ),
        ),
      ),
    );
    expect(mem.rows.get("wf-1")!.outcome).toBe("budget-terminated");
  });

  it("flags a LEDGER GAP instead of a silent $0 when no run mirrors match", async () => {
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1" }));
    await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "COMPLETED" }),
            }),
          ),
        ),
      ),
    );
    expect(mem.rows.get("wf-1")).toMatchObject({ costUsd: 0, costGap: true });
  });

  it("budget-terminates past the deadline and finalizes as budget-terminated", async () => {
    const mem = memoryWatchStore();
    const terminated: string[] = [];
    mem.rows.set(
      "wf-1",
      activeRow({
        instanceId: "wf-1",
        startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        policy: { maxDurationMs: 30 * 60_000 },
      }),
    );
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              terminate: (id) => Effect.sync(() => void terminated.push(id)),
            }),
          ),
        ),
      ),
    );
    expect(terminated).toEqual(["wf-1"]);
    expect(report.terminated).toEqual(["wf-1"]);
    expect(mem.rows.get("wf-1")).toMatchObject({
      status: "finalized",
      outcome: "budget-terminated",
    });
  });

  it("W8: a rejected terminate against an already-terminal instance still finalizes", async () => {
    const mem = memoryWatchStore();
    mem.rows.set(
      "wf-1",
      activeRow({
        instanceId: "wf-1",
        startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        policy: { maxDurationMs: 30 * 60_000 },
      }),
    );
    let statusCalls = 0;
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              // First status read says RUNNING (drives the budget path); the post-rejection
              // re-check says TERMINATED — the race's loser treats that as success.
              getStatus: (id) => {
                statusCalls += 1;
                return Effect.succeed({
                  instanceId: id,
                  runtimeStatus: statusCalls === 1 ? "RUNNING" : "TERMINATED",
                });
              },
              terminate: (id) =>
                Effect.fail(new WorkflowError({ cause: new Error("409"), instanceId: id })),
            }),
          ),
        ),
      ),
    );
    expect(report.terminated).toEqual(["wf-1"]);
    expect(mem.rows.get("wf-1")!.status).toBe("finalized");
  });

  it("a rejected terminate against a still-live instance waits for the next tick", async () => {
    const mem = memoryWatchStore();
    mem.rows.set(
      "wf-1",
      activeRow({
        instanceId: "wf-1",
        startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        policy: { maxDurationMs: 30 * 60_000 },
      }),
    );
    await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              terminate: (id) =>
                Effect.fail(new WorkflowError({ cause: new Error("rejected"), instanceId: id })),
            }),
          ),
        ),
      ),
    );
    // Never finalize a run that is still actually running.
    const row = mem.rows.get("wf-1")!;
    expect(row.status).not.toBe("finalized");
    expect(row.note).toContain("terminate rejected");
  });

  it("retries a failed run: mark-before-fire, epoch bump, fresh purge, engine-fire ledger", async () => {
    const mem = memoryWatchStore();
    const invoked: WorkflowRequest[] = [];
    mem.rows.set(
      "wf-1",
      activeRow({
        instanceId: "wf-1",
        policy: { maxDurationMs: 60_000, retry: { maxAttempts: 2 } },
        resubmit: { steps: [{ activity: "run-claude", input: { task: "t" } }], workspaceId: "ws" },
      }),
    );
    const report = await Effect.runPromise(
      scanWatchesEffect("00-abc-def-01").pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "FAILED" }),
              invoke: (input) => {
                invoked.push(input);
                return Effect.succeed({ instanceId: input.instanceId ?? "?" });
              },
            }),
          ),
        ),
      ),
    );
    expect(report.retried).toEqual(["wf-1"]);
    expect(invoked[0]).toMatchObject({
      instanceId: "wf-1",
      fresh: true, // a terminal instance must purge to re-run
      workspaceId: "ws",
      traceparent: "00-abc-def-01",
    });
    const row = mem.rows.get("wf-1")!;
    expect(row).toMatchObject({ epoch: 2, attempts: 2, status: "scheduling" });
    expect(mem.ledgers.get(today())).toMatchObject({ runsFired: 1, engineFires: 1 });
  });

  const usageLimitedFallbackRow = (overrides: Partial<import("./internal.ts").WatchPolicy> = {}) =>
    activeRow({
      instanceId: "wf-1",
      policy: {
        maxDurationMs: 60_000,
        fallback: {
          onOutcome: ["usage-limited"],
          after: 600_000,
          identity: { runActivity: "run-openhands", agentId: "openhands-agent" },
          maxHandoffs: 2,
        },
        ...overrides,
      },
      resubmit: {
        steps: [{ activity: "{{params.runActivity}}", input: { task: "t" } }],
        params: { repo: "o/r" },
        workspaceId: "ws-1",
      },
    });

  const scanForFallback = (mem: MemoryWatchStore, cron: CronStoreService) =>
    Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "COMPLETED" }),
            }),
            stubWorkflowStore(),
            capturingPublisher().service,
            cron,
          ),
        ),
      ),
    );

  it("usage-limited fallback: arms a cron:sched row under a different agent, decrements the budget", async () => {
    const mem = memoryWatchStore({ maxEngineFiresPerDay: 10 });
    const cron = memorySchedStore();
    mem.rows.set("wf-1", usageLimitedFallbackRow());
    mem.runRecords.set("run:wf-1:claude-agent:1", 0.5);
    mem.runStopReasons.set("run:wf-1:claude-agent:1", "usage-limited");
    const report = await scanForFallback(mem, cron.service);

    expect(report.fallbacks).toHaveLength(1);
    const sched = [...cron.sched.values()][0]!;
    expect(sched.origin).toBe("fallback:usage-limited");
    expect(sched.status).toBe("armed");
    expect(sched.trigger.workspaceId).toBe("ws-1"); // reuse the limited run's workspace
    // The identity override wins over the resubmit params → a different agent re-enters the steps.
    expect(sched.trigger.params).toMatchObject({
      repo: "o/r",
      runActivity: "run-openhands",
      agentId: "openhands-agent",
    });
    expect(sched.trigger.instanceId).toBe(sched.id);
    expect(sched.handoffsRemaining).toBe(1);
    // The continuation is itself supervised with the decremented budget (can't ping-pong forever).
    expect(sched.trigger.watch?.fallback?.maxHandoffs).toBe(1);
    expect(mem.ledgers.get(today())).toMatchObject({ engineFires: 1 });
  });

  it("fallback is fail-closed without maxEngineFiresPerDay (never fires)", async () => {
    const mem = memoryWatchStore(); // no config
    const cron = memorySchedStore();
    mem.rows.set("wf-1", usageLimitedFallbackRow());
    mem.runRecords.set("run:wf-1:claude-agent:1", 0.5);
    mem.runStopReasons.set("run:wf-1:claude-agent:1", "usage-limited");
    const report = await scanForFallback(mem, cron.service);
    expect(report.fallbacks).toHaveLength(0);
    expect(cron.sched.size).toBe(0);
  });

  it("fallback stops when the handoff budget is exhausted (maxHandoffs 0)", async () => {
    const mem = memoryWatchStore({ maxEngineFiresPerDay: 10 });
    const cron = memorySchedStore();
    mem.rows.set(
      "wf-1",
      usageLimitedFallbackRow({
        fallback: { onOutcome: ["usage-limited"], identity: { agentId: "x" }, maxHandoffs: 0 },
      }),
    );
    mem.runRecords.set("run:wf-1:claude-agent:1", 0.5);
    mem.runStopReasons.set("run:wf-1:claude-agent:1", "usage-limited");
    const report = await scanForFallback(mem, cron.service);
    expect(report.fallbacks).toHaveLength(0);
  });

  it("a failed retry dispatch finalizes with the original outcome (no infinite retry loop)", async () => {
    const mem = memoryWatchStore();
    mem.rows.set(
      "wf-1",
      activeRow({
        instanceId: "wf-1",
        policy: { maxDurationMs: 60_000, retry: { maxAttempts: 3 } },
        resubmit: { steps: [] },
      }),
    );
    await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "FAILED" }),
              invoke: () =>
                Effect.fail(
                  new WorkflowError({ cause: new Error("purge failed"), instanceId: "wf-1" }),
                ),
            }),
          ),
        ),
      ),
    );
    const row = mem.rows.get("wf-1")!;
    expect(row.status).toBe("finalized");
    expect(row.outcome).toBe("failed");
    expect(row.note).toContain("retry dispatch failed");
  });

  it("escalates on a matching outcome: gated, budgeted child watch row, facts as params", async () => {
    const mem = memoryWatchStore({ enabled: true, maxEngineFiresPerDay: 10 });
    const invoked: WorkflowRequest[] = [];
    const storedTemplate: StoredWorkflow = { steps: [{ activity: "run-claude" }] };
    mem.rows.set(
      "wf-1",
      activeRow({
        instanceId: "wf-1",
        policy: {
          maxDurationMs: 60_000,
          escalate: { onOutcome: ["failed"], key: "escalate-human", params: { channel: "ops" } },
        },
      }),
    );
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "FAILED" }),
              invoke: (input) => {
                invoked.push(input);
                return Effect.succeed({ instanceId: input.instanceId ?? "?" });
              },
            }),
            stubWorkflowStore({
              get: (key) =>
                Effect.succeed(
                  key === "escalate-human" ? Option.some(storedTemplate) : Option.none(),
                ),
            }),
          ),
        ),
      ),
    );
    expect(report.escalated).toEqual(["esc-wf-1-e1"]);
    expect(invoked[0]!.params).toMatchObject({
      channel: "ops",
      watchedInstanceId: "wf-1",
      outcome: "failed",
    });
    // The child is itself watched and budgeted (agreement 7).
    const child = mem.rows.get("esc-wf-1-e1")!;
    expect(child).toMatchObject({ status: "scheduling", policy: { maxDurationMs: 60_000 } });
    expect(mem.ledgers.get(today())!.engineFires).toBeGreaterThanOrEqual(1);
  });

  it("escalation is fail-closed: no configured daily cap → never fires", async () => {
    const mem = memoryWatchStore({ enabled: true }); // no maxEngineFiresPerDay
    mem.rows.set(
      "wf-1",
      activeRow({
        instanceId: "wf-1",
        policy: { maxDurationMs: 60_000, escalate: { onOutcome: ["failed"], key: "esc" } },
      }),
    );
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "FAILED" }),
            }),
          ),
        ),
      ),
    );
    expect(report.escalated).toEqual([]);
    expect(report.errors.some((e) => e.includes("fail-closed"))).toBe(true);
  });

  it("epoch fencing: a re-fire mid-decision drops the stale finalize", async () => {
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1", epoch: 1 }));
    await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) =>
                Effect.gen(function* () {
                  // Simulate a concurrent fresh re-fire landing between the status read and
                  // the row write: the stored epoch moves to 2.
                  const current = mem.rows.get("wf-1")!;
                  if (current.epoch === 1) {
                    mem.rows.set("wf-1", { ...current, epoch: 2, status: "scheduling" });
                  }
                  return yield* Effect.succeed({ instanceId: id, runtimeStatus: "COMPLETED" });
                }),
            }),
          ),
        ),
      ),
    );
    // The stale finalize (computed against epoch 1) must not clobber the new incarnation.
    expect(mem.rows.get("wf-1")).toMatchObject({ epoch: 2, status: "scheduling" });
  });

  it("one row's failure never starves the rest of the fleet", async () => {
    const mem = memoryWatchStore();
    mem.rows.set("bad", activeRow({ instanceId: "bad" }));
    mem.rows.set("good", activeRow({ instanceId: "good" }));
    // A store whose writes fail for the "bad" row only.
    const service: typeof mem.service = {
      ...mem.service,
      saveRow: (row) =>
        row.instanceId === "bad"
          ? Effect.fail(new WorkflowError({ cause: new Error("redis down"), instanceId: "bad" }))
          : mem.service.saveRow(row),
    };
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "COMPLETED" }),
            }),
          ),
        ),
      ),
    );
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("bad");
    expect(report.finalized).toEqual(["good:completed"]);
    expect(mem.rows.get("good")!.status).toBe("finalized");
  });
});

describe("scanWatchesEffect — the quota registry", () => {
  const hour = 3_600_000;
  const reportAt = (
    utilization: number,
    status: QuotaReport["status"] = "allowed",
  ): QuotaReport => ({
    status,
    windows: {
      five_hour: { utilization, resetsAt: new Date(Date.now() + hour).toISOString() },
      seven_day: { utilization: 0.3, resetsAt: new Date(Date.now() + 5 * 24 * hour).toISOString() },
    },
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    spent: { five_hour: 0.12 },
  });

  const scan = (
    mem: MemoryWatchStore,
    quota: QuotaStoreService,
    cron?: CronStoreService,
    exec?: ExecPolicyStoreService,
  ) =>
    Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "COMPLETED" }),
            }),
            stubWorkflowStore(),
            capturingPublisher().service,
            cron ?? memorySchedStore().service,
            exec ?? memoryExecPolicyStore().service,
            quota,
          ),
        ),
      ),
    );

  it("folds a completed run's quota report into the executor's row — every finalize, not only limits", async () => {
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1" }));
    mem.runRecords.set("run:wf-1:claude-agent:1", 0.5);
    mem.runQuota.set("run:wf-1:claude-agent:1", reportAt(0.4));
    const quota = memoryQuotaStore();
    const report = await scan(mem, quota.service);
    expect(report.quotaRecorded).toEqual(["claude"]);
    const row = quota.rows.get("claude")!;
    expect(row.status).toBe("allowed");
    expect(row.windows.five_hour?.utilization).toBe(0.4);
    expect(row.runId).toBe("wf-1:claude-agent:1");
    expect(row.history).toEqual([
      expect.objectContaining({ runId: "wf-1:claude-agent:1", spent: { five_hour: 0.12 } }),
    ]);
  });

  it("a usage-limited finalize fences until the exhausted window RESETS, not the flat default", async () => {
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1" }));
    mem.runRecords.set("run:wf-1:claude-agent:1", 0.5);
    mem.runStopReasons.set("run:wf-1:claude-agent:1", "usage-limited");
    const limited = reportAt(1, "rejected");
    mem.runQuota.set("run:wf-1:claude-agent:1", limited);
    const exec = memoryExecPolicyStore();
    const report = await scan(mem, memoryQuotaStore().service, undefined, exec.service);
    expect(report.autoDenied).toEqual(["claude"]);
    const entry = exec.current()!.denied[0] as { until?: string };
    const expected = new Date(limited.windows.five_hour!.resetsAt).getTime() + 60_000;
    expect(new Date(entry.until!).getTime()).toBe(expected);
  });

  it("onQuota: wait arms a SAME-identity continuation after the reset, decrementing the wait budget", async () => {
    const mem = memoryWatchStore({ maxEngineFiresPerDay: 10 });
    const cron = memorySchedStore();
    mem.rows.set(
      "wf-1",
      activeRow({
        instanceId: "wf-1",
        policy: { maxDurationMs: 60_000, onQuota: "wait" },
        resubmit: {
          steps: [{ activity: "run-claude", input: { task: "t" } }],
          params: { repo: "o/r", agentId: "claude-agent" },
          workspaceId: "ws-1",
        },
      }),
    );
    mem.runRecords.set("run:wf-1:claude-agent:1", 0.5);
    mem.runStopReasons.set("run:wf-1:claude-agent:1", "usage-limited");
    const limited = reportAt(1, "rejected");
    mem.runQuota.set("run:wf-1:claude-agent:1", limited);
    const report = await scan(mem, memoryQuotaStore().service, cron.service);
    expect(report.quotaWaits).toEqual(["qw-wf-1-e1"]);
    const sched = [...cron.sched.values()][0]!;
    expect(sched.origin).toBe("quota-wait");
    expect(sched.trigger.params).toEqual({ repo: "o/r", agentId: "claude-agent" }); // no identity swap
    expect(sched.trigger.workspaceId).toBe("ws-1");
    expect(sched.trigger.watch?.maxQuotaWaits).toBe(1);
    // Fires AFTER the auto-deny fence (reset + slack) has expired, so the gate lets it through.
    const fence = new Date(limited.windows.five_hour!.resetsAt).getTime() + 60_000;
    expect(new Date(sched.fireAt).getTime()).toBeGreaterThan(fence);
    expect(mem.ledgers.get(today())).toMatchObject({ engineFires: 1 });
  });

  it("onQuota: wait is fail-closed — no reset time reported means no continuation", async () => {
    const mem = memoryWatchStore({ maxEngineFiresPerDay: 10 });
    const cron = memorySchedStore();
    mem.rows.set(
      "wf-1",
      activeRow({
        instanceId: "wf-1",
        policy: { maxDurationMs: 60_000, onQuota: "wait" },
        resubmit: { steps: [{ activity: "run-claude", input: {} }], params: {} },
      }),
    );
    mem.runRecords.set("run:wf-1:claude-agent:1", 0.5);
    mem.runStopReasons.set("run:wf-1:claude-agent:1", "usage-limited");
    const report = await scan(mem, memoryQuotaStore().service, cron.service);
    expect(report.quotaWaits).toEqual([]);
    expect(cron.sched.size).toBe(0);
    expect(report.errors.join("\n")).toContain("reported no reset time");
  });
});

describe("tallyCost", () => {
  it("prefix-matches runIds under the instance and sums numeric costs only", async () => {
    const mem = memoryWatchStore();
    mem.runRecords.set("run:wf-1:claude-agent:1", 1.2);
    mem.runRecords.set("run:wf-1:setup:2", null); // activity record, no cost — not a gap
    mem.runKinds.set("run:wf-1:setup:2", "activity");
    mem.runRecords.set("run:wf-10:claude-agent:3", 50); // wf-10 is NOT wf-1 (issue #10's trap)
    const result = await Effect.runPromise(
      tallyCost("wf-1").pipe(Effect.provide(Layer.succeed(WatchStore, mem.service))),
    );
    expect(result).toEqual({
      costUsd: 1.2,
      costGap: false,
      gapRuns: 0,
      costByAgent: { "claude-agent": 1.2 },
    });
  });

  it("an AGENT run with no usable cost is a per-run gap, never a silent $0 (B3)", async () => {
    // The Moonshot $20 day's hole 1: a timed-out kimi run mirrors costUsd null — before B3 the
    // tally skipped it silently (costGap only fired when NO mirror matched at all).
    const mem = memoryWatchStore();
    mem.runRecords.set("run:wf-1:claude-agent:1", 2.5);
    mem.runRecords.set("run:wf-1:kimi-agent:2", null); // timed out — usage lost, cost unknown
    const result = await Effect.runPromise(
      tallyCost("wf-1").pipe(Effect.provide(Layer.succeed(WatchStore, mem.service))),
    );
    expect(result).toEqual({
      costUsd: 2.5,
      costGap: true,
      gapRuns: 1,
      costByAgent: { "claude-agent": 2.5 },
    });
  });

  it("crossing an exec:config daily budget at finalize writes an expiring cost-budget deny (A1)", async () => {
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1" }));
    mem.runRecords.set("run:wf-1:kimi-agent:1", 5.5); // over kimi's $5/day budget
    const exec = memoryExecPolicyStore();
    exec.saved.push({ denied: [], updatedAt: "2026-07-30T00:00:00Z", budgets: { kimi: 5 } });
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "COMPLETED" }),
            }),
            stubWorkflowStore(),
            capturingPublisher().service,
            memorySchedStore().service,
            exec.service,
          ),
        ),
      ),
    );
    expect(report.autoDenied).toContain("kimi:cost-budget");
    const entry = exec
      .current()!
      .denied.find((d) => typeof d !== "string" && d.name === "kimi") as {
      reason: string;
      until?: string;
    };
    expect(entry.reason).toBe("cost-budget");
    expect(entry.until).toMatch(/T00:00:00.000Z$/); // expires at the next UTC midnight
    // The budget table survives the merge.
    expect(exec.current()!.budgets).toEqual({ kimi: 5 });
  });

  it("a finalize under every budget writes no deny (and no budgets ⇒ no check at all)", async () => {
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1" }));
    mem.runRecords.set("run:wf-1:kimi-agent:1", 1.5);
    const exec = memoryExecPolicyStore();
    exec.saved.push({ denied: [], updatedAt: "2026-07-30T00:00:00Z", budgets: { kimi: 5 } });
    const report = await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "COMPLETED" }),
            }),
            stubWorkflowStore(),
            capturingPublisher().service,
            memorySchedStore().service,
            exec.service,
          ),
        ),
      ),
    );
    expect(report.autoDenied).toEqual([]);
    expect(exec.current()!.denied).toEqual([]);
  });

  it("per-agent subtotals and gap counts land on the day ledger at finalize", async () => {
    const mem = memoryWatchStore();
    mem.rows.set("wf-1", activeRow({ instanceId: "wf-1" }));
    mem.runRecords.set("run:wf-1:claude-agent:1", 3.1);
    mem.runRecords.set("run:wf-1:kimi-agent:2", null); // timed out — cost unknown, a gap
    await Effect.runPromise(
      scanWatchesEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            stubInvoker({
              getStatus: (id) => Effect.succeed({ instanceId: id, runtimeStatus: "COMPLETED" }),
            }),
          ),
        ),
      ),
    );
    const ledger = mem.ledgers.get(today())!;
    expect(ledger.costByAgent).toEqual({ "claude-agent": 3.1 });
    expect(ledger.costGapRuns).toBe(1);
  });
});
