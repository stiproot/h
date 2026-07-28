import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import type { AgentStreamParser, AgentStrategy, InvocationResult, StreamEvent } from "./types.ts";
import { createMissingEnvResult, resolveEnvValue } from "./shared.ts";

// OpenHands --json streams JSONL events plus a human-readable banner. The returned output must be
// only the agent's final message text — the full transcript bloated to ~130KB and blew past the OS
// single-arg limit (E2BIG) when interpolated into the next step's task.
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
  } catch {}
  return null;
}

/**
 * OpenHands' own event vocabulary, observed from captured runs (2026-07-27): a working run emits
 * `ActionEvent`/`ObservationEvent` pairs (plus `TaskAction`/`ThinkAction` specialisations) and
 * `MessageEvent`; a run the LLM rejected emits `MessageEvent` + `ConversationErrorEvent` and
 * nothing else — while the process still exits 0.
 */
export interface OpenhandsErrorEvent {
  code: string;
  detail: string;
}

/** The fatal-error event, or null. `source: "environment"` — the runtime, not the agent. */
export function extractConversationError(line: string): OpenhandsErrorEvent | null {
  try {
    const ev = JSON.parse(line) as { kind?: string; code?: string; detail?: string };
    if (ev.kind !== "ConversationErrorEvent") return null;
    return { code: ev.code ?? "unknown", detail: ev.detail ?? "" };
  } catch {
    return null;
  }
}

/** True when the line is an agent ACTION — openhands' unit of tool use. */
export function isOpenhandsActionEvent(line: string): boolean {
  try {
    const kind = (JSON.parse(line) as { kind?: string }).kind ?? "";
    // ActionEvent is the base; TaskAction/ThinkAction/… are its specialisations.
    return kind === "ActionEvent" || (kind.endsWith("Action") && kind !== "Action");
  } catch {
    return false;
  }
}

export const openhandsJsonlParser: AgentStreamParser = {
  parseLine(line, events, onEvent) {
    if (!line.trim()) return;
    onEvent?.({ type: "output", text: line });

    // A fatal error the CLI reports as an EVENT while exiting 0 — recorded so extractMetrics can
    // veto success. Without it the run is reported completed with empty output (see 2026-07-27:
    // a claude model id sent to DeepSeek 400'd and the failure was invisible).
    const failure = extractConversationError(line);
    if (failure) {
      events.push({
        type: "result",
        subtype: "error",
        is_error: true,
        result: `openhands ${failure.code}: ${failure.detail}`,
      });
      return;
    }

    const text = extractAgentMessageText(line);
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

  buildInvocation(request) {
    // Use --file to avoid the OS single-argument limit (E2BIG on posix_spawn).
    const taskFile = join(tmpdir(), `openhands-task-${randomUUID()}.md`);
    return Effect.promise(() => writeFile(taskFile, request.taskPrompt, "utf-8")).pipe(
      Effect.as({
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
      }),
    );
  },

  extractSessionId(_events: StreamEvent[]) {
    return undefined;
  },

  extractMetrics(events: StreamEvent[], _request): Partial<InvocationResult> {
    // Veto success when the CLI reported a fatal error event — it exits 0 regardless, so without
    // this the caller sees `completed` with no output and no cause.
    const failure = events.find((event) => event.type === "result" && event.is_error);
    if (failure) return { success: false, stdout: failure.result ?? "openhands reported an error" };
    return {};
  },

  // openhands' verified shape: each agent ACTION is one tool call. Counted off the raw stdout
  // lines the ledger sees (`{type:"output", text:<json line>}`), which is where its JSONL lands.
  tallyToolCalls(current, event) {
    const text = (event as { text?: unknown }).text;
    return typeof text === "string" && isOpenhandsActionEvent(text) ? current + 1 : current;
  },
};
