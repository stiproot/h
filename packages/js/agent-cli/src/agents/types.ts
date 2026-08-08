import type { HttpClient } from "@effect/platform";
import { Data, type Effect } from "effect";

import type { StopReason } from "./classify-stop.ts";

export type { StopReason } from "./classify-stop.ts";

/**
 * LLM API keys forwarded to agent CLI processes. Which key is required
 * depends on the agent type and is validated contextually at invocation time.
 */
export const AGENT_ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LLM_API_KEY"] as const;

export type AgentEnv = Partial<Record<(typeof AGENT_ENV_KEYS)[number], string>>;

/** LLM provider configuration: API key plus optional proxy base URL and routing hint. */
export interface LlmConfig {
  apiKey: string;
  baseUrl?: string;
  /** Environment hint for model routing (e.g. 'production' vs 'development') */
  llmEnv?: string;
}

/** Per-model token and cost usage breakdown. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

/**
 * Called for each event emitted by the agent CLI stream.
 *
 * Deliberately structural (`Record<string, unknown>`): the run ledger is agent-AGNOSTIC and must
 * accept any CLI's vocabulary. What each strategy passes THROUGH it is its own typed native event
 * (`OpenhandsEvent`, `PiEvent`, `CodexEvent`, or claude's `StreamEvent`), so what lands in
 * events.jsonl is the shape that agent's CLI actually emitted — not a re-wrapping of it.
 */
export type AgentEventCallback = (event: Record<string, unknown>) => void;

/**
 * A stdout line that is not JSON at all — a banner, a Rich-drawn box, a progress line. Every
 * non-claude CLI interleaves these with its JSON stream, so they need a home in the event
 * vocabulary rather than being disguised as real events.
 *
 * They used to be emitted as `{type: "output", text: line}`, which made EVERY line of those
 * streams look like a uniform `output` event and buried the real event as an escaped string
 * inside `text`. `raw` names them for what they are, so a reader can tell CLI chatter from the
 * agent's actual events.
 */
export interface RawLineEvent {
  type: "raw";
  text: string;
}

/** Build a {@link RawLineEvent} for a line that could not be parsed as the agent's JSON. */
export const rawLineEvent = (text: string): RawLineEvent => ({ type: "raw", text });

export type AgentType = "claude" | "codex" | "openhands" | "pi";

/** The agent CLI subprocess could not be spawned or its stdio streams failed. */
export class AgentSpawnError extends Data.TaggedError("AgentSpawnError")<{
  readonly command: string;
  readonly cause: unknown;
}> {}

/**
 * The agent CLI subprocess exceeded the requested timeout. Internal: the
 * invoker layer converts it back into the exit-124 `InvocationResult` so the
 * observable contract matches the legacy Promise implementation.
 */
export class AgentTimeoutError extends Data.TaggedError("AgentTimeoutError")<{
  readonly timeoutMs: number;
}> {}

/** The LiteLLM proxy model listing failed (request error, non-2xx, or malformed body). */
export class LiteLlmCheckError extends Data.TaggedError("LiteLlmCheckError")<{
  readonly url: string;
  readonly status?: number;
  readonly body?: string;
  readonly cause?: unknown;
}> {}

/** The LiteLLM proxy model listing did not answer within the check timeout. */
export class LiteLlmTimeoutError extends Data.TaggedError("LiteLlmTimeoutError")<{
  readonly url: string;
  readonly timeoutMs: number;
}> {}

/** The requested model is not served by the LiteLLM proxy. */
export class LiteLlmModelUnavailableError extends Data.TaggedError("LiteLlmModelUnavailableError")<{
  readonly model: string;
  readonly available: ReadonlyArray<string>;
}> {}

export type LiteLlmError = LiteLlmCheckError | LiteLlmTimeoutError | LiteLlmModelUnavailableError;

export interface InvocationResult {
  success: boolean;
  stdout: string;
  stderr?: string;
  exitCode?: number;
  /**
   * Why the run stopped, classified from exit/signal/stderr/result-event (classify-stop.ts). A NEW,
   * orthogonal field — `success` stays `exitCode === 0`. "usage-limited" is the signal the watcher's
   * fallback reads to hand off to a different agent after a delay.
   */
  stopReason?: StopReason;
  /**
   * The terminal `result` event's text, verbatim. On a failed run this is the CLI's own account of
   * the stop (claude carries the limit text here even on exit 0), which failure reports must prefer
   * over stderr — stderr's head is usually an incidental startup warning (h#112).
   */
  resultEventText?: string;
  tokenUsage?: {
    input: number;
    output: number;
  };
  model?: string;
  modelUsage?: Record<string, ModelUsage>;
  costUsd?: number;
  numTurns?: number;
  sessionId?: string;
  /**
   * True when tokenUsage/model were folded from the PARTIAL event stream of a run that ended
   * without a terminal result event (timeout/kill) — cumulative usage up to the stop, not a
   * final accounting. costUsd is typically absent on such a result (per-event usage carries no
   * cost); the ledger records the flag so a partial tally is never mistaken for a measured total
   *.
   */
  costPartial?: boolean;
}

