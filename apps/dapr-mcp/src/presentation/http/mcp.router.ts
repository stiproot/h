import type { FastifyInstance } from "fastify";
import type { DaprActorError, DaprPubSubError } from "core-dapr";
import { Effect, Option, Schema } from "effect";
import type { ManagedRuntime, ParseResult } from "effect";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { ActorStore } from "../../domain/ports/IActorStore.ts";
import { PubSub } from "../../domain/ports/IPubSub.ts";
import { StateStore } from "../../domain/ports/IStateStore.ts";
import type { DaprStateError } from "../../domain/ports/IStateStore.ts";

/** The runtime the tool effects run through: one shared ManagedRuntime built in index.ts. */
export type DaprMcpRuntime = ManagedRuntime.ManagedRuntime<StateStore | ActorStore | PubSub, never>;

const DEFAULT_STORE = "statestore";
const DEFAULT_PUBSUB = "pubsub";

const storeNameProp = {
  storeName: {
    type: "string",
    description: "Dapr state store component name (default: statestore)",
  },
};

const actorIdProp = {
  actorId: {
    type: "string",
    description: 'Actor instance id — an agent-chosen, stable key (e.g. "customer-42")',
  },
};

const durationNote = "ISO-8601 duration (e.g. PT5S, PT1M, PT1H)";

// ---------------------------------------------------------------------------------------------
// Per-tool input Structs, used ONLY to decode tool args. Field descriptions are byte-for-byte
// the ones in the published inputSchema literals below. Exported (with TOOL_DEFINITIONS) for
// the schema-drift test that pins the two sources together.
// ---------------------------------------------------------------------------------------------

const storeNameField = Schema.optional(
  Schema.String.annotations({
    description: "Dapr state store component name (default: statestore)",
  }),
);

const actorIdField = Schema.String.annotations({
  description: 'Actor instance id — an agent-chosen, stable key (e.g. "customer-42")',
});

export const StateGetInput = Schema.Struct({
  key: Schema.String.annotations({ description: "State key" }),
  storeName: storeNameField,
});

export const StateGetBulkInput = Schema.Struct({
  keys: Schema.Array(Schema.String).annotations({ description: "State keys to fetch" }),
  storeName: storeNameField,
});

export const StateSaveInput = Schema.Struct({
  key: Schema.String.annotations({ description: "State key" }),
  value: Schema.Unknown.annotations({ description: "Value to store (any JSON value)" }),
  storeName: storeNameField,
});

export const StateDeleteInput = Schema.Struct({
  key: Schema.String.annotations({ description: "State key" }),
  storeName: storeNameField,
});

export const PubsubPublishInput = Schema.Struct({
  topic: Schema.String.annotations({ description: "Topic name to publish to" }),
  data: Schema.Unknown.annotations({ description: "Message payload (any JSON value)" }),
  pubsubName: Schema.optional(
    Schema.String.annotations({ description: "Dapr pub/sub component name (default: pubsub)" }),
  ),
  metadata: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }).annotations({
      description:
        "Optional Dapr publish metadata, each sent as a metadata.<key> query param " +
        '(e.g. {"cloudevent.type": "run.completed", "ttlInSeconds": "60"})',
    }),
  ),
});

export const ActorInvokeInput = Schema.Struct({
  actorId: actorIdField,
  method: Schema.Literal("record", "increment", "merge", "snapshot", "clear").annotations({
    description: "Built-in command to invoke",
  }),
  payload: Schema.optional(
    Schema.Unknown.annotations({ description: "Command argument (any JSON value)" }),
  ),
});

export const ActorStateGetInput = Schema.Struct({
  actorId: actorIdField,
  key: Schema.String.annotations({ description: "Actor state key" }),
});

export const ActorStateSetInput = Schema.Struct({
  actorId: actorIdField,
  key: Schema.String.annotations({ description: "Actor state key" }),
  value: Schema.Unknown.annotations({ description: "Value to store (any JSON value)" }),
});

export const ActorStateDeleteInput = Schema.Struct({
  actorId: actorIdField,
  key: Schema.String.annotations({ description: "Actor state key" }),
});

export const ActorStateKeysInput = Schema.Struct({
  actorId: actorIdField,
});

export const ActorReminderRegisterInput = Schema.Struct({
  actorId: actorIdField,
  name: Schema.String.annotations({ description: "Reminder name (unique per actor)" }),
  dueTime: Schema.String.annotations({
    description: `Delay before first fire — ${durationNote}`,
  }),
  period: Schema.optional(
    Schema.String.annotations({
      description: `Repeat interval — ${durationNote}. Omit for a one-shot reminder.`,
    }),
  ),
  data: Schema.optional(
    Schema.Unknown.annotations({ description: "Optional JSON payload delivered on each fire" }),
  ),
});

