import { WorkflowError } from "core";
import { DaprPublisherTag, type DaprPublisherService } from "core-dapr";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { type WatchRow, emptyLedger } from "../../domain/models/watch.model.ts";
import type { StoredWorkflow, WorkflowRequest } from "../../domain/models/workflow.model.ts";
import { emptyChainLedger } from "../../domain/models/chain.model.ts";
import { type CronRow, emptyCronLedger } from "../../domain/models/cron.model.ts";
import { ChainStore, type ChainStoreService } from "../../domain/ports/IChainStore.ts";
import { CronStore, type CronStoreService } from "../../domain/ports/ICronStore.ts";
import { WatchStore, type WatchStoreService } from "../../domain/ports/IWatchStore.ts";
import { WfStore, type WfStoreService } from "../../domain/ports/IWfStore.ts";
import { SourceReader, type SourceReaderService } from "../../domain/ports/ISourceReader.ts";
import {
  WorkflowInvoker,
  type WorkflowInvokerService,
} from "../../domain/ports/IWorkflowInvoker.ts";
import { WorkflowStore, type WorkflowStoreService } from "../../domain/ports/IWorkflowStore.ts";
import { registerWorkflowRoutes, type WorkflowRoutesRuntime } from "./workflow.router.ts";

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

// In-memory watch registry so the routes' registration through invokeWithWatch is observable.
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
    },
  };
}

// The workflow routes never touch chains, but the shared runtime type now includes ChainStore.
const stubChainStore: ChainStoreService = {
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

// Same for crons + the wf store — the run routes don't touch them, but the shared runtime type does.
const stubCronStore: CronStoreService = {
  getRow: () => Effect.succeed(Option.none()),
  listRows: () => Effect.succeed([]),
  saveRow: () => Effect.void,
  deleteRow: () => Effect.void,
  getDiscoverRow: () => Effect.succeed(Option.none()),
  listDiscoverRows: () => Effect.succeed([]),
  saveDiscoverRow: () => Effect.void,
  deleteDiscoverRow: () => Effect.void,
  getConfig: () => Effect.succeed(Option.none()),
  getHeartbeat: () => Effect.succeed(Option.none()),
  heartbeat: () => Effect.void,
  getLedger: () => Effect.succeed(emptyCronLedger),
  bumpLedger: () => Effect.void,
};
const stubWfStore: WfStoreService = {
  getRow: () => Effect.succeed(Option.none()),
  saveRow: () => Effect.void,
};

const stubPublisher: DaprPublisherService = { publish: () => Effect.void };
const stubSourceReader: SourceReaderService = { listOpenIssues: () => Effect.succeed([]) };

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeApp(
  invoker: WorkflowInvokerService,
  store: WorkflowStoreService,
  watch: WatchStoreService = memoryWatchStore().service,
  cron: CronStoreService = stubCronStore,
): Promise<FastifyInstance> {
  const runtime: WorkflowRoutesRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(WorkflowInvoker, invoker),
      Layer.succeed(WorkflowStore, store),
      Layer.succeed(WatchStore, watch),
      Layer.succeed(ChainStore, stubChainStore),
      Layer.succeed(CronStore, cron),
      Layer.succeed(WfStore, stubWfStore),
      Layer.succeed(DaprPublisherTag, stubPublisher),
      Layer.succeed(SourceReader, stubSourceReader),
    ),
  );
  const app = Fastify();
  registerWorkflowRoutes(app, runtime);
  await app.ready();
  cleanups.push(
    () => app.close(),
    () => runtime.dispose(),
  );
  return app;
}

