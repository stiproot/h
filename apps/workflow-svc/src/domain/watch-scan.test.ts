import { WorkflowError } from "core";
import { DaprPublisherTag, type DaprPublisherService } from "core-dapr";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { emptyCronLedger } from "./models/cron.model.ts";
import type { SchedRow } from "./models/schedule.model.ts";
import type { WatchConfig, WatchHeartbeat, WatchLedger, WatchRow } from "./models/watch.model.ts";
import { emptyLedger } from "./models/watch.model.ts";
import type { StoredWorkflow, WorkflowRequest } from "./models/workflow.model.ts";
import { CronStore, type CronStoreService } from "./ports/ICronStore.ts";
import { ExecPolicyStore, type ExecPolicyStoreService } from "./ports/IExecPolicyStore.ts";
import type { ExecPolicy } from "./models/exec.model.ts";
import { WatchStore, type WatchStoreService } from "./ports/IWatchStore.ts";
import { WorkflowInvoker, type WorkflowInvokerService } from "./ports/IWorkflowInvoker.ts";
import { WorkflowStore, type WorkflowStoreService } from "./ports/IWorkflowStore.ts";
import { registerWatchForFire, scanWatchesEffect, tallyCost } from "./watch-scan.ts";

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
};

function memoryWatchStore(config?: WatchConfig): MemoryWatchStore {
  const rows = new Map<string, WatchRow>();
  const ledgers = new Map<string, WatchLedger>();
  const heartbeats: WatchHeartbeat[] = [];
  const runRecords = new Map<string, number | null>();
  const runStopReasons = new Map<string, string>();
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
        ledgers.set(date, {
          runsFired: current.runsFired + (delta.runsFired ?? 0),
          runsFinalized: current.runsFinalized + (delta.runsFinalized ?? 0),
          engineFires: current.engineFires + (delta.engineFires ?? 0),
          costUsd: current.costUsd + (delta.costUsd ?? 0),
        });
      }),
    listRunKeys: () => Effect.succeed([...runRecords.keys()]),
    getRunCost: (key) => Effect.succeed(runRecords.get(key) ?? null),
    getRunStopReason: (key) => Effect.succeed(runStopReasons.get(key) ?? null),
  };
  return { service, rows, ledgers, heartbeats, runRecords, runStopReasons };
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

function capturingPublisher(): { service: DaprPublisherService; events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    service: {
      publish: (_pubsub, _topic, data) => Effect.sync(() => void events.push(data)),
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

function env(
  ws: WatchStoreService,
  invoker: WorkflowInvokerService,
  wfStore: WorkflowStoreService = stubWorkflowStore(),
  publisher: DaprPublisherService = capturingPublisher().service,
  cron: CronStoreService = memorySchedStore().service,
  execPolicy: ExecPolicyStoreService = memoryExecPolicyStore().service,
) {
  return Layer.mergeAll(
    Layer.succeed(WatchStore, ws),
    Layer.succeed(WorkflowInvoker, invoker),
    Layer.succeed(WorkflowStore, wfStore),
    Layer.succeed(DaprPublisherTag, publisher),
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

  it("auto-denies the limited executor on a usage-limited finalize (docs/plans/impl/usage-limit-auto-deny.md)", async () => {
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

  const usageLimitedFallbackRow = (
    overrides: Partial<import("./models/watch.model.ts").WatchPolicy> = {},
  ) =>
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
    expect(sched.workspaceId).toBe("ws-1"); // reuse the limited run's workspace
    // The identity override wins over the resubmit params → a different agent re-enters the steps.
    expect(sched.source).toMatchObject({
      mode: "embedded",
      params: { repo: "o/r", runActivity: "run-openhands", agentId: "openhands-agent" },
    });
    expect(sched.handoffsRemaining).toBe(1);
    // The continuation is itself supervised with the decremented budget (can't ping-pong forever).
    expect(sched.watch?.fallback?.maxHandoffs).toBe(1);
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

describe("tallyCost", () => {
  it("prefix-matches runIds under the instance and sums numeric costs only", async () => {
    const mem = memoryWatchStore();
    mem.runRecords.set("run:wf-1:claude-agent:1", 1.2);
    mem.runRecords.set("run:wf-1:setup:2", null); // activity record, no cost — not a gap
    mem.runRecords.set("run:wf-10:claude-agent:3", 50); // wf-10 is NOT wf-1 (issue #10's trap)
    const result = await Effect.runPromise(
      tallyCost("wf-1").pipe(Effect.provide(Layer.succeed(WatchStore, mem.service))),
    );
    expect(result).toEqual({ costUsd: 1.2, costGap: false });
  });
});
