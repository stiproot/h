import { WorkflowError } from "core";
import { Effect, JSONSchema, Layer, Option } from "effect";
import type { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  SaveWorkflowRequest,
  WorkflowRequest,
  WorkflowService,
} from "../../domain/ports/IWorkflowService.ts";
import {
  AwaitWorkflowInput,
  GetWorkflowInput,
  GetWorkflowStatusInput,
  RunSavedWorkflowInput,
  TOOL_DEFINITIONS,
  toolHandlers,
} from "./mcp.router.ts";

// ---------------------------------------------------------------------------------------------
// Schema drift guard: the published inputSchema literals are hand-written (deriving them via
// JSONSchema.make would change the wire shape — see the comment on TOOL_DEFINITIONS), so this
// suite pins the two sources together: every description and required field in a published
// literal must match what the annotated Struct generates.
// ---------------------------------------------------------------------------------------------

type ObjectSchema = {
  properties?: Record<string, { description?: string; items?: ObjectSchema }>;
  required?: string[];
};

const generatedFor = (schema: Schema.Schema.AnyNoContext): ObjectSchema =>
  JSONSchema.make(schema) as ObjectSchema;

const publishedFor = (toolName: string): ObjectSchema => {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === toolName);
  expect(tool, `published tool ${toolName}`).toBeDefined();
  return tool!.inputSchema as unknown as ObjectSchema;
};

// Assert the literal's descriptions and required list agree with the generated schema.
function expectAligned(published: ObjectSchema, generated: ObjectSchema): void {
  expect([...(published.required ?? [])].sort()).toEqual([...(generated.required ?? [])].sort());
  for (const [field, publishedProp] of Object.entries(published.properties ?? {})) {
    const generatedProp = generated.properties?.[field];
    expect(generatedProp, `struct is missing published field '${field}'`).toBeDefined();
    if (publishedProp.description !== undefined) {
      expect(generatedProp!.description, `description of '${field}'`).toBe(
        publishedProp.description,
      );
    }
  }
}

describe("published inputSchema stays aligned with the annotated Structs", () => {
  it("save_workflow", () => {
    const published = publishedFor("save_workflow");
    const generated = generatedFor(SaveWorkflowRequest);
    expectAligned(published, generated);
    // The step shape's required fields, published on the array items.
    const publishedItems = published.properties?.steps?.items;
    const generatedItems = generated.properties?.steps?.items;
    expect([...(publishedItems?.required ?? [])].sort()).toEqual(
      [...(generatedItems?.required ?? [])].sort(),
    );
  });

  it("run_workflow", () => {
    const published = publishedFor("run_workflow");
    const generated = generatedFor(WorkflowRequest);
    expectAligned(published, generated);
    expect(published.required).toEqual(["steps"]); // instanceId stays optional
  });

  it("run_saved_workflow", () => {
    expectAligned(publishedFor("run_saved_workflow"), generatedFor(RunSavedWorkflowInput));
  });

  it("get_workflow", () => {
    expectAligned(publishedFor("get_workflow"), generatedFor(GetWorkflowInput));
  });

  it("get_workflow_status", () => {
    expectAligned(publishedFor("get_workflow_status"), generatedFor(GetWorkflowStatusInput));
  });

  it("await_workflow", () => {
    expectAligned(publishedFor("await_workflow"), generatedFor(AwaitWorkflowInput));
  });

  it("every published tool has a handler and vice versa", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(Object.keys(toolHandlers).sort());
  });
});

// ---------------------------------------------------------------------------------------------
// The MCP error edge: an E-channel failure must become an { isError: true } ToolResult, never a
// rejection (an uncaught failure degrades into an untagged JSON-RPC InternalError).
// ---------------------------------------------------------------------------------------------

const boom = (instanceId: string) =>
  Effect.fail(
    new WorkflowError({ cause: new Error("Workflow service error 500: boom"), instanceId }),
  );

const failingService = Layer.succeed(WorkflowService, {
  save: (req) => boom(req.key),
  run: () => boom(""),
  runByKey: (key) => boom(key),
  list: () => boom(""),
  getByKey: (key) => boom(key),
  getStatus: (instanceId) => boom(instanceId),
});

const stubService = Layer.succeed(WorkflowService, {
  save: (req) => Effect.succeed({ key: req.key }),
  run: () => Effect.succeed({ instanceId: "wf-1" }),
  runByKey: () => Effect.succeed({ instanceId: "wf-1" }),
  list: () => Effect.succeed({ keys: ["a", "b"] }),
  getByKey: () => Effect.succeedNone,
  getStatus: (instanceId) => Effect.succeed({ instanceId, runtimeStatus: "RUNNING" }),
});

