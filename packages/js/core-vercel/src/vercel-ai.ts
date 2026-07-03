import { readFileSync } from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, generateText } from "ai";
import { Data, Duration, Effect, Layer, Schedule, Schema } from "effect";

import { LlmClient, LlmError, LlmTimeoutError } from "./llm-client.ts";
import type { LlmService } from "./llm-client.ts";

/**
 * Shape of the secrets file the adapter reads at layer build. The schema is the
 * single source of truth: the file is decoded with `Schema.decodeUnknown`, so a
 * missing or non-string key fails as a typed `LlmConfigError` at startup instead
 * of a silent cast.
 */
export const LlmSecrets = Schema.Struct({
  LITELLM_API_KEY: Schema.String,
});
export type LlmSecrets = Schema.Schema.Type<typeof LlmSecrets>;

/**
 * Raised at layer build when the secrets file is missing, unreadable, malformed
 * JSON, or fails the {@link LlmSecrets} decode.
 */
export class LlmConfigError extends Data.TaggedError("LlmConfigError")<{
  readonly cause: unknown;
  readonly secretsPath: string;
}> {}

/** Configuration for {@link VercelAiClientLive} (same knobs the legacy constructor took, plus resilience). */
export interface VercelAiConfig {
  readonly secretsPath: string;
  readonly baseUrl: string;
  readonly modelName: string;
  /** Per-attempt bound on a generate call. Default: 60 seconds. */
  readonly timeout?: Duration.DurationInput;
  /** Retry policy for transient failures. Default: exponential from 200 ms (factor 2), jittered, max 2 retries. */
  readonly retrySchedule?: Schedule.Schedule<unknown, LlmError | LlmTimeoutError>;
}

const defaultRetrySchedule = Schedule.exponential("200 millis", 2).pipe(
  Schedule.intersect(Schedule.recurs(2)),
  Schedule.jittered,
);

/**
 * Only transient failures are retried: a per-attempt timeout, or a provider/HTTP
 * failure the SDK marks retryable (429/5xx/network). 4xx-style errors (bad
 * request, auth, unknown model) fail immediately.
 */
const isTransient = (error: LlmError | LlmTimeoutError): boolean =>
  error._tag === "LlmTimeoutError" ||
  (APICallError.isInstance(error.cause) && error.cause.isRetryable);

const makeLlmService = (config: VercelAiConfig): Effect.Effect<LlmService, LlmConfigError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () => JSON.parse(readFileSync(config.secretsPath, "utf-8")) as unknown,
      catch: (cause) => new LlmConfigError({ cause, secretsPath: config.secretsPath }),
    });
    const secrets = yield* Schema.decodeUnknown(LlmSecrets)(raw).pipe(
      Effect.mapError((cause) => new LlmConfigError({ cause, secretsPath: config.secretsPath })),
    );
    const llm = createOpenAI({ apiKey: secrets.LITELLM_API_KEY, baseURL: config.baseUrl });
    const timeout = Duration.decode(config.timeout ?? "60 seconds");
    const retrySchedule = config.retrySchedule ?? defaultRetrySchedule;
    return {
      generate: (input, systemPrompt) =>
        Effect.tryPromise({
          // The fiber's abort signal is threaded into the SDK, so a timeout or
          // interruption actually cancels the underlying HTTP call.
          try: (signal) =>
            generateText({
              model: llm(config.modelName),
              system: systemPrompt,
              prompt: input,
              abortSignal: signal,
              // Effect.retry below is the single retry authority; the SDK's own
              // internal retry (default 2) is disabled so attempts don't multiply.
              maxRetries: 0,
            }),
          catch: (cause) => new LlmError({ cause, model: config.modelName }),
        }).pipe(
          Effect.map((result) => ({
            text: result.text,
            usage: { input: result.usage.promptTokens, output: result.usage.completionTokens },
            model: config.modelName,
          })),
          Effect.timeoutFail({
            duration: timeout,
            onTimeout: () => new LlmTimeoutError({ model: config.modelName, timeout }),
          }),
          Effect.retry({ schedule: retrySchedule, while: isTransient }),
        ),
    } satisfies LlmService;
  });

/**
 * Live adapter layer for {@link LlmClient} over the Vercel AI SDK pointed at the
 * LiteLLM proxy. The secrets file is read and decoded at layer build, so a bad
 * config surfaces as `LlmConfigError` at startup — before any call is made.
 */
export const VercelAiClientLive = (
  config: VercelAiConfig,
): Layer.Layer<LlmClient, LlmConfigError> => Layer.effect(LlmClient, makeLlmService(config));
