import path from "path";

import type { WorkflowActivityContext } from "@dapr/dapr";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";

import { runActivity } from "../activity-runtime.ts";

type Input = { output: string; sessionId: string | null; targetDir: string; traceparent?: string };

export async function copySessionActivity(
  _ctx: WorkflowActivityContext,
  input: unknown,
): Promise<void> {
  const { output, sessionId, targetDir, traceparent } = input as Input;
  await runActivity(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(targetDir, { recursive: true });
      yield* fs.writeFileString(path.join(targetDir, "output.txt"), output);
      if (sessionId) {
        yield* fs.writeFileString(path.join(targetDir, "session-id.txt"), sessionId);
      }
    }),
    traceparent,
  );
}
