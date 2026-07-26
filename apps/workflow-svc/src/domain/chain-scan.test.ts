import { DaprPublisherTag, type DaprPublisherService } from "core-dapr";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { registerChainForFire, scanChainsEffect } from "./chain-scan.ts";
import type { ChainConfig, ChainHeartbeat, ChainLedger, ChainRow } from "./models/chain.model.ts";
import { emptyChainLedger } from "./models/chain.model.ts";
import type { WfIdentity, WfRow } from "./models/wf.model.ts";
import { wfKey } from "./models/wf.model.ts";
import type { StoredWorkflow, WorkflowRequest, WorkflowStatus } from "./models/workflow.model.ts";
import { ChainStore, type ChainStoreService } from "./ports/IChainStore.ts";
import { WfStore, type WfStoreService } from "./ports/IWfStore.ts";
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

// Records the topic too — the D6 teardown asserts on cron-disarm publishes distinctly from the
// workflow-events finalize publish.
function recordingPublisher(): {
  service: DaprPublisherService;
  events: { topic: string; data: unknown }[];
} {
  const events: { topic: string; data: unknown }[] = [];
  return {
    events,
    service: { publish: (_p, topic, data) => Effect.sync(() => void events.push({ topic, data })) },
  };
}

// The wf: registry the chain reads for a cron member's completion predicate (wf:<...>.resolved) and
// its resolved-run output. Seeded per test by wfKey.
function memoryWfStore(rows: Record<string, WfRow> = {}): WfStoreService {
  const map = new Map<string, WfRow>(Object.entries(rows));
  return {
    getRow: (id: WfIdentity) => Effect.succeed(Option.fromNullable(map.get(wfKey(id)))),
    saveRow: (row) => Effect.sync(() => void map.set(wfKey(row), row)),
  };
}

function env(
  cs: ChainStoreService,
  invoker: WorkflowInvokerService,
  wfStore: WorkflowStoreService = stubWorkflowStore(),
  publisher: DaprPublisherService = capturingPublisher().service,
  wfRegistry: WfStoreService = memoryWfStore(),
) {
  return Layer.mergeAll(
    Layer.succeed(ChainStore, cs),
    Layer.succeed(WorkflowInvoker, invoker),
    Layer.succeed(WorkflowStore, wfStore),
    Layer.succeed(WfStore, wfRegistry),
    Layer.succeed(DaprPublisherTag, publisher),
  );
}