describe("POST /workflow/run", () => {
  it("202s with the scheduled instance id and passes the payload through", async () => {
    const seen: WorkflowRequest[] = [];
    const app = await makeApp(
      stubInvoker({
        invoke: (input) => {
          seen.push(input);
          return Effect.succeed({ instanceId: "wf-1" });
        },
      }),
      stubStore(),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow/run",
      payload: { steps: [{ activity: "run-claude", input: { task: "t" } }], extra: "kept" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ instanceId: "wf-1", watching: false });
    // Excess wire fields survive the decode (onExcessProperty: "preserve").
    expect(seen[0]).toMatchObject({ extra: "kept" });
  });

  it("400s a malformed body with the Bad Request shape (ParseError mapping)", async () => {
    const app = await makeApp(stubInvoker(), stubStore());
    const res = await app.inject({
      method: "POST",
      url: "/workflow/run",
      payload: { steps: "not-an-array" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ statusCode: 400, error: "Bad Request" });
  });

  it("500s a WorkflowError with the Fastify default error shape and the cause's message", async () => {
    const app = await makeApp(
      stubInvoker({
        invoke: () =>
          Effect.fail(new WorkflowError({ cause: new Error("scheduler down"), instanceId: "" })),
      }),
      stubStore(),
    );
    const res = await app.inject({ method: "POST", url: "/workflow/run", payload: { steps: [] } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({
      statusCode: 500,
      error: "Internal Server Error",
      message: "scheduler down",
    });
  });
});

describe("POST /workflow/save", () => {
  it("201s and persists the schedule envelope", async () => {
    const saved: Array<{ key: string; workflow: StoredWorkflow }> = [];
    const app = await makeApp(
      stubInvoker(),
      stubStore({
        save: (key, workflow) => {
          saved.push({ key, workflow });
          return Effect.void;
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow/save",
      payload: { key: "daily", steps: [{ activity: "run-claude" }], schedule: "0 9 * * *" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ key: "daily" });
    expect(saved[0]!.key).toBe("daily");
    expect(saved[0]!.workflow.schedule).toMatchObject({ cron: "0 9 * * *" });
    expect(saved[0]!.workflow.schedule!.savedAt).toBeTruthy();
  });

  it("persists default params on the stored workflow", async () => {
    const saved: Array<{ key: string; workflow: StoredWorkflow }> = [];
    const app = await makeApp(
      stubInvoker(),
      stubStore({
        save: (key, workflow) => {
          saved.push({ key, workflow });
          return Effect.void;
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow/save",
      payload: {
        key: "feature",
        steps: [{ activity: "run-claude", input: { task: "{{params.spec}}" } }],
        params: { slug: "default-slug" },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(saved[0]!.workflow.params).toEqual({ slug: "default-slug" });
  });

  it("400s an invalid cron expression with the legacy body", async () => {
    const app = await makeApp(stubInvoker(), stubStore());
    const res = await app.inject({
      method: "POST",
      url: "/workflow/save",
      payload: { key: "daily", steps: [], schedule: "not a cron" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid cron expression: not a cron" });
  });

  it("400s a body without a key (ParseError mapping)", async () => {
    const app = await makeApp(stubInvoker(), stubStore());
    const res = await app.inject({
      method: "POST",
      url: "/workflow/save",
      payload: { steps: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ statusCode: 400, error: "Bad Request" });
  });
});

describe("POST /workflow/run/:key", () => {
  it("404s a missing key with the legacy body (Option.none mapping)", async () => {
    const app = await makeApp(stubInvoker(), stubStore());
    const res = await app.inject({ method: "POST", url: "/workflow/run/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Workflow not found" });
  });

  it("202s and invokes the stored workflow's projection", async () => {
    const seen: WorkflowRequest[] = [];
    const stored: StoredWorkflow = {
      steps: [{ activity: "run-claude", input: { task: "t" } }],
      workspaceId: "ws-1",
    };
    const app = await makeApp(
      stubInvoker({
        invoke: (input) => {
          seen.push(input);
          return Effect.succeed({ instanceId: "wf-2" });
        },
      }),
      stubStore({ get: () => Effect.succeed(Option.some(stored)) }),
    );
    const res = await app.inject({ method: "POST", url: "/workflow/run/daily" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ instanceId: "wf-2", watching: false });
    expect(seen[0]).toMatchObject({ steps: stored.steps, workspaceId: "ws-1" });
  });

  it("merges fire-time params over the stored defaults", async () => {
    const seen: WorkflowRequest[] = [];
    const stored: StoredWorkflow = {
      steps: [{ activity: "run-claude", input: { task: "{{params.spec}}" } }],
      params: { spec: "default-spec", slug: "default-slug" },
    };
    const app = await makeApp(
      stubInvoker({
        invoke: (input) => {
          seen.push(input);
          return Effect.succeed({ instanceId: "wf-3" });
        },
      }),
      stubStore({ get: () => Effect.succeed(Option.some(stored)) }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow/run/feature",
      payload: { params: { spec: "fire-time-spec" } },
    });
    expect(res.statusCode).toBe(202);
    expect(seen[0]!.params).toEqual({ spec: "fire-time-spec", slug: "default-slug" });
  });

  it("passes a fire-time instanceId/workspaceId through to the invoker (readable run keys)", async () => {
    const seen: WorkflowRequest[] = [];
    const app = await makeApp(
      stubInvoker({
        invoke: (input) => {
          seen.push(input);
          return Effect.succeed({ instanceId: input.instanceId ?? "generated" });
        },
      }),
      stubStore({ get: () => Effect.succeed(Option.some({ steps: [] })) }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow/run/feature",
      payload: { instanceId: "feature-dark-mode", workspaceId: "ws-dark-mode" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ instanceId: "feature-dark-mode", watching: false });
    expect(seen[0]).toMatchObject({
      instanceId: "feature-dark-mode",
      workspaceId: "ws-dark-mode",
    });
  });

  it("passes fresh through to the invoker, and omits it when not sent", async () => {
    const seen: WorkflowRequest[] = [];
    const app = await makeApp(
      stubInvoker({
        invoke: (input) => {
          seen.push(input);
          return Effect.succeed({ instanceId: input.instanceId ?? "generated" });
        },
      }),
      stubStore({ get: () => Effect.succeed(Option.some({ steps: [] })) }),
    );
    const fresh = await app.inject({
      method: "POST",
      url: "/workflow/run/feature",
      payload: { instanceId: "feature-issue-1", fresh: true },
    });
    expect(fresh.statusCode).toBe(202);
    expect(seen[0]).toMatchObject({ instanceId: "feature-issue-1", fresh: true });

    const attach = await app.inject({
      method: "POST",
      url: "/workflow/run/feature",
      payload: { instanceId: "feature-issue-1" },
    });
    expect(attach.statusCode).toBe(202);
    expect(seen[1]).not.toHaveProperty("fresh");
  });

  it("a watch field registers a durable row in the same handler that schedules (W6)", async () => {
    const mem = memoryWatchStore();
    const seen: WorkflowRequest[] = [];
    const app = await makeApp(
      stubInvoker({
        invoke: (input) => {
          seen.push(input);
          return Effect.succeed({ instanceId: input.instanceId ?? "generated" });
        },
      }),
      stubStore({
        get: () => Effect.succeed(Option.some({ steps: [{ activity: "run-claude" }] })),
      }),
      mem.service,
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow/run/feature",
      payload: { instanceId: "feature-issue-9", watch: { maxDurationMs: 60_000 } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ instanceId: "feature-issue-9", watching: true });
    const row = mem.rows.get("feature-issue-9")!;
    expect(row).toMatchObject({
      status: "scheduling",
      policy: { maxDurationMs: 60_000 },
      meta: { owner: "feature" },
    });
    // The resubmit is stored for engine retries, and the watch field never reaches the invoker.
    expect(row.resubmit).toBeDefined();
    expect(seen[0]).not.toHaveProperty("watch");
  });

  it("a cron field passes armCron to the run (armed by the run's closing bracket, not the route)", async () => {
    const invokes: WorkflowRequest[] = [];
    const stored: StoredWorkflow = {
      steps: [{ activity: "run-claude" }],
      params: { repo: "stiproot/h", slug: "pi-agent" },
    };
    const app = await makeApp(
      stubInvoker({
        invoke: (req) =>
          Effect.sync(() => {
            invokes.push(req);
            return { instanceId: "revise-pi-agent" };
          }),
      }),
      stubStore({ get: () => Effect.succeed(Option.some(stored)) }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow/run/revise",
      payload: { cron: { cadence: "*/30 * * * *", budget: { maxFires: 50 } } },
    });
    expect(res.statusCode).toBe(202);
    // §10: the route does NOT register the cron — it threads armCron into the run, whose closing
    // bracket (register-cron activity) arms the recur cron idempotently.
    expect(invokes[0]!.armCron).toEqual({
      cadence: "*/30 * * * *",
      workflow: "revise",
      budget: { maxFires: 50 },
    });
  });

  it("400s a cron field on a run with no wf-identity (no repo/slug)", async () => {
    const app = await makeApp(
      stubInvoker(),
      stubStore({
        get: () => Effect.succeed(Option.some({ steps: [{ activity: "run-claude" }] })),
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow/run/revise",
      payload: { cron: { cadence: "*/30 * * * *" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a stored watch policy on the saved workflow registers without any body field", async () => {
    const mem = memoryWatchStore();
    const stored: StoredWorkflow = {
      steps: [{ activity: "run-claude" }],
      watch: { maxDurationMs: 5_000, retry: { maxAttempts: 2 } },
    };
    const app = await makeApp(
      stubInvoker(),
      stubStore({ get: () => Effect.succeed(Option.some(stored)) }),
      mem.service,
    );
    const res = await app.inject({ method: "POST", url: "/workflow/run/nightly" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ instanceId: "generated-id", watching: true });
    expect(mem.rows.get("generated-id")!.policy.retry).toEqual({ maxAttempts: 2 });
  });
});

describe("POST /workflow/terminate/:instanceId", () => {
  it("202s with the instance id after terminating", async () => {
    const terminated: string[] = [];
    const app = await makeApp(
      stubInvoker({
        terminate: (instanceId) => {
          terminated.push(instanceId);
          return Effect.void;
        },
      }),
      stubStore(),
    );
    const res = await app.inject({ method: "POST", url: "/workflow/terminate/wf-9" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ instanceId: "wf-9" });
    expect(terminated).toEqual(["wf-9"]);
  });

  it("500s a WorkflowError from the invoker with its cause message", async () => {
    const app = await makeApp(
      stubInvoker({
        terminate: (instanceId) =>
          Effect.fail(
            new WorkflowError({ cause: new Error("terminate failed with 404"), instanceId }),
          ),
      }),
      stubStore(),
    );
    const res = await app.inject({ method: "POST", url: "/workflow/terminate/wf-9" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ message: "terminate failed with 404" });
  });
});

describe("GET routes", () => {
  it("GET /workflow/list returns the keys", async () => {
    const app = await makeApp(stubInvoker(), stubStore({ list: () => Effect.succeed(["a", "b"]) }));
    const res = await app.inject({ method: "GET", url: "/workflow/list" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ keys: ["a", "b"] });
  });

  it("GET /workflow/get/:key returns the stored value, 404s a miss", async () => {
    const stored: StoredWorkflow = { steps: [{ activity: "setup" }], disabled: true };
    const app = await makeApp(
      stubInvoker(),
      stubStore({
        get: (key) => Effect.succeed(key === "daily" ? Option.some(stored) : Option.none()),
      }),
    );
    const hit = await app.inject({ method: "GET", url: "/workflow/get/daily" });
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toEqual(stored);
    const miss = await app.inject({ method: "GET", url: "/workflow/get/nope" });
    expect(miss.statusCode).toBe(404);
    expect(miss.json()).toEqual({ error: "Workflow not found" });
  });

  it("GET /workflow/status/:instanceId passes the status through (UNKNOWN fallback intact)", async () => {
    const app = await makeApp(
      stubInvoker({
        getStatus: (instanceId) => Effect.succeed({ instanceId, runtimeStatus: "UNKNOWN" }),
      }),
      stubStore(),
    );
    const res = await app.inject({ method: "GET", url: "/workflow/status/wf-9" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ instanceId: "wf-9", runtimeStatus: "UNKNOWN" });
  });

  it("GET /dapr/subscribe declares the workflow-trigger subscription", async () => {
    const app = await makeApp(stubInvoker(), stubStore());
    const res = await app.inject({ method: "GET", url: "/dapr/subscribe" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { pubsubname: "pubsub", topic: "workflow-trigger", route: "workflow-trigger" },
    ]);
  });
});
