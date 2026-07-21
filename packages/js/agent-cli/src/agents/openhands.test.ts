import { existsSync } from "node:fs";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { extractAgentMessageText, openhandsStrategy } from "./openhands.ts";
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

describe("openhandsStrategy.buildInvocation", () => {
  it("writes the task to a temp file and exposes a cleanup that removes it", async () => {
    const invocation = await Effect.runPromise(openhandsStrategy.buildInvocation(baseRequest()));
    const taskFile = invocation.args[invocation.args.indexOf("--file") + 1]!;

    expect(existsSync(taskFile)).toBe(true);
    await invocation.cleanup?.();
    expect(existsSync(taskFile)).toBe(false);
  });
});

describe("extractAgentMessageText", () => {
  it("extracts the text of an agent MessageEvent (the final answer)", () => {
    const line = JSON.stringify({
      source: "agent",
      kind: "MessageEvent",
      llm_message: { role: "assistant", content: [{ type: "text", text: "the plan" }] },
    });

    expect(extractAgentMessageText(line)).toBe("the plan");
  });

  it("ignores the user's echoed message, tool events, and the non-JSON banner", () => {
    const userMsg = JSON.stringify({
      source: "user",
      kind: "MessageEvent",
      llm_message: { content: [{ type: "text", text: "do the task" }] },
    });
    const action = JSON.stringify({
      source: "agent",
      kind: "ActionEvent",
      tool_name: "file_editor",
    });

    expect(extractAgentMessageText(userMsg)).toBeNull();
    expect(extractAgentMessageText(action)).toBeNull();
    expect(extractAgentMessageText("│ - github_list_tags: List git tags │")).toBeNull();
  });
});
