import { ActorId, ActorProxyBuilder, DaprClient, Temporal } from "@dapr/dapr";
import { Context, Data, Effect, Layer } from "effect";

import { GenericActor, type ActorStateResult, type IGenericActor } from "./generic-actor.ts";

// The Dapr runtime keys actor types by the class name (cls.name), so the client must
// address the same string the host registered.
const ACTOR_TYPE = GenericActor.name;

// Timer callbacks name an actor method; GenericActor records fires via onTimerFire.
const TIMER_CALLBACK = "onTimerFire";

function toDuration(iso: string): Temporal.Duration {
  return Temporal.Duration.from(iso);
}

/** A Dapr actor operation failed (proxy invoke, state, reminder/timer management, host lifecycle). */
export class DaprActorError extends Data.TaggedError("DaprActorError")<{
  readonly cause: unknown;
  readonly operation: string;
  readonly actorId?: string;
}> {}

/**
 * Client-side wrapper over a hosted GenericActor. State and command calls go through the
 * actor (via a typed proxy); reminders/timers are managed through the Dapr actor client.
 */
export class GenericActorClient {
  private readonly builder: ActorProxyBuilder<IGenericActor>;

  constructor(daprClient: DaprClient) {
    this.builder = new ActorProxyBuilder<IGenericActor>(GenericActor, daprClient);
  }

  private proxy(actorId: string): IGenericActor {
    return this.builder.build(new ActorId(actorId));
  }

  // Reminder/timer/enumeration live on the lower-level actor client, not the proxy.
  private get manager() {
    return this.builder.actorClient.actor;
  }

  invoke(actorId: string, method: string, payload: unknown): Promise<unknown> {
    return this.proxy(actorId).invokeCommand(method, payload);
  }

  getState(actorId: string, key: string): Promise<ActorStateResult> {
    return this.proxy(actorId).getState(key);
  }

  setState(actorId: string, key: string, value: unknown): Promise<{ key: string }> {
    return this.proxy(actorId).setState(key, value);
  }

  removeState(actorId: string, key: string): Promise<{ key: string; removed: boolean }> {
    return this.proxy(actorId).removeState(key);
  }

  listStateKeys(actorId: string): Promise<string[]> {
    return this.proxy(actorId).listStateKeys();
  }

  registerReminder(
    actorId: string,
    name: string,
    dueTime: string,
    period?: string,
    data?: unknown,
  ): Promise<void> {
    return this.manager.registerActorReminder(ACTOR_TYPE, new ActorId(actorId), name, {
      dueTime: toDuration(dueTime),
      period: period ? toDuration(period) : undefined,
      data,
    });
  }

  unregisterReminder(actorId: string, name: string): Promise<void> {
    return this.manager.unregisterActorReminder(ACTOR_TYPE, new ActorId(actorId), name);
  }

  registerTimer(
    actorId: string,
    name: string,
    dueTime: string,
    period?: string,
    data?: unknown,
  ): Promise<void> {
    return this.manager.registerActorTimer(ACTOR_TYPE, new ActorId(actorId), name, {
      callback: TIMER_CALLBACK,
      dueTime: toDuration(dueTime),
      period: period ? toDuration(period) : undefined,
      data,
    });
  }

  unregisterTimer(actorId: string, name: string): Promise<void> {
    return this.manager.unregisterActorTimer(ACTOR_TYPE, new ActorId(actorId), name);
  }

  listActiveActors(): Promise<object> {
    return this.manager.getActors();
  }
}

/**
 * The GenericActor client port — the same surface as `GenericActorClient`, with every
 * call lifted into the Effect world and failing with `DaprActorError`.
 */