export const ActorReminderUnregisterInput = Schema.Struct({
  actorId: actorIdField,
  name: Schema.String.annotations({ description: "Reminder name" }),
});

export const ActorTimerRegisterInput = Schema.Struct({
  actorId: actorIdField,
  name: Schema.String.annotations({ description: "Timer name (unique per actor)" }),
  dueTime: Schema.String.annotations({
    description: `Delay before first fire — ${durationNote}`,
  }),
  period: Schema.optional(
    Schema.String.annotations({
      description: `Repeat interval — ${durationNote}. Omit for a one-shot timer.`,
    }),
  ),
  data: Schema.optional(
    Schema.Unknown.annotations({ description: "Optional JSON payload delivered on each fire" }),
  ),
});

export const ActorTimerUnregisterInput = Schema.Struct({
  actorId: actorIdField,
  name: Schema.String.annotations({ description: "Timer name" }),
});

export const ActorListActiveInput = Schema.Struct({});

// The published tool list — a wire artifact the model reads, kept byte-identical to the
// pre-Effect server. Deliberate duplication: deriving it from the annotated Structs via
// JSONSchema.make would change the wire shape materially (`additionalProperties: false` and a
// draft-07 `$schema` key on every object, `title: "unknown"` noise on the free-form value/data/
// payload fields), so the hand-written literals stay and mcp.router.test.ts guards the two
// sources against drifting apart (descriptions + required fields must match the Structs).
export const TOOL_DEFINITIONS = [
  {
    name: "state_get",
    description: "Get a single value by key from a Dapr state store (null if absent)",
    inputSchema: {
      type: "object" as const,
      properties: { key: { type: "string", description: "State key" }, ...storeNameProp },
      required: ["key"],
    },
  },
  {
    name: "state_get_bulk",
    description: "Get multiple values by key from a Dapr state store in one call",
    inputSchema: {
      type: "object" as const,
      properties: {
        keys: { type: "array", items: { type: "string" }, description: "State keys to fetch" },
        ...storeNameProp,
      },
      required: ["keys"],
    },
  },
  {
    name: "state_save",
    description: "Save (upsert) a value under a key in a Dapr state store",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "State key" },
        value: { description: "Value to store (any JSON value)" },
        ...storeNameProp,
      },
      required: ["key", "value"],
    },
  },
  {
    name: "state_delete",
    description: "Delete a key from a Dapr state store",
    inputSchema: {
      type: "object" as const,
      properties: { key: { type: "string", description: "State key" }, ...storeNameProp },
      required: ["key"],
    },
  },
  {
    name: "pubsub_publish",
    description:
      "Publish a message to a Dapr pub/sub topic (fire-and-forget). Dapr wraps the data in " +
      "a CloudEvents envelope and delivers it at-least-once to every subscriber of the topic. " +
      "Returns once the broker accepts the message — it does NOT wait for any subscriber to " +
      "handle it, and succeeds even when nothing is subscribed. Override CloudEvents fields " +
      "via metadata keys like 'cloudevent.type'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: { type: "string", description: "Topic name to publish to" },
        data: { description: "Message payload (any JSON value)" },
        pubsubName: {
          type: "string",
          description: "Dapr pub/sub component name (default: pubsub)",
        },
        metadata: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Optional Dapr publish metadata, each sent as a metadata.<key> query param " +
            '(e.g. {"cloudevent.type": "run.completed", "ttlInSeconds": "60"})',
        },
      },
      required: ["topic", "data"],
    },
  },
  {
    name: "actor_invoke",
    description:
      "Invoke a built-in command on a GenericActor instance. Single-threaded per actorId, " +
      "so commands are race-free. Methods: 'record' (append payload to the actor's durable " +
      "log), 'increment' (atomically bump a named counter; payload {name, by?}), 'merge' " +
      "(shallow-merge a payload object into the actor's state), 'snapshot' (return current " +
      "state, counters, and log length without mutating), 'clear' (reset all state).",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...actorIdProp,
        method: {
          type: "string",
          enum: ["record", "increment", "merge", "snapshot", "clear"],
          description: "Built-in command to invoke",
        },
        payload: { description: "Command argument (any JSON value)" },
      },
      required: ["actorId", "method"],
    },
  },
  {
    name: "actor_state_get",
    description:
      "Get a value by key from a GenericActor instance's private durable state " +
      "(returns {key, value, exists}). State is isolated per actorId.",
    inputSchema: {
      type: "object" as const,
      properties: { ...actorIdProp, key: { type: "string", description: "Actor state key" } },
      required: ["actorId", "key"],
    },
  },
  {
    name: "actor_state_set",
    description:
      "Set (upsert) a value under a key in a GenericActor instance's private durable state — " +
      "a per-id scratchpad isolated from other actor ids.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...actorIdProp,
        key: { type: "string", description: "Actor state key" },
        value: { description: "Value to store (any JSON value)" },
      },
      required: ["actorId", "key", "value"],
    },
  },
  {
    name: "actor_state_delete",
    description: "Remove a key from a GenericActor instance's private durable state",
    inputSchema: {
      type: "object" as const,
      properties: { ...actorIdProp, key: { type: "string", description: "Actor state key" } },
      required: ["actorId", "key"],
    },
  },
  {
    name: "actor_state_keys",
    description:
      "List the state keys held by a GenericActor instance (excludes reserved internal keys)",
    inputSchema: {
      type: "object" as const,
      properties: { ...actorIdProp },
      required: ["actorId"],
    },
  },
  {
    name: "actor_reminder_register",
    description:
      "Register a durable reminder on a GenericActor instance. Reminders survive restarts " +
      "and re-activate the actor. When it fires, the actor appends a {kind:'reminder'} entry " +
      "to its durable log (read it via actor_invoke 'snapshot' or actor_state_get '__log__'). " +
      "Re-registering the same name overwrites it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...actorIdProp,
        name: { type: "string", description: "Reminder name (unique per actor)" },
        dueTime: { type: "string", description: `Delay before first fire — ${durationNote}` },
        period: {
          type: "string",
          description: `Repeat interval — ${durationNote}. Omit for a one-shot reminder.`,
        },
        data: { description: "Optional JSON payload delivered on each fire" },
      },
      required: ["actorId", "name", "dueTime"],
    },
  },
  {
    name: "actor_reminder_unregister",
    description: "Cancel a durable reminder by name on a GenericActor instance",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...actorIdProp,
        name: { type: "string", description: "Reminder name" },
      },
      required: ["actorId", "name"],
    },
  },
  {
    name: "actor_timer_register",
    description:
      "Register a non-durable timer on a GenericActor instance. Timers fire only while the " +
      "actor is active and are lost on deactivation/restart (use a reminder for durability). " +
      "When it fires, the actor appends a {kind:'timer'} entry to its durable log.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...actorIdProp,
        name: { type: "string", description: "Timer name (unique per actor)" },
        dueTime: { type: "string", description: `Delay before first fire — ${durationNote}` },
        period: {
          type: "string",
          description: `Repeat interval — ${durationNote}. Omit for a one-shot timer.`,
        },
        data: { description: "Optional JSON payload delivered on each fire" },
      },
      required: ["actorId", "name", "dueTime"],
    },
  },
  {
    name: "actor_timer_unregister",
    description: "Cancel a timer by name on a GenericActor instance",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...actorIdProp,
        name: { type: "string", description: "Timer name" },
      },
      required: ["actorId", "name"],
    },
  },
  {
    name: "actor_list_active",
    description:
      "List actor types currently active on this host and their instance counts (via the " +
      "Dapr metadata API). Dapr has no full per-instance enumeration.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
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

// All three domain tags carry the raw failure in `cause`; surface its message like the
// legacy throw did.
const causeMessage = (e: { readonly cause: unknown }): string =>
  e.cause instanceof Error ? e.cause.message : String(e.cause);

// The MCP error edge — there is no HTTP status to map onto (the /messages reply is hijacked
// and results travel the SSE stream), so a decode failure or a port failure becomes an
// `{ isError: true }` ToolResult; an uncaught E-channel failure would degrade into an
// untagged JSON-RPC InternalError via the SDK's catch-all.
const catchToolErrors =
  (toolName: string) =>
  <R>(
    effect: Effect.Effect<
      ToolResult,
      ParseResult.ParseError | DaprStateError | DaprActorError | DaprPubSubError,
      R
    >,
  ): Effect.Effect<ToolResult, never, R> =>
    effect.pipe(
      Effect.catchTags({
        ParseError: (e) => Effect.succeed(errorResult(`Invalid ${toolName} input: ${e.message}`)),
        DaprStateError: (e) => Effect.succeed(errorResult(causeMessage(e))),
        DaprActorError: (e) => Effect.succeed(errorResult(causeMessage(e))),
        DaprPubSubError: (e) => Effect.succeed(errorResult(causeMessage(e))),
      }),
    );

/**
 * The tool-call Effects, keyed by published tool name (exported for tests). Each handler is
 * ONE Effect: decode args against the annotated Struct → yield the port → format the result —
 * with ParseError and the Dapr domain tags caught into ToolResults by catchToolErrors.
 */
export const toolHandlers: Record<
  string,
  (args: unknown) => Effect.Effect<ToolResult, never, StateStore | ActorStore | PubSub>
> = {
  state_get: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(StateGetInput)(args);
      const state = yield* StateStore;
      const value = yield* state.get(input.storeName ?? DEFAULT_STORE, input.key);
      // Option.none → the literal "null" text the pre-Effect server produced for a missing key.
      return jsonResult(Option.getOrNull(value));
    }).pipe(catchToolErrors("state_get")),

  state_get_bulk: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(StateGetBulkInput)(args);
      const state = yield* StateStore;
      return jsonResult(yield* state.getBulk(input.storeName ?? DEFAULT_STORE, input.keys));
    }).pipe(catchToolErrors("state_get_bulk")),

  state_save: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(StateSaveInput)(args);
      const state = yield* StateStore;
      yield* state.save(input.storeName ?? DEFAULT_STORE, input.key, input.value);
      return jsonResult({ key: input.key });
    }).pipe(catchToolErrors("state_save")),

  state_delete: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(StateDeleteInput)(args);
      const state = yield* StateStore;
      yield* state.delete(input.storeName ?? DEFAULT_STORE, input.key);
      return jsonResult({ key: input.key });
    }).pipe(catchToolErrors("state_delete")),

  pubsub_publish: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(PubsubPublishInput)(args);
      const pubsub = yield* PubSub;
      const pubsubName = input.pubsubName ?? DEFAULT_PUBSUB;
      yield* pubsub.publish(pubsubName, input.topic, input.data, input.metadata);
      return jsonResult({ pubsubName, topic: input.topic, published: true });
    }).pipe(catchToolErrors("pubsub_publish")),

  actor_invoke: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(ActorInvokeInput)(args);
      const actors = yield* ActorStore;
      return jsonResult(yield* actors.invoke(input.actorId, input.method, input.payload));
    }).pipe(catchToolErrors("actor_invoke")),

  actor_state_get: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(ActorStateGetInput)(args);
      const actors = yield* ActorStore;
      return jsonResult(yield* actors.getState(input.actorId, input.key));
    }).pipe(catchToolErrors("actor_state_get")),

  actor_state_set: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(ActorStateSetInput)(args);
      const actors = yield* ActorStore;
      return jsonResult(yield* actors.setState(input.actorId, input.key, input.value));
    }).pipe(catchToolErrors("actor_state_set")),

  actor_state_delete: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(ActorStateDeleteInput)(args);
      const actors = yield* ActorStore;
      return jsonResult(yield* actors.removeState(input.actorId, input.key));
    }).pipe(catchToolErrors("actor_state_delete")),

  actor_state_keys: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(ActorStateKeysInput)(args);
      const actors = yield* ActorStore;
      return jsonResult(yield* actors.listStateKeys(input.actorId));
    }).pipe(catchToolErrors("actor_state_keys")),

  actor_reminder_register: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(ActorReminderRegisterInput)(args);
      const actors = yield* ActorStore;
      yield* actors.registerReminder(
        input.actorId,
        input.name,
        input.dueTime,
        input.period,
        input.data,
      );
      return jsonResult({ actorId: input.actorId, reminder: input.name, registered: true });
    }).pipe(catchToolErrors("actor_reminder_register")),

  actor_reminder_unregister: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(ActorReminderUnregisterInput)(args);
      const actors = yield* ActorStore;
      yield* actors.unregisterReminder(input.actorId, input.name);
      return jsonResult({ actorId: input.actorId, reminder: input.name, unregistered: true });
    }).pipe(catchToolErrors("actor_reminder_unregister")),

  actor_timer_register: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(ActorTimerRegisterInput)(args);
      const actors = yield* ActorStore;
      yield* actors.registerTimer(
        input.actorId,
        input.name,
        input.dueTime,
        input.period,
        input.data,
      );
      return jsonResult({ actorId: input.actorId, timer: input.name, registered: true });
    }).pipe(catchToolErrors("actor_timer_register")),

  actor_timer_unregister: (args) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknown(ActorTimerUnregisterInput)(args);
      const actors = yield* ActorStore;
      yield* actors.unregisterTimer(input.actorId, input.name);
      return jsonResult({ actorId: input.actorId, timer: input.name, unregistered: true });
    }).pipe(catchToolErrors("actor_timer_unregister")),

  actor_list_active: (args) =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknown(ActorListActiveInput)(args);
      const actors = yield* ActorStore;
      return jsonResult(yield* actors.listActiveActors());
    }).pipe(catchToolErrors("actor_list_active")),
};

function createServer(runtime: DaprMcpRuntime): Server {
  const server = new Server(
    { name: "dapr-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = toolHandlers[name];
    // Protocol-level failure, not a tool failure: keep the SDK's MethodNotFound mapping.
    if (!handler) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    return runtime.runPromise(handler(args ?? {}));
  });

  return server;
}

export async function registerMcpRoutes(
  fastify: FastifyInstance,
  runtime: DaprMcpRuntime,
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
    await session.transport.handlePostMessage(req.raw, reply.raw, req.body);
  });

  fastify.get("/dapr/subscribe", async (_req, reply) => {
    return reply.send([]);
  });
}
