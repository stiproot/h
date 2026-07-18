import { classifyStop } from "./classify-stop.ts";
import type { AgentEventCallback, InvocationResult, StreamEvent } from "./types.ts";

interface ParseStreamChunkOptions {
  buffer: string;
  chunk: string;
  events: StreamEvent[];
  onEvent?: AgentEventCallback;
  shouldFilterEvent?: (event: StreamEvent) => boolean;
}

interface FlushStreamBufferOptions {
  buffer: string;
  events: StreamEvent[];
  onEvent?: AgentEventCallback;
  shouldFilterEvent?: (event: StreamEvent) => boolean;
}

interface BuildInvocationResultOptions {
  events: StreamEvent[];
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId?: string;
  metrics?: Partial<InvocationResult>;
}

export function appendStreamEventsFromChunk({
  buffer,
  chunk,
  events,
  onEvent,
  shouldFilterEvent,
}: ParseStreamChunkOptions): string {
  const nextBuffer = buffer + chunk;
  const lines = nextBuffer.split("\n");
  const remainder = lines.pop() ?? "";

  for (const line of lines) {
    appendStreamEventFromLine(line, events, onEvent, shouldFilterEvent);
  }

  return remainder;
}

export function flushStreamEventBuffer({
  buffer,
  events,
  onEvent,
  shouldFilterEvent,
}: FlushStreamBufferOptions): void {
  appendStreamEventFromLine(buffer, events, onEvent, shouldFilterEvent);
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

function appendStreamEventFromLine(
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
