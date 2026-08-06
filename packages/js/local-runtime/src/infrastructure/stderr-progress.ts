import { Effect, Layer } from "effect";

import { ProgressPort } from "../domain/ports.ts";

/**
 * Progress to stderr, so stdout carries ONLY the result envelope and a caller can parse it
 * without stripping chatter. Best-effort: a closed or full stderr must never fail a run that is
 * otherwise fine.
 */
export const StderrProgressLive: Layer.Layer<ProgressPort> = Layer.succeed(ProgressPort, {
  emit: (line: string) =>
    Effect.sync(() => {
      process.stderr.write(`${line}\n`);
    }).pipe(Effect.ignore),
});
