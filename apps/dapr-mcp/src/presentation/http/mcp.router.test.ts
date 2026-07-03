import { DaprActorError, DaprPubSubError } from "core-dapr";
import { Effect, JSONSchema, Layer } from "effect";
import type { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ActorStore } from "../../domain/ports/IActorStore.ts";
import { PubSub } from "../../domain/ports/IPubSub.ts";
import { DaprStateError, StateStore } from "../../domain/ports/IStateStore.ts";
import {
  ActorInvokeInput,
  ActorListActiveInput,
  ActorReminderRegisterInput,
  ActorReminderUnregisterInput,
  ActorStateDeleteInput,
  ActorStateGetInput,
  ActorStateKeysInput,
  ActorStateSetInput,
  ActorTimerRegisterInput,
  ActorTimerUnregisterInput,
  PubsubPublishInput,
  StateDeleteInput,
  StateGetBulkInput,
  StateGetInput,
  StateSaveInput,
  TOOL_DEFINITIONS,
  toolHandlers,
} from "./mcp.router.ts";

// ---------------------------------------------------------------------------------------------
// Schema drift guard: the published inputSchema literals are hand-written (deriving them via
// JSONSchema.make would change the wire shape — see the comment on TOOL_DEFINITIONS), so this
// suite pins the two sources together: every description and required field in a published
// literal must match what the annotated Struct generates.
// ---------------------------------------------------------------------------------------------

const decodeStructFor: Record<string, Schema.Schema.AnyNoContext> = {
  state_get: StateGetInput,
  state_get_bulk: StateGetBulkInput,
  state_save: StateSaveInput,
  state_delete: StateDeleteInput,
  pubsub_publish: PubsubPublishInput,
  actor_invoke: ActorInvokeInput,
  actor_state_get: ActorStateGetInput,
  actor_state_set: ActorStateSetInput,
  actor_state_delete: ActorStateDeleteInput,
  actor_state_keys: ActorStateKeysInput,
  actor_reminder_register: ActorReminderRegisterInput,
  actor_reminder_unregister: ActorReminderUnregisterInput,
  actor_timer_register: ActorTimerRegisterInput,
  actor_timer_unregister: ActorTimerUnregisterInput,
  actor_list_active: ActorListActiveInput,
};

type ObjectSchema = {
  properties?: Record<string, { description?: string }>;
  required?: string[];
};

