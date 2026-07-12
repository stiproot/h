import { WorkflowError } from "core";
import { DaprPublisherTag, type DaprPublisherService } from "core-dapr";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { emptyLedger } from "../../domain/models/watch.model.ts";
import type { StoredWorkflow, WorkflowRequest } from "../../domain/models/workflow.model.ts";
import { emptyChainLedger } from "../../domain/models/chain.model.ts";
import { emptyCronLedger } from "../../domain/models/cron.model.ts";
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
import { registerTriggerRoutes } from "./trigger.router.ts";
import type { WorkflowRoutesRuntime } from "./workflow.router.ts";

const stubWatchStore = (): WatchStoreService => ({
  getRow: () => Effect.succeed(Option.none()),
  listRows: () => Effect.succeed([]),
  saveRow: () => Effect.void,
  deleteRow: () => Effect.void,
  getConfig: () => Effect.succeed(Option.none()),
  getHeartbeat: () => Effect.succeed(Option.none()),
  heartbeat: () => Effect.void,
  getLedger: () => Effect.succeed(emptyLedger),
  bumpLedger: () => Effect.void,
  listRunKeys: () => Effect.succeed([]),
  getRunCost: () => Effect.succeed(null),
});

// The trigger router never touches chains, but the shared runtime type now includes ChainStore.
const stubChainStore = (): ChainStoreService => ({
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
});

// The trigger router never touches crons either, but the shared runtime type now includes them.
const stubCronStore = (): CronStoreService => ({
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
});
const stubWfStore = (): WfStoreService => ({
  getRow: () => Effect.succeed(Option.none()),
  saveRow: () => Effect.void,
});

const stubPublisher: DaprPublisherService = { publish: () => Effect.void };
const stubSourceReader: SourceReaderService = { listOpenIssues: () => Effect.succeed([]) };

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

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeApp(
  invoker: WorkflowInvokerService,
  store: WorkflowStoreService,
): Promise<FastifyInstance> {
  const runtime: WorkflowRoutesRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(WorkflowInvoker, invoker),
      Layer.succeed(WorkflowStore, store),
      Layer.succeed(WatchStore, stubWatchStore()),
      Layer.succeed(ChainStore, stubChainStore()),
      Layer.succeed(CronStore, stubCronStore()),
      Layer.succeed(WfStore, stubWfStore()),
      Layer.succeed(DaprPublisherTag, stubPublisher),
      Layer.succeed(SourceReader, stubSourceReader),
    ),
  );
  const app = Fastify();
  registerTriggerRoutes(app, runtime);
  await app.ready();
  cleanups.push(
    () => app.close(),
    () => runtime.dispose(),
  );
  return app;
}

const storedTemplate: StoredWorkflow = {
  steps: [{ id: "improve", activity: "run-claude", input: { task: "{{params.feedback}}" } }],
  params: { slug: "default-slug" },
};

describe("POST /workflow-trigger", () => {
  it("fires the named template with fire-time params merged over defaults (CloudEvents envelope)", async () => {
    const seen: WorkflowRequest[] = [];
    const app = await makeApp(
      stubInvoker({
        invoke: (input) => {
          seen.push(input);
          return Effect.succeed({ instanceId: "wf-9" });
        },
      }),
      stubStore({
        get: (key) =>
          Effect.succeed(
            key === "plugin-improvement" ? Option.some(storedTemplate) : Option.none(),
          ),
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow-trigger",
      headers: { "content-type": "application/cloudevents+json" },
      payload: JSON.stringify({
        id: "evt-1",
        data: { key: "plugin-improvement", params: { feedback: "sharpen the prompt" } },
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fired: "plugin-improvement", instanceId: "wf-9" });
    expect(seen[0]!.params).toEqual({ slug: "default-slug", feedback: "sharpen the prompt" });
  });

  it("tolerates a JSON-string data payload (defensive parse, like the old handler)", async () => {
    const app = await makeApp(
      stubInvoker(),
      stubStore({ get: () => Effect.succeed(Option.some(storedTemplate)) }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow-trigger",
      headers: { "content-type": "application/cloudevents+json" },
      payload: JSON.stringify({ data: JSON.stringify({ key: "plugin-improvement" }) }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fired: "plugin-improvement", instanceId: "generated-id" });
  });

  it("acks (skips) an event without a workflow key — redelivery cannot fix a payload", async () => {
    const app = await makeApp(stubInvoker(), stubStore());
    const res = await app.inject({
      method: "POST",
      url: "/workflow-trigger",
      headers: { "content-type": "application/cloudevents+json" },
      payload: JSON.stringify({ data: { feedback: "no key here" } }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ skipped: "event data lacks a workflow key" });
  });

  it("acks an unknown key and a disabled template", async () => {
    const app = await makeApp(
      stubInvoker(),
      stubStore({
        get: (key) =>
          Effect.succeed(
            key === "paused" ? Option.some({ ...storedTemplate, disabled: true }) : Option.none(),
          ),
      }),
    );
    const unknown = await app.inject({
      method: "POST",
      url: "/workflow-trigger",
      headers: { "content-type": "application/cloudevents+json" },
      payload: JSON.stringify({ data: { key: "nope" } }),
    });
    expect(unknown.json()).toEqual({ skipped: "no saved workflow 'nope'" });
    const disabled = await app.inject({
      method: "POST",
      url: "/workflow-trigger",
      headers: { "content-type": "application/cloudevents+json" },
      payload: JSON.stringify({ data: { key: "paused" } }),
    });
    expect(disabled.json()).toEqual({ skipped: "workflow 'paused' is disabled" });
  });

  it("500s on an infra failure so Dapr redelivers", async () => {
    const app = await makeApp(
      stubInvoker({
        invoke: () =>
          Effect.fail(new WorkflowError({ cause: new Error("scheduler down"), instanceId: "" })),
      }),
      stubStore({ get: () => Effect.succeed(Option.some(storedTemplate)) }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow-trigger",
      headers: { "content-type": "application/cloudevents+json" },
      payload: JSON.stringify({ data: { key: "plugin-improvement" } }),
    });
    expect(res.statusCode).toBe(500);
  });

  it("also accepts a plain application/json publish (no envelope)", async () => {
    const app = await makeApp(
      stubInvoker(),
      stubStore({ get: () => Effect.succeed(Option.some(storedTemplate)) }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow-trigger",
      payload: { key: "plugin-improvement", params: { feedback: "raw" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fired: "plugin-improvement", instanceId: "generated-id" });
  });
});
