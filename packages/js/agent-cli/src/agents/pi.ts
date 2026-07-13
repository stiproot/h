import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStreamParser, AgentStrategy, InvocationResult, StreamEvent } from "./types.ts";
import { createMissingEnvResult, resolveEnvValue } from "./shared.ts";

// pi --mode json streams JSONL events. The agent's final text arrives as a series of
// message_update events with assistantMessageEvent.type === "text_delta". Each delta is
// concatenated on the ledger side; here we surface each delta as an assistant StreamEvent
// so the run ledger's output captures the full response.
export function extractPiText(line: string): string | null {
  try {
    const ev = JSON.parse(line) as {
      type?: string;
      assistantMessageEvent?: { type?: string; delta?: string };
    };
    if (
      ev.type === "message_update" &&
      ev.assistantMessageEvent?.type === "text_delta" &&
      ev.assistantMessageEvent.delta
    ) {
      return ev.assistantMessageEvent.delta;
    }
  } catch {
    // Non-JSON banner/debug line — not part of the agent's answer.
  }
  return null;
}

// Resolve a model string for pi: bare id → openai/ prefix (routes via LiteLLM proxy);
// a provider-prefixed id (e.g. anthropic/…, openai/…) is passed through unchanged.
function resolvePiModel(model?: string): string {
  // claude-sonnet-4-6 is an Anthropic model — route it via the anthropic/ provider
  // (prepareEnvironment then forwards ANTHROPIC_API_KEY), not a bogus openai/ prefix.
  if (!model) return "anthropic/claude-sonnet-4-6";
  return model.includes("/") ? model : `openai/${model}`;
}

const piJsonlParser: AgentStreamParser = {
  parseChunk(buffer, chunk, events, onEvent) {
    const combined = buffer + chunk;
    const lines = combined.split("\n");
    const remainder = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent?.({ type: "output", text: line });

      try {
        const ev = JSON.parse(line) as { type?: string; id?: string };
        if (ev.type === "session") {
          events.push({ type: "session_start", session_id: ev.id });
        } else if (ev.type?.startsWith("tool_execution_")) {
          events.push({ type: "tool_use" });
        } else {
          const text = extractPiText(line);
          if (text)
            events.push({ type: "assistant", message: { content: [{ type: "text", text }] } });
        }
      } catch {
        // Non-JSON line — already surfaced via onEvent above.
      }
    }

    return remainder;
  },
  flushBuffer(buffer, events, onEvent) {
    if (!buffer.trim()) return;
    onEvent?.({ type: "output", text: buffer });
    const text = extractPiText(buffer);
    if (text) events.push({ type: "assistant", message: { content: [{ type: "text", text }] } });
  },
};

export const piStrategy: AgentStrategy = {
  type: "pi",
  name: "Pi",

  validateEnvironment(effectiveEnv, processEnv) {
    const hasKey =
      resolveEnvValue(effectiveEnv, "ANTHROPIC_API_KEY") ??
      resolveEnvValue(effectiveEnv, "OPENAI_API_KEY") ??
      resolveEnvValue(effectiveEnv, "LLM_API_KEY") ??
      resolveEnvValue(processEnv as Record<string, string | undefined>, "ANTHROPIC_API_KEY") ??
      resolveEnvValue(processEnv as Record<string, string | undefined>, "OPENAI_API_KEY") ??
      resolveEnvValue(processEnv as Record<string, string | undefined>, "LLM_API_KEY");
    if (!hasKey) {
      return createMissingEnvResult("Pi", "ANTHROPIC_API_KEY or OPENAI_API_KEY or LLM_API_KEY");
    }
    return null;
  },

  prepareEnvironment(request) {
    const { llmConfig, model } = request;
    if (!llmConfig) return {};

    const resolved = resolvePiModel(model);
    const env: Record<string, string> = {};

    // Route the API key to the correct provider env var pi expects.
    if (resolved.startsWith("anthropic/")) {
      env["ANTHROPIC_API_KEY"] = llmConfig.apiKey;
    } else {
      env["OPENAI_API_KEY"] = llmConfig.apiKey;
    }
    if (llmConfig.baseUrl) env["OPENAI_BASE_URL"] = llmConfig.baseUrl;

    return env;
  },

  async buildInvocation(request) {
    // Pass the task via --file, not inline: a task carrying a prior step's output can exceed
    // the OS single-argument limit (E2BIG on posix_spawn). A file has no such limit.
    const taskFile = join(tmpdir(), `pi-task-${randomUUID()}.md`);
    await writeFile(taskFile, request.taskPrompt, "utf-8");
    const model = resolvePiModel(request.model);
    return {
      command: "pi",
      args: ["--mode", "json", "--approve", "--model", model, "--file", taskFile],
      streamParser: piJsonlParser,
      cleanup: () => rm(taskFile, { force: true }),
    };
  },

  extractSessionId(events: StreamEvent[]) {
    return events.find((e) => e.session_id)?.session_id;
  },

  extractMetrics(_events: StreamEvent[], _request): Partial<InvocationResult> {
    // pi --mode json does not emit token usage; costUsd remains unknown.
    // The watcher engine already handles a costGap — do NOT invent a fake $0.
    return {};
  },
};
