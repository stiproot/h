import { DaprPublisherTag, type DaprPublisherService } from "core-dapr";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { registerChainForFire, scanChainsEffect } from "./chain-scan.ts";
import type { ChainConfig, ChainHeartbeat, ChainLedger, ChainRow } from "./models/chain.model.ts";
import { emptyChainLedger } from "./models/chain.model.ts";
import type { StoredWorkflow, WorkflowRequest, WorkflowStatus } from "./models/workflow.model.ts";
import { ChainStore, type ChainStoreService } from "./ports/IChainStore.ts";
import { WorkflowInvoker, type WorkflowInvokerService } from "./ports/IWorkflowInvoker.ts";
import { WorkflowStore, type WorkflowStoreService } from "./ports/IWorkflowStore.ts";

// ---------------------------------------------------------------------------
// In-memory fixtures (mirrors watch-scan.test.ts)
// ---------------------------------------------------------------------------

type MemoryChainStore = {
  service: ChainStoreService;
  rows: Map<string, ChainRow>;
  ledgers: Map<string, ChainLedger>;
  heartbeats: ChainHeartbeat[];
  runRecords: Map<string, number | null>;
};

function memoryChainStore(config?: ChainConfig): MemoryChainStore {
  const rows = new Map<string, ChainRow>();
  const ledgers = new Map<string, ChainLedger>();
  const heartbeats: ChainHeartbeat[] = [];
  const runRecords = new Map<string, number | null>();
  const service: ChainStoreService = {
    getRow: (id) => Effect.succeed(Option.fromNullable(rows.get(id))),
    listRows: () => Effect.succeed([...rows.values()]),
    saveRow: (row) => Effect.sync(() => void rows.set(row.chainId, row)),
    deleteRow: (id) => Effect.sync(() => void rows.delete(id)),
    getConfig: () => Effect.succeed(Option.fromNullable(config)),
    getHeartbeat: () => Effect.succeed(Option.fromNullable(heartbeats.at(-1))),
    heartbeat: (beat) => Effect.sync(() => void heartbeats.push(beat)),
    getLedger: (date) => Effect.succeed(ledgers.get(date) ?? emptyChainLedger),
    bumpLedger: (date, delta) =>
      Effect.sync(() => {
        const current = ledgers.get(date) ?? emptyChainLedger;
        ledgers.set(date, {
          chainsRegistered: current.chainsRegistered + (delta.chainsRegistered ?? 0),
          hopsFired: current.hopsFired + (delta.hopsFired ?? 0),
          chainsFinalized: current.chainsFinalized + (delta.chainsFinalized ?? 0),
          costUsd: current.costUsd + (delta.costUsd ?? 0),
        });
      }),
    listRunKeys: () => Effect.succeed([...runRecords.keys()]),
    getRunCost: (key) => Effect.succeed(runRecords.get(key) ?? null),
  };
  return { service, rows, ledgers, heartbeats, runRecords };
}

// Records every invoke so tests can assert on the fired hop (key/params/instanceId), and drives
// getStatus per instanceId (default RUNNING).
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
        Effect.succeed(statuses[instanceId] ?? { instanceId, runtimeStatus: "RUNNING" }),
      terminate: () => Effect.void,
    },
  };
}

