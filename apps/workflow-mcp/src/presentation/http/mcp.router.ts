import type { FastifyInstance } from "fastify";
import type { WorkflowError } from "core";
import { Duration, Effect, Option, Schema } from "effect";
import type { ManagedRuntime, ParseResult } from "effect";
import { withAmbientParent, withServerSpan } from "telemetry";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import {
  SaveWorkflowRequest,
  WorkflowParams,
  WorkflowRequest,
  WorkflowService,
} from "../../domain/ports/IWorkflowService.ts";

/** The runtime the tool effects run through: one shared ManagedRuntime built in index.ts. */
export type McpToolRuntime = ManagedRuntime.ManagedRuntime<WorkflowService, never>;

// Per-tool input Structs for the single-field tools. `save_workflow` / `run_workflow` reuse the
// port's SaveWorkflowRequest / WorkflowRequest, whose annotations carry those tools' published
// descriptions. Exported (with TOOL_DEFINITIONS) for the schema-drift test.
export const RunSavedWorkflowInput = Schema.Struct({
  key: Schema.String.annotations({ description: "Key of the saved workflow to run" }),
  params: Schema.optional(
    WorkflowParams.annotations({
      description:
        "Fire-time parameter values; they override the saved workflow's default params key-by-key.",
    }),
  ),
  instanceId: Schema.optional(
    Schema.String.annotations({
      description:
        "Optional stable, readable workflow instance id for this run (e.g. 'feature-dark-mode'); it becomes the run's worktree/workspace name instead of a generated GUID.",
    }),
  ),
  workspaceId: Schema.optional(
    Schema.String.annotations({
      description:
        "Optional stable workspace key: every step targets the same reusable agent workspace dir instead of a per-run one.",
    }),
  ),
  fresh: Schema.optional(
    Schema.Boolean.annotations({
      description:
        "Opt-in re-run: purge a FINISHED instance under the given instanceId and run it again. Default (false) attaches to the existing instance without re-running.",
    }),
  ),
});
export const TerminateWorkflowInput = Schema.Struct({
  instanceId: Schema.String.annotations({
    description: "Instance ID of the running workflow to terminate",
  }),
});
export const GetWorkflowInput = Schema.Struct({
  key: Schema.String.annotations({ description: "Key of the saved workflow to fetch" }),
});
export const GetWorkflowStatusInput = Schema.Struct({
  instanceId: Schema.String.annotations({
    description: "Instance ID returned when the workflow was run",
  }),
});
// await_workflow takes the same single instanceId as get_workflow_status; the poll cadence and
// wait budget are server-side (env-overridable) rather than model-controlled — matching the
// helper this promotes out of workflow-agent so every MCP client (JS + Python) shares it.
export const AwaitWorkflowInput = Schema.Struct({
  instanceId: Schema.String.annotations({
    description: "Instance ID returned when the workflow was run",
  }),
});

// Terminal runtimeStatus values that stop the await poll. Anything else (RUNNING/PENDING/…) keeps
// waiting until the budget elapses, at which point await returns runtimeStatus "TIMEOUT" so the
// caller can re-await with the same instanceId (the contract the orchestrator prompt relies on).
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "TERMINATED"]);
const AWAIT_MAX_WAIT_MS = Number(process.env.WORKFLOW_AWAIT_MAX_WAIT_MS ?? 900_000);
const AWAIT_POLL_INTERVAL_MS = Number(process.env.WORKFLOW_AWAIT_POLL_INTERVAL_MS ?? 5_000);

