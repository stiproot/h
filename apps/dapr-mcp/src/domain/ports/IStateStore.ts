import { Context, Data } from "effect";
import type { Effect, Option } from "effect";

export interface BulkStateItem {
  key: string;
  data: unknown;
}

/** A Dapr state-store operation failed (network failure or a non-ok sidecar status). */
export class DaprStateError extends Data.TaggedError("DaprStateError")<{
  readonly cause: unknown;
  readonly operation: string;
  readonly storeName: string;
  readonly key?: string;
}> {}

/**
 * The Dapr state-store port. A missing key is not an error: `get` returns `Option.none`
 * (the legacy adapter returned `null` on 204/404, and the tool edge restores that exact
 * wire shape via `Option.getOrNull`). `getBulk` keeps the legacy per-item `data: null`
 * for absent keys, since that shape is itself part of the published wire result.
 */
export class StateStore extends Context.Tag("StateStore")<
  StateStore,
  {
    readonly get: (
      storeName: string,
      key: string,
    ) => Effect.Effect<Option.Option<unknown>, DaprStateError>;
    readonly getBulk: (
      storeName: string,
      keys: readonly string[],
    ) => Effect.Effect<BulkStateItem[], DaprStateError>;
    readonly save: (
      storeName: string,
      key: string,
      value: unknown,
    ) => Effect.Effect<void, DaprStateError>;
    readonly delete: (storeName: string, key: string) => Effect.Effect<void, DaprStateError>;
  }
>() {}
