import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { withAmbientParent, withTraceparentParent } from "./bridge.ts";
import { makeTracingLive } from "./tracing.ts";

describe("withAmbientParent", () => {
  it("returns the effect unchanged when no ambient OTel span is active", () => {
    const effect = Effect.succeed(42);
    // Identity, not a wrapper: no ambient span means no parent to hand off.
    expect(withAmbientParent(effect)).toBe(effect);
  });

  it("runs the effect normally without an ambient span", async () => {
    await expect(Effect.runPromise(withAmbientParent(Effect.succeed("ok")))).resolves.toBe("ok");
  });
});

describe("withTraceparentParent", () => {
  it("returns the effect unchanged when the traceparent is absent and no span is active", () => {
    const effect = Effect.succeed(1);
    expect(withTraceparentParent(effect, undefined)).toBe(effect);
  });

  it("parents the fiber under an external span built from the traceparent", async () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const spanId = "b7ad6b7169203331";
    const traceparent = `00-${traceId}-${spanId}-01`;

    // The W3C propagator is only registered once tracing is initialised, and the bridge
    // captures at call time — so the call is suspended until the layer has built, exactly
    // like a real edge calling it after tracing is up.
    const parent = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.suspend(() => withTraceparentParent(Effect.currentParentSpan, traceparent)),
          makeTracingLive("telemetry-test"),
        ),
      ),
    );

    expect(parent._tag).toBe("ExternalSpan");
    if (parent._tag === "ExternalSpan") {
      expect(parent.spanId).toBe(spanId);
      expect(parent.traceId).toBe(traceId);
    }
  });
});

describe("TracingLive", () => {
  it("builds, runs Effect.withSpan, and releases cleanly (twice — provider re-acquirable)", async () => {
    const program = Effect.provide(
      Effect.void.pipe(Effect.withSpan("bridge-test-span")),
      makeTracingLive("telemetry-test"),
    );
    await Effect.runPromise(Effect.scoped(program));
    await Effect.runPromise(Effect.scoped(program));
  });
});