// A saved workflow whose stored key rides on its (single) step's activity, so tests can see which
// template each hop resolved to. toRequest merges the hop's built params over these (empty) defaults.
const stubWorkflowStore = (
  overrides: Partial<WorkflowStoreService> = {},
): WorkflowStoreService => ({
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

function capturingPublisher(): { service: DaprPublisherService; events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    service: { publish: (_p, _t, data) => Effect.sync(() => void events.push(data)) },
  };
}

function env(
  cs: ChainStoreService,
  invoker: WorkflowInvokerService,
  wfStore: WorkflowStoreService = stubWorkflowStore(),
  publisher: DaprPublisherService = capturingPublisher().service,
) {
  return Layer.mergeAll(
    Layer.succeed(ChainStore, cs),
    Layer.succeed(WorkflowInvoker, invoker),
    Layer.succeed(WorkflowStore, wfStore),
    Layer.succeed(DaprPublisherTag, publisher),
  );
}

// The default feature-pr → pr-review → revise chain, with explicit shared instanceIds
// (feature + revise share the branch instance; pr-review has its own).
const DEFAULT_HOPS = [
  { kind: "feature-pr", key: "feature-pr", instanceId: "feature-x" },
  { kind: "pr-review", key: "pr-review", instanceId: "pr-review-x" },
  { kind: "revise", key: "feature-pr", instanceId: "feature-x", fresh: true },
] as const;

function pr(url: string): string {
  return JSON.stringify({ implement: { output: `done\n===PR===\n${url}` } });
}
function review(findings: string): string {
  return JSON.stringify({ review: { output: `===REVIEW===\n${findings}` } });
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

describe("registerChainForFire", () => {
  it("writes a scheduling row (epoch 1, cursor 0) and fires hop 0 under its instanceId", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    await Effect.runPromise(
      registerChainForFire(
        { slug: "x", hops: [...DEFAULT_HOPS], data: { slug: "x", spec: "do it" } },
        undefined,
      ).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    const row = mem.rows.get("x");
    expect(row?.epoch).toBe(1);
    expect(row?.cursor).toBe(0);
    expect(row?.currentInstanceId).toBe("feature-x");
    // hop 0 fired: feature-pr resolved, under feature-x, with the spec threaded in.
    expect(inv.invokes).toHaveLength(1);
    expect(inv.invokes[0].instanceId).toBe("feature-x");
    expect(inv.invokes[0].steps).toEqual([{ activity: "run-feature-pr" }]);
    expect(inv.invokes[0].params).toMatchObject({ slug: "x", spec: "do it" });
    expect(mem.ledgers.get(new Date().toISOString().slice(0, 10))).toMatchObject({
      chainsRegistered: 1,
      hopsFired: 1,
    });
  });

  it("finalizes the chain failed when hop 0 cannot be resolved", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    const wfStore = stubWorkflowStore({ get: () => Effect.succeed(Option.none()) });
    await Effect.runPromise(
      registerChainForFire(
        { slug: "x", hops: [...DEFAULT_HOPS], data: { slug: "x", spec: "do it" } },
        undefined,
      ).pipe(Effect.provide(env(mem.service, inv.service, wfStore))),
    );
    const row = mem.rows.get("x");
    expect(row?.status).toBe("finalized");
    expect(row?.outcome).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// the scan — advance, thread, finalize
// ---------------------------------------------------------------------------

async function seedAt(cursor: number, statuses: Record<string, WorkflowStatus>) {
  const mem = memoryChainStore();
  const inv = recordingInvoker(statuses);
  // Register (fires hop 0), then fast-forward the row's cursor for the test.
  await Effect.runPromise(
    registerChainForFire(
      { slug: "x", hops: [...DEFAULT_HOPS], data: { slug: "x", spec: "do it" } },
      undefined,
    ).pipe(Effect.provide(env(mem.service, inv.service))),
  );
  const row = mem.rows.get("x")!;
  const inst = ["feature-x", "pr-review-x", "feature-x"][cursor];
  mem.rows.set("x", {
    ...row,
    cursor,
    currentInstanceId: inst,
    status: "running",
    lastStatus: "RUNNING",
  });
  inv.invokes.length = 0; // drop the registration fire; assert only on scan-driven fires
  return { mem, inv };
}

describe("scanChainsEffect: advance threads state to the next hop", () => {
  it("captures ===PR=== and fires pr-review with the parsed pr number", async () => {
    const { mem, inv } = await seedAt(0, {
      "feature-x": {
        instanceId: "feature-x",
        runtimeStatus: "COMPLETED",
        output: pr("https://github.com/o/r/pull/42"),
      },
    });
    const report = await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    expect(report.advanced).toEqual(["x:h1:pr-review"]);
    const row = mem.rows.get("x");
    expect(row?.cursor).toBe(1);
    expect(row?.data.prNumber).toBe("42");
    expect(inv.invokes).toHaveLength(1);
    expect(inv.invokes[0].instanceId).toBe("pr-review-x");
    expect(inv.invokes[0].params).toMatchObject({ pr: "42" });
  });

  it("captures ===REVIEW=== and folds the findings into the revise spec", async () => {
    const { mem, inv } = await seedAt(1, {
      "pr-review-x": {
        instanceId: "pr-review-x",
        runtimeStatus: "COMPLETED",
        output: review("file.ts:12 — missing guard"),
      },
    });
    await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    const row = mem.rows.get("x");
    expect(row?.cursor).toBe(2);
    expect(row?.data.reviewFindings).toContain("missing guard");
    // revise fires feature-pr fresh, spec carrying the findings.
    expect(inv.invokes[0].instanceId).toBe("feature-x");
    expect(inv.invokes[0].fresh).toBe(true);
    expect(String(inv.invokes[0].params?.spec)).toContain("missing guard");
  });
});

describe("scanChainsEffect: finalize", () => {
  it("finalizes completed when the LAST hop completes", async () => {
    const { mem } = await seedAt(2, {
      "feature-x": { instanceId: "feature-x", runtimeStatus: "COMPLETED", output: pr("no-url") },
    });
    const report = await Effect.runPromise(
      scanChainsEffect(undefined).pipe(
        Effect.provide(
          env(
            mem.service,
            recordingInvoker({
              "feature-x": {
                instanceId: "feature-x",
                runtimeStatus: "COMPLETED",
                output: pr("no-url"),
              },
            }).service,
          ),
        ),
      ),
    );
    expect(report.finalized).toEqual(["x:completed"]);
    expect(mem.rows.get("x")?.status).toBe("finalized");
  });

  it("finalizes failed when a hop fails — no advance past a failure", async () => {
    const { mem, inv } = await seedAt(0, {
      "feature-x": { instanceId: "feature-x", runtimeStatus: "FAILED" },
    });
    const report = await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    expect(report.finalized).toEqual(["x:failed"]);
    expect(inv.invokes).toHaveLength(0); // never fired the next hop
  });
});

describe("scanChainsEffect: isolation and kill switch", () => {
  it("one chain's failure never starves another", async () => {
    const mem = memoryChainStore();
    // Two active chains in one store; the invoker throws only for chain 'boom'.
    const inv: WorkflowInvokerService = {
      invoke: () => Effect.succeed({ instanceId: "i" }),
      getStatus: (instanceId) =>
        instanceId === "feature-boom"
          ? Effect.fail(new Error("kaboom") as never)
          : Effect.succeed({ instanceId, runtimeStatus: "RUNNING" }),
      terminate: () => Effect.void,
    };
    const base = {
      hops: [...DEFAULT_HOPS],
      strategy: "sequential" as const,
      data: {},
      unknownStreak: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastStatus: "RUNNING",
      status: "running" as const,
      cursor: 0,
    };
    mem.rows.set("ok", {
      ...base,
      chainId: "ok",
      slug: "ok",
      epoch: 1,
      currentInstanceId: "feature-ok",
    });
    mem.rows.set("boom", {
      ...base,
      chainId: "boom",
      slug: "boom",
      epoch: 1,
      currentInstanceId: "feature-boom",
    });
    const report = await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv))),
    );
    // Both scanned; neither errored (a failed getStatus reads as UNKNOWN, not a scan error).
    expect(report.scanned).toBe(2);
  });

  it("disarms when chain:config.enabled is false", async () => {
    const mem = memoryChainStore({ enabled: false });
    mem.rows.set("x", {
      chainId: "x",
      epoch: 1,
      slug: "x",
      hops: [...DEFAULT_HOPS],
      strategy: "sequential",
      cursor: 0,
      currentInstanceId: "feature-x",
      data: {},
      status: "running",
      lastStatus: "RUNNING",
      unknownStreak: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const report = await Effect.runPromise(
      scanChainsEffect(undefined).pipe(
        Effect.provide(env(mem.service, recordingInvoker().service)),
      ),
    );
    expect(report.disabled).toBe(true);
    expect(report.scanned).toBe(0);
  });
});