// The published tool list — a wire artifact the model reads, kept byte-identical to the
// pre-Effect server. Deliberate duplication: deriving it from the annotated Structs via
// JSONSchema.make would change the wire shape materially (`additionalProperties: false` on every
// object, a draft-07 `$schema` key, `anyOf` for the empty struct, and record-of-unknown noise on
// step `input`), so the hand-written literals stay and mcp.router.test.ts guards the two sources
// against drifting apart (descriptions + required fields must match the Structs).
export const TOOL_DEFINITIONS = [
  {
    name: "save_workflow",
    description: "Save a reusable workflow definition under a key for later invocation",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Unique identifier for the workflow" },
        steps: {
          type: "array",
          description: "Ordered list of step definitions",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              activity: { type: "string" },
              input: { type: "object" },
            },
            required: ["activity", "input"],
          },
        },
        params: {
          type: "object",
          description:
            "Default parameter values for this saved workflow; run_saved_workflow params override them key-by-key.",
        },
      },
      required: ["key", "steps"],
    },
  },
  {
    name: "run_workflow",
    description: "Run a workflow inline with the provided step definitions",
    inputSchema: {
      type: "object" as const,
      properties: {
        instanceId: {
          type: "string",
          description:
            "Optional stable, readable workflow instance id (e.g. 'triage-ABC-123'). It becomes the run's worktree/workspace name. Re-running with the same id attaches to the existing instance (running or finished) instead of starting a new one; pass fresh=true to purge a finished instance and re-run.",
        },
        steps: {
          type: "array",
          description: "Ordered list of step definitions",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              activity: { type: "string" },
              input: { type: "object" },
            },
            required: ["activity", "input"],
          },
        },
        params: {
          type: "object",
          description:
            'Named parameters resolved into step inputs: reference them as {{params.x}} inside a string, or {"$ref": "params.x"} for a whole value.',
        },
        fresh: {
          type: "boolean",
          description:
            "Opt-in re-run: purge a FINISHED instance under the given instanceId and run it again. Default (false) attaches to the existing instance without re-running.",
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "run_saved_workflow",
    description: "Run a previously saved workflow by its key",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Key of the saved workflow to run" },
        params: {
          type: "object",
          description:
            "Fire-time parameter values; they override the saved workflow's default params key-by-key.",
        },
        instanceId: {
          type: "string",
          description:
            "Optional stable, readable workflow instance id for this run (e.g. 'feature-dark-mode'); it becomes the run's worktree/workspace name instead of a generated GUID.",
        },
        workspaceId: {
          type: "string",
          description:
            "Optional stable workspace key: every step targets the same reusable agent workspace dir instead of a per-run one.",
        },
        fresh: {
          type: "boolean",
          description:
            "Opt-in re-run: purge a FINISHED instance under the given instanceId and run it again. Default (false) attaches to the existing instance without re-running.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "terminate_workflow",
    description:
      "Terminate a running workflow instance (it reaches runtimeStatus TERMINATED). Use to short-circuit a run that is stuck, spinning, or no longer needed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        instanceId: {
          type: "string",
          description: "Instance ID of the running workflow to terminate",
        },
      },
      required: ["instanceId"],
    },
  },
  {
    name: "list_workflows",
    description: "List the keys of all persisted workflows, to check whether one already exists",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_workflow",
    description: "Fetch a persisted workflow definition by its key (null if it does not exist)",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Key of the saved workflow to fetch" },
      },
      required: ["key"],
    },
  },
  {
    name: "get_workflow_status",
    description:
      "Get the execution status of a workflow instance (runtimeStatus: RUNNING/COMPLETED/FAILED/TERMINATED, plus output when complete)",
    inputSchema: {
      type: "object" as const,
      properties: {
        instanceId: {
          type: "string",
          description: "Instance ID returned when the workflow was run",
        },
      },
      required: ["instanceId"],
    },
  },
  {
    name: "await_workflow",
    description:
      "Block until a running workflow instance reaches a terminal state (COMPLETED / FAILED / TERMINATED) and return its final runtimeStatus and output. Call this once after run_workflow or run_saved_workflow, passing the returned instanceId — do not poll get_workflow_status in a loop yourself. If the wait budget elapses while the run is still going it returns runtimeStatus 'TIMEOUT'; call it again with the same instanceId to keep waiting.",
    inputSchema: {
      type: "object" as const,
      properties: {
        instanceId: {
          type: "string",
          description: "Instance ID returned when the workflow was run",
        },
      },
      required: ["instanceId"],
    },
  },
];

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const jsonResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const errorResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

// The MCP error edge — distinct from an HTTP runHandler, structurally: the /messages reply is
// hijacked (the SSE transport answers 202 and results travel the stream), so there is no status
// code to map tags onto. A decode failure or a WorkflowService failure becomes an
// `{ isError: true }` ToolResult on the result stream; an uncaught E-channel failure would
// degrade into an untagged JSON-RPC InternalError via the SDK's catch-all.
const catchToolErrors =
  (toolName: string) =>
  <R>(
    effect: Effect.Effect<ToolResult, ParseResult.ParseError | WorkflowError, R>,
  ): Effect.Effect<ToolResult, never, R> =>
    effect.pipe(
      Effect.catchTags({
        ParseError: (e) => Effect.succeed(errorResult(`Invalid ${toolName} input: ${e.message}`)),
        WorkflowError: (e) =>
          Effect.succeed(errorResult(e.cause instanceof Error ? e.cause.message : String(e.cause))),
      }),
    );

// Decode tool args preserving excess properties — workflow-svc accepts fields beyond the
// published schema (e.g. schedule/workspaceId/disabled on save) and callers have always been
// able to pass them through; a stripping decode would silently drop them.
const decodePreserving = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknown(schema, { onExcessProperty: "preserve" });

/**
 * The tool-call Effects, keyed by published tool name (exported for tests). Each handler is ONE
 * Effect: decode args against the annotated Struct → yield the WorkflowService port → format the
 * result — with ParseError/WorkflowError caught into ToolResults by catchToolErrors.
 */
export const toolHandlers: Record<
  string,
  (args: unknown) => Effect.Effect<ToolResult, never, WorkflowService>
