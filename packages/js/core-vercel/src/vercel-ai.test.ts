import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { LlmClient } from "./llm-client.ts";
import { LlmConfigError, VercelAiClientLive } from "./vercel-ai.ts";

const generateOnce = Effect.gen(function* () {
  const llm = yield* LlmClient;
  return yield* llm.generate("hi");
});

const layerFor = (secretsPath: string) =>
  VercelAiClientLive({
    secretsPath,
    baseUrl: "http://localhost:4000",
    modelName: "test-model",
  });

const tempSecretsFile = (contents: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "core-vercel-test-")), "secrets.json");
  writeFileSync(path, contents);
  return path;
};

describe("VercelAiClientLive", () => {
  it.effect("fails with LlmConfigError at layer build when the secrets file is missing", () =>
    Effect.gen(function* () {
      const secretsPath = join(tmpdir(), "core-vercel-test-does-not-exist", "secrets.json");
      const error = yield* Effect.flip(generateOnce.pipe(Effect.provide(layerFor(secretsPath))));
      expect(error).toBeInstanceOf(LlmConfigError);
      expect(error._tag).toBe("LlmConfigError");
      expect((error as LlmConfigError).secretsPath).toBe(secretsPath);
    }),
  );

  it.effect("fails with LlmConfigError on malformed secrets JSON", () =>
    Effect.gen(function* () {
      const secretsPath = tempSecretsFile("{ definitely not json");
      const error = yield* Effect.flip(generateOnce.pipe(Effect.provide(layerFor(secretsPath))));
      expect(error).toBeInstanceOf(LlmConfigError);
      expect((error as LlmConfigError).cause).toBeInstanceOf(SyntaxError);
    }),
  );

  it.effect("fails with LlmConfigError when the secrets shape is wrong", () =>
    Effect.gen(function* () {
      const secretsPath = tempSecretsFile(JSON.stringify({ WRONG_KEY: "nope" }));
      const error = yield* Effect.flip(generateOnce.pipe(Effect.provide(layerFor(secretsPath))));
      expect(error).toBeInstanceOf(LlmConfigError);
      // The decode failure is Effect's ParseError, carried as the cause.
      expect((error as LlmConfigError).cause).toMatchObject({ _tag: "ParseError" });
    }),
  );
});

describe("LlmClient tag", () => {
  it.effect("resolves whichever LlmService layer is provided", () => {
    const stub = Layer.succeed(LlmClient, {
      generate: (input) =>
        Effect.succeed({ text: `echo:${input}`, usage: { input: 1, output: 2 }, model: "stub" }),
    });
    return Effect.gen(function* () {
      const result = yield* generateOnce.pipe(Effect.provide(stub));
      expect(result).toEqual({ text: "echo:hi", usage: { input: 1, output: 2 }, model: "stub" });
    });
  });
});
