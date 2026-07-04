import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { StoredWorkflow, WorkflowRequest, toRequest } from "./workflow.model.ts";

const decodeStored = Schema.decodeUnknown(StoredWorkflow, { onExcessProperty: "preserve" });

describe("StoredWorkflow schema", () => {
  it("round-trips a full stored workflow including schedule and disabled", async () => {
    const wire = {
      steps: [{ id: "plan", activity: "run-claude", input: { task: "do the thing" } }],
      workspaceId: "ws-1",
      schedule: {
        cron: "0 9 * * *",
        savedAt: "2026-06-23T08:00:00Z",
        lastRunAt: "2026-06-24T09:00:00Z",
      },
      disabled: true,
    };
    const decoded = await Effect.runPromise(decodeStored(wire));
    expect(decoded).toEqual(wire);
  });

  it("preserves excess wire fields at the top level and inside steps", async () => {
    const wire = {
      steps: [{ activity: "setup", input: { setup: [] }, extraStepField: 42 }],
      extraTopLevel: "kept",
    };
    const decoded = await Effect.runPromise(decodeStored(wire));
    expect(decoded).toEqual(wire);
  });

  it("tolerates a step with no input (the workflow spreads it)", async () => {
    const decoded = await Effect.runPromise(decodeStored({ steps: [{ activity: "setup" }] }));
    expect(decoded.steps[0]).toEqual({ activity: "setup" });
  });

  it("rejects a value without steps as a ParseError", async () => {
    const error = await Effect.runPromise(decodeStored({ workspaceId: "ws" }).pipe(Effect.flip));
    // Proxy-wrapped across spans in general: assert the tag, never instance identity.
    expect(error._tag).toBe("ParseError");
  });
});

describe("WorkflowRequest schema", () => {
  it("decodes a minimal run request", async () => {
    const decoded = await Effect.runPromise(Schema.decodeUnknown(WorkflowRequest)({ steps: [] }));
    expect(decoded).toEqual({ steps: [] });
  });

  it("preserves payload fields beyond the schema when asked to", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(WorkflowRequest, { onExcessProperty: "preserve" })({
        steps: [],
        instanceId: "groom-AE-1",
        payload: { issue: "AE-1" },
      }),
    );
    expect(decoded).toEqual({ steps: [], instanceId: "groom-AE-1", payload: { issue: "AE-1" } });
  });
});

describe("toRequest", () => {
  it("projects steps + workspaceId and threads the traceparent", () => {
    const stored: StoredWorkflow = {
      steps: [{ activity: "run-claude", input: { task: "t" } }],
      workspaceId: "ws-1",
      schedule: { cron: "* * * * *", savedAt: "2026-06-23T08:00:00Z" },
    };
    expect(toRequest(stored, "00-abc-def-01")).toEqual({
      steps: stored.steps,
      workspaceId: "ws-1",
      traceparent: "00-abc-def-01",
    });
  });

  it("merges fire-time params over stored defaults key-by-key", () => {
    const stored: StoredWorkflow = {
      steps: [],
      params: { spec: "default", slug: "kept" },
    };
    expect(toRequest(stored, undefined, { spec: "override" }).params).toEqual({
      spec: "override",
      slug: "kept",
    });
  });

  it("leaves params undefined when neither side has any", () => {
    expect(toRequest({ steps: [] }).params).toBeUndefined();
  });

  it("passes fire-time params through when nothing is stored", () => {
    expect(toRequest({ steps: [] }, undefined, { a: 1 }).params).toEqual({ a: 1 });
  });
});