export interface GenericActorClientService {
  readonly invoke: (
    actorId: string,
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, DaprActorError>;
  readonly getState: (
    actorId: string,
    key: string,
  ) => Effect.Effect<ActorStateResult, DaprActorError>;
  readonly setState: (
    actorId: string,
    key: string,
    value: unknown,
  ) => Effect.Effect<{ key: string }, DaprActorError>;
  readonly removeState: (
    actorId: string,
    key: string,
  ) => Effect.Effect<{ key: string; removed: boolean }, DaprActorError>;
  readonly listStateKeys: (actorId: string) => Effect.Effect<string[], DaprActorError>;
  readonly registerReminder: (
    actorId: string,
    name: string,
    dueTime: string,
    period?: string,
    data?: unknown,
  ) => Effect.Effect<void, DaprActorError>;
  readonly unregisterReminder: (
    actorId: string,
    name: string,
  ) => Effect.Effect<void, DaprActorError>;
  readonly registerTimer: (
    actorId: string,
    name: string,
    dueTime: string,
    period?: string,
    data?: unknown,
  ) => Effect.Effect<void, DaprActorError>;
  readonly unregisterTimer: (actorId: string, name: string) => Effect.Effect<void, DaprActorError>;
  readonly listActiveActors: () => Effect.Effect<object, DaprActorError>;
}

/** Service tag for the actor client. Yield it to call: `const actors = yield* GenericActorClientTag`. */
export class GenericActorClientTag extends Context.Tag("GenericActorClient")<
  GenericActorClientTag,
  GenericActorClientService
>() {}

export interface GenericActorClientOptions {
  daprHost?: string;
  daprPort?: string;
}

/**
 * Live scoped layer owning its own `DaprClient`, keeping the @dapr/dapr SDK encapsulated
 * here so consumers depend only on core-dapr. Teardown calls `DaprClient.stop()` —
 * verified present in the installed @dapr/dapr@3.17.0 typings (delegates to the underlying
 * HTTP client's stop) — best-effort, since teardown must never fail the scope close.
 */
export const GenericActorClientLive = (
  opts: GenericActorClientOptions = {},
): Layer.Layer<GenericActorClientTag> =>
  Layer.scoped(
    GenericActorClientTag,
    Effect.gen(function* () {
      const daprClient = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new DaprClient({
              daprHost: opts.daprHost ?? "127.0.0.1",
              daprPort: opts.daprPort ?? "3500",
            }),
        ),
        (client) => Effect.ignore(Effect.tryPromise(() => client.stop())),
      );
      const client = new GenericActorClient(daprClient);
      const attempt = <A>(
        operation: string,
        actorId: string | undefined,
        run: () => Promise<A>,
      ): Effect.Effect<A, DaprActorError> =>
        Effect.tryPromise({
          try: run,
          catch: (cause) => new DaprActorError({ cause, operation, actorId }),
        });
      return {
        invoke: (actorId, method, payload) =>
          attempt("invoke", actorId, () => client.invoke(actorId, method, payload)),
        getState: (actorId, key) =>
          attempt("getState", actorId, () => client.getState(actorId, key)),
        setState: (actorId, key, value) =>
          attempt("setState", actorId, () => client.setState(actorId, key, value)),
        removeState: (actorId, key) =>
          attempt("removeState", actorId, () => client.removeState(actorId, key)),
        listStateKeys: (actorId) =>
          attempt("listStateKeys", actorId, () => client.listStateKeys(actorId)),
        registerReminder: (actorId, name, dueTime, period, data) =>
          attempt("registerReminder", actorId, () =>
            client.registerReminder(actorId, name, dueTime, period, data),
          ),
        unregisterReminder: (actorId, name) =>
          attempt("unregisterReminder", actorId, () => client.unregisterReminder(actorId, name)),
        registerTimer: (actorId, name, dueTime, period, data) =>
          attempt("registerTimer", actorId, () =>
            client.registerTimer(actorId, name, dueTime, period, data),
          ),
        unregisterTimer: (actorId, name) =>
          attempt("unregisterTimer", actorId, () => client.unregisterTimer(actorId, name)),
        listActiveActors: () =>
          attempt("listActiveActors", undefined, () => client.listActiveActors()),
      };
    }),
  );