export interface StreamEventModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export interface StreamEventStatsModel {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached?: number;
  input?: number;
}

export interface StreamEvent {
  type: string;
  subtype?: string;
  thread_id?: string;
  model?: string;
  num_turns?: number;
  // The terminal `result` event's fields (Claude CLI): `is_error` can be true while the process
  // exits 0, and `result` carries the error/limit text — both read by the stop classifier.
  is_error?: boolean;
  result?: string;
  message?: {
    /** The API message id — several stream events can carry the SAME message (verified live:
     * 30 assistant events / 14 distinct ids on a kimi run), so usage folds dedupe by id. */
    id?: string;
    model?: string;
    content?: Array<{
      type: string;
      text?: string;
    }>;
    /** Per-API-call usage on assistant events (claude CLI stream-json) — the B1 partial-capture
     * source when a run ends without a terminal result event. */
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    input?: number;
    duration_ms?: number;
    tool_calls?: number;
    models?: Record<string, StreamEventStatsModel>;
  };
  modelUsage?: Record<string, StreamEventModelUsage>;
  total_cost_usd?: number;
  session_id?: string;
}

export interface AgentInvocationRequest {
  systemPrompt: string;
  taskPrompt: string;
  cwd: string;
  env: Record<string, string>;
  effectiveEnv: AgentEnv;
  timeout: number;
  model?: string;
  resumeSessionId?: string;
  onEvent?: AgentEventCallback;
  verbose?: boolean;
  llmConfig?: LlmConfig;
  permissionMode?: "plan";
}

export interface AgentStreamParser {
  /**
   * Consume ONE complete stdout line. The process runner drives parsing off
   * `Stream.splitLines`, so a parser never sees partial lines and needs no
   * internal buffering — it appends any derived events and fires `onEvent`.
   */
  parseLine(line: string, events: StreamEvent[], onEvent?: AgentEventCallback): void;
}

export interface PreparedAgentInvocation {
  command: string;
  args: string[];
  stdinInput?: string;
  shouldFilterEvent?: (event: StreamEvent) => boolean;
  streamParser?: AgentStreamParser;
  /**
   * Teardown run on every exit path — success, failure, timeout, or
   * interruption. Removes temp artifacts from buildInvocation (e.g. the
   * `--file` task file). Must not throw; errors are silently ignored.
   */
  cleanup?: () => void | Promise<void>;
}

export interface AgentStrategy {
  readonly type: AgentType;
  readonly name: string;

  validateEnvironment(
    effectiveEnv: AgentEnv,
    processEnv: NodeJS.ProcessEnv,
  ): InvocationResult | null;

  prepareEnvironment?(request: AgentInvocationRequest): Record<string, string>;

  /**
   * Build the CLI invocation. Effect-native so a strategy can surface tagged
   * errors (e.g. the LiteLLM model check) in the error channel instead of
   * throwing, and thread `HttpClient` when it needs one. A pure strategy just
   * returns `Effect.succeed(...)`.
   */
  buildInvocation(
    request: AgentInvocationRequest,
  ): Effect.Effect<PreparedAgentInvocation, LiteLlmError, HttpClient.HttpClient>;

  extractSessionId(events: StreamEvent[]): string | undefined;

  extractMetrics(events: StreamEvent[], request: AgentInvocationRequest): Partial<InvocationResult>;

  /**
   * This agent's OWN tool-call tally, folded over its raw event stream — the sibling of
   * `streamParser`, because only the strategy knows its CLI's event vocabulary.
   *
   * OMIT IT until this agent's shape has actually been verified against captured events: the run
   * ledger then records `toolCalls: null` (unknown) instead of 0, and a 0 reads as a measured
   * zero. That mistake is not hypothetical — a busy openhands run was misread as a "hollow
   * panelist" on 2026-07-27 because a claude-shaped tally was applied to it. Every run's
   * observed `eventShape` is logged, so a tally is added from evidence, never from assumption.
   */
  tallyToolCalls?(current: number, event: Record<string, unknown>): number;
}
