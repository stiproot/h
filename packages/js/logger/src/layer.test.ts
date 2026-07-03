import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { LoggerInitError, LoggerLive, LoggerTag, LoggerTest } from "./layer.ts";

const logOnce = Effect.gen(function* () {
  const logger = yield* LoggerTag;
  yield* logger.info({ step: "one" }, "hello world");
});

describe("LoggerLive", () => {
  it.effect("fails with LoggerInitError when LOG_LEVEL is missing", () =>
    Effect.gen(function* () {
      // Empty env: NODE_ENV is not "test", so initLogger's LOG_LEVEL guard applies.
      const error = yield* Effect.flip(
        logOnce.pipe(Effect.provide(LoggerLive("missing-level", {}))),
      );
      expect(error).toBeInstanceOf(LoggerInitError);
      expect(error._tag).toBe("LoggerInitError");
      expect(String((error.cause as Error).message)).toContain("LOG_LEVEL");
    }),
  );

  it.effect("builds a Pino logger that writes the record to the given stream", () => {
    const chunks: string[] = [];
    const stream = {
      write(msg: string) {
        chunks.push(msg);
      },
    };
    return Effect.gen(function* () {
      yield* logOnce.pipe(
        Effect.provide(LoggerLive("layer-test", { LOG_LEVEL: "info" }, { stream })),
      );
      // The provided effect has completed, so the layer scope closed and flushed.
      const records = chunks.map((c) => JSON.parse(c) as Record<string, unknown>);
      const hello = records.find((r) => r["msg"] === "hello world");
      expect(hello).toBeDefined();
      expect(hello).toMatchObject({ name: "layer-test", level: "info", step: "one" });
    });
  });
});

describe("LoggerTest", () => {
  it.effect("captures logged lines, including child context", () => {
    const lines: Record<string, unknown>[] = [];
    return Effect.gen(function* () {
      const logger = yield* LoggerTag;
      yield* logger.info({ runId: "r1" }, "started");
      const child = yield* logger.child({ scope: "inner" });
      yield* child.error({}, "boom");
      expect(lines).toContainEqual({ runId: "r1", level: "info", message: "started" });
      expect(lines).toContainEqual({ scope: "inner", level: "error", message: "boom" });
    }).pipe(Effect.provide(LoggerTest((obj) => lines.push(obj))));
  });
});
