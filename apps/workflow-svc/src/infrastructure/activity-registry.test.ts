import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ExecPolicy } from "engine-core";
import { ExecPolicyStore } from "engine-core";
import { gatedExecutor, getActivity } from "./activity-registry.ts";
import { type ActivityRuntime, setActivityRuntime } from "./activity-runtime.ts";

// A stub runtime carrying only the ExecPolicyStore the gate reads. The cast is test-only: the
// shared ActivityRuntime is typed over the full ActivityEnv, but the gate effect yields nothing
// else, so a store-only runtime satisfies it at run time.
const stubRuntime = (policy: ExecPolicy | undefined): ActivityRuntime =>
  ManagedRuntime.make(
    Layer.succeed(ExecPolicyStore, {
      get: () => Effect.succeed(Option.fromNullable(policy)),
      save: () => Effect.void,
    }),
  ) as unknown as ActivityRuntime;

const ctx = {} as WorkflowActivityContext;

describe("gatedExecutor (the executor-policy gate)", () => {
  afterEach(() => setActivityRuntime(undefined as unknown as ActivityRuntime));

  it("passes a non-run activity through ungated (no policy read, no runtime needed)", async () => {
    const probe = async () => "provisioned";
    expect(gatedExecutor("clone-repo", probe)).toBe(probe);
  });

  it("runs the gated activity when no policy row exists (allow is the default)", async () => {
    setActivityRuntime(stubRuntime(undefined));
    const gated = gatedExecutor("run-probe", async () => "ran");
    await expect(gated(ctx, { task: "x" })).resolves.toBe("ran");
  });

  it("runs the gated activity when the policy denies a DIFFERENT executor", async () => {
    setActivityRuntime(stubRuntime({ denied: ["codex"], updatedAt: "" }));
    const gated = gatedExecutor("run-probe", async () => "ran");
    await expect(gated(ctx, { task: "x" })).resolves.toBe("ran");
  });

  it("REFUSES a denied executor before the activity body runs", async () => {
    setActivityRuntime(stubRuntime({ denied: ["probe"], updatedAt: "" }));
    let invoked = false;
    const gated = gatedExecutor("run-probe", async () => {
      invoked = true;
      return "ran";
    });
    await expect(gated(ctx, { task: "x" })).rejects.toThrow(/executor 'probe' is denied/);
    expect(invoked).toBe(false);
  });

  it("preserves the wrapped function's name (Dapr dispatches activities by function name)", () => {
    async function runProbeActivity() {
      return "ran";
    }
    expect(gatedExecutor("run-probe", runProbeActivity).name).toBe("runProbeActivity");
    // …and the real registry entries kept theirs through the structural wrap.
    expect(getActivity("run-codex").name).toBe("runCodexActivity");
    expect(getActivity("run-claude").name).toBe("runClaudeActivity");
  });
});
