import type { FastifyInstance } from "fastify";
import { withAmbientParent, withServerSpan } from "telemetry";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect, ManagedRuntime, Option, Schema } from "effect";
import type { ConfigError } from "effect";

import { ObservabilityService } from "../../domain/ports/IObservabilityService.ts";

/** The app's compiled runtime, as the routes need it: tool effects yield the observability port. */
export type ObsMcpRuntime = ManagedRuntime.ManagedRuntime<
  ObservabilityService,
  ConfigError.ConfigError
>;

// Tool input contracts. Field descriptions are byte-for-byte the ones published in the
// hand-written inputSchema literals below — the literals stay the wire source of truth
// because JSONSchema.make(Struct) does not round-trip them faithfully (it adds `$schema`,
// an empty `required: []`, and `additionalProperties: false`, all wire changes an MCP
// client could observe). Keep a Struct and its literal in sync when editing either.
const TraceSearchInput = Schema.Struct({
  service: Schema.optional(Schema.String.annotations({ description: "Service name to filter by" })),
  name: Schema.optional(Schema.String.annotations({ description: "Span name to match" })),
  lookbackMs: Schema.optional(
    Schema.Number.annotations({ description: "How far back to search (default 3600000)" }),
  ),
  limit: Schema.optional(Schema.Number.annotations({ description: "Max traces (default 10)" })),
});

const TraceGetInput = Schema.Struct({
  traceId: Schema.String,
});

const LogsQueryInput = Schema.Struct({
  selector: Schema.String.annotations({ description: "LogQL selector" }),
  lookbackMs: Schema.optional(
    Schema.Number.annotations({ description: "How far back (default 3600000)" }),
  ),
  limit: Schema.optional(Schema.Number.annotations({ description: "Max lines (default 100)" })),
});

const RunsListInput = Schema.Struct({
  limit: Schema.optional(Schema.Number.annotations({ description: "Max runs (default 20)" })),
  agentId: Schema.optional(Schema.String.annotations({ description: "Filter by agent id" })),
  status: Schema.optional(
    Schema.String.annotations({ description: "Filter by status (completed/failed)" }),
  ),
  instanceId: Schema.optional(
    Schema.String.annotations({ description: "Filter by workflow instance id (group key)" }),
  ),
});

const RunGetInput = Schema.Struct({
  runId: Schema.String.annotations({ description: "Run id (group:agentId:ts)" }),
});

const SystemOverviewInput = Schema.Struct({});

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

const errorResult = (error: unknown): ToolResult => ({
  content: [
    {
      type: "text" as const,
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
    },
  ],
  isError: true,
});

/**
 * One Effect per tool: decode args → yield the port → format a ToolResult. Undefined for an
 * unknown tool (a protocol-level McpError, not a tool failure).
 *
 * The error edge: a decode `ParseError`, a domain `ObservabilityError`, or a defect becomes a
 * `{ isError: true }` ToolResult — the effect never rejects (an uncaught failure would degrade
 * into an untagged JSON-RPC InternalError via the SDK's catch-all). Tolerated-missing data never
 * reaches this edge: the port returns empty results / `Option.none`, published as structured
 * empty results exactly as before.
 */
