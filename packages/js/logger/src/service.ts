import { trace } from "@opentelemetry/api";
import type { DestinationStream, Logger as PinoLogger } from "pino";
import { pino, transport } from "pino";
import pretty from "pino-pretty";

// Stamp the active trace/span ids onto every log record so logs in Loki correlate with the
// matching span in Zipkin. No-ops when no span is active (e.g. no OTel SDK initialised), which
// keeps the logger working unchanged in processes that don't trace.
function traceContextMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  if (!traceId) return {};
  return { trace_id: traceId, span_id: spanId };
}

export function initLogger(
  env: Partial<Record<"LOG_LEVEL" | "PRETTY_LOGS" | "NODE_ENV", string>>,
  name: string,
  opts?: { stream?: DestinationStream },
): PinoLogger {
  if (env.NODE_ENV === "test") {
    return pino({ level: env.LOG_LEVEL ?? "fatal" }, pretty({ sync: true }));
  }

  if (!env.LOG_LEVEL) {
    throw new Error("LOG_LEVEL is required");
  }

  let stream: DestinationStream;
  if (env.PRETTY_LOGS === "true") {
    stream = pretty({ translateTime: "HH:MM:ss", sync: true });
  } else if (opts?.stream) {
    stream = opts.stream;
  } else {
    stream = transport({ target: "pino/file" }) as never;
  }

  return pino(
    {
      name,
      base: { name },
      formatters: {
        level: (level: string) => ({ level }),
      },
      mixin: traceContextMixin,
      timestamp: pino.stdTimeFunctions.isoTime,
      level: env.LOG_LEVEL,
    },
    stream,
  );
}

export async function flushLogger(flushable: Partial<Pick<PinoLogger, "flush">>): Promise<void> {
  if (!("flush" in flushable) || !flushable.flush) return;
  await new Promise<void>((resolve, reject) =>
    flushable.flush!((err) => {
      if (err) reject(err);
      else resolve();
    }),
  );
}
