import { Effect } from "effect";

import type { AgentStreamParser, AgentStrategy, InvocationResult, StreamEvent } from "./types.ts";
import { createMissingEnvResult, resolveEnvValue } from "./shared.ts";

// Codex streams JSONL events. Map each known event type to the standard StreamEvent vocabulary.
const codexJsonlParser: AgentStreamParser = {
  parseLine(line, events, onEvent) {
    if (!line.trim()) return;
    onEvent?.({ type: "output", text: line });

    try {
      const ev = JSON.parse(line) as {
        type?: string;
        thread_id?: string;
        item?: {
          type?: string;
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
        usage?: {
          prompt_tokens?: number;
          cached_tokens?: number;
          output_tokens?: number;
        };
        error?: string;
      };

      switch (ev.type) {
        case "thread.started":
          events.push({ type: "session_start", session_id: ev.thread_id });
          break;
        case "item.completed":
          if (ev.item?.type === "message") {
            events.push({
              type: "assistant",
              message: {
                content: (ev.item.content ?? []).map((c) => ({
                  type: c.type ?? "text",
                  text: c.text,
                })),
              },
            });
          } else if (ev.item?.type === "function_call") {
            events.push({ type: "tool_use" });
          }
          break;
        case "turn.completed":
          events.push({
            type: "result",
            usage: {
              input_tokens: ev.usage?.prompt_tokens,
              output_tokens: ev.usage?.output_tokens,
              cached_input_tokens: ev.usage?.cached_tokens,
            },
          });
          break;
        case "error":
          events.push({ type: "error", result: ev.error });
          break;
      }
    } catch {}
  },
};

export const codexStrategy: AgentStrategy = {
  type: "codex",
  name: "Codex",

  validateEnvironment(effectiveEnv, processEnv) {
    const hasKey =
      resolveEnvValue(effectiveEnv, "OPENAI_API_KEY") ??
      resolveEnvValue(processEnv as Record<string, string | undefined>, "OPENAI_API_KEY");
    if (!hasKey) {
      return createMissingEnvResult("Codex", "OPENAI_API_KEY");
    }
    return null;
  },

  prepareEnvironment(_request) {
    return {};
  },

  buildInvocation(request) {
    const model = request.model ?? "o4-mini";
    return Effect.succeed({
      command: "codex",
      args: [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--cd",
        request.cwd,
        "--model",
        model,
        request.taskPrompt,
      ],
      streamParser: codexJsonlParser,
    });
  },

  extractSessionId(events: StreamEvent[]) {
    return events.find((e) => e.type === "session_start")?.session_id;
  },

  extractMetrics(events: StreamEvent[]): Partial<InvocationResult> {
    const resultEvent = events.find((e) => e.type === "result");
    if (!resultEvent?.usage) return {};
    const { input_tokens, output_tokens, cached_input_tokens } = resultEvent.usage;
    return {
      tokenUsage: {
        input: (input_tokens ?? 0) + (cached_input_tokens ?? 0),
        output: output_tokens ?? 0,
      },
      // costUsd is intentionally omitted — Codex does not report it.
    };
  },
};
