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
  it("routes a bare deepseek model to the deepseek provider (DEEPSEEK_API_KEY)", () => {
    const env = piStrategy.prepareEnvironment!(baseRequest({ model: "deepseek-v4-flash" }));

    expect(env["DEEPSEEK_API_KEY"]).toBe("sk-test");
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("routes an anthropic-prefixed (or bare claude) model to ANTHROPIC_API_KEY", () => {
    for (const model of ["anthropic/claude-sonnet-4-6", "claude-sonnet-4-6"]) {
      const env = piStrategy.prepareEnvironment!(baseRequest({ model }));
      expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test");
      expect(env["OPENAI_API_KEY"]).toBeUndefined();
    }
  });

  it("sets OPENAI_API_KEY for an openai-prefixed model", () => {
    const env = piStrategy.prepareEnvironment!(baseRequest({ model: "openai/gpt-4o" }));

    expect(env["OPENAI_API_KEY"]).toBe("sk-test");
  });

  it("forwards the base url as OPENAI_BASE_URL only for the openai provider", () => {
    const openai = piStrategy.prepareEnvironment!(baseRequest({ model: "openai/gpt-4o" }));
    expect(openai["OPENAI_BASE_URL"]).toBe("https://api.litellm.test/v1");
    // deepseek uses its native endpoint — a base url is never forwarded for it
    const deepseek = piStrategy.prepareEnvironment!(baseRequest({ model: "deepseek-v4-flash" }));
    expect(deepseek["OPENAI_BASE_URL"]).toBeUndefined();
  });

  it("omits OPENAI_BASE_URL when llmConfig has no baseUrl", () => {
    const env = piStrategy.prepareEnvironment!(
      baseRequest({ llmConfig: { apiKey: "sk-test" }, model: "openai/gpt-4o" }),
    );

    expect(env["OPENAI_BASE_URL"]).toBeUndefined();
  });
});

describe("piStrategy.buildInvocation", () => {
  it("runs pi non-interactively (-p) in json mode with --provider and --model", async () => {
    const invocation = await piStrategy.buildInvocation!(
      baseRequest({ model: "anthropic/claude-sonnet-4-6" }),
    );

    expect(invocation.command).toBe("pi");
    expect(invocation.args).toContain("-p");
    expect(invocation.args).toContain("--mode");
    expect(invocation.args).toContain("json");
    expect(invocation.args).toContain("--approve");
    expect(invocation.args[invocation.args.indexOf("--provider") + 1]).toBe("anthropic");
    expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
    expect(invocation.args).not.toContain("--file");
  });

  it("resolves a bare deepseek model to --provider deepseek --model <id>", async () => {
    const invocation = await piStrategy.buildInvocation!(
      baseRequest({ model: "deepseek-v4-flash" }),
    );

    expect(invocation.args[invocation.args.indexOf("--provider") + 1]).toBe("deepseek");
    expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("deepseek-v4-flash");
  });

  it("defaults an absent model to the deepseek provider", async () => {
    const invocation = await piStrategy.buildInvocation!(baseRequest());

    expect(invocation.args[invocation.args.indexOf("--provider") + 1]).toBe("deepseek");
    expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("deepseek-v4-flash");
  });

  it("passes the task via stdin (E2BIG-safe), not a temp file", async () => {
    const invocation = await piStrategy.buildInvocation!(
      baseRequest({ taskPrompt: "implement X" }),
    );

    expect(invocation.stdinInput).toBe("implement X");
    expect(invocation.args).not.toContain("--file");
    expect(invocation.cleanup).toBeUndefined();
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
