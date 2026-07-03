import { Context, Data } from "effect";
import type { Duration, Effect } from "effect";

/** Result of one LLM generation: the text plus token usage and the model that produced it. */
export interface LlmGeneration {
  readonly text: string;
  readonly usage: { readonly input: number; readonly output: number };
  readonly model: string;
}

/** The LLM call failed (network, provider error, bad response). `cause` carries the raw SDK failure. */
export class LlmError extends Data.TaggedError("LlmError")<{
  readonly cause: unknown;
  readonly model: string;
}> {}

/** A single LLM call attempt did not complete within the configured timeout. */
export class LlmTimeoutError extends Data.TaggedError("LlmTimeoutError")<{
  readonly model: string;
  readonly timeout: Duration.Duration;
}> {}

/**
 * The Effect-shaped LLM port behind {@link LlmClient}: failures are named in
 * the error channel instead of thrown, and `R = never` — the adapter captures its
 * own dependencies at layer build.
 */
export interface LlmService {
  readonly generate: (
    input: string,
    systemPrompt?: string,
  ) => Effect.Effect<LlmGeneration, LlmError | LlmTimeoutError>;
}

/** Service tag for the LLM port. Yield it to generate: `const llm = yield* LlmClient`. */
export class LlmClient extends Context.Tag("LlmClient")<LlmClient, LlmService>() {}