// The default implement-pr → review-pr → revise-pr chain, with explicit shared instanceIds
// (feature + revise-pr share the branch instance; review-pr has its own).
const DEFAULT_WORKFLOWS = [
  { kind: "implement-pr", key: "implement-pr", instanceId: "feature-x" },
  { kind: "review-pr", key: "review-pr", instanceId: "review-pr-x" },
  { kind: "revise-pr", key: "revise-pr", instanceId: "feature-x", fresh: true },
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
        { slug: "x", members: [...DEFAULT_WORKFLOWS], data: { slug: "x", spec: "do it" } },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(env(mem.service, inv.service))),
    );
    const row = mem.rows.get("x");
    expect(row?.epoch).toBe(1);
    expect(row?.cursor).toBe(0);
    expect(row?.currentInstanceId).toBe("feature-x");
    // workflow 0 fired: implement-pr resolved, under feature-x, with the spec threaded in.
    expect(inv.invokes).toHaveLength(1);
    expect(inv.invokes[0].instanceId).toBe("feature-x");
    // Every member shares a workspaceId = chainId, so all resolve ONE worktree (implement-pr creates
    // it, revise-pr reuses it). Without this, members cut the same branch at per-instanceId paths and
    // collide ("'feature/<slug>' is already used by worktree at …").
    expect(inv.invokes[0].workspaceId).toBe("x");
    expect(inv.invokes[0].steps).toEqual([{ activity: "run-implement-pr" }]);
    expect(inv.invokes[0].params).toMatchObject({ slug: "x", spec: "do it" });
    expect(mem.ledgers.get(new Date().toISOString().slice(0, 10))).toMatchObject({
      chainsRegistered: 1,
      workflowsFired: 1,
    });
  });

  it("stamps the wf-registry identity on the fired workflow when the chain data carries a repo", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    await Effect.runPromise(
      registerChainForFire(
        {
          slug: "x",
          members: [...DEFAULT_WORKFLOWS],
          data: { slug: "x", spec: "do it", repo: "o/r" },
        },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(env(mem.service, inv.service))),
    );
    // wf leaf = the fired member's kind; slug = the chain slug; repo = the chain data target.
    expect(inv.invokes[0].wf).toEqual({ repo: "o/r", slug: "x", workflow: "implement-pr" });
    // the threaded repo also rides the member's params (feature reads none, review-pr's target).
    expect(inv.invokes[0].params).toMatchObject({ repo: "o/r" });
  });

  it("omits the wf identity when the chain data carries no repo (opt-in)", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    await Effect.runPromise(
      registerChainForFire(
        { slug: "x", members: [...DEFAULT_WORKFLOWS], data: { slug: "x", spec: "do it" } },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(env(mem.service, inv.service))),
    );
    expect(inv.invokes[0].wf).toBeUndefined();
  });

  it("carries the member's identity params alongside the contract's threading params (disjoint)", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    const members = [
      {
        kind: "implement-pr",
        key: "implement-pr",
        instanceId: "feature-x",
        // Fire-time identity from the CLI (chain-composition-surface §1.9): rides the member row.
        // Identity keys are DISJOINT from the contract's threading keys; threaded values win on
        // any overlap (rendered defaults must never clobber chain data — trxy trial finding).
        params: { runActivity: "run-openhands", agentId: "openhands-agent" },
      },
    ] as const;
    await Effect.runPromise(
      registerChainForFire(
        { slug: "x", members, data: { slug: "x", spec: "do it" } },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(env(mem.service, inv.service))),
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
        { slug: "x", members: [...DEFAULT_WORKFLOWS], data: { slug: "x", spec: "do it" } },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(env(mem.service, inv.service, wfStore))),
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
        // prNumber pre-seeded so a fast-forward to the revise-pr cursor has the PR ref revise-pr threads.
        members: [...DEFAULT_WORKFLOWS],
        data: { slug: "x", spec: "do it", prNumber: "42" },
      },
      undefined,
    ).pipe(Effect.provide(env(mem.service, inv.service))),
  );
  const row = mem.rows.get("x")!;
  const inst = ["feature-x", "review-pr-x", "feature-x"][cursor];
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
  it("captures the structured pr and fires review-pr with it", async () => {
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
    expect(report.advanced).toEqual(["x:w1:review-pr"]);
    const row = mem.rows.get("x");
    expect(row?.cursor).toBe(1);
    expect(row?.data.prNumber).toBe("42");
    expect(inv.invokes).toHaveLength(1);
    expect(inv.invokes[0].instanceId).toBe("review-pr-x");
    expect(inv.invokes[0].params).toMatchObject({ pr: "42" });
  });

  it("advances to revise-pr, threading only the PR ref + slug (revise-pr reads the review itself)", async () => {
    const { mem, inv } = await seedAt(1, {
      "review-pr-x": {
        instanceId: "review-pr-x",
        runtimeStatus: "COMPLETED",
        output: review("file.ts:12 — missing guard"),
      },
    });
    await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    const row = mem.rows.get("x");
    expect(row?.cursor).toBe(2);
    // revise-pr fires on the shared branch instance, fresh, with only the durable references —
    // NOT the review text (revise-pr reads the PR's unresolved threads from GitHub itself).
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
    const members = [
      { kind: "implement-pr", key: "implement-pr", stage: 0, id: "a", captures: { val: "n" } },
      { kind: "implement-pr", key: "implement-pr", stage: 0, id: "b", captures: { val: "n" } },
      {
        kind: "implement-pr",
        key: "implement-pr",
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
        { slug: "x", members: [...members], data: { slug: "x", spec: "do it" } },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(env(mem.service, inv.service))),
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

describe("scanChainsEffect: cron member (D2/D4 — chain observes, never re-fires)", () => {
  // An inline cron member (gather-metrics) recurs on its own clock until its goal resolves; the chain
  // fires it ONCE (arming its cron via §10) then observes wf:<member>.resolved. A downstream plain
  // member reads the cron member's captured metrics via the dotted input.
  const cronMember = {
    kind: "implement-pr",
    stage: 0,
    id: "gather",
    steps: [{ activity: "run-claude" }],
    cron: { cadence: "*/30 * * * *", maxFires: 20 },
    captures: { metrics: "latest" },
  } as const;
  const reportMember = {
    kind: "implement-pr",
    key: "implement-pr",
    stage: 1,
    id: "report",
    inputs: { slug: "slug", spec: "gather.metrics" },
  } as const;
  const data = { slug: "x", repo: "o/r", spec: "seed" };
  const WF_KEY = "wf:o/r:x:implement-pr";
  const resolvedWfRow = {
    repo: "o/r",
    slug: "x",
    workflow: "implement-pr",
    status: "done" as const,
    resolved: true,
    instanceId: "x-w0",
    output: JSON.stringify({ s: { structured: { latest: "42ms" } } }),
    updatedAt: new Date().toISOString(),
  };

  async function register(wfRows: Record<string, WfRow> = {}) {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    const wfReg = memoryWfStore(wfRows);
    await Effect.runPromise(
      registerChainForFire(
        { slug: "x", members: [cronMember, reportMember], data },
        undefined,
      ).pipe(
        Effect.tap(() => scanChainsEffect(undefined)),
        Effect.provide(
          env(mem.service, inv.service, stubWorkflowStore(), capturingPublisher().service, wfReg),
        ),
      ),
    );
    return { mem, inv, wfReg };
  }

  it("fires the cron member ONCE with armCron + wf identity + embedded steps (self-arm via §10)", async () => {
    const { inv } = await register();
    expect(inv.invokes).toHaveLength(1);
    const fire = inv.invokes[0];
    // Inline: the embedded steps fire verbatim (NOT resolved from the saved store).
    expect(fire.steps).toEqual([{ activity: "run-claude" }]);
    // The member arms its OWN recurrence — the chain never writes cron:sub.
    expect(fire.armCron).toEqual({
      cadence: "*/30 * * * *",
      workflow: "implement-pr",
      inline: true,
      budget: { maxFires: 20 },
    });
    // wf identity is REQUIRED for a cron member (the cron goal + the chain predicate both read it).
    expect(fire.wf).toEqual({ repo: "o/r", slug: "x", workflow: "implement-pr" });
    expect(fire.instanceId).toBe("x-w0");
  });

  it("WAITS while wf:<member> is unresolved — the chain re-fires nothing (the cron engine owns re-fire)", async () => {
    const { mem, inv, wfReg } = await register();
    inv.invokes.length = 0;
    await Effect.runPromise(
      scanChainsEffect(undefined).pipe(
        Effect.provide(
          env(mem.service, inv.service, stubWorkflowStore(), capturingPublisher().service, wfReg),
        ),
      ),
    );
    expect(mem.rows.get("x")?.cursor).toBe(0); // still on stage 0
    expect(inv.invokes).toHaveLength(0); // chain fires nothing — the cron engine re-fires, not the chain
  });

  it("advances once wf:resolved, capturing off the RESOLVED run's wf.output (namespaced)", async () => {
    const { mem, inv, wfReg } = await register({ [WF_KEY]: resolvedWfRow });
    inv.invokes.length = 0;
    await Effect.runPromise(
      scanChainsEffect(undefined).pipe(
        Effect.provide(
          env(mem.service, inv.service, stubWorkflowStore(), capturingPublisher().service, wfReg),
        ),
      ),
    );
    const row = mem.rows.get("x");
    expect(row?.cursor).toBe(1);
    // The cron member's capture threaded off wf.output (the resolved run), namespaced under its id.
    expect(row?.data.gather).toEqual({ metrics: "42ms" });
    // Stage 1 fired, its spec resolved from the dotted gather.metrics.
    expect(inv.invokes).toHaveLength(1);
    expect(inv.invokes[0].instanceId).toBe("x-w1");
    expect(inv.invokes[0].params).toMatchObject({ slug: "x", spec: "42ms", repo: "o/r" });
  });

  it("finalizes the chain failed when a cron member has no repo (can't observe wf:resolved)", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    await Effect.runPromise(
      registerChainForFire(
        { slug: "x", members: [cronMember], data: { slug: "x", spec: "seed" } }, // no repo
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(env(mem.service, inv.service))),
    );
    const row = mem.rows.get("x");
    expect(row?.status).toBe("finalized");
    expect(row?.outcome).toBe("failed");
    expect(row?.note).toMatch(/dispatch failed/);
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
      members: [...DEFAULT_WORKFLOWS],
      strategy: "loop-until-clean",
      loop: { startCursor: 1, maxIterations: 3, iterations: 0 },
      cursor: 1,
      currentInstanceId: "review-pr-x",
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

  it("finalizes completed when the review comes back CLEAN — no revise-pr", async () => {
    const { mem } = loopStore({ cursor: 1, currentInstanceId: "review-pr-x" });
    const inv = recordingInvoker({
      "review-pr-x": {
        instanceId: "review-pr-x",
        runtimeStatus: "COMPLETED",
        output: review("CLEAN"),
      },
    });
    const report = await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    expect(report.finalized).toEqual(["x:completed"]);
    expect(inv.invokes).toHaveLength(0); // did NOT advance to revise-pr
  });

  it("advances to revise-pr when the review still has findings", async () => {
    const { mem } = loopStore({ cursor: 1, currentInstanceId: "review-pr-x" });
    const inv = recordingInvoker({
      "review-pr-x": {
        instanceId: "review-pr-x",
        runtimeStatus: "COMPLETED",
        output: review("src/x.ts:9 — missing guard"),
      },
    });
    await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    expect(mem.rows.get("x")?.cursor).toBe(2);
    expect(inv.invokes[0].instanceId).toBe("feature-x"); // revise-pr fired
  });

  it("loops back to re-review after revise-pr, fresh, bumping the iteration", async () => {
    const { mem } = loopStore({ cursor: 2, currentInstanceId: "feature-x" });
    const inv = recordingInvoker({
      "feature-x": { instanceId: "feature-x", runtimeStatus: "COMPLETED", output: pr("pull/42") },
    });
    await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    const row = mem.rows.get("x");
    expect(row?.cursor).toBe(1); // back to review-pr
    expect(row?.loop?.iterations).toBe(1);
    expect(inv.invokes[0].instanceId).toBe("review-pr-x");
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

describe("scanChainsEffect: atomic-failure teardown (D6)", () => {
  it("terminates running siblings and publishes cron-disarm before finalizing failed", async () => {
    const mem = memoryChainStore();
    // stage 0 = { failer(FAILED) ∥ runner(RUNNING) ∥ watcher(inline cron, unresolved) }.
    const members = [
      { kind: "implement-pr", key: "implement-pr", stage: 0, id: "failer" },
      { kind: "implement-pr", key: "implement-pr", stage: 0, id: "runner" },
      {
        kind: "review-pr",
        stage: 0,
        id: "watcher",
        steps: [{ activity: "run-claude" }],
        cron: { cadence: "*/30 * * * *" },
        // Declared inputs replace the kind's buildParams, so the inline member fires off the seeded
        // chain data (a review-pr's coded contract would demand a prNumber the seed lacks).
        inputs: { slug: "slug", spec: "spec" },
      },
    ] as const;
    const inv = recordingInvoker({
      "x-w0": { instanceId: "x-w0", runtimeStatus: "FAILED" },
      "x-w1": { instanceId: "x-w1", runtimeStatus: "RUNNING" },
      // x-w2 is a cron member — read via wf (absent ⇒ unresolved ⇒ RUNNING), never getStatus.
    });
    const pub = recordingPublisher();
    const provide = env(mem.service, inv.service, stubWorkflowStore(), pub.service);
    await Effect.runPromise(
      registerChainForFire(
        { slug: "x", members: [...members], data: { slug: "x", repo: "o/r", spec: "seed" } },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(provide)),
    );
    pub.events.length = 0;
    const report = await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(provide)),
    );

    // The chain fails as a unit.
    expect(report.finalized).toEqual(["x:failed"]);
    expect(mem.rows.get("x")?.outcome).toBe("failed");
    // The running siblings are terminated (the FAILED member is already terminal — skipped).
    expect(report.terminated.sort()).toEqual(["x-w1", "x-w2"]);
    // The cron member's cron is disarmed via pub/sub — the chain NEVER writes cron:sub itself.
    const disarms = pub.events.filter((e) => e.topic === "cron-disarm");
    expect(disarms).toHaveLength(1);
    expect(disarms[0].data).toEqual({ repo: "o/r", slug: "x", workflow: "review-pr" });
  });

  it("does NOT terminate or disarm on a clean completed finalize (nothing to reap)", async () => {
    const { mem } = await seedAt(2, {
      "feature-x": { instanceId: "feature-x", runtimeStatus: "COMPLETED", output: pr("no-url") },
    });
    const pub = recordingPublisher();
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
            stubWorkflowStore(),
            pub.service,
          ),
        ),
      ),
    );
    expect(report.finalized).toEqual(["x:completed"]);
    expect(report.terminated).toEqual([]);
    expect(pub.events.filter((e) => e.topic === "cron-disarm")).toHaveLength(0);
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
      members: [{ kind: "implement-pr" as const, key: "implement-pr" }],
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
      members: [...DEFAULT_WORKFLOWS],
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

// ---------------------------------------------------------------------------
// Terminal captures + activation gates (issues #77 / #78 / #79a)
// ---------------------------------------------------------------------------

describe("scanChainsEffect: terminal captures + activation gates (#77/#78)", () => {
  const structured = (obj: Record<string, unknown>) => JSON.stringify({ s: { structured: obj } });

  it("captures the LAST stage's outputs onto the finalized row (#77)", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker({
      "x-w0": { instanceId: "x-w0", runtimeStatus: "COMPLETED", output: structured({ pr: 7 }) },
    });
    await Effect.runPromise(
      registerChainForFire(
        {
          slug: "x",
          members: [{ kind: "implement-pr", key: "implement-pr", captures: { prNumber: "pr" } }],
          data: { slug: "x", spec: "do it" },
        },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(env(mem.service, inv.service))),
    );
    await Effect.runPromise(
      scanChainsEffect(undefined).pipe(Effect.provide(env(mem.service, inv.service))),
    );
    const row = mem.rows.get("x");
    expect(row?.status).toBe("finalized");
    expect(row?.outcome).toBe("completed");
    // The terminal stage's capture landed — the finalized row is the chain's result surface.
    expect(row?.data.prNumber).toBe(7);
  });

  it("an --after child holds while the parent runs, then fires seeded from its finalized data (#78)", async () => {
    const mem = memoryChainStore();
    // The parent RUNS at first; the test completes it later by mutating the status map.
    const statuses: Record<string, WorkflowStatus> = {
      "p-w0": { instanceId: "p-w0", runtimeStatus: "RUNNING" },
    };
    const inv = recordingInvoker(statuses);
    const layer = env(mem.service, inv.service);
    await Effect.runPromise(
      registerChainForFire(
        {
          slug: "p",
          members: [{ kind: "implement-pr", key: "implement-pr", captures: { handoff: "pr" } }],
          data: { slug: "p", spec: "parent work" },
        },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(layer)),
    );
    await Effect.runPromise(
      registerChainForFire(
        {
          slug: "c",
          members: [
            { kind: "implement-pr", key: "implement-pr", inputs: { slug: "slug", spec: "handoff" } },
          ],
          data: { slug: "c" },
          after: "p",
        },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(layer)),
    );
    // Parent fired; child HELD (its member never invoked while the parent is unfinalized).
    expect(inv.invokes.map((i) => i.instanceId)).toEqual(["p-w0"]);
    // The parent's member completes; the next scan finalizes it (terminal capture #77 lands
    // handoff), then the following scan activates the child seeded from the finalized data.
    statuses["p-w0"] = {
      instanceId: "p-w0",
      runtimeStatus: "COMPLETED",
      output: structured({ pr: "PR-9" }),
    };
    await Effect.runPromise(scanChainsEffect(undefined).pipe(Effect.provide(layer)));
    expect(mem.rows.get("p")?.outcome).toBe("completed");
    await Effect.runPromise(scanChainsEffect(undefined).pipe(Effect.provide(layer)));
    const fired = inv.invokes.map((i) => i.instanceId);
    expect(fired).toContain("c-w0");
    const child = inv.invokes.find((i) => i.instanceId === "c-w0");
    expect(child?.params).toMatchObject({ slug: "c", spec: "PR-9" });
    expect(mem.rows.get("c")?.status).toBe("running");
  });

  it("an --after child finalizes terminated when the parent fails (#78)", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker({
      "p-w0": { instanceId: "p-w0", runtimeStatus: "FAILED" },
    });
    const layer = env(mem.service, inv.service);
    await Effect.runPromise(
      registerChainForFire(
        {
          slug: "p",
          members: [{ kind: "implement-pr", key: "implement-pr" }],
          data: { slug: "p", spec: "parent work" },
        },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(layer)),
    );
    await Effect.runPromise(
      registerChainForFire(
        {
          slug: "c",
          members: [{ kind: "implement-pr", key: "implement-pr" }],
          data: { slug: "c", spec: "child work" },
          after: "p",
        },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(layer)),
    );
    await Effect.runPromise(scanChainsEffect(undefined).pipe(Effect.provide(layer))); // parent fails
    await Effect.runPromise(scanChainsEffect(undefined).pipe(Effect.provide(layer))); // child aborts
    const child = mem.rows.get("c");
    expect(child?.status).toBe("finalized");
    expect(child?.outcome).toBe("terminated");
    expect(child?.note).toContain("finalized failed");
    // The child's member never fired.
    expect(inv.invokes.map((i) => i.instanceId)).toEqual(["p-w0"]);
  });

  it("notBefore holds activation until the time passes (#78)", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    const layer = env(mem.service, inv.service);
    await Effect.runPromise(
      registerChainForFire(
        {
          slug: "x",
          members: [{ kind: "implement-pr", key: "implement-pr" }],
          data: { slug: "x", spec: "do it" },
          notBefore: new Date(Date.now() + 3_600_000).toISOString(),
        },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(layer)),
    );
    expect(inv.invokes).toHaveLength(0);
    expect(mem.rows.get("x")?.status).toBe("scheduling");
    // Time passes: rewrite the gate into the past — the next scan fires stage 0.
    const row = mem.rows.get("x");
    if (row) mem.rows.set("x", { ...row, notBefore: new Date(Date.now() - 1000).toISOString() });
    await Effect.runPromise(scanChainsEffect(undefined).pipe(Effect.provide(layer)));
    expect(inv.invokes.map((i) => i.instanceId)).toEqual(["x-w0"]);
    expect(mem.rows.get("x")?.status).toBe("running");
  });
});

describe("threaded params beat rendered defaults (trxy trial finding, 2026-07-25)", () => {
  it("a member's rendered default (clonePath: '') never clobbers the threaded chain data", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    await Effect.runPromise(
      registerChainForFire(
        {
          slug: "x",
          members: [
            {
              kind: "implement-pr",
              key: "implement-pr",
              // The template's rendered params block: identity + an EMPTY clonePath default.
              params: { runActivity: "run-codex", clonePath: "" },
            },
          ],
          data: { slug: "x", spec: "do it", clonePath: "/workspace/other-repo" },
        },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(env(mem.service, inv.service))),
    );
    expect(inv.invokes[0].params).toMatchObject({
      clonePath: "/workspace/other-repo", // threaded wins
      runActivity: "run-codex", // identity survives (disjoint from the contract)
    });
  });
});

describe("activation re-stamps startedAt (batch finding: gate-hold must not spend the budget)", () => {
  it("a chain held past its whole budget by notBefore fires with a fresh clock", async () => {
    const mem = memoryChainStore();
    const inv = recordingInvoker();
    const layer = env(mem.service, inv.service);
    await Effect.runPromise(
      registerChainForFire(
        {
          slug: "x",
          members: [{ kind: "implement-pr", key: "implement-pr" }],
          data: { slug: "x", spec: "do it" },
          budgetMs: 45 * 60_000,
          notBefore: new Date(Date.now() + 3_600_000).toISOString(),
        },
        undefined,
      ).pipe(Effect.tap(() => scanChainsEffect(undefined)), Effect.provide(layer)),
    );
    // Simulate the hold having lasted longer than the whole budget: backdate registration and
    // open the gate.
    const held = mem.rows.get("x");
    if (held)
      mem.rows.set("x", {
        ...held,
        startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        notBefore: new Date(Date.now() - 1000).toISOString(),
      });
    await Effect.runPromise(scanChainsEffect(undefined).pipe(Effect.provide(layer)));
    const fired = mem.rows.get("x");
    expect(inv.invokes.map((i) => i.instanceId)).toEqual(["x-w0"]);
    expect(fired?.status).toBe("running");
    // startedAt moved to activation time — the next live tick must NOT budget-terminate.
    expect(Date.now() - Date.parse(fired?.startedAt ?? "")).toBeLessThan(60_000);
    await Effect.runPromise(scanChainsEffect(undefined).pipe(Effect.provide(layer)));
    expect(mem.rows.get("x")?.status).toBe("running");
  });
});
