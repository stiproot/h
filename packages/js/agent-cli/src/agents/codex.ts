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
// Codex's own event vocabulary — what the run ledger records, so events.jsonl is the agent's shape
// rather than a re-wrapping of it. Discriminated on `type`; open by design, so an unmodelled type
// keeps its `type` under CodexOtherEvent instead of being coerced or dropped.
// ---------------------------------------------------------------------------------------------

interface CodexEventBase {
  type: string;
}

/** Thread announcement — `thread_id` is the session id. */
export interface CodexThreadStartedEvent extends CodexEventBase {
  type: "thread.started";
  thread_id?: string;
}

/**
 * One completed item. `item.type` says what it was: `agent_message`/`message` (assistant text) or
 * `function_call`/`mcp_tool_call` (a TOOL CALL — codex's unit of tool use).
 */
export interface CodexItemCompletedEvent extends CodexEventBase {
  type: "item.completed";
  item?: {
    type?: string;
    role?: string;
    text?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

/** End of a turn, carrying token usage. */
export interface CodexTurnCompletedEvent extends CodexEventBase {
  type: "turn.completed";
  usage?: { prompt_tokens?: number; cached_tokens?: number; output_tokens?: number };
}

/** A JSON event whose `type` we do not model yet — preserved verbatim. */
export type CodexOtherEvent = CodexEventBase;

export type CodexEvent =
  | CodexThreadStartedEvent
  | CodexItemCompletedEvent
  | CodexTurnCompletedEvent
  | CodexOtherEvent
  | RawLineEvent;

/** Item types codex uses for a tool call — its unit of tool use. */
const CODEX_TOOL_ITEMS = new Set(["function_call", "mcp_tool_call"]);

/** True when this event is a completed TOOL CALL. */
export function isCodexToolCall(event: CodexEvent): event is CodexItemCompletedEvent {
  const ev = event as CodexItemCompletedEvent;
  return ev.type === "item.completed" && CODEX_TOOL_ITEMS.has(ev.item?.type ?? "");
}

/** One stdout line → codex's native event, or a `raw` event when the line is not its JSON. */
export function parseCodexEvent(line: string): CodexEvent {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as CodexEvent;
    }
  } catch {
    // Not JSON — codex interleaves plain lines with its JSONL stream.
  }
  return rawLineEvent(line);
}

