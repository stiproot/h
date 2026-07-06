import type { AgentStreamParser, AgentStrategy, InvocationResult, StreamEvent } from "./types.ts";
import { createMissingEnvResult, resolveEnvValue } from "./shared.ts";

const rawStdoutParser: AgentStreamParser = {
  parseChunk(buffer, chunk, events, onEvent) {
    const combined = buffer + chunk;
    const lines = combined.split("\n");
    const remainder = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent?.({ type: "output", text: line });
      events.push({
        type: "assistant",
        message: { content: [{ type: "text", text: line }] },
      });
    }

    return remainder;
  },
  flushBuffer(buffer, events, onEvent) {
    if (!buffer.trim()) return;
    onEvent?.({ type: "output", text: buffer });
    events.push({
      type: "assistant",
      message: { content: [{ type: "text", text: buffer }] },
    });
  },
};

export const openhandsStrategy: AgentStrategy = {
  type: "openhands",
  name: "OpenHands",

  validateEnvironment(effectiveEnv, processEnv) {
    if (
      !resolveEnvValue(effectiveEnv, "LLM_API_KEY") &&
      !resolveEnvValue(processEnv, "LLM_API_KEY")
    ) {
      return createMissingEnvResult("OpenHands", "LLM_API_KEY");
    }
    return null;
  },

  prepareEnvironment(request) {
    const { llmConfig } = request;
    if (!llmConfig) return {};

    const env: Record<string, string> = { LLM_API_KEY: llmConfig.apiKey };
    if (llmConfig.baseUrl) env["LLM_BASE_URL"] = llmConfig.baseUrl;
    // A model already carrying a LiteLLM provider prefix (e.g. `anthropic/…`, `deepseek/…`)
    // routes as-is; a bare id (e.g. `deepseek-v4-flash`) is treated as an OpenAI-compatible
    // endpoint reached via LLM_BASE_URL.
    if (request.model)
      env["LLM_MODEL"] = request.model.includes("/") ? request.model : `openai/${request.model}`;
    return env;
  },

  async buildInvocation(request) {
    return {
      command: "openhands",
      args: [
        "--task",
        request.taskPrompt,
        "--headless",
        "--json",
        "--always-approve",
        "--override-with-envs",
      ],
      streamParser: rawStdoutParser,
    };
  },

  extractSessionId(_events: StreamEvent[]) {
    return undefined;
  },

  extractMetrics(_events: StreamEvent[], _request): Partial<InvocationResult> {
    return {};
  },
};
