import type { AgentStreamParser, AgentStrategy, InvocationResult, StreamEvent } from "./types.ts";
import { createMissingEnvResult, resolveEnvValue } from "./shared.ts";

// pi --mode json streams JSONL. The agent's final text arrives as
// message_update/text_delta events concatenated on the ledger side.
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
  } catch {}
  return null;
}

type PiProvider = "deepseek" | "anthropic" | "openai";

// pi selects its backend from the model's optional "provider/id" prefix. Resolve a (provider,
// modelId) pair the runner passes as `--provider <provider> --model <modelId>`, and that
// prepareEnvironment uses to route the API key to the provider-specific env var. A bare id is
// mapped by name (deepseek-* / claude-* have native pi providers; anything else → openai). pi's
// deepseek + anthropic providers use their NATIVE endpoints; only openai honors a custom base URL.
function resolvePiModel(model?: string): { provider: PiProvider; modelId: string } {
  const m = model ?? "deepseek-v4-flash";
  const slash = m.indexOf("/");
  if (slash !== -1) {
    const prov = m.slice(0, slash);
    const provider: PiProvider =
      prov === "deepseek" || prov === "anthropic" || prov === "openai" ? prov : "openai";
    return { provider, modelId: m.slice(slash + 1) };
  }
  if (m.startsWith("claude") || m.startsWith("anthropic"))
    return { provider: "anthropic", modelId: m };
  if (m.startsWith("deepseek")) return { provider: "deepseek", modelId: m };
  return { provider: "openai", modelId: m };
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
      } catch {}
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

    const { provider } = resolvePiModel(model);
    const env: Record<string, string> = {};

    // Route the API key to the provider-specific env var pi reads.
    const keyVar =
      provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : provider === "deepseek"
          ? "DEEPSEEK_API_KEY"
          : "OPENAI_API_KEY";
    env[keyVar] = llmConfig.apiKey;
    // Only pi's openai provider honors a custom base URL (an openai-compatible proxy); deepseek and
    // anthropic use their native endpoints.
    if (provider === "openai" && llmConfig.baseUrl) env["OPENAI_BASE_URL"] = llmConfig.baseUrl;

    return env;
  },

  buildInvocation(request) {
    const { provider, modelId } = resolvePiModel(request.model);
    // pi 0.80 CLI: `-p` is non-interactive (process the prompt and exit) and reads the prompt from
    // STDIN — E2BIG-safe, so no temp task file. `--approve` trusts the worktree's project-local pi
    // files for this run; `--mode json` streams the JSONL the parser below consumes.
    return Promise.resolve({
      command: "pi",
      args: ["-p", "--mode", "json", "--approve", "--provider", provider, "--model", modelId],
      stdinInput: request.taskPrompt,
      streamParser: piJsonlParser,
    });
  },

  extractSessionId(events: StreamEvent[]) {
    return events.find((e) => e.session_id)?.session_id;
  },

  extractMetrics(_events: StreamEvent[], _request): Partial<InvocationResult> {
    // pi --mode json does not emit token usage; costUsd remains unknown.
    // Do NOT invent a fake $0 — the watcher handles a costGap.
    return {};
  },
};
