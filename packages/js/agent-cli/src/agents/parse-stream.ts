import { classifyStop } from "./classify-stop.ts";
import { foldQuota, parseRateLimitEvent } from "./quota.ts";
import type { AgentEventCallback, InvocationResult, StreamEvent } from "./types.ts";

interface BuildInvocationResultOptions {
  events: StreamEvent[];
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId?: string;
  metrics?: Partial<InvocationResult>;
  /** Set when the run was cut off by the invoker's timeout — names the exit and caps stderr. */
  timedOutAfterMs?: number;
}

/**
 * A rate-limit retry the CLI reported as a stream event (claude CLI shape, verified live:
 * `{type:"system", subtype:"api_retry", error_status:429, error:"rate_limit"}`). Counted so a
 * throttle-stretched timeout classifies `usage-limited` — the markers never reach stderr or a
 * result event on such runs, so the classifier's haystack alone misses them.
 */
function isRateLimitRetryEvent(event: StreamEvent): boolean {
  if (event.type !== "system" || event.subtype !== "api_retry") return false;
  const { error_status, error } = event as { error_status?: unknown; error?: unknown };
  return error_status === 429 || (typeof error === "string" && /rate.?limit/i.test(error));
}

/**
 * Default per-line parser: JSON.parse one complete stdout line into a
 * `StreamEvent`, drop it if `shouldFilterEvent` rejects it, else record it and
 * fire `onEvent`. Blank and non-JSON lines are ignored. Used by strategies that
 * emit the standard stream-json shape (Claude); others supply their own
 * {@link AgentStreamParser}.
 */
export function parseStreamLine(
  line: string,
  events: StreamEvent[],
  onEvent?: AgentEventCallback,
  shouldFilterEvent?: (event: StreamEvent) => boolean,
): void {
  if (!line.trim()) {
    return;
  }

  try {
    const event = JSON.parse(line) as StreamEvent;
    if (shouldFilterEvent?.(event)) {
      return;
    }

    events.push(event);
    onEvent?.(event as unknown as Record<string, unknown>);
  } catch {}
}

export function buildInvocationResult({
  events,
  stderr,
  exitCode,
  signal,
  sessionId,
  metrics,
  timedOutAfterMs,
}: BuildInvocationResultOptions): InvocationResult {
  const textOutput = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => event.message?.content ?? [])
    .filter((content) => content.type === "text")
    .map((content) => content.text ?? "")
    .join("\n");

  const exitDescription =
    timedOutAfterMs !== undefined
      ? `Task timed out after ${timedOutAfterMs}ms`
      : signal
        ? `Process killed by signal ${signal}`
        : `Process exited with code ${exitCode}`;

  const numTurns = events.filter((event) => event.type === "assistant").length;

  // The terminal `result` event carries the limit text even when the process exits 0 (Claude CLI),
  // so the classifier reads it alongside exit/signal/stderr — plus the stream's rate-limit retry
  // count, which is the only place throttling shows on a timed-out run.
  const resultEvent = events.find((event) => event.type === "result");
  const stopReason = classifyStop({
    exitCode,
    signal,
    stderr,
    resultEventText: resultEvent?.result,
    rateLimitRetries: events.filter(isRateLimitRetryEvent).length,
  });

  // The account's quota as the CLI reported it along the way — every rate_limit_event, folded to
  // the last state plus what this run spent (quota.ts). Absent for CLIs that report none.
  const quota = foldQuota(
    events.flatMap((event) => {
      const observation = parseRateLimitEvent(event);
      return observation ? [observation] : [];
    }),
  );

  return {
    // A strategy may VETO success from its own event stream: some CLIs report a fatal error as an
    // event and still exit 0 (openhands' ConversationErrorEvent — e.g. a rejected model id). Without
    // this, such a run is recorded `completed` with empty output and the real cause is lost.
    success: metrics?.success ?? exitCode === 0,
    stopReason,
    ...(resultEvent?.result ? { resultEventText: resultEvent.result } : {}),
    stdout: metrics?.stdout ?? (textOutput || exitDescription),
    stderr: stderr || (timedOutAfterMs !== undefined ? "Task timed out" : undefined),
    exitCode: exitCode ?? undefined,
    tokenUsage: metrics?.tokenUsage,
    model: metrics?.model,
    modelUsage: metrics?.modelUsage,
    costUsd: metrics?.costUsd,
    numTurns: metrics?.numTurns ?? (numTurns > 0 ? numTurns : undefined),
    sessionId,
    ...(metrics?.costPartial ? { costPartial: true } : {}),
    ...(quota ? { quota } : {}),
  };
}
