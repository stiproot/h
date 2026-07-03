import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Duration, Effect, Schema } from "effect";

import type { AgentInvocationRequest, LiteLlmError } from "../agents/types.ts";
import {
  LiteLlmCheckError,
  LiteLlmModelUnavailableError,
  LiteLlmTimeoutError,
} from "../agents/types.ts";

const LITELLM_CHECK_TIMEOUT_MS = 30_000;

const ModelsResponse = Schema.Struct({
  data: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
});

/**
 * When an LLM proxy base URL is configured, verify the requested model is
 * served by the LiteLLM proxy before invoking the agent CLI; otherwise pass
 * the model through untouched.
 */
export function adaptToLiteLlmEffect(
  request: Pick<AgentInvocationRequest, "llmConfig">,
  model: string,
): Effect.Effect<string, LiteLlmError, HttpClient.HttpClient> {
  const { llmConfig } = request;
  if (!llmConfig?.baseUrl) return Effect.succeed(model);

  const baseUrl = llmConfig.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/v1/models`;

  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${llmConfig.apiKey}`),
        ),
      )
      .pipe(Effect.mapError((cause) => new LiteLlmCheckError({ url, cause })));

    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new LiteLlmCheckError({ url, status: response.status, body });
    }

    const json = yield* response.json.pipe(
      Effect.mapError((cause) => new LiteLlmCheckError({ url, status: response.status, cause })),
    );
    const decoded = yield* Schema.decodeUnknown(ModelsResponse)(json).pipe(
      Effect.mapError((cause) => new LiteLlmCheckError({ url, status: response.status, cause })),
    );

    const available = decoded.data?.map((entry) => entry.id) ?? [];
    if (!available.includes(model)) {
      return yield* new LiteLlmModelUnavailableError({ model, available });
    }

    return model;
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(LITELLM_CHECK_TIMEOUT_MS),
      onTimeout: () => new LiteLlmTimeoutError({ url, timeoutMs: LITELLM_CHECK_TIMEOUT_MS }),
    }),
  );
}
