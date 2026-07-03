import { HttpClient, HttpClientResponse } from "@effect/platform";
import type { HttpClientRequest } from "@effect/platform";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { DaprPublisherLive, DaprPublisherTag, DaprPubSubError } from "./publisher.ts";

function stubClient(respond: () => Response) {
  const seen: HttpClientRequest.HttpClientRequest[] = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((req) => {
      seen.push(req);
      return Effect.succeed(HttpClientResponse.fromWeb(req, respond()));
    }),
  );
  return { layer, seen };
}

function publishWith(layer: Layer.Layer<HttpClient.HttpClient>, metadata?: Record<string, string>) {
  return Effect.gen(function* () {
    const publisher = yield* DaprPublisherTag;
    yield* publisher.publish("pubsub", "my topic", { hello: "world" }, metadata);
  }).pipe(Effect.provide(DaprPublisherLive("http://localhost:3500").pipe(Layer.provide(layer))));
}

describe("DaprPublisherLive", () => {
  it("POSTs the event to the publish URL with metadata as query params", async () => {
    const { layer, seen } = stubClient(() => new Response(null, { status: 204 }));

    await Effect.runPromise(publishWith(layer, { ttlInSeconds: "60" }));

    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    // topic is URL-encoded; metadata rides as metadata.<key> query params
    expect(req.url).toBe(
      "http://localhost:3500/v1.0/publish/pubsub/my%20topic?metadata.ttlInSeconds=60",
    );
    const body = req.body;
    if ("body" in body && body.body instanceof Uint8Array) {
      expect(JSON.parse(new TextDecoder().decode(body.body))).toEqual({ hello: "world" });
    } else {
      expect.fail("expected a Uint8Array request body");
    }
  });

  it("fails with DaprPubSubError carrying pubsub/topic on a non-ok response", async () => {
    const { layer } = stubClient(() => new Response("boom", { status: 500 }));

    const err = await Effect.runPromise(Effect.flip(publishWith(layer)));

    expect(err).toBeInstanceOf(DaprPubSubError);
    expect(err.pubsubName).toBe("pubsub");
    expect(err.topic).toBe("my topic");
    expect(String(err.cause)).toContain("500");
  });
});
