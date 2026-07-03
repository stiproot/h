import { Effect, Fiber, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { DaprSidecarError, retryUntilReady } from "./wait-for-sidecar.ts";

// The retry policy is tested through `retryUntilReady` (the exported test seam) with a
// synchronous probe and the TestClock — no live sidecar, no real time.

describe("retryUntilReady", () => {
  it("probes once a second until the probe succeeds", async () => {
    let attempts = 0;
    const probe = Effect.suspend(() => {
      attempts += 1;
      return attempts >= 3 ? Effect.void : Effect.fail(new Error("not ready"));
    });

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(retryUntilReady(probe, "3500", 60));
      // attempt 1 at t=0, attempt 2 at t=1s, attempt 3 (success) at t=2s
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);
    });

    await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)));
    expect(attempts).toBe(3);
  });

  it("stops after exactly maxAttempts probes and fails with DaprSidecarError", async () => {
    let attempts = 0;
    const probe = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail(new Error("never ready"));
    });

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(Effect.flip(retryUntilReady(probe, "3500", 5)));
      // budget: initial attempt + 4 retries, spaced 1s — all inside 10 virtual seconds
      yield* TestClock.adjust("10 seconds");
      return yield* Fiber.join(fiber);
    });

    const err: DaprSidecarError = await Effect.runPromise(
      program.pipe(Effect.provide(TestContext.TestContext)),
    );
    expect(err).toBeInstanceOf(DaprSidecarError);
    expect(err.port).toBe("3500");
    expect(err.attempts).toBe(5);
    expect(attempts).toBe(5);
    expect(String(err.cause)).toContain("never ready");
  });
});
