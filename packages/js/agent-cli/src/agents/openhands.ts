import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStreamParser, AgentStrategy, InvocationResult, StreamEvent } from "./types.ts";
import { createMissingEnvResult, resolveEnvValue } from "./shared.ts";

// OpenHands --json streams JSONL events plus a human-readable banner (e.g. its whole tool inventory).
// The run ledger (onEvent) still sees every raw line for debugging, but the RETURNED output must be
// only the agent's final message text: capturing the entire transcript (the old behaviour) bloated
// the result to ~130KB and, once interpolated into the next step's task, blew past the OS single-arg
// limit (E2BIG). Only a MessageEvent from source "agent" carries the agent's actual answer.
export function extractAgentMessageText(line: string): string | null {
  try {
    const ev = JSON.parse(line) as {
      kind?: string;
      source?: string;
      llm_message?: { content?: { type?: string; text?: string }[] };
    };
    if (ev.kind === "MessageEvent" && ev.source === "agent" && ev.llm_message?.content) {
      const text = ev.llm_message.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n");
      return text || null;
    }
  } catch {
    // Non-JSON banner/debug line — not part of the agent's answer.
  }
  return null;
}

const openhandsJsonlParser: AgentStreamParser = {
  parseChunk(buffer, chunk, events, onEvent) {
    const combined = buffer + chunk;
    const lines = combined.split("\n");
    const remainder = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent?.({ type: "output", text: line });
      const text = extractAgentMessageText(line);
      if (text) events.push({ type: "assistant", message: { content: [{ type: "text", text }] } });
    }

    return remainder;
  },
  flushBuffer(buffer, events, onEvent) {
    if (!buffer.trim()) return;
    onEvent?.({ type: "output", text: buffer });
    const text = extractAgentMessageText(buffer);
    if (text) events.push({ type: "assistant", message: { content: [{ type: "text", text }] } });
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
    // Pass the task via --file, not --task: a task carrying a prior step's output can exceed the OS
    // single-argument limit (E2BIG on posix_spawn). A file has no such limit.
    const taskFile = join(tmpdir(), `openhands-task-${randomUUID()}.md`);
    await writeFile(taskFile, request.taskPrompt, "utf-8");
    return {
      command: "openhands",
      args: [
        "--file",
        taskFile,
        "--headless",
        "--json",
        "--always-approve",
        "--override-with-envs",
      ],
      streamParser: openhandsJsonlParser,
      cleanup: () => rm(taskFile, { force: true }),
    };
  },

  extractSessionId(_events: StreamEvent[]) {
    return undefined;
  },

  extractMetrics(_events: StreamEvent[], _request): Partial<InvocationResult> {
    return {};
  },
};
