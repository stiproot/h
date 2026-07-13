import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractPiText, piStrategy } from "./pi.ts";
import type { AgentInvocationRequest } from "./types.ts";

function baseRequest(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    systemPrompt: "",
    taskPrompt: "do the thing",
    cwd: "/tmp",
    env: {},
    effectiveEnv: {},
    timeout: 1000,
    llmConfig: { apiKey: "sk-test", baseUrl: "https://api.litellm.test/v1" },
    ...overrides,
  };
}

describe("piStrategy.prepareEnvironment model routing", () => {
  it("prefixes a bare model id with openai/ and sets OPENAI_API_KEY", () => {
    const env = piStrategy.prepareEnvironment!(baseRequest({ model: "deepseek-v4-flash" }));

    expect(env["OPENAI_API_KEY"]).toBe("sk-test");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("sets ANTHROPIC_API_KEY when the model is anthropic-prefixed", () => {
    const env = piStrategy.prepareEnvironment!(
      baseRequest({ model: "anthropic/claude-sonnet-4-6" }),
    );

    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test");
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
  });

  it("passes a provider-prefixed openai model through and sets OPENAI_API_KEY", () => {
    const env = piStrategy.prepareEnvironment!(baseRequest({ model: "openai/gpt-4o" }));

    expect(env["OPENAI_API_KEY"]).toBe("sk-test");
  });

  it("forwards the base url as OPENAI_BASE_URL", () => {
    const env = piStrategy.prepareEnvironment!(baseRequest({ model: "deepseek-v4-flash" }));

    expect(env["OPENAI_BASE_URL"]).toBe("https://api.litellm.test/v1");
  });

  it("omits OPENAI_BASE_URL when llmConfig has no baseUrl", () => {
    const env = piStrategy.prepareEnvironment!(
      baseRequest({ llmConfig: { apiKey: "sk-test" }, model: "openai/gpt-4o" }),
    );

    expect(env["OPENAI_BASE_URL"]).toBeUndefined();
  });
});

describe("piStrategy.buildInvocation", () => {
  it("includes --mode json, --approve, --model, and --file in args", async () => {
    const invocation = await piStrategy.buildInvocation!(
      baseRequest({ model: "anthropic/claude-sonnet-4-6" }),
    );

    expect(invocation.command).toBe("pi");
    expect(invocation.args).toContain("--mode");
    expect(invocation.args).toContain("json");
    expect(invocation.args).toContain("--approve");
    expect(invocation.args).toContain("--model");
    expect(invocation.args).toContain("anthropic/claude-sonnet-4-6");
    expect(invocation.args).toContain("--file");
  });

  it("prefixes a bare model with openai/ in args", async () => {
    const invocation = await piStrategy.buildInvocation!(
      baseRequest({ model: "deepseek-v4-flash" }),
    );

    const modelIdx = invocation.args.indexOf("--model");
    expect(invocation.args[modelIdx + 1]).toBe("openai/deepseek-v4-flash");
  });

  it("defaults an absent model to the anthropic/ provider (a resolvable model)", async () => {
    const invocation = await piStrategy.buildInvocation!(baseRequest());

    const modelIdx = invocation.args.indexOf("--model");
    expect(invocation.args[modelIdx + 1]).toBe("anthropic/claude-sonnet-4-6");
  });

  it("writes the task to a temp file and exposes a cleanup that removes it", async () => {
    const invocation = await piStrategy.buildInvocation!(baseRequest());
    const taskFile = invocation.args[invocation.args.indexOf("--file") + 1]!;

    expect(existsSync(taskFile)).toBe(true);
    await invocation.cleanup?.();
    expect(existsSync(taskFile)).toBe(false);
  });
});

describe("extractPiText", () => {
  it("extracts the delta from a message_update / text_delta event", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "the plan" },
    });

    expect(extractPiText(line)).toBe("the plan");
  });

  it("returns null for tool_execution events", () => {
    const line = JSON.stringify({ type: "tool_execution_start", toolName: "bash" });

    expect(extractPiText(line)).toBeNull();
  });

  it("returns null for session events", () => {
    const line = JSON.stringify({ type: "session", id: "sess-abc" });

    expect(extractPiText(line)).toBeNull();
  });

  it("returns null for non-JSON banner lines", () => {
    expect(extractPiText("pi-coding-agent v0.1.0")).toBeNull();
  });

  it("returns null for agent_end", () => {
    const line = JSON.stringify({ type: "agent_end" });

    expect(extractPiText(line)).toBeNull();
  });
});

describe("piStrategy.extractSessionId", () => {
  it("returns the session id from a session_start StreamEvent", () => {
    const id = piStrategy.extractSessionId([
      { type: "something_else" },
      { type: "session_start", session_id: "sess-123" },
    ]);

    expect(id).toBe("sess-123");
  });

  it("returns undefined when no session_id is present", () => {
    expect(piStrategy.extractSessionId([{ type: "assistant" }])).toBeUndefined();
  });
});
