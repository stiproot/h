import { HttpClient, HttpClientError, HttpClientResponse } from "@effect/platform";
import type { HttpClientRequest } from "@effect/platform";
import { ConfigProvider, Context, Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { StateStore } from "../domain/ports/IStateStore.ts";
import { StateStoreLive } from "./dapr-state-store.ts";

// Pin the sidecar port so URLs are deterministic regardless of the test env.
const configLayer = Layer.setConfigProvider(
  ConfigProvider.fromMap(new Map([["DAPR_HTTP_PORT", "3500"]])),
);

const BASE = "http://localhost:3500/v1.0/state/statestore";

interface Seen {
  url: string;
  method: string;
  body: string;
}

// Stub HttpClient: every request is recorded into `seen` and answered by `respond`
// (a Response, or "unreachable" to fail in the transport like a dead sidecar).
function httpLayer(seen: Seen[], respond: (req: Seen) => Response | "unreachable") {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((req: HttpClientRequest.HttpClientRequest) => {
      const request: Seen = {
        url: req.url,
        method: req.method,
        body: req.body._tag === "Uint8Array" ? new TextDecoder().decode(req.body.body) : "",
      };
      seen.push(request);
      const res = respond(request);
      if (res === "unreachable") {
        return Effect.fail(
          new HttpClientError.RequestError({
            request: req,
            reason: "Transport",
            cause: new Error("connect ECONNREFUSED"),
          }),
        );
      }
      return Effect.succeed(HttpClientResponse.fromWeb(req, res));
    }),
  );
}

function run<A, E>(
  use: (state: Context.Tag.Service<StateStore>) => Effect.Effect<A, E>,
  respond: (req: Seen) => Response | "unreachable",
  seen: Seen[] = [],
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* StateStore;
      return yield* use(state);
    }).pipe(
      Effect.provide(
        StateStoreLive.pipe(Layer.provide(Layer.mergeAll(httpLayer(seen, respond), configLayer))),
      ),
    ) as Effect.Effect<A, E>,
  );
}

describe("get — missing-key semantics preserved", () => {
  it("404 is a missing key (Option.none, the legacy null), not an error", async () => {
    const value = await run(
      (s) => s.get("statestore", "nope"),
      () =>
        new Response("", {
          status: 404,
        }),
    );
    expect(Option.isNone(value)).toBe(true);
  });

  it("204 is a missing key too", async () => {
    const value = await run(
      (s) => s.get("statestore", "nope"),
      () => new Response(null, { status: 204 }),
    );
    expect(Option.isNone(value)).toBe(true);
  });

  it("an empty 200 body reads as no value (legacy parseValue('') → null)", async () => {
    const value = await run(
      (s) => s.get("statestore", "k"),
      () =>
        new Response("", {
          status: 200,
        }),
    );
    expect(Option.isNone(value)).toBe(true);
  });

  it("parses a JSON body", async () => {
    const value = await run(
      (s) => s.get("statestore", "k"),
      () => new Response(JSON.stringify({ a: 1 }), { status: 200 }),
    );
    expect(Option.getOrNull(value)).toEqual({ a: 1 });
  });

  it("returns a non-JSON body as raw text", async () => {
    const value = await run(
      (s) => s.get("statestore", "k"),
      () =>
        new Response("plain-text", {
          status: 200,
        }),
    );
    expect(Option.getOrNull(value)).toBe("plain-text");
  });

  it("hits the legacy URL with the key encoded", async () => {
    const seen: Seen[] = [];
    await run(
      (s) => s.get("statestore", "a/b"),
      () => new Response("1", { status: 200 }),
      seen,
    );
    expect(seen[0]).toMatchObject({ method: "GET", url: `${BASE}/a%2Fb` });
  });

  it("a non-ok status fails with the legacy message in the cause", async () => {
    const error = await run(
      (s) => s.get("statestore", "k").pipe(Effect.flip),
      () => new Response("boom", { status: 500 }),
    );
    expect(error._tag).toBe("DaprStateError");
    expect((error.cause as Error).message).toBe("state get failed: 500 boom");
  });

  it("a transport failure lands in the typed channel, not a rejection", async () => {
    const error = await run(
      (s) => s.get("statestore", "k").pipe(Effect.flip),
      () => "unreachable",
    );
    expect(error._tag).toBe("DaprStateError");
  });
});

describe("getBulk", () => {
  it("POSTs {keys} to /bulk and maps an absent per-item data to null", async () => {
    const seen: Seen[] = [];
    const items = await run(
      (s) => s.getBulk("statestore", ["a", "b"]),
      () =>
        new Response(JSON.stringify([{ key: "a", data: { v: 1 } }, { key: "b" }]), {
          status: 200,
        }),
      seen,
    );
    expect(seen[0]).toMatchObject({ method: "POST", url: `${BASE}/bulk` });
    expect(JSON.parse(seen[0]!.body)).toEqual({ keys: ["a", "b"] });
    expect(items).toEqual([
      { key: "a", data: { v: 1 } },
      { key: "b", data: null },
    ]);
  });

  it("a non-ok status fails with the legacy message", async () => {
    const error = await run(
      (s) => s.getBulk("statestore", ["a"]).pipe(Effect.flip),
      () => new Response("nope", { status: 500 }),
    );
    expect((error.cause as Error).message).toBe("state getBulk failed: 500 nope");
  });
});

describe("save", () => {
  it("POSTs the legacy [{key, value}] envelope to the store URL", async () => {
    const seen: Seen[] = [];
    await run(
      (s) => s.save("statestore", "k", { a: 1 }),
      () => new Response(null, { status: 204 }),
      seen,
    );
    expect(seen[0]).toMatchObject({ method: "POST", url: BASE });
    expect(JSON.parse(seen[0]!.body)).toEqual([{ key: "k", value: { a: 1 } }]);
  });

  it("a non-ok status fails with the legacy message", async () => {
    const error = await run(
      (s) => s.save("statestore", "k", 1).pipe(Effect.flip),
      () => new Response("denied", { status: 403 }),
    );
    expect((error.cause as Error).message).toBe("state save failed: 403 denied");
  });
});

describe("delete", () => {
  it("DELETEs the key URL", async () => {
    const seen: Seen[] = [];
    await run(
      (s) => s.delete("statestore", "k"),
      () => new Response(null, { status: 204 }),
      seen,
    );
    expect(seen[0]).toMatchObject({ method: "DELETE", url: `${BASE}/k` });
  });

  it("a non-ok status fails with the legacy message", async () => {
    const error = await run(
      (s) => s.delete("statestore", "k").pipe(Effect.flip),
      () => new Response("bad", { status: 500 }),
    );
    expect((error.cause as Error).message).toBe("state delete failed: 500 bad");
  });
});
