/**
 * Classify WHY an agent CLI run stopped — orthogonal to `success` (which stays `exitCode === 0`).
 * The one signal the runtime lacked (docs/plans/impl/schedule-and-fallback.md): a usage/rate limit is
 * today indistinguishable from a crash, and a limited Claude run can even exit 0 (emitting a
 * `{type:"result", is_error:true}` event with the limit text). This heuristic reads the exit code,
 * the kill signal, stderr, AND the terminal result event so the watcher can arm a delayed fallback
 * to a different agent instead of treating a rate-limit as a hard failure.
 *
 * Posture (a genuine risk called out in the plan): provider strings drift, so this is
 * POSITIVE-MATCH-ONLY and never suppresses a real failure — an unrecognised failure stays "failed".
 * Context-window overflow is explicitly excluded so an over-long prompt never triggers a pointless
 * agent handoff (a different agent would overflow too).
 */

export type StopReason = "completed" | "usage-limited" | "timeout" | "failed";

// Provider-agnostic usage/rate-limit markers: HTTP 429, Anthropic `overloaded_error`/
// `rate_limit_error` result types, OpenAI/LiteLLM `insufficient_quota`, and the `RateLimitError`
// exception class OpenHands/pi surface. Kept broad but positive-only.
const USAGE_LIMIT: readonly RegExp[] = [
  /rate.?limit/i,
  /\b429\b/,
  /too many requests/i,
  /\bquota\b/i,
  /insufficient_quota/i,
  /overloaded_error/i,
  /rate_limit_error/i,
  /\bRateLimitError\b/,
  /usage limit/i,
];

// A context-window overflow reads like a limit but is NOT one — a different agent would overflow too,
// so it must never trigger a fallback handoff. Excluded from the usage-limit match.
const NOT_USAGE: readonly RegExp[] = [
  /context.?window/i,
  /maximum context length/i,
  /ContextWindowExceeded/i,
];

/**
 * A timed-out run whose stream carried at least this many rate-limit retry events classifies
 * `usage-limited` instead of `timeout`: provider throttling stretched the run into its budget, and
 * `timeout` would hide the limit from the watcher's fallback/auto-deny (observed live 2026-07-30:
 * a Moonshot run with 20 `api_retry` 429 events finalized `timeout`, so the fence never saw it —
 * docs/plans/cost-containment.md C3). Threshold >1 keeps the positive-match posture: one stray
 * retry early in an otherwise-slow run must not re-route the fallback.
 */
const RATE_LIMIT_RETRIES_FOR_TIMEOUT = 3;

export interface ClassifyStopInput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr?: string;
  /** The terminal `result` stream event's text (Claude CLI carries the limit here even on exit 0). */
  resultEventText?: string;
  /**
   * How many rate-limit retry events the stream carried (claude CLI: `system`/`api_retry` with
   * `error_status` 429 or `error` "rate_limit"). Counted by buildInvocationResult so a
   * throttle-stretched timeout still classifies as the usage limit it is.
   */
  rateLimitRetries?: number;
}

export function classifyStop(input: ClassifyStopInput): StopReason {
  // A kill signal or our synthetic exit 124 (the timeout path) is a timeout — unless the stream
  // shows the run spent its budget being throttled, which is a usage limit wearing a timeout.
  if (input.signal !== null || input.exitCode === 124) {
    return (input.rateLimitRetries ?? 0) >= RATE_LIMIT_RETRIES_FOR_TIMEOUT
      ? "usage-limited"
      : "timeout";
  }
  const haystack = `${input.stderr ?? ""}\n${input.resultEventText ?? ""}`;
  const usageHit =
    USAGE_LIMIT.some((re) => re.test(haystack)) && !NOT_USAGE.some((re) => re.test(haystack));
  if (usageHit) return "usage-limited";
  // Otherwise the stop reason mirrors the exit code — stopReason never contradicts `success`.
  return input.exitCode === 0 ? "completed" : "failed";
}
