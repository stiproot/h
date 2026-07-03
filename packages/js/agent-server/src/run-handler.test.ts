import { AgentRequest, AgentRunError } from "core";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { runHandler } from "./run-handler.ts";
import type { HandlerReply } from "./run-handler.ts";

// Plain vitest + a real ManagedRuntime over an empty layer; see the refactor map's
// testing note re @effect/vitest peering on vitest 3 vs the repo's 4.
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

/** Stub reply that records what the bridge sent. */
function makeReply(): { reply: HandlerReply; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const reply: HandlerReply = {
    status(statusCode) {
      sent.status = statusCode;
      return reply;
    },
    send(payload) {
      sent.body = payload;
      return reply;
    },
  };
  return { reply, sent };
}

describe("runHandler", () => {
  it("sends the success value with status 200", async () => {
    const { reply, sent } = makeReply();
    await runHandler(runtime, reply, Effect.succeed({ ok: true }));
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ ok: true });
  });

  it("honours successStatus for no-body routes", async () => {
    const { reply, sent } = makeReply();
    await runHandler(runtime, reply, Effect.void, { successStatus: 204 });
    expect(sent.status).toBe(204);
    expect(sent.body).toBeUndefined();
  });

  it("maps a ParseError (malformed body decoded inside the effect) to 400", async () => {
    const { reply, sent } = makeReply();
    await runHandler(runtime, reply, Schema.decodeUnknown(AgentRequest)({ nope: true }));
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ statusCode: 400, error: "Bad Request" });
    expect((sent.body as { message: string }).message).toContain("input");
  });

  it("maps a tagged domain error to 500 with the cause's message", async () => {
    const { reply, sent } = makeReply();
    await runHandler(
      runtime,
      reply,
      Effect.fail(new AgentRunError({ cause: new Error("boom"), agentId: "claude-agent" })),
    );
    expect(sent.status).toBe(500);
    expect(sent.body).toMatchObject({
      statusCode: 500,
      error: "Internal Server Error",
      message: "boom",
    });
  });

  it("maps a defect (thrown, untyped) to 500", async () => {
    const { reply, sent } = makeReply();
    await runHandler(
      runtime,
      reply,
      Effect.sync(() => {
        throw new Error("kaboom");
      }),
    );
    expect(sent.status).toBe(500);
    expect(sent.body).toMatchObject({ statusCode: 500, message: "kaboom" });
  });
});
