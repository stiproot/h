import { WorkflowError } from "core";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option, Ref } from "effect";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { StoredWorkflow, WorkflowRequest } from "../../domain/models/workflow.model.ts";
import {
  WorkflowInvoker,
  type WorkflowInvokerService,
} from "../../domain/ports/IWorkflowInvoker.ts";
import { WorkflowStore, type WorkflowStoreService } from "../../domain/ports/IWorkflowStore.ts";
import { registerCronRoutes, tickEffect } from "./cron.router.ts";

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

const envLayer = (invoker: WorkflowInvokerService, store: WorkflowStoreService) =>
  Layer.mergeAll(Layer.succeed(WorkflowInvoker, invoker), Layer.succeed(WorkflowStore, store));

// A workflow whose every-minute schedule was saved long ago: always due.
const dueWorkflow: StoredWorkflow = {
  steps: [{ activity: "run-claude", input: { task: "t" } }],
  schedule: { cron: "* * * * *", savedAt: "2020-01-01T00:00:00Z" },
};

describe("tickEffect compare-and-set", () => {
  it("runs exactly one of two concurrent ticks; the loser is skipped immediately", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ticking = yield* Ref.make(false);
        const gate = yield* Deferred.make<void>();
        const scanning = yield* Deferred.make<void>();
        let scans = 0;
        const env = envLayer(
          stubInvoker(),
          stubStore({
            listScheduled: () =>
              Effect.gen(function* () {
                scans += 1;
                yield* Deferred.succeed(scanning, void 0);
                yield* Deferred.await(gate); // hold the winner mid-scan
                return [];
              }),
          }),
        );

        const winner = yield* Effect.fork(tickEffect(ticking, undefined).pipe(Effect.provide(env)));
        yield* Deferred.await(scanning); // the winner owns the flag and is mid-scan

        const loser = yield* tickEffect(ticking, undefined).pipe(Effect.provide(env));
        expect(loser).toEqual({ skipped: "previous tick still processing" });

        yield* Deferred.succeed(gate, void 0);
        const result = yield* Fiber.join(winner);
        expect(result).toEqual({ fired: [] });
        expect(scans).toBe(1); // the losing tick never scanned
        expect(yield* Ref.get(ticking)).toBe(false); // flag released for the next tick
      }),
    );
  });

  it("clears the flag when the scan fails (ensuring), so the next tick runs", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ticking = yield* Ref.make(false);
        let calls = 0;
        const env = envLayer(
          stubInvoker(),
          stubStore({
            listScheduled: () => {
              calls += 1;
              return calls === 1
                ? Effect.fail(new WorkflowError({ cause: new Error("redis down"), instanceId: "" }))
                : Effect.succeed([]);
            },
          }),
        );

        const failure = yield* tickEffect(ticking, undefined).pipe(
          Effect.provide(env),
          Effect.flip,
        );
        // Proxy-wrapped across spans in general: assert the tag, never instance identity.
        expect(failure._tag).toBe("WorkflowError");
        expect(yield* Ref.get(ticking)).toBe(false); // reset ran on the failure path

        const second = yield* tickEffect(ticking, undefined).pipe(Effect.provide(env));
        expect(second).toEqual({ fired: [] });
      }),
    );
  });

  it("fires due workflows, threads the tick's traceparent, and stamps markRun", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ticking = yield* Ref.make(false);
        const invoked: WorkflowRequest[] = [];
        const stamped: Array<{ key: string; lastRunAt: string }> = [];
        const notDue: StoredWorkflow = {
          steps: [],
          schedule: { cron: "* * * * *", savedAt: new Date(Date.now() + 60_000).toISOString() },
        };
        const paused: StoredWorkflow = { ...dueWorkflow, disabled: true };
        const env = envLayer(
          stubInvoker({
            invoke: (input) => {
              invoked.push(input);
              return Effect.succeed({ instanceId: "wf-1" });
            },
          }),
          stubStore({
            listScheduled: () =>
              Effect.succeed([
                { key: "due", workflow: dueWorkflow },
                { key: "future", workflow: notDue },
                { key: "paused", workflow: paused },
              ]),
            markRun: (key, lastRunAt) => {
              stamped.push({ key, lastRunAt });
              return Effect.void;
            },
          }),
        );

        const result = yield* tickEffect(ticking, "00-abc-def-01").pipe(Effect.provide(env));
        expect(result).toEqual({ fired: ["due"] });
        expect(invoked).toEqual([
          { steps: dueWorkflow.steps, workspaceId: undefined, traceparent: "00-abc-def-01" },
        ]);
        expect(stamped).toHaveLength(1);
        expect(stamped[0]!.key).toBe("due");
      }),
    );
  });
});

describe("the cron route's Fastify plugin scope", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function makeApp(store: WorkflowStoreService) {
    const runtime = ManagedRuntime.make(envLayer(stubInvoker(), store));
    const app = Fastify();
    registerCronRoutes(app, runtime);
    await app.ready();
    cleanups.push(
      () => app.close(),
      () => runtime.dispose(),
    );
    return app;
  }

  it("answers the Dapr OPTIONS probe with 200", async () => {
    const app = await makeApp(stubStore());
    const res = await app.inject({ method: "OPTIONS", url: "/workflow-cron-tick" });
    expect(res.statusCode).toBe(200);
  });

  it("accepts the empty-body application/json tick (cleared content-type parsers)", async () => {
    const app = await makeApp(stubStore());
    const res = await app.inject({
      method: "POST",
      url: "/workflow-cron-tick",
      headers: { "content-type": "application/json" },
      // no payload: Dapr's tick arrives with an empty JSON body
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fired: [] });
  });

  it("500s in the Fastify default error shape when the scan fails", async () => {
    const app = await makeApp(
      stubStore({
        listScheduled: () =>
          Effect.fail(new WorkflowError({ cause: new Error("redis down"), instanceId: "" })),
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/workflow-cron-tick",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ statusCode: 500, error: "Internal Server Error" });
  });
});
