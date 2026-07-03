import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Config, Effect, Layer, Option } from "effect";
import type { ConfigError } from "effect";

import { DaprStateError, StateStore } from "../domain/ports/IStateStore.ts";
import type { BulkStateItem } from "../domain/ports/IStateStore.ts";

// Dapr returns the stored value verbatim; parse JSON when possible, else return raw text.
function parseValue(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Live layer over the sidecar's state HTTP API (get/getBulk/save/delete). The `HttpClient`
 * requirement is captured at layer build, so the port methods stay `R = never` — the
 * composition root provides `NodeHttpClient.layer`. The sidecar base URL comes from
 * `DAPR_HTTP_PORT` via Effect `Config` (default 3500), same env var as the legacy class.
 *
 * Missing-key semantics preserved from the legacy adapter: a 204/404 on `get` is a missing
 * value (`Option.none`, `null` on the wire — never an error), and `getBulk` maps an absent
 * per-item `data` to `null`. Every other non-2xx becomes a `DaprStateError` whose cause
 * carries the legacy `state <op> failed: <status> <body>` message.
 */
export const StateStoreLive: Layer.Layer<
  StateStore,
  ConfigError.ConfigError,
  HttpClient.HttpClient
> = Layer.effect(
  StateStore,
  Effect.gen(function* () {
    const daprPort = yield* Config.string("DAPR_HTTP_PORT").pipe(Config.withDefault("3500"));
    const client = yield* HttpClient.HttpClient;
    const daprBase = `http://localhost:${daprPort}`;

    const stateUrl = (storeName: string, key?: string): string => {
      const base = `${daprBase}/v1.0/state/${encodeURIComponent(storeName)}`;
      return key ? `${base}/${encodeURIComponent(key)}` : base;
    };

    // Wrap raw HttpClient/body failures into the port's tag; pass an already-tagged
    // failure (a non-ok status we raised ourselves) through untouched.
    const asStateError =
      (operation: string, storeName: string, key?: string) =>
      (cause: unknown): DaprStateError =>
        cause instanceof DaprStateError
          ? cause
          : new DaprStateError({ cause, operation, storeName, key });

    const failStatus = (
      operation: string,
      storeName: string,
      status: number,
      body: string,
      key?: string,
    ) =>
      new DaprStateError({
        cause: new Error(`state ${operation} failed: ${status} ${body}`),
        operation,
        storeName,
        key,
      });

    return {
      get: (storeName, key) =>
        Effect.gen(function* () {
          const res = yield* client.execute(HttpClientRequest.get(stateUrl(storeName, key)));
          if (res.status === 204 || res.status === 404) return Option.none();
          const text = yield* res.text;
          if (res.status < 200 || res.status >= 300) {
            return yield* failStatus("get", storeName, res.status, text, key);
          }
          // parseValue maps an empty body to null — legacy "no value", i.e. Option.none.
          return Option.fromNullable(parseValue(text));
        }).pipe(Effect.mapError(asStateError("get", storeName, key))),

      getBulk: (storeName, keys) =>
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(`${stateUrl(storeName)}/bulk`),
            { keys },
          );
          const res = yield* client.execute(request);
          if (res.status < 200 || res.status >= 300) {
            const text = yield* res.text;
            return yield* failStatus("getBulk", storeName, res.status, text);
          }
          const items = (yield* res.json) as { key: string; data?: unknown }[];
          return items.map((i): BulkStateItem => ({ key: i.key, data: i.data ?? null }));
        }).pipe(Effect.mapError(asStateError("getBulk", storeName))),

      save: (storeName, key, value) =>
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(stateUrl(storeName)),
            [{ key, value }],
          );
          const res = yield* client.execute(request);
          if (res.status < 200 || res.status >= 300) {
            const text = yield* res.text;
            return yield* failStatus("save", storeName, res.status, text, key);
          }
        }).pipe(Effect.asVoid, Effect.mapError(asStateError("save", storeName, key))),

      delete: (storeName, key) =>
        Effect.gen(function* () {
          const res = yield* client.execute(HttpClientRequest.del(stateUrl(storeName, key)));
          if (res.status < 200 || res.status >= 300) {
            const text = yield* res.text;
            return yield* failStatus("delete", storeName, res.status, text, key);
          }
        }).pipe(Effect.asVoid, Effect.mapError(asStateError("delete", storeName, key))),
    };
  }),
);
