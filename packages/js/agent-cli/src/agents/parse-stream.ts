import { classifyStop } from "./classify-stop.ts";
import type { AgentEventCallback, InvocationResult, StreamEvent } from "./types.ts";

interface BuildInvocationResultOptions {
  events: StreamEvent[];
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId?: string;
  metrics?: Partial<InvocationResult>;
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
}: BuildInvocationResultOptions): InvocationResult {
  const textOutput = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => event.message?.content ?? [])
    .filter((content) => content.type === "text")
    .map((content) => content.text ?? "")
    .join("\n");

  const exitDescription = signal
    ? `Process killed by signal ${signal}`
    : `Process exited with code ${exitCode}`;

  const numTurns = events.filter((event) => event.type === "assistant").length;

  // The terminal `result` event carries the limit text even when the process exits 0 (Claude CLI),
  // so the classifier reads it alongside exit/signal/stderr.
  const resultEvent = events.find((event) => event.type === "result");
  const stopReason = classifyStop({
    exitCode,
    signal,
    stderr,
    resultEventText: resultEvent?.result,
  });

  return {
    success: exitCode === 0,
    stopReason,
    stdout: textOutput || exitDescription,
    stderr: stderr || undefined,
    exitCode: exitCode ?? undefined,
    tokenUsage: metrics?.tokenUsage,
    model: metrics?.model,
    modelUsage: metrics?.modelUsage,
    costUsd: metrics?.costUsd,
    numTurns: metrics?.numTurns ?? (numTurns > 0 ? numTurns : undefined),
    sessionId,
  };
}
