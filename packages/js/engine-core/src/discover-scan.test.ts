import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { registerDiscover, scanDiscoverEffect } from "./discover-scan.ts";
import { type CronLedger, emptyCronLedger } from "./internal.ts";
import { type DiscoverRow, discoverTrigger } from "./internal.ts";
import type { WatchLedger } from "./internal.ts";
import type { WfRow } from "./internal.ts";
import type { StoredWorkflow, WorkflowRequest, WorkflowStatus } from "./internal.ts";
import { CronStore, type CronStoreService } from "./internal.ts";
import { type SourceItem, SourceReader, type SourceReaderService } from "./internal.ts";
import { WatchStore, type WatchStoreService } from "./internal.ts";
import { WfStore, type WfStoreService } from "./internal.ts";
import { WorkflowInvoker, type WorkflowInvokerService } from "./internal.ts";
import { WorkflowStore, type WorkflowStoreService } from "./internal.ts";

// --- in-memory cron store (discover rows + ledger) ---
function memoryCronStore(): {
  service: CronStoreService;
  discoverRows: Map<string, DiscoverRow>;
  ledgers: Map<string, CronLedger>;
} {
  const discoverRows = new Map<string, DiscoverRow>();
  const ledgers = new Map<string, CronLedger>();
  return {
    discoverRows,
    ledgers,
    service: {
      getRow: () => Effect.succeed(Option.none()),
      listRows: () => Effect.succeed([]),
      saveRow: () => Effect.void,
      deleteRow: () => Effect.void,
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

// A wf store where `dispatched` slugs already have a row (dedup should skip them).
const wfStoreWith = (dispatched: Set<string> = new Set()): WfStoreService => ({
  getRow: (id) =>
    Effect.succeed(
      dispatched.has(id.slug)
        ? Option.some({
            repo: id.repo,
            slug: id.slug,
            workflow: id.workflow,
            status: "running",
            instanceId: "x",
            updatedAt: "t",
          } as WfRow)
        : Option.none(),
    ),
  saveRow: () => Effect.void,
});

const savedStore = (): WorkflowStoreService => ({
  save: () => Effect.void,
  get: (key) =>
    Effect.succeed(
      Option.some({ steps: [{ activity: `run-${key}` }] } as unknown as StoredWorkflow),
    ),
  list: () => Effect.succeed([]),
  listScheduled: () => Effect.succeed([]),
  markRun: () => Effect.void,
});

const sourceReader = (issues: readonly SourceItem[]): SourceReaderService => ({
  listOpenIssues: () => Effect.succeed(issues),
});

const emptyWatchLedger: WatchLedger = {
  runsFired: 0,
  runsFinalized: 0,
  engineFires: 0,
  costUsd: 0,
};
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
  getRunMeta: () => Effect.succeed(null),
};

function env(
  cs: CronStoreService,
  invoker: WorkflowInvokerService,
  sr: SourceReaderService,
  wf: WfStoreService = wfStoreWith(),
) {
  return Layer.mergeAll(
    Layer.succeed(CronStore, cs),
    Layer.succeed(WorkflowInvoker, invoker),
    Layer.succeed(SourceReader, sr),
    Layer.succeed(WfStore, wf),
    Layer.succeed(WorkflowStore, savedStore()),
    Layer.succeed(WatchStore, stubWatch),
  );
}

const DUE = "* * * * *"; // every minute, created long ago → always due
const issues: SourceItem[] = [
  { number: 10, title: "oldest", createdAt: "2026-07-01T00:00:00Z" },
  { number: 20, title: "newer", createdAt: "2026-07-02T00:00:00Z" },
];

const activeRow = (over: Partial<DiscoverRow> = {}): DiscoverRow => ({
  repo: "stiproot/h",
  label: "agent-approved",
  trigger: { key: "implement-pr" },
  status: "active",
  cadence: DUE,
  source: { mode: "github-issues" },
  gates: { maxFiresPerDay: 5 },
  epoch: 1,
  fires: 0,
  createdAt: "2020-01-01T00:00:00Z",
  updatedAt: "2020-01-01T00:00:00Z",
  ...over,
});

describe("registerDiscover", () => {
  it("writes an active discovery row (epoch 1, fires 0, github-issues source)", async () => {
    const cs = memoryCronStore();
    const res = await Effect.runPromise(
      registerDiscover({
        repo: "stiproot/h",
        label: "agent-approved",
        trigger: { key: "implement-pr" },
        cadence: DUE,
      }).pipe(Effect.provide(env(cs.service, recordingInvoker().service, sourceReader([])))),
    );
    expect(res).toEqual({ discoverId: "stiproot/h:agent-approved", active: true });
    const row = cs.discoverRows.get("stiproot/h:agent-approved")!;
    expect(row.status).toBe("active");
    expect(row.epoch).toBe(1);
    expect(row.fires).toBe(0);
    expect(row.source.mode).toBe("github-issues");
    expect(row.gates.maxFiresPerDay).toBe(5);
  });

  it("re-registration bumps epoch and preserves runtime state (fires, currentInstanceId)", async () => {
    const cs = memoryCronStore();
    cs.discoverRows.set(
      "stiproot/h:agent-approved",
      activeRow({ epoch: 3, fires: 2, currentInstanceId: "feature-issue-9", lastFiredIssue: 9 }),
    );
    await Effect.runPromise(
      registerDiscover({
        repo: "stiproot/h",
        label: "agent-approved",
        trigger: { key: "implement-pr" },
        cadence: "*/30 * * * *",
      }).pipe(Effect.provide(env(cs.service, recordingInvoker().service, sourceReader([])))),
    );
    const row = cs.discoverRows.get("stiproot/h:agent-approved")!;
    expect(row.epoch).toBe(4);
    expect(row.fires).toBe(2);
    expect(row.currentInstanceId).toBe("feature-issue-9");
    expect(row.cadence).toBe("*/30 * * * *");
  });
});

describe("scanDiscoverEffect", () => {
  it("fires the OLDEST eligible issue, once, with the right identity + fresh", async () => {
    const cs = memoryCronStore();
    cs.discoverRows.set("stiproot/h:agent-approved", activeRow());
    const inv = recordingInvoker();
    const report = await Effect.runPromise(
      scanDiscoverEffect(undefined).pipe(
        Effect.provide(env(cs.service, inv.service, sourceReader(issues))),
      ),
    );
    expect(report.fired).toEqual(["stiproot/h:agent-approved#10"]);
    expect(inv.invokes).toHaveLength(1);
    const req = inv.invokes[0]!;
    expect(req.instanceId).toBe("feature-issue-10");
    expect(req.fresh).toBe(true);
    expect(req.wf).toEqual({ repo: "stiproot/h", slug: "issue-10", workflow: "implement-pr" });
    expect(req.params).toMatchObject({ repo: "stiproot/h", slug: "issue-10", issueNumber: "10" });
    // Row stamped: fired the oldest, fires incremented, in-flight instance recorded, ledger tallied.
    const row = cs.discoverRows.get("stiproot/h:agent-approved")!;
    expect(row.fires).toBe(1);
    expect(row.currentInstanceId).toBe("feature-issue-10");
    expect(row.lastFiredIssue).toBe(10);
    expect(cs.ledgers.get(new Date().toISOString().slice(0, 10))?.discoveryFires).toBe(1);
  });

  it("dedups: skips issues that already have a wf: row, fires the next eligible", async () => {
    const cs = memoryCronStore();
    cs.discoverRows.set("stiproot/h:agent-approved", activeRow());
    const inv = recordingInvoker();
    // issue-10 already dispatched → dedup skips it, fires issue-20.
    const report = await Effect.runPromise(
      scanDiscoverEffect(undefined).pipe(
        Effect.provide(
          env(cs.service, inv.service, sourceReader(issues), wfStoreWith(new Set(["issue-10"]))),
        ),
      ),
    );
    expect(report.fired).toEqual(["stiproot/h:agent-approved#20"]);
    expect(inv.invokes[0]!.instanceId).toBe("feature-issue-20");
  });

  it("serializes: no fire while the last-fired instance is still live", async () => {
    const cs = memoryCronStore();
    cs.discoverRows.set(
      "stiproot/h:agent-approved",
      activeRow({ fires: 1, currentInstanceId: "feature-issue-10", lastFiredIssue: 10 }),
    );
    const inv = recordingInvoker({
      "feature-issue-10": { instanceId: "feature-issue-10", runtimeStatus: "RUNNING" },
    });
    const report = await Effect.runPromise(
      scanDiscoverEffect(undefined).pipe(
        Effect.provide(env(cs.service, inv.service, sourceReader(issues))),
      ),
    );
    expect(report.fired).toEqual([]);
    expect(inv.invokes).toHaveLength(0);
  });

  it("respects the daily cap (no fire when discoveryFires >= maxFiresPerDay)", async () => {
    const cs = memoryCronStore();
    cs.discoverRows.set("stiproot/h:agent-approved", activeRow({ gates: { maxFiresPerDay: 2 } }));
    cs.ledgers.set(new Date().toISOString().slice(0, 10), {
      ...emptyCronLedger,
      discoveryFires: 2,
    });
    const inv = recordingInvoker();
    const report = await Effect.runPromise(
      scanDiscoverEffect(undefined).pipe(
        Effect.provide(env(cs.service, inv.service, sourceReader(issues))),
      ),
    );
    expect(report.fired).toEqual([]);
    expect(inv.invokes).toHaveLength(0);
  });

  it("stamps lastRunAt even when nothing is eligible (throttles the next read)", async () => {
    const cs = memoryCronStore();
    cs.discoverRows.set("stiproot/h:agent-approved", activeRow());
    const inv = recordingInvoker();
    // Every issue already dispatched → nothing eligible.
    const report = await Effect.runPromise(
      scanDiscoverEffect(undefined).pipe(
        Effect.provide(
          env(
            cs.service,
            inv.service,
            sourceReader(issues),
            wfStoreWith(new Set(["issue-10", "issue-20"])),
          ),
        ),
      ),
    );
    expect(report.fired).toEqual([]);
    expect(report.skipped).toEqual(["stiproot/h:agent-approved: nothing eligible"]);
    const row = cs.discoverRows.get("stiproot/h:agent-approved")!;
    expect(row.lastRunAt).toBeDefined();
    expect(row.epoch).toBe(2); // mark-scanned bumped the epoch
  });
});

describe("discoverTrigger (the row is a fire-descriptor template)", () => {
  it("instantiates the per-issue descriptor: deterministic id, engine params winning over the template's", () => {
    expect(
      discoverTrigger(
        {
          repo: "o/r",
          trigger: {
            key: "implement-pr",
            params: { agentId: "pi-agent", slug: "stale-clobbered" },
            watch: { maxDurationMs: 1000 },
          },
        },
        42,
      ),
    ).toEqual({
      key: "implement-pr",
      params: { agentId: "pi-agent", repo: "o/r", slug: "issue-42", issueNumber: "42" },
      instanceId: "feature-issue-42",
      workspaceId: "feature-issue-42",
      watch: { maxDurationMs: 1000 },
    });
  });

  it("omits watch when the row fires unsupervised", () => {
    const trigger = discoverTrigger({ repo: "o/r", trigger: { key: "implement-pr" } }, 7);
    expect(trigger).not.toHaveProperty("watch");
  });
});