// Codex streams JSONL events. Map each known event type to the standard StreamEvent vocabulary.
const codexJsonlParser: AgentStreamParser = {
  parseLine(line, events, onEvent) {
    if (!line.trim()) return;
    // The LEDGER gets codex's OWN event — parsed, typed, verbatim (not `{type:"output", text}`).
    onEvent?.(parseCodexEvent(line) as unknown as Record<string, unknown>);

    try {
      const ev = JSON.parse(line) as {
        type?: string;
        thread_id?: string;
        item?: {
          type?: string;
          role?: string;
          text?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
        // Two generations of field names: the older `prompt_tokens`/`cached_tokens`, and the
        // `input_tokens`/`cached_input_tokens` codex 0.60+ actually emits. Reading only the old
        // pair reported `tokens.input: 0` on every codex run (ledger local-260904-071251, 2026-09-04:
        // 38,268 input tokens on the wire, 0 in the envelope) — an unpriced run looked free.
        usage?: {
          prompt_tokens?: number;
          cached_tokens?: number;
          input_tokens?: number;
          cached_input_tokens?: number;
          output_tokens?: number;
        };
        // `error` is a STRING on the older `{type:"error", error}` shape and an OBJECT on
        // `turn.failed` (`{error: {message}}`); the current `{type:"error"}` carries `message`
        // at the top level instead. All three were observed on one run (see below).
        error?: string | { message?: string };
        message?: string;
      };

      switch (ev.type) {
        case "thread.started":
          events.push({ type: "session_start", session_id: ev.thread_id });
          break;
        case "item.completed": {
          const item = ev.item;
          // Codex emits assistant text as `agent_message` (flat `text` field — the common case,
          // including the final structured-output json block) OR `message` (a `content[]` array).
          // Both must become `assistant` events, or buildInvocationResult's textOutput is empty and
          // stdout falls back to "Process exited with code N" — losing the run's real output (and
          // the fenced json block the structured-output contract parses). Bit the codex e2e live.
          if (item?.type === "agent_message" || item?.type === "message") {
            const content = item.content
              ? item.content.map((c) => ({ type: c.type ?? "text", text: c.text }))
              : item.text !== undefined
                ? [{ type: "text", text: item.text }]
                : [];
            events.push({ type: "assistant", message: { content } });
          } else if (
            item?.type === "function_call" ||
            item?.type === "mcp_tool_call" ||
            // a shell command codex ran itself — the tool call a coding agent makes most
            item?.type === "command_execution"
          ) {
            events.push({ type: "tool_use" });
          }
          break;
        }
        case "turn.completed":
          events.push({
            type: "result",
            usage: {
              input_tokens: ev.usage?.input_tokens ?? ev.usage?.prompt_tokens,
              output_tokens: ev.usage?.output_tokens,
              cached_input_tokens: ev.usage?.cached_input_tokens ?? ev.usage?.cached_tokens,
            },
          });
          break;
        // The failure text lives in THREE places across codex versions, and the process exits
        // without any `turn.completed`, so a `result` event is synthesized from `turn.failed`:
        // the stop classifier and the failure report read resultEventText, and without it a
        // usage-limited codex run classified `failed` with stderr's incidental last line
        // ("Reading additional input from stdin...") as its error, while the real text —
        // "You've hit your usage limit … try again at 12:13 PM" — sat only in events.jsonl
        // (runs usr-block-svc-client:codex:1788515218860 and h-134-observed-text, 2026-09-04).
        // A limit read as a crash defeats the usage-limit fallback and the auto-deny fence.
        case "error":
          events.push({ type: "error", result: codexErrorText(ev) });
          break;
        case "turn.failed":
          events.push({ type: "result", is_error: true, result: codexErrorText(ev) });
          break;
      }
    } catch {}
  },
};

/** The error text of a codex `error` / `turn.failed` event, whichever field this version used. */
function codexErrorText(ev: {
  error?: string | { message?: string };
  message?: string;
}): string | undefined {
  if (typeof ev.error === "string") return ev.error;
  return ev.error?.message ?? ev.message;
}

export const codexStrategy: AgentStrategy = {
  type: "codex",
  name: "Codex",

  validateEnvironment(effectiveEnv, processEnv) {
    const hasKey =
      resolveEnvValue(effectiveEnv, "OPENAI_API_KEY") ||
      resolveEnvValue(processEnv, "OPENAI_API_KEY");
    // A ChatGPT (Plus/Pro/Team) subscription authenticates the Codex CLI via account credentials in
    // $CODEX_HOME/auth.json (`codex login`), inherited by the `codex` subprocess through HOME/CODEX_HOME
    // (invoker mergeProcessEnv passes the process env through) — not an API key. Opt in EXPLICITLY with
    // CODEX_AUTH_MODE=chatgpt so we never silently assume a mode and never sniff $HOME from here. The
    // Enterprise CODEX_ACCESS_TOKEN path (codex login --with-access-token) also satisfies the gate.
    const chatgptAuth =
      resolveEnvValue(processEnv, "CODEX_AUTH_MODE")?.toLowerCase() === "chatgpt" ||
      Boolean(resolveEnvValue(processEnv, "CODEX_ACCESS_TOKEN"));
    if (!hasKey && !chatgptAuth) {
      return createMissingEnvResult("Codex", "OPENAI_API_KEY or CODEX_AUTH_MODE=chatgpt");
    }
    return null;
  },

  prepareEnvironment(_request) {
    return {};
  },

  buildInvocation(request) {
    const args = [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--cd",
      request.cwd,
    ];
    // Only pin a model when one is explicitly set. A ChatGPT-account (Plus/Pro/Team) plan REJECTS
    // explicit API model ids (`o4-mini`, `gpt-5-codex`, …) with a 400 — omitting --model lets the
    // codex CLI use the account's own default. In API-key mode the runner supplies AGENT_MODEL
    // (e.g. o4-mini); in chatgpt mode it leaves it empty (see the codex gotcha in CLAUDE.md).
    if (request.model) args.push("--model", request.model);
    args.push(request.taskPrompt);
    return Effect.succeed({
      command: "codex",
      args,
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

  // Codex's verified shape: a completed function_call/mcp_tool_call item is one tool call. Reads
  // the TYPED native event the parser emits — NOT the `tool_use` pushed into `events`, which is
  // internal to buildInvocationResult and never reaches the ledger.
  tallyToolCalls(current, event) {
    return isCodexToolCall(event as unknown as CodexEvent) ? current + 1 : current;
  },
};