describe("tool error edge", () => {
  it("a failing service becomes an isError ToolResult, not a rejection", async () => {
    const result = await Effect.runPromise(
      toolHandlers["save_workflow"]!({ key: "k", steps: [{ activity: "a", input: {} }] }).pipe(
        Effect.provide(failingService),
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Workflow service error 500: boom");
  });

  it("a malformed input becomes an isError ToolResult (ParseError edge)", async () => {
    const result = await Effect.runPromise(
      toolHandlers["save_workflow"]!({ steps: "not-an-array" }).pipe(Effect.provide(stubService)),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Invalid save_workflow input");
  });

  it("every tool catches its service failure into an isError ToolResult", async () => {
    const args: Record<string, unknown> = {
      save_workflow: { key: "k", steps: [] },
      run_workflow: { steps: [] },
      run_saved_workflow: { key: "k" },
      list_workflows: {},
      get_workflow: { key: "k" },
      get_workflow_status: { instanceId: "wf-1" },
      await_workflow: { instanceId: "wf-1" },
    };
    for (const [name, handler] of Object.entries(toolHandlers)) {
      const result = await Effect.runPromise(
        handler(args[name]).pipe(Effect.provide(failingService)),
      );
      expect(result.isError, `${name} must catch into isError`).toBe(true);
    }
  });
});

describe("behaviour preservation", () => {
  it("get_workflow renders a missing workflow as the literal 'null' text", async () => {
    const result = await Effect.runPromise(
      toolHandlers["get_workflow"]!({ key: "nope" }).pipe(Effect.provide(stubService)),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("null");
  });

  it("save_workflow passes excess fields (schedule/workspaceId) through the decode", async () => {
    let seen: unknown;
    const capture = Layer.succeed(WorkflowService, {
      save: (req) => {
        seen = req;
        return Effect.succeed({ key: req.key });
      },
      run: () => Effect.succeed({ instanceId: "wf-1" }),
      runByKey: () => Effect.succeed({ instanceId: "wf-1" }),
      list: () => Effect.succeed({ keys: [] }),
      getByKey: () => Effect.succeedNone,
      getStatus: (instanceId) => Effect.succeed({ instanceId, runtimeStatus: "UNKNOWN" }),
    });
    await Effect.runPromise(
      toolHandlers["save_workflow"]!({
        key: "k",
        steps: [{ activity: "a", input: {} }],
        schedule: "0 * * * *",
        workspaceId: "ws-1",
      }).pipe(Effect.provide(capture)),
    );
    expect(seen).toMatchObject({ key: "k", schedule: "0 * * * *", workspaceId: "ws-1" });
  });

  it("get_workflow_status returns the stubbed status verbatim", async () => {
    const result = await Effect.runPromise(
      toolHandlers["get_workflow_status"]!({ instanceId: "wf-1" }).pipe(
        Effect.provide(stubService),
      ),
    );
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      instanceId: "wf-1",
      runtimeStatus: "RUNNING",
    });
  });

  it("await_workflow returns a terminal status immediately, without polling", async () => {
    const completed = Layer.succeed(WorkflowService, {
      save: (req) => Effect.succeed({ key: req.key }),
      run: () => Effect.succeed({ instanceId: "wf-1" }),
      runByKey: () => Effect.succeed({ instanceId: "wf-1" }),
      list: () => Effect.succeed({ keys: [] }),
      getByKey: () => Effect.succeedNone,
      getStatus: (instanceId) =>
        Effect.succeed({ instanceId, runtimeStatus: "COMPLETED", output: "done" }),
    });
    const result = await Effect.runPromise(
      toolHandlers["await_workflow"]!({ instanceId: "wf-1" }).pipe(Effect.provide(completed)),
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      instanceId: "wf-1",
      runtimeStatus: "COMPLETED",
      output: "done",
    });
  });

  it("get_workflow returns Option.some payloads as plain JSON", async () => {
    const withWorkflow = Layer.succeed(WorkflowService, {
      save: (req) => Effect.succeed({ key: req.key }),
      run: () => Effect.succeed({ instanceId: "wf-1" }),
      runByKey: () => Effect.succeed({ instanceId: "wf-1" }),
      list: () => Effect.succeed({ keys: [] }),
      getByKey: () => Effect.succeed(Option.some({ steps: [{ activity: "a", input: {} }] })),
      getStatus: (instanceId) => Effect.succeed({ instanceId, runtimeStatus: "UNKNOWN" }),
    });
    const result = await Effect.runPromise(
      toolHandlers["get_workflow"]!({ key: "k" }).pipe(Effect.provide(withWorkflow)),
    );
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      steps: [{ activity: "a", input: {} }],
    });
  });
});
