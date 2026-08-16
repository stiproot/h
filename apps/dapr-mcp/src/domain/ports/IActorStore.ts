import { Context, Data } from "effect";
import type { Effect } from "effect";

/** One actor state key's value, and whether it was present. */
export interface ActorStateResult {
  key: string;
  value: unknown;
  exists: boolean;
}

/** A Dapr actor operation failed (network failure, a non-ok sidecar status, or an actor throw). */
export class DaprActorError extends Data.TaggedError("DaprActorError")<{
  readonly cause: unknown;
  readonly operation: string;
  readonly actorId?: string;
}> {}

/**
 * The actor port: dapr-mcp's actor surface — command invocation, KV state, reminders and timers.
 *
 * The shape matches core-dapr's `GenericActorClientService` exactly and is nonetheless RESTATED
 * here, like its sibling `IStateStore` — the domain declares what it needs, and `infrastructure/`
 * binds an adapter to it. Importing the adapter's own interface would invert that: `domain/` would
 * depend on an I/O package, which is the one thing the layering forbids (and, until the boundary
 * rule's path patterns were fixed on 2026-08-16, silently allowed).
 *
 * Restating costs nothing in drift risk, because `ActorStoreLive` delegates by identity: if
 * core-dapr's surface ever diverges from this one, that assignment stops compiling. The coupling is
 * still there — it is just checked now instead of assumed.
 */
export class ActorStore extends Context.Tag("ActorStore")<
  ActorStore,
  {
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
    readonly unregisterTimer: (
      actorId: string,
      name: string,
    ) => Effect.Effect<void, DaprActorError>;
    readonly listActiveActors: () => Effect.Effect<object, DaprActorError>;
  }
>() {}