describe("published inputSchema stays aligned with the annotated Structs", () => {
  it("covers every published tool with a decode Struct and a handler", () => {
    const published = TOOL_DEFINITIONS.map((t) => t.name).sort();
    expect(Object.keys(decodeStructFor).sort()).toEqual(published);
    expect(Object.keys(toolHandlers).sort()).toEqual(published);
  });

  for (const tool of TOOL_DEFINITIONS) {
    it(tool.name, () => {
      const published = tool.inputSchema as unknown as ObjectSchema;
      const generated = JSONSchema.make(decodeStructFor[tool.name]!) as ObjectSchema;
      expect([...(published.required ?? [])].sort()).toEqual(
        [...(generated.required ?? [])].sort(),
      );
      for (const [field, publishedProp] of Object.entries(published.properties ?? {})) {
        const generatedProp = generated.properties?.[field];
        expect(generatedProp, `struct is missing published field '${field}'`).toBeDefined();
        if (publishedProp.description !== undefined) {
          expect(generatedProp!.description, `description of '${field}'`).toBe(
            publishedProp.description,
          );
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// The MCP error edge: an E-channel failure must become an { isError: true } ToolResult, never a
// rejection (an uncaught failure degrades into an untagged JSON-RPC InternalError).
// ---------------------------------------------------------------------------------------------

const stateBoom = (operation: string, storeName: string, key?: string) =>
  Effect.fail(
    new DaprStateError({
      cause: new Error(`state ${operation} failed: 500 boom`),
      operation,
      storeName,
      key,
    }),
  );

const failingStateStore = Layer.succeed(StateStore, {
  get: (storeName, key) => stateBoom("get", storeName, key),
  getBulk: (storeName) => stateBoom("getBulk", storeName),
  save: (storeName, key) => stateBoom("save", storeName, key),
  delete: (storeName, key) => stateBoom("delete", storeName, key),
});

const actorBoom = (operation: string, actorId?: string) =>
  Effect.fail(new DaprActorError({ cause: new Error("actor exploded"), operation, actorId }));

const failingActorStore = Layer.succeed(ActorStore, {
  invoke: (actorId) => actorBoom("invoke", actorId),
  getState: (actorId) => actorBoom("getState", actorId),
  setState: (actorId) => actorBoom("setState", actorId),
  removeState: (actorId) => actorBoom("removeState", actorId),
  listStateKeys: (actorId) => actorBoom("listStateKeys", actorId),
  registerReminder: (actorId) => actorBoom("registerReminder", actorId),
  unregisterReminder: (actorId) => actorBoom("unregisterReminder", actorId),
  registerTimer: (actorId) => actorBoom("registerTimer", actorId),
  unregisterTimer: (actorId) => actorBoom("unregisterTimer", actorId),
  listActiveActors: () => actorBoom("listActiveActors"),
});

const failingPubSub = Layer.succeed(PubSub, {
  publish: (pubsubName, topic) =>
    Effect.fail(
      new DaprPubSubError({
        cause: new Error("Dapr publish failed: 500 broker down"),
        pubsubName,
        topic,
      }),
    ),
});

const stubStateStore = Layer.succeed(StateStore, {
  get: () => Effect.succeedNone,
  getBulk: (_store, keys) => Effect.succeed(keys.map((key) => ({ key, data: null }))),
  save: () => Effect.void,
  delete: () => Effect.void,
});

const stubActorStore = Layer.succeed(ActorStore, {
  invoke: () => Effect.succeed({ ok: true }),
  getState: (_actorId, key) => Effect.succeed({ key, value: "v", exists: true }),
  setState: (_actorId, key) => Effect.succeed({ key }),
  removeState: (_actorId, key) => Effect.succeed({ key, removed: true }),
  listStateKeys: () => Effect.succeed(["a", "b"]),
  registerReminder: () => Effect.void,
  unregisterReminder: () => Effect.void,
  registerTimer: () => Effect.void,
  unregisterTimer: () => Effect.void,
  listActiveActors: () => Effect.succeed({ GenericActor: 1 }),
});

const stubPubSub = Layer.succeed(PubSub, { publish: () => Effect.void });

const failingPorts = Layer.mergeAll(failingStateStore, failingActorStore, failingPubSub);
const stubPorts = Layer.mergeAll(stubStateStore, stubActorStore, stubPubSub);

// Minimal valid args per tool, reused across the edge and behaviour suites.
const validArgs: Record<string, unknown> = {
  state_get: { key: "k" },
  state_get_bulk: { keys: ["a", "b"] },
  state_save: { key: "k", value: { a: 1 } },
  state_delete: { key: "k" },
  pubsub_publish: { topic: "t", data: { hello: 1 } },
  actor_invoke: { actorId: "id-1", method: "record", payload: { x: 1 } },
  actor_state_get: { actorId: "id-1", key: "k" },
  actor_state_set: { actorId: "id-1", key: "k", value: 1 },
  actor_state_delete: { actorId: "id-1", key: "k" },
  actor_state_keys: { actorId: "id-1" },
  actor_reminder_register: { actorId: "id-1", name: "r", dueTime: "PT5S" },
  actor_reminder_unregister: { actorId: "id-1", name: "r" },
  actor_timer_register: { actorId: "id-1", name: "t", dueTime: "PT5S" },
  actor_timer_unregister: { actorId: "id-1", name: "t" },
  actor_list_active: {},
};

describe("tool error edge", () => {
  it("every tool catches its port failure into an isError ToolResult", async () => {
    for (const [name, handler] of Object.entries(toolHandlers)) {
      const result = await Effect.runPromise(
        handler(validArgs[name]).pipe(Effect.provide(failingPorts)),
      );
      expect(result.isError, `${name} must catch into isError`).toBe(true);
    }
  });

  it("a failing state store surfaces the legacy message text", async () => {
    const result = await Effect.runPromise(
      toolHandlers["state_get"]!({ key: "k" }).pipe(Effect.provide(failingPorts)),
    );
    expect(result.content[0]!.text).toBe("state get failed: 500 boom");
  });

  it("a malformed input becomes an isError ToolResult (ParseError edge)", async () => {
    const result = await Effect.runPromise(
      toolHandlers["state_get"]!({}).pipe(Effect.provide(stubPorts)),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Invalid state_get input");
  });

  it("rejects a method outside the published actor_invoke enum", async () => {
    const result = await Effect.runPromise(
      toolHandlers["actor_invoke"]!({ actorId: "id-1", method: "explode" }).pipe(
        Effect.provide(stubPorts),
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Invalid actor_invoke input");
  });
});

// ---------------------------------------------------------------------------------------------
// Behaviour preservation: success wire shapes are byte-identical to the pre-Effect server.
// ---------------------------------------------------------------------------------------------

describe("behaviour preservation", () => {
  const runTool = (name: string, args: unknown) =>
    Effect.runPromise(toolHandlers[name]!(args).pipe(Effect.provide(stubPorts)));

  it("state_get renders a missing key as the literal 'null' text", async () => {
    const result = await runTool("state_get", { key: "nope" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("null");
  });

  it("state_save answers {key} and defaults the store name", async () => {
    let seen: { storeName: string; key: string; value: unknown } | undefined;
    const capture = Layer.merge(
      Layer.succeed(StateStore, {
        get: () => Effect.succeedNone,
        getBulk: () => Effect.succeed([]),
        save: (storeName, key, value) => {
          seen = { storeName, key, value };
          return Effect.void;
        },
        delete: () => Effect.void,
      }),
      Layer.merge(stubActorStore, stubPubSub),
    );
    const result = await Effect.runPromise(
      toolHandlers["state_save"]!({ key: "k", value: { a: 1 } }).pipe(Effect.provide(capture)),
    );
    expect(JSON.parse(result.content[0]!.text)).toEqual({ key: "k" });
    expect(seen).toEqual({ storeName: "statestore", key: "k", value: { a: 1 } });
  });

  it("pubsub_publish answers the legacy envelope and defaults the component name", async () => {
    let seen: { pubsubName: string; topic: string } | undefined;
    const capture = Layer.merge(
      Layer.succeed(PubSub, {
        publish: (pubsubName, topic) => {
          seen = { pubsubName, topic };
          return Effect.void;
        },
      }),
      Layer.merge(stubStateStore, stubActorStore),
    );
    const result = await Effect.runPromise(
      toolHandlers["pubsub_publish"]!({ topic: "runs", data: { d: 1 } }).pipe(
        Effect.provide(capture),
      ),
    );
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      pubsubName: "pubsub",
      topic: "runs",
      published: true,
    });
    expect(seen).toEqual({ pubsubName: "pubsub", topic: "runs" });
  });

  it("actor_state_get passes the port's {key, value, exists} straight through", async () => {
    const result = await runTool("actor_state_get", { actorId: "id-1", key: "k" });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ key: "k", value: "v", exists: true });
  });

  it("actor_reminder_register answers the legacy envelope and forwards all fields", async () => {
    let seen: unknown[] | undefined;
    const withCapture = Layer.merge(
      Layer.succeed(ActorStore, {
        invoke: () => Effect.succeed({}),
        getState: (_a, key) => Effect.succeed({ key, value: null, exists: false }),
        setState: (_a, key) => Effect.succeed({ key }),
        removeState: (_a, key) => Effect.succeed({ key, removed: true }),
        listStateKeys: () => Effect.succeed([]),
        registerReminder: (actorId, name, dueTime, period, data) => {
          seen = [actorId, name, dueTime, period, data];
          return Effect.void;
        },
        unregisterReminder: () => Effect.void,
        registerTimer: () => Effect.void,
        unregisterTimer: () => Effect.void,
        listActiveActors: () => Effect.succeed({}),
      }),
      Layer.merge(stubStateStore, stubPubSub),
    );
    const result = await Effect.runPromise(
      toolHandlers["actor_reminder_register"]!({
        actorId: "id-1",
        name: "r",
        dueTime: "PT5S",
        period: "PT1M",
        data: { p: 1 },
      }).pipe(Effect.provide(withCapture)),
    );
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      actorId: "id-1",
      reminder: "r",
      registered: true,
    });
    expect(seen).toEqual(["id-1", "r", "PT5S", "PT1M", { p: 1 }]);
  });

  it("actor_timer_unregister answers the legacy envelope", async () => {
    const result = await runTool("actor_timer_unregister", { actorId: "id-1", name: "t" });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      actorId: "id-1",
      timer: "t",
      unregistered: true,
    });
  });
});
