/** Read-only observability surface: traces (Zipkin), logs (Loki), and the agent run ledger. */

import { Context, Data, Effect, Option } from "effect";

export type TraceSearchParams = {
  service?: string;
  /** Span name to match (e.g. a workflow instance id used as a span name). */
  name?: string;
  lookbackMs?: number;
  limit?: number;
};

/** Compact per-trace summary, so a search doesn't return every span. */
export type TraceSummary = {
  traceId: string;
  durationMs: number;
  services: string[];
  spanNames: string[];
  hasError: boolean;
};

export type LogsQueryParams = {
  /** LogQL selector, e.g. `{service="redis"}` or `{container="scheduler"} |= "error"`. */
  selector: string;
  lookbackMs?: number;
  limit?: number;
};

export type LogLine = { ts: string; line: string; labels: Record<string, string> };

export type RunsListParams = {
  limit?: number;
  agentId?: string;
  status?: string;
};

export type RunSummary = Record<string, unknown>;

/**
 * `summary`/`output` are `Option.none` when the artefact is missing or unparsable —
 * tolerated-missing, never an error (the wire shape maps them back to `null`).
 */
export type RunDetail = {
  summary: Option.Option<RunSummary>;
  output: Option.Option<string>;
  events: Record<string, unknown>[];
};

export type SystemOverview = {
  services: string[];
  recentRuns: RunSummary[];
};

/**
 * A failure that genuinely surfaces to the caller. Tolerated-missing data — an unreachable
 * Zipkin/Loki, a missing or unparsable ledger file, an unreadable run directory — is NEVER
 * this error: those stay empty results / `Option.none`, exactly as the pre-Effect service
 * swallowed them (promoting one would turn tolerated-missing into a failed tool call).
 */
export class ObservabilityError extends Data.TaggedError("ObservabilityError")<{
  readonly op: string;
  readonly cause: unknown;
}> {}

export interface ObservabilityServiceShape {
  readonly traceSearch: (
    params: TraceSearchParams,
  ) => Effect.Effect<TraceSummary[], ObservabilityError>;
  /** `Option.none` when the trace is missing or Zipkin is unreachable (legacy `null`). */
  readonly traceGet: (traceId: string) => Effect.Effect<Option.Option<unknown>, ObservabilityError>;
  readonly logsQuery: (params: LogsQueryParams) => Effect.Effect<LogLine[], ObservabilityError>;
  readonly runsList: (params: RunsListParams) => Effect.Effect<RunSummary[], ObservabilityError>;
  readonly runGet: (runId: string) => Effect.Effect<RunDetail, ObservabilityError>;
  readonly systemOverview: () => Effect.Effect<SystemOverview, ObservabilityError>;
}

/** The observability port. Yield it to call: `const obs = yield* ObservabilityService`. */
export class ObservabilityService extends Context.Tag("ObservabilityService")<
  ObservabilityService,
  ObservabilityServiceShape
>() {}
