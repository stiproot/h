import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  StoredWorkflow,
  Trigger,
  WorkflowRequest,
  deriveInstanceId,
  toRequest,
} from "./workflow.model.ts";

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

describe("Trigger (the fire descriptor)", () => {
  it("decodes the full core and its degenerate {key, params} trigger-event form", async () => {
    const full = {
      key: "feature-pr",
      params: { slug: "s" },
      instanceId: "feature-x",
      workspaceId: "ws",
      watch: { maxDurationMs: 1000 },
    };
    expect(await Effect.runPromise(Schema.decodeUnknown(Trigger)(full))).toEqual(full);
    const degenerate = { key: "improve-plugin", params: { finding: "f" } };
    expect(await Effect.runPromise(Schema.decodeUnknown(Trigger)(degenerate))).toEqual(degenerate);
  });

  it("a WorkflowRequest embeds the descriptor flattened — same wire, key rides as provenance", async () => {
    const wire = {
      key: "review-pr",
      steps: [{ activity: "run-claude" }],
      params: { pr: "7" },
      instanceId: "review-x",
      watch: { maxDurationMs: 1000 },
      fresh: true,
    };
    const decoded = await Effect.runPromise(Schema.decodeUnknown(WorkflowRequest)(wire));
    expect(decoded).toEqual(wire);
  });
});

describe("deriveInstanceId", () => {
  it("derives <base>-<yymmdd>-<hhmmss> in UTC", () => {
    expect(deriveInstanceId("feature-pr", Date.parse("2026-07-31T09:05:42.123Z"))).toBe(
      "feature-pr-260731-090542",
    );
  });

  it("sanitizes the base to id-safe chars and falls back to 'run'", () => {
    const at = Date.parse("2026-07-31T09:05:42Z");
    expect(deriveInstanceId("owner/repo review", at)).toBe("owner-repo-review-260731-090542");
    expect(deriveInstanceId("", at)).toBe("run-260731-090542");
    expect(deriveInstanceId("///", at)).toBe("run-260731-090542");
  });
});
