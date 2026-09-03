import type { WorkflowActivityContext } from "@dapr/dapr";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ExecPolicy, QuotaRow } from "engine-core";
import { ExecPolicyStore, QuotaStore } from "engine-core";
import { gatedExecutor, getActivity } from "./activity-registry.ts";
import { type ActivityRuntime, setActivityRuntime } from "./activity-runtime.ts";

// A stub runtime carrying only the two stores the gate reads. The cast is test-only: the
// shared ActivityRuntime is typed over the full ActivityEnv, but the gate effect yields nothing
// else, so a store-only runtime satisfies it at run time.
const stubRuntime = (policy: ExecPolicy | undefined, quota?: QuotaRow): ActivityRuntime =>
  ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(ExecPolicyStore, {
        get: () => Effect.succeed(Option.fromNullable(policy)),
        save: () => Effect.void,
      }),
      Layer.succeed(QuotaStore, {
        get: (executor) =>
          Effect.succeed(Option.fromNullable(quota?.executor === executor ? quota : undefined)),
        list: () => Effect.succeed(quota ? [quota] : []),
        save: () => Effect.void,
      }),
    ),
  ) as unknown as ActivityRuntime;

/** probe's CLI last saw the 5h window at `utilization`, resetting in an hour. */
const probeQuota = (utilization: number, status: QuotaRow["status"] = "allowed"): QuotaRow => ({
  executor: "probe",
  status,
  windows: {
    five_hour: { utilization, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
  },
  observedAt: new Date().toISOString(),
  runId: "wf-0:probe-agent:1",
  history: [],
  updatedAt: new Date().toISOString(),
});

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

  it("REFUSES a fire the quota row projects would exhaust the window (fail mode, the default)", async () => {
    setActivityRuntime(stubRuntime(undefined, probeQuota(0.95)));
    let invoked = false;
    const gated = gatedExecutor("run-probe", async () => {
      invoked = true;
      return "ran";
    });
    await expect(gated(ctx, { task: "x" })).rejects.toThrow(/probe's 5h window is at 95%/);
    expect(invoked).toBe(false);
  });

  it("lets a hot-but-open fire through in wait mode — the provider adjudicates, the watcher continues", async () => {
    setActivityRuntime(stubRuntime(undefined, probeQuota(0.95)));
    const gated = gatedExecutor("run-probe", async () => "ran");
    await expect(gated(ctx, { task: "x", onQuota: "wait" })).resolves.toBe("ran");
  });

  it("still REFUSES an exhausted window in wait mode when the reset is past the wait ceiling", async () => {
    const row: QuotaRow = {
      ...probeQuota(1, "rejected"),
      windows: {
        five_hour: { utilization: 1, resetsAt: new Date(Date.now() + 8 * 3_600_000).toISOString() },
      },
    };
    setActivityRuntime(stubRuntime(undefined, row));
    const gated = gatedExecutor("run-probe", async () => "ran");
    await expect(gated(ctx, { task: "x", onQuota: "wait" })).rejects.toThrow(/rate-limited/);
  });

  it("ignoreQuota skips the quota read; the policy fence still holds", async () => {
    setActivityRuntime(
      stubRuntime({ denied: ["probe"], updatedAt: "" }, probeQuota(1, "rejected")),
    );
    const gated = gatedExecutor("run-probe", async () => "ran");
    await expect(gated(ctx, { task: "x", ignoreQuota: true })).rejects.toThrow(
      /executor 'probe' is denied/,
    );
    setActivityRuntime(stubRuntime(undefined, probeQuota(1, "rejected")));
    await expect(gated(ctx, { task: "x", ignoreQuota: true })).resolves.toBe("ran");
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
