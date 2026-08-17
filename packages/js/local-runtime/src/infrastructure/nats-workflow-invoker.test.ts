import { WfStore, WorkflowInvoker, type WfRow } from "engine-core";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { type FirePublisher, NatsWorkflowInvokerLive } from "./nats-workflow-invoker.ts";

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const wfStore = (rows: Record<string, Partial<WfRow>> = {}) =>
  Layer.succeed(WfStore, {
    getRun: (instanceId: string) =>
      Effect.succeed(
        rows[instanceId] === undefined
          ? Option.none()
          : Option.some({ instanceId, updatedAt: iso(0), ...rows[instanceId] } as WfRow),
      ),
    saveRow: () => Effect.void,
  });

const recordingPublisher = (): {
  publisher: FirePublisher;
  sent: Record<string, unknown>[];
  control: Array<{ subject: string; data: Record<string, unknown> }>;
} => {
  const sent: Record<string, unknown>[] = [];
  const control: Array<{ subject: string; data: Record<string, unknown> }> = [];
  return {
    sent,
    control,
    publisher: {
      publish: async (d) => void sent.push(d),
      control: async (subject, data) => void control.push({ subject, data }),
    },
  };
};

const run = <A>(
  effect: Effect.Effect<A, unknown, WorkflowInvoker>,
  rows: Record<string, Partial<WfRow>> = {},
  publisher: FirePublisher = recordingPublisher().publisher,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(NatsWorkflowInvokerLive(publisher).pipe(Layer.provide(wfStore(rows)))),
    ) as Effect.Effect<A, unknown, never>,
  );

describe("getStatus", () => {
  it("maps a run's own report onto the runtime statuses the engines decide against", async () => {
    const cases: Array<[WfRow["status"], string]> = [
      ["done", "COMPLETED"],
      ["failed", "FAILED"],
      // The run did not decide its own outcome — the same distinction the service substrate's
      // terminate produces.
      ["orphaned", "TERMINATED"],
      ["running", "RUNNING"],
    ];
    for (const [status, expected] of cases) {
      const got = await run(
        Effect.flatMap(WorkflowInvoker, (i) => i.getStatus("x")),
        { x: { status } },
      );
      expect(got.runtimeStatus, `wf status ${status}`).toBe(expected);
    }
  });

  it("reads a missing row as UNKNOWN — never a guess in either direction", async () => {
    // RUNNING would pin a cron forever; COMPLETED would let it double-fire. UNKNOWN hands it to
    // the engines' streak machinery, which is built for exactly this.
    const got = await run(Effect.flatMap(WorkflowInvoker, (i) => i.getStatus("never-ran")));
    expect(got.runtimeStatus).toBe("UNKNOWN");
  });

  it("ages a STALE running row into UNKNOWN, so a dead run cannot pin a cron forever", async () => {
    // The divergence from the service substrate, and the reason for it: the row is written BY THE
    // RUN, so a killed run leaves `running` behind and cannot correct it. Dapr observes from
    // outside and would say TERMINATED.
    const fresh = await run(
      Effect.flatMap(WorkflowInvoker, (i) => i.getStatus("x")),
      { x: { status: "running", updatedAt: iso(60_000) } },
    );
    expect(fresh.runtimeStatus).toBe("RUNNING");

    const stale = await run(
      Effect.flatMap(WorkflowInvoker, (i) => i.getStatus("x")),
      { x: { status: "running", updatedAt: iso(31 * 60_000) } },
    );
    expect(stale.runtimeStatus).toBe("UNKNOWN");
  });

  it("treats an unparseable timestamp as stale rather than as live", async () => {
    // Fail toward the escape hatch: a re-fire is recoverable, a permanently pinned cron is not.
    const got = await run(
      Effect.flatMap(WorkflowInvoker, (i) => i.getStatus("x")),
      { x: { status: "running", updatedAt: "not-a-date" } },
    );
    expect(got.runtimeStatus).toBe("UNKNOWN");
  });

  it("returns the run's output alongside its status", async () => {
    // What makes the row a status SOURCE and not an audit trail: a chain captures from this.
    const got = await run(
      Effect.flatMap(WorkflowInvoker, (i) => i.getStatus("x")),
      { x: { status: "done", output: '{"s":{"structured":{"answer":"42"}}}' } },
    );
    expect(got.output).toContain("42");
  });
});

describe("invoke", () => {
  it("publishes a PRE-COMPOSED descriptor keyed by the instance id", async () => {
    const { publisher, sent } = recordingPublisher();
    await run(
      Effect.flatMap(WorkflowInvoker, (i) =>
        i.invoke({
          steps: [{ activity: "run-claude" }],
          params: { slug: "x" },
          instanceId: "feature-x",
          wf: { repo: "o/r", slug: "x", workflow: "implement-pr" },
        }),
      ),
      {},
      publisher,
    );

    // `steps`, not `template`: the engine host decides and emits descriptors; composing is the
    // relay's job, exactly as workflow-svc fires at agent services rather than rendering charts.
    expect(sent[0]).toMatchObject({
      steps: [{ activity: "run-claude" }],
      group: "feature-x",
      instanceId: "feature-x",
      wf: { repo: "o/r" },
      maxSteps: 1,
    });
    expect(sent[0]?.template).toBeUndefined();
  });
});

describe("terminate", () => {
  it("ASKS the relay holding the run, on a control subject keyed by the instance", async () => {
    const recorder = recordingPublisher();
    await run(
      Effect.flatMap(WorkflowInvoker, (i) => i.terminate("feature-x")),
      {},
      recorder.publisher,
    );

    // The engine host owns no running process — it asks whichever process does. Core NATS, so a
    // terminate for a run that already finished simply lands nowhere.
    expect(recorder.control[0]?.subject).toBe("h.control.terminate.feature-x");
    expect(recorder.control[0]?.data).toMatchObject({ instanceId: "feature-x" });
  });

  it("does not fire a task descriptor — terminating is not a fire", async () => {
    const recorder = recordingPublisher();
    await run(
      Effect.flatMap(WorkflowInvoker, (i) => i.terminate("feature-x")),
      {},
      recorder.publisher,
    );
    expect(recorder.sent).toHaveLength(0);
  });
});
