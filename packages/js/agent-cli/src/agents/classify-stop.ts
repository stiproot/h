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

export interface ClassifyStopInput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr?: string;
  /** The terminal `result` stream event's text (Claude CLI carries the limit here even on exit 0). */
  resultEventText?: string;
}

export function classifyStop(input: ClassifyStopInput): StopReason {
  // A kill signal or our synthetic exit 124 (the timeout path) is a timeout, never a usage limit.
  if (input.signal !== null || input.exitCode === 124) return "timeout";
  const haystack = `${input.stderr ?? ""}\n${input.resultEventText ?? ""}`;
  const usageHit =
    USAGE_LIMIT.some((re) => re.test(haystack)) && !NOT_USAGE.some((re) => re.test(haystack));
  if (usageHit) return "usage-limited";
  // Otherwise the stop reason mirrors the exit code — stopReason never contradicts `success`.
  return input.exitCode === 0 ? "completed" : "failed";
}
