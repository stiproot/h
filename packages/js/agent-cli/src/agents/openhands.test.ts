import { existsSync } from "node:fs";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  extractAgentMessageText,
  isActionEvent,
  isConversationError,
  parseOpenhandsEvent,
  openhandsJsonlParser,
  openhandsStrategy,
} from "./openhands.ts";
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

  it("omits LLM_MODEL when model is an empty string (defence in depth)", () => {
    const env = openhandsStrategy.prepareEnvironment!(baseRequest({ model: "" }));

    expect(env["LLM_MODEL"]).toBeUndefined();
  });

  // The direct substrate passes NO llmConfig on purpose (a run uses the operator's own
  // credentials), and openhands is the one agent whose model arrives through the ENVIRONMENT
  // rather than a --model flag. Gating the model on llmConfig made every direct `--agent
  // openhands` run die with "Missing required environment variable(s): LLM_MODEL".
  it("still delivers LLM_MODEL when there is no llmConfig (the direct substrate)", () => {
    const { llmConfig: _dropped, ...withoutConfig } = baseRequest({ model: "deepseek-v4-flash" });
    const env = openhandsStrategy.prepareEnvironment!(withoutConfig as never);

    expect(env["LLM_MODEL"]).toBe("openai/deepseek-v4-flash");
    // Key and base url are left to the ambient environment in that case, not invented.
    expect(env["LLM_API_KEY"]).toBeUndefined();
    expect(env["LLM_BASE_URL"]).toBeUndefined();
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

describe("openhands fatal-error events (its own shape, not claude's)", () => {
  const errLine = JSON.stringify({
    kind: "ConversationErrorEvent",
    source: "environment",
    code: "LLMBadRequestError",
    detail:
      "litellm.BadRequestError: OpenAIException - The supported API model names are " +
      "deepseek-v4-pro or deepseek-v4-flash, but you passed claude-sonnet-4-6.",
  });

  it("extracts the error the CLI reports while still exiting 0", () => {
    const failure = parseOpenhandsEvent(errLine);
    expect(isConversationError(failure)).toBe(true);
    if (isConversationError(failure)) {
      expect(failure.code).toBe("LLMBadRequestError");
      expect(failure.detail).toContain("you passed claude-sonnet-4-6");
    }
    expect(isConversationError(parseOpenhandsEvent(JSON.stringify({ kind: "ActionEvent" })))).toBe(
      false,
    );
    expect(isConversationError(parseOpenhandsEvent("│ a banner line │"))).toBe(false);
  });

  it("VETOES success so a fatal error is not recorded as a completed empty run", () => {
    // Regression (2026-07-27): openhands 400'd on a claude model id, exited 0, and the run was
    // stored `completed` with 26 bytes of output — the cause invisible to every consumer.
    const events: Parameters<typeof openhandsStrategy.extractMetrics>[0] = [];
    openhandsJsonlParser.parseLine(errLine, events, undefined);

    const metrics = openhandsStrategy.extractMetrics(events, baseRequest());
    expect(metrics.success).toBe(false);
    expect(metrics.stdout).toContain("LLMBadRequestError");
    expect(metrics.stdout).toContain("deepseek-v4-flash");
  });

  it("leaves success alone on a healthy stream", () => {
    const events: Parameters<typeof openhandsStrategy.extractMetrics>[0] = [];
    expect(openhandsStrategy.extractMetrics(events, baseRequest()).success).toBeUndefined();
  });
});

describe("openhandsStrategy.tallyToolCalls (ActionEvent is its unit of tool use)", () => {
  const tally = (lines: string[]): number =>
    lines.reduce(
      (n, line) =>
        openhandsStrategy.tallyToolCalls?.call(
          openhandsStrategy,
          n,
          parseOpenhandsEvent(line) as unknown as Record<string, unknown>,
        ) ?? n,
      0,
    );

  it("counts agent actions, ignoring observations, messages and banner noise", () => {
    expect(
      tally([
        JSON.stringify({ kind: "ActionEvent", tool_name: "file_editor" }),
        JSON.stringify({ kind: "ObservationEvent" }),
        JSON.stringify({ kind: "TaskAction" }),
        JSON.stringify({ kind: "ThinkAction" }),
        JSON.stringify({ kind: "MessageEvent", source: "agent" }),
        "│ a Rich banner line │",
      ]),
    ).toBe(3);
  });

  it("is exposed so the ledger records a real number, not the claude-shaped 0", () => {
    expect(typeof openhandsStrategy.tallyToolCalls).toBe("function");
  });

  it("classifies Action kinds without mistaking Observation/Message for tool use", () => {
    const action = (kind: string) => isActionEvent(parseOpenhandsEvent(JSON.stringify({ kind })));
    expect(action("ActionEvent")).toBe(true);
    expect(action("TaskAction")).toBe(true);
    expect(action("FileEditorAction")).toBe(true);
    expect(action("ObservationEvent")).toBe(false);
    expect(action("ThinkObservation")).toBe(false);
    expect(isActionEvent(parseOpenhandsEvent("not json at all"))).toBe(false);
  });
});
