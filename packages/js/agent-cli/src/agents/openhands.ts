import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import type {
  AgentStreamParser,
  AgentStrategy,
  InvocationResult,
  RawLineEvent,
  StreamEvent,
} from "./types.ts";
import { rawLineEvent } from "./types.ts";
import { createMissingEnvResult, resolveEnvValue } from "./shared.ts";

// ---------------------------------------------------------------------------------------------
// OpenHands' own event vocabulary — what its CLI actually emits, so what the run ledger records is
// the agent's shape rather than a re-wrapping of it.
//
// Discriminated on `kind`. The set is OPEN by design: a working run was observed emitting
// ActionEvent/ObservationEvent + Task*/Think* specialisations (2026-07-27), and a later implement
// run added FileEditorAction/TerminalAction — kinds nothing had predicted. So known kinds are
// modelled precisely and everything else keeps its `kind` under OpenhandsOtherEvent instead of
// being dropped or coerced. The run summary's `eventShape` histogram is how new kinds surface.
// ---------------------------------------------------------------------------------------------

interface OpenhandsEventBase {
  kind: string;
  source?: string;
  id?: string;
  timestamp?: string;
}

/** The agent (or user) speaking. `llm_message.content` carries the text. */
export interface OpenhandsMessageEvent extends OpenhandsEventBase {
  kind: "MessageEvent";
  llm_message?: { content?: { type?: string; text?: string }[] };
}

/** An agent ACTION — openhands' unit of tool use. `kind` ends in "Action". */
export interface OpenhandsActionEvent extends OpenhandsEventBase {
  tool_name?: string;
  tool_call_id?: string;
}

/** The result of an action. `kind` ends in "Observation". */
export type OpenhandsObservationEvent = OpenhandsEventBase;

/**
 * A FATAL error the CLI reports as an event — while still exiting 0. `source: "environment"`
 * (the runtime, not the agent). Ignoring it is how a rejected model id was once recorded as a
 * completed run with empty output.
 */
export interface OpenhandsConversationErrorEvent extends OpenhandsEventBase {
  kind: "ConversationErrorEvent";
  code: string;
  detail: string;
}

/** A JSON event whose `kind` we do not model yet — preserved verbatim, never coerced. */
export type OpenhandsOtherEvent = OpenhandsEventBase;

export type OpenhandsEvent =
  | OpenhandsMessageEvent
  | OpenhandsActionEvent
  | OpenhandsObservationEvent
  | OpenhandsConversationErrorEvent
  | OpenhandsOtherEvent
  | RawLineEvent;

/**
 * True when this event is an agent ACTION (openhands' unit of tool use).
 *
 * `ActionEvent` is the BASE kind and must be matched by name — note it ends in "Event", not
 * "Action", so an `endsWith("Action")` test alone silently misses it. The specialisations
 * (`TaskAction`, `ThinkAction`, `FileEditorAction`, `TerminalAction`, …) are the ones that end
 * in "Action". A bare `"Action"` is excluded as a non-kind.
 */
export function isActionEvent(event: OpenhandsEvent): event is OpenhandsActionEvent {
  const kind = (event as OpenhandsEventBase).kind;
  if (typeof kind !== "string") return false;
  return kind === "ActionEvent" || (kind.endsWith("Action") && kind !== "Action");
}

/** True when this event is the fatal ConversationErrorEvent. */
export function isConversationError(
  event: OpenhandsEvent,
): event is OpenhandsConversationErrorEvent {
  return (event as OpenhandsEventBase).kind === "ConversationErrorEvent";
}

/** One stdout line → openhands' native event, or a `raw` event when the line is not its JSON. */
export function parseOpenhandsEvent(line: string): OpenhandsEvent {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { kind?: unknown }).kind === "string"
    ) {
      return parsed as OpenhandsEvent;
    }
  } catch {
    // Not JSON — a banner or Rich-drawn box line.
  }
  return rawLineEvent(line);
}

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

export const openhandsJsonlParser: AgentStreamParser = {
  parseLine(line, events, onEvent) {
    if (!line.trim()) return;

    // The LEDGER gets openhands' OWN event — parsed, typed, verbatim. It used to get
    // `{type:"output", text: line}`, which made every line of the stream look like a uniform
    // `output` event with the real event buried as an escaped string inside `text`.
    const event = parseOpenhandsEvent(line);
    onEvent?.(event as unknown as Record<string, unknown>);

    // A fatal error the CLI reports as an EVENT while exiting 0 — recorded so extractMetrics can
    // veto success. Without it the run is reported completed with empty output (see 2026-07-27:
    // a claude model id sent to DeepSeek 400'd and the failure was invisible).
    if (isConversationError(event)) {
      events.push({
        type: "result",
        subtype: "error",
        is_error: true,
        result: `openhands ${event.code ?? "unknown"}: ${event.detail ?? ""}`,
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

  // openhands' verified shape: each agent ACTION is one tool call. Reads the TYPED native event
  // the parser now emits — no re-parsing a string out of a wrapper.
  tallyToolCalls(current, event) {
    return isActionEvent(event as unknown as OpenhandsEvent) ? current + 1 : current;
  },
};
