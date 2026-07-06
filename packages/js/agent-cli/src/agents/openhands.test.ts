import { describe, expect, it } from "vitest";

import { openhandsStrategy } from "./openhands.ts";
import type { AgentInvocationRequest } from "./types.ts";

function baseRequest(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    systemPrompt: "",
    taskPrompt: "do the thing",
    cwd: "/tmp",
    env: {},
    effectiveEnv: {},
    timeout: 1000,
    llmConfig: { apiKey: "sk-test", baseUrl: "https://api.deepseek.com/v1" },
    ...overrides,
  };
}

describe("openhandsStrategy.prepareEnvironment LLM_MODEL routing", () => {
  it("prefixes a bare model id with openai/ (OpenAI-compatible endpoint via LLM_BASE_URL)", () => {
    const env = openhandsStrategy.prepareEnvironment!(baseRequest({ model: "deepseek-v4-flash" }));

    expect(env["LLM_MODEL"]).toBe("openai/deepseek-v4-flash");
  });

  it("passes a provider-prefixed model through unchanged", () => {
    const anthropic = openhandsStrategy.prepareEnvironment!(
      baseRequest({ model: "anthropic/claude-sonnet-4-6" }),
    );
    const deepseek = openhandsStrategy.prepareEnvironment!(
      baseRequest({ model: "deepseek/deepseek-v4-flash" }),
    );

    expect(anthropic["LLM_MODEL"]).toBe("anthropic/claude-sonnet-4-6");
    expect(deepseek["LLM_MODEL"]).toBe("deepseek/deepseek-v4-flash");
  });

  it("forwards the LLM api key and base url", () => {
    const env = openhandsStrategy.prepareEnvironment!(baseRequest({ model: "deepseek-v4-flash" }));

    expect(env["LLM_API_KEY"]).toBe("sk-test");
    expect(env["LLM_BASE_URL"]).toBe("https://api.deepseek.com/v1");
  });
});