> = {
  save_workflow: (args) =>
    Effect.gen(function* () {
      const input = yield* decodePreserving(SaveWorkflowRequest)(args);
      const service = yield* WorkflowService;
      return jsonResult(yield* service.save(input));
    }).pipe(catchToolErrors("save_workflow")),

  run_workflow: (args) =>
    Effect.gen(function* () {
      const input = yield* decodePreserving(WorkflowRequest)(args);
      const service = yield* WorkflowService;
      return jsonResult(yield* service.run(input));
    }).pipe(catchToolErrors("run_workflow")),

  run_saved_workflow: (args) =>
    Effect.gen(function* () {
      const input = yield* decodePreserving(RunSavedWorkflowInput)(args);
      const service = yield* WorkflowService;
      return jsonResult(
        yield* service.runByKey(input.key, input.params, {
          instanceId: input.instanceId,
          workspaceId: input.workspaceId,
          fresh: input.fresh,
        }),
      );
    }).pipe(catchToolErrors("run_saved_workflow")),

  terminate_workflow: (args) =>
    Effect.gen(function* () {
      const input = yield* decodePreserving(TerminateWorkflowInput)(args);
      const service = yield* WorkflowService;
      return jsonResult(yield* service.terminate(input.instanceId));
    }).pipe(catchToolErrors("terminate_workflow")),

  list_workflows: () =>
    Effect.gen(function* () {
      const service = yield* WorkflowService;
      return jsonResult(yield* service.list());
    }).pipe(catchToolErrors("list_workflows")),

  get_workflow: (args) =>
    Effect.gen(function* () {
      const input = yield* decodePreserving(GetWorkflowInput)(args);
      const service = yield* WorkflowService;
      const workflow = yield* service.getByKey(input.key);
      // Option.none → the literal "null" text the pre-Effect server produced.
      return jsonResult(Option.getOrNull(workflow));
    }).pipe(catchToolErrors("get_workflow")),

  get_workflow_status: (args) =>
    Effect.gen(function* () {
      const input = yield* decodePreserving(GetWorkflowStatusInput)(args);
      const service = yield* WorkflowService;
      return jsonResult(yield* service.getStatus(input.instanceId));
    }).pipe(catchToolErrors("get_workflow_status")),

  await_workflow: (args) =>
    Effect.gen(function* () {
      const input = yield* decodePreserving(AwaitWorkflowInput)(args);
      const service = yield* WorkflowService;
      // Poll getStatus until terminal or the budget elapses. Recursion via flatMap is stack-safe
      // (Effect trampolines); each getStatus keeps its own client span + invoke timeout.
      const poll = (elapsedMs: number): Effect.Effect<unknown, WorkflowError> =>
        service.getStatus(input.instanceId).pipe(
          Effect.flatMap((status) => {
            if (TERMINAL_STATUSES.has(status.runtimeStatus)) return Effect.succeed(status);
            if (elapsedMs + AWAIT_POLL_INTERVAL_MS > AWAIT_MAX_WAIT_MS) {
              return Effect.succeed({ instanceId: input.instanceId, runtimeStatus: "TIMEOUT" });
            }
            return Effect.sleep(Duration.millis(AWAIT_POLL_INTERVAL_MS)).pipe(
              Effect.flatMap(() => poll(elapsedMs + AWAIT_POLL_INTERVAL_MS)),
            );
          }),
        );
      return jsonResult(
        yield* poll(0).pipe(
          Effect.withSpan("await_workflow", {
            attributes: { "workflow.instance_id": input.instanceId },
          }),
        ),
      );
    }).pipe(catchToolErrors("await_workflow")),
};

function createServer(runtime: McpToolRuntime): Server {
  const server = new Server(
    { name: "workflow-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = toolHandlers[name];
    // Protocol-level failure, not a tool failure: keep the SDK's MethodNotFound mapping.
    if (!handler) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    // withAmbientParent must be applied inline at the run call: it captures the ambient OTel
    // span (the /messages withServerSpan below, still active here) synchronously, so the tool
    // fiber — resumed later on Effect's scheduler — parents under the inbound trace.
    return runtime.runPromise(withAmbientParent(handler(args ?? {})));
  });

  return server;
}

export async function registerMcpRoutes(
  fastify: FastifyInstance,
  runtime: McpToolRuntime,
): Promise<void> {
  const sessions = new Map<string, { transport: SSEServerTransport; server: Server }>();

  fastify.get("/sse", (_req, reply) => {
    reply.hijack();
    const transport = new SSEServerTransport("/messages", reply.raw);
    const server = createServer(runtime);
    sessions.set(transport.sessionId, { transport, server });
    reply.raw.on("close", () => sessions.delete(transport.sessionId));
    server.connect(transport).catch((err: unknown) => {
      console.error("MCP transport error:", err);
    });
  });

  fastify.post<{ Querystring: { sessionId?: string } }>("/messages", async (req, reply) => {
    const { sessionId } = req.query;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      return reply.status(400).send({ error: "Unknown or missing sessionId" });
    }
    reply.hijack();
    // Continue the trace from the inbound traceparent (injected by the MCP client) and keep the
    // span active across handlePostMessage — it awaits the tool handler down to the outbound
    // invoke, so ambient context flows the whole way and the downstream call chains in.
    await withServerSpan("mcp tool call", req.headers, () =>
      session.transport.handlePostMessage(req.raw, reply.raw, req.body),
    );
  });

  fastify.get("/dapr/subscribe", async (_req, reply) => {
    return reply.send([]);
  });
}
