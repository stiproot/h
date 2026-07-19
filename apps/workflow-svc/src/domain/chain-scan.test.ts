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
          workflowsFired: current.workflowsFired + (delta.workflowsFired ?? 0),
          chainsFinalized: current.chainsFinalized + (delta.chainsFinalized ?? 0),
          costUsd: current.costUsd + (delta.costUsd ?? 0),
        });
      }),
    listRunKeys: () => Effect.succeed([...runRecords.keys()]),
    getRunCost: (key) => Effect.succeed(runRecords.get(key) ?? null),
  };
  return { service, rows, ledgers, heartbeats, runRecords };
}

// Records every invoke so tests can assert on the fired workflow (key/params/instanceId), and drives
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
// template each workflow resolved to. toRequest merges the workflow's built params over these (empty) defaults.
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
const DEFAULT_WORKFLOWS = [
  { kind: "feature-pr", key: "feature-pr", instanceId: "feature-x" },
  { kind: "pr-review", key: "pr-review", instanceId: "pr-review-x" },
  { kind: "revise", key: "revise", instanceId: "feature-x", fresh: true },
] as const;

// Structured envelopes, as the rung-2 seam produces them (structured-workflow-outputs): a
// pull/<n> url carries pr+url; anything else is a skip (no pr → downstream fails loud).
function pr(url: string): string {
  const match = url.match(/pull\/(\d+)/);
  const structured = match ? { pr: Number(match[1]), url } : { skipped: url };
  return JSON.stringify({ implement: { output: "done", structured } });
}
function review(findings: string): string {
  const structured =
    findings === "CLEAN" ? { verdict: "CLEAN" } : { verdict: "FINDINGS", summary: findings };
  return JSON.stringify({ review: { output: "reviewed", structured } });
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

describe("registerChainForFire", () => {
  it("writes a scheduling row (epoch 1, cursor 0) and fires workflow 0 under its instanceId", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    await Effect.runPromise(
      registerChainForFire(
        { slug: "x", workflows: [...DEFAULT_WORKFLOWS], data: { slug: "x", spec: "do it" } },
        undefined,
      ).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    const row = mem.rows.get("x");
    expect(row?.epoch).toBe(1);
    expect(row?.cursor).toBe(0);
    expect(row?.currentInstanceId).toBe("feature-x");
    // workflow 0 fired: feature-pr resolved, under feature-x, with the spec threaded in.
    expect(inv.invokes).toHaveLength(1);
    expect(inv.invokes[0].instanceId).toBe("feature-x");
    // Every member shares a workspaceId = chainId, so all resolve ONE worktree (feature-pr creates
    // it, revise reuses it). Without this, members cut the same branch at per-instanceId paths and
    // collide ("'feature/<slug>' is already used by worktree at …").
    expect(inv.invokes[0].workspaceId).toBe("x");
    expect(inv.invokes[0].steps).toEqual([{ activity: "run-feature-pr" }]);
    expect(inv.invokes[0].params).toMatchObject({ slug: "x", spec: "do it" });
    expect(mem.ledgers.get(new Date().toISOString().slice(0, 10))).toMatchObject({
      chainsRegistered: 1,
      workflowsFired: 1,
    });
  });

  it("stamps the wf-registry identity on the fired workflow when the blackboard carries a repo", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    await Effect.runPromise(
      registerChainForFire(
        {
          slug: "x",
          workflows: [...DEFAULT_WORKFLOWS],
          data: { slug: "x", spec: "do it", repo: "o/r" },
        },
        undefined,
      ).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    // wf leaf = the fired member's kind; slug = the chain slug; repo = the blackboard target.
    expect(inv.invokes[0].wf).toEqual({ repo: "o/r", slug: "x", workflow: "feature-pr" });
    // the threaded repo also rides the member's params (feature reads none, pr-review's target).
    expect(inv.invokes[0].params).toMatchObject({ repo: "o/r" });
  });

  it("omits the wf identity when the blackboard carries no repo (opt-in)", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    await Effect.runPromise(
      registerChainForFire(
        { slug: "x", workflows: [...DEFAULT_WORKFLOWS], data: { slug: "x", spec: "do it" } },
        undefined,
      ).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    expect(inv.invokes[0].wf).toBeUndefined();
  });

  it("merges the workflow's own params OVER the kind contract's threading params", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    const workflows = [
      {
        kind: "feature-pr",
        key: "feature-pr",
        instanceId: "feature-x",
        // Fire-time identity from the CLI (chain-composition-surface §1.9): rides the workflow row,
        // merged over buildParams' threading keys at fire time.
        params: { runActivity: "run-openhands", agentId: "openhands-agent" },
      },
    ] as const;
    await Effect.runPromise(
      registerChainForFire(
        { slug: "x", workflows, data: { slug: "x", spec: "do it" } },
        undefined,
      ).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    expect(inv.invokes[0].params).toMatchObject({
      slug: "x",
      spec: "do it",
      runActivity: "run-openhands",
      agentId: "openhands-agent",
    });
  });

  it("finalizes the chain failed when workflow 0 cannot be resolved", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    const wfStore = stubWorkflowStore({ get: () => Effect.succeed(Option.none()) });
    await Effect.runPromise(
      registerChainForFire(
        { slug: "x", workflows: [...DEFAULT_WORKFLOWS], data: { slug: "x", spec: "do it" } },
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
  // Register (fires workflow 0), then fast-forward the row's cursor for the test.
  await Effect.runPromise(
    registerChainForFire(
      {
        slug: "x",
        // prNumber pre-seeded so a fast-forward to the revise cursor has the PR ref revise threads.
        workflows: [...DEFAULT_WORKFLOWS],
        data: { slug: "x", spec: "do it", prNumber: "42" },
      },
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

describe("scanChainsEffect: advance threads state to the next workflow", () => {
  it("captures the structured pr and fires pr-review with it", async () => {
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
    expect(report.advanced).toEqual(["x:w1:pr-review"]);
    const row = mem.rows.get("x");
    expect(row?.cursor).toBe(1);
    expect(row?.data.prNumber).toBe("42");
    expect(inv.invokes).toHaveLength(1);
    expect(inv.invokes[0].instanceId).toBe("pr-review-x");
    expect(inv.invokes[0].params).toMatchObject({ pr: "42" });
  });

  it("advances to revise, threading only the PR ref + slug (revise reads the review itself)", async () => {
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
    // revise fires on the shared branch instance, fresh, with only the durable references —
    // NOT the review text (revise reads the PR's unresolved threads from GitHub itself).
    expect(inv.invokes[0].instanceId).toBe("feature-x");
    expect(inv.invokes[0].fresh).toBe(true);
    expect(inv.invokes[0].params).toEqual({ pr: "42", slug: "x" });
  });
});

describe("scanChainsEffect: parallel stage namespacing (D5)", () => {
  it("joins two concurrent members, namespaces their captures, feeds a dotted input downstream", async () => {
    const mem = memoryChainStore();
    // {a ∥ b} → c: a and b share stage 0 and both capture `val` (would clobber if flat); c reads a's
    // namespaced capture via the dotted input `a.val`.
    const workflows = [
      { kind: "feature-pr", key: "feature-pr", stage: 0, id: "a", captures: { val: "n" } },
      { kind: "feature-pr", key: "feature-pr", stage: 0, id: "b", captures: { val: "n" } },
      {
        kind: "feature-pr",
        key: "feature-pr",
        stage: 1,
        id: "c",
        inputs: { slug: "slug", spec: "a.val" },
      },
    ] as const;
    const structured = (n: string) => JSON.stringify({ s: { structured: { n } } });
    const inv = recordingInvoker({
      "x-w0": { instanceId: "x-w0", runtimeStatus: "COMPLETED", output: structured("AA") },
      "x-w1": { instanceId: "x-w1", runtimeStatus: "COMPLETED", output: structured("BB") },
    });
    await Effect.runPromise(
      registerChainForFire(
        { slug: "x", workflows: [...workflows], data: { slug: "x", spec: "do it" } },
        undefined,
      ).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    // registration fired both stage-0 members (derived instances x-w0, x-w1).
    expect(inv.invokes.map((i) => i.instanceId).sort()).toEqual(["x-w0", "x-w1"]);
    inv.invokes.length = 0;
    await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    const row = mem.rows.get("x");
    expect(row?.cursor).toBe(1);
    // Namespaced captures — no clobber despite both writing `val`.
    expect(row?.data.a).toEqual({ val: "AA" });
    expect(row?.data.b).toEqual({ val: "BB" });
    // Stage 1 fired once (member c), its spec resolved from the dotted a.val path.
    expect(inv.invokes).toHaveLength(1);
    expect(inv.invokes[0].instanceId).toBe("x-w2");
    expect(inv.invokes[0].params).toMatchObject({ slug: "x", spec: "AA" });
  });
});

describe("scanChainsEffect: loop-until-clean", () => {
  // A loop chain parked on a given cursor/iteration, ready for one scan tick.
  function loopStore(over: Partial<ChainRow>): { mem: MemoryChainStore } {
    const mem = memoryChainStore();
    mem.rows.set("x", {
      chainId: "x",
      epoch: 1,
      slug: "x",
      workflows: [...DEFAULT_WORKFLOWS],
      strategy: "loop-until-clean",
      loop: { startCursor: 1, maxIterations: 3, iterations: 0 },
      cursor: 1,
      currentInstanceId: "pr-review-x",
      data: { slug: "x", spec: "do it", prNumber: "42" },
      status: "running",
      lastStatus: "RUNNING",
      unknownStreak: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...over,
    });
    return { mem };
  }

  it("finalizes completed when the review comes back CLEAN — no revise", async () => {
    const { mem } = loopStore({ cursor: 1, currentInstanceId: "pr-review-x" });
    const inv = recordingInvoker({
      "pr-review-x": {
        instanceId: "pr-review-x",
        runtimeStatus: "COMPLETED",
        output: review("CLEAN"),
      },
    });
    const report = await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    expect(report.finalized).toEqual(["x:completed"]);
    expect(inv.invokes).toHaveLength(0); // did NOT advance to revise
  });

  it("advances to revise when the review still has findings", async () => {
    const { mem } = loopStore({ cursor: 1, currentInstanceId: "pr-review-x" });
    const inv = recordingInvoker({
      "pr-review-x": {
        instanceId: "pr-review-x",
        runtimeStatus: "COMPLETED",
        output: review("src/x.ts:9 — missing guard"),
      },
    });
    await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    expect(mem.rows.get("x")?.cursor).toBe(2);
    expect(inv.invokes[0].instanceId).toBe("feature-x"); // revise fired
  });

  it("loops back to re-review after revise, fresh, bumping the iteration", async () => {
    const { mem } = loopStore({ cursor: 2, currentInstanceId: "feature-x" });
    const inv = recordingInvoker({
      "feature-x": { instanceId: "feature-x", runtimeStatus: "COMPLETED", output: pr("pull/42") },
    });
    await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    const row = mem.rows.get("x");
    expect(row?.cursor).toBe(1); // back to pr-review
    expect(row?.loop?.iterations).toBe(1);
    expect(inv.invokes[0].instanceId).toBe("pr-review-x");
    expect(inv.invokes[0].fresh).toBe(true); // re-review must purge the terminal prior run
  });

  it("stops (finalizes completed) once max iterations is reached", async () => {
    // iterations 2, max 3 → 2+1 == 3, not < 3, so no more loops.
    const { mem } = loopStore({
      cursor: 2,
      currentInstanceId: "feature-x",
      loop: { startCursor: 1, maxIterations: 3, iterations: 2 },
    });
    const inv = recordingInvoker({
      "feature-x": { instanceId: "feature-x", runtimeStatus: "COMPLETED", output: pr("pull/42") },
    });
    const report = await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    expect(report.finalized).toEqual(["x:completed"]);
    expect(mem.rows.get("x")?.note).toContain("stopped after 3 iterations");
    expect(inv.invokes).toHaveLength(0);
  });
});

describe("scanChainsEffect: finalize", () => {
  it("finalizes completed when the LAST workflow completes", async () => {
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

  it("finalizes failed when a workflow fails — no advance past a failure", async () => {
    const { mem, inv } = await seedAt(0, {
      "feature-x": { instanceId: "feature-x", runtimeStatus: "FAILED" },
    });
    const report = await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    expect(report.finalized).toEqual(["x:failed"]);
    expect(inv.invokes).toHaveLength(0); // never fired the next workflow
  });
});

describe("scanChainsEffect: isolation and kill switch", () => {
  it("one chain's failure never starves another", async () => {
    const mem = memoryChainStore();
    // Two active chains in one store; the invoker throws only for chain 'boom' (its stage-0 member
    // derives to `boom-w0` — no explicit instanceId, so per-member reads key off the chain id).
    const inv: WorkflowInvokerService = {
      invoke: () => Effect.succeed({ instanceId: "i" }),
      getStatus: (instanceId) =>
        instanceId === "boom-w0"
          ? Effect.fail(new Error("kaboom") as never)
          : Effect.succeed({ instanceId, runtimeStatus: "RUNNING" }),
      terminate: () => Effect.void,
    };
    const base = {
      // A single stage-0 member with no explicit instanceId, so each chain reads its own `<id>-w0`.
      workflows: [{ kind: "feature-pr" as const, key: "feature-pr" }],
      strategy: "sequential" as const,
      data: {},
      unknownStreak: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastStatus: "RUNNING",
      status: "running" as const,
      cursor: 0,
    };
    mem.rows.set("ok", { ...base, chainId: "ok", slug: "ok", epoch: 1 });
    mem.rows.set("boom", { ...base, chainId: "boom", slug: "boom", epoch: 1 });
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
      workflows: [...DEFAULT_WORKFLOWS],
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
