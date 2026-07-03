import { HttpClient, HttpClientResponse } from "@effect/platform";
import type { HttpClientRequest } from "@effect/platform";
import { DaprInvokeError } from "core";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { DaprInvokerLive, DaprInvokerTag } from "./invoker.ts";

const agentResponse = {
  output: "done",
  sessionId: "s-1",
  usage: { input: 10, output: 20 },
  model: "claude",
  turns: 2,
};

// Read the JSON out of a captured request's (Uint8Array) body.
function decodeJsonBody(req: HttpClientRequest.HttpClientRequest): unknown {
  const body = req.body;
  if ("body" in body && body.body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body.body));
  }
  throw new Error("expected a Uint8Array request body");
}

// Stub HttpClient layer: no network — every request is answered by `respond`, and the
// outgoing request is captured for assertions.
function stubClient(respond: (req: HttpClientRequest.HttpClientRequest) => Response) {
  const seen: HttpClientRequest.HttpClientRequest[] = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((req) => {
      seen.push(req);
      return Effect.succeed(HttpClientResponse.fromWeb(req, respond(req)));
    }),
  );
  return { layer, seen };
}

function invokeWith(layer: Layer.Layer<HttpClient.HttpClient>) {
  return Effect.gen(function* () {
    const invoker = yield* DaprInvokerTag;
    return yield* invoker.invoke("claude-agent", "run", { input: "hello" });
  }).pipe(Effect.provide(DaprInvokerLive("http://localhost:3500").pipe(Layer.provide(layer))));
}

describe("DaprInvokerLive", () => {
  it("POSTs the body to the sidecar invoke URL and decodes the AgentResponse", async () => {
    const { layer, seen } = stubClient(
      () =>
        new Response(JSON.stringify(agentResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await Effect.runPromise(invokeWith(layer));

    expect(result).toEqual(agentResponse);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:3500/v1.0/invoke/claude-agent/method/run");
    expect(decodeJsonBody(req)).toEqual({ input: "hello" });
  });

  it("fails with DaprInvokeError carrying appId/method on a non-2xx response", async () => {
    const { layer } = stubClient(() => new Response("sidecar says no", { status: 502 }));

    const err = await Effect.runPromise(Effect.flip(invokeWith(layer)));

    expect(err).toBeInstanceOf(DaprInvokeError);
    expect(err.appId).toBe("claude-agent");
    expect(err.method).toBe("run");
    expect(String(err.cause)).toContain("502");
    expect(String(err.cause)).toContain("sidecar says no");
  });

  it("fails with DaprInvokeError when the response body is not an AgentResponse", async () => {
    const { layer } = stubClient(
      () =>
        new Response(JSON.stringify({ nope: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const err = await Effect.runPromise(Effect.flip(invokeWith(layer)));

    expect(err).toBeInstanceOf(DaprInvokeError);
    // The decode failure rides in the cause (a ParseError), not a swallowed cast.
    expect(err.cause).toBeDefined();
  });
});