export function toolEffect(
  name: string,
  args: unknown,
): Effect.Effect<ToolResult, never, ObservabilityService> | undefined {
  const effect = (() => {
    switch (name) {
      case "trace_search":
        return Effect.gen(function* () {
          const input = yield* Schema.decodeUnknown(TraceSearchInput)(args);
          const obs = yield* ObservabilityService;
          return text(yield* obs.traceSearch(input));
        });
      case "trace_get":
        return Effect.gen(function* () {
          const input = yield* Schema.decodeUnknown(TraceGetInput)(args);
          const obs = yield* ObservabilityService;
          // A missing trace stays the structured `null` result of the legacy wire, not isError.
          return text(Option.getOrNull(yield* obs.traceGet(input.traceId)));
        });
      case "logs_query":
        return Effect.gen(function* () {
          const input = yield* Schema.decodeUnknown(LogsQueryInput)(args);
          const obs = yield* ObservabilityService;
          return text(yield* obs.logsQuery(input));
        });
      case "runs_list":
        return Effect.gen(function* () {
          const input = yield* Schema.decodeUnknown(RunsListInput)(args);
          const obs = yield* ObservabilityService;
          return text(yield* obs.runsList(input));
        });
      case "run_get":
        return Effect.gen(function* () {
          const input = yield* Schema.decodeUnknown(RunGetInput)(args);
          const obs = yield* ObservabilityService;
          const detail = yield* obs.runGet(input.runId);
          return text({
            summary: Option.getOrNull(detail.summary),
            output: Option.getOrNull(detail.output),
            events: detail.events,
          });
        });
      case "system_overview":
        return Effect.gen(function* () {
          yield* Schema.decodeUnknown(SystemOverviewInput)(args);
          const obs = yield* ObservabilityService;
          return text(yield* obs.systemOverview());
        });
      default:
        return undefined;
    }
  })();
  return effect?.pipe(
    Effect.catchAll((error) => Effect.succeed(errorResult(error))),
    Effect.catchAllDefect((defect) => Effect.succeed(errorResult(defect))),
  );
}

function createServer(runtime: ObsMcpRuntime): Server {
  const server = new Server({ name: "obs-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "trace_search",
        description:
          "Search Zipkin for recent traces. Filter by service and/or span name (e.g. a workflow instanceId). Returns compact per-trace summaries.",
        inputSchema: {
          type: "object" as const,
          properties: {
            service: { type: "string", description: "Service name to filter by" },
            name: { type: "string", description: "Span name to match" },
            lookbackMs: { type: "number", description: "How far back to search (default 3600000)" },
            limit: { type: "number", description: "Max traces (default 10)" },
          },
        },
      },
      {
        name: "trace_get",
        description: "Fetch the full span tree for a trace id from Zipkin",
        inputSchema: {
          type: "object" as const,
          properties: { traceId: { type: "string" } },
          required: ["traceId"],
        },
      },
      {
        name: "logs_query",
        description:
          'Query Loki logs with a LogQL selector, e.g. {service="redis"} or {container="scheduler"} |= "error". Note: only dockerized infra logs are in Loki; host-run app logs are not.',
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "LogQL selector" },
            lookbackMs: { type: "number", description: "How far back (default 3600000)" },
            limit: { type: "number", description: "Max lines (default 100)" },
          },
          required: ["selector"],
        },
      },
      {
        name: "runs_list",
        description:
          "List recent agent runs from the run ledger (most recent first). Each run records status, model, turns, tokens, cost, tool calls and sessionId.",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: { type: "number", description: "Max runs (default 20)" },
            agentId: { type: "string", description: "Filter by agent id" },
            status: { type: "string", description: "Filter by status (completed/failed)" },
            instanceId: {
              type: "string",
              description: "Filter by workflow instance id (group key)",
            },
          },
        },
      },
      {
        name: "run_get",
        description:
          "Fetch one run's full detail from the ledger: summary, final output, and the event stream.",
        inputSchema: {
          type: "object" as const,
          properties: { runId: { type: "string", description: "Run id (group:agentId:ts)" } },
          required: ["runId"],
        },
      },
      {
        name: "system_overview",
        description:
          "A quick health snapshot: services reporting traces, plus the most recent agent runs.",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const effect = toolEffect(name, args ?? {});
    if (!effect) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    // withAmbientParent at the fiber entry: parents the tool fiber under the ambient
    // "mcp tool call" server span (established by the withServerSpan wrapper below), which
    // fiber continuations would otherwise escape.
    return runtime.runPromise(withAmbientParent(effect));
  });

  return server;
}

export async function registerMcpRoutes(
  fastify: FastifyInstance,
  runtime: ObsMcpRuntime,
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
    await withServerSpan("mcp tool call", req.headers, () =>
      session.transport.handlePostMessage(req.raw, reply.raw, req.body),
    );
  });

  fastify.get("/dapr/subscribe", async (_req, reply) => {
    return reply.send([]);
  });
}
